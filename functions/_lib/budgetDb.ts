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
  Account, AccountKind, Category, Cents, DebtDetail, DebtSlice, DebtTerms, IsoDate, LatestStatement, LoanRow, LoansResponse, MerchantRule,
  Person, ReviewReason, SimilarMixedReason, SimilarResponse, SimilarRow, StatementPromo, SummaryQuery, SummaryResponse, SummarySlice, Txn, TxnKind, TxnQuery,
} from '../../src/lib/budget/types'
import { SPENDING_KINDS, TXN_KINDS, UNCATEGORIZED } from '../../src/lib/budget/types'
import { categorize, ruleIdFor } from '../../src/lib/budget/rules'
import { debtAprBp } from '../../src/lib/budget/loanMath'
import { isPaymentServiceKey } from '../../src/lib/budget/merchant'
import { BUDGET_DENIED } from './auth'
import { budgetJson, type BudgetData, type BudgetEnv } from './budgetAccess'

// ---------- limits -------------------------------------------------------------------------------

export const MAX_RANGE_DAYS = 400
export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 200
export const MAX_PURCHASES = 200
export const MAX_MERCHANT_KEYS = 200
/** Request body caps in bytes (413 too_large above). */
export const MAX_BODY = { patch: 4096, rule: 1024, apply: 32_768, balance: 1024, similar: 32_768 } as const
/** Most candidates one similar-purchases read returns, and most rows one apply may change. */
export const MAX_SIMILAR = 300
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
  included: Number(r.included ?? 1) === 1,
  // Only a bank-synced row can be pending (sync sets 1; a load inserts 0): sent when true, absent otherwise.
  ...(Number(r.pending ?? 0) === 1 ? { pending: true } : {}),
})

export const TXN_COLUMNS = 'id, account_id, posted_date, txn_date, amount_cents, description, merchant_key, merchant_name, store_no, kind, kind_source, '
  + 'category_id, category_source, rule_id, confidence, needs_review, review_reason, pair_id, debt_account_id, principal_cents, interest_cents, '
  + 'note, updated_at, updated_by, included, pending'
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

/** `forWrite`: a category to assign (an archived one is refused); reads may still filter by an archived one. */
export async function assertCategory(db: D1Database, categoryId: string | null | undefined, field = 'category', forWrite = false): Promise<void> {
  if (categoryId === undefined || categoryId === null || categoryId === UNCATEGORIZED) return
  const hit = await db.prepare('SELECT archived FROM categories WHERE id = ?').bind(categoryId).first<{ archived: number }>()
  if (!hit) throw badRequest(`${field}: unknown category`)
  if (forWrite && Number(hit.archived) === 1) throw badRequest(`${field}: category is archived`)
}

/**
 * `assertCategory` for many ids at once: ONE read for the distinct ids, then a synchronous check per id with the same
 * messages. Reads and writes of one request share it (apply plans up to 100 items on a few categories).
 */
