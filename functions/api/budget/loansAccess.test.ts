// GET /api/budget/loans and GET /api/budget/debts/:id behind the scoped middleware: 200 for an allowlisted
// identity, 403 for a signed-in identity not on the list, 403 for a route reached with no identity, and the
// write methods (403 unlisted, 405 with Allow when listed). Emails are made up (example.com).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionCookie, readAuthConfig, VIEWER_KEY_PREFIX, type ViewerStore } from '../../_lib/auth'
import type { BudgetData, BudgetEnv } from '../../_lib/budgetAccess'
import { createBudgetDb, type FakeBudgetDb } from '../../_lib/testing/budgetDb'
import { onRequest as middleware } from './_middleware'
import { onRequest as loans } from './loans'
import { onRequest as debtDetail } from './debts/[id]/index'

const ORIGIN = 'https://stats.goodstuff.software'
const LISTED = 'listed@example.com'
const UNLISTED = 'unlisted@example.com'
const VIEWERS: ViewerStore = { get: async (key) => (key === `${VIEWER_KEY_PREFIX}${LISTED}` || key === `${VIEWER_KEY_PREFIX}${UNLISTED}` ? 'viewer' : null) }

let db: FakeBudgetDb
let env: BudgetEnv
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  db = await createBudgetDb()
  env = {
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-client-secret', SESSION_SECRET: 'c'.repeat(48),
    ALLOWED_EMAILS: `${LISTED},${UNLISTED}`, BUDGET_ALLOWED_EMAILS: LISTED, STATS_CONFIG: VIEWERS, BUDGET_DB: db.d1,
  }
})

type Handler = (ctx: unknown) => Promise<Response> | Response
const ROUTES = [
  { name: 'loans', path: '/api/budget/loans', handler: loans as unknown as Handler, params: {} },
  { name: 'debt detail', path: '/api/budget/debts/card-a', handler: debtDetail as unknown as Handler, params: { id: 'card-a' } },
]

async function call(route: (typeof ROUTES)[number], method: string, email: string | null): Promise<Response> {
  const headers = new Headers()
  if (email) {
    const r = readAuthConfig(env)
    if (!r.ok) throw new Error(r.problems.join('; '))
    headers.set('Cookie', (await createSessionCookie(new URL(ORIGIN), r.config, { email, sub: `sub-${email}` }, Date.now())).split(';')[0]!)
  }
  if (!['GET', 'HEAD'].includes(method)) headers.set('Origin', ORIGIN)
  const request = new Request(ORIGIN + route.path, { method, headers })
  const data: BudgetData = {}
  const ctx = {
    request, env, data, params: route.params, waitUntil: () => {},
    next: () => Promise.resolve(route.handler({ request, env, data, params: route.params, waitUntil: () => {} })),
  }
  return (await middleware(ctx as unknown as Parameters<typeof middleware>[0])) as Response
}

describe.each(ROUTES)('$name', (route) => {
  it('GET is 200 for an allowlisted identity', async () => {
    const res = await call(route, 'GET', LISTED)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/)
  })
  it('GET is 403 for a signed-in identity that is not on the allowlist', async () => {
    const res = await call(route, 'GET', UNLISTED)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('budget_denied')
  })
  it('HEAD is 403 for a signed-in identity that is not on the allowlist', async () => {
    expect((await call(route, 'HEAD', UNLISTED)).status).toBe(403)
  })
  it('the route itself answers 403 when no identity reached it', async () => {
    const request = new Request(ORIGIN + route.path)
    const res = await route.handler({ request, env, data: {}, params: route.params, waitUntil: () => {} })
    expect(res.status).toBe(403)
  })
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s is 403 unlisted and 405 listed', async (method) => {
    expect((await call(route, method, UNLISTED)).status).toBe(403)
    const res = await call(route, method, LISTED)
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('GET, HEAD')
  })
})
