// Sync, fetch half (plan sections 4.1 to 4.3): which Items are due, claiming one, the run row, fetching one whole
// /transactions/sync update in memory, and turning a Plaid transaction into our fields. Nothing here writes except
// the claim, the run row and its finish. The apply half (D1 writes) is apply.ts. Logs: counts and codes only.
import { maskDigits } from '../../../src/lib/budget/mask'
import { PlaidError, PlaidTimeoutError, type PlaidClient } from './plaid'

// Bank-row classification is src/lib/budget/classifyRow.ts (the statement load's own call); apply.ts imports it from there.

export const DUE_AFTER_MS = 20 * 3_600_000
export const CLAIM_WINDOW_MS = 15 * 60_000
export const RECONNECT_WINDOW_MS = 24 * 3_600_000
export const PICK_LIMIT = 3
export const PAGE_SIZE = 500
export const MAX_PAGES = 60
export const MAX_RESTARTS = 3

/** The due pick, exactly plan 4.1 (leg 1's EXPLAIN test runs the same text): requested first, at most 3 per tick. */
export const DUE_SQL =
  `SELECT id FROM bank_items WHERE status IN ('active','pending_disconnect') AND (sync_requested_at IS NOT NULL OR last_ok_at IS NULL OR last_ok_at < ?1)
   ORDER BY sync_requested_at IS NULL, sync_requested_at LIMIT ${PICK_LIMIT}`
/** The daily reconnect check pick (plan 4.1). */
export const RECONNECT_SQL = `SELECT id FROM bank_items WHERE status = 'needs_reconnect' AND (last_sync_at IS NULL OR last_sync_at < ?1) LIMIT ${PICK_LIMIT}`
export const CLAIM_SQL = `UPDATE bank_items SET last_sync_at = ?2 WHERE id = ?1 AND (last_sync_at IS NULL OR last_sync_at < ?3)`
export const MAPPED_SQL = `SELECT 1 AS x FROM bank_txns WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE item_id = ?1) LIMIT 1`

const iso = (ms: number): string => new Date(ms).toISOString()

/** Items to sync this tick: ids, requested ones first. */
export async function pickDue(db: D1Database, now: Date): Promise<string[]> {
  const r = await db.prepare(DUE_SQL).bind(iso(now.getTime() - DUE_AFTER_MS)).all<{ id: string }>()
  return (r.results ?? []).map((x) => x.id)
}

/** Items in needs_reconnect not looked at for 24 h (the caller claims each with the 24 h window). */
export async function pickReconnect(db: D1Database, now: Date): Promise<string[]> {
  const r = await db.prepare(RECONNECT_SQL).bind(iso(now.getTime() - RECONNECT_WINDOW_MS)).all<{ id: string }>()
  return (r.results ?? []).map((x) => x.id)
}

/** Take the Item for this tick. False = another tick claimed it inside `windowMs`: skip it. */
export async function claim(db: D1Database, id: string, now: Date, windowMs: number = CLAIM_WINDOW_MS): Promise<boolean> {
  const r = await db.prepare(CLAIM_SQL).bind(id, now.toISOString(), iso(now.getTime() - windowMs)).run()
  return (r.meta?.changes ?? 0) === 1
}

export type RunTrigger = 'webhook' | 'cron' | 'manual' | 'initial' | 'resync'

export interface TriggerFacts {
  initial_done: number
  sync_cursor: string | null
  sync_requested_at: string | null
}

/**
 * initial while the first update has not completed; resync when the cursor is NULL but mapped rows exist; else what
 * set the flag (`requestedBy`, the caller knows: webhook or manual) or cron when nothing did.
 */
export async function chooseTrigger(
  db: D1Database, itemId: string, facts: TriggerFacts, requestedBy: 'webhook' | 'manual' | null = null,
): Promise<RunTrigger> {
  if (facts.initial_done === 0) return 'initial'
  if (facts.sync_cursor === null) {
    const mapped = await db.prepare(MAPPED_SQL).bind(itemId).first()
    if (mapped) return 'resync'
  }
  if (facts.sync_requested_at !== null && requestedBy) return requestedBy
  return 'cron'
}

