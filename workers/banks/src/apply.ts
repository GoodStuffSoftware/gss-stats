// Sync, apply half (plan section 4.4): turn one fetched update into planned writes (decide), write them in D1 batches with
// the cursor LAST (applyPlan), and the per-tick driver (syncTick). Rules this file keeps (Mike's): a person's edit is never
// overwritten by a re-import, Plaid sync and pending-to-posted included. The only UPDATE of an existing transactions row
// writes the bank's own fields (dates, amount, description, pending, bank_ref, updated_at) and never updated_by, category_id,
// category_source, kind, kind_source, included or note; the pair step is pairUpdateSql, which carries its own manual guard.
// Every write is keyed, so a run that dies part way and repeats from the old cursor ends in the same state.
// Reads are indexed lookups (the two small config tables, accounts and active rules, are read whole). Logs: counts and codes.
import type { Account, MerchantRule, PairCandidate, ReviewReason, TxnKind } from '../../../src/lib/budget/types'
import { classifyRow } from '../../../src/lib/budget/classifyRow'
import { daysBetween } from '../../../src/lib/budget/dates'
import { dedupeKey } from '../../../src/lib/budget/dedupe'
import { pairTransfers } from '../../../src/lib/budget/pairing'
import { sameDayKey } from '../../../src/lib/budget/review'
import { pairUpdateSql } from '../../../src/lib/budget/sqlFile'
import { log } from './log'
import { createPlaidClient, type PlaidClient } from './plaid'
import { getItem, openAndRefreshToken, type Keys } from './store'
import { CHUNK_PAGES, TICK_QUERY_BUDGET, WORST_CHUNK_QUERIES, chooseTrigger, claim, fetchUpdate, release, releasedStamp, finishRun, normalize, pickDue, plaidErrorCode, startRun, type BankTxn, type FetchResult } from './sync'
import type { Env } from './env'

export const WRITER = 'sync:plaid'
export const CHUNK = 90
export const BATCH_SIZE = 100
export const KEEP_RUNS = 200
const BOUNDARY_DAYS = 3

type Update = Extract<FetchResult, { kind: 'ok' }>

export interface BankAcct { id: string; plaidAccountId: string; accountId: string | null; sync: string; syncFrom: string | null }
export interface MapRow {
  plaidTxnId: string; bankAccountId: string; txnId: string; role: 'inserted' | 'matched'; state: 'live' | 'dropped' | 'kept'
  updatedAt: string; postedDate: string; txnDate: string | null; amountCents: number; description: string; pending: number; bankRef: string | null
}
export interface Candidate { id: string; postedDate: string; amountCents: number }
export interface Normalized { added: BankTxn[]; modified: BankTxn[]; removed: string[]; skipped: number }

export interface State {
  now: Date
  accounts: Map<string, BankAcct> // by Plaid account id
  budgetAccounts: Account[]
  rules: MerchantRule[]
  mapped: Map<string, MapRow> // by Plaid transaction id
  candidates: Map<string, Candidate[]> // by bank account id (boundary candidates)
  /** Rows Plaid removed: txn id -> whether a person touched it, and its pair partner. */
  removedFacts: Map<string, { touched: boolean; pairId: string | null }>
  /** D1 queries loadState issued (for the per-invocation budget). */
  queries: number
}

export interface Fields { postedDate: string; txnDate: string | null; amountCents: number; description: string; pending: number }
export interface NewRow extends Fields {
  id: string; accountId: string; bankAccountId: string; plaidTxnId: string; bankRef: string
  merchantKey: string; merchantName: string; storeNo: string | null; counterpartyLast4: string | null
  kind: TxnKind; kindSource: string; categoryId: string | null; categorySource: string; ruleId: string | null; confidence: number
  needsReview: boolean; reviewReason: ReviewReason | null; debtAccountId: string | null; dupOf: string | null
}
export interface Counts {
  added: number; modified: number; removed: number; inserted: number; matched: number; flagged: number; posted: number; dropped: number; skipped: number
}
export interface Plan {
  inserts: NewRow[]
  matches: Array<{ plaidTxnId: string; bankAccountId: string; txnId: string }>
  inPlace: Array<{ oldPlaidId: string; newPlaidId: string; bankAccountId: string; txnId: string; bankRef: string; updatedAt: string } & Fields>
  updates: Array<{ txnId: string; updatedAt: string } & Fields>
  unmap: string[]
  dropped: string[]
  deletes: Array<{ txnId: string; pairId: string | null }>
  pairs: Array<[string, string]>
  counts: Counts
}

const ID = /^[A-Za-z0-9_-]{1,64}$/

