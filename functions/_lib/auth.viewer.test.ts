// View-only access (README "Auth → View-only access"): a viewer on the KV list reads every page
// and API the owner reads, and gets 403 on every write, decided in the gate before any Function
// runs. Every email here is made up.
import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  authGate,
  b64urlEncode,
  createSessionCookie,
  GOOGLE_TOKEN_ENDPOINT,
  readAuthConfig,
  roleFor,
  VIEWER_KEY_PREFIX,
  VIEWER_READ_POSTS,
  viewerMayRequest,
  type AuthConfig,
  type AuthEnv,
  type ViewerStore,
} from './auth'
import { onRequest } from '../_middleware'

const ORIGIN = 'https://stats.goodstuff.software'
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0)
const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const OWNER = 'owner@example.com'
const VIEWER = 'viewer@example.com'
const STRANGER = 'stranger@example.com'

function kv(entries: Record<string, string>): ViewerStore & { get: ReturnType<typeof vi.fn> } {
  return { get: vi.fn(async (key: string) => (key in entries ? entries[key] : null)) }
}

const VIEWERS = kv({ [`${VIEWER_KEY_PREFIX}${VIEWER}`]: 'viewer', [`${VIEWER_KEY_PREFIX}notquite@example.com`]: '1' })

const ENV: AuthEnv = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'y'.repeat(48),
  ALLOWED_EMAILS: OWNER,
  STATS_CONFIG: VIEWERS,
}

function config(env: AuthEnv = ENV): AuthConfig {
  const r = readAuthConfig(env)
  if (!r.ok) throw new Error(r.problems.join('; '))
  return r.config
}

async function cookieFor(email: string): Promise<string> {
  const header = await createSessionCookie(new URL(ORIGIN), config(), { email, sub: `sub-${email}` }, NOW)
  return header.split(';')[0]
}

async function gate(path: string, init: RequestInit & { cookie?: string } = {}, env: AuthEnv = ENV) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('Cookie', init.cookie)
  const next = vi.fn(async () => new Response('protected', { status: 200 }))
  const res = await authGate(new Request(ORIGIN + path, { ...init, headers }), env, next, { now: () => NOW })
  return { res, next }
}

// ── Every route Pages serves from functions/api, and the methods each one handles ──────────────

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api')

function handlerFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (!name.startsWith('__')) out.push(...handlerFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !/\.test\.ts$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

interface Route {
  path: string
  file: string
  methods: string[]
}

const ROUTES: Route[] = handlerFiles(API_DIR)
  .map((file) => {
    const src = readFileSync(file, 'utf8')
    const methods = [...src.matchAll(/export const onRequest(\w*)\b/g)].map((m) => (m[1] || 'ANY').toUpperCase())
    const path = '/api/' + relative(API_DIR, file).replace(/\\/g, '/').replace(/\.ts$/, '').replace(/\/index$/, '')
    return { path, file, methods }
  })
  .filter((r) => r.methods.length > 0)

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

describe('the route inventory the write tests run over', () => {
  it('finds the known handlers, including both known writes', () => {
    const byPath = Object.fromEntries(ROUTES.map((r) => [r.path, r.methods.sort()]))
    expect(byPath['/api/config']).toEqual(['GET', 'PUT'])
    expect(byPath['/api/ads/refresh']).toEqual(['GET', 'POST'])
    for (const p of VIEWER_READ_POSTS) expect(byPath[p], p).toContain('POST')
  })
})

// ── Roles ──────────────────────────────────────────────────────────────────────────────────

describe('roleFor', () => {
  it('owner from ALLOWED_EMAILS, viewer only from a KV key whose value is exactly "viewer"', async () => {
    const c = config()
    expect(await roleFor(OWNER, c, VIEWERS)).toBe('owner')
    expect(await roleFor(VIEWER, c, VIEWERS)).toBe('viewer')
    expect(await roleFor('VIEWER@Example.com', c, VIEWERS)).toBe('viewer')
    expect(await roleFor(STRANGER, c, VIEWERS)).toBeNull()
    expect(await roleFor('notquite@example.com', c, VIEWERS)).toBeNull()
    expect(await roleFor(VIEWER, c, undefined)).toBeNull()
  })

  it('an owner who is also on the view-only list stays owner, without a KV read', async () => {
    const store = kv({ [`${VIEWER_KEY_PREFIX}${OWNER}`]: 'viewer' })
    expect(await roleFor(OWNER, config(), store)).toBe('owner')
    expect(store.get).not.toHaveBeenCalled()
  })

  it('fails closed: a KV error, a non-ASCII look-alike or a non-string is not a viewer', async () => {
    const broken: ViewerStore = { get: async () => { throw new Error('kv down') } }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await roleFor(VIEWER, config(), broken)).toBeNull()
    err.mockRestore()
    const store = kv({ [`${VIEWER_KEY_PREFIX}kviewer@example.com`]: 'viewer' })
    expect(await roleFor('Kviewer@example.com', config(), store)).toBeNull() // KELVIN SIGN
    expect(store.get).not.toHaveBeenCalled()
    expect(await roleFor(undefined, config(), store)).toBeNull()
    expect(await roleFor(`${VIEWER} `, config(), store)).toBeNull()
  })
})

