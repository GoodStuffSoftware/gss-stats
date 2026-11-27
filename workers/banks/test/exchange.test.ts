import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBudgetDb, type FakeBudgetDb } from '../../../functions/_lib/testing/budgetDb'
import { handleExchange } from '../src/exchange'
import { handleLinkToken } from '../src/linkToken'
import { decryptToken } from '../../receipts/src/tokenCrypto'
import type { Env } from '../src/env'
import type { RouteInput } from '../src/index'

const secret = (v: string) => ({ get: async () => v })
const OWNER = 'owner@example.com'
const CLIENT_ID = 'client-id-sandbox-test'
const PLAID_SECRET = 'secret-value-sandbox-test'
const KEY = btoa('0123456789abcdef0123456789abcdef')
const ACCESS = 'access-sandbox-aaaa-bbbb-cccc'
const PUBLIC = 'public-sandbox-dddd-eeee-ffff'
const EX = 'https://sandbox.plaid.com/item/public_token/exchange'
const ACCTS = 'https://sandbox.plaid.com/accounts/get'
const REMOVE = 'https://sandbox.plaid.com/item/remove'
const LINK = 'https://sandbox.plaid.com/link/token/create'
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

let db: FakeBudgetDb
let calls: Array<{ url: string; body: Record<string, any> }>
let logs: string[]
let known: Record<string, () => Response | Promise<Response>>

let acctTag = ''
const goodAccounts = () =>
  json({
    accounts: [
      { account_id: `acc-sandbox-001${acctTag}`, name: 'Pine Ridge Checking 123456789012', mask: '0001', type: 'depository', subtype: 'checking', balances: { current: 1234.56, available: 1200, limit: null } },
      { account_id: `acc-sandbox-002${acctTag}`, name: 'Pine Ridge Card', mask: '12', type: 'credit', subtype: 'credit card', balances: { current: 80.1, available: null, limit: 5000 } },
    ],
  })

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    BUDGET_DB: db.d1,
    PLAID_CLIENT_ID: secret(CLIENT_ID),
    PLAID_SECRET: secret(PLAID_SECRET),
    BANKS_TOKEN_KEY: secret(KEY),
    RECEIPTS_ALLOWED_EMAILS: secret(OWNER),
    PLAID_ENV: 'sandbox',
    PLAID_WEBHOOK_URL: 'https://stats.example.com/hooks/plaid',
    PLAID_REDIRECT_URI: 'https://stats.example.com/banks/return',
    ...over,
  }
}
const stubFetch = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url)
  calls.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) })
  if (!Object.prototype.hasOwnProperty.call(known, u)) throw new Error(`unexpected fetch ${u}`)
  return Promise.resolve(known[u]())
}) as typeof fetch
const deps = { fetch: stubFetch, now: () => new Date('2026-11-27T12:00:00Z') }
const input = (env: Env, body: Record<string, unknown>): RouteInput => ({
  request: new Request('https://banks.internal/x', { method: 'POST' }), env, ctx: {} as ExecutionContext, raw: JSON.stringify(body), body, ownerEmail: OWNER,
})
const exchangeBody = (over: Record<string, unknown> = {}) => ({
  ownerEmail: OWNER, consentVersion: 1, publicToken: PUBLIC, institution: { id: 'ins_sandbox_1', name: 'Pine Ridge Credit Union' },
  accounts: [{ mask: '0001', name: 'Pine Ridge Checking 123456789012' }], ...over,
})
const exchange = (env: Env = makeEnv(), over: Record<string, unknown> = {}) => handleExchange(input(env, exchangeBody(over)), deps)
const slots = () => db.all<Record<string, any>>('SELECT * FROM plaid_slot_log ORDER BY id')
const items = () => db.all<Record<string, any>>('SELECT * FROM bank_items')
const accts = () => db.all<Record<string, any>>('SELECT * FROM bank_accounts ORDER BY plaid_account_id')
const seedSlots = (n: number, status: string, environment = 'production') => {
  for (let i = 0; i < n; i++) {
    runSql(`INSERT INTO plaid_slot_log (environment, status, created_at, created_by) VALUES (?, ?, '2026-01-01T00:00:00Z', 'seed')`, environment, status)
  }
}
const runSql = (sql: string, ...v: unknown[]) => void (db.sqlite.prepare(sql) as any).run(...v)
const prodEnv = () => makeEnv({ PLAID_ENV: 'production' })

