/// <reference types="@cloudflare/workers-types" />
//
// The Budget section's database layer (docs/adr/0007-budget-section.md): row mappers, request
// validation, the person -> account ids step, the summary and transaction query builders, the rule
// engine's write path, and the route wrapper every functions/api/budget/* handler uses.
//
// Rules this file keeps (D1 limits, official docs 2026-11-20):
//  - every value is BOUND, never spliced; the only SQL text built here comes from fixed fragments
//    (SPENDING_KINDS, column lists), so user text never reaches a statement;
//  - at most 100 bound parameters and 100 KB per statement: lists travel as ONE json_each(?) param, and
//    the rule engine's bulk writes are chunked by serialized size;
//  - `batch()` is one transaction: a multi-statement write goes through it, so it lands whole or not at all;
//  - every response is `private, no-store` (budgetJson); nothing here touches the shared edge cache.

import type {
  Account, AccountKind, Category, Cents, DebtDetail, DebtSlice, IsoDate, MerchantRule, Person, ReviewReason, SummaryQuery,
  SummaryResponse, SummarySlice, Txn, TxnKind, TxnQuery,
} from '../../src/lib/budget/types'
import { SPENDING_KINDS, TXN_KINDS, UNCATEGORIZED } from '../../src/lib/budget/types'
import { categorize, ruleIdFor } from '../../src/lib/budget/rules'
import { BUDGET_DENIED } from './auth'
import { budgetJson, type BudgetData, type BudgetEnv } from './budgetAccess'

// ---------- limits -------------------------------------------------------------------------------

export const MAX_RANGE_DAYS = 400
export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 200
export const MAX_PURCHASES = 200
export const MAX_MERCHANT_KEYS = 200
/** Request body caps in bytes (413 too_large above). */
export const MAX_BODY = { patch: 4096, rule: 1024, apply: 32_768, balance: 1024 } as const
/** The rule engine writes in chunks no bigger than this many serialized bytes (D1: 100 KB per statement). */
export const CHUNK_BYTES = 60_000
export const CHUNK_ROWS = 300

// ---------- errors and the route wrapper ---------------------------------------------------------

export type Ctx = EventContext<BudgetEnv, any, BudgetData>

export class BudgetHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string, readonly extra: Record<string, unknown> = {}, readonly headers: Record<string, string> = {}) {
    super(message ?? code)
  }
}
export const badRequest = (message: string): BudgetHttpError => new BudgetHttpError(400, 'bad_request', message)
export const notFound = (message?: string): BudgetHttpError => new BudgetHttpError(404, 'not_found', message)

type Handler = (ctx: Ctx) => Promise<Response> | Response

/**
 * One route's `onRequest`. Order: identity (a missing `data.budgetEmail` is 403: the scoped middleware did
 * not run), method (405 with `Allow`; HEAD answers as GET), then the handler, whose BudgetHttpError becomes
 * `{error, message?, ...extra}`. Anything else it throws is logged without the message text and answers 500.
 */
export function defineRoute(handlers: Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', Handler>>): PagesFunction<BudgetEnv, any, BudgetData> {
  const allow = [...Object.keys(handlers), ...(handlers.GET ? ['HEAD'] : [])].join(', ')
  return async (ctx) => {
    if (!ctx.data.budgetEmail) return budgetJson(403, BUDGET_DENIED)
    let method = ctx.request.method.toUpperCase()
    if (method === 'HEAD') method = 'GET'
    const handler = handlers[method as keyof typeof handlers]
    if (!handler) return budgetJson(405, { error: 'method_not_allowed' }, { Allow: allow })
    if (!ctx.env.BUDGET_DB) return budgetJson(503, { error: 'budget_db_missing', message: 'The Budget database is not connected.' })
    try {
      return await handler(ctx)
    } catch (err) {
      if (err instanceof BudgetHttpError) {
        return budgetJson(err.status, { error: err.code, ...(err.message !== err.code ? { message: err.message } : {}), ...err.extra }, err.headers)
      }
      console.error(`budget: route failed: ${(err as Error)?.name ?? 'error'}`)
      return budgetJson(500, { error: 'internal_error' })
    }
  }
}

/** Reads a JSON object body of at most `maxBytes` (413 above, 400 for bad JSON or a non-object). */
export async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) throw new BudgetHttpError(413, 'too_large', `body is over ${maxBytes} bytes`)
  const text = await request.text()
  if (new TextEncoder().encode(text).length > maxBytes) throw new BudgetHttpError(413, 'too_large', `body is over ${maxBytes} bytes`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw badRequest('body: not valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('body: expected a JSON object')
  return value as Record<string, unknown>
}

// ---------- validation ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const PERSON_RE = /^[a-z0-9]{1,24}$/
const ID_RE = /^[a-z0-9-]{1,32}$/
const TXN_ID_RE = /^[0-9a-f]{32}$/
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2})\|([0-9a-f]{32})$/

