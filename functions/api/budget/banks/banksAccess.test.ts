// Every bank-link route behind the scoped middleware: 403 for a signed-in identity not on the allowlist, 403 for a route
// reached with no identity, 405 (with Allow) for a wrong method, 503 banks_not_configured without the BANKS binding
// (status still 200, configured:false), and 413 over each route's body cap. The Worker fake throws on any call, so a
// refused request that still reaches the Worker fails here. Emails are made up (example.com).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionCookie, readAuthConfig, VIEWER_KEY_PREFIX, type ViewerStore } from '../../../_lib/auth'
import type { BudgetData, BudgetEnv } from '../../../_lib/budgetAccess'
import { callRoute, createBudgetDb, json, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import { createFakeBanks, seedBankAccount, seedBankItem, type FakeBanks } from '../../../_lib/testing/banksFake'
import { onRequest as middleware } from '../_middleware'
import { onRequest as status } from './status'
import { onRequest as linkToken } from './link-token'
import { onRequest as exchange } from './exchange'
import { onRequest as account } from './accounts/[id]'
import { onRequest as itemSync } from './items/[id]/sync'
import { onRequest as itemReconnected } from './items/[id]/reconnected'
import { onRequest as itemRefresh } from './items/[id]/accounts-refresh'
import { onRequest as itemUnlink } from './items/[id]/unlink'
import { onRequest as dropped } from './dropped/[txnId]'

const ORIGIN = 'https://stats.goodstuff.software'
const LISTED = 'listed@example.com'
const UNLISTED = 'unlisted@example.com'
const VIEWERS: ViewerStore = { get: async (key) => (key === `${VIEWER_KEY_PREFIX}${LISTED}` || key === `${VIEWER_KEY_PREFIX}${UNLISTED}` ? 'viewer' : null) }
const ITEM = 'i000000000000a001'
const BANK_ACCT = 'b000000000000c001'
const TXN = '0'.repeat(31) + '1'

let db: FakeBudgetDb
let banks: FakeBanks
let env: BudgetEnv
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  db = await createBudgetDb()
  banks = createFakeBanks()
  seedBankItem(db, { id: ITEM, owner: LISTED })
  seedBankAccount(db, { id: BANK_ACCT, itemId: ITEM })
  env = {
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-client-secret', SESSION_SECRET: 'c'.repeat(48),
    ALLOWED_EMAILS: `${LISTED},${UNLISTED}`, BUDGET_ALLOWED_EMAILS: LISTED, STATS_CONFIG: VIEWERS, BUDGET_DB: db.d1, BANKS: banks.binding,
  }
})

type Handler = (ctx: unknown) => Promise<Response> | Response
interface Route {
  name: string
  method: string
  path: string
  handler: Handler
  params: Record<string, string>
  /** A body that gets past the body read (when the route reads one). */
  body?: unknown
  /** The body cap in bytes, when the route reads a body. */
  cap?: number
  /** A method the route does not serve. */
  wrongMethod: string
}
const ROUTES: Route[] = [
  { name: 'status', method: 'GET', path: '/api/budget/banks/status', handler: status as unknown as Handler, params: {}, wrongMethod: 'POST' },
  { name: 'link-token', method: 'POST', path: '/api/budget/banks/link-token', handler: linkToken as unknown as Handler, params: {}, body: { consent: 1 }, cap: 1024, wrongMethod: 'GET' },
  { name: 'exchange', method: 'POST', path: '/api/budget/banks/exchange', handler: exchange as unknown as Handler, params: {}, body: {}, cap: 8192, wrongMethod: 'GET' },
  { name: 'account PATCH', method: 'PATCH', path: `/api/budget/banks/accounts/${BANK_ACCT}`, handler: account as unknown as Handler, params: { id: BANK_ACCT }, body: { sync: 'off' }, cap: 2048, wrongMethod: 'POST' },
  { name: 'item sync', method: 'POST', path: `/api/budget/banks/items/${ITEM}/sync`, handler: itemSync as unknown as Handler, params: { id: ITEM }, wrongMethod: 'GET' },
  { name: 'item reconnected', method: 'POST', path: `/api/budget/banks/items/${ITEM}/reconnected`, handler: itemReconnected as unknown as Handler, params: { id: ITEM }, wrongMethod: 'GET' },
  { name: 'item accounts-refresh', method: 'POST', path: `/api/budget/banks/items/${ITEM}/accounts-refresh`, handler: itemRefresh as unknown as Handler, params: { id: ITEM }, wrongMethod: 'GET' },
  { name: 'item unlink', method: 'POST', path: `/api/budget/banks/items/${ITEM}/unlink`, handler: itemUnlink as unknown as Handler, params: { id: ITEM }, body: { confirm: true }, cap: 1024, wrongMethod: 'GET' },
  { name: 'dropped', method: 'POST', path: `/api/budget/banks/dropped/${TXN}`, handler: dropped as unknown as Handler, params: { txnId: TXN }, body: { action: 'keep' }, cap: 1024, wrongMethod: 'GET' },
]

