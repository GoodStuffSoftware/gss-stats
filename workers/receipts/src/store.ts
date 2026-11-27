// Receipts Worker store: every D1 read and write of the receipts run (docs/adr/0008-email-receipts.md, plan stage 6).
//
// Rules this file keeps:
//  - It NEVER writes `transactions`, except autoApplyMatches, which is off unless the caller passes enabled=true
//    (RECEIPTS_AUTO_APPLY="1"; off at launch). Applying a match by hand is the Pages route's job (stage 10).
//  - D1 read budget (5M rows/day; production was once taken down by read sweeps): every query below is served by an
//    index (store.test.ts asserts each plan with EXPLAIN QUERY PLAN), there is no SELECT * and no per-row loop where
//    one batched statement (json_each) will do. Per run: one candidate-rows read, one open-receipts read, one items
//    read, one rejected-pairs read.
//  - No private data in logs: nothing here logs. Values are bound, never concatenated into SQL.
//  - Row ids written here are opaque; gmail_msg_id is the dedupe key and is never returned to a caller outside the Worker.

import { addDays } from '../../../src/lib/budget/dates'
import {
  AUTO_MIN_SCORE,
  NO_REF_REPEAT_DAYS,
  STALE_AFTER_DAYS,
  candidateWindow,
  chargedCents,
  type AppliedSibling,
  type MatchBankRow,
  type MatchProposal,
  type MatchReceipt,
  type ReceiptMatchResult,
} from '../../../src/lib/budget/receiptMatch'
import { groupQueries, type ReceiptQueries } from './gmail'
import type { ExtractedReceipt } from './extract'

export const ACTOR = 'script:receipts'
/** Failed extractions are retried until this many attempts, then the receipt becomes 'error'. */
export const MAX_ATTEMPTS = 3
/** Newest run rows kept per connection. */
export const KEEP_RUNS = 200
/** Most open receipts re-matched in one run (newest first); older ones wait for the next run or go stale. */
export const MAX_OPEN_PER_RUN = 300
/** Statements per D1 batch. */
const BATCH_SIZE = 40

type Db = D1Database

// ---------- small helpers ----------

const iso = (d: Date): string => d.toISOString()
const dayOf = (d: Date): string => d.toISOString().slice(0, 10)
const HEX_ID = /^[0-9a-f]{8,32}$/

/** Whose receipts a re-match covers: one email connection's, or one person's photo uploads. A bare string is a connection id. */
export type ReceiptScope = { kind: 'connection'; connectionId: string } | { kind: 'upload'; email: string }
const asScope = (s: ReceiptScope | string): ReceiptScope => (typeof s === 'string' ? { kind: 'connection', connectionId: s } : s)

/** Same rule as functions/_lib/budgetDb nextStamp: strictly newer than the previous stamp, so an updated_at guard sees every edit. */
function nextStamp(prev: string | null, now: number): string {
  const prevMs = prev ? Date.parse(prev) : NaN
  return new Date(Number.isFinite(prevMs) && prevMs >= now ? prevMs + 1 : now).toISOString()
}

function newId(prefix: 'r'): string {
  const b = crypto.getRandomValues(new Uint8Array(8))
  return prefix + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

async function runBatches(db: Db, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  const out: D1Result[] = []
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) out.push(...(await db.batch(stmts.slice(i, i + BATCH_SIZE))))
  return out
}

// ---------- connection, queries, watermark ----------

export interface ConnectionRow {
  id: string
  ownerEmail: string
  googleSub: string
  personId: string | null
  status: 'active' | 'needs_reconnect' | 'paused' | 'revoked'
  tokenCt: string | null
  tokenIv: string | null
  keyId: string | null
  consentVersion: number
  watermarkAt: string | null
  lastRunAt: string | null
  lastOkAt: string | null
}

export const CONNECTION_SQL = `SELECT id, owner_email, google_sub, person_id, status, token_ct, token_iv, key_id, consent_version, watermark_at, last_run_at, last_ok_at
FROM email_connections WHERE id = ?1`

export async function loadConnection(db: Db, id: string): Promise<ConnectionRow | null> {
  const r = await db.prepare(CONNECTION_SQL).bind(id).first<Record<string, unknown>>()
  if (!r) return null
  return {
    id: r.id as string, ownerEmail: r.owner_email as string, googleSub: r.google_sub as string, personId: (r.person_id as string | null) ?? null,
    status: r.status as ConnectionRow['status'], tokenCt: (r.token_ct as string | null) ?? null, tokenIv: (r.token_iv as string | null) ?? null,
    keyId: (r.key_id as string | null) ?? null, consentVersion: r.consent_version as number, watermarkAt: (r.watermark_at as string | null) ?? null,
    lastRunAt: (r.last_run_at as string | null) ?? null, lastOkAt: (r.last_ok_at as string | null) ?? null,
  }
}

/** The cron's list: ids of active connections. email_connections has one row per Budget login (two people), so a scan reads two rows; the migration has no status index. */
export const ACTIVE_CONNECTIONS_SQL = `SELECT id FROM email_connections WHERE status = 'active'`

export async function loadActiveConnectionIds(db: Db): Promise<string[]> {
  const { results } = await db.prepare(ACTIVE_CONNECTIONS_SQL).all<{ id: string }>()
  return results.map((r) => r.id)
}

/** The sync watermark in epoch milliseconds (afterBound's input), or null on the first run. */
export function watermarkMs(c: Pick<ConnectionRow, 'watermarkAt'>): number | null {
  const ms = c.watermarkAt ? Date.parse(c.watermarkAt) : NaN
  return Number.isFinite(ms) ? ms : null
}

/** Active Gmail search terms; the kind IN list lets the (kind, value) unique index serve it. */
export const QUERIES_SQL = `SELECT kind, value FROM receipt_queries WHERE kind IN ('from','subject','exclude_from') AND active = 1 ORDER BY kind, value`

export async function loadReceiptQueries(db: Db): Promise<ReceiptQueries> {
  const { results } = await db.prepare(QUERIES_SQL).all<{ kind: string; value: string }>()
  return groupQueries(results)
}

export interface ConnectionResult {
  runAtIso: string
  /** true = the run finished without a stop code: last_ok_at moves. */
  ok: boolean
  /** Newest email date (ISO) fully processed; the watermark only ever moves forward. */
  watermarkAt?: string | null
  /** A code ([a-z_]{1,40}), never text from Google or mail. */
  lastError?: string | null
}