export async function categoryChecker(db: D1Database, ids: Iterable<string>, field = 'category', forWrite = false): Promise<(id: string) => void> {
  const distinct = [...new Set([...ids].filter((id) => id !== UNCATEGORIZED))]
  const found = new Map<string, number>()
  if (distinct.length > 0) {
    const { results } = await db.prepare('SELECT id, archived FROM categories WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(distinct)).all<{ id: string; archived: number }>()
    for (const r of results) found.set(r.id, Number(r.archived))
  }
  return (id) => {
    if (id === UNCATEGORIZED) return
    const archived = found.get(id)
    if (archived === undefined) throw badRequest(`${field}: unknown category`)
    if (forWrite && archived === 1) throw badRequest(`${field}: category is archived`)
  }
}

// ---------- query builders -----------------------------------------------------------------------

export interface Built {
  sql: string
  params: Array<string | number>
}

const SPENDING_SQL = SPENDING_KINDS.map((k) => `'${k}'`).join(',')
const IN_ACCOUNTS = 'account_id IN (SELECT value FROM json_each(?))'

/**
 * A store as the pie and the table's merchant filter see it: its display name (the first 80 characters, the
 * `merchant` parameter's cap), falling back to the key. Several merchant keys can carry one display name (a
 * marketplace and a retail line of one chain), and the person looking at the pie sees one store, so the pie
 * groups and the drill filters on this expression, never on `merchant_key`. It is evaluated only on the rows the
 * date range, person and category already narrowed to (idx_txn_cat / idx_txn_date), never as an index probe.
 */
export const STORE_SQL = `substr(COALESCE(NULLIF(merchant_name, ''), merchant_key), 1, 80)`

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
  // `included = 1`: a purchase a person excluded (transactions.included = 0) is in no spending total, pie or trend. Any new
  // spending aggregate takes this clause too. The review count and the transactions list do not (rows stay listed).
  const base = `kind IN (${SPENDING_SQL}) AND included = 1 AND posted_date BETWEEN ? AND ? AND ${IN_ACCOUNTS}`
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
  if (q.merchant !== undefined) { reviewWhere.push(`${STORE_SQL} = ?`); reviewParams.push(q.merchant) }
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
          : `SELECT ${STORE_SQL} AS key, -SUM(amount_cents) AS net, COUNT(*) AS n FROM transactions WHERE ${cat.sql} AND ${base} GROUP BY ${STORE_SQL}`,
        params: [...cat.params, ...baseParams],
      },
    }
  }
  let where = `${cat.sql} AND ${base}`
  const params: Array<string | number> = [...cat.params, ...baseParams]
  if (q.merchant !== undefined) { where += ` AND ${STORE_SQL} = ?`; params.push(q.merchant) }
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
  if (q.merchant !== undefined) { where.push(`${STORE_SQL} = ?`); params.push(q.merchant) }
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
    slices = main.results.map((r) => ({ key: str(r.key), label: str(r.key), netCents: Number(r.net), count: Number(r.n) }))
  } else if (plan.shape === 'account') {
    slices = main.results.map((r) => ({ key: str(r.key), label: labelOf.get(str(r.key)) ?? str(r.key), netCents: Number(r.net), count: Number(r.n) }))
  } else {
    slices = main.results.map((r) => ({ key: str(r.key), label: `${str(r.posted_date)} ${str(r.merchant_name)}`.trim(), netCents: Number(r.net), count: 1, date: str(r.posted_date), merchant: str(r.merchant_name) }))
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
  const page = await withRuleSafe(db, results.slice(0, q.limit).map(mapTxn))
  const next = results.length > q.limit && page.length > 0 ? encodeCursor(page[page.length - 1].postedDate, page[page.length - 1].id) : null
  return { rows: page, nextCursor: next }
}

// ---------- rule safety: does a rule on a merchant key reach only the merchant the row names? -----

/**
 * Why a rule on each key would reach other merchants than the row names, for the keys where it would (a key absent from the
 * map is safe). Two cases: a payment-service key (processor, wallet or person-to-person rail: many merchants pay through it),
 * and a key whose rows carry more than one display name (a shared key whose real merchants were named from receipts).
 * One grouped read over those keys' rows; payment-service keys need no read.
 */
export async function ruleUnsafeReasons(db: D1Database, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const toCheck: string[] = []
  for (const k of new Set(keys.filter((x) => x !== ''))) {
    if (isPaymentServiceKey(k)) out.set(k, 'a payment-service key: many merchants pay through it')
    else toCheck.push(k)
  }
  if (toCheck.length > 0) {
    const { results } = await db.prepare(
      `SELECT merchant_key AS k FROM transactions WHERE merchant_key IN (SELECT value FROM json_each(?))
       GROUP BY merchant_key HAVING COUNT(DISTINCT merchant_name) > 1`,
    ).bind(JSON.stringify(toCheck)).all<Row>()
    for (const r of results) out.set(str(r.k), 'shared by more than one merchant name')
  }
  return out
}

/** Fill `ruleSafe` on the rows a rule could be made from (a manual category or kind); the others get false, as no rule can
 *  come from them yet (POST /rules refuses them), and need no read. */