/** The update as our fields: normalize each, count what cannot be used. */
export function prepareUpdate(u: Update): Normalized {
  let skipped = 0
  const conv = (list: unknown[]): BankTxn[] => {
    const out: BankTxn[] = []
    for (const t of list) {
      const n = normalize(t as Parameters<typeof normalize>[0])
      if (n) out.push(n)
      else skipped++
    }
    return out
  }
  const removed: string[] = []
  for (const r of u.removed) {
    const id = (r as { transaction_id?: unknown }).transaction_id
    if (typeof id === 'string' && ID.test(id)) removed.push(id)
  }
  return { added: conv(u.added), modified: conv(u.modified), removed, skipped }
}

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}
const marks = (n: number): string => Array.from({ length: n }, (_, i) => `?${i + 1}`).join(',')

/** Same text as sqlFile's nextStamp: strictly after the row's own updated_at. */
export function nextStamp(prev: string | null, now: number): string {
  const prevMs = prev ? Date.parse(prev) : NaN
  return new Date(Number.isFinite(prevMs) && prevMs >= now ? prevMs + 1 : now).toISOString()
}

// ---- reads (all indexed lookups, one set per run) -------------------------------------------------------------------

export const SQL = {
  bankAccounts: `SELECT id, plaid_account_id, account_id, sync, sync_from FROM bank_accounts WHERE item_id = ?1`,
  accounts: `SELECT id, label, kind, person_id, last4, is_debt, in_spending, credit_limit_cents, apr_bp FROM accounts`,
  rules: `SELECT id, merchant_key, store_no, account_id, amount_min_cents, amount_max_cents, set_category_id, set_kind, debt_account_id,
    display_name, confidence, review, review_reason, source, active FROM merchant_rules WHERE active = 1`,
  mapped: (n: number) => `SELECT b.plaid_txn_id, b.bank_account_id, b.txn_id, b.role, b.state, t.updated_at, t.posted_date, t.txn_date,
    t.amount_cents, t.description, t.pending, t.bank_ref FROM bank_txns b JOIN transactions t ON t.id = b.txn_id WHERE b.plaid_txn_id IN (${marks(n)})`,
  candidates: `SELECT t.id, t.posted_date, t.amount_cents FROM transactions t WHERE t.account_id = ?1
    AND t.posted_date BETWEEN date(?2,'-3 days') AND date(?2,'+3 days') AND NOT EXISTS (SELECT 1 FROM bank_txns b WHERE b.txn_id = t.id)`,
  touched: (n: number) => `SELECT t.id, t.pair_id, (instr(t.updated_by,'@') > 0 OR t.category_source = 'manual' OR t.kind_source = 'manual'
    OR t.note IS NOT NULL OR t.included = 0 OR EXISTS (SELECT 1 FROM receipt_matches m WHERE m.txn_id = t.id)) AS touched
    FROM transactions t WHERE t.id IN (${marks(n)})`,
  pairCandidates: `SELECT id, account_id, posted_date, amount_cents, kind, counterparty_last4 FROM transactions
    WHERE posted_date BETWEEN ?1 AND ?2 AND pair_id IS NULL AND pending = 0 AND kind_source NOT IN ('manual','rule')
    AND category_source <> 'manual' AND instr(updated_by,'@') = 0`,
  // The pending rows that post in this update: still pending in D1 when the read above runs, so they get their own read. Same guards.
  postedFacts: (n: number) => `SELECT id, account_id, kind, counterparty_last4 FROM transactions WHERE id IN (${marks(n)})
    AND pair_id IS NULL AND kind_source NOT IN ('manual','rule') AND category_source <> 'manual' AND instr(updated_by,'@') = 0`,
}