describe('viewerMayRequest', () => {
  it('allows GET and HEAD anywhere and POST only to the read-only query endpoints', () => {
    expect(viewerMayRequest('GET', '/api/config')).toBe(true)
    expect(viewerMayRequest('head', '/')).toBe(true)
    for (const p of VIEWER_READ_POSTS) expect(viewerMayRequest('post', p)).toBe(true)
    for (const [m, p] of [
      ['PUT', '/api/config'],
      ['POST', '/api/config'],
      ['POST', '/api/ads/refresh'],
      ['POST', '/api/stats/'],
      ['POST', '/api/Stats'],
      ['POST', '/api/stats/../config'],
      ['POST', '/api/anything-added-later'],
      ['DELETE', '/api/stats'],
      ['PATCH', '/api/stats'],
      ['PUT', '/api/stats'],
      ['OPTIONS', '/api/config'],
      ['PROPFIND', '/'],
    ]) {
      expect(viewerMayRequest(m, p), `${m} ${p}`).toBe(false)
    }
  })
})

// ── Through the gate ───────────────────────────────────────────────────────────────────────

describe('a viewer reads everything the owner reads', () => {
  it('pages, static assets and every GET route reach the Function', async () => {
    const cookie = await cookieFor(VIEWER)
    for (const path of ['/', '/?page=abc', '/assets/index-abc.js', ...ROUTES.filter((r) => r.methods.includes('GET')).map((r) => r.path)]) {
      const { res, next } = await gate(path, { cookie })
      expect(res.status, path).toBe(200)
      expect(next, path).toHaveBeenCalledOnce()
    }
  })

  it('the read-only query POSTs reach the Function', async () => {
    const cookie = await cookieFor(VIEWER)
    for (const path of VIEWER_READ_POSTS) {
      const { res, next } = await gate(path, { method: 'POST', cookie, headers: { Origin: ORIGIN }, body: '{}' })
      expect(res.status, path).toBe(200)
      expect(next, path).toHaveBeenCalledOnce()
    }
  })

  it('/auth/me reports the role', async () => {
    const viewer = await gate('/auth/me', { cookie: await cookieFor(VIEWER) })
    expect(await viewer.res.json()).toMatchObject({ email: VIEWER, role: 'viewer' })
    const owner = await gate('/auth/me', { cookie: await cookieFor(OWNER) })
    expect(await owner.res.json()).toMatchObject({ email: OWNER, role: 'owner' })
  })

  it('a viewer can still sign out', async () => {
    const { res } = await gate('/auth/logout', { method: 'POST', cookie: await cookieFor(VIEWER), headers: { Origin: ORIGIN } })
    expect(res.status).toBe(303)
  })
})

