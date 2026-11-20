// /api/budget/access and the scoped middleware, end to end: root gate -> functions/api/budget/_middleware.ts
// -> route, and the middleware ALONE with the root gate skipped (the second layer must give the same
// answers). Emails are made up (example.com).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authGate, createSessionCookie, readAuthConfig, VIEWER_KEY_PREFIX, type AuthEnv, type ViewerStore } from '../../_lib/auth'
import type { BudgetData, BudgetEnv } from '../../_lib/budgetAccess'
import { onRequest as middleware } from './_middleware'
import { onRequest as access } from './access'
import { onRequest as catchAll } from './[[path]]'

const ORIGIN = 'https://stats.goodstuff.software'
const OWNER_UNLISTED = 'owner@example.com'
const OWNER_LISTED = 'owner2@example.com'
const VIEWER_UNLISTED = 'viewer@example.com'
const VIEWER_LISTED = 'viewer2@example.com'

const VIEWERS: ViewerStore = {
  get: async (key) =>
    key === `${VIEWER_KEY_PREFIX}${VIEWER_UNLISTED}` || key === `${VIEWER_KEY_PREFIX}${VIEWER_LISTED}` ? 'viewer' : null,
}
const DB = {} as D1Database

const ENV: BudgetEnv = {
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'c'.repeat(48),
  ALLOWED_EMAILS: `${OWNER_UNLISTED},${OWNER_LISTED}`,
  BUDGET_ALLOWED_EMAILS: `${OWNER_LISTED},${VIEWER_LISTED}`,
  STATS_CONFIG: VIEWERS,
  BUDGET_DB: DB,
}

type Who = 'signedOut' | 'ownerUnlisted' | 'viewerUnlisted' | 'viewerListed' | 'ownerListed'
const EMAILS = { ownerUnlisted: OWNER_UNLISTED, viewerUnlisted: VIEWER_UNLISTED, viewerListed: VIEWER_LISTED, ownerListed: OWNER_LISTED }
const WHO: Who[] = ['signedOut', 'ownerUnlisted', 'viewerUnlisted', 'viewerListed', 'ownerListed']
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const PATHS = [
  '/api/budget/access',
  '/api/budget/transactions/x',
  '/api/Budget/meta',
  '/api//budget/meta',
  '/api/%62udget/meta',
  '/api/budget%2Fmeta',
  '/api/budget',
]

async function cookieFor(who: Who, env: BudgetEnv = ENV): Promise<string | undefined> {
  if (who === 'signedOut') return undefined
  const r = readAuthConfig(env)
  if (!r.ok) throw new Error(r.problems.join('; '))
  // The middleware reads the real clock, so the cookie is minted on it too.
  return (await createSessionCookie(new URL(ORIGIN), r.config, { email: EMAILS[who], sub: `sub-${who}` }, Date.now())).split(';')[0]
}

function request(path: string, method: string, cookie: string | undefined, base = ORIGIN): Request {
  const headers = new Headers()
  if (cookie) headers.set('Cookie', cookie)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('Origin', base)
  return new Request(base + path, { method, headers })
}

/** Routes the way Pages does for the two budget handlers this leg owns: access, else the catch-all. */
function route(ctx: Parameters<typeof access>[0]): Promise<Response> | Response {
  return new URL(ctx.request.url).pathname === '/api/budget/access' ? access(ctx) : catchAll(ctx)
}

/** The scoped middleware around the routes; `data` is what Pages passes through. */
function runMiddleware(req: Request, env: BudgetEnv, leaf: (ctx: Parameters<typeof access>[0]) => Promise<Response> | Response = route) {
  const data: BudgetData = {}
  const reached = vi.fn()
  const ctx = {
    request: req,
    env,
    data,
    next: async () => {
      reached()
      return leaf({ request: req, env, data } as unknown as Parameters<typeof access>[0])
    },
  } as unknown as Parameters<typeof middleware>[0]
  return { run: () => middleware(ctx), reached, data }
}

/** Root gate -> middleware -> route. */
async function full(path: string, method: string, who: Who, env: BudgetEnv = ENV, base = ORIGIN) {
  const req = request(path, method, await cookieFor(who), base)
  const mw = runMiddleware(req, env)
  const res = await authGate(req, env, () => Promise.resolve(mw.run()) as Promise<Response>)
  return { res, reached: mw.reached, data: mw.data }
}

