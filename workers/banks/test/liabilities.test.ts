// Liabilities and balances (plan 4.5). Plaid is a stub that throws on any URL it was not told to expect; D1 is the fake over the real
// migrations. Every value is made up. The SENTINEL strings stand in for the fields that must never be stored.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBudgetDb, type FakeBudgetDb } from '../../../functions/_lib/testing/budgetDb'
import { DEBT_MONTH_SQL, LIAB_ACCOUNTS_SQL, LIAB_CLAIM_SQL, LIAB_DUE_SQL, liabilitiesTick, mapLiability, refreshItem } from '../src/liabilities'
import { createPlaidClient } from '../src/plaid'
import { sealToken, type Keys } from '../src/store'
import type { Env } from '../src/env'

const secret = (v: string) => ({ get: async () => v })
const BASE = 'https://sandbox.plaid.com'
const ACCESS = 'access-sandbox-test-token'
const KEY = btoa('0123456789abcdef0123456789abcdef')
const KEYS: Keys = { current: KEY, old: null }
const HOUR = 3_600_000
const ITEM = 'i000000000000a001'
const OWNER = 'owner@example.com'
const SENTINELS = ['ACCT-SENTINEL-MTG', 'ACCT-SENTINEL-STU', 'PAYREF-SENTINEL', 'Sentinel Property Lane', 'Sentinel Servicer Road', 'Sentinel Loan Name']

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const plaidError = (type: string, code: string) => json({ error_type: type, error_code: code, error_message: 'text that must never be kept', request_id: 'r' }, 400)

let db: FakeBudgetDb
let t: Date
let queue: Array<() => Response>
let fetched: string[]
let allowed: Set<string>

const env = (): Env => ({
  BUDGET_DB: db.d1, PLAID_CLIENT_ID: secret('client-id-sandbox-test'), PLAID_SECRET: secret('secret-value-sandbox-test'),
  BANKS_TOKEN_KEY: secret(KEY), PLAID_ENV: 'sandbox',
})
const stubFetch = ((url: string | URL | Request) => {
  const u = String(url)
  fetched.push(u)
  if (!allowed.has(u)) throw new Error(`unexpected fetch ${u}`)
  const next = queue.shift()
  if (!next) throw new Error('no response queued')
  return Promise.resolve(next())
}) as typeof fetch
const client = () => createPlaidClient({ env: env(), fetch: stubFetch, now: () => t })
const refresh = (res: Response | (() => Response), at?: string) => {
  queue.push(typeof res === 'function' ? res : () => res)
  if (at) t = new Date(at)
  return refreshItem(db.d1, env(), client(), KEYS, ITEM, t)
}

const run = (sql: string, ...v: unknown[]) => void (db.sqlite.prepare(sql) as any).run(...v)
const q = <T = Record<string, any>>(sql: string, ...v: unknown[]) => db.all<T>(sql, ...v)
const one = <T = Record<string, any>>(sql: string, ...v: unknown[]) => db.get<T>(sql, ...v)
const liab = (bankId: string) => one('SELECT * FROM bank_liabilities WHERE bank_account_id = ?', bankId)
const debts = (account: string) => q('SELECT * FROM debt_balances WHERE account_id = ? ORDER BY as_of', account)