export async function withRuleSafe(db: D1Database, txns: Txn[]): Promise<Txn[]> {
  const teachable = (t: Txn) => t.merchantKey !== '' && (t.categorySource === 'manual' || t.kindSource === 'manual')
  const unsafe = await ruleUnsafeReasons(db, txns.filter(teachable).map((t) => t.merchantKey))
  return txns.map((t) => ({ ...t, ruleSafe: teachable(t) && !unsafe.has(t.merchantKey) }))
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
  person_edit: number
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
 * 1 when a person's edit is the row's latest word: `updated_by` is an address ('@') and the newest category_edits row is not a rule's.
 * `alias` is the transactions table's name or alias in the query (idx_edits_txn serves the subselect).
 */
export const personEditSql = (alias = 'transactions'): string =>
  `(instr(${alias}.updated_by, '@') > 0 AND COALESCE((SELECT e.rule_id IS NOT NULL FROM category_edits e WHERE e.txn_id = ${alias}.id ORDER BY e.edited_at DESC, e.id DESC LIMIT 1), 0) = 0)`

const APPLY_COLUMNS = 'id, account_id, merchant_key, store_no, amount_cents, kind, kind_source, category_id, category_source, rule_id, debt_account_id, confidence, needs_review, review_reason, updated_at, '
  + `${personEditSql()} AS person_edit`

/**
 * The rows a rule re-apply reads: a merchant's whole history, on purpose. A rule says what a merchant IS,
 * so it must reach every past row of that merchant, and a date window would silently skip some (ADR 0007,
 * Consequences). The read is key-limited and index-backed: idx_txn_merchant (merchant_key, posted_date), at
 * most MAX_MERCHANT_KEYS keys per statement, manual rows excluded. Only "apply all" (no keys) reaches
 * every merchant that has an active rule, and that is an explicit action.
 */
export const APPLY_CANDIDATES_SQL =
  `SELECT ${APPLY_COLUMNS} FROM transactions WHERE merchant_key IN (SELECT value FROM json_each(?)) AND category_source <> 'manual' AND kind_source <> 'manual'`

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
  const rows: ApplyRow[] = []
  // Candidate rows come in slices of merchant keys so one json_each parameter stays small.
  for (let i = 0; i < keys.length; i += MAX_MERCHANT_KEYS) {
    const { results } = await db.prepare(APPLY_CANDIDATES_SQL).bind(JSON.stringify(keys.slice(i, i + MAX_MERCHANT_KEYS))).all<ApplyRow>()
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
    // A review-only rule change: nothing else differs, but the rule now asks for review and the row is not yet flagged
    // with its reason. A row whose latest edit is a person's ('@' in updated_by) is never touched this way.
    const wantReason = res.rule.reviewReason ?? 'rule'
    const needsFlag = sameFields && res.rule.review && Number(r.person_edit) !== 1
      && (Number(r.needs_review) !== 1 || r.review_reason !== wantReason)
    if (sameFields && !needsFlag) continue
    const categoryMoved = res.categoryId !== r.category_id || res.categorySource !== r.category_source || res.ruleId !== r.rule_id
    let review = Number(r.needs_review)
    let reason = r.review_reason
    if (needsFlag) { review = 1; reason = wantReason }
    else if (categoryMoved) {
      if (res.rule.review) { review = 1; reason = wantReason }
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

export const EDITS_FROM_JSON_SQL = `INSERT INTO category_edits (txn_id, old_category_id, new_category_id, old_kind, new_kind, rule_id, edited_at, edited_by)
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

/**
 * One statement for GET /transactions/similar: the source row, the merchant's category/name spread (spending rows) and the
 * candidates, newest first. Candidates: same merchant_key (never ''), same kind group, any date, not already in the source's
 * category. idx_txn_merchant (merchant_key, posted_date) serves the join and the order; idx_edits_txn serves the EXISTS.
 * LIMIT is MAX_SIMILAR + 1 so a 301st row says "truncated". person_set: a manual category a person may have chosen.
 */
export const SIMILAR_SQL = `WITH src AS (SELECT id, merchant_key, kind, amount_cents, category_id FROM transactions WHERE id = ?1),
k AS (SELECT COUNT(DISTINCT COALESCE(t.category_id, '')) AS cats, COUNT(DISTINCT t.merchant_name) AS names
      FROM transactions t, src WHERE t.merchant_key = src.merchant_key AND src.merchant_key <> '' AND t.kind IN (${SPENDING_SQL}))
SELECT src.id AS src_id, src.merchant_key AS src_key, src.kind AS src_kind, src.amount_cents AS src_amount, src.category_id AS src_cat, k.cats, k.names,
       t.id, t.posted_date, t.amount_cents, t.merchant_name, t.description, t.account_id, t.kind, t.category_id, t.category_source, t.updated_at, t.note,
       (t.category_source = 'manual' AND (instr(t.updated_by, '@') > 0 OR EXISTS (
          SELECT 1 FROM category_edits e WHERE e.txn_id = t.id AND instr(e.edited_by, '@') > 0
            AND e.new_category_id IS NOT e.old_category_id))) AS person_set
FROM src CROSS JOIN k
LEFT JOIN transactions t
  ON t.merchant_key = src.merchant_key AND src.merchant_key <> '' AND t.id <> src.id
 AND ((src.kind IN (${SPENDING_SQL}) AND t.kind IN (${SPENDING_SQL})) OR (src.kind NOT IN (${SPENDING_SQL}) AND t.kind = src.kind))
 AND t.category_id IS NOT src.category_id
ORDER BY t.posted_date DESC, t.id DESC
LIMIT ${MAX_SIMILAR + 1}`

/** The read's rows as the response; null when there is no source row (no rows at all). */
export function buildSimilar(rows: Row[]): SimilarResponse | null {
  const first = rows[0]
  if (!first) return null
  const key = str(first.src_key)
  const reasons: SimilarMixedReason[] = []
  if (isPaymentServiceKey(key)) reasons.push('payment_service')
  if (Number(first.names) > 1) reasons.push('shared_name')
  if (Number(first.cats) >= 3) reasons.push('many_categories')
  const mixed = reasons.length > 0
  const srcAmount = Number(first.src_amount)
  const found = rows.filter((r) => r.id !== null && r.id !== undefined)
  const out: SimilarRow[] = found.slice(0, MAX_SIMILAR).map((r) => {
    const personSet = Number(r.person_set) === 1
    const scriptSet = str(r.category_source) === 'manual' && !personSet
    return {
      id: str(r.id), postedDate: str(r.posted_date), amountCents: Number(r.amount_cents), merchantName: str(r.merchant_name), description: str(r.description),
      accountId: str(r.account_id), kind: str(r.kind) as TxnKind, categoryId: strOrNull(r.category_id), categorySource: str(r.category_source) as Txn['categorySource'],
      updatedAt: str(r.updated_at), note: strOrNull(r.note), personSet, scriptSet, sameAmount: Number(r.amount_cents) === srcAmount,
      suggestTick: !personSet && !(scriptSet && mixed),
    }
  })
  return {
    source: { id: str(first.src_id), merchantKey: key, amountCents: srcAmount, categoryId: strOrNull(first.src_cat) },
    mixed, mixedReasons: reasons, rows: out, truncated: found.length > MAX_SIMILAR,
    ruleOffer: mixed ? { allowed: false, reason: 'Several merchants or purchase types share this name.' } : { allowed: true },
  }
}

/** The apply's audit rows: one per item whose stamp still matches and whose row is another row of the source's merchant. */
const SIMILAR_EDITS_SQL = `INSERT INTO category_edits (txn_id, old_category_id, new_category_id, old_kind, new_kind, rule_id, edited_at, edited_by)
SELECT t.id, t.category_id, ?2, t.kind, t.kind, NULL, json_extract(j.value, '$.stamp'), ?4
FROM json_each(?1) j JOIN transactions t ON t.id = json_extract(j.value, '$.id') AND t.updated_at = json_extract(j.value, '$.prev')
WHERE t.id <> ?3 AND t.merchant_key <> '' AND t.merchant_key = (SELECT merchant_key FROM transactions WHERE id = ?3)
  AND ((SELECT kind FROM transactions WHERE id = ?3) IN (${SPENDING_SQL}) AND t.kind IN (${SPENDING_SQL})
   OR (SELECT kind FROM transactions WHERE id = ?3) NOT IN (${SPENDING_SQL}) AND t.kind = (SELECT kind FROM transactions WHERE id = ?3))
  AND t.category_id IS NOT ?2`

/** Same category semantics as PATCH (manual, rule cleared, review settled). The guards (same merchant, same kind group as SIMILAR_SQL, not already in the target category) are re-checked here so a stale or crafted client list cannot recategorize other merchants' rows, a transfer with a spending category, or rewrite a row already there as manual. */
const SIMILAR_UPDATE_SQL = `WITH ch AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.prev') AS prev, json_extract(value, '$.stamp') AS stamp FROM json_each(?1))
UPDATE transactions SET category_id = ?2, category_source = 'manual', rule_id = NULL, needs_review = 0, review_reason = NULL, confidence = 100,
  updated_at = ch.stamp, updated_by = ?4
FROM ch WHERE transactions.id = ch.id AND transactions.updated_at = ch.prev AND transactions.id <> ?3 AND transactions.merchant_key <> ''
  AND transactions.merchant_key = (SELECT merchant_key FROM transactions WHERE id = ?3)
  AND ((SELECT kind FROM transactions WHERE id = ?3) IN (${SPENDING_SQL}) AND transactions.kind IN (${SPENDING_SQL})
   OR (SELECT kind FROM transactions WHERE id = ?3) NOT IN (${SPENDING_SQL}) AND transactions.kind = (SELECT kind FROM transactions WHERE id = ?3))
  AND transactions.category_id IS NOT ?2`

export interface SimilarItem { id: string; expectedUpdatedAt: string }

/**
 * Applies a category to the ticked rows in ONE batch (one transaction): per chunk an audit insert then the guarded update (the
 * insert first, its join needs the old updated_at), optionally the merchant rule, then a read-back of every item. A row whose stamp
 * moved, that is not a candidate (other merchant or kind group, or already in the category) is not written; it comes back in `conflicts`.
 */
export async function applySimilar(
  db: D1Database, sourceId: string, categoryId: string | null, items: SimilarItem[], who: string, rule: D1PreparedStatement | null, now: number = Date.now(),
): Promise<{ changed: Array<{ id: string; updatedAt: string }>; conflicts: Array<{ id: string; current: Txn | null }> }> {
  const planned = items.map((it) => ({ id: it.id, prev: it.expectedUpdatedAt, stamp: nextStamp(it.expectedUpdatedAt, now) }))
  const stmts: D1PreparedStatement[] = []
  for (const chunk of chunkBySize(planned)) {
    const json = JSON.stringify(chunk)
    stmts.push(db.prepare(SIMILAR_EDITS_SQL).bind(json, categoryId, sourceId, who))
    stmts.push(db.prepare(SIMILAR_UPDATE_SQL).bind(json, categoryId, sourceId, who))
  }
  if (rule) stmts.push(rule)
  stmts.push(db.prepare(`SELECT ${TXN_COLUMNS} FROM transactions WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(items.map((i) => i.id))))
  const results = await db.batch(stmts)
  const current = new Map((results[results.length - 1].results as Row[]).map((r) => [str(r.id), r]))
  const changed: Array<{ id: string; updatedAt: string }> = []
  const conflicts: Array<{ id: string; current: Txn | null }> = []
  for (const p of planned) {
    const r = current.get(p.id)
    if (r && str(r.updated_at) === p.stamp) changed.push({ id: p.id, updatedAt: p.stamp })
    else conflicts.push({ id: p.id, current: r ? mapTxn(r) : null })
  }
  return { changed, conflicts }
}