async function alone(path: string, method: string, who: Who, env: BudgetEnv = ENV, base = ORIGIN) {
  const mw = runMiddleware(request(path, method, await cookieFor(who), base), env)
  const res = await mw.run()
  return { res: res as Response, reached: mw.reached, data: mw.data }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const noStoreVary = (res: Response, label: string) => {
  expect(res.headers.get('Cache-Control'), label).toMatch(/no-store/)
  expect(res.headers.get('Cache-Control'), label).toMatch(/private/)
  expect(res.headers.get('Vary') ?? '', label).toMatch(/cookie/i)
}

describe('the route answers', () => {
  it('GET /api/budget/access -> AccessResponse for the listed account, lower-cased', async () => {
    for (const who of ['viewerListed', 'ownerListed'] as const) {
      const { res, data } = await full('/api/budget/access', 'GET', who)
      expect(res.status, who).toBe(200)
      expect(await res.json()).toEqual({ ok: true, email: EMAILS[who] })
      expect(data.budgetEmail).toBe(EMAILS[who])
    }
  })

  it('HEAD is a GET; every other method is 405 with Allow', async () => {
    expect((await full('/api/budget/access', 'HEAD', 'ownerListed')).res.status).toBe(200)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const { res } = await full('/api/budget/access', method, 'viewerListed')
      expect(res.status, method).toBe(405)
      expect(res.headers.get('Allow'), method).toBe('GET, HEAD')
      expect(await res.json()).toEqual({ error: 'method_not_allowed' })
    }
  })

  it('an unknown budget path is a 404 for a listed account, whatever the method', async () => {
    for (const path of ['/api/budget/nope', '/api/budget/transactions/x', '/api/budget/a/b/c']) {
      for (const method of METHODS) {
        const { res, reached } = await full(path, method, 'viewerListed')
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(reached, `${method} ${path}`).toHaveBeenCalledOnce()
        if (method !== 'HEAD') expect(await res.json()).toEqual({ error: 'not_found' })
      }
    }
  })

  it('a route that runs without the middleware (no identity) answers 403', async () => {
    const ctx = { request: new Request(`${ORIGIN}/api/budget/access`), env: ENV, data: {} } as unknown as Parameters<typeof access>[0]
    expect((await access(ctx)).status).toBe(403)
    expect((await catchAll(ctx)).status).toBe(403)
  })
})

describe('root gate + middleware, each method x identity x spelling', () => {
  for (const method of METHODS) {
    for (const path of PATHS) {
      it(`${method} ${path}`, async () => {
        for (const who of WHO) {
          const label = `${who} ${method} ${path}`
          const { res, reached } = await full(path, method, who)
          if (who === 'signedOut') expect(res.status, label).toBe(401)
          else if (who === 'ownerUnlisted' || who === 'viewerUnlisted') expect(res.status, label).toBe(403)
          else expect([200, 404, 405], label).toContain(res.status) // reached the route
          if (res.status === 401 || res.status === 403) expect(reached, label).not.toHaveBeenCalled()
          else expect(reached, label).toHaveBeenCalledOnce()
          // The root gate's own 401 is plain no-store (not budget code); everything else is private + Vary.
          if (who === 'signedOut') expect(res.headers.get('Cache-Control'), label).toBe('no-store')
          else noStoreVary(res, label)
        }
      })
    }
  }
})

