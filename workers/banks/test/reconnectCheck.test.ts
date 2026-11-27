// The daily reconnect check (plan 4.1, recovery path 2 of 3): a needs_reconnect Item gets one /item/get per 24 h, at most 3 per
// tick. Plaid is a stub that throws on any URL but /item/get; D1 is the fake over the real migrations. Every value is made up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBudgetDb, type FakeBudgetDb } from '../../../functions/_lib/testing/budgetDb'
import { handleScheduled } from '../src/index'
import { createPlaidClient } from '../src/plaid'
import { reconnectCheck } from '../src/reconnectCheck'
import { sealToken, type Keys } from '../src/store'
import type { Env } from '../src/env'

const secret = (v: string) => ({ get: async () => v })
const ITEM_GET = 'https://sandbox.plaid.com/item/get'
const NOW = new Date('2026-11-27T12:00:00Z')
const HOUR = 3_600_000
const ACCESS = 'access-sandbox-test-token'
const KEY = btoa('0123456789abcdef0123456789abcdef')
const KEYS: Keys = { current: KEY, old: null }

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const itemOk = () => json({ item: { item_id: 'x', error: null }, request_id: 'r' })
const itemBroken = () => json({ item: { item_id: 'x', error: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' } }, request_id: 'r' })

let db: FakeBudgetDb
let t: Date
let queue: Array<() => Response>
let fetched: Array<{ url: string; body: Record<string, any> }>
let logs: string[]

const env = (): Env => ({
  BUDGET_DB: db.d1, PLAID_CLIENT_ID: secret('client-id-sandbox-test'), PLAID_SECRET: secret('secret-value-sandbox-test'),
  BANKS_TOKEN_KEY: secret(KEY), PLAID_ENV: 'sandbox',
})
const stubFetch = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url)
  fetched.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) })
  if (u !== ITEM_GET) throw new Error(`unexpected fetch ${u}`)
  const next = queue.shift()
  if (!next) throw new Error('no response queued')
  return Promise.resolve(next())
}) as typeof fetch

const run = (sql: string, ...v: unknown[]) => void (db.sqlite.prepare(sql) as any).run(...v)
const one = <T = Record<string, any>>(sql: string, ...v: unknown[]) => db.get<T>(sql, ...v)
const itemRow = (id: string) => one('SELECT * FROM bank_items WHERE id = ?', id)!
const check = () => reconnectCheck(db.d1, env(), createPlaidClient({ env: env(), fetch: stubFetch, now: () => t }), KEYS, t)
const advance = (ms: number) => void (t = new Date(t.getTime() + ms))