/** The merchant-wide 'edit' rule POST /rules and the similar apply both write (upsert on the deterministic id). */
export function editRuleStmt(
  db: D1Database, r: { id: string; merchantKey: string; storeNo: string | null; setCategoryId: string | null; setKind: TxnKind | null }, who: string, now: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO merchant_rules (id, merchant_key, store_no, account_id, amount_min_cents, amount_max_cents, set_category_id, set_kind,
       debt_account_id, display_name, confidence, review, review_reason, source, active, created_at, created_by)
     VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, 90, 0, NULL, 'edit', 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET set_category_id = COALESCE(excluded.set_category_id, merchant_rules.set_category_id),
       set_kind = COALESCE(excluded.set_kind, merchant_rules.set_kind), review = 0, review_reason = NULL, active = 1, source = 'edit'`,
  ).bind(r.id, r.merchantKey, r.storeNo, r.setCategoryId, r.setKind, now, who)
}

/** The id a merchant-wide rule for this key has (see ruleIdFor). */
export const merchantRuleId = (merchantKey: string): Promise<string> =>
  ruleIdFor({ merchantKey, storeNo: null, accountId: null, amountMinCents: null, amountMaxCents: null })

/** The rule a manual edit teaches, as its stored id and fields (see POST /rules). */
export async function ruleFromTxn(txn: Txn, scope: 'merchant' | 'merchant_store'): Promise<{ id: string; storeNo: string | null; setCategoryId: string | null; setKind: TxnKind | null }> {
  const storeNo = scope === 'merchant_store' ? txn.storeNo : null
  const id = await ruleIdFor({ merchantKey: txn.merchantKey, storeNo, accountId: null, amountMinCents: null, amountMaxCents: null })
  return { id, storeNo, setCategoryId: txn.categoryId, setKind: txn.kindSource === 'manual' ? txn.kind : null }
}

// ---------- debts --------------------------------------------------------------------------------

interface DebtRow extends Row { id: string }

/** debt_balances.entered_by of a row the bank sync wrote (the banks Worker's `WRITER`); every other writer is a person. */
const BANK_BALANCE_WRITER = 'sync:plaid'
/** A debt_balances row's source: `'bank'` only for the sync's own row, otherwise typed in by a person. */
const balanceSource = (enteredBy: unknown): 'manual' | 'bank' => (enteredBy === BANK_BALANCE_WRITER ? 'bank' : 'manual')

/** Latest statement balance and latest typed balance per debt account; the newer wins (a tie: the statement). */
export async function loadDebts(db: D1Database, person: string): Promise<DebtSlice[]> {
  if (person !== 'all') {
    const p = await db.prepare('SELECT id FROM people WHERE id = ?').bind(person).first()
    if (!p) throw badRequest('person: unknown person')
  }
  const scope = `SELECT id FROM accounts WHERE is_debt = 1 AND archived = 0 AND (?1 = 'all' OR person_id = ?1 OR person_id IS NULL)`
  const [accounts, statements, manual, cosigned] = await db.batch<DebtRow>([
    db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE is_debt = 1 AND archived = 0 AND (?1 = 'all' OR person_id = ?1 OR person_id IS NULL) ORDER BY sort, id`).bind(person),
    db.prepare(
      `SELECT s.account_id, s.period_end, s.closing_balance_cents, s.apr_bp, s.credit_limit_cents FROM statements s
       WHERE s.account_id IN (${scope}) AND s.closing_balance_cents IS NOT NULL
         AND s.period_end = (SELECT MAX(s2.period_end) FROM statements s2 WHERE s2.account_id = s.account_id AND s2.closing_balance_cents IS NOT NULL)`,
    ).bind(person),
    db.prepare(
      `SELECT b.account_id, b.as_of, b.balance_cents, b.apr_bp, b.entered_by FROM debt_balances b
       WHERE b.account_id IN (${scope}) AND b.as_of = (SELECT MAX(b2.as_of) FROM debt_balances b2 WHERE b2.account_id = b.account_id)`,
    ).bind(person),
    db.prepare(`SELECT account_id FROM debt_terms WHERE cosigned = 1 AND account_id IN (${scope})`).bind(person),
  ])
  const cosignedIds = new Set(cosigned.results.map((r) => str(r.account_id)))
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
      source: chosen ? (useManual ? balanceSource(m!.entered_by) : 'statement') : null,
      aprBp: debtAprBp([
        ...(s ? [{ asOf: str(s.period_end), source: 'statement' as const, aprBp: numOrNull(s.apr_bp) }] : []),
        ...(m ? [{ asOf: str(m.as_of), source: 'manual' as const, aprBp: numOrNull(m.apr_bp) }] : []),
      ], a.aprBp),
      creditLimitCents: numOrNull(s?.credit_limit_cents) ?? a.creditLimitCents,
      cosigned: cosignedIds.has(a.id),
    }
  })
}

