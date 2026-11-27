// POST /accounts-refresh (plan 3.3 and 4.5): add the accounts the owner shared through update-mode Link as unmapped rows. Plaid is a stub
// that throws on any URL it was not told to expect; D1 is the fake over the real migrations. Every value is made up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBudgetDb, type FakeBudgetDb } from '../../../functions/_lib/testing/budgetDb'
import { handleAccountsRefresh } from '../src/accounts'
import { sealToken, type Keys } from '../src/store'
import type { Env } from '../src/env'
import type { RouteInput } from '../src/index'

const secret = (v: string) => ({ get: async () => v })
const BASE = 'https://sandbox.plaid.com'
const ACCTS = `${BASE}/accounts/get`
const ACCESS = 'access-sandbox-test-token'
const KEY = btoa('0123456789abcdef0123456789abcdef')
const KEYS: Keys = { current: KEY, old: null }
const ITEM = 'i000000000000a001'
const OWNER = 'owner@example.com'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const plaidError = (type: string, code: string) => json({ error_type: type, error_code: code, error_message: 'text that must never be kept', request_id: 'r' }, 400)

let db: FakeBudgetDb
let queue: Array<() => Response>
let fetched: Array<{ url: string; body: Record<string, unknown> }>
let allowed: Set<string>

const makeEnv = (over: Partial<Env> = {}): Env => ({
  BUDGET_DB: db.d1, PLAID_CLIENT_ID: secret('client-id-sandbox-test'), PLAID_SECRET: secret('secret-value-sandbox-test'),
  BANKS_TOKEN_KEY: secret(KEY), PLAID_ENV: 'sandbox', ...over,
})
const stubFetch = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url)
  fetched.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) })
  if (!allowed.has(u)) throw new Error(`unexpected fetch ${u}`)
  const next = queue.shift()
  if (!next) throw new Error('no response queued')
  return Promise.resolve(next())
}) as typeof fetch

const refresh = (body: Record<string, unknown> = { itemId: ITEM }, ownerEmail = OWNER, env: Env = makeEnv()) => {
  const raw = JSON.stringify(body)
  const input: RouteInput = { request: new Request('https://banks.test/accounts-refresh', { method: 'POST', body: raw }), env, ctx: {} as ExecutionContext, raw, body, ownerEmail }
  return handleAccountsRefresh(input, { fetch: stubFetch, now: () => new Date('2026-11-27T12:00:00Z') })
}

const run = (sql: string, ...v: unknown[]) => void (db.sqlite.prepare(sql) as any).run(...v)
const q = <T = Record<string, any>>(sql: string, ...v: unknown[]) => db.all<T>(sql, ...v)
const one = <T = Record<string, any>>(sql: string, ...v: unknown[]) => db.get<T>(sql, ...v)
const item = () => one('SELECT * FROM bank_items WHERE id = ?', ITEM)!
const stored = () => q('SELECT * FROM bank_accounts ORDER BY id')