async function call(route: Route, method: string, email: string | null, e: BudgetEnv = env, rawBody?: string): Promise<Response> {
  const headers = new Headers()
  if (email) {
    const r = readAuthConfig(e)
    if (!r.ok) throw new Error(r.problems.join('; '))
    headers.set('Cookie', (await createSessionCookie(new URL(ORIGIN), r.config, { email, sub: `sub-${email}` }, Date.now())).split(';')[0]!)
  }
  if (!['GET', 'HEAD'].includes(method)) {
    headers.set('Origin', ORIGIN)
    headers.set('Content-Type', 'application/json')
  }
  const text = rawBody ?? (route.body === undefined ? undefined : JSON.stringify(route.body))
  const request = new Request(ORIGIN + route.path, { method, headers, ...(text !== undefined && !['GET', 'HEAD'].includes(method) ? { body: text } : {}) })
  const data: BudgetData = {}
  const ctx = {
    request, env: e, data, params: route.params, waitUntil: () => {},
    next: () => Promise.resolve(route.handler({ request, env: e, data, params: route.params, waitUntil: () => {} })),
  }
  return (await middleware(ctx as unknown as Parameters<typeof middleware>[0])) as Response
}

describe.each(ROUTES)('$name', (route) => {
  it('is 403 for a signed-in identity that is not on the allowlist, with no Worker call', async () => {
    const res = await call(route, route.method, UNLISTED)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('budget_denied')
    expect(banks.calls).toEqual([])
  })

  it('is refused (401, no session) for an anonymous request', async () => {
    const res = await call(route, route.method, null)
    expect(res.status).toBe(401)
    expect(banks.calls).toEqual([])
  })

  it('the route itself answers 403 when no identity reached it', async () => {
    const request = new Request(ORIGIN + route.path, { method: route.method })
    const res = await route.handler({ request, env, data: {}, params: route.params, waitUntil: () => {} })
    expect(res.status).toBe(403)
    expect(banks.calls).toEqual([])
  })

  it('answers a wrong method 403 unlisted and 405 with Allow when listed', async () => {
    expect((await call(route, route.wrongMethod, UNLISTED)).status).toBe(403)
    const res = await call(route, route.wrongMethod, LISTED)
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toMatch(route.method)
  })

  it('without the BANKS binding: 503 banks_not_configured (status stays 200 with configured:false)', async () => {
    const noBanks: BudgetEnv = { ...env, BANKS: undefined }
    const res = await call(route, route.method, LISTED, noBanks)
    if (route.name === 'status') {
      expect(res.status).toBe(200)
      const body = (await res.json()) as { configured: boolean; linkEnabled: boolean }
      expect(body.configured).toBe(false)
      expect(body.linkEnabled).toBe(false)
    } else {
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: string }).error).toBe('banks_not_configured')
    }
  })

  if (route.cap !== undefined) {
    it(`answers 413 over its ${route.cap}-byte body cap, with no Worker call`, async () => {
      const big = JSON.stringify({ pad: 'x'.repeat(route.cap! + 10) })
      const res = await call(route, route.method, LISTED, env, big)
      expect(res.status).toBe(413)
      expect(((await res.json()) as { error: string }).error).toBe('too_large')
      expect(banks.calls).toEqual([])
    })
  }
})

describe('every route sits under the budget middleware scope', () => {
  it('all new routes live beneath functions/api/budget/', () => {
    for (const r of ROUTES) expect(r.path.startsWith('/api/budget/banks/')).toBe(true)
  })
})

describe('owner-only actions refuse the other listed person (403 not_owner, no Worker call, nothing changed)', () => {
  const OWNER = 'user-a@example.com'
  const OTHER = 'user-b@example.com'
  const cases: Array<{ name: string; handler: Handler; path: string; params: Record<string, string>; method: string; body?: unknown }> = [
    { name: 'accounts-refresh', handler: itemRefresh as unknown as Handler, path: `/api/budget/banks/items/${ITEM}/accounts-refresh`, params: { id: ITEM }, method: 'POST' },
    { name: 'unlink', handler: itemUnlink as unknown as Handler, path: `/api/budget/banks/items/${ITEM}/unlink`, params: { id: ITEM }, method: 'POST', body: { confirm: true } },
    { name: 'reconnected', handler: itemReconnected as unknown as Handler, path: `/api/budget/banks/items/${ITEM}/reconnected`, params: { id: ITEM }, method: 'POST' },
    { name: 'link-token update mode', handler: linkToken as unknown as Handler, path: '/api/budget/banks/link-token', params: {}, method: 'POST', body: { itemId: ITEM } },
    { name: 'account PATCH on', handler: account as unknown as Handler, path: `/api/budget/banks/accounts/${BANK_ACCT}`, params: { id: BANK_ACCT }, method: 'PATCH', body: { sync: 'on', accountId: 'chk-a' } },
    { name: 'account PATCH off', handler: account as unknown as Handler, path: `/api/budget/banks/accounts/${BANK_ACCT}`, params: { id: BANK_ACCT }, method: 'PATCH', body: { sync: 'off' } },
  ]
  it.each(cases)('$name', async (c) => {
    db.exec(`UPDATE bank_items SET owner_email = '${OWNER}' WHERE id = '${ITEM}'`)
    const before = JSON.stringify([db.all('SELECT * FROM bank_items'), db.all('SELECT * FROM bank_accounts')])
    const res = await callRoute(c.handler as never, db, c.path, { method: c.method, params: c.params, body: c.body, email: OTHER, env: { BANKS: banks.binding } })
    expect(res.status).toBe(403)
    expect((await json<{ error: string }>(res)).error).toBe('not_owner')
    expect(banks.calls).toEqual([])
    expect(JSON.stringify([db.all('SELECT * FROM bank_items'), db.all('SELECT * FROM bank_accounts')])).toBe(before)
  })
})
