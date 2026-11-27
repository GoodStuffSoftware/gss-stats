import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLAID_TIMEOUT_MS, PlaidError, PlaidTimeoutError, createPlaidClient } from '../src/plaid'
import type { Env } from '../src/env'

const secret = (v: string) => ({ get: async () => v })
const CLIENT_ID = 'client-id-sandbox-test'
const SECRET = 'secret-value-sandbox-test'
const baseEnv = (over: Partial<Env> = {}): Env => ({
  BUDGET_DB: {} as D1Database,
  PLAID_CLIENT_ID: secret(CLIENT_ID),
  PLAID_SECRET: secret(SECRET),
  PLAID_ENV: 'sandbox',
  ...over,
})
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

let calls: Array<{ url: string; body: Record<string, unknown> }>
let logs: string[]

/** A fetch that only knows the URLs in `known`, and throws on any other (the receipts exchange.test.ts pattern). */
function stub(known: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) })
    if (!Object.prototype.hasOwnProperty.call(known, u)) throw new Error(`unexpected fetch ${u}`)
    return known[u]()
  }) as typeof fetch
}
const now = () => new Date('2026-11-27T12:00:00Z')

beforeEach(() => {
  calls = []
  logs = []
  for (const m of ['info', 'log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('base URL', () => {
  it('uses sandbox.plaid.com for sandbox and production.plaid.com for production', async () => {
    const f = stub({ 'https://sandbox.plaid.com/accounts/get': () => json({ ok: 1 }), 'https://production.plaid.com/accounts/get': () => json({ ok: 2 }) })
    const sb = createPlaidClient({ env: baseEnv(), fetch: f, now })
    const pr = createPlaidClient({ env: baseEnv({ PLAID_ENV: 'production' }), fetch: f, now })
    expect(sb.baseUrl).toBe('https://sandbox.plaid.com')
    expect(pr.baseUrl).toBe('https://production.plaid.com')
    expect(await sb.post('/accounts/get', { access_token: 'tok-1' })).toEqual({ ok: 1 })
    expect(await pr.post('/accounts/get', { access_token: 'tok-1' })).toEqual({ ok: 2 })
    expect(calls.map((c) => c.url)).toEqual(['https://sandbox.plaid.com/accounts/get', 'https://production.plaid.com/accounts/get'])
  })

  it('refuses an unknown PLAID_ENV before any fetch', async () => {
    const c = createPlaidClient({ env: baseEnv({ PLAID_ENV: 'development' }), fetch: stub({}), now })
    await expect(c.post('/accounts/get')).rejects.toMatchObject({ type: 'CONFIG', code: 'PLAID_ENV_INVALID' })
    expect(calls).toEqual([])
  })
})

describe('credentials', () => {
  it('adds client_id and secret to the body, keeping the caller fields', async () => {
    const c = createPlaidClient({ env: baseEnv(), fetch: stub({ 'https://sandbox.plaid.com/item/get': () => json({}) }), now })
    await c.post('/item/get', { access_token: 'tok-1' })
    expect(calls[0].body).toEqual({ access_token: 'tok-1', client_id: CLIENT_ID, secret: SECRET })
  })

  it('refuses to call Plaid with an empty or missing secret', async () => {
    for (const over of [{ PLAID_SECRET: secret('') }, { PLAID_SECRET: undefined }, { PLAID_CLIENT_ID: secret('  ') }]) {
      const c = createPlaidClient({ env: baseEnv(over), fetch: stub({}), now })
      await expect(c.post('/link/token/create')).rejects.toMatchObject({ type: 'CONFIG', code: 'PLAID_SECRETS_MISSING' })
    }
    expect(calls).toEqual([])
  })

  it('never puts credentials or request bodies in a log line, an error message or an error field', async () => {
    const f = stub({ 'https://sandbox.plaid.com/item/get': () => json({ error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: `bad ${SECRET} tok-1` }, 400) })
    const c = createPlaidClient({ env: baseEnv(), fetch: f, now })
    const err = await c.post('/item/get', { access_token: 'tok-1' }).catch((e) => e)
    expect(err).toBeInstanceOf(PlaidError)
    const seen = [logs.join('\n'), String(err.message), JSON.stringify(err), String(err.stack ?? '').split('\n')[0]].join('\n')
    for (const s of [SECRET, CLIENT_ID, 'tok-1']) expect(seen).not.toContain(s)
  })
})

describe('error mapping', () => {
  const failWith = async (body: unknown, status = 400) => {
    const c = createPlaidClient({ env: baseEnv(), fetch: stub({ 'https://sandbox.plaid.com/x': () => json(body, status) }), now })
    return c.post('/x').catch((e) => e as PlaidError)
  }

  it('keeps only error_type and error_code, not the message text', async () => {
    const e = await failWith({ error_type: 'INVALID_INPUT', error_code: 'INVALID_PUBLIC_TOKEN', error_message: 'Pine Ridge Credit Union says no', request_id: 'req-1' })
    expect(e).toBeInstanceOf(PlaidError)
    expect(e).toMatchObject({ type: 'INVALID_INPUT', code: 'INVALID_PUBLIC_TOKEN', status: 400 })
    expect(e.message).toBe('plaid_invalid_input')
    expect(JSON.stringify(e)).not.toContain('Pine Ridge')
    expect(JSON.stringify(e)).not.toContain('req-1')
  })

  it('maps an error body without usable fields to API_ERROR / UNKNOWN', async () => {
    expect(await failWith({ error_type: 'lower case', error_code: 42 }, 500)).toMatchObject({ type: 'API_ERROR', code: 'UNKNOWN', status: 500 })
    expect(await failWith(null, 502)).toMatchObject({ type: 'API_ERROR', code: 'UNKNOWN', status: 502 })
  })

  it('maps a non-JSON error page to API_ERROR / UNKNOWN and a non-JSON 200 to BAD_RESPONSE', async () => {
    const page = (status: number) => createPlaidClient({ env: baseEnv(), fetch: stub({ 'https://sandbox.plaid.com/x': () => new Response('<html>oops</html>', { status }) }), now })
    await expect(page(502).post('/x')).rejects.toMatchObject({ type: 'API_ERROR', code: 'UNKNOWN', status: 502 })
    await expect(page(200).post('/x')).rejects.toMatchObject({ type: 'API_ERROR', code: 'BAD_RESPONSE' })
  })

  it('maps a network failure to NETWORK / FETCH_FAILED without its message', async () => {
    const f = (async () => { throw new Error(`connect failed ${SECRET}`) }) as unknown as typeof fetch
    const e = await createPlaidClient({ env: baseEnv(), fetch: f, now }).post('/x').catch((x) => x)
    expect(e).toMatchObject({ type: 'NETWORK', code: 'FETCH_FAILED' })
    expect(e.message).not.toContain(SECRET)
  })
})

describe('timeout', () => {
  it('aborts after 15 s and throws PlaidTimeoutError', async () => {
    vi.useFakeTimers()
    const f = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    })) as unknown as typeof fetch
    const c = createPlaidClient({ env: baseEnv(), fetch: f, now })
    const p = c.post('/x').catch((e) => e)
    await vi.advanceTimersByTimeAsync(PLAID_TIMEOUT_MS - 1)
    let settled = false
    void p.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toBeInstanceOf(PlaidTimeoutError)
    expect(PLAID_TIMEOUT_MS).toBe(15_000)
  })

  it('clears the timer after a normal answer', async () => {
    vi.useFakeTimers()
    const c = createPlaidClient({ env: baseEnv(), fetch: stub({ 'https://sandbox.plaid.com/x': () => json({ ok: true }) }), now })
    await c.post('/x')
    expect(vi.getTimerCount()).toBe(0)
  })
})