// ---------- loan reads (migrations/gss-budget/0002_loans.sql) -------------------------------------

const TERMS_COLUMNS = 'account_id, original_cents, opened_on, maturity_on, term_months, payment_cents, payment_every, cosigned, updated_at, updated_by'
const LATEST_COLUMNS = 'account_id, period_end, min_due_cents, due_date, payoff_cents, escrow_cents, interest_cents'
const PROMO_COLUMNS = 'account_id, period_end, seq, balance_cents, apr_bp, ends_on, deferred_interest_cents'
export const TERMS_SQL = `SELECT ${TERMS_COLUMNS} FROM debt_terms WHERE account_id = ?`
export const LATEST_ONE_SQL = `SELECT ${LATEST_COLUMNS} FROM statements WHERE account_id = ? ORDER BY period_end DESC LIMIT 1`
/** The promos of the newest statement, in printed order (PK prefix walk). */
export const PROMOS_ONE_SQL = `SELECT ${PROMO_COLUMNS} FROM statement_promos WHERE account_id = ?1
  AND period_end = (SELECT MAX(period_end) FROM statements WHERE account_id = ?1) ORDER BY seq`

const mapTerms = (r: Row): DebtTerms => ({
  accountId: str(r.account_id), originalCents: numOrNull(r.original_cents), openedOn: strOrNull(r.opened_on) as IsoDate | null,
  maturityOn: strOrNull(r.maturity_on) as IsoDate | null, termMonths: numOrNull(r.term_months), paymentCents: numOrNull(r.payment_cents),
  paymentEvery: strOrNull(r.payment_every) as DebtTerms['paymentEvery'], cosigned: Number(r.cosigned) === 1,
  updatedAt: str(r.updated_at), updatedBy: str(r.updated_by),
})
const mapLatest = (r: Row): LatestStatement => ({
  periodEnd: str(r.period_end) as IsoDate, minDueCents: numOrNull(r.min_due_cents), dueDate: strOrNull(r.due_date) as IsoDate | null,
  payoffCents: numOrNull(r.payoff_cents), escrowCents: numOrNull(r.escrow_cents), interestCents: numOrNull(r.interest_cents),
})
const mapPromo = (r: Row): StatementPromo => ({
  accountId: str(r.account_id), periodEnd: str(r.period_end) as IsoDate, seq: Number(r.seq), balanceCents: Number(r.balance_cents),
  aprBp: numOrNull(r.apr_bp), endsOn: strOrNull(r.ends_on) as IsoDate | null, deferredInterestCents: numOrNull(r.deferred_interest_cents),
})