function expectNoToken(text: string) {
  for (const s of [ACCESS, PUBLIC, KEY, PLAID_SECRET]) expect(text).not.toContain(s)
}
async function dbText(): Promise<string> {
  return JSON.stringify([items(), accts(), slots()])
}

beforeEach(async () => {
  db = await createBudgetDb({ seed: false })
  acctTag = ''
  calls = []
  logs = []
  known = {
    [EX]: () => json({ access_token: ACCESS, item_id: 'item-sandbox-001', request_id: 'r1' }),
    [ACCTS]: goodAccounts,
    [REMOVE]: () => json({ request_id: 'r2' }),
    [LINK]: () => json({ link_token: 'link-sandbox-tok', expiration: '2026-11-27T16:00:00Z' }),
  }
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')))
})
afterEach(() => vi.restoreAllMocks())

describe('POST /exchange', () => {
  it('stores ciphertext that is not the token and decrypts only with AAD = item id', async () => {
    const res = await exchange()
    const text = await res.clone().text()
    const out = (await res.json()) as { ok: boolean; itemId: string; accounts: number }
    expect(res.status).toBe(200)
    expect(out).toMatchObject({ ok: true, accounts: 2 })
    expect(calls.map((c) => c.url)).toEqual([EX, ACCTS])
    expect(calls[0].body.public_token).toBe(PUBLIC)
    expect(calls[1].body.access_token).toBe(ACCESS)

    const [item] = items()
    expect(item).toMatchObject({ id: out.itemId, owner_email: OWNER, environment: 'sandbox', status: 'active', consent_version: 1, institution_id: 'ins_sandbox_1' })
    expect(item.token_ct).not.toBe(ACCESS)
    const row = { token_ct: item.token_ct, token_iv: item.token_iv, key_id: item.key_id }
    expect((await decryptToken(row, item.id, { current: KEY })).plaintext).toBe(ACCESS)
    await expect(decryptToken(row, 'i0000000000000000', { current: KEY })).rejects.toThrow()

    expectNoToken(await dbText())
    expectNoToken(logs.join('\n'))
    expectNoToken(text)
    expect(slots()).toMatchObject([{ status: 'done', plaid_item_id: 'item-sandbox-001', environment: 'sandbox' }])
  })

  it('masks names, keeps the mask only when it is 4 digits, stores cents', async () => {
    await exchange()
    const [a, b] = accts()
    expect(a).toMatchObject({ plaid_account_id: 'acc-sandbox-001', mask: '0001', type: 'depository', subtype: 'checking', sync: 'unmapped', balance_cents: 123456, available_cents: 120000, limit_cents: null })
    expect(a.name).not.toMatch(/\d{5,}/)
    expect(a.name).toContain('Pine Ridge Checking')
    expect(b).toMatchObject({ plaid_account_id: 'acc-sandbox-002', mask: null, type: 'credit', subtype: 'credit card', limit_cents: 500000 })
  })

  it('409 duplicate_item for a live item with the same institution, mask and name; no exchange call, no slot row', async () => {
    expect((await exchange()).status).toBe(200)
    calls.length = 0
    const res = await exchange()
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('duplicate_item')
    expect(calls).toEqual([])
    expect(slots()).toHaveLength(1)
    // a different institution is not a duplicate
    acctTag = 'b'
    known[EX] = () => json({ access_token: ACCESS, item_id: 'item-sandbox-002' })
    const other = await exchange(makeEnv(), { institution: { id: 'ins_sandbox_2', name: 'Other Bank' } })
    expect(other.status).toBe(200)
  })

  it('a removed item is not a duplicate', async () => {
    await exchange()
    runSql(`UPDATE bank_items SET status='removed', token_ct=NULL, token_iv=NULL, key_id=NULL, sync_cursor=NULL`)
    acctTag = 'b'
    known[EX] = () => json({ access_token: ACCESS, item_id: 'item-sandbox-002' })
    expect((await exchange()).status).toBe(200)
  })

  it('Plaid error: slot row failed, 502 plaid_<type>', async () => {
    known[EX] = () => json({ error_type: 'INVALID_INPUT', error_code: 'INVALID_PUBLIC_TOKEN', error_message: 'secret detail' }, 400)
    const res = await exchange()
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('plaid_invalid_input')
    expect(slots()).toMatchObject([{ status: 'failed' }])
    expect(items()).toHaveLength(0)
    expect(logs.join('\n')).not.toContain('secret detail')
  })

  it('timeout: slot row stays pending, 504', async () => {
    vi.useFakeTimers()
    try {
      known[EX] = () => new Promise<Response>(() => {})
      const stuckFetch = ((url: string | URL | Request, init?: RequestInit) =>
        String(url) === EX
          ? new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))
          : stubFetch(url, init)) as typeof fetch
      const p = handleExchange(input(makeEnv(), exchangeBody()), { ...deps, fetch: stuckFetch })
      await vi.advanceTimersByTimeAsync(20_000)
      const res = await p
      expect(res.status).toBe(504)
      expect(slots()).toMatchObject([{ status: 'pending' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a 2xx exchange answer that is not JSON leaves the slot pending (the Item may exist), nothing stored, no remove', async () => {
    known[EX] = () => new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    const res = await exchange()
    expect(res.status).toBe(502)
    expect(slots()).toMatchObject([{ status: 'pending' }])
    expect(items()).toHaveLength(0)
    expect(calls.map((c) => c.url)).toEqual([EX])
    expectNoToken(logs.join('\n'))
  })

  it('a 2xx exchange answer with a bad item_id or no access_token leaves the slot pending', async () => {
    for (const bad of [{ access_token: ACCESS, item_id: 'bad id with spaces' }, { access_token: ACCESS }, { item_id: 'item-sandbox-001' }]) {
      known[EX] = () => json(bad)
      const res = await exchange()
      expect(res.status).toBe(502)
    }
    expect(slots().map((s) => s.status)).toEqual(['pending', 'pending', 'pending'])
    expect(items()).toHaveLength(0)
  })

  it('a non-JSON error answer or a 5xx leaves the slot pending; only a 4xx JSON refusal closes it as failed', async () => {
    known[EX] = () => new Response('bad gateway', { status: 502 })
    expect((await exchange()).status).toBe(502)
    known[EX] = () => json({ error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' }, 500)
    expect((await exchange()).status).toBe(502)
    known[EX] = () => json({ error_type: 'INVALID_INPUT', error_code: 'INVALID_PUBLIC_TOKEN' }, 400)
    expect((await exchange()).status).toBe(502)
    expect(slots().map((s) => s.status)).toEqual(['pending', 'pending', 'failed'])
  })

  it('a failed /accounts/get after a good exchange keeps the Item (encrypted token, new_accounts = 1), no remove, slot done', async () => {
    known[ACCTS] = () => json({ error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', error_message: 'secret detail' }, 500)
    const res = await exchange()
    const out = (await res.json()) as { ok: boolean; itemId: string; accounts: number }
    expect(res.status).toBe(200)
    expect(out).toMatchObject({ ok: true, accounts: 0 })
    expect(calls.map((c) => c.url)).toEqual([EX, ACCTS])
    const [item] = items()
    expect(item).toMatchObject({ id: out.itemId, status: 'active', new_accounts: 1 })
    const row = { token_ct: item.token_ct, token_iv: item.token_iv, key_id: item.key_id }
    expect((await decryptToken(row, item.id, { current: KEY })).plaintext).toBe(ACCESS)
    expect(accts()).toHaveLength(0)
    expect(slots()).toMatchObject([{ status: 'done', plaid_item_id: 'item-sandbox-001' }])
    expect(logs.join('\n')).not.toContain('secret detail')
    expectNoToken(logs.join('\n'))
  })

  it('a good /accounts/get stores the Item with new_accounts = 0', async () => {
    await exchange()
    expect(items()[0].new_accounts).toBe(0)
  })

  it('batch fails twice: /item/remove is called, 500 store_failed, slot stays counted, nothing stored', async () => {
    const real = db.d1.batch.bind(db.d1)
    let n = 0
    vi.spyOn(db.d1, 'batch').mockImplementation(async (s: any) => {
      n++
      if (n <= 2) throw new Error('D1_ERROR: simulated')
      return real(s)
    })
    const res = await exchange()
    expect(res.status).toBe(500)
    expect(((await res.json()) as { code: string }).code).toBe('store_failed')
    expect(calls.map((c) => c.url)).toEqual([EX, ACCTS, REMOVE])
    expect(calls[2].body).toMatchObject({ access_token: ACCESS, reason_code: 'OTHER' })
    expect(items()).toHaveLength(0)
    expect(slots()).toHaveLength(1)
    expect(slots()[0].status).not.toBe('failed')
    expectNoToken(logs.join('\n'))
  })

  it('batch fails once then succeeds: stored, no remove', async () => {
    const real = db.d1.batch.bind(db.d1)
    let n = 0
    vi.spyOn(db.d1, 'batch').mockImplementation(async (s: any) => {
      if (++n === 1) throw new Error('D1_ERROR: simulated')
      return real(s)
    })
    expect((await exchange()).status).toBe(200)
    expect(items()).toHaveLength(1)
    expect(calls.map((c) => c.url)).not.toContain(REMOVE)
  })

  it('refuses a bad body and a missing key before any Plaid call', async () => {
    expect((await exchange(makeEnv(), { publicToken: 7 })).status).toBe(400)
    expect((await exchange(makeEnv(), { accounts: 'x' })).status).toBe(400)
    expect((await exchange(makeEnv(), { consentVersion: 0 })).status).toBe(400)
    expect((await exchange(makeEnv({ BANKS_TOKEN_KEY: secret('') }))).status).toBe(503)
    expect(calls).toEqual([])
    expect(slots()).toHaveLength(0)
  })

  it('refuses at 10 used in production, with no exchange call', async () => {
    seedSlots(10, 'done')
    const res = await handleExchange(input(prodEnv(), exchangeBody()), { ...deps, fetch: stubFetch })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('slots_full')
    expect(calls).toEqual([])
  })
})

describe('slot guard', () => {
  const reserve = (env: Env) => import('../src/slots').then((m) => m.reserveSlot(db.d1, env, OWNER, 'ins_x'))

  it('pending, done and prior count; failed and sandbox do not', async () => {
    const { slotsUsed } = await import('../src/slots')
    seedSlots(3, 'pending')
    seedSlots(3, 'done')
    seedSlots(2, 'prior')
    seedSlots(5, 'failed')
    seedSlots(4, 'done', 'sandbox')
    expect(await slotsUsed(db.d1)).toBe(8)
  })

  it('refuses the 11th: 9 used reserves one, then 10 used refuses', async () => {
    seedSlots(9, 'done')
    expect(await reserve(prodEnv())).not.toBeNull()
    expect(await reserve(prodEnv())).toBeNull()
  })

  it('failed slots free the count; sandbox reserves without a limit', async () => {
    seedSlots(10, 'failed')
    expect(await reserve(prodEnv())).not.toBeNull()
    seedSlots(12, 'done', 'sandbox')
    expect(await reserve(makeEnv())).not.toBeNull()
  })

  it('two reservations at 9 used: exactly one wins', async () => {
    seedSlots(9, 'done')
    const [a, b] = await Promise.all([reserve(prodEnv()), reserve(prodEnv())])
    expect([a, b].filter((x) => x !== null)).toHaveLength(1)
    expect(slots().filter((r) => r.environment === 'production')).toHaveLength(10)
  })

  it('finishSlot moves pending to done or failed once; the log cannot be deleted', async () => {
    const { finishSlot } = await import('../src/slots')
    const id = (await reserve(makeEnv()))!
    await finishSlot(db.d1, id, 'done', 'item-sandbox-009')
    await expect(finishSlot(db.d1, id, 'failed')).rejects.toThrow()
    await expect(db.d1.prepare('DELETE FROM plaid_slot_log').run()).rejects.toThrow()
  })
})

describe('POST /link-token', () => {
  const link = (env: Env, body: Record<string, unknown> = {}) => handleLinkToken(input(env, { ownerEmail: OWNER, consentVersion: 1, ...body }), deps)
  const linkCall = () => calls.find((c) => c.url === LINK)!.body

  it('new link: products, optional Liabilities, hashed client_user_id, no update', async () => {
    const res = await link(makeEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, linkToken: 'link-sandbox-tok', expiration: '2026-11-27T16:00:00Z' })
    const b = linkCall()
    expect(b).toMatchObject({
      client_name: 'GSS Budget', products: ['transactions'], required_if_supported_products: ['liabilities'],
      transactions: { days_requested: 730 }, country_codes: ['US'], language: 'en',
      webhook: 'https://stats.example.com/hooks/plaid', redirect_uri: 'https://stats.example.com/banks/return',
    })
    expect(b.user.client_user_id).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(b)).not.toContain(OWNER)
    expect('update' in b).toBe(false)
    expect('access_token' in b).toBe(false)
  })

  it('new link with accountSelection still never sends update', async () => {
    await link(makeEnv(), { accountSelection: true })
    expect('update' in linkCall()).toBe(false)
  })

  it('production at 10 used: 409 slots_full, no Plaid call', async () => {
    seedSlots(10, 'done')
    const res = await link(prodEnv())
    expect(res.status).toBe(409)
    expect(calls).toEqual([])
  })

  it('refuses a missing consentVersion and an empty PLAID_SECRET', async () => {
    expect((await handleLinkToken(input(makeEnv(), { ownerEmail: OWNER }), deps)).status).toBe(400)
    const res = await link(makeEnv({ PLAID_SECRET: secret('') }))
    expect(res.status).toBe(503)
    expect(calls).toEqual([])
  })

  describe('update mode', () => {
    let itemId: string
    beforeEach(async () => {
      itemId = ((await (await exchange()).json()) as { itemId: string }).itemId
      calls.length = 0
    })

    it('a refused update-mode token (bad link, not our setup) keeps plaid_<type>, never plaid_setup', async () => {
      known[LINK] = () => json({ error_type: 'INVALID_INPUT', error_code: 'INVALID_ACCESS_TOKEN', error_message: 'secret-looking text' }, 400)
      const res = await link(makeEnv(), { itemId })
      expect(res.status).toBe(502)
      expect(((await res.json()) as { code: string }).code).toBe('plaid_invalid_input')
      expect(logs.join('\n')).not.toContain('secret-looking')
    })

    it('sends the decrypted access token, no products, and no update by default', async () => {
      const res = await link(makeEnv(), { itemId })
      expect(res.status).toBe(200)
      const b = linkCall()
      expect(b.access_token).toBe(ACCESS)
      expect('products' in b).toBe(false)
      expect('required_if_supported_products' in b).toBe(false)
      expect('transactions' in b).toBe(false)
      expect('update' in b).toBe(false)
    })

    it('accountSelection adds update.account_selection_enabled', async () => {
      await link(makeEnv(), { itemId, accountSelection: true })
      expect(linkCall().update).toEqual({ account_selection_enabled: true })
    })

    it('needs the owner: another email gets 404 and no Plaid call', async () => {
      const res = await handleLinkToken({ ...input(makeEnv(), { consentVersion: 1, itemId }), ownerEmail: 'other@example.com' }, deps)
      expect(res.status).toBe(404)
      expect(calls).toEqual([])
    })

    it('refuses a removed item, an unknown id and a bad id', async () => {
      expect((await link(makeEnv(), { itemId: 'i0000000000000000' })).status).toBe(404)
      expect((await link(makeEnv(), { itemId: 'nope' })).status).toBe(400)
      runSql(`UPDATE bank_items SET status='removed', token_ct=NULL, token_iv=NULL, key_id=NULL, sync_cursor=NULL`)
      expect((await link(makeEnv(), { itemId })).status).toBe(409)
      expect(calls).toEqual([])
    })

    it('the wrong key answers 500 decrypt_failed without leaking', async () => {
      const res = await link(makeEnv({ BANKS_TOKEN_KEY: secret(btoa('ffffffffffffffffffffffffffffffff')) }), { itemId })
      expect(res.status).toBe(500)
      expect(calls).toEqual([])
      expectNoToken(logs.join('\n') + (await res.text()))
    })
  })

  it('a Plaid error maps to 502 plaid_<type>', async () => {
    known[LINK] = () => json({ error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'RATE_LIMIT' }, 429)
    const res = await link(makeEnv())
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('plaid_rate_limit_exceeded')
  })

  it('a refused link token request (our setup, such as an unregistered redirect) maps to 502 plaid_setup, logging only the code', async () => {
    known[LINK] = () => json({ error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD', error_message: 'secret-looking text' }, 400)
    const res = await link(makeEnv())
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('plaid_setup')
    expect(logs.join('\n')).not.toContain('secret-looking')
  })

  it('a bank-side error on the link token request keeps plaid_<type>', async () => {
    known[LINK] = () => json({ error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' }, 400)
    const res = await link(makeEnv())
    expect(((await res.json()) as { code: string }).code).toBe('plaid_item_error')
  })
})