// A disconnect (paused, revoked) that landed while the run was going has already cleared the watermark and the error:
// the late result must not write them back, so both change only on an active row, or one this run itself sent to needs_reconnect.
export const CONNECTION_RESULT_SQL = `UPDATE email_connections SET last_run_at = ?2,
  last_ok_at = CASE WHEN ?3 = 1 THEN ?2 ELSE last_ok_at END,
  watermark_at = CASE WHEN ?4 IS NOT NULL AND status IN ('active','needs_reconnect') AND (watermark_at IS NULL OR ?4 > watermark_at) THEN ?4 ELSE watermark_at END,
  last_error = CASE WHEN status IN ('active','needs_reconnect') THEN ?5 ELSE last_error END, updated_at = ?2
WHERE id = ?1`

export async function recordConnectionResult(db: Db, connectionId: string, r: ConnectionResult): Promise<void> {
  await db.prepare(CONNECTION_RESULT_SQL).bind(connectionId, r.runAtIso, r.ok ? 1 : 0, r.watermarkAt ?? null, r.lastError ?? null).run()
}

/**
 * paused keeps the token; needs_reconnect clears all token material (the table's CHECK requires it).
 * Only an active or paused connection changes, so a revoked one never comes back by accident.
 */
export const SET_STATUS_SQL = {
  paused: `UPDATE email_connections SET status = 'paused', last_error = ?3, updated_at = ?2 WHERE id = ?1 AND status IN ('active','paused')`,
  needs_reconnect: `UPDATE email_connections SET status = 'needs_reconnect', token_ct = NULL, token_iv = NULL, key_id = NULL, last_error = ?3, updated_at = ?2
WHERE id = ?1 AND status IN ('active','paused') AND (?4 IS NULL OR token_ct = ?4)`,
} as const

export async function setConnectionStatus(db: Db, connectionId: string, status: 'paused' | 'needs_reconnect', code: string, now: Date, tokenCt: string | null = null): Promise<void> {
  // tokenCt (needs_reconnect): only the token this run loaded is cleared; a reconnect that stored a fresh one is left alone.
  const q = db.prepare(SET_STATUS_SQL[status])
  await (status === 'paused' ? q.bind(connectionId, iso(now), code) : q.bind(connectionId, iso(now), code, tokenCt)).run()
}

// ---------- listed ids: dedupe pre-check ----------

export const KNOWN_IDS_SQL = `SELECT gmail_msg_id FROM receipts WHERE connection_id = ?1 AND gmail_msg_id IN (SELECT value FROM json_each(?2))`

export interface NewIds { fresh: string[]; known: number; invalid: number }

/**
 * One query per listed page: ids already stored are skipped before any messages.get. Ids that fail the hex/length
 * check are counted and never stored. Order of `fresh` follows the input.
 */
export async function filterNewMessageIds(db: Db, connectionId: string, ids: readonly string[]): Promise<NewIds> {
  const valid = [...new Set(ids.filter((i) => HEX_ID.test(i)))]
  const invalid = ids.length - ids.filter((i) => HEX_ID.test(i)).length
  if (valid.length === 0) return { fresh: [], known: 0, invalid }
  const { results } = await db.prepare(KNOWN_IDS_SQL).bind(connectionId, JSON.stringify(valid)).all<{ gmail_msg_id: string }>()
  const known = new Set(results.map((r) => r.gmail_msg_id))
  return { fresh: valid.filter((i) => !known.has(i)), known: known.size, invalid }
}

// ---------- receipts: insert, retry ----------

const cap = (s: string | null, n: number): string | null => (s === null ? null : s.slice(0, n))

/** extracted -> (status, [kind, sender_domain, merchant, payment_via, card_last4, order_ref, receipt_date, related_date, currency, ...]). */
function fieldsOf(e: ExtractedReceipt | null, senderDomain: string | null, model: string | null) {
  const status = e === null ? 'pending' : e.status === 'ok' ? 'unmatched' : e.status
  // A skipped email keeps no fields at all (a stub, so it is never fetched again).
  const keep = e !== null && e.status !== 'skipped' ? e : null
  const binds = [
    keep?.kind ?? null, cap(senderDomain, 80), cap(keep?.merchant ?? null, 80), keep?.paymentVia ?? null, keep?.cardLast4 ?? null,
    keep?.orderRef ?? null, keep?.receiptDate ?? null, keep?.relatedDate ?? null, keep?.currency ?? null,
    keep?.totalCents ?? null, keep?.taxCents ?? null, keep?.shippingCents ?? null,
    keep && keep.charges.length > 0 ? keep.chargesJson : null, cap(model, 64),
  ] as const
  return { status, binds }
}

interface ItemJson { d: string; a: number | null; q: number | null; c: string | null }

function itemsJson(e: ExtractedReceipt | null): string {
  if (!e || e.status === 'skipped') return '[]'
  const items: ItemJson[] = []
  for (const it of e.items) {
    const d = it.description.trim().slice(0, 120)
    if (!d || items.length >= 20) continue
    items.push({ d, a: it.amountCents, q: it.quantity, c: it.categoryHint })
  }
  return JSON.stringify(items)
}

export const INSERT_RECEIPT_SQL = `INSERT OR IGNORE INTO receipts (id, connection_id, gmail_msg_id, email_date, status, attempts, error_code, kind, sender_domain, merchant,
  payment_via, card_last4, order_ref, receipt_date, related_date, currency, total_cents, tax_cents, shipping_cents, charges_json, extract_model, created_at, updated_at, updated_by)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?22, '${ACTOR}'
WHERE EXISTS (SELECT 1 FROM email_connections WHERE id = ?2 AND status = 'active')`

/** Items of one receipt from one JSON array. The category hint must be a real category (else NULL), so a bad hint never fails the batch. */
export const INSERT_ITEMS_SQL = `INSERT INTO receipt_items (receipt_id, seq, description, amount_cents, quantity, category_hint)
SELECT ?1, j.key + 1, json_extract(j.value, '$.d'), json_extract(j.value, '$.a'), json_extract(j.value, '$.q'),
  (SELECT c.id FROM categories c WHERE c.id = json_extract(j.value, '$.c'))
FROM json_each(?2) j WHERE EXISTS (SELECT 1 FROM receipts r WHERE r.id = ?1 AND r.updated_at = ?3)`