type Row = Record<string, unknown>
const s = (v: unknown): string => String(v)
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export async function loadState(db: D1Database, itemId: string, norm: Normalized, now: Date): Promise<State> {
  let queries = 3
  const [ba, ac, ru] = await Promise.all([
    db.prepare(SQL.bankAccounts).bind(itemId).all<Row>(),
    db.prepare(SQL.accounts).all<Row>(),
    db.prepare(SQL.rules).all<Row>(),
  ])
  const accounts = new Map<string, BankAcct>()
  for (const r of ba.results ?? []) {
    accounts.set(s(r.plaid_account_id), { id: s(r.id), plaidAccountId: s(r.plaid_account_id), accountId: sn(r.account_id), sync: s(r.sync), syncFrom: sn(r.sync_from) })
  }
  const budgetAccounts: Account[] = (ac.results ?? []).map((r) => ({
    id: s(r.id), label: s(r.label), kind: s(r.kind) as Account['kind'], personId: sn(r.person_id), last4: sn(r.last4),
    isDebt: Number(r.is_debt) === 1, inSpending: Number(r.in_spending) === 1, creditLimitCents: nn(r.credit_limit_cents), aprBp: nn(r.apr_bp),
  }))
  const rules: MerchantRule[] = (ru.results ?? []).map((r) => ({
    id: s(r.id), merchantKey: s(r.merchant_key), storeNo: sn(r.store_no), accountId: sn(r.account_id), amountMinCents: nn(r.amount_min_cents),
    amountMaxCents: nn(r.amount_max_cents), setCategoryId: sn(r.set_category_id), setKind: sn(r.set_kind) as TxnKind | null,
    debtAccountId: sn(r.debt_account_id), displayName: sn(r.display_name), confidence: Number(r.confidence), review: Number(r.review) === 1,
    reviewReason: sn(r.review_reason) as ReviewReason | null, source: s(r.source) as MerchantRule['source'], active: Number(r.active) === 1,
  }))

  const ids = new Set<string>()
  for (const t of [...norm.added, ...norm.modified]) {
    ids.add(t.plaidTxnId)
    if (t.pendingTransactionId) ids.add(t.pendingTransactionId)
  }
  for (const id of norm.removed) ids.add(id)
  const mapped = new Map<string, MapRow>()
  for (const part of chunks([...ids], CHUNK)) {
    const r = await db.prepare(SQL.mapped(part.length)).bind(...part).all<Row>()
    queries++
    for (const x of r.results ?? []) {
      mapped.set(s(x.plaid_txn_id), {
        plaidTxnId: s(x.plaid_txn_id), bankAccountId: s(x.bank_account_id), txnId: s(x.txn_id), role: s(x.role) as MapRow['role'],
        state: s(x.state) as MapRow['state'], updatedAt: s(x.updated_at), postedDate: s(x.posted_date), txnDate: sn(x.txn_date),
        amountCents: Number(x.amount_cents), description: s(x.description), pending: Number(x.pending), bankRef: sn(x.bank_ref),
      })
    }
  }

  // Boundary candidates: one query per account that has a posted new row near its sync_from.
  const candidates = new Map<string, Candidate[]>()
  for (const t of [...norm.added, ...norm.modified]) {
    const a = accounts.get(t.plaidAccountId)
    if (!a || a.sync !== 'on' || !a.syncFrom || candidates.has(a.id) || t.pending === 1 || mapped.has(t.plaidTxnId)) continue
    if (t.postedDate < a.syncFrom || daysBetween(a.syncFrom, t.postedDate) >= BOUNDARY_DAYS + 1 || !a.accountId) continue
    const r = await db.prepare(SQL.candidates).bind(a.accountId, a.syncFrom).all<Row>()
    queries++
    candidates.set(a.id, (r.results ?? []).map((x) => ({ id: s(x.id), postedDate: s(x.posted_date), amountCents: Number(x.amount_cents) })))
  }

  // Person-touched check for the rows Plaid removed (inserted + live only).
  const removedFacts = new Map<string, { touched: boolean; pairId: string | null }>()
  const rm = norm.removed.map((id) => mapped.get(id)).filter((m): m is MapRow => !!m && m.role === 'inserted' && m.state === 'live').map((m) => m.txnId)
  for (const part of chunks(rm, CHUNK)) {
    const r = await db.prepare(SQL.touched(part.length)).bind(...part).all<Row>()
    queries++
    for (const x of r.results ?? []) removedFacts.set(s(x.id), { touched: Number(x.touched) === 1, pairId: sn(x.pair_id) })
  }
  return { now, accounts, budgetAccounts, rules, mapped, candidates, removedFacts, queries }
}

// ---- decide (no D1 access) ------------------------------------------------------------------------------------------

const sameFields = (m: MapRow, f: Fields): boolean =>
  m.postedDate === f.postedDate && m.txnDate === f.txnDate && m.amountCents === f.amountCents && m.description === f.description && m.pending === f.pending
const fieldsOf = (t: BankTxn): Fields => ({ postedDate: t.postedDate, txnDate: t.txnDate, amountCents: t.amountCents, description: t.description, pending: t.pending })

