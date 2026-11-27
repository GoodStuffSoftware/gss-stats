// Liabilities and balances (plan 4.5). Once per ~20 h per Item that has an `on` account: /liabilities/get when one of those is
// a credit or loan account, else the free /accounts/get (also the fallback when Plaid says liabilities are not on the Item).
// Never /accounts/balance/get. Only typed fields are kept (cents, basis points, ISO dates, flags): the account number, property
// address, servicer address, payment reference and every other free-text field in Plaid's answer are never read, stored or logged.
// Balances: bank_accounts.balance_cents is Plaid's `current` x100 as sent (credit: positive = owed).
// debt_balances: a person-entered row is never overwritten; a `sync:plaid` row of the same month is updated, else one is added.
// Logs: counts and codes only.
import { WRITER } from './apply'
import type { Env } from './env'
import { log } from './log'
import { PlaidError, type PlaidClient } from './plaid'
import { getItem, openAndRefreshToken, type Keys } from './store'
import { plaidErrorCode } from './sync'

export const LIAB_WINDOW_MS = 20 * 3_600_000
/** A claim moves liabilities_at to (now - window + retry): a failed refresh is tried again after this long, not after 20 h. */
export const LIAB_RETRY_MS = 3_600_000
export const LIAB_PICK_LIMIT = 3

/** The due pick (EXPLAIN-tested): a live Item with an `on` account whose liabilities_at is empty or older than ?1. */
export const LIAB_DUE_SQL = `SELECT i.id FROM bank_items i
   WHERE i.status IN ('active','pending_disconnect') AND (i.liabilities_at IS NULL OR i.liabilities_at < ?1)
     AND EXISTS (SELECT 1 FROM bank_accounts b WHERE b.item_id = i.id AND b.sync = 'on')
   LIMIT ${LIAB_PICK_LIMIT}`
export const LIAB_CLAIM_SQL = `UPDATE bank_items SET liabilities_at = ?2 WHERE id = ?1 AND (liabilities_at IS NULL OR liabilities_at < ?3)`
/** The stored accounts of one Item with their Budget account's debt flag (index on item_id, primary key on accounts). */
export const LIAB_ACCOUNTS_SQL = `SELECT b.id, b.plaid_account_id, b.account_id, b.sync, b.type, a.is_debt
   FROM bank_accounts b LEFT JOIN accounts a ON a.id = b.account_id WHERE b.item_id = ?1`
/** The debt_balances rows of one account in one month (primary key range). */
export const DEBT_MONTH_SQL = `SELECT as_of, entered_by FROM debt_balances WHERE account_id = ?1 AND as_of >= ?2 AND as_of <= ?3`

const iso = (ms: number): string => new Date(ms).toISOString()
const FALLBACK_CODES = new Set(['PRODUCTS_NOT_SUPPORTED', 'NO_LIABILITY_ACCOUNTS'])
const LIMIT = 10_000_000_000