export interface NewReceiptInput {
  connectionId: string
  gmailMsgId: string
  /** 'YYYY-MM-DD' (the email's own date). */
  emailDate: string
  /** null = extraction failed and will be retried; failureCode says why. */
  extracted: ExtractedReceipt | null
  failureCode?: string | null
  senderDomain?: string | null
  model?: string | null
}

export interface InsertedReceipt { id: string; inserted: boolean }

/**
 * Insert one receipt and its items in one batch. UNIQUE (connection_id, gmail_msg_id) with INSERT OR IGNORE is the
 * dedupe: a message stored by an overlapping run or a second Worker changes nothing (inserted=false) and its items
 * are not written (their insert is guarded by the new row's own created stamp).
 */
export async function insertReceipt(db: Db, r: NewReceiptInput, now: Date): Promise<InsertedReceipt> {
  const id = newId('r')
  const at = iso(now)
  const { status, binds } = fieldsOf(r.extracted, r.senderDomain ?? null, r.model ?? null)
  const attempts = r.extracted === null ? 1 : 0
  const res = await db.batch([
    db.prepare(INSERT_RECEIPT_SQL).bind(id, r.connectionId, r.gmailMsgId, r.emailDate, status, attempts, r.extracted === null ? (r.failureCode ?? null) : null, ...binds, at),
    db.prepare(INSERT_ITEMS_SQL).bind(id, itemsJson(r.extracted), at),
  ])
  return { id, inserted: (res[0].meta?.changes ?? 0) > 0 }
}

export const RETRY_SQL = `SELECT id, gmail_msg_id, email_date, attempts FROM receipts
WHERE connection_id = ?1 AND status IN ('pending','error') AND attempts < ${MAX_ATTEMPTS} ORDER BY attempts, id LIMIT ?2`

export interface RetryRow { id: string; gmailMsgId: string; emailDate: string; attempts: number }

export async function loadRetryReceipts(db: Db, connectionId: string, limit: number): Promise<RetryRow[]> {
  const { results } = await db.prepare(RETRY_SQL).bind(connectionId, Math.max(1, Math.floor(limit))).all<{ id: string; gmail_msg_id: string; email_date: string; attempts: number }>()
  return results.map((r) => ({ id: r.id, gmailMsgId: r.gmail_msg_id, emailDate: r.email_date, attempts: r.attempts }))
}

export const FAIL_SQL = `UPDATE receipts SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'error' ELSE 'pending' END,
  error_code = ?3, updated_at = ?2, updated_by = '${ACTOR}'
WHERE id = ?1 AND status IN ('pending','error') AND attempts < 9`

/** A retry failed again: attempts + 1; at the limit the receipt becomes 'error' (shown as "could not read"). */
export async function recordFailure(db: Db, receiptId: string, code: string, now: Date): Promise<void> {
  await db.prepare(FAIL_SQL).bind(receiptId, iso(now), code).run()
}

export const COMPLETE_SQL = `UPDATE receipts SET status = ?3, error_code = NULL, kind = ?4, sender_domain = coalesce(?5, sender_domain), merchant = ?6, payment_via = ?7,
  card_last4 = ?8, order_ref = ?9, receipt_date = ?10, related_date = ?11, currency = ?12, total_cents = ?13, tax_cents = ?14, shipping_cents = ?15,
  charges_json = ?16, extract_model = ?17, updated_at = ?2, updated_by = '${ACTOR}'
WHERE id = ?1 AND status IN ('pending','error')`
export const CLEAR_ITEMS_SQL = `DELETE FROM receipt_items WHERE receipt_id = ?1 AND EXISTS (SELECT 1 FROM receipts r WHERE r.id = ?1 AND r.updated_at = ?2)`

/** A retry succeeded: fill the stored row (still pending or error) and its items. */
export async function completeReceipt(db: Db, receiptId: string, e: ExtractedReceipt, model: string | null, senderDomain: string | null, now: Date): Promise<boolean> {
  const at = iso(now)
  const { status, binds } = fieldsOf(e, senderDomain, model)
  const res = await db.batch([
    db.prepare(COMPLETE_SQL).bind(receiptId, at, status, ...binds),
    db.prepare(CLEAR_ITEMS_SQL).bind(receiptId, at),
    db.prepare(INSERT_ITEMS_SQL).bind(receiptId, itemsJson(e), at),
  ])
  return (res[0].meta?.changes ?? 0) > 0
}

// ---------- stale ----------

/** Receipts whose base date is on or before this are stale (isStale: more than STALE_AFTER_DAYS before today). */
export function staleCutoff(today: string): string {
  return addDays(today, -(STALE_AFTER_DAYS + 1))
}
/** Earliest base date an open receipt can have and still not be stale. */
export function openSince(today: string): string {
  return addDays(today, -STALE_AFTER_DAYS)
}

const OPEN_BASE = `coalesce(receipt_date, email_date)`
export const STALE_SUPERSEDE_SQL = `UPDATE receipt_matches SET status = 'superseded', decided_at = ?3, decided_by = '${ACTOR}'
WHERE status = 'suggested' AND receipt_id IN (SELECT id FROM receipts WHERE connection_id = ?1 AND status IN ('unmatched','suggested') AND ${OPEN_BASE} <= ?2)`
export const STALE_DISMISS_SQL = `UPDATE receipts SET status = 'dismissed', updated_at = ?3, updated_by = '${ACTOR}'
WHERE connection_id = ?1 AND status IN ('unmatched','suggested') AND ${OPEN_BASE} <= ?2`
/** Upload twins: one person's uploads (idx_rcpt_up_open). */
export const UP_STALE_SUPERSEDE_SQL = `UPDATE receipt_matches SET status = 'superseded', decided_at = ?3, decided_by = '${ACTOR}'
WHERE status = 'suggested' AND receipt_id IN (SELECT id FROM receipts WHERE uploader_email = ?1 AND uploader_email IS NOT NULL AND status IN ('unmatched','suggested') AND ${OPEN_BASE} <= ?2)`
export const UP_STALE_DISMISS_SQL = `UPDATE receipts SET status = 'dismissed', updated_at = ?3, updated_by = '${ACTOR}'
WHERE uploader_email = ?1 AND uploader_email IS NOT NULL AND status IN ('unmatched','suggested') AND ${OPEN_BASE} <= ?2`