async function seed(o: { status?: string; newAccounts?: number } = {}): Promise<void> {
  const enc = await sealToken(ACCESS, ITEM, KEYS)
  run(`INSERT INTO accounts (id, label, kind, is_debt) VALUES ('chk', 'Everyday Checking', 'checking', 0)`)
  run(
    `INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, status, token_ct, token_iv, key_id, sync_cursor, initial_done, new_accounts,
       consent_version, consented_at, created_at, updated_at)
     VALUES (?, ?, 'sandbox', 'item-plaid-001', ?, ?, ?, ?, 'cur-0', 1, ?, 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    ITEM, OWNER, o.status ?? 'active', enc.token_ct, enc.token_iv, enc.key_id, o.newAccounts ?? 1,
  )
  run(`INSERT INTO bank_accounts (id, item_id, plaid_account_id, name, mask, type, subtype, account_id, sync, balance_cents, created_at, updated_at)
       VALUES ('b000000000000c001', ?, 'acc-chk', 'Everyday Checking', '0001', 'depository', 'checking', 'chk', 'on', 250050, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`, ITEM)
  // A stored account the owner stopped sharing: Plaid no longer lists it, the row must stay.
  run(`INSERT INTO bank_accounts (id, item_id, plaid_account_id, name, type, sync, created_at, updated_at)
       VALUES ('b000000000000c002', ?, 'acc-gone', 'Old Savings', 'depository', 'off', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`, ITEM)
}

const bal = (current: number | null, available: number | null = null, limit: number | null = null) => ({ current, available, limit, iso_currency_code: 'USD' })
const answer = () => ({
  accounts: [
    // already stored: Plaid now says different things about it; the stored row must not change
    { account_id: 'acc-chk', name: 'Renamed By Bank', mask: '9999', type: 'depository', subtype: 'checking', balances: bal(1, 1) },
    { account_id: 'acc-new1', name: 'Pine Ridge Savings 12345678', mask: '0042', type: 'depository', subtype: 'savings', balances: bal(900.5, 900.5) },
    { account_id: 'acc-new2', name: 'Pine Ridge Card', mask: '123456', type: 'credit', subtype: 'credit card', balances: bal(120.25, 4879.75, 5000) },
    { account_id: 'acc-new1', name: 'Duplicate In The Same Answer', mask: '0042', type: 'depository', subtype: 'savings', balances: bal(1) },
  ],
  request_id: 'r',
})

beforeEach(async () => {
  db = await createBudgetDb({ seed: false })
  queue = []
  fetched = []
  allowed = new Set([ACCTS])
  await seed()
})
afterEach(() => vi.restoreAllMocks())

describe('accounts refresh: the good path', () => {
  it('inserts only the plaid ids not stored yet, as unmapped rows, and answers { ok, added }', async () => {
    queue.push(() => json(answer()))
    const res = await refresh()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, added: 2 })
    expect(fetched).toHaveLength(1)
    expect(fetched[0]!.url).toBe(ACCTS)
    expect(fetched[0]!.body).toMatchObject({ access_token: ACCESS })
    const rows = q('SELECT * FROM bank_accounts WHERE plaid_account_id LIKE ? ORDER BY plaid_account_id', 'acc-new%')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      plaid_account_id: 'acc-new1', item_id: ITEM, sync: 'unmapped', account_id: null, mask: '0042', type: 'depository', subtype: 'savings',
      balance_cents: 90050, available_cents: 90050, limit_cents: null, created_at: '2026-11-27T12:00:00.000Z',
    })
    expect(rows[1]).toMatchObject({ plaid_account_id: 'acc-new2', sync: 'unmapped', mask: null, type: 'credit', balance_cents: 12025, available_cents: 487975, limit_cents: 500000 })
  })

  it('masks digit runs in the name (no look-alike of an account number is stored)', async () => {
    queue.push(() => json(answer()))
    await refresh()
    const names = q<{ name: string }>('SELECT name FROM bank_accounts WHERE plaid_account_id LIKE ?', 'acc-new%').map((r) => r.name)
    for (const n of names) expect(n).not.toMatch(/\d{5,}/)
  })

  it('leaves every stored row exactly as it was, including the one Plaid no longer lists', async () => {
    const before = q('SELECT * FROM bank_accounts WHERE plaid_account_id IN (?, ?) ORDER BY id', 'acc-chk', 'acc-gone')
    queue.push(() => json(answer()))
    await refresh()
    expect(q('SELECT * FROM bank_accounts WHERE plaid_account_id IN (?, ?) ORDER BY id', 'acc-chk', 'acc-gone')).toEqual(before)
    expect(stored()).toHaveLength(4)
  })

  it('clears new_accounts in the same batch as the inserts', async () => {
    queue.push(() => json(answer()))
    await refresh()
    expect(item().new_accounts).toBe(0)
    expect(item().updated_at).toBe('2026-11-27T12:00:00.000Z')
  })

  it('nothing new: added 0, the flag still clears, no row changes', async () => {
    queue.push(() => json({ accounts: answer().accounts.slice(0, 1), request_id: 'r' }))
    const res = await refresh()
    expect(await res.json()).toEqual({ ok: true, added: 0 })
    expect(item().new_accounts).toBe(0)
    expect(stored()).toHaveLength(2)
  })

  it('a second run right after adds nothing and does not duplicate', async () => {
    queue.push(() => json(answer()))
    await refresh()
    queue.push(() => json(answer()))
    const res = await refresh()
    expect(await res.json()).toEqual({ ok: true, added: 0 })
    expect(stored()).toHaveLength(4)
  })

  it('an answer entry with a bad account id is skipped, not stored', async () => {
    queue.push(() => json({ accounts: [{ account_id: 'bad id with spaces', name: 'X', type: 'depository', balances: bal(1) }, { account_id: 7, name: 'Y' }], request_id: 'r' }))
    const res = await refresh()
    expect(await res.json()).toEqual({ ok: true, added: 0 })
    expect(stored()).toHaveLength(2)
  })

  it('logs counts and codes only', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    queue.push(() => json(answer()))
    await refresh()
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toMatch(/^\{"event":"[a-z_]+"(,"[a-z_]+":\d+)*(,"code":"[a-z_]+")?\}$/)
    expect(lines.join('\n')).not.toContain(ACCESS)
  })
})

describe('accounts refresh: guards', () => {
  it('another owner gets 403 not_owner and no Plaid call', async () => {
    const res = await refresh({ itemId: ITEM }, 'other@example.com')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ ok: false, code: 'not_owner' })
    expect(fetched).toEqual([])
    expect(item().new_accounts).toBe(1)
  })

  it('a bad or unknown item id: 400 and 404, no Plaid call', async () => {
    expect((await refresh({ itemId: 'nope' })).status).toBe(400)
    expect((await refresh({})).status).toBe(400)
    expect((await refresh({ itemId: 'i0000000000000fff' })).status).toBe(404)
    expect(fetched).toEqual([])
  })

  it('an Item that is not live answers 409 item_not_active with no Plaid call', async () => {
    for (const status of ['removed', 'revoked']) {
      db = await createBudgetDb({ seed: false })
      await seed()
      run(
        `UPDATE bank_items SET status = ?, token_ct = NULL, token_iv = NULL, key_id = NULL, sync_cursor = NULL WHERE id = ?`, status, ITEM,
      )
      const res = await refresh()
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, code: 'item_not_active' })
    }
    expect(fetched).toEqual([])
  })

  it('an Item from the other Plaid environment answers 409 item_not_active, no Plaid call', async () => {
    expect((await refresh(undefined, OWNER, makeEnv({ PLAID_ENV: 'production' }))).status).toBe(409)
    expect(fetched).toEqual([])
  })

  it('missing token key answers 503 and calls nothing', async () => {
    const res = await refresh(undefined, OWNER, makeEnv({ BANKS_TOKEN_KEY: secret('') }))
    expect(res.status).toBe(503)
    expect(fetched).toEqual([])
    expect(item().new_accounts).toBe(1)
  })
})

describe('accounts refresh: Plaid errors', () => {
  it('ITEM_LOGIN_REQUIRED sets needs_reconnect with a code, answers 409 needs_reconnect, keeps the flag and adds nothing', async () => {
    queue.push(() => plaidError('ITEM_ERROR', 'ITEM_LOGIN_REQUIRED'))
    const res = await refresh()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, code: 'needs_reconnect' })
    expect(item()).toMatchObject({ status: 'needs_reconnect', new_accounts: 1 })
    expect(item().last_error).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(item().last_error).not.toContain('text that must never be kept')
    expect(item().token_ct).not.toBeNull()
    expect(stored()).toHaveLength(2)
  })

  it('any other Plaid error answers 502, keeps the flag, adds nothing, leaves the status alone', async () => {
    queue.push(() => plaidError('API_ERROR', 'INTERNAL_SERVER_ERROR'))
    const res = await refresh()
    expect(res.status).toBe(502)
    expect(item()).toMatchObject({ status: 'active', new_accounts: 1 })
    expect(stored()).toHaveLength(2)
  })

  it('an answer without an accounts list is a 502 and changes nothing', async () => {
    queue.push(() => json({ request_id: 'r' }))
    const res = await refresh()
    expect(res.status).toBe(502)
    expect(item().new_accounts).toBe(1)
    expect(stored()).toHaveLength(2)
  })

  it('the stub throws on any URL other than /accounts/get', async () => {
    allowed = new Set()
    queue.push(() => json(answer()))
    const res = await refresh()
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(fetched.map((f) => f.url)).toEqual([ACCTS])
    expect(stored()).toHaveLength(2)
  })
})
