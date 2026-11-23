// GET and PUT /api/budget/prefs: the access layers, a round trip, the hashed key, schema rejection and the size cap.
// Emails are made up (example.com); KV is an in-memory stand-in.
import { describe, expect, it } from 'vitest'
import { authGate, createSessionCookie, readAuthConfig, type ViewerStore } from '../../_lib/auth'
import type { BudgetData, BudgetEnv } from '../../_lib/budgetAccess'
import { defaultTxnViewPrefs } from '../../../src/lib/budget/txnView'
import { onRequest as middleware } from './_middleware'
import { onRequest as prefs, prefsKey, PREFS_MAX_BYTES } from './prefs'

const ORIGIN = 'https://stats.goodstuff.software'
const LISTED = 'listed@example.com'
const OTHER = 'other@example.com'
const UNLISTED = 'unlisted@example.com'

function kv() {
  const m = new Map<string, string>()
  const store = { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) }
  return { m, store: store as unknown as KVNamespace & ViewerStore }
}

function env(store: unknown): BudgetEnv {
  return {
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'c'.repeat(48),
    ALLOWED_EMAILS: `${LISTED},${OTHER},${UNLISTED}`,
    BUDGET_ALLOWED_EMAILS: `${LISTED},${OTHER}`,
    STATS_CONFIG: store as never,
    BUDGET_DB: {} as D1Database,
  }
}

async function call(e: BudgetEnv, who: string | null, method: string, body?: string): Promise<Response> {
  const headers = new Headers()
  if (who) {
    const r = readAuthConfig(e)
    if (!r.ok) throw new Error(r.problems.join('; '))
    headers.set('Cookie', (await createSessionCookie(new URL(ORIGIN), r.config, { email: who, sub: `s-${who}` }, Date.now())).split(';')[0])
  }
  if (method !== 'GET') headers.set('Origin', ORIGIN)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  const request = new Request(`${ORIGIN}/api/budget/prefs`, { method, headers, body })
  const data: BudgetData = {}
  const ctx = { request, env: e, data, next: async () => prefs({ request, env: e, data, params: {} } as never) }
  return authGate(request, e, () => Promise.resolve(middleware(ctx as never)) as Promise<Response>)
}

const good = { txnView: { ...defaultTxnViewPrefs(), search: 'milk', categories: ['fun'], sortKey: 'amount', sortDir: 'asc' } }

describe('/api/budget/prefs sameAmount', () => {
  it('accepts the map at its limits and round trips it', async () => {
    const { store } = kv()
    const e = env(store)
    const sameAmount: Record<string, boolean> = Object.fromEntries(Array.from({ length: 29 }, (_, i) => [`m${i}`, i % 2 === 0]))
    sameAmount['k'.repeat(80)] = true
    const put = await call(e, LISTED, 'PUT', JSON.stringify({ txnView: { ...good.txnView, sameAmount } }))
    expect(put.status).toBe(200)
    const got = (await (await call(e, LISTED, 'GET')).json()) as { txnView: { sameAmount: Record<string, boolean> } }
    expect(got.txnView.sameAmount).toEqual(sameAmount)
  })
})

describe('/api/budget/prefs access', () => {
  it('GET and PUT are 403 for a login off the budget list, 401 when signed out; nothing is written', async () => {
    const { store, m } = kv()
    const e = env(store)
    for (const method of ['GET', 'PUT']) {
      const body = method === 'PUT' ? JSON.stringify(good) : undefined
      expect((await call(e, UNLISTED, method, body)).status, method).toBe(403)
      expect((await call(e, null, method, body)).status, method).toBe(401)
    }
    expect(m.size).toBe(0)
  })
  it('the handler alone answers 403 with no identity (anonymous)', async () => {
    const { store } = kv()
    for (const method of ['GET', 'PUT']) {
      const req = new Request(`${ORIGIN}/api/budget/prefs`, { method, body: method === 'PUT' ? JSON.stringify(good) : undefined })
      expect((await prefs({ request: req, env: env(store), data: {}, params: {} } as never)).status).toBe(403)
    }
  })
})

describe('/api/budget/prefs storage', () => {
  it('round trips per login under a hashed key (no address in the key), and logins do not mix', async () => {
    const { store, m } = kv()
    const e = env(store)
    expect(await (await call(e, LISTED, 'GET')).json()).toEqual({})
    const put = await call(e, LISTED, 'PUT', JSON.stringify(good))
    expect(put.status).toBe(200)
    expect(put.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await (await call(e, LISTED, 'GET')).json()).toEqual(good)
    expect(await (await call(e, OTHER, 'GET')).json()).toEqual({})
    const keys = [...m.keys()]
    expect(keys).toEqual([await prefsKey(LISTED)])
    expect(keys[0]).toMatch(/^budget:prefs:[0-9a-f]{64}$/)
    expect(keys[0]).not.toContain('example')
    expect(await prefsKey(' LISTED@example.com ')).toBe(keys[0])
  })
  it('rejects unknown fields, bad values and bad JSON with 400, and writes nothing', async () => {
    const { store, m } = kv()
    const e = env(store)
    const bad = [
      '{"txnView":' + JSON.stringify({ ...good.txnView, extra: 1 }) + '}',
      '{"txnView":' + JSON.stringify({ ...good.txnView, sortKey: 'nope' }) + '}',
      '{"txnView":' + JSON.stringify({ ...good.txnView, merchants: [1] }) + '}',
      JSON.stringify({ ...good, other: 1 }),
      '{"txnView":' + JSON.stringify({ ...good.txnView, sameAmount: { acme: 'yes' } }) + '}',
      '{"txnView":' + JSON.stringify({ ...good.txnView, sameAmount: { '': true } }) + '}',
      '{"txnView":' + JSON.stringify({ ...good.txnView, sameAmount: { ['k'.repeat(81)]: true } }) + '}',
      '{"txnView":' + JSON.stringify({ ...good.txnView, sameAmount: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`m${i}`, true])) }) + '}',
      '{"txnView":' + JSON.stringify({ ...good.txnView, sameAmount: ['acme'] }) + '}',
      '{"txnView":null}',
      '[]',
      'not json',
    ]
    for (const b of bad) expect((await call(e, LISTED, 'PUT', b)).status, b).toBe(400)
    expect(m.size).toBe(0)
  })
  it('caps the body at 4 KB: 413 above, accepted at the schema limits below', async () => {
    const { store, m } = kv()
    const e = env(store)
    const big = JSON.stringify({ txnView: { ...good.txnView, merchants: Array.from({ length: 100 }, (_, i) => `m${i}`.padEnd(120, 'x')) } })
    expect(big.length).toBeGreaterThan(PREFS_MAX_BYTES)
    expect((await call(e, LISTED, 'PUT', big)).status).toBe(413)
    expect(m.size).toBe(0)
    expect((await call(e, LISTED, 'PUT', JSON.stringify(good))).status).toBe(200)
  })
  it('405 for other methods; 503 when the KV binding is missing; never touches the layout key', async () => {
    const { store, m } = kv()
    const res = await call(env(store), LISTED, 'POST', '{}')
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('GET, HEAD, PUT')
    const noKv = await prefs({ request: new Request(`${ORIGIN}/api/budget/prefs`), env: { ...env(undefined) }, data: { budgetEmail: LISTED }, params: {} } as never)
    expect(noKv.status).toBe(503)
    await call(env(store), LISTED, 'PUT', JSON.stringify(good))
    expect([...m.keys()].every((k) => k.startsWith('budget:prefs:'))).toBe(true)
  })
})