/** Unmatched or suggested receipts older than 75 days go dismissed on their own (their open suggestions are superseded). Returns how many. */
export async function markStale(db: Db, scope: ReceiptScope | string, now: Date): Promise<number> {
  const sc = asScope(scope)
  const [supersede, dismiss, key] = sc.kind === 'connection' ? [STALE_SUPERSEDE_SQL, STALE_DISMISS_SQL, sc.connectionId] : [UP_STALE_SUPERSEDE_SQL, UP_STALE_DISMISS_SQL, sc.email]
  const cutoff = staleCutoff(dayOf(now))
  const at = iso(now)
  const res = await db.batch([
    db.prepare(supersede).bind(key, cutoff, at),
    db.prepare(dismiss).bind(key, cutoff, at),
  ])
  return res[1].meta?.changes ?? 0
}

// ---------- open receipts and candidate bank rows ----------

export const OPEN_RECEIPTS_SQL = `SELECT id, kind, merchant, payment_via, card_last4, order_ref, sender_domain, currency, email_date, receipt_date, related_date, total_cents, charges_json
FROM receipts WHERE connection_id = ?1 AND status IN ('unmatched','suggested') AND ${OPEN_BASE} >= ?2
ORDER BY ${OPEN_BASE} DESC LIMIT ${MAX_OPEN_PER_RUN}`
/** Upload twin (idx_rcpt_up_open): one person's open uploads. */
export const UP_OPEN_RECEIPTS_SQL = `SELECT id, kind, merchant, payment_via, card_last4, order_ref, sender_domain, currency, email_date, receipt_date, related_date, total_cents, charges_json
FROM receipts WHERE uploader_email = ?1 AND uploader_email IS NOT NULL AND status IN ('unmatched','suggested') AND ${OPEN_BASE} >= ?2
ORDER BY ${OPEN_BASE} DESC LIMIT ${MAX_OPEN_PER_RUN}`
export const ITEMS_SQL = `SELECT receipt_id, seq, description, amount_cents, quantity, category_hint FROM receipt_items
WHERE receipt_id IN (SELECT value FROM json_each(?1)) ORDER BY receipt_id, seq`

function parseCharges(text: unknown): MatchReceipt['charges'] {
  if (typeof text !== 'string') return []
  try {
    const arr = JSON.parse(text) as unknown
    if (!Array.isArray(arr)) return []
    return arr.flatMap((c) => {
      const o = c as { amountCents?: unknown; last4?: unknown }
      return typeof o?.amountCents === 'number' ? [{ amountCents: o.amountCents, last4: typeof o.last4 === 'string' ? o.last4 : null }] : []
    })
  } catch {
    return []
  }
}

/**
 * Open receipts (unmatched or suggested, not stale) as matcher input, with their items, newest first. Two reads in
 * all: idx_rcpt_open, then one items read for the whole set (the primary key).
 */
export async function loadOpenReceipts(db: Db, scope: ReceiptScope | string, now: Date): Promise<MatchReceipt[]> {
  const sc = asScope(scope)
  const { results } = await db.prepare(sc.kind === 'connection' ? OPEN_RECEIPTS_SQL : UP_OPEN_RECEIPTS_SQL)
    .bind(sc.kind === 'connection' ? sc.connectionId : sc.email, openSince(dayOf(now))).all<Record<string, unknown>>()
  if (results.length === 0) return []
  const items = await db.prepare(ITEMS_SQL).bind(JSON.stringify(results.map((r) => r.id))).all<Record<string, unknown>>()
  const byReceipt = new Map<string, MatchReceipt['items']>()
  for (const it of items.results) {
    const list = byReceipt.get(it.receipt_id as string) ?? []
    list.push({ description: it.description as string, amountCents: (it.amount_cents as number | null) ?? null, quantity: (it.quantity as number | null) ?? null, categoryHint: (it.category_hint as string | null) ?? null })
    byReceipt.set(it.receipt_id as string, list)
  }
  return results.map((r) => ({
    id: r.id as string, kind: (r.kind as MatchReceipt['kind']) ?? null, merchant: (r.merchant as string | null) ?? null, paymentVia: (r.payment_via as string | null) ?? null,
    cardLast4: (r.card_last4 as string | null) ?? null, orderRef: (r.order_ref as string | null) ?? null, senderDomain: (r.sender_domain as string | null) ?? null, currency: (r.currency as string | null) ?? null, emailDate: r.email_date as string,
    receiptDate: (r.receipt_date as string | null) ?? null, relatedDate: (r.related_date as string | null) ?? null, totalCents: (r.total_cents as number | null) ?? null,
    charges: parseCharges(r.charges_json), items: byReceipt.get(r.id as string) ?? [],
  }))
}

/**
 * Applied receipts of the connection the matcher's repeat-email guard can compare with an open one: those sharing an
 * order_ref (?2 = JSON array of order refs; idx_rcpt_order), and those with no order_ref from a sender domain of an
 * open receipt without one (?3 = JSON array of domains, ?4 = earliest email_date; idx_rcpt_review).
 */
export const APPLIED_SIBLINGS_SQL = `SELECT order_ref, kind, sender_domain, coalesce(receipt_date, email_date) AS base_date, total_cents, charges_json FROM receipts
WHERE connection_id = ?1 AND status = 'applied' AND order_ref IN (SELECT value FROM json_each(?2))
UNION ALL
SELECT order_ref, kind, sender_domain, coalesce(receipt_date, email_date) AS base_date, total_cents, charges_json FROM receipts
WHERE connection_id = ?1 AND status = 'applied' AND email_date >= ?4 AND order_ref IS NULL AND sender_domain IN (SELECT value FROM json_each(?3))`

/** Upload twin: a photo has no sender domain, so only the order_ref arm applies (idx_rcpt_up_review). */
export const UP_APPLIED_SIBLINGS_SQL = `SELECT order_ref, kind, sender_domain, coalesce(receipt_date, email_date) AS base_date, total_cents, charges_json FROM receipts
WHERE uploader_email = ?1 AND uploader_email IS NOT NULL AND status = 'applied' AND order_ref IN (SELECT value FROM json_each(?2))`