const LOAN_SCOPE = `SELECT id FROM accounts WHERE is_debt = 1 AND archived = 0 AND (?1 = 'all' OR person_id = ?1 OR person_id IS NULL)`
/**
 * Payments per calendar month, bounded by posted_date ([?2, ?3)): an external debt's rows are linked by
 * debt_account_id (idx_txn_debt), every other debt's by its own account (partial idx_txn_pay), as in
 * DEBT_PAYMENTS_SQL. Amounts are what was paid toward the debt, so positive. The test asserts both plans.
 */
export const LOAN_PAYMENTS_SQL = {
  external: `SELECT debt_account_id AS account_id, substr(posted_date, 1, 7) AS month, SUM(ABS(amount_cents)) AS cents FROM transactions
    WHERE debt_account_id IN (SELECT id FROM (${LOAN_SCOPE}) WHERE id IN (SELECT id FROM accounts WHERE kind = 'external_debt'))
      AND posted_date >= ?2 AND posted_date < ?3 GROUP BY debt_account_id, month`,
  account: `SELECT account_id, substr(posted_date, 1, 7) AS month, SUM(ABS(amount_cents)) AS cents FROM transactions INDEXED BY idx_txn_pay
    WHERE account_id IN (SELECT id FROM (${LOAN_SCOPE}) WHERE id IN (SELECT id FROM accounts WHERE kind <> 'external_debt'))
      AND kind IN ('card_payment','loan_payment') AND posted_date >= ?2 AND posted_date < ?3 GROUP BY account_id, month`,
} as const