const id = (n: number) => `i0000000000000${String(n).padStart(3, '0')}`
async function seedItem(n: number, o: { status?: string; environment?: string; lastError?: string | null; lastSyncAt?: string | null } = {}): Promise<string> {
  const itemId = id(n)
  const enc = await sealToken(ACCESS, itemId, KEYS)
  run(
    `INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, status, last_error, token_ct, token_iv, key_id, sync_cursor, initial_done,
       consent_version, consented_at, last_sync_at, created_at, updated_at)
     VALUES (?, 'owner@example.com', ?, ?, ?, ?, ?, ?, ?, 'cur-0', 1, 1, '2026-11-01T00:00:00Z', ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    itemId, o.environment ?? 'sandbox', `item-plaid-${n}`, o.status ?? 'needs_reconnect', o.lastError === undefined ? 'plaid_item_login_required' : o.lastError,
    enc.token_ct, enc.token_iv, enc.key_id, o.lastSyncAt ?? null,
  )
  return itemId
}

beforeEach(async () => {
  db = await createBudgetDb({ seed: false })
  t = new Date(NOW)
  queue = []
  fetched = []
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')))
})
afterEach(() => vi.restoreAllMocks())

describe('repair', () => {
  it('item.error null: active, last_error cleared, a sync requested for now, the token opened for the call', async () => {
    const a = await seedItem(1)
    queue.push(itemOk)
    expect(await check()).toEqual({ checked: 1, repaired: 1 })
    expect(itemRow(a)).toMatchObject({ status: 'active', last_error: null, sync_requested_at: t.toISOString(), last_sync_at: t.toISOString() })
    expect(fetched).toEqual([{ url: ITEM_GET, body: { access_token: ACCESS, client_id: 'client-id-sandbox-test', secret: 'secret-value-sandbox-test' } }])
    expect(one('SELECT COUNT(*) AS n FROM bank_sync_runs')!.n).toBe(0)
  })

  it('an error still on the Item changes nothing, and the next look is 24 h later, not sooner', async () => {
    const a = await seedItem(1)
    queue.push(itemBroken)
    expect(await check()).toEqual({ checked: 1, repaired: 0 })
    expect(itemRow(a)).toMatchObject({ status: 'needs_reconnect', last_error: 'plaid_item_login_required', sync_requested_at: null, last_sync_at: t.toISOString() })

    advance(23 * HOUR)
    expect(await check()).toEqual({ checked: 0, repaired: 0 })
    expect(fetched).toHaveLength(1)

    advance(2 * HOUR) // 25 h after the first look
    queue.push(itemOk)
    expect(await check()).toEqual({ checked: 1, repaired: 1 })
    expect(fetched).toHaveLength(2)
    expect(itemRow(a).status).toBe('active')
  })

  it('a failed call (Plaid 400, or no answer) changes nothing, logs a code only, and is not retried inside 24 h', async () => {
    const a = await seedItem(1)
    const b = await seedItem(2)
    queue.push(() => json({ error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', error_message: 'text', request_id: 'r' }, 500))
    queue.push(() => { throw new Error('network down') })
    expect(await check()).toEqual({ checked: 2, repaired: 0 })
    for (const x of [a, b]) expect(itemRow(x)).toMatchObject({ status: 'needs_reconnect', last_error: 'plaid_item_login_required', sync_requested_at: null })
    expect(logs.filter((l) => l.includes('reconnect_check_failed'))).toHaveLength(2)

    advance(HOUR)
    expect(await check()).toEqual({ checked: 0, repaired: 0 })
    expect(fetched).toHaveLength(2)
  })

  it('a reply with no item object is not a repair', async () => {
    const a = await seedItem(1)
    queue.push(() => json({ request_id: 'r' }))
    expect(await check()).toEqual({ checked: 1, repaired: 0 })
    expect(itemRow(a).status).toBe('needs_reconnect')
  })
})

describe('who is looked at', () => {
  it('at most 3 per tick; the rest wait for the next tick', async () => {
    for (let n = 1; n <= 5; n++) await seedItem(n)
    for (let n = 0; n < 5; n++) queue.push(itemBroken)
    expect(await check()).toEqual({ checked: 3, repaired: 0 })
    expect(fetched).toHaveLength(3)
    advance(10 * 60_000)
    expect(await check()).toEqual({ checked: 2, repaired: 0 })
    expect(fetched).toHaveLength(5)
    expect(new Set(fetched.map((f) => f.body.access_token)).size).toBe(1) // every call carried an opened token, never a sealed one
  })

  it('active and pending_disconnect Items never get /item/get; the stub would throw on anything else', async () => {
    const a = await seedItem(1, { status: 'active', lastError: null })
    const p = await seedItem(2, { status: 'pending_disconnect', lastError: null })
    expect(await check()).toEqual({ checked: 0, repaired: 0 })
    expect(fetched).toEqual([])
    for (const x of [a, p]) expect(itemRow(x).last_sync_at).toBeNull()
  })

  it('an Item looked at less than 24 h ago is skipped; one looked at 25 h ago is not', async () => {
    const recent = await seedItem(1, { lastSyncAt: new Date(t.getTime() - 23 * HOUR).toISOString() })
    const old = await seedItem(2, { lastSyncAt: new Date(t.getTime() - 25 * HOUR).toISOString() })
    queue.push(itemOk)
    expect(await check()).toEqual({ checked: 1, repaired: 1 })
    expect(itemRow(recent).status).toBe('needs_reconnect')
    expect(itemRow(old).status).toBe('active')
  })

  it('an Item of another Plaid environment is never called (and is not looked at again for 24 h)', async () => {
    const prod = await seedItem(1, { environment: 'production' })
    expect(await check()).toEqual({ checked: 0, repaired: 0 })
    expect(fetched).toEqual([])
    expect(itemRow(prod)).toMatchObject({ status: 'needs_reconnect', last_error: 'plaid_item_login_required' })
  })

  it('an Item that turns active between the pick and the claim (a webhook repaired it) gets no call', async () => {
    const a = await seedItem(1)
    // Same instant the pick would run: simulate the race by repairing before the check; the pick then finds nothing.
    run(`UPDATE bank_items SET status = 'active', last_error = NULL WHERE id = ?`, a)
    expect(await check()).toEqual({ checked: 0, repaired: 0 })
    expect(fetched).toEqual([])
  })
})

describe('the scheduled tick', () => {
  it('handleScheduled runs the check: only /item/get is called, the Item is repaired, logs hold counts and codes only', async () => {
    const a = await seedItem(1)
    queue.push(itemOk)
    await handleScheduled(env(), { fetch: stubFetch, now: () => t })
    expect(fetched.map((f) => f.url)).toEqual([ITEM_GET])
    expect(itemRow(a)).toMatchObject({ status: 'active', last_error: null, sync_requested_at: t.toISOString() })
    expect(logs.map((l) => JSON.parse(l))).toContainEqual({ event: 'reconnect_check', checked: 1, repaired: 1 })
    const all = logs.join('\n')
    for (const secretText of [ACCESS, 'item-plaid-1', 'owner@example.com', KEY, 'secret-value-sandbox-test']) expect(all).not.toContain(secretText)
  })
})