async function seed(o: { depositoryOnly?: boolean; status?: string; environment?: string; liabilitiesAt?: string | null } = {}): Promise<void> {
  const enc = await sealToken(ACCESS, ITEM, KEYS)
  run(`INSERT INTO accounts (id, label, kind, is_debt) VALUES ('chk', 'Everyday Checking', 'checking', 0), ('crd', 'Pine Ridge Card', 'card', 1),
        ('mtg', 'Pine Ridge Home Loan', 'loan', 1), ('stu', 'Pine Ridge Study Loan', 'loan', 1)`)
  run(
    `INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, status, token_ct, token_iv, key_id, sync_cursor, initial_done,
       consent_version, consented_at, liabilities_at, created_at, updated_at)
     VALUES (?, ?, ?, 'item-plaid-001', ?, ?, ?, ?, 'cur-0', 1, 1, '2026-11-01T00:00:00Z', ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    ITEM, OWNER, o.environment ?? 'sandbox', o.status ?? 'active', enc.token_ct, enc.token_iv, enc.key_id, o.liabilitiesAt ?? null,
  )
  const ba = (id: string, plaid: string, name: string, type: string, subtype: string, acct: string | null, sync: string) =>
    run(`INSERT INTO bank_accounts (id, item_id, plaid_account_id, name, type, subtype, account_id, sync, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`, id, ITEM, plaid, name, type, subtype, acct, sync)
  ba('b000000000000c001', 'acc-chk', 'Everyday Checking', 'depository', 'checking', 'chk', 'on')
  if (o.depositoryOnly) return
  ba('b000000000000c002', 'acc-card', 'Pine Ridge Card', 'credit', 'credit card', 'crd', 'on')
  ba('b000000000000c003', 'acc-mtg', 'Pine Ridge Home Loan', 'loan', 'mortgage', 'mtg', 'on')
  ba('b000000000000c004', 'acc-stu', 'Pine Ridge Study Loan', 'loan', 'student', 'stu', 'on')
  ba('b000000000000c005', 'acc-unm', 'New Savings', 'depository', 'savings', null, 'unmapped')
}
const CHK = 'b000000000000c001', CARD = 'b000000000000c002', MTG = 'b000000000000c003', STU = 'b000000000000c004', UNM = 'b000000000000c005'

/** A /liabilities/get answer. Fields Plaid sends that we must never keep carry SENTINEL text. */
function liabilitiesAnswer(cardCurrent = 1234.56) {
  const bal = (current: number, available: number | null, limit: number | null) => ({ current, available, limit, iso_currency_code: 'USD' })
  return {
    accounts: [
      { account_id: 'acc-chk', name: 'Everyday Checking', mask: '0001', type: 'depository', subtype: 'checking', balances: bal(2500.5, 2400, null) },
      { account_id: 'acc-card', name: 'Pine Ridge Card', mask: '0002', type: 'credit', subtype: 'credit card', balances: bal(cardCurrent, 3765.44, 5000) },
      { account_id: 'acc-mtg', name: 'Pine Ridge Home Loan', mask: '0003', type: 'loan', subtype: 'mortgage', balances: bal(180000.25, null, null) },
      { account_id: 'acc-stu', name: 'Pine Ridge Study Loan', mask: '0004', type: 'loan', subtype: 'student', balances: bal(9750.1, null, null) },
      { account_id: 'acc-unm', name: 'New Savings', mask: '0005', type: 'depository', subtype: 'savings', balances: bal(300, 300, null) },
      { account_id: 'acc-new', name: 'Not Stored Yet', mask: '0006', type: 'depository', subtype: 'savings', balances: bal(1, 1, null) },
    ],
    liabilities: {
      credit: [{
        account_id: 'acc-card', is_overdue: false, last_payment_amount: 150.25, last_payment_date: '2026-11-05', last_statement_issue_date: '2026-11-01',
        last_statement_balance: 1190.5, minimum_payment_amount: 35, next_payment_due_date: '2026-11-28',
        aprs: [{ apr_type: 'balance_transfer_apr', apr_percentage: 15.5 }, { apr_type: 'purchase_apr', apr_percentage: 21.99 }],
      }],
      mortgage: [{
        account_id: 'acc-mtg', account_number: 'ACCT-SENTINEL-MTG', property_address: { street: 'Sentinel Property Lane', city: 'Nowhere', region: 'ZZ', postal_code: '00000', country: 'US' },
        interest_rate: { percentage: 3.875, type: 'fixed' }, next_monthly_payment: 1840.12, escrow_balance: 410.5, past_due_amount: 0,
        origination_date: '2019-04-01', origination_principal_amount: 250000, maturity_date: '2049-04-01', ytd_interest_paid: 6100.4, ytd_principal_paid: 2500.75,
        next_payment_due_date: '2026-12-01', last_payment_amount: 1840.12, last_payment_date: '2026-11-01',
      }],
      student: [{
        account_id: 'acc-stu', account_number: 'ACCT-SENTINEL-STU', payment_reference_number: 'PAYREF-SENTINEL', loan_name: 'Sentinel Loan Name',
        servicer_address: { street: 'Sentinel Servicer Road', city: 'Nowhere', region: 'ZZ', postal_code: '00000', country: 'US' },
        interest_rate_percentage: 4.5, minimum_payment_amount: 120, next_payment_due_date: '2026-12-05', expected_payoff_date: '2031-06-30',
        origination_date: '2018-09-01', origination_principal_amount: 18000, last_statement_issue_date: '2026-11-05', last_statement_balance: 9800.25,
        ytd_interest_paid: 300.1, ytd_principal_paid: 700.2, is_overdue: true,
      }],
    },
    item: { item_id: 'item-plaid-001' },
    request_id: 'r',
  }
}
const accountsOnly = () => ({ accounts: liabilitiesAnswer().accounts, request_id: 'r' })
const LIAB = `${BASE}/liabilities/get`
const ACCTS = `${BASE}/accounts/get`

beforeEach(async () => {
  db = await createBudgetDb({ seed: false })
  t = new Date('2026-11-27T12:00:00Z')
  queue = []
  fetched = []
  allowed = new Set([LIAB, ACCTS])
  await seed()
})
afterEach(() => vi.restoreAllMocks())

describe('typed mapping', () => {
  it('credit: purchase APR, minimum, dates, last payment, overdue flag', async () => {
    expect(await refresh(json(liabilitiesAnswer()))).toBe(true)
    expect(liab(CARD)).toMatchObject({
      kind: 'credit', apr_bp: 2199, min_due_cents: 3500, next_due_date: '2026-11-28', last_statement_date: '2026-11-01', last_statement_balance_cents: 119050,
      last_payment_cents: 15025, last_payment_date: '2026-11-05', is_overdue: 0, next_monthly_payment_cents: null, fetched_at: '2026-11-27T12:00:00.000Z',
    })
  })

  it('mortgage: rate, monthly payment, escrow, past due, origination, maturity, year-to-date, next due', async () => {
    await refresh(json(liabilitiesAnswer()))
    expect(liab(MTG)).toMatchObject({
      kind: 'mortgage', apr_bp: 388, next_monthly_payment_cents: 184012, escrow_cents: 41050, past_due_cents: 0, origination_date: '2019-04-01',
      origination_cents: 25000000, maturity_date: '2049-04-01', ytd_interest_cents: 610040, ytd_principal_cents: 250075, next_due_date: '2026-12-01',
      min_due_cents: null,
    })
  })

  it('student: rate, minimum, due, payoff, origination, last statement, year-to-date, overdue', async () => {
    await refresh(json(liabilitiesAnswer()))
    expect(liab(STU)).toMatchObject({
      kind: 'student', apr_bp: 450, min_due_cents: 12000, next_due_date: '2026-12-05', expected_payoff_date: '2031-06-30', origination_date: '2018-09-01',
      origination_cents: 1800000, last_statement_date: '2026-11-05', last_statement_balance_cents: 980025, ytd_interest_cents: 30010, ytd_principal_cents: 70020, is_overdue: 1,
    })
  })

  it('a value outside its column limits, or the wrong shape, becomes null instead of failing the batch', () => {
    const l = mapLiability('credit', { aprs: [{ apr_type: 'purchase_apr', apr_percentage: 250 }], minimum_payment_amount: -5, next_payment_due_date: '2026-02-31', is_overdue: 'yes', last_payment_amount: 'x' })
    expect(l).toMatchObject({ apr_bp: null, min_due_cents: null, next_due_date: null, is_overdue: null, last_payment_cents: null })
    expect(mapLiability('mortgage', { interest_rate: 'fixed' }).apr_bp).toBeNull()
    expect(mapLiability('credit', { aprs: [{ apr_type: 'cash_apr', apr_percentage: 25 }] }).apr_bp).toBeNull()
  })

  it('stores none of the fields that must never be kept: a full dump of every table has no account number, address or reference', async () => {
    await refresh(json(liabilitiesAnswer()))
    const dump: string[] = []
    for (const { name } of q<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)) {
      dump.push(JSON.stringify(q(`SELECT * FROM ${name}`)))
    }
    const text = dump.join('\n')
    for (const s of SENTINELS) expect(text).not.toContain(s)
    expect(text).toContain('Pine Ridge') // the dump is real, not empty
  })

  it('logs counts and codes only', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    await refresh(json(liabilitiesAnswer()))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toMatch(/^\{"event":"[a-z_]+"(,"[a-z_]+":\d+)*(,"code":"[a-z_]+")?\}$/)
    for (const s of [...SENTINELS, 'Pine Ridge', ACCESS, 'secret-value']) for (const l of lines) expect(l).not.toContain(s)
  })
})

describe('balances', () => {
  it('writes current, available, limit x100 as sent (credit: positive = owed) and the as-of time; unknown accounts are not inserted', async () => {
    await refresh(json(liabilitiesAnswer()))
    expect(one('SELECT * FROM bank_accounts WHERE id = ?', CARD)).toMatchObject({ balance_cents: 123456, available_cents: 376544, limit_cents: 500000, balance_as_of: '2026-11-27T12:00:00.000Z' })
    expect(one('SELECT * FROM bank_accounts WHERE id = ?', CHK)).toMatchObject({ balance_cents: 250050, available_cents: 240000, limit_cents: null })
    expect(one('SELECT * FROM bank_accounts WHERE id = ?', UNM)).toMatchObject({ balance_cents: 30000 }) // unmapped still gets its balance
    expect(liab(UNM)).toBeUndefined() // but no liabilities row for an account that is not on
    expect(one(`SELECT 1 AS x FROM bank_accounts WHERE plaid_account_id = 'acc-new'`)).toBeUndefined()
    expect(one('SELECT liabilities_at FROM bank_items WHERE id = ?', ITEM)).toMatchObject({ liabilities_at: '2026-11-27T12:00:00.000Z' })
  })

  it('a second refresh updates the same liabilities rows (one per bank account)', async () => {
    await refresh(json(liabilitiesAnswer()))
    await refresh(json(liabilitiesAnswer(900)), '2026-11-28T12:00:00Z')
    expect(q('SELECT bank_account_id FROM bank_liabilities')).toHaveLength(3)
    expect(liab(CARD)).toMatchObject({ fetched_at: '2026-11-28T12:00:00.000Z' })
  })
})

describe('debt_balances', () => {
  it('adds a sync:plaid row for each mapped on debt account with a balance >= 0, carrying the APR', async () => {
    await refresh(json(liabilitiesAnswer()))
    expect(debts('crd')).toEqual([{ account_id: 'crd', as_of: '2026-11-27', balance_cents: 123456, apr_bp: 2199, entered_at: '2026-11-27T12:00:00.000Z', entered_by: 'sync:plaid' }])
    expect(debts('mtg')[0]).toMatchObject({ balance_cents: 18000025, apr_bp: 388 })
    expect(debts('stu')[0]).toMatchObject({ balance_cents: 975010, apr_bp: 450 })
    expect(debts('chk')).toHaveLength(0) // not a debt account
  })

  it('a negative current (an overpaid card) writes no row', async () => {
    await refresh(json(liabilitiesAnswer(-20)))
    expect(debts('crd')).toHaveLength(0)
  })

  it('same month: updates the sync row (date, balance, entered_at); a new month: inserts a second row', async () => {
    await refresh(json(liabilitiesAnswer(1234.56)), '2026-11-10T12:00:00Z')
    await refresh(json(liabilitiesAnswer(1000)), '2026-11-27T12:00:00Z')
    expect(debts('crd')).toEqual([{ account_id: 'crd', as_of: '2026-11-27', balance_cents: 100000, apr_bp: 2199, entered_at: '2026-11-27T12:00:00.000Z', entered_by: 'sync:plaid' }])
    await refresh(json(liabilitiesAnswer(900)), '2026-12-02T12:00:00Z')
    expect(debts('crd').map((r) => [r.as_of, r.balance_cents])).toEqual([['2026-11-27', 100000], ['2026-12-02', 90000]])
    await refresh(json(liabilitiesAnswer(800)), '2026-12-02T18:00:00Z') // same day again: updated in place
    expect(debts('crd').map((r) => [r.as_of, r.balance_cents])).toEqual([['2026-11-27', 100000], ['2026-12-02', 80000]])
  })

  it('a person row for the same day is skipped and left exactly as it was', async () => {
    run(`INSERT INTO debt_balances (account_id, as_of, balance_cents, apr_bp, entered_at, entered_by) VALUES ('crd', '2026-11-27', 50000, 1999, '2026-11-27T01:00:00Z', 'owner@example.com')`)
    await refresh(json(liabilitiesAnswer()))
    expect(debts('crd')).toEqual([{ account_id: 'crd', as_of: '2026-11-27', balance_cents: 50000, apr_bp: 1999, entered_at: '2026-11-27T01:00:00Z', entered_by: 'owner@example.com' }])
    expect(debts('mtg')).toHaveLength(1) // the other accounts still get theirs
  })

  it('a person row on another day of the month is never touched: the sync row is added or updated beside it', async () => {
    const person = { account_id: 'crd', as_of: '2026-11-15', balance_cents: 77777, apr_bp: null, entered_at: '2026-11-15T01:00:00Z', entered_by: 'owner@example.com' }
    run(`INSERT INTO debt_balances (account_id, as_of, balance_cents, apr_bp, entered_at, entered_by) VALUES ('crd', '2026-11-15', 77777, NULL, '2026-11-15T01:00:00Z', 'owner@example.com')`)
    await refresh(json(liabilitiesAnswer(1234.56)), '2026-11-20T12:00:00Z')
    await refresh(json(liabilitiesAnswer(1000)), '2026-11-27T12:00:00Z')
    const rows = debts('crd')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(person)
    expect(rows[1]).toMatchObject({ as_of: '2026-11-27', balance_cents: 100000, entered_by: 'sync:plaid' })
  })

  it('a row of another non-person writer on the same day is left alone too (no primary key clash)', async () => {
    run(`INSERT INTO debt_balances (account_id, as_of, balance_cents, apr_bp, entered_at, entered_by) VALUES ('crd', '2026-11-27', 40000, NULL, '2026-11-27T01:00:00Z', 'tool:build-load-sql')`)
    expect(await refresh(json(liabilitiesAnswer()))).toBe(true)
    expect(debts('crd')).toHaveLength(1)
    expect(debts('crd')[0].entered_by).toBe('tool:build-load-sql')
  })

  it('an update keeps the old APR when this answer carries none', async () => {
    await refresh(json(liabilitiesAnswer()), '2026-11-10T12:00:00Z')
    await refresh(json(accountsOnly()), '2026-11-11T12:00:00Z')
    expect(debts('crd')[0]).toMatchObject({ as_of: '2026-11-11', apr_bp: 2199 })
  })
})

describe('which Plaid call', () => {
  it('a depository-only Item uses /accounts/get and never /liabilities/get', async () => {
    db = await createBudgetDb({ seed: false })
    await seed({ depositoryOnly: true })
    allowed = new Set([ACCTS])
    expect(await refresh(json(accountsOnly()))).toBe(true)
    expect(fetched).toEqual([ACCTS])
    expect(one('SELECT * FROM bank_accounts WHERE id = ?', CHK)).toMatchObject({ balance_cents: 250050 })
    expect(q('SELECT * FROM bank_liabilities')).toHaveLength(0)
  })

  it('PRODUCTS_NOT_SUPPORTED falls back to /accounts/get: balances still update, liabilities rows are not written, code liabilities_unavailable', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    queue.push(() => plaidError('ITEM_ERROR', 'PRODUCTS_NOT_SUPPORTED'))
    expect(await refresh(json(accountsOnly()))).toBe(true)
    expect(fetched).toEqual([LIAB, ACCTS])
    expect(one('SELECT * FROM bank_accounts WHERE id = ?', CARD)).toMatchObject({ balance_cents: 123456 })
    expect(q('SELECT * FROM bank_liabilities')).toHaveLength(0)
    expect(debts('crd')[0]).toMatchObject({ balance_cents: 123456, apr_bp: null })
    expect(lines.some((l) => l.includes('"code":"liabilities_unavailable"'))).toBe(true)
  })

  it('never calls /accounts/balance/get (the stub would throw on it)', async () => {
    await refresh(json(liabilitiesAnswer()))
    expect(fetched.every((u) => !u.includes('balance/get'))).toBe(true)
    expect(allowed.has(`${BASE}/accounts/balance/get`)).toBe(false)
  })

  it('ITEM_LOGIN_REQUIRED sets needs_reconnect with a code and writes nothing else', async () => {
    expect(await refresh(plaidError('ITEM_ERROR', 'ITEM_LOGIN_REQUIRED'))).toBe(false)
    expect(one('SELECT status, last_error, liabilities_at FROM bank_items WHERE id = ?', ITEM)).toEqual({ status: 'needs_reconnect', last_error: 'plaid_item_login_required', liabilities_at: null })
    expect(q('SELECT * FROM bank_liabilities')).toHaveLength(0)
  })

  it('another Plaid error, or an unreadable answer, changes nothing', async () => {
    expect(await refresh(plaidError('API_ERROR', 'INTERNAL_SERVER_ERROR'))).toBe(false)
    expect(await refresh(json({ nonsense: true }))).toBe(false)
    expect(one('SELECT status, liabilities_at FROM bank_items WHERE id = ?', ITEM)).toEqual({ status: 'active', liabilities_at: null })
    expect(one('SELECT balance_cents FROM bank_accounts WHERE id = ?', CARD)).toEqual({ balance_cents: null })
  })

  it('skips an Item in another environment or one that is not live, with no Plaid call', async () => {
    run(`UPDATE bank_items SET environment = 'production'`)
    expect(await refresh(json(liabilitiesAnswer()))).toBe(false)
    run(`UPDATE bank_items SET environment = 'sandbox', status = 'needs_reconnect'`)
    expect(await refresh(json(liabilitiesAnswer()))).toBe(false)
    expect(fetched).toEqual([])
  })
})

describe('the cron step', () => {
  const tick = () => liabilitiesTick(db.d1, env(), client(), KEYS, t)
  const at = () => one<{ liabilities_at: string | null }>('SELECT liabilities_at FROM bank_items WHERE id = ?', ITEM)!.liabilities_at

  it('refreshes a due Item once, then leaves it for about 20 hours', async () => {
    queue.push(() => json(liabilitiesAnswer()))
    expect(await tick()).toBe(1)
    t = new Date(t.getTime() + 19 * HOUR)
    expect(await tick()).toBe(0)
    expect(fetched).toEqual([LIAB])
    queue.push(() => json(liabilitiesAnswer()))
    t = new Date(t.getTime() + 2 * HOUR)
    expect(await tick()).toBe(1)
  })

  it('a failed refresh is tried again in an hour, not at the next tick and not after 20 hours', async () => {
    queue.push(() => plaidError('API_ERROR', 'INTERNAL_SERVER_ERROR'))
    expect(await tick()).toBe(0)
    t = new Date(t.getTime() + 10 * 60_000)
    expect(await tick()).toBe(0)
    expect(fetched).toHaveLength(1)
    queue.push(() => json(liabilitiesAnswer()))
    t = new Date(t.getTime() + 61 * 60_000)
    expect(await tick()).toBe(1)
    expect(fetched).toHaveLength(2)
  })

  it('a webhook (liabilities_at NULL) makes it due again at once', async () => {
    queue.push(() => json(liabilitiesAnswer()))
    await tick()
    run(`UPDATE bank_items SET liabilities_at = NULL`)
    queue.push(() => json(liabilitiesAnswer()))
    expect(await tick()).toBe(1)
  })

  it('picks only live Items with an on account', async () => {
    run(`UPDATE bank_accounts SET sync = 'off'`)
    expect(await tick()).toBe(0)
    run(`UPDATE bank_accounts SET sync = 'on' WHERE id = '${CARD}'`)
    run(`UPDATE bank_items SET status = 'needs_reconnect'`)
    expect(await tick()).toBe(0)
    expect(fetched).toEqual([])
    expect(at()).toBeNull()
  })

  it('the pick, the claim, the account read and the month read use an index or primary key', () => {
    const plan = (sql: string, ...v: unknown[]) => db.explain(sql, v).join('\n')
    const due = plan(LIAB_DUE_SQL, '2026-11-26T00:00:00.000Z')
    expect(due).toMatch(/SEARCH i USING (COVERING )?INDEX idx_bank_items_due/)
    expect(due).toMatch(/SEARCH b (EXISTS )?USING .*idx_bank_acct_item/)
    expect(due).not.toMatch(/SCAN/)
    expect(plan(LIAB_CLAIM_SQL, ITEM, 'a', 'b')).toMatch(/SEARCH bank_items USING .*PRIMARY KEY|SEARCH bank_items USING .*autoindex/)
    const accts = plan(LIAB_ACCOUNTS_SQL, ITEM)
    expect(accts).toMatch(/idx_bank_acct_item/)
    expect(accts).not.toMatch(/SCAN/)
    expect(plan(DEBT_MONTH_SQL, 'crd', '2026-11-01', '2026-11-31')).toMatch(/SEARCH debt_balances USING .*PRIMARY KEY|SEARCH debt_balances USING .*autoindex/)
  })
})