/** The last `count` FULL calendar months before `now` (UTC), oldest first, and the [from, to) date bounds. */
export function lastFullMonths(now: Date, count = 3): { months: string[]; from: IsoDate; to: IsoDate } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const months: string[] = []
  for (let i = count; i >= 1; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    months.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`)
  }
  return { months, from: `${months[0]}-01` as IsoDate, to: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01` as IsoDate }
}

/** The /loans batch's terms, latest-statement and promo reads (one per account set; ?1 = person). The test asserts their plans. */
export const LOAN_TERMS_SQL = `SELECT ${TERMS_COLUMNS} FROM debt_terms WHERE account_id IN (${LOAN_SCOPE})`
export const LOAN_LATEST_SQL = `SELECT ${LATEST_COLUMNS} FROM statements s WHERE s.account_id IN (${LOAN_SCOPE})
         AND s.period_end = (SELECT MAX(s2.period_end) FROM statements s2 WHERE s2.account_id = s.account_id)`
export const LOAN_PROMOS_SQL = `SELECT ${PROMO_COLUMNS} FROM statement_promos p WHERE p.account_id IN (${LOAN_SCOPE})
         AND p.period_end = (SELECT MAX(s.period_end) FROM statements s WHERE s.account_id = p.account_id) ORDER BY p.account_id, p.seq`

/**
 * The bank's liabilities snapshot of each linked debt in scope (bank_liabilities, written by the banks Worker). One read:
 * the scope's accounts drive, each looks up its single `on` bank account through the partial idx_bank_acct_on, then the
 * snapshot by primary key. The test asserts the plan.
 */
export const LOAN_BANK_SQL = `SELECT ba.account_id, l.last_statement_date, l.min_due_cents, l.next_monthly_payment_cents, l.next_due_date, l.escrow_cents, l.fetched_at
  FROM bank_accounts ba JOIN bank_liabilities l ON l.bank_account_id = ba.id
  WHERE ba.sync = 'on' AND ba.account_id IN (${LOAN_SCOPE})`
/** The same snapshot read for the one debt of the debt detail (?1 = the account), so Loans and the detail agree. */
export const DEBT_BANK_ONE_SQL = `SELECT ba.account_id, l.last_statement_date, l.min_due_cents, l.next_monthly_payment_cents, l.next_due_date, l.escrow_cents, l.fetched_at
  FROM bank_accounts ba JOIN bank_liabilities l ON l.bank_account_id = ba.id
  WHERE ba.sync = 'on' AND ba.account_id = ?`

/**
 * The latest-statement block of a Loans row: the bank snapshot's min due, due date and escrow replace the statement's only
 * when the snapshot's last statement date is newer than the newest statement's period end (a snapshot with no statement
 * date, as a mortgage has, wins only where there is no statement at all). Payoff and interest stay null: the bank sends neither.
 */
export function preferBankLatest(statement: LatestStatement | null, bank: Row | undefined): LatestStatement | null {
  if (!bank) return statement
  const stmtDate = strOrNull(bank.last_statement_date)
  if (statement && !(stmtDate !== null && stmtDate > statement.periodEnd)) return statement
  return {
    periodEnd: (stmtDate ?? str(bank.fetched_at).slice(0, 10)) as IsoDate,
    minDueCents: numOrNull(bank.min_due_cents) ?? numOrNull(bank.next_monthly_payment_cents),
    dueDate: strOrNull(bank.next_due_date) as IsoDate | null,
    payoffCents: null, escrowCents: numOrNull(bank.escrow_cents), interestCents: null,
  }
}