// ---- typed readers: a value outside its column's CHECK becomes null, never a failed batch ----
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function cents(v: unknown, allowNegative = false): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const c = Math.round(v * 100)
  if (c > LIMIT || c < (allowNegative ? -LIMIT : 0)) return null
  return c
}
function bp(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const c = Math.round(v * 100)
  return c >= 0 && c <= 10_000 ? c : null
}
function day(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = new Date(`${v}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v
}
const flag = (v: unknown): number | null => (typeof v === 'boolean' ? (v ? 1 : 0) : null)

export interface Liability {
  kind: 'credit' | 'mortgage' | 'student'
  apr_bp: number | null
  min_due_cents: number | null
  next_due_date: string | null
  last_statement_date: string | null
  last_statement_balance_cents: number | null
  last_payment_cents: number | null
  last_payment_date: string | null
  is_overdue: number | null
  past_due_cents: number | null
  next_monthly_payment_cents: number | null
  escrow_cents: number | null
  origination_date: string | null
  origination_cents: number | null
  maturity_date: string | null
  expected_payoff_date: string | null
  ytd_interest_cents: number | null
  ytd_principal_cents: number | null
}
const blank = (kind: Liability['kind']): Liability => ({
  kind, apr_bp: null, min_due_cents: null, next_due_date: null, last_statement_date: null, last_statement_balance_cents: null,
  last_payment_cents: null, last_payment_date: null, is_overdue: null, past_due_cents: null, next_monthly_payment_cents: null,
  escrow_cents: null, origination_date: null, origination_cents: null, maturity_date: null, expected_payoff_date: null,
  ytd_interest_cents: null, ytd_principal_cents: null,
})

/** The purchase APR of a credit entry (apr_type 'purchase_apr'); null when there is none. */
function purchaseApr(aprs: unknown): number | null {
  if (!Array.isArray(aprs)) return null
  for (const a of aprs) if (isObj(a) && a.apr_type === 'purchase_apr') return bp(a.apr_percentage)
  return null
}

/** One liabilities entry to typed fields. Reads only the fields named here; everything else Plaid sends is ignored. */
export function mapLiability(kind: Liability['kind'], e: Record<string, unknown>): Liability {
  const l = blank(kind)
  if (kind === 'credit') {
    l.apr_bp = purchaseApr(e.aprs)
    l.min_due_cents = cents(e.minimum_payment_amount)
    l.next_due_date = day(e.next_payment_due_date)
    l.last_statement_date = day(e.last_statement_issue_date)
    l.last_statement_balance_cents = cents(e.last_statement_balance, true)
    l.last_payment_cents = cents(e.last_payment_amount)
    l.last_payment_date = day(e.last_payment_date)
    l.is_overdue = flag(e.is_overdue)
  } else if (kind === 'mortgage') {
    l.apr_bp = isObj(e.interest_rate) ? bp(e.interest_rate.percentage) : null
    l.next_monthly_payment_cents = cents(e.next_monthly_payment)
    l.escrow_cents = cents(e.escrow_balance)
    l.past_due_cents = cents(e.past_due_amount)
    l.origination_date = day(e.origination_date)
    l.origination_cents = cents(e.origination_principal_amount)
    l.maturity_date = day(e.maturity_date)
    l.ytd_interest_cents = cents(e.ytd_interest_paid)
    l.ytd_principal_cents = cents(e.ytd_principal_paid)
    l.next_due_date = day(e.next_payment_due_date)
  } else {
    l.apr_bp = bp(e.interest_rate_percentage)
    l.min_due_cents = cents(e.minimum_payment_amount)
    l.next_due_date = day(e.next_payment_due_date)
    l.expected_payoff_date = day(e.expected_payoff_date)
    l.origination_date = day(e.origination_date)
    l.origination_cents = cents(e.origination_principal_amount)
    l.last_statement_date = day(e.last_statement_issue_date)
    l.last_statement_balance_cents = cents(e.last_statement_balance, true)
    l.ytd_interest_cents = cents(e.ytd_interest_paid)
    l.ytd_principal_cents = cents(e.ytd_principal_paid)
    l.is_overdue = flag(e.is_overdue)
  }
  return l
}

const LIAB_COLS = [
  'kind', 'apr_bp', 'min_due_cents', 'next_due_date', 'last_statement_date', 'last_statement_balance_cents', 'last_payment_cents',
  'last_payment_date', 'is_overdue', 'past_due_cents', 'next_monthly_payment_cents', 'escrow_cents', 'origination_date',
  'origination_cents', 'maturity_date', 'expected_payoff_date', 'ytd_interest_cents', 'ytd_principal_cents',
] as const
const LIAB_UPSERT = `INSERT INTO bank_liabilities (bank_account_id, ${LIAB_COLS.join(', ')}, fetched_at)
  VALUES (?1, ${LIAB_COLS.map((_, i) => `?${i + 2}`).join(', ')}, ?${LIAB_COLS.length + 2})
  ON CONFLICT(bank_account_id) DO UPDATE SET ${[...LIAB_COLS, 'fetched_at'].map((c) => `${c} = excluded.${c}`).join(', ')}`

interface StoredAccount { id: string; plaid_account_id: string; account_id: string | null; sync: string; type: string; is_debt: number | null }

/** Take the Item for this tick. False = another tick took it inside the window: skip it. */
export async function claimLiabilities(db: D1Database, id: string, now: Date): Promise<boolean> {
  const r = await db.prepare(LIAB_CLAIM_SQL).bind(id, iso(now.getTime() - LIAB_WINDOW_MS + LIAB_RETRY_MS), iso(now.getTime() - LIAB_WINDOW_MS)).run()
  return (r.meta?.changes ?? 0) === 1
}

export async function pickLiabilitiesDue(db: D1Database, now: Date): Promise<string[]> {
  const r = await db.prepare(LIAB_DUE_SQL).bind(iso(now.getTime() - LIAB_WINDOW_MS)).all<{ id: string }>()
  return (r.results ?? []).map((x) => x.id)
}

/** The statements for one debt account (plan 4.5 debt_balances rule). `rows` are the account's rows in the current month. */
export function debtStatements(
  db: D1Database, accountId: string, balanceCents: number, aprBp: number | null, today: string, nowIso: string,
  rows: Array<{ as_of: string; entered_by: string }>,
): D1PreparedStatement[] {
  const atToday = rows.find((r) => r.as_of === today)
  if (atToday && atToday.entered_by !== WRITER) return [] // a person's (or any other writer's) row for today: never touched
  const mine = rows.filter((r) => r.entered_by === WRITER).sort((a, b) => (a.as_of < b.as_of ? 1 : -1))[0]
  if (mine) {
    return [
      db
        .prepare(
          `UPDATE debt_balances SET as_of = ?3, balance_cents = ?4, apr_bp = COALESCE(?5, apr_bp), entered_at = ?6
            WHERE account_id = ?1 AND as_of = ?2 AND entered_by = '${WRITER}'
              AND (as_of = ?3 OR NOT EXISTS (SELECT 1 FROM debt_balances WHERE account_id = ?1 AND as_of = ?3))`,
        )
        .bind(accountId, mine.as_of, today, balanceCents, aprBp, nowIso),
    ]
  }
  return [
    db
      .prepare(
        `INSERT INTO debt_balances (account_id, as_of, balance_cents, apr_bp, entered_at, entered_by)
         SELECT ?1, ?2, ?3, ?4, ?5, '${WRITER}'
          WHERE NOT EXISTS (SELECT 1 FROM debt_balances WHERE account_id = ?1 AND as_of = ?2)`,
      )
      .bind(accountId, today, balanceCents, aprBp, nowIso),
  ]
}

interface PlaidAcct { account_id?: unknown; balances?: unknown }
type Answer = { accounts?: unknown; liabilities?: unknown }

/**
 * Refresh one Item: balances for every stored account in the answer, typed liabilities for its `on` accounts, the debt balance
 * rows. True when the answer was applied. A failed Plaid call or an unreadable answer changes nothing (the claim retries it).
 */
export async function refreshItem(db: D1Database, env: Env, client: PlaidClient, keys: Keys, itemId: string, now: Date): Promise<boolean> {
  const item = await getItem(db, itemId)
  if (!item || !['active', 'pending_disconnect'].includes(item.status) || item.environment !== (env.PLAID_ENV ?? '')) return false
  const at = now.toISOString()
  const stored = ((await db.prepare(LIAB_ACCOUNTS_SQL).bind(itemId).all<StoredAccount>()).results ?? [])
  if (stored.length === 0) return false
  const byPlaid = new Map(stored.map((s) => [s.plaid_account_id, s]))
  const useLiabilities = stored.some((s) => s.sync === 'on' && (s.type === 'credit' || s.type === 'loan'))

  let answer: Answer
  let unavailable = false
  try {
    const token = await openAndRefreshToken(db, item, keys)
    if (useLiabilities) {
      try {
        answer = await client.post<Answer>('/liabilities/get', { access_token: token })
      } catch (e) {
        if (!(e instanceof PlaidError) || !FALLBACK_CODES.has(e.code)) throw e
        unavailable = true
        answer = await client.post<Answer>('/accounts/get', { access_token: token })
      }
    } else {
      answer = await client.post<Answer>('/accounts/get', { access_token: token })
    }
  } catch (e) {
    if (e instanceof PlaidError && e.code === 'ITEM_LOGIN_REQUIRED') {
      await db
        .prepare(`UPDATE bank_items SET status = 'needs_reconnect', last_error = ?2, updated_at = ?3 WHERE id = ?1 AND status IN ('active','pending_disconnect')`)
        .bind(itemId, plaidErrorCode('ITEM_LOGIN_REQUIRED'), at)
        .run()
      log('liabilities_failed', {}, 'needs_reconnect')
    } else {
      log('liabilities_failed', {}, e instanceof PlaidError ? plaidErrorCode(e.code) : 'plaid_failed')
    }
    return false
  }
  if (!isObj(answer) || !Array.isArray(answer.accounts)) {
    log('liabilities_failed', {}, 'bad_response')
    return false
  }

  const stmts: D1PreparedStatement[] = []
  const currentBy = new Map<string, number>()
  let balances = 0
  for (const a of answer.accounts as PlaidAcct[]) {
    if (!isObj(a) || typeof a.account_id !== 'string') continue
    const s = byPlaid.get(a.account_id)
    if (!s) continue // an account we do not hold (the new-accounts step adds it); never inserted here
    const b = isObj(a.balances) ? a.balances : {}
    const current = cents(b.current, true)
    if (current !== null) currentBy.set(s.id, current)
    stmts.push(
      db
        .prepare('UPDATE bank_accounts SET balance_cents = ?2, available_cents = ?3, limit_cents = ?4, balance_as_of = ?5, updated_at = ?5 WHERE id = ?1')
        .bind(s.id, current, cents(b.available, true), cents(b.limit), at),
    )
    balances++
  }

  // Typed liabilities for `on` accounts only (an unmapped or off account keeps no liabilities row).
  const aprBy = new Map<string, number | null>()
  let liabilities = 0
  if (!unavailable && isObj(answer.liabilities)) {
    for (const kind of ['credit', 'mortgage', 'student'] as const) {
      const list = (answer.liabilities as Record<string, unknown>)[kind]
      if (!Array.isArray(list)) continue
      for (const e of list) {
        if (!isObj(e) || typeof e.account_id !== 'string') continue
        const s = byPlaid.get(e.account_id)
        if (!s || s.sync !== 'on') continue
        const l = mapLiability(kind, e)
        aprBy.set(s.id, l.apr_bp)
        stmts.push(db.prepare(LIAB_UPSERT).bind(s.id, ...LIAB_COLS.map((c) => l[c]), at))
        liabilities++
      }
    }
  }

  // Debt balance rows: a mapped `on` account whose Budget account is a debt and whose balance is not negative.
  const today = at.slice(0, 10)
  const month = today.slice(0, 7)
  let debts = 0
  for (const s of stored) {
    const current = currentBy.get(s.id)
    if (s.sync !== 'on' || !s.account_id || s.is_debt !== 1 || current === undefined || current < 0) continue
    const rows = (await db.prepare(DEBT_MONTH_SQL).bind(s.account_id, `${month}-01`, `${month}-31`).all<{ as_of: string; entered_by: string }>()).results ?? []
    const ds = debtStatements(db, s.account_id, current, aprBy.get(s.id) ?? null, today, at, rows)
    if (ds.length > 0) debts++
    stmts.push(...ds)
  }

  stmts.push(db.prepare('UPDATE bank_items SET liabilities_at = ?2, updated_at = ?2 WHERE id = ?1').bind(itemId, at))
  try {
    await db.batch(stmts)
  } catch {
    log('liabilities_failed', {}, 'store_failed')
    return false
  }
  log('liabilities_done', { balances, liabilities, debts }, unavailable ? 'liabilities_unavailable' : null)
  return true
}

/** The cron step: refresh up to three due Items. Returns how many were refreshed. */
export async function liabilitiesTick(db: D1Database, env: Env, client: PlaidClient, keys: Keys, now: Date): Promise<number> {
  let done = 0
  for (const id of await pickLiabilitiesDue(db, now)) {
    if (!(await claimLiabilities(db, id, now))) continue
    try {
      if (await refreshItem(db, env, client, keys, id, now)) done++
    } catch {
      log('liabilities_failed', {}, 'refresh_threw')
    }
  }
  return done
}