export async function decide(norm: Normalized, st: State): Promise<Plan> {
  const plan: Plan = {
    inserts: [], matches: [], inPlace: [], updates: [], unmap: [], dropped: [], deletes: [], pairs: [],
    counts: { added: norm.added.length, modified: norm.modified.length, removed: norm.removed.length, inserted: 0, matched: 0, flagged: 0, posted: 0, dropped: 0, skipped: norm.skipped },
  }
  const nowMs = st.now.getTime()
  const planned = new Map<string, NewRow>() // inserted in this run, by Plaid id
  const consumed = new Set<string>() // pending ids that posted in place
  const claimed = new Set<string>() // boundary candidates taken in this run
  const seenSameDay = new Set<string>()

  const modify = (t: BankTxn, m: MapRow): void => {
    const f = fieldsOf(t)
    if (m.role !== 'inserted' || m.state !== 'live') return // matched, dropped, kept: nothing
    if (sameFields(m, f)) return
    plan.updates.push({ txnId: m.txnId, updatedAt: nextStamp(m.updatedAt, nowMs), ...f })
  }

  const addOne = async (t: BankTxn): Promise<void> => {
    const acct = st.accounts.get(t.plaidAccountId)
    if (!acct || acct.sync !== 'on' || !acct.accountId || (acct.syncFrom && t.postedDate < acct.syncFrom)) { plan.counts.skipped++; return }
    const budget = st.budgetAccounts.find((a) => a.id === acct.accountId)
    if (!budget) { plan.counts.skipped++; return }

    const plan0 = planned.get(t.plaidTxnId)
    if (plan0) { Object.assign(plan0, fieldsOf(t)); return } // the same id twice in one update: last wins
    const m = st.mapped.get(t.plaidTxnId)
    if (m) { if (!consumed.has(m.plaidTxnId)) modify(t, m); return }

    // 3. pending -> posted in place.
    const p = t.pendingTransactionId ? st.mapped.get(t.pendingTransactionId) : undefined
    if (p && p.role === 'inserted' && (p.state === 'live' || p.state === 'dropped') && !consumed.has(p.plaidTxnId)) {
      consumed.add(p.plaidTxnId)
      plan.inPlace.push({ oldPlaidId: p.plaidTxnId, newPlaidId: t.plaidTxnId, bankAccountId: p.bankAccountId, txnId: p.txnId, bankRef: t.bankRef,
        updatedAt: nextStamp(p.updatedAt, nowMs), ...fieldsOf(t) })
      plan.counts.posted++
      return
    }

    // 4. boundary match against statement rows around sync_from.
    let dupOf: string | null = null
    if (t.pending === 0 && acct.syncFrom && daysBetween(acct.syncFrom, t.postedDate) < BOUNDARY_DAYS + 1) {
      const near = (st.candidates.get(acct.id) ?? []).filter((c) =>
        !claimed.has(c.id) && c.amountCents === t.amountCents && Math.abs(daysBetween(c.postedDate, t.postedDate)) <= BOUNDARY_DAYS)
      if (near.length === 1) {
        claimed.add(near[0].id)
        plan.matches.push({ plaidTxnId: t.plaidTxnId, bankAccountId: acct.id, txnId: near[0].id })
        plan.counts.matched++
        return
      }
      if (near.length >= 2) {
        near.sort((a, b) => Math.abs(daysBetween(a.postedDate, t.postedDate)) - Math.abs(daysBetween(b.postedDate, t.postedDate)) || (a.id < b.id ? -1 : 1))
        dupOf = near[0].id
      }
    }

    // 5. insert, classified by the statement load's own classifier.
    const id = await dedupeKey({ accountId: acct.accountId, postedDate: t.postedDate, amountCents: t.amountCents, clean: '', occurrence: 0, bankRef: t.bankRef })
    const { n, mk, cat, confidence, flags } = classifyRow(
      { description: t.description, amountCents: t.amountCents, postedDate: t.postedDate }, budget, st.budgetAccounts, st.rules, seenSameDay)
    seenSameDay.add(sameDayKey(acct.accountId, t.postedDate, t.amountCents))
    const row: NewRow = {
      id, accountId: acct.accountId, bankAccountId: acct.id, plaidTxnId: t.plaidTxnId, bankRef: t.bankRef, ...fieldsOf(t),
      merchantKey: mk.key, merchantName: cat.displayName ?? mk.name, storeNo: n.storeNo, counterpartyLast4: n.counterpartyLast4,
      kind: cat.kind, kindSource: cat.kindSource, categoryId: cat.categoryId, categorySource: cat.categorySource, ruleId: cat.ruleId, confidence,
      needsReview: dupOf ? true : flags.needsReview, reviewReason: dupOf ? 'possible_duplicate' : flags.reason, debtAccountId: cat.debtAccountId, dupOf,
    }
    plan.inserts.push(row)
    planned.set(t.plaidTxnId, row)
    plan.counts.inserted++
    if (dupOf) plan.counts.flagged++
  }

  for (const t of norm.added) await addOne(t)
  for (const t of norm.modified) await addOne(t) // a mapped id is a modify; an unmapped one is handled as added

  for (const id of norm.removed) {
    if (consumed.has(id)) continue
    const own = planned.get(id)
    if (own) { // added and removed in the same update: nothing to keep
      plan.inserts.splice(plan.inserts.indexOf(own), 1)
      planned.delete(id)
      plan.counts.inserted--
      if (own.dupOf) plan.counts.flagged--
      continue
    }
    const m = st.mapped.get(id)
    if (!m) continue
    if (m.role === 'matched') { plan.unmap.push(id); continue }
    if (m.state !== 'live') continue
    const f = st.removedFacts.get(m.txnId)
    if (f?.touched !== false) { plan.dropped.push(id); plan.counts.dropped++ } // touched or unknown: keep the row
    else plan.deletes.push({ txnId: m.txnId, pairId: f.pairId })
  }
  return plan
}

/** Candidate rows for the pair step: the new unpaired posted rows, rule/manual kinds carried as 'other' (never paired). */
export function newCandidates(plan: Plan): PairCandidate[] {
  return plan.inserts.filter((r) => r.pending === 0).map((r) => ({
    id: r.id, accountId: r.accountId, postedDate: r.postedDate, amountCents: r.amountCents,
    kind: r.kindSource === 'manual' || r.kindSource === 'rule' ? ('other' as TxnKind) : r.kind, counterpartyLast4: r.counterpartyLast4, pairId: null,
  }))
}