describe('the middleware alone (root gate skipped) gives the same answers', () => {
  for (const method of METHODS) {
    for (const path of PATHS) {
      it(`${method} ${path}`, async () => {
        for (const who of WHO) {
          const label = `${who} ${method} ${path}`
          const { res, reached, data } = await alone(path, method, who)
          if (who === 'signedOut') expect(res.status, label).toBe(401)
          else if (who === 'ownerUnlisted' || who === 'viewerUnlisted') {
            expect(res.status, label).toBe(403)
            if (method !== 'HEAD') expect(((await res.json()) as { error?: string }).error, label).toBe('budget_denied')
          } else expect([200, 404, 405], label).toContain(res.status)
          if (res.status === 401 || res.status === 403) {
            expect(reached, label).not.toHaveBeenCalled()
            expect(data.budgetEmail, label).toBeUndefined()
          } else expect(data.budgetEmail, label).toBe(EMAILS[who as 'viewerListed' | 'ownerListed'])
          noStoreVary(res, label)
        }
      })
    }
  }

  it('a missing or empty list is 403 for every signed-in identity (and 403 for signed out: the list is checked first)', async () => {
    for (const raw of [undefined, '', '  ', ' , ']) {
      const env: BudgetEnv = { ...ENV, BUDGET_ALLOWED_EMAILS: raw }
      for (const who of WHO) {
        const { res, reached } = await alone('/api/budget/access', 'GET', who, env)
        expect(res.status, `${who} ${JSON.stringify(raw)}`).toBe(403)
        expect(reached).not.toHaveBeenCalled()
        noStoreVary(res, who)
      }
    }
  })

  it('sign-in not configured is a 503 for budget too', async () => {
    const cookie = await cookieFor('ownerListed')
    const env: BudgetEnv = { ...ENV, GOOGLE_CLIENT_ID: '' }
    const mw = runMiddleware(request('/api/budget/access', 'GET', cookie), env)
    const res = (await mw.run()) as Response
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error?: string }).error).toBe('auth_not_configured')
    noStoreVary(res, 'auth_not_configured')
  })

  it('a missing BUDGET_DB is 503 budget_db_missing for a listed account only', async () => {
    const env: BudgetEnv = { ...ENV, BUDGET_DB: undefined }
    const listed = await alone('/api/budget/access', 'GET', 'ownerListed', env)
    expect(listed.res.status).toBe(503)
    expect(await listed.res.json()).toMatchObject({ error: 'budget_db_missing' })
    expect(listed.reached).not.toHaveBeenCalled()
    noStoreVary(listed.res, 'budget_db_missing')
    // An unlisted account learns nothing about the setup.
    expect((await alone('/api/budget/access', 'GET', 'ownerUnlisted', env)).res.status).toBe(403)
    expect((await alone('/api/budget/access', 'GET', 'signedOut', env)).res.status).toBe(401)
  })

  it('a handler that throws becomes a no-store 500', async () => {
    const mw = runMiddleware(request('/api/budget/x', 'GET', await cookieFor('ownerListed')), ENV, () => {
      throw new Error('boom')
    })
    const res = (await mw.run()) as Response
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
    noStoreVary(res, 'boom')
  })

  it('stamps no-store on whatever the route sent, and merges Vary', async () => {
    const mw = runMiddleware(
      request('/api/budget/x', 'GET', await cookieFor('ownerListed')),
      ENV,
      () => new Response('{}', { headers: { 'Cache-Control': 'public, max-age=600', Vary: 'Accept-Encoding', ETag: '"x"' } }),
    )
    const res = (await mw.run()) as Response
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Vary')).toBe('Accept-Encoding, Cookie')
    expect(res.headers.get('ETag')).toBe('"x"')
  })
})

describe('the dev bypass in the middleware', () => {
  const LOCAL = 'http://localhost'
  const bypass = (list: string | undefined, extra: Partial<AuthEnv> = {}): BudgetEnv => ({
    AUTH_DEV_BYPASS: '1',
    BUDGET_ALLOWED_EMAILS: list,
    BUDGET_DB: DB,
    ...extra,
  })

  it('opens for a listed dev email only (no cookie needed)', async () => {
    const ok = await alone('/api/budget/access', 'GET', 'signedOut', bypass('dev@localhost'), LOCAL)
    expect(ok.res.status).toBe(200)
    expect(await ok.res.json()).toEqual({ ok: true, email: 'dev@localhost' })
    expect((await alone('/api/budget/access', 'GET', 'signedOut', bypass(OWNER_LISTED), LOCAL)).res.status).toBe(403)
    expect((await alone('/api/budget/access', 'GET', 'signedOut', bypass(undefined), LOCAL)).res.status).toBe(403)
  })

  it('does nothing on a non-loopback host', async () => {
    const env: BudgetEnv = { ...ENV, AUTH_DEV_BYPASS: '1', BUDGET_ALLOWED_EMAILS: `dev@localhost,${OWNER_LISTED}` }
    const { res } = await alone('/api/budget/access', 'GET', 'signedOut', env)
    expect(res.status).toBe(401)
  })

  it('the bypass still needs BUDGET_DB', async () => {
    const env = bypass('dev@localhost')
    delete env.BUDGET_DB
    const { res } = await alone('/api/budget/access', 'GET', 'signedOut', env, LOCAL)
    expect(res.status).toBe(503)
  })
})