export function isIsoDate(v: unknown): v is IsoDate {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}
const dayNumber = (d: IsoDate): number => Date.parse(`${d}T00:00:00Z`) / 86_400_000

export const isTxnId = (v: unknown): v is string => typeof v === 'string' && TXN_ID_RE.test(v)
export const isAccountId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)
export const isKind = (v: unknown): v is TxnKind => typeof v === 'string' && (TXN_KINDS as readonly string[]).includes(v)

function dateParam(sp: URLSearchParams, name: string): IsoDate {
  const v = sp.get(name)
  if (v === null || v === '') throw badRequest(`${name}: required (YYYY-MM-DD)`)
  if (!isIsoDate(v)) throw badRequest(`${name}: not a valid date (YYYY-MM-DD)`)
  return v
}

export function parseRange(sp: URLSearchParams): { from: IsoDate; to: IsoDate } {
  const from = dateParam(sp, 'from')
  const to = dateParam(sp, 'to')
  if (from > to) throw badRequest('from: is after to')
  if (dayNumber(to) - dayNumber(from) > MAX_RANGE_DAYS) throw badRequest(`to: range is over ${MAX_RANGE_DAYS} days`)
  return { from, to }
}

export function parsePerson(sp: URLSearchParams): string {
  const v = sp.get('person') ?? 'all'
  if (v !== 'all' && !PERSON_RE.test(v)) throw badRequest('person: not a valid person id')
  return v
}

function optionalText(sp: URLSearchParams, name: string, max: number): string | undefined {
  const v = sp.get(name)
  if (v === null || v === '') return undefined
  if (v.length > max || v.includes('\u0000')) throw badRequest(`${name}: too long or not text`)
  return v
}

function optionalAccount(sp: URLSearchParams): string | undefined {
  const v = sp.get('account')
  if (v === null || v === '') return undefined
  if (!ID_RE.test(v)) throw badRequest('account: not a valid account id')
  return v
}

/** `category` is a category id or '__none__' (uncategorized); its existence is checked by `assertCategory`. */
function optionalCategory(sp: URLSearchParams): string | undefined {
  const v = sp.get('category')
  if (v === null || v === '') return undefined
  if (v !== UNCATEGORIZED && !ID_RE.test(v)) throw badRequest('category: not a valid category id')
  return v
}

export function parseSummaryQuery(sp: URLSearchParams): SummaryQuery {
  const { from, to } = parseRange(sp)
  const q: SummaryQuery = { from, to, person: parsePerson(sp) }
  const category = optionalCategory(sp)
  const merchant = optionalText(sp, 'merchant', 80)
  const account = optionalAccount(sp)
  const groupBy = sp.get('groupBy')
  if (groupBy !== null && groupBy !== '' && groupBy !== 'merchant' && groupBy !== 'account') throw badRequest('groupBy: expected merchant or account')
  if (category) q.category = category
  else if (merchant || account) throw badRequest('category: required when merchant or account is given')
  if (merchant) q.merchant = merchant
  if (account) q.account = account
  if (groupBy) q.groupBy = groupBy
  return q
}