/** The load's pairing step, scoped to the days around the new rows: existing unpaired rows in that range are candidates. */
export async function planPairs(db: D1Database, plan: Plan, accounts: Account[], rerunDates: string[] = []): Promise<Array<[string, string]>> {
  const fresh = newCandidates(plan)
  // rerunDates: posted dates of this update's rows that an earlier, interrupted run already inserted (they are mapped, so not in
  // plan.inserts). The read below finds them as unpaired rows, so a run that died after the insert batch but before the pair batch
  // still pairs them on the rerun.
  // Pending rows that post in place in this update are fresh candidates too (their read value is pending = 1, so the range read
  // below cannot see them): their facts come from their own read, their date and amount are the new posted ones.
  const posted = plan.inPlace.filter((p) => p.pending === 0)
  const inPlace: PairCandidate[] = []
  for (const part of chunks(posted, CHUNK)) {
    const byId = new Map(part.map((p) => [p.txnId, p]))
    const r = await db.prepare(SQL.postedFacts(part.length)).bind(...part.map((p) => p.txnId)).all<Row>()
    for (const x of r.results ?? []) {
      const p = byId.get(s(x.id))
      if (p) inPlace.push({ id: p.txnId, accountId: s(x.account_id), postedDate: p.postedDate, amountCents: p.amountCents, kind: s(x.kind) as TxnKind, counterpartyLast4: sn(x.counterparty_last4), pairId: null })
    }
  }
  const dates = [...fresh.map((c) => c.postedDate), ...inPlace.map((c) => c.postedDate), ...rerunDates].sort()
  if (dates.length === 0) return []
  const lo = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - 5 * 86_400_000).toISOString().slice(0, 10)
  const hi = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + 5 * 86_400_000).toISOString().slice(0, 10)
  const r = await db.prepare(SQL.pairCandidates).bind(lo, hi).all<Row>()
  const existing: PairCandidate[] = (r.results ?? []).map((x) => ({
    id: s(x.id), accountId: s(x.account_id), postedDate: s(x.posted_date), amountCents: Number(x.amount_cents), kind: s(x.kind) as TxnKind,
    counterpartyLast4: sn(x.counterparty_last4), pairId: null,
  }))
  const taken = new Set(inPlace.map((c) => c.id))
  return pairTransfers([...existing.filter((c) => !taken.has(c.id)), ...fresh, ...inPlace], accounts)
}

// ---- apply (D1 writes) ----------------------------------------------------------------------------------------------

/** more: the update has pages left (the cursor moves, the Item stays due). chunk: 0-based chunk of this run. counts: the run's totals so far. */
export interface RunCtx {
  itemId: string; runId: number; now: Date; runStart: string; pages: number; nextCursor: string; more?: boolean; chunk?: number; counts?: Counts
  /** The cursor this update began at ('' = the very start); saved with the cursor while `more`, cleared when the update finishes. */
  base?: string
  /** The last page of the update said the historical pull is complete: only then does a NULL sync_from get its value. */
  historical?: boolean
}

const INSERT_TXN = `INSERT INTO transactions (id, account_id, statement_end, import_id, posted_date, txn_date, amount_cents, description, merchant_key,
  merchant_name, store_no, counterparty_last4, bank_ref, kind, kind_source, category_id, category_source, rule_id, confidence, needs_review,
  review_reason, pair_id, debt_account_id, principal_cents, interest_cents, note, updated_at, updated_by, included, pending)
  VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, NULL, ?21, NULL, NULL, NULL, ?22, '${WRITER}', 1, ?23)
  ON CONFLICT(id) DO NOTHING`
const INSERT_MAP = (role: 'inserted' | 'matched') => `INSERT OR IGNORE INTO bank_txns (plaid_txn_id, bank_account_id, txn_id, role, state, dup_of, seen_at, updated_at)
  VALUES (?1, ?2, ?3, '${role}', 'live', ?4, ?5, ?5)`
/** The ONLY update of an existing transactions row: the bank's own fields. No category, kind, included, note or updated_by. */
export const UPDATE_BANK_FIELDS = `UPDATE transactions SET posted_date = ?2, txn_date = ?3, amount_cents = ?4, description = ?5, pending = ?6, updated_at = ?7 WHERE id = ?1`
export const UPDATE_BANK_FIELDS_REF = `UPDATE transactions SET posted_date = ?2, txn_date = ?3, amount_cents = ?4, description = ?5, pending = ?6, bank_ref = ?8, updated_at = ?7 WHERE id = ?1`
// An account linked with sync_from NULL (it had no statement rows) gets its cutover when its first sync completes: the earliest
// date the bank returned for it, so older statement history still loads (the load guard skips only rows on or after sync_from).
const FIRST_SYNC_FROM = `UPDATE bank_accounts SET updated_at = ?2, sync_from = (SELECT MIN(t.posted_date) FROM bank_txns b JOIN transactions t ON t.id = b.txn_id
  WHERE b.bank_account_id = bank_accounts.id AND b.role = 'inserted') WHERE item_id = ?1 AND sync = 'on' AND sync_from IS NULL AND account_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM bank_txns b2 WHERE b2.bank_account_id = bank_accounts.id AND b2.role = 'inserted')`