/** Applied receipts that could be the twin of an open one (see APPLIED_SIBLINGS_SQL): the matcher's repeat-email guard. */
export async function loadAppliedSiblings(db: Db, scope: ReceiptScope | string,
  open: ReadonlyArray<Pick<MatchReceipt, 'orderRef' | 'senderDomain' | 'emailDate' | 'receiptDate'>>): Promise<AppliedSibling[]> {
  const sc = asScope(scope)
  if (sc.kind === 'upload') {
    const upRefs = [...new Set(open.flatMap((r) => (r.orderRef ? [r.orderRef] : [])))]
    if (upRefs.length === 0) return []
    const { results } = await db.prepare(UP_APPLIED_SIBLINGS_SQL).bind(sc.email, JSON.stringify(upRefs)).all<Record<string, unknown>>()
    return siblingsOf(results)
  }
  const connectionId = sc.connectionId
  const refs = [...new Set(open.flatMap((r) => (r.orderRef ? [r.orderRef] : [])))]
  const noRef = open.filter((r) => !r.orderRef && r.senderDomain)
  if (refs.length === 0 && noRef.length === 0) return []
  const domains = [...new Set(noRef.map((r) => r.senderDomain as string))]
  const earliest = noRef.reduce((m, r) => { const d = r.receiptDate ?? r.emailDate; return d < m ? d : m }, '9999-12-31')
  const from = noRef.length === 0 ? '9999-12-31' : addDays(earliest, -NO_REF_REPEAT_DAYS)
  const { results } = await db.prepare(APPLIED_SIBLINGS_SQL).bind(connectionId, JSON.stringify(refs), JSON.stringify(domains), from).all<Record<string, unknown>>()
  return siblingsOf(results)
}

function siblingsOf(results: ReadonlyArray<Record<string, unknown>>): AppliedSibling[] {
  return results.flatMap((r) => {
    const amountCents = chargedCents({ totalCents: (r.total_cents as number | null) ?? null, charges: parseCharges(r.charges_json) })
    return amountCents === null ? [] : [{
      orderRef: (r.order_ref as string | null) ?? null, amountCents, refund: r.kind === 'refund',
      baseDate: (r.base_date as string | null) ?? null, senderDomain: (r.sender_domain as string | null) ?? null,
    }]
  })
}

/** Disjoint, sorted day ranges covering every receipt's candidateWindow (overlapping or touching windows merge). */
export function mergedWindows(receipts: ReadonlyArray<Pick<MatchReceipt, 'kind' | 'emailDate' | 'receiptDate'>>): Array<{ from: string; to: string }> {
  const ws = receipts.map(candidateWindow).filter((w): w is { from: string; to: string } => w !== null).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  const out: Array<{ from: string; to: string }> = []
  for (const w of ws) {
    const last = out[out.length - 1]
    if (last && w.from <= addDays(last.to, 1)) {
      if (w.to > last.to) last.to = w.to
    } else out.push({ from: w.from, to: w.to })
  }
  return out
}

/** A person set it: a manual kind or category, a person's address on the row, or a person's newest category edit (not made by a rule). */
const personEditedSql = (t: string) => `(${t}.category_source = 'manual' OR ${t}.kind_source = 'manual' OR instr(${t}.updated_by, '@') > 0 OR EXISTS (
    SELECT 1 FROM category_edits e WHERE e.id = (SELECT e2.id FROM category_edits e2 WHERE e2.txn_id = ${t}.id ORDER BY e2.edited_at DESC, e2.id DESC LIMIT 1)
      AND instr(e.edited_by, '@') > 0 AND e.rule_id IS NULL))`

/** Kinds the matcher can pair with a receipt (receiptMatch rowFits and decline fees); transfers and loan rows never. */
const CANDIDATE_KINDS = `'spend','refund','fee','other','transfer_external','income'`

/** ?1 = JSON [[from,to],...] of disjoint windows: one range read of idx_txn_date per window, one statement for the run. */
export const CANDIDATE_ROWS_SQL = `SELECT t.id, t.account_id, a.last4 AS account_last4, t.posted_date, t.amount_cents, t.kind, t.merchant_key, t.merchant_name, t.category_id, t.updated_at,
  ${personEditedSql('t')} AS person_edited,
  EXISTS (SELECT 1 FROM receipt_matches m WHERE m.txn_id = t.id AND m.status = 'applied') AS taken
FROM json_each(?1) w
JOIN transactions t INDEXED BY idx_txn_date ON t.posted_date >= json_extract(w.value, '$[0]') AND t.posted_date <= json_extract(w.value, '$[1]')
JOIN accounts a ON a.id = t.account_id
WHERE t.kind IN (${CANDIDATE_KINDS})`

export interface CandidateRows { rows: MatchBankRow[]; takenTxnIds: string[] }

/** Bank rows inside any receipt's candidate window, read once per run. Rows already applied to a receipt come back as taken. */
export async function loadCandidateRows(db: Db, receipts: ReadonlyArray<Pick<MatchReceipt, 'kind' | 'emailDate' | 'receiptDate'>>): Promise<CandidateRows> {
  const windows = mergedWindows(receipts)
  if (windows.length === 0) return { rows: [], takenTxnIds: [] }
  const { results } = await db.prepare(CANDIDATE_ROWS_SQL).bind(JSON.stringify(windows.map((w) => [w.from, w.to]))).all<Record<string, unknown>>()
  const rows: MatchBankRow[] = []
  const takenTxnIds: string[] = []
  for (const r of results) {
    rows.push({
      id: r.id as string, accountId: r.account_id as string, accountLast4: (r.account_last4 as string | null) ?? null, postedDate: r.posted_date as string,
      amountCents: r.amount_cents as number, kind: r.kind as string, merchantKey: (r.merchant_key as string | null) || null, merchantName: (r.merchant_name as string | null) || null,
      categoryId: (r.category_id as string | null) ?? null, updatedAt: r.updated_at as string, personEdited: r.person_edited === 1,
    })
    if (r.taken === 1) takenTxnIds.push(r.id as string)
  }
  return { rows, takenTxnIds }
}

// ---------- writing suggested matches ----------

export const REJECTED_SQL = `SELECT receipt_id, txn_id FROM receipt_matches WHERE status = 'rejected' AND receipt_id IN (SELECT value FROM json_each(?1))`
export const SUPERSEDE_SQL = `UPDATE receipt_matches SET status = 'superseded', decided_at = ?2, decided_by = '${ACTOR}'
WHERE receipt_id = ?1 AND status = 'suggested' AND txn_id NOT IN (SELECT value FROM json_each(?3))`
/** A suggestion is written only while its receipt is still open and the bank row still exists; a rejected or applied pair is never touched. */
export const UPSERT_MATCH_SQL = `INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, proposed_category_id, txn_updated_at, created_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'suggested', ?7, ?8, ?9
WHERE EXISTS (SELECT 1 FROM receipts r WHERE r.id = ?1 AND r.status IN ('unmatched','suggested')) AND EXISTS (SELECT 1 FROM transactions t WHERE t.id = ?2)
ON CONFLICT (receipt_id, txn_id) DO UPDATE SET group_key = excluded.group_key, rule = excluded.rule, share_cents = excluded.share_cents, score = excluded.score,
  status = 'suggested', proposed_category_id = excluded.proposed_category_id, txn_updated_at = excluded.txn_updated_at, decided_at = NULL, decided_by = NULL
WHERE receipt_matches.status IN ('suggested','superseded')`
export const SET_RECEIPT_STATUS_SQL = `UPDATE receipts SET status = ?2, updated_at = ?3, updated_by = '${ACTOR}' WHERE id = ?1 AND status IN ('unmatched','suggested') AND status <> ?2`