export function parseTxnQuery(sp: URLSearchParams): TxnQuery & { limit: number } {
  const { from, to } = parseRange(sp)
  const scope = sp.get('scope') ?? 'spending'
  if (scope !== 'spending' && scope !== 'all') throw badRequest('scope: expected spending or all')
  const q: TxnQuery & { limit: number } = { from, to, person: parsePerson(sp), scope, limit: DEFAULT_LIMIT }
  const category = optionalCategory(sp)
  const merchant = optionalText(sp, 'merchant', 80)
  const account = optionalAccount(sp)
  if (category) q.category = category
  if (merchant) q.merchant = merchant
  if (account) q.account = account
  const review = sp.get('review')
  if (review !== null && review !== '' && review !== '0' && review !== '1' && review !== 'true' && review !== 'false') throw badRequest('review: expected 1 or 0')
  if (review === '1' || review === 'true') q.review = true
  const limit = sp.get('limit')
  if (limit !== null && limit !== '') {
    const n = Number(limit)
    if (!/^\d{1,4}$/.test(limit) || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw badRequest(`limit: expected an integer from 1 to ${MAX_LIMIT}`)
    q.limit = n
  }
  const cursor = sp.get('cursor')
  if (cursor !== null && cursor !== '') {
    decodeCursor(cursor)
    q.cursor = cursor
  }
  return q
}

// ---------- cursor -------------------------------------------------------------------------------

export function encodeCursor(postedDate: IsoDate, id: string): string {
  return btoa(`${postedDate}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function decodeCursor(cursor: string): { postedDate: IsoDate; id: string } {
  let text = ''
  try {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(cursor)) throw new Error('shape')
    text = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    throw badRequest('cursor: not a valid cursor')
  }
  const m = CURSOR_RE.exec(text)
  if (!m || !isIsoDate(m[1])) throw badRequest('cursor: not a valid cursor')
  return { postedDate: m[1], id: m[2] }
}

// ---------- row mappers --------------------------------------------------------------------------

type Row = Record<string, unknown>
const str = (v: unknown): string => String(v)
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export const mapPerson = (r: Row): Person => ({ id: str(r.id), label: str(r.label) })
export const mapAccount = (r: Row): Account => ({
  id: str(r.id), label: str(r.label), kind: str(r.kind) as AccountKind, personId: strOrNull(r.person_id), last4: strOrNull(r.last4),
  isDebt: Number(r.is_debt) === 1, inSpending: Number(r.in_spending) === 1, creditLimitCents: numOrNull(r.credit_limit_cents), aprBp: numOrNull(r.apr_bp),
})
export const mapCategory = (r: Row): Category => ({ id: str(r.id), label: str(r.label), color: strOrNull(r.color), sort: Number(r.sort) })
export const mapRule = (r: Row): MerchantRule => ({
  id: str(r.id), merchantKey: str(r.merchant_key), storeNo: strOrNull(r.store_no), accountId: strOrNull(r.account_id),
  amountMinCents: numOrNull(r.amount_min_cents), amountMaxCents: numOrNull(r.amount_max_cents), setCategoryId: strOrNull(r.set_category_id),
  setKind: strOrNull(r.set_kind) as TxnKind | null, debtAccountId: strOrNull(r.debt_account_id), displayName: strOrNull(r.display_name),
  confidence: Number(r.confidence), review: Number(r.review) === 1, reviewReason: strOrNull(r.review_reason) as ReviewReason | null,
  source: str(r.source) as MerchantRule['source'], active: Number(r.active) === 1,
})
export const mapTxn = (r: Row): Txn => ({
  id: str(r.id), accountId: str(r.account_id), postedDate: str(r.posted_date), txnDate: strOrNull(r.txn_date), amountCents: Number(r.amount_cents),
  description: str(r.description), merchantKey: str(r.merchant_key), merchantName: str(r.merchant_name), storeNo: strOrNull(r.store_no),
  kind: str(r.kind) as TxnKind, kindSource: str(r.kind_source) as Txn['kindSource'], categoryId: strOrNull(r.category_id),
  categorySource: str(r.category_source) as Txn['categorySource'], ruleId: strOrNull(r.rule_id), confidence: Number(r.confidence),
  needsReview: Number(r.needs_review) === 1, reviewReason: strOrNull(r.review_reason) as ReviewReason | null, pairId: strOrNull(r.pair_id),
  debtAccountId: strOrNull(r.debt_account_id), principalCents: numOrNull(r.principal_cents), interestCents: numOrNull(r.interest_cents),
  note: strOrNull(r.note), updatedAt: str(r.updated_at), updatedBy: str(r.updated_by),
})

export const TXN_COLUMNS = 'id, account_id, posted_date, txn_date, amount_cents, description, merchant_key, merchant_name, store_no, kind, kind_source, '
  + 'category_id, category_source, rule_id, confidence, needs_review, review_reason, pair_id, debt_account_id, principal_cents, interest_cents, '
  + 'note, updated_at, updated_by'
export const RULE_COLUMNS = 'id, merchant_key, store_no, account_id, amount_min_cents, amount_max_cents, set_category_id, set_kind, debt_account_id, '
  + 'display_name, confidence, review, review_reason, source, active'
export const ACCOUNT_COLUMNS = 'id, label, kind, person_id, last4, is_debt, in_spending, credit_limit_cents, apr_bp'

// One MIN and one MAX per subquery: SQLite answers each from the end of idx_txn_date (two index probes).
// A single `SELECT MIN(..), MAX(..)` would scan a whole index instead.
export const RANGE_SQL = 'SELECT (SELECT MIN(posted_date) FROM transactions) AS min, (SELECT MAX(posted_date) FROM transactions) AS max'


// ---------- person -> account ids; category checks -----------------------------------------------

/**
 * The accounts a person filter covers: that person's and the shared ones (person_id NULL); 'all' is every
 * active account. An unknown person is 400. The result is bound as ONE json_each(?) parameter by the builders.
 */
export async function accountIdsFor(db: D1Database, person: string): Promise<string[]> {
  if (person !== 'all') {
    const p = await db.prepare('SELECT id FROM people WHERE id = ?').bind(person).first()
    if (!p) throw badRequest('person: unknown person')
  }
  const { results } = await db.prepare(
    `SELECT id FROM accounts WHERE archived = 0 AND (?1 = 'all' OR person_id = ?1 OR person_id IS NULL)`,
  ).bind(person).all<{ id: string }>()
  return results.map((r) => r.id)
}

export async function assertCategory(db: D1Database, categoryId: string | null | undefined, field = 'category'): Promise<void> {
  if (categoryId === undefined || categoryId === null || categoryId === UNCATEGORIZED) return
  const hit = await db.prepare('SELECT 1 AS ok FROM categories WHERE id = ?').bind(categoryId).first()
  if (!hit) throw badRequest(`${field}: unknown category`)
}

// ---------- query builders -----------------------------------------------------------------------

export interface Built {
  sql: string
  params: Array<string | number>
}

const SPENDING_SQL = SPENDING_KINDS.map((k) => `'${k}'`).join(',')
const IN_ACCOUNTS = 'account_id IN (SELECT value FROM json_each(?))'

function categoryFragment(category: string): { sql: string; params: string[] } {
  return category === UNCATEGORIZED ? { sql: 'category_id IS NULL', params: [] } : { sql: 'category_id = ?', params: [category] }
}

export type SummaryShape = 'category' | 'merchant' | 'account' | 'purchase'

export interface SummaryPlan {
  level: SummaryResponse['level']
  shape: SummaryShape
  main: Built
  /** Purchase level only: the true total, since the list is capped. */
  total: Built | null
  review: Built
}

/** The statements behind one /summary answer. `idsJson` = JSON.stringify(accountIdsFor(...)). */
export function buildSummary(q: SummaryQuery, idsJson: string): SummaryPlan {
  const base = `kind IN (${SPENDING_SQL}) AND posted_date BETWEEN ? AND ? AND ${IN_ACCOUNTS}`
  const baseParams: Array<string | number> = [q.from, q.to, idsJson]
  // The review count is the SAME set the table lists for `review=1` (buildTxnList): flagged rows of ANY kind
  // in the range and person filter, narrowed by the drill (category, merchant, account) but not by spending kinds.
  const reviewWhere = ['needs_review = 1', 'posted_date BETWEEN ? AND ?', IN_ACCOUNTS]
  const reviewParams: Array<string | number> = [q.from, q.to, idsJson]
  if (q.category !== undefined) {
    const c = categoryFragment(q.category)
    reviewWhere.push(c.sql)
    reviewParams.push(...c.params)
  }
  if (q.merchant !== undefined) { reviewWhere.push('merchant_key = ?'); reviewParams.push(q.merchant) }
  if (q.account !== undefined) { reviewWhere.push('account_id = ?'); reviewParams.push(q.account) }
  const review: Built = { sql: `SELECT COUNT(*) AS n FROM transactions WHERE ${reviewWhere.join(' AND ')}`, params: reviewParams }
  if (q.category === undefined) {
    return {
      level: 'category', shape: 'category', total: null, review,
      main: { sql: `SELECT category_id AS key, -SUM(amount_cents) AS net, COUNT(*) AS n FROM transactions WHERE ${base} GROUP BY category_id`, params: baseParams },
    }
  }
  const cat = categoryFragment(q.category)
  if (q.merchant === undefined && q.account === undefined) {
    const byAccount = q.groupBy === 'account'
    return {
      level: 'merchant', shape: byAccount ? 'account' : 'merchant', total: null, review,
      main: {
        sql: byAccount
          ? `SELECT account_id AS key, -SUM(amount_cents) AS net, COUNT(*) AS n FROM transactions WHERE ${cat.sql} AND ${base} GROUP BY account_id`
          : `SELECT merchant_key AS key, MIN(merchant_name) AS label, -SUM(amount_cents) AS net, COUNT(*) AS n FROM transactions WHERE ${cat.sql} AND ${base} GROUP BY merchant_key`,
        params: [...cat.params, ...baseParams],
      },
    }
  }
  let where = `${cat.sql} AND ${base}`
  const params: Array<string | number> = [...cat.params, ...baseParams]
  if (q.merchant !== undefined) { where += ' AND merchant_key = ?'; params.push(q.merchant) }
  if (q.account !== undefined) { where += ' AND account_id = ?'; params.push(q.account) }
  return {
    level: 'purchase', shape: 'purchase', review,
    main: {
      sql: `SELECT id AS key, posted_date, merchant_name, -amount_cents AS net FROM transactions WHERE ${where} ORDER BY net DESC, id LIMIT ${MAX_PURCHASES}`,
      params,
    },
    total: { sql: `SELECT COALESCE(-SUM(amount_cents), 0) AS net, COUNT(*) AS n FROM transactions WHERE ${where}`, params },
  }
}

/** The transactions list statement. Fetches limit + 1 rows (the extra one proves a next page exists). */
export function buildTxnList(q: TxnQuery & { limit: number }, idsJson: string): Built {
  const where: string[] = ['posted_date BETWEEN ? AND ?', IN_ACCOUNTS]
  const params: Array<string | number> = [q.from, q.to, idsJson]
  // A flagged row is listed whatever its kind (a transfer to an unknown account is a review reason), so the
  // review list matches the summary's reviewCount.
  if (q.scope === 'spending' && !q.review) where.push(`kind IN (${SPENDING_SQL})`)
  if (q.category !== undefined) {
    const c = categoryFragment(q.category)
    where.push(c.sql)
    params.push(...c.params)
  }
  if (q.merchant !== undefined) { where.push('merchant_key = ?'); params.push(q.merchant) }
  if (q.account !== undefined) { where.push('account_id = ?'); params.push(q.account) }
  if (q.review) where.push('needs_review = 1')
  if (q.cursor) {
    const c = decodeCursor(q.cursor)
    // Expanded keyset form: the plain `posted_date <= ?` lets the index bound the range.
    where.push('posted_date <= ?', '(posted_date < ? OR (posted_date = ? AND id < ?))')
    params.push(c.postedDate, c.postedDate, c.postedDate, c.id)
  }
  return {
    sql: `SELECT ${TXN_COLUMNS} FROM transactions WHERE ${where.join(' AND ')} ORDER BY posted_date DESC, id DESC LIMIT ?`,
    params: [...params, q.limit + 1],
  }
}

// ---------- summary and list runners -------------------------------------------------------------

export async function runSummary(db: D1Database, q: SummaryQuery): Promise<SummaryResponse> {
  if (q.category !== undefined) await assertCategory(db, q.category)
  const ids = await accountIdsFor(db, q.person)
  const plan = buildSummary(q, JSON.stringify(ids))
  const bind = (b: Built) => db.prepare(b.sql).bind(...b.params)
  const needsLabels = plan.shape === 'category' || plan.shape === 'account'
  const stmts = [bind(plan.main), bind(plan.review)]
  if (needsLabels) stmts.push(db.prepare(plan.shape === 'account' ? 'SELECT id, label FROM accounts' : 'SELECT id, label FROM categories'))
  if (plan.total) stmts.push(bind(plan.total))
  const out = await db.batch<Row>(stmts)
  const [main, review] = out
  const labels = needsLabels ? out[2] : null
  const total = plan.total ? out[out.length - 1] : null
  const labelOf = new Map((labels?.results ?? []).map((r) => [str(r.id), str(r.label)]))
  const reviewCount = Number((review.results[0] as Row | undefined)?.n ?? 0)
  let slices: SummarySlice[]
  if (plan.shape === 'category') {
    slices = main.results.map((r) => {
      const key = r.key === null ? UNCATEGORIZED : str(r.key)
      return { key, label: key === UNCATEGORIZED ? 'Uncategorized' : (labelOf.get(key) ?? key), netCents: Number(r.net), count: Number(r.n) }
    })
  } else if (plan.shape === 'merchant') {
    slices = main.results.map((r) => ({ key: str(r.key), label: str(r.label) || str(r.key), netCents: Number(r.net), count: Number(r.n) }))
  } else if (plan.shape === 'account') {
    slices = main.results.map((r) => ({ key: str(r.key), label: labelOf.get(str(r.key)) ?? str(r.key), netCents: Number(r.net), count: Number(r.n) }))
  } else {
    slices = main.results.map((r) => ({ key: str(r.key), label: `${str(r.posted_date)} ${str(r.merchant_name)}`.trim(), netCents: Number(r.net), count: 1 }))
  }
  if (plan.shape !== 'purchase') slices.sort((a, b) => b.netCents - a.netCents || (a.key < b.key ? -1 : 1))
  const totalCents = total ? Number((total.results[0] as Row).net) : slices.reduce((s, x) => s + x.netCents, 0)
  return { level: plan.level, slices, totalCents, reviewCount }
}

export async function runTxnList(db: D1Database, q: TxnQuery & { limit: number }): Promise<{ rows: Txn[]; nextCursor: string | null }> {
  if (q.category !== undefined) await assertCategory(db, q.category)
  const ids = await accountIdsFor(db, q.person)
  const built = buildTxnList(q, JSON.stringify(ids))
  const { results } = await db.prepare(built.sql).bind(...built.params).all<Row>()
  const page = results.slice(0, q.limit).map(mapTxn)
  const next = results.length > q.limit && page.length > 0 ? encodeCursor(page[page.length - 1].postedDate, page[page.length - 1].id) : null
  return { rows: page, nextCursor: next }
}

// ---------- transactions: one row, the write stamp -----------------------------------------------

export async function getTxn(db: D1Database, id: string): Promise<Txn | null> {
  const r = await db.prepare(`SELECT ${TXN_COLUMNS} FROM transactions WHERE id = ?`).bind(id).first<Row>()
  return r ? mapTxn(r) : null
}

/** A new `updated_at` that is strictly after `prev` (so a stale client's expectedUpdatedAt never matches twice). */
export function nextStamp(prev: string | null, now: number = Date.now()): string {
  const prevMs = prev ? Date.parse(prev) : NaN
  return new Date(Number.isFinite(prevMs) && prevMs >= now ? prevMs + 1 : now).toISOString()
}

// ---------- rules: engine write path -------------------------------------------------------------

/** Review reasons a rule that now answers the question settles; the others (duplicates, hidden merchant, ...) stay. */
const SETTLED_BY_RULE: ReadonlySet<string> = new Set(['ambiguous_store', 'amount_out_of_band', 'low_confidence', 'rule'])

interface ApplyRow {
  id: string
  account_id: string
  merchant_key: string
  store_no: string | null
  amount_cents: number
  kind: TxnKind
  kind_source: Txn['kindSource']
  category_id: string | null
  category_source: Txn['categorySource']
  rule_id: string | null
  debt_account_id: string | null
  confidence: number
  needs_review: number
  review_reason: string | null
  updated_at: string
}

interface Change {
  id: string
  prev: string
  stamp: string
  old_cat: string | null
  old_kind: string
  kind: string
  kind_source: string
  cat: string | null
  cat_source: string
  rule_id: string | null
  debt: string | null
  conf: number
  review: number
  reason: string | null
}

export async function loadActiveRules(db: D1Database, merchantKeys: string[] | null): Promise<MerchantRule[]> {
  const stmt = merchantKeys === null
    ? db.prepare(`SELECT ${RULE_COLUMNS} FROM merchant_rules WHERE active = 1`)
    : db.prepare(`SELECT ${RULE_COLUMNS} FROM merchant_rules WHERE active = 1 AND merchant_key IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(merchantKeys))
  return (await stmt.all<Row>()).results.map(mapRule)
}

/**
 * Re-applies the active rules to stored rows in the precedence manual > rule > auto
 * (src/lib/budget/rules.ts `categorize`): a row whose category_source OR kind_source is 'manual' is never
 * read or changed, a row that matches no rule (or a rule that sets nothing) is left alone, and the most
 * specific matching rule wins, so a new merchant-wide rule cannot override a store-specific one. `merchantKeys` null = every merchant that
 * has an active rule. Writes go out as chunked json_each statements inside ONE batch (a transaction),
 * each guarded by the row's `updated_at` so a concurrent edit is skipped, not overwritten. Returns how many
 * rows changed.
 */
export async function applyRules(db: D1Database, merchantKeys: string[] | null, who: string, now: number = Date.now()): Promise<number> {
  const rules = await loadActiveRules(db, merchantKeys)
  if (rules.length === 0) return 0
  const keys = merchantKeys ?? [...new Set(rules.map((r) => r.merchantKey))]
  const cols = 'id, account_id, merchant_key, store_no, amount_cents, kind, kind_source, category_id, category_source, rule_id, debt_account_id, confidence, needs_review, review_reason, updated_at'
  const rows: ApplyRow[] = []
  // Candidate rows come in slices of merchant keys so one json_each parameter stays small.
  for (let i = 0; i < keys.length; i += MAX_MERCHANT_KEYS) {
    const { results } = await db.prepare(
      `SELECT ${cols} FROM transactions WHERE merchant_key IN (SELECT value FROM json_each(?)) AND category_source <> 'manual' AND kind_source <> 'manual'`,
    ).bind(JSON.stringify(keys.slice(i, i + MAX_MERCHANT_KEYS))).all<ApplyRow>()
    rows.push(...results)
  }

  const changes: Change[] = []
  for (const r of rows) {
    const res = categorize(
      { accountId: r.account_id, merchantKey: r.merchant_key, storeNo: r.store_no, amountCents: Number(r.amount_cents),
        current: { kind: r.kind, kindSource: r.kind_source, categoryId: r.category_id, categorySource: r.category_source, ruleId: r.rule_id,
          debtAccountId: r.debt_account_id, confidence: Number(r.confidence) } },
      rules,
      { kind: r.kind, kindSource: r.kind_source === 'hint' ? 'hint' : 'auto', kindConfidence: Number(r.confidence),
        categoryId: r.category_source === 'auto' ? r.category_id : null },
    )
    if (!res.rule || (!res.rule.setCategoryId && !res.rule.setKind)) continue
    const sameFields = res.kind === r.kind && res.kindSource === r.kind_source && res.categoryId === r.category_id
      && res.categorySource === r.category_source && res.ruleId === r.rule_id && res.debtAccountId === r.debt_account_id
    if (sameFields) continue
    const categoryMoved = res.categoryId !== r.category_id || res.categorySource !== r.category_source || res.ruleId !== r.rule_id
    let review = Number(r.needs_review)
    let reason = r.review_reason
    if (categoryMoved) {
      if (res.rule.review) { review = 1; reason = res.rule.reviewReason ?? 'rule' }
      else if (review === 1 && (reason === null || SETTLED_BY_RULE.has(reason))) { review = 0; reason = null }
    }
    changes.push({
      id: r.id, prev: r.updated_at, stamp: nextStamp(r.updated_at, now), old_cat: r.category_id, old_kind: r.kind, kind: res.kind,
      kind_source: res.kindSource, cat: res.categoryId, cat_source: res.categorySource, rule_id: res.ruleId, debt: res.debtAccountId,
      conf: res.confidence, review, reason,
    })
  }
  if (changes.length === 0) return 0

  const stmts: D1PreparedStatement[] = []
  for (const chunk of chunkBySize(changes)) {
    const json = JSON.stringify(chunk)
    stmts.push(db.prepare(EDITS_FROM_JSON_SQL).bind(json, who))
    stmts.push(db.prepare(UPDATE_FROM_JSON_SQL).bind(json, who))
  }
  const results = await db.batch(stmts)
  return results.reduce((n, r, i) => (i % 2 === 1 ? n + Number(r.meta?.changes ?? 0) : n), 0)
}

export function chunkBySize<T>(items: T[], maxBytes = CHUNK_BYTES, maxRows = CHUNK_ROWS): T[][] {
  const out: T[][] = []
  let cur: T[] = []
  let bytes = 2
  for (const it of items) {
    const size = JSON.stringify(it).length + 1
    if (cur.length > 0 && (bytes + size > maxBytes || cur.length >= maxRows)) { out.push(cur); cur = []; bytes = 2 }
    cur.push(it)
    bytes += size
  }
  if (cur.length > 0) out.push(cur)
  return out
}

const EDITS_FROM_JSON_SQL = `INSERT INTO category_edits (txn_id, old_category_id, new_category_id, old_kind, new_kind, rule_id, edited_at, edited_by)
SELECT t.id, json_extract(j.value, '$.old_cat'), json_extract(j.value, '$.cat'), json_extract(j.value, '$.old_kind'), json_extract(j.value, '$.kind'),
  json_extract(j.value, '$.rule_id'), json_extract(j.value, '$.stamp'), ?2
FROM json_each(?1) j JOIN transactions t ON t.id = json_extract(j.value, '$.id') AND t.updated_at = json_extract(j.value, '$.prev')`

const UPDATE_FROM_JSON_SQL = `WITH ch AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.prev') AS prev, json_extract(value, '$.stamp') AS stamp,
  json_extract(value, '$.kind') AS kind, json_extract(value, '$.kind_source') AS kind_source, json_extract(value, '$.cat') AS cat,
  json_extract(value, '$.cat_source') AS cat_source, json_extract(value, '$.rule_id') AS rule_id, json_extract(value, '$.debt') AS debt,
  json_extract(value, '$.conf') AS conf, json_extract(value, '$.review') AS review, json_extract(value, '$.reason') AS reason FROM json_each(?1))
UPDATE transactions SET kind = ch.kind, kind_source = ch.kind_source, category_id = ch.cat, category_source = ch.cat_source, rule_id = ch.rule_id,
  debt_account_id = ch.debt, confidence = ch.conf, needs_review = ch.review, review_reason = ch.reason, updated_at = ch.stamp, updated_by = ?2
FROM ch WHERE transactions.id = ch.id AND transactions.updated_at = ch.prev`

/** The rule a manual edit teaches, as its stored id and fields (see POST /rules). */
export async function ruleFromTxn(txn: Txn, scope: 'merchant' | 'merchant_store'): Promise<{ id: string; storeNo: string | null; setCategoryId: string | null; setKind: TxnKind | null }> {
  const storeNo = scope === 'merchant_store' ? txn.storeNo : null
  const id = await ruleIdFor({ merchantKey: txn.merchantKey, storeNo, accountId: null, amountMinCents: null, amountMaxCents: null })
  return { id, storeNo, setCategoryId: txn.categoryId, setKind: txn.kindSource === 'manual' ? txn.kind : null }
}

// ---------- debts --------------------------------------------------------------------------------

interface DebtRow extends Row { id: string }

/** Latest statement balance and latest typed balance per debt account; the newer wins (a tie: the statement). */
export async function loadDebts(db: D1Database, person: string): Promise<DebtSlice[]> {
  if (person !== 'all') {
    const p = await db.prepare('SELECT id FROM people WHERE id = ?').bind(person).first()
    if (!p) throw badRequest('person: unknown person')
  }
  const scope = `SELECT id FROM accounts WHERE is_debt = 1 AND archived = 0 AND (?1 = 'all' OR person_id = ?1 OR person_id IS NULL)`
  const [accounts, statements, manual] = await db.batch<DebtRow>([
    db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE is_debt = 1 AND archived = 0 AND (?1 = 'all' OR person_id = ?1 OR person_id IS NULL) ORDER BY sort, id`).bind(person),
    db.prepare(
      `SELECT s.account_id, s.period_end, s.closing_balance_cents, s.apr_bp, s.credit_limit_cents FROM statements s
       WHERE s.account_id IN (${scope}) AND s.closing_balance_cents IS NOT NULL
         AND s.period_end = (SELECT MAX(s2.period_end) FROM statements s2 WHERE s2.account_id = s.account_id AND s2.closing_balance_cents IS NOT NULL)`,
    ).bind(person),
    db.prepare(
      `SELECT b.account_id, b.as_of, b.balance_cents, b.apr_bp FROM debt_balances b
       WHERE b.account_id IN (${scope}) AND b.as_of = (SELECT MAX(b2.as_of) FROM debt_balances b2 WHERE b2.account_id = b.account_id)`,
    ).bind(person),
  ])
  const stmtBy = new Map(statements.results.map((r) => [str(r.account_id), r]))
  const manualBy = new Map(manual.results.map((r) => [str(r.account_id), r]))
  return accounts.results.map((row) => {
    const a = mapAccount(row)
    const s = stmtBy.get(a.id)
    const m = manualBy.get(a.id)
    const useManual = m !== undefined && (s === undefined || str(m.as_of) > str(s.period_end))
    const chosen = useManual ? m : s
    return {
      accountId: a.id, label: a.label, kind: a.kind, last4: a.last4, personId: a.personId,
      balanceCents: chosen ? Number(useManual ? m!.balance_cents : s!.closing_balance_cents) : null,
      asOf: chosen ? str(useManual ? m!.as_of : s!.period_end) : null,
      source: chosen ? (useManual ? 'manual' : 'statement') : null,
      aprBp: numOrNull(chosen?.apr_bp) ?? a.aprBp,
      creditLimitCents: numOrNull(s?.credit_limit_cents) ?? a.creditLimitCents,
    }
  })
}

export async function loadDebtDetail(db: D1Database, id: string): Promise<DebtDetail | null> {
  const acct = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ? AND is_debt = 1`).bind(id).first<Row>()
  if (!acct) return null
  const account = mapAccount(acct)
  const paymentSql = account.kind === 'external_debt'
    ? `SELECT id, posted_date, amount_cents, principal_cents, interest_cents FROM transactions WHERE debt_account_id = ? ORDER BY posted_date DESC, id DESC LIMIT 60`
    : `SELECT id, posted_date, amount_cents, principal_cents, interest_cents FROM transactions WHERE account_id = ? AND kind IN ('card_payment','loan_payment') ORDER BY posted_date DESC, id DESC LIMIT 60`
  const [statements, manual, payments] = await db.batch<Row>([
    db.prepare(
      `SELECT period_end, closing_balance_cents, apr_bp, interest_cents, principal_paid_cents, advances_cents FROM statements WHERE account_id = ? ORDER BY period_end DESC LIMIT 24`,
    ).bind(id),
    db.prepare(`SELECT as_of, balance_cents FROM debt_balances WHERE account_id = ? ORDER BY as_of DESC LIMIT 24`).bind(id),
    db.prepare(paymentSql).bind(id),
  ])
  const history: DebtDetail['history'] = [
    ...statements.results.filter((r) => r.closing_balance_cents !== null).map((r) => ({ asOf: str(r.period_end), balanceCents: Number(r.closing_balance_cents), source: 'statement' as const })),
    ...manual.results.map((r) => ({ asOf: str(r.as_of), balanceCents: Number(r.balance_cents), source: 'manual' as const })),
  ].sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : a.source === b.source ? 0 : a.source === 'statement' ? -1 : 1))
  const periods: DebtDetail['periods'] = statements.results.map((r) => ({
    periodEnd: str(r.period_end), aprBp: numOrNull(r.apr_bp), interestCents: numOrNull(r.interest_cents),
    principalPaidCents: numOrNull(r.principal_paid_cents), advancesCents: numOrNull(r.advances_cents),
  })).reverse()
  return {
    account, history, periods,
    // Amounts are what was paid toward the debt: positive, whichever side of the move the row sits on.
    payments: payments.results.map((r) => ({
      id: str(r.id), postedDate: str(r.posted_date), amountCents: Math.abs(Number(r.amount_cents)),
      principalCents: numOrNull(r.principal_cents), interestCents: numOrNull(r.interest_cents),
    })),
  }
}

export function parseManualBalance(body: Record<string, unknown>): { asOf: IsoDate; balanceCents: Cents; aprBp: number | null } {
  if (!isIsoDate(body.asOf)) throw badRequest('asOf: not a valid date (YYYY-MM-DD)')
  const c = body.balanceCents
  if (typeof c !== 'number' || !Number.isSafeInteger(c) || c < 0) throw badRequest('balanceCents: expected a whole number of cents, 0 or more')
  const apr = body.aprBp
  if (apr !== undefined && apr !== null && (typeof apr !== 'number' || !Number.isInteger(apr) || apr < 0 || apr > 10_000)) {
    throw badRequest('aprBp: expected a whole number from 0 to 10000')
  }
  return { asOf: body.asOf, balanceCents: c, aprBp: (apr as number | null | undefined) ?? null }
}