/** A row no person has touched, as SQL over the row `t` with id parameter `p` (the same test the removal's person-touched read makes). */
const UNTOUCHED = (t: string, p: string): string => `instr(${t}updated_by,'@') = 0 AND ${t}category_source <> 'manual' AND ${t}kind_source <> 'manual'
  AND ${t}note IS NULL AND ${t}included = 1 AND NOT EXISTS (SELECT 1 FROM receipt_matches m WHERE m.txn_id = ${p})`
const DELETE_UNTOUCHED = `DELETE FROM transactions WHERE id = ?1 AND ${UNTOUCHED('', '?1')}`
// The partner of a row about to be deleted loses its link to it (pair_id only; never category, kind, included or note, so a person's
// edit of the partner does not matter and is never overwritten). It does so only while the DELETED row (?2) is still untouched: the
// same test as the delete, in the same batch, so the two succeed or skip together if a person edited the row after it was read.
const UNPAIR_PARTNER = `UPDATE transactions SET pair_id = NULL WHERE id = ?1 AND pair_id = ?2
  AND EXISTS (SELECT 1 FROM transactions d WHERE d.id = ?2 AND ${UNTOUCHED('d.', '?2')})`

export function planStatements(db: D1Database, plan: Plan, c: RunCtx): { body: D1PreparedStatement[][]; tail: D1PreparedStatement[] } {
  const at = c.now.toISOString()
  const body: D1PreparedStatement[][] = []
  const importId = `bank-${c.itemId}-${c.runId}${c.chunk ? `-${c.chunk}` : ''}`
  if (plan.inserts.length > 0) {
    body.push([db.prepare(`INSERT INTO imports (id, source_label, created_at, created_by, rows_in) VALUES (?1, 'Bank sync', ?2, '${WRITER}', ?3) ON CONFLICT(id) DO NOTHING`)
      .bind(importId, at, plan.inserts.length)])
  }
  // Each push below is one UNIT that never straddles two batches (see applyPlan): a row with its mapping, a pending-to-posted
  // in place, a removal with its unpair, both sides of a pair. Units are also rerun-safe on their own (decide sees a finished
  // unit as already mapped), so a run that dies between any two batches repeats from the old cursor to the same state.
  const unit = (...stmts: D1PreparedStatement[]): void => void body.push(stmts)
  for (const r of plan.inserts) {
    unit(
      db.prepare(INSERT_TXN).bind(r.id, r.accountId, importId, r.postedDate, r.txnDate, r.amountCents, r.description, r.merchantKey, r.merchantName, r.storeNo,
        r.counterpartyLast4, r.bankRef, r.kind, r.kindSource, r.categoryId, r.categorySource, r.ruleId, r.confidence, r.needsReview ? 1 : 0, r.reviewReason,
        r.debtAccountId, at, r.pending),
      db.prepare(INSERT_MAP('inserted')).bind(r.plaidTxnId, r.bankAccountId, r.id, r.dupOf, at),
    )
  }
  for (const m of plan.matches) unit(db.prepare(INSERT_MAP('matched')).bind(m.plaidTxnId, m.bankAccountId, m.txnId, null, at))
  for (const p of plan.inPlace) {
    // The row's bank fields, then the mapping moves to the new id in ONE update (no delete + insert that a batch boundary could split).
    unit(
      db.prepare(UPDATE_BANK_FIELDS_REF).bind(p.txnId, p.postedDate, p.txnDate, p.amountCents, p.description, p.pending, p.updatedAt, p.bankRef),
      db.prepare(`UPDATE bank_txns SET plaid_txn_id = ?2, state = 'live', updated_at = ?3 WHERE plaid_txn_id = ?1`).bind(p.oldPlaidId, p.newPlaidId, at),
    )
  }
  for (const u of plan.updates) unit(db.prepare(UPDATE_BANK_FIELDS).bind(u.txnId, u.postedDate, u.txnDate, u.amountCents, u.description, u.pending, u.updatedAt))
  for (const id of plan.unmap) unit(db.prepare('DELETE FROM bank_txns WHERE plaid_txn_id = ?1').bind(id))
  for (const id of plan.dropped) unit(db.prepare(`UPDATE bank_txns SET state = 'dropped', updated_at = ?2 WHERE plaid_txn_id = ?1 AND role = 'inserted'`).bind(id, at))
  for (const d of plan.deletes) {
    unit(...(d.pairId ? [db.prepare(UNPAIR_PARTNER).bind(d.pairId, d.txnId)] : []), db.prepare(DELETE_UNTOUCHED).bind(d.txnId))
  }
  for (const [a, b] of plan.pairs) unit(db.prepare(pairUpdateSql(a, b, at, WRITER)), db.prepare(pairUpdateSql(b, a, at, WRITER)))
  const k = c.counts ?? plan.counts
  const more = c.more ? 1 : 0
  const tail = [
    // sync_from is set only at the end of an update that saw the historical pull complete; before that, the older rows still to come
    // would fall under it and be skipped. NULL keeps the statement load skipping every bank-account row meanwhile (never double-counted).
    ...(more || !c.historical ? [] : [db.prepare(FIRST_SYNC_FROM).bind(c.itemId, at)]),
    // The cursor moves last, together with the run row; a flag set during the run (later than run_start) survives it. A run that
    // is done (not `more`) also releases its claim (releasedStamp), so only a run in flight or one that crashed holds the Item.
    db.prepare(`UPDATE bank_items SET sync_cursor = ?2, sync_cursor_base = ?7, last_ok_at = ?3, last_error = NULL, updated_at = ?3,
      sync_requested_at = CASE WHEN ?5 = 1 THEN COALESCE(sync_requested_at, ?3) WHEN sync_requested_at <= ?4 THEN NULL ELSE sync_requested_at END,
      last_sync_at = CASE WHEN ?5 = 0 AND last_sync_at = ?3 THEN ?6 ELSE last_sync_at END
      WHERE id = ?1 AND status IN ('active','pending_disconnect')`).bind(c.itemId, c.nextCursor, at, c.runStart, more, releasedStamp(c.now), more ? (c.base ?? '') : null),
    db.prepare(`UPDATE bank_sync_runs SET finished_at = ?2, pages = ?3, added = ?4, modified = ?5, removed = ?6, inserted = ?7, matched = ?8,
      flagged = ?9, posted = ?10, dropped = ?11, skipped = ?12, error_code = NULL WHERE id = ?1`)
      .bind(c.runId, at, c.pages, k.added, k.modified, k.removed, k.inserted, k.matched, k.flagged, k.posted, k.dropped, k.skipped),
    db.prepare(`DELETE FROM bank_sync_runs WHERE item_id = ?1 AND id NOT IN (SELECT id FROM bank_sync_runs WHERE item_id = ?1 ORDER BY id DESC LIMIT ${KEEP_RUNS})`).bind(c.itemId),
  ]
  return { body, tail }
}