export interface WriteCounts { suggested: number; unmatched: number; noTotal: number; proposals: MatchProposal[] }

/**
 * Store the matcher's results: suggested matches (new ones inserted, a changed one updated, ones no longer proposed
 * superseded, ones a person rejected never re-suggested) and each receipt's status. Writes only receipts, receipt_matches.
 * Returns the proposals kept (for autoApplyMatches).
 */
export async function writeMatchResults(db: Db, results: readonly ReceiptMatchResult[], now: Date): Promise<WriteCounts> {
  const out: WriteCounts = { suggested: 0, unmatched: 0, noTotal: 0, proposals: [] }
  if (results.length === 0) return out
  const at = iso(now)

  const rej = await db.prepare(REJECTED_SQL).bind(JSON.stringify(results.map((r) => r.receiptId))).all<{ receipt_id: string; txn_id: string }>()
  const rejected = new Set(rej.results.map((r) => `${r.receipt_id}|${r.txn_id}`))

  const kept = new Map<string, MatchProposal[]>()
  const keepTxns = new Map<string, Set<string>>()
  for (const r of results) {
    const ok = r.proposals.filter((p) => !p.parts.some((x) => rejected.has(`${x.receiptId}|${x.txnId}`)))
    kept.set(r.receiptId, ok)
    for (const p of ok) for (const x of p.parts) {
      const s = keepTxns.get(x.receiptId) ?? new Set<string>()
      s.add(x.txnId)
      keepTxns.set(x.receiptId, s)
    }
  }

  const stmts: D1PreparedStatement[] = []
  for (const r of results) {
    const props = kept.get(r.receiptId) ?? []
    const status = r.status === 'suggested' && props.length === 0 ? 'unmatched' : r.status
    if (status === 'suggested') out.suggested++
    else if (status === 'no_total') out.noTotal++
    else out.unmatched++
    stmts.push(db.prepare(SUPERSEDE_SQL).bind(r.receiptId, at, JSON.stringify([...(keepTxns.get(r.receiptId) ?? [])])))
    for (const p of props) {
      out.proposals.push(p)
      for (const x of p.parts) {
        stmts.push(db.prepare(UPSERT_MATCH_SQL).bind(x.receiptId, x.txnId, p.groupKey, p.rule, x.shareCents, p.score, p.proposedCategoryId, x.txnUpdatedAt, at))
      }
    }
    stmts.push(db.prepare(SET_RECEIPT_STATUS_SQL).bind(r.receiptId, status, at))
  }
  await runBatches(db, stmts)
  return out
}

// ---------- auto-apply (off at launch) ----------

/** RECEIPTS_AUTO_APPLY: only the string "1" turns it on. */
export function autoApplyEnabled(v: string | undefined | null): boolean {
  return v === '1'
}

/** A row the Worker may touch: not manual, no person's address, newest category edit not a person's. Same guard as the apply route. */
const AUTO_ROW_GUARD = `t.category_source <> 'manual' AND t.kind_source <> 'manual' AND instr(t.updated_by, '@') = 0 AND NOT EXISTS (
    SELECT 1 FROM category_edits e WHERE e.id = (SELECT e2.id FROM category_edits e2 WHERE e2.txn_id = t.id ORDER BY e2.edited_at DESC, e2.id DESC LIMIT 1)
      AND instr(e.edited_by, '@') > 0 AND e.rule_id IS NULL)`

/** ?1 stamp, ?2 receipt, ?3 txn, ?4 the row's updated_at when proposed. */
export const AUTO_LINK_SQL = `UPDATE receipt_matches SET status = 'applied', decided_at = ?1, decided_by = '${ACTOR}'
WHERE receipt_id = ?2 AND txn_id = ?3 AND status = 'suggested'
  AND EXISTS (SELECT 1 FROM receipts r WHERE r.id = ?2 AND r.source = 'email' AND r.status IN ('unmatched','suggested'))
  AND EXISTS (SELECT 1 FROM transactions t WHERE t.id = ?3 AND t.updated_at = ?4 AND ${AUTO_ROW_GUARD})`
/** ?1 category, ?2 new stamp, ?3 txn, ?4 prev updated_at, ?5 receipt, ?6 link stamp. Only a row with no category; never the note. */
export const AUTO_CATEGORY_SQL = `UPDATE transactions AS t SET category_id = ?1, category_source = 'auto', updated_by = '${ACTOR}', updated_at = ?2
WHERE t.id = ?3 AND t.updated_at = ?4 AND t.category_id IS NULL AND ${AUTO_ROW_GUARD}
  AND EXISTS (SELECT 1 FROM receipt_matches m WHERE m.receipt_id = ?5 AND m.txn_id = ?3 AND m.status = 'applied' AND m.decided_at = ?6 AND m.decided_by = '${ACTOR}')`
export const AUTO_AUDIT_SQL = `INSERT INTO category_edits (txn_id, old_category_id, new_category_id, old_kind, new_kind, rule_id, edited_at, edited_by)
SELECT t.id, NULL, ?1, t.kind, t.kind, NULL, ?2, '${ACTOR}' FROM transactions t WHERE t.id = ?3 AND t.updated_at = ?2 AND t.updated_by = '${ACTOR}'`
export const AUTO_RECEIPT_SQL = `UPDATE receipts SET status = 'applied', updated_at = ?3, updated_by = '${ACTOR}'
WHERE id = ?1 AND source = 'email' AND status IN ('unmatched','suggested')
  AND EXISTS (SELECT 1 FROM receipt_matches m WHERE m.receipt_id = ?1 AND m.txn_id = ?2 AND m.status = 'applied' AND m.decided_at = ?3 AND m.decided_by = '${ACTOR}')`

export interface AutoApplyOptions { enabled: boolean; minScore?: number }