describe('a viewer writes nothing: 403 before any Function runs', () => {
  it('every write method on every API route, except the read-only query POSTs', async () => {
    const cookie = await cookieFor(VIEWER)
    let checked = 0
    for (const route of ROUTES) {
      for (const method of WRITE_METHODS) {
        if (method === 'POST' && VIEWER_READ_POSTS.has(route.path)) continue
        for (const path of [route.path, `${route.path}/`, `${route.path}?x=1`]) {
          const { res, next } = await gate(path, { method, cookie, headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{"pages":[]}' })
          expect(res.status, `${method} ${path}`).toBe(403)
          expect(await res.json(), `${method} ${path}`).toMatchObject({ error: 'view_only' })
          expect(next, `${method} ${path}`).not.toHaveBeenCalled()
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(40)
  })

  it('the known writes: PUT /api/config (layout, cards, chart types, breakdowns) and POST /api/ads/refresh', async () => {
    const cookie = await cookieFor(VIEWER)
    for (const [method, path] of [['PUT', '/api/config'], ['POST', '/api/ads/refresh']]) {
      const { res, next } = await gate(path, { method, cookie, headers: { Origin: ORIGIN }, body: '{}' })
      expect(res.status).toBe(403)
      expect(next).not.toHaveBeenCalled()
      expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    }
  })

  it('odd methods, lower-case methods, encoded paths and unknown routes are refused too', async () => {
    const cookie = await cookieFor(VIEWER)
    for (const [method, path] of [
      ['put', '/api/config'],
      ['OPTIONS', '/api/config'],
      ['POST', '/api/%63onfig'],
      ['POST', '/api/stats/..%2Fconfig'],
      ['POST', '/api/new-write-endpoint'],
      ['DELETE', '/'],
      ['POST', '/'],
    ]) {
      const { res, next } = await gate(path, { method, cookie, headers: { Origin: ORIGIN } })
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(next, `${method} ${path}`).not.toHaveBeenCalled()
    }
  })

  it('a role can not be forged in the cookie: an extra "role":"owner" claim is ignored', async () => {
    // Even a correctly signed session (only the server can sign one) carries no role; the role is
    // always resolved from ALLOWED_EMAILS and KV on the request.
    const { signToken } = await import('./auth')
    const iat = Math.floor(NOW / 1000)
    const token = await signToken(ENV.SESSION_SECRET!, 'gss-stats/session/v1', { v: 1, email: VIEWER, sub: 's', iat, exp: iat + 3600, role: 'owner' })
    const { res, next } = await gate('/api/config', { method: 'PUT', cookie: `__Host-gss_session=${token}`, headers: { Origin: ORIGIN }, body: '{}' })
    expect(res.status).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('a removed viewer is locked out on the next request', async () => {
    const cookie = await cookieFor(VIEWER)
    const env = { ...ENV, STATS_CONFIG: kv({}) }
    const page = await gate('/api/sites', { cookie }, env)
    expect(page.res.status).toBe(401)
    expect(page.next).not.toHaveBeenCalled()
  })
})

describe('the owner is unchanged', () => {
  it('writes and reads every route, and never touches KV for it', async () => {
    const store = kv({})
    const env = { ...ENV, STATS_CONFIG: store }
    const cookie = await cookieFor(OWNER)
    for (const route of ROUTES) {
      for (const method of route.methods.filter((m) => m !== 'ANY')) {
        const { res, next } = await gate(route.path, { method, cookie, headers: { Origin: ORIGIN }, body: method === 'GET' ? undefined : '{}' }, env)
        expect(res.status, `${method} ${route.path}`).toBe(200)
        expect(next, `${method} ${route.path}`).toHaveBeenCalledOnce()
      }
    }
    expect(store.get).not.toHaveBeenCalled()
  })

  it('still works with no KV binding at all', async () => {
    const { STATS_CONFIG: _, ...noKv } = ENV
    const { res, next } = await gate('/api/config', { method: 'PUT', cookie: await cookieFor(OWNER), headers: { Origin: ORIGIN }, body: '{}' }, noKv)
    expect(res.status).toBe(200)
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('unauthenticated and unlisted accounts are unchanged', () => {
  it('no session: API 401, page redirect to sign-in', async () => {
    expect((await gate('/api/config')).res.status).toBe(401)
    expect((await gate('/api/config', { method: 'PUT', headers: { Origin: ORIGIN } })).res.status).toBe(401)
    const page = await gate('/')
    expect(page.res.status).toBe(302)
    expect(page.res.headers.get('Location')).toMatch(/^\/auth\/google\/login/)
  })

  it('a signed session for an email on neither list gets nothing', async () => {
    const { res, next } = await gate('/api/sites', { cookie: await cookieFor(STRANGER) })
    expect(res.status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })
})

// ── Sign-in: the callback lets a viewer in, the same way as the owner ──────────────────────

describe('sign-in callback', () => {
  function fakeJwt(claims: Record<string, unknown>): string {
    const enc = (o: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)))
    return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.c2ln`
  }

  async function signIn(email: string, env: AuthEnv = ENV) {
    const login = await gate('/auth/google/login?next=/')
    const stateCookie = login.res.headers.getSetCookie()[0].split(';')[0]
    const google = new URL(login.res.headers.get('Location')!)
    const now = Math.floor(NOW / 1000)
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(GOOGLE_TOKEN_ENDPOINT)
      const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: '42', email, email_verified: true, nonce: google.searchParams.get('nonce'), iat: now, exp: now + 3600 }
      return new Response(JSON.stringify({ id_token: fakeJwt(claims) }), { status: 200 })
    })
    const headers = new Headers({ Cookie: stateCookie })
    const cb = new Request(`${ORIGIN}/auth/google/callback?state=${google.searchParams.get('state')}&code=abc`, { headers })
    return authGate(cb, env, async () => new Response('x'), { now: () => NOW, fetch: fetchImpl as unknown as typeof fetch })
  }

  it('a viewer gets a session; an unlisted account gets 403 "Not allowed"', async () => {
    const viewer = await signIn(VIEWER)
    expect(viewer.status).toBe(302)
    expect(viewer.headers.getSetCookie().some((c) => c.startsWith('__Host-gss_session=') && !c.startsWith('__Host-gss_session=;'))).toBe(true)
    const stranger = await signIn(STRANGER)
    expect(stranger.status).toBe(403)
    const owner = await signIn(OWNER)
    expect(owner.status).toBe(302)
  })
})

describe('functions/_middleware passes the KV binding to the gate', () => {
  it('a viewer through onRequest: GET 200, PUT 403', async () => {
    const cookie = await cookieFor(VIEWER)
    const run = async (method: string) => {
      const next = vi.fn(async () => new Response('ok'))
      const request = new Request(`${ORIGIN}/api/config`, { method, headers: { Cookie: cookie, Origin: ORIGIN }, body: method === 'GET' ? undefined : '{}' })
      const res = await onRequest({ request, env: ENV, next } as unknown as Parameters<typeof onRequest>[0])
      return { res, next }
    }
    vi.useFakeTimers({ now: NOW })
    try {
      const get = await run('GET')
      expect(get.res.status).toBe(200)
      const put = await run('PUT')
      expect(put.res.status).toBe(403)
      expect(put.next).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── The read-only query endpoints really only read ─────────────────────────────────────────

describe('VIEWER_READ_POSTS handlers write nothing', () => {
  it('no KV put/delete, no D1 write statement, no sync or service-binding call in their files', () => {
    for (const path of VIEWER_READ_POSTS) {
      const route = ROUTES.find((r) => r.path === path)!
      const src = readFileSync(route.file, 'utf8')
      expect(src, path).not.toMatch(/\.(put|delete)\(\s*[A-Za-z_'"`]/)
      expect(src, path).not.toMatch(/\b(INSERT|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|CREATE|DROP|ALTER)\b/)
      expect(src, path).not.toMatch(/ADS_SYNC|env\.LIVE|refreshAds/)
    }
  })
})