/** Write the plan in batches of at most 100 statements; the cursor batch is last, so a failure before it repeats from the old cursor. */
export async function applyPlan(db: D1Database, plan: Plan, c: RunCtx): Promise<number> {
  let batches = 0
  const { body, tail } = planStatements(db, plan, c)
  // Pack whole units into batches of at most BATCH_SIZE statements; a unit is never split.
  let cur: D1PreparedStatement[] = []
  for (const u of body) {
    if (cur.length > 0 && cur.length + u.length > BATCH_SIZE) { await db.batch(cur); batches++; cur = [] }
    cur.push(...u)
  }
  if (cur.length > 0) { await db.batch(cur); batches++ }
  await db.batch(tail)
  return batches + 1
}

// ---- the tick ---------------------------------------------------------------------------------------------------------

/** Fixed D1 queries one Item costs outside the update: facts, claim, trigger, run row, item + token, finish (rounded up). */
const ITEM_FIXED_QUERIES = 10

const zeroCounts = (): Counts => ({ added: 0, modified: 0, removed: 0, inserted: 0, matched: 0, flagged: 0, posted: 0, dropped: 0, skipped: 0 })
const addCounts = (to: Counts, c: Counts): void => { for (const k of Object.keys(to) as Array<keyof Counts>) to[k] += c[k] }

/** D1 queries used so far in this Worker invocation (an estimate from the calls we make; a db.batch counts as one). */
export interface QueryBudget { used: number }

/**
 * One Item: claim, run row, token, then the update in chunks of CHUNK_PAGES pages: fetch, decide, pair, apply, and the cursor
 * moves with each chunk's last batch, so a long first sync resumes from the last finished chunk (in this tick while the query budget
 * lasts, else next tick). Returns false when it was skipped (not due, claimed elsewhere, other Plaid environment).
 */