/**
 * Link the receipts the matcher marked auto-eligible (rule exact, unique, score >= minScore, row not person-edited), when
 * enabled. Each proposal is its own batch (all or nothing), `updated_at`-guarded, so a row someone edited meanwhile, a
 * manual row or a person's latest edit is left alone. The category is set only on a row with none; the note is never
 * written. Returns the number applied. With enabled=false it does nothing at all.
 */
export async function autoApplyMatches(db: Db, proposals: readonly MatchProposal[], now: Date, opts: AutoApplyOptions): Promise<number> {
  if (!opts.enabled) return 0
  const min = opts.minScore ?? AUTO_MIN_SCORE
  let applied = 0
  for (const p of proposals) {
    if (!p.autoEligible || p.rule !== 'exact' || !p.unique || p.split || p.parts.length !== 1 || p.score < min) continue
    const part = p.parts[0]
    const linkAt = nextStamp(null, now.getTime())
    const rowStamp = nextStamp(part.txnUpdatedAt, now.getTime())
    const stmts = [db.prepare(AUTO_LINK_SQL).bind(linkAt, part.receiptId, part.txnId, part.txnUpdatedAt)]
    if (p.proposedCategoryId) {
      stmts.push(
        db.prepare(AUTO_CATEGORY_SQL).bind(p.proposedCategoryId, rowStamp, part.txnId, part.txnUpdatedAt, part.receiptId, linkAt),
        db.prepare(AUTO_AUDIT_SQL).bind(p.proposedCategoryId, rowStamp, part.txnId),
      )
    }
    stmts.push(db.prepare(AUTO_RECEIPT_SQL).bind(part.receiptId, part.txnId, linkAt))
    try {
      const res = await db.batch(stmts)
      if ((res[0].meta?.changes ?? 0) > 0) applied++
    } catch {
      // A constraint (another receipt already applied to the row) rolls this proposal back; the rest go on.
    }
  }
  return applied
}

// ---------- photo uploads ----------

/** The stored image key of an upload: 'img/<receipt id>.jpg' (the schema CHECK holds the same shape). */
export const imageKeyOf = (id: string): string => `img/${id}.jpg`
export const newUploadId = (): string => newId('r')

export interface NewUploadInput {
  id: string
  /** Lower-cased signed-in address of the uploader. */
  uploaderEmail: string
  /** sha256 hex of the stripped bytes. */
  imageSha256: string
  imageBytes: number
}

export const INSERT_UPLOAD_SQL = `INSERT INTO receipts (id, connection_id, gmail_msg_id, email_date, status, attempts, created_at, updated_at, updated_by,
  source, uploader_email, image_key, image_sha256, image_bytes)
VALUES (?1, NULL, NULL, ?2, 'pending', 0, ?3, ?3, '${ACTOR}', 'upload', ?4, ?5, ?6, ?7)`

export interface UploadRow { id: string; uploaderEmail: string; status: string; imageKey: string | null; attempts: number; emailDate: string }
export type InsertedUpload = { ok: true; id: string } | { ok: false; duplicate: UploadRow | null }

export const UPLOAD_BY_HASH_SQL = `SELECT id, uploader_email, status, image_key, attempts, email_date FROM receipts WHERE image_sha256 = ?1 AND image_sha256 IS NOT NULL`
export const UPLOAD_BY_ID_SQL = `SELECT id, uploader_email, status, image_key, attempts, email_date FROM receipts WHERE id = ?1 AND source = 'upload'`
/** ?1 uploader, ?2 start of the UTC day (ISO). */
export const UPLOADS_TODAY_SQL = `SELECT count(*) AS n FROM receipts WHERE uploader_email = ?1 AND uploader_email IS NOT NULL AND created_at >= ?2`
export const UPLOAD_RETRY_SQL = `SELECT id, uploader_email, status, image_key, attempts, email_date FROM receipts
WHERE uploader_email IS NOT NULL AND status IN ('pending','error') AND attempts < ${MAX_ATTEMPTS} ORDER BY attempts, id LIMIT ?1`
/** Rows whose image is past retention (?1 = ISO cutoff). Scans the small idx_rcpt_up_day partial index: uploads are few. */
export const EXPIRED_IMAGES_SQL = `SELECT id, image_key FROM receipts WHERE uploader_email IS NOT NULL AND created_at < ?1 AND image_key IS NOT NULL ORDER BY created_at LIMIT ?2`
export const CLEAR_IMAGE_KEY_SQL = `UPDATE receipts SET image_key = NULL, updated_at = ?2, updated_by = '${ACTOR}' WHERE id = ?1 AND uploader_email IS NOT NULL AND image_key IS NOT NULL`
export const DELETE_UPLOAD_SQL = `DELETE FROM receipts WHERE id = ?1 AND uploader_email = ?2 AND uploader_email IS NOT NULL`

const uploadRow = (r: Record<string, unknown>): UploadRow => ({
  id: r.id as string, uploaderEmail: r.uploader_email as string, status: r.status as string,
  imageKey: (r.image_key as string | null) ?? null, attempts: r.attempts as number, emailDate: r.email_date as string,
})

export async function findUploadByHash(db: Db, sha256: string): Promise<UploadRow | null> {
  const r = await db.prepare(UPLOAD_BY_HASH_SQL).bind(sha256).first<Record<string, unknown>>()
  return r ? uploadRow(r) : null
}

export async function loadUpload(db: Db, id: string): Promise<UploadRow | null> {
  const r = await db.prepare(UPLOAD_BY_ID_SQL).bind(id).first<Record<string, unknown>>()
  return r ? uploadRow(r) : null
}

/** Insert one pending upload row. The unique image hash is the household-wide dedupe: a collision (a race) answers with the existing row. */
export async function insertUploadReceipt(db: Db, u: NewUploadInput, now: Date): Promise<InsertedUpload> {
  try {
    await db.prepare(INSERT_UPLOAD_SQL).bind(u.id, dayOf(now), iso(now), u.uploaderEmail, imageKeyOf(u.id), u.imageSha256, u.imageBytes).run()
    return { ok: true, id: u.id }
  } catch (e) {
    if (/UNIQUE/i.test(e instanceof Error ? e.message : '')) return { ok: false, duplicate: await findUploadByHash(db, u.imageSha256) }
    throw e
  }
}

export async function uploadsToday(db: Db, email: string, now: Date): Promise<number> {
  const r = await db.prepare(UPLOADS_TODAY_SQL).bind(email, `${dayOf(now)}T00:00:00.000Z`).first<{ n: number }>()
  return r?.n ?? 0
}