/** Everything the Loans page needs; the debt rows are exactly loadDebts' (same scope, same newer-wins rule). */
export async function loadLoans(db: D1Database, person: string, now: Date = new Date()): Promise<LoansResponse> {
  const debts = await loadDebts(db, person)
  const { months, from, to } = lastFullMonths(now)
  const [terms, latest, promos, ext, own, bank] = await db.batch<Row>([
    db.prepare(LOAN_TERMS_SQL).bind(person),
    db.prepare(LOAN_LATEST_SQL).bind(person),
    db.prepare(LOAN_PROMOS_SQL).bind(person),
    db.prepare(LOAN_PAYMENTS_SQL.external).bind(person, from, to),
    db.prepare(LOAN_PAYMENTS_SQL.account).bind(person, from, to),
    db.prepare(LOAN_BANK_SQL).bind(person),
  ])
  const bankBy = new Map(bank.results.map((r) => [str(r.account_id), r]))
  const termsBy = new Map(terms.results.map((r) => [str(r.account_id), mapTerms(r)]))
  const latestBy = new Map(latest.results.map((r) => [str(r.account_id), mapLatest(r)]))
  const promosBy = new Map<string, StatementPromo[]>()
  for (const r of promos.results) {
    const p = mapPromo(r)
    promosBy.set(p.accountId, [...(promosBy.get(p.accountId) ?? []), p])
  }
  const paidBy = new Map<string, number>()
  for (const r of [...ext.results, ...own.results]) paidBy.set(`${str(r.account_id)}|${str(r.month)}`, Number(r.cents))
  const rows: LoanRow[] = debts.map((d) => ({
    ...d,
    terms: termsBy.get(d.accountId) ?? null,
    latest: preferBankLatest(latestBy.get(d.accountId) ?? null, bankBy.get(d.accountId)),
    promos: promosBy.get(d.accountId) ?? [],
    payments: months.map((month) => ({ month, amountCents: paidBy.get(`${d.accountId}|${month}`) ?? 0 })),
  }))
  return { debts: rows, months }
}

/**
 * The debt detail's payment list, newest 60. Each reads only the newest 60 index entries: idx_txn_debt
 * (debt_account_id, posted_date, id) and the partial idx_txn_pay (account_id, posted_date, id) walk in the
 * order asked for, so there is no sort and no read of the account's older rows. The test asserts the plan.
 */
export const DEBT_PAYMENTS_SQL = {
  external: `SELECT id, posted_date, amount_cents, principal_cents, interest_cents FROM transactions WHERE debt_account_id = ? ORDER BY posted_date DESC, id DESC LIMIT 60`,
  account: `SELECT id, posted_date, amount_cents, principal_cents, interest_cents FROM transactions WHERE account_id = ? AND kind IN ('card_payment','loan_payment') ORDER BY posted_date DESC, id DESC LIMIT 60`,
} as const

export async function loadDebtDetail(db: D1Database, id: string): Promise<DebtDetail | null> {
  const acct = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ? AND is_debt = 1`).bind(id).first<Row>()
  if (!acct) return null
  const account = mapAccount(acct)
  const paymentSql = account.kind === 'external_debt' ? DEBT_PAYMENTS_SQL.external : DEBT_PAYMENTS_SQL.account
  const [statements, manual, payments, terms, latest, promos, bank] = await db.batch<Row>([
    db.prepare(
      `SELECT period_end, closing_balance_cents, apr_bp, interest_cents, principal_paid_cents, advances_cents FROM statements WHERE account_id = ? ORDER BY period_end DESC LIMIT 24`,
    ).bind(id),
    db.prepare(`SELECT as_of, balance_cents, apr_bp, entered_by FROM debt_balances WHERE account_id = ? ORDER BY as_of DESC LIMIT 24`).bind(id),
    db.prepare(paymentSql).bind(id),
    db.prepare(TERMS_SQL).bind(id),
    db.prepare(LATEST_ONE_SQL).bind(id),
    db.prepare(PROMOS_ONE_SQL).bind(id),
    db.prepare(DEBT_BANK_ONE_SQL).bind(id),
  ])
  const history: DebtDetail['history'] = [
    ...statements.results.filter((r) => r.closing_balance_cents !== null).map((r) => ({ asOf: str(r.period_end), balanceCents: Number(r.closing_balance_cents), source: 'statement' as const, aprBp: numOrNull(r.apr_bp) })),
    ...manual.results.map((r) => ({ asOf: str(r.as_of), balanceCents: Number(r.balance_cents), source: balanceSource(r.entered_by), aprBp: numOrNull(r.apr_bp) })),
  ].sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : a.source === b.source ? 0 : a.source === 'statement' ? -1 : 1))
  const periods: DebtDetail['periods'] = statements.results.map((r) => ({
    periodEnd: str(r.period_end), aprBp: numOrNull(r.apr_bp), interestCents: numOrNull(r.interest_cents),
    principalPaidCents: numOrNull(r.principal_paid_cents), advancesCents: numOrNull(r.advances_cents),
  })).reverse()
  return {
    account, history, periods,
    terms: terms.results[0] ? mapTerms(terms.results[0]) : null,
    latest: preferBankLatest(latest.results[0] ? mapLatest(latest.results[0]) : null, bank.results[0]),
    promos: promos.results.map(mapPromo),
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