export async function syncItem(db: D1Database, env: Env, client: PlaidClient, keys: Keys, itemId: string, now: Date, budget: QueryBudget = { used: 0 }): Promise<boolean> {
  const facts = await db
    .prepare(`SELECT sync_cursor, sync_cursor_base, initial_done, sync_requested_at, last_webhook_at, status, environment FROM bank_items WHERE id = ?1`)
    .bind(itemId).first<Row>()
  budget.used += ITEM_FIXED_QUERIES
  if (!facts || (facts.status !== 'active' && facts.status !== 'pending_disconnect')) return false
  // Claim FIRST, so an Item that returns early (other environment, claimed elsewhere) still moves to the back of the pick order.
  if (!(await claim(db, itemId, now))) return false
  if (s(facts.environment) !== (env.PLAID_ENV ?? '')) { log('sync_skip', {}, 'environment_mismatch'); return false }
  const runStart = now.toISOString()
  const requested = sn(facts.sync_requested_at)
  const byWebhook = requested !== null && sn(facts.last_webhook_at) !== null && s(facts.last_webhook_at) >= requested
  const trigger = await chooseTrigger(db, itemId,
    { initial_done: Number(facts.initial_done), sync_cursor: sn(facts.sync_cursor), sync_requested_at: requested }, byWebhook ? 'webhook' : 'manual')
  const runId = await startRun(db, itemId, trigger, now)
  let pages = 0
  const fail = async (code: string, status?: 'needs_reconnect'): Promise<boolean> => {
    const at = now.toISOString()
    // A failed run releases its claim like a finished one (the Item is retried on a later tick), except into needs_reconnect, whose
    // claim is the daily reconnect check's window.
    const stmts = [db.prepare(`UPDATE bank_items SET last_error = ?2, updated_at = ?3 ${status ? ", status = 'needs_reconnect'" : ', last_sync_at = CASE WHEN last_sync_at = ?3 THEN ?4 ELSE last_sync_at END'} WHERE id = ?1 AND status IN ('active','pending_disconnect')`)
      .bind(...(status ? [itemId, code, at] : [itemId, code, at, releasedStamp(now)]))]
    await db.batch(stmts)
    await finishRun(db, runId, now, pages, code)
    log('sync_failed', { pages }, code)
    return true
  }
  try {
    const item = await getItem(db, itemId)
    if (!item) { await finishRun(db, runId, now, 0, 'item_missing'); await release(db, itemId, now); return false }
    const token = await openAndRefreshToken(db, item, keys)
    let cursor = sn(facts.sync_cursor)
    // base: the cursor the in-progress update began at ('' = the very start), NULL when the saved cursor is a finished one. A mutation
    // error restarts at base, never at the saved mid-way cursor (Plaid: restart at the update's first cursor).
    let base = cursor === null ? null : sn(facts.sync_cursor_base)
    const totals = zeroCounts()
    let pairs = 0
    for (let chunk = 0; ; chunk++) {
      if (base === null) base = cursor ?? '' // this chunk begins a new update
      const res = await fetchUpdate(client, token, cursor, { maxPages: CHUNK_PAGES, restartCursor: base === '' ? null : base })
      pages += res.pages
      if (res.kind === 'noop') { await finishRun(db, runId, now, pages); await release(db, itemId, now); log('sync_noop', { pages }); return true }
      if (res.kind === 'needs_reconnect') return await fail(plaidErrorCode('ITEM_LOGIN_REQUIRED'), 'needs_reconnect')
      if (res.kind === 'error') return await fail(res.code)
      const norm = prepareUpdate(res)
      const st = await loadState(db, itemId, norm, now)
      const plan = await decide(norm, st)
      const rerunDates = [...norm.added, ...norm.modified].filter((t) => t.pending === 0 && st.mapped.get(t.plaidTxnId)?.role === 'inserted').map((t) => t.postedDate)
      plan.pairs = await planPairs(db, plan, st.budgetAccounts, rerunDates)
      addCounts(totals, plan.counts)
      pairs += plan.pairs.length
      const batches = await applyPlan(db, plan, { itemId, runId, now, runStart, pages, nextCursor: res.nextCursor, more: res.more, chunk, counts: { ...totals }, base, historical: res.historical })
      budget.used += st.queries + 1 + batches + Math.ceil(plan.inPlace.filter((p) => p.pending === 0).length / CHUNK)
      cursor = res.nextCursor
      if (!res.more) break
      // Another chunk only if its worst case still fits (see TICK_QUERY_BUDGET: the rest of the invocation is reserved on top of it).
      if (budget.used + WORST_CHUNK_QUERIES > TICK_QUERY_BUDGET) { await release(db, itemId, now); log('sync_partial', { ...totals, pairs, pages }); return true } // the next tick resumes at the cursor just written
    }
    log('sync_ok', { ...totals, pairs, pages })
    return true
  } catch (e) {
    const code = e instanceof Error && e.message === 'decrypt_failed' ? 'token_unreadable' : 'internal_error'
    try { await finishRun(db, runId, now, 0, code); await release(db, itemId, now) } catch { /* the run row stays open; the claim lapses after its window */ }
    log('sync_failed', {}, code)
    return true
  }
}

/** The sync half of a cron tick: up to 3 due Items, one at a time, while the tick's D1 query budget lasts. */
export async function syncTick(env: Env, fetchFn: typeof fetch, keys: Keys, now: () => Date, budget: QueryBudget = { used: 0 }): Promise<number> {
  const db = env.BUDGET_DB
  const client = createPlaidClient({ env, fetch: fetchFn, now })
  let ran = 0
  budget.used += 1
  for (const id of await pickDue(db, now(), env.PLAID_ENV ?? '')) {
    if (budget.used + ITEM_FIXED_QUERIES + WORST_CHUNK_QUERIES > TICK_QUERY_BUDGET) { log('sync_budget', { used: budget.used }); break }
    try {
      if (await syncItem(db, env, client, keys, id, now(), budget)) ran++
    } catch {
      log('sync_failed', {}, 'internal_error')
    }
  }
  return ran
}