/** Pending or failed uploads still under the attempt limit, across people, oldest attempts first. */
export async function loadUploadRetries(db: Db, limit: number): Promise<UploadRow[]> {
  const { results } = await db.prepare(UPLOAD_RETRY_SQL).bind(Math.max(1, Math.floor(limit))).all<Record<string, unknown>>()
  return results.map(uploadRow)
}

/** Delete the uploader's own row (items and matches cascade). True when a row went; false for a missing row or someone else's. */
export async function deleteUploadReceipt(db: Db, id: string, email: string): Promise<boolean> {
  const res = await db.prepare(DELETE_UPLOAD_SQL).bind(id, email).run()
  return (res.meta?.changes ?? 0) > 0
}

export interface ExpiredImage { id: string; imageKey: string }
export async function loadExpiredImages(db: Db, olderThan: Date, limit: number): Promise<ExpiredImage[]> {
  const { results } = await db.prepare(EXPIRED_IMAGES_SQL).bind(iso(olderThan), Math.max(1, Math.floor(limit))).all<{ id: string; image_key: string }>()
  return results.map((r) => ({ id: r.id, imageKey: r.image_key }))
}

/** Keep the row (its facts, matches and hash) and drop only the pointer to the deleted image. */
export async function clearImageKey(db: Db, id: string, now: Date): Promise<void> {
  await db.prepare(CLEAR_IMAGE_KEY_SQL).bind(id, iso(now)).run()
}

// ---------- run rows and the daily cap ----------

export interface RunCounts {
  listed: number; fetched: number; extracted: number; skipped: number; matched: number; autoApplied: number
  modelInTokens: number; modelOutTokens: number
}
export const ZERO_COUNTS: RunCounts = { listed: 0, fetched: 0, extracted: 0, skipped: 0, matched: 0, autoApplied: 0, modelInTokens: 0, modelOutTokens: 0 }

export const CREATE_RUN_SQL = `INSERT INTO receipt_sync_runs (connection_id, run_trigger, started_at) VALUES (?1, ?2, ?3) RETURNING id`

/** Start a run row (cron or backfill; the manual route inserts its own). Returns the run id. */
export async function createRun(db: Db, connectionId: string, trigger: 'cron' | 'manual' | 'backfill', now: Date): Promise<number> {
  const r = await db.prepare(CREATE_RUN_SQL).bind(connectionId, trigger, iso(now)).first<{ id: number }>()
  if (!r) throw new Error('run_insert_failed')
  return r.id
}

/** A run still open and younger than this blocks another run on the same connection (a crashed run row ages out). */
export const OPEN_RUN_WINDOW_MS = 2 * 60_000
/** Like CREATE_RUN_SQL, but inserts nothing while the connection's newest run is open and under OPEN_RUN_WINDOW_MS old (?4 is that cutoff). */
export const CREATE_RUN_IF_IDLE_SQL = `INSERT INTO receipt_sync_runs (connection_id, run_trigger, started_at)
SELECT ?1, ?2, ?3 WHERE NOT EXISTS (
  SELECT 1 FROM (SELECT finished_at, started_at FROM receipt_sync_runs WHERE connection_id = ?1 ORDER BY id DESC LIMIT 1) last
  WHERE last.finished_at IS NULL AND last.started_at > ?4)
RETURNING id`

/** Start a cron run row unless another run of the connection is going (a manual run, or an earlier cron run still working).
 *  Returns the run id, or null when one is: the caller skips, so two runs never spend on the same mailbox at once. */
export async function createRunIfIdle(db: Db, connectionId: string, trigger: 'cron' | 'manual' | 'backfill', now: Date): Promise<number | null> {
  const r = await db.prepare(CREATE_RUN_IF_IDLE_SQL).bind(connectionId, trigger, iso(now), iso(new Date(now.getTime() - OPEN_RUN_WINDOW_MS))).first<{ id: number }>()
  return r?.id ?? null
}

export const FINISH_RUN_SQL = `UPDATE receipt_sync_runs SET finished_at = ?2, listed = ?3, fetched = ?4, extracted = ?5, skipped = ?6, matched = ?7, auto_applied = ?8,
  model_in_tokens = ?9, model_out_tokens = ?10, error_code = ?11 WHERE id = ?1 AND finished_at IS NULL`

/** Close a run row: counts, finished_at and error_code (a code or null). A run already closed is left as it is. */
export async function finishRun(db: Db, runId: number, c: RunCounts, errorCode: string | null, now: Date): Promise<void> {
  const nz = (n: number) => Math.max(0, Math.floor(n))
  await db.prepare(FINISH_RUN_SQL).bind(runId, iso(now), nz(c.listed), nz(c.fetched), nz(c.extracted), nz(c.skipped), nz(c.matched), nz(c.autoApplied),
    nz(c.modelInTokens), nz(c.modelOutTokens), errorCode).run()
}

export const PRUNE_RUNS_SQL = `DELETE FROM receipt_sync_runs WHERE connection_id = ?1
AND id < (SELECT id FROM receipt_sync_runs WHERE connection_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET ${KEEP_RUNS - 1})`

/** Keep the newest KEEP_RUNS run rows of the connection. */
export async function pruneRuns(db: Db, connectionId: string): Promise<void> {
  await db.prepare(PRUNE_RUNS_SQL).bind(connectionId).run()
}

/** Model calls made today (UTC) by the connection: each fetched email was at most one call, including the ones whose answer was
 *  invalid or that another run stored first (extracted + skipped would miss those). A day's rows are at most KEEP_RUNS. */
export const DAILY_CALLS_SQL = `SELECT coalesce(sum(fetched), 0) AS calls FROM receipt_sync_runs WHERE connection_id = ?1 AND started_at >= ?2`

export async function modelCallsToday(db: Db, connectionId: string, now: Date): Promise<number> {
  const r = await db.prepare(DAILY_CALLS_SQL).bind(connectionId, `${dayOf(now)}T00:00:00.000Z`).first<{ calls: number }>()
  return r?.calls ?? 0
}

/** How many more model calls this run may make under RECEIPTS_DAILY_CAP (0 = none left; a cap that is not a number allows none). */
export function capRemaining(dailyCap: number, usedToday: number): number {
  return Number.isFinite(dailyCap) ? Math.max(0, Math.floor(dailyCap) - Math.max(0, usedToday)) : 0
}