/** Insert the run row; returns its id. */
export async function startRun(db: D1Database, itemId: string, trigger: RunTrigger, now: Date): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO bank_sync_runs (item_id, run_trigger, started_at) VALUES (?1, ?2, ?3) RETURNING id`)
    .bind(itemId, trigger, now.toISOString())
    .first<{ id: number }>()
  if (!row) throw new Error('run_insert_failed')
  return row.id
}

/** Close a run that applied nothing (no-op or an error): pages and an optional error code. */
export async function finishRun(db: D1Database, runId: number, now: Date, pages: number, errorCode: string | null = null): Promise<void> {
  await db
    .prepare(`UPDATE bank_sync_runs SET finished_at = ?2, pages = ?3, error_code = ?4 WHERE id = ?1`)
    .bind(runId, now.toISOString(), pages, errorCode)
    .run()
}

// --- Plaid shapes (only the fields we read) -------------------------------------------------------------------------

export interface PlaidTxn {
  transaction_id?: unknown
  account_id?: unknown
  amount?: unknown
  iso_currency_code?: unknown
  date?: unknown
  authorized_date?: unknown
  name?: unknown
  merchant_name?: unknown
  pending?: unknown
  pending_transaction_id?: unknown
}
export interface PlaidRemoved {
  transaction_id?: unknown
  account_id?: unknown
}
interface SyncPage {
  added?: unknown
  modified?: unknown
  removed?: unknown
  next_cursor?: unknown
  has_more?: unknown
}

export type FetchResult =
  | { kind: 'ok'; added: PlaidTxn[]; modified: PlaidTxn[]; removed: PlaidRemoved[]; nextCursor: string; pages: number }
  /** Nothing to apply, nothing moves: the Item is not ready yet (empty next_cursor, or PRODUCT_NOT_READY). */
  | { kind: 'noop'; pages: number }
  | { kind: 'needs_reconnect'; pages: number }
  /** Stop with a code for last_error / the run row (sync_mutation, too_many_pages, plaid_<code>, bad_response). */
  | { kind: 'error'; code: string; pages: number }

/** `plaid_` + lower-case code, `[a-z0-9_]` only, cut to 40 (the bank_items.last_error CHECK). */
export function plaidErrorCode(code: string): string {
  const clean = code.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  return `plaid_${clean}`.slice(0, 40)
}

const arr = <T>(v: unknown): T[] | null => (Array.isArray(v) ? (v as T[]) : v === undefined ? [] : null)

/**
 * Fetch one whole update from `cursor0` (NULL = from the beginning), looping while has_more and keeping everything in
 * memory. A mutation during pagination restarts from cursor0 (at most 3 restarts), more than 60 calls stops. Neither
 * a stop nor a no-op applies anything.
 */
export async function fetchUpdate(client: PlaidClient, accessToken: string, cursor0: string | null): Promise<FetchResult> {
  let pages = 0
  let restarts = 0
  for (;;) {
    let cursor = cursor0
    const added: PlaidTxn[] = []
    const modified: PlaidTxn[] = []
    const removed: PlaidRemoved[] = []
    for (;;) {
      if (pages >= MAX_PAGES) return { kind: 'error', code: 'too_many_pages', pages }
      let page: SyncPage
      pages++
      try {
        page = await client.post<SyncPage>('/transactions/sync', {
          access_token: accessToken,
          ...(cursor ? { cursor } : {}),
          count: PAGE_SIZE,
        })
      } catch (e) {
        if (e instanceof PlaidTimeoutError) return { kind: 'error', code: 'plaid_timeout', pages }
        if (!(e instanceof PlaidError)) throw e
        if (e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
          if (restarts >= MAX_RESTARTS) return { kind: 'error', code: 'sync_mutation', pages }
          restarts++
          break // drop what was collected, start over from cursor0
        }
        if (e.code === 'ITEM_LOGIN_REQUIRED') return { kind: 'needs_reconnect', pages }
        if (e.code === 'PRODUCT_NOT_READY') return { kind: 'noop', pages }
        return { kind: 'error', code: plaidErrorCode(e.code), pages }
      }
      const a = arr<PlaidTxn>(page.added), m = arr<PlaidTxn>(page.modified), r = arr<PlaidRemoved>(page.removed)
      const next = page.next_cursor
      if (!a || !m || !r || typeof next !== 'string' || next.length > 256 || typeof page.has_more !== 'boolean') {
        return { kind: 'error', code: 'bad_response', pages }
      }
      added.push(...a)
      modified.push(...m)
      removed.push(...r)
      if (next === '') {
        if (added.length + modified.length + removed.length === 0) return { kind: 'noop', pages }
        return { kind: 'error', code: 'bad_response', pages }
      }
      cursor = next
      if (!page.has_more) return { kind: 'ok', added, modified, removed, nextCursor: next, pages }
    }
  }
}

// --- Normalize ------------------------------------------------------------------------------------------------------

export interface BankTxn {
  plaidTxnId: string
  plaidAccountId: string
  /** Ours: negative = money out (Plaid sends the opposite sign). */
  amountCents: number
  postedDate: string
  txnDate: string | null
  pending: 0 | 1
  pendingTransactionId: string | null
  bankRef: string
  /** Digits masked, whitespace collapsed, at most 300. The classifier input; Plaid's own category is not stored. */
  description: string
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const validDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

/** Plaid cents the way the plan says: -round(amount x 100), rounded away from zero on halves, never -0. */
export function toCents(plaidAmount: number): number {
  const c = Math.round(Math.abs(plaidAmount) * 100) * Math.sign(plaidAmount)
  return c === 0 ? 0 : -c
}

/** Our fields for one Plaid transaction, or null when it is skipped (not USD, or fields we cannot trust). */
export function normalize(t: PlaidTxn): BankTxn | null {
  if (t.iso_currency_code !== 'USD') return null
  const id = t.transaction_id
  const acct = t.account_id
  if (typeof id !== 'string' || !ID.test(id) || typeof acct !== 'string' || !ID.test(acct)) return null
  if (typeof t.amount !== 'number' || !Number.isFinite(t.amount) || Math.abs(t.amount) > 99_999_999) return null
  if (!validDate(t.date)) return null
  const txnDate = validDate(t.authorized_date) ? t.authorized_date : null
  const pendingId = typeof t.pending_transaction_id === 'string' && ID.test(t.pending_transaction_id) ? t.pending_transaction_id : null
  const text = typeof t.name === 'string' && t.name.trim() !== '' ? t.name : typeof t.merchant_name === 'string' ? t.merchant_name : ''
  return {
    plaidTxnId: id,
    plaidAccountId: acct,
    amountCents: toCents(t.amount),
    postedDate: t.date,
    txnDate,
    pending: t.pending === true ? 1 : 0,
    pendingTransactionId: pendingId,
    bankRef: `plaid:${id}`,
    description: maskDigits(text.replace(/\s+/g, ' ').trim()).slice(0, 300),
  }
}
