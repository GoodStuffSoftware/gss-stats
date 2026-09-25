import { describe, it, expect, vi } from 'vitest'
import {
  authGate,
  b64urlDecode,
  b64urlEncode,
  CLOCK_SKEW_SECONDS,
  createSessionCookie,
  GOOGLE_TOKEN_ENDPOINT,
  isAllowedEmail,
  parseAllowedEmails,
  readAuthConfig,
  safeNext,
  sessionTtlHours,
  signToken,
  validateIdTokenClaims,
  type AuthConfig,
  type AuthEnv,
} from './auth'
import { onRequest } from '../_middleware'

// ── Fixtures ─────────────────────────────────────────────────────────────────────

const ORIGIN = 'https://stats.goodstuff.software'
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0)
const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const SECRET = 'x'.repeat(48)

const ENV: AuthEnv = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: SECRET,
  ALLOWED_EMAILS: ' Owner@Example.com , second@example.com ',
}

function config(env: AuthEnv = ENV): AuthConfig {
  const r = readAuthConfig(env)
  if (!r.ok) throw new Error(r.problems.join('; '))
  return r.config
}

const PROTECTED_BODY = 'protected content'

function nextSpy() {
  return vi.fn(async () => new Response(PROTECTED_BODY, { status: 200 }))
}

function req(path: string, init: RequestInit & { cookie?: string } = {}, origin = ORIGIN): Request {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('Cookie', init.cookie)
  return new Request(origin + path, { ...init, headers })
}

async function gate(request: Request, env: AuthEnv = ENV, deps: Parameters<typeof authGate>[3] = {}) {
  const next = nextSpy()
  const res = await authGate(request, env, next, { now: () => NOW, ...deps })
  return { res, next }
}

/** `name=value` from a Set-Cookie header value. */
function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0]
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie()
}

async function sessionCookieFor(email: string, opts: { nowMs?: number; env?: AuthEnv } = {}): Promise<string> {
  const header = await createSessionCookie(new URL(ORIGIN), config(opts.env), { email, sub: 'sub-1' }, opts.nowMs ?? NOW)
  return cookiePair(header)
}

function fakeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)))
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.c2lnbmF0dXJl`
}

function goodClaims(nonce: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(NOW / 1000)
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: '1234567890',
    email: 'OWNER@example.com',
    email_verified: true,
    nonce,
    iat: now,
    exp: now + 3600,
    ...overrides,
  }
}

/** Start a login: returns the state cookie pair and the Google authorize URL. */
async function startLogin(next = '/') {
  const { res } = await gate(req(`/auth/google/login?next=${encodeURIComponent(next)}`))
  expect(res.status).toBe(302)
  const google = new URL(res.headers.get('Location')!)
  const stateCookie = setCookies(res).find((c) => c.startsWith('__Host-gss_oauth='))!
  return { res, google, stateCookie }
}

function tokenEndpointReturning(idToken: string | null, status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(idToken ? { access_token: 'at', id_token: idToken } : { access_token: 'at' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

async function completeLogin(
  opts: { claims?: (nonce: string) => Record<string, unknown>; next?: string; env?: AuthEnv } = {},
) {
  const { google, stateCookie } = await startLogin(opts.next)
  const state = google.searchParams.get('state')!
  const nonce = google.searchParams.get('nonce')!
  const fetchMock = tokenEndpointReturning(fakeJwt((opts.claims ?? goodClaims)(nonce)))
  const { res, next } = await gate(
    req(`/auth/google/callback?state=${state}&code=auth-code`, { cookie: cookiePair(stateCookie) }),
    opts.env ?? ENV,
    { fetch: fetchMock as unknown as typeof fetch },
  )
  return { res, next, fetchMock, google }
}

/** True when the response sets a non-empty session cookie. */
function issuesSession(res: Response): boolean {
  return setCookies(res).some((c) => /^(__Host-)?gss_session=[^;]/.test(c))
}

/** A validly signed session token with arbitrary claims, as a cookie pair. */
async function signedSession(claims: Record<string, unknown>): Promise<string> {
  return `__Host-gss_session=${await signToken(SECRET, 'gss-stats/session/v1', claims)}`
}

// ── Configuration: allowlist + fail closed ───────────────────────────────────────

describe('allowlist parsing (deckhand convention)', () => {
  it('is comma-separated, trimmed, lower-cased, exact', () => {
    expect(parseAllowedEmails(' A@x.com,b@Y.com ,, ')).toEqual(['a@x.com', 'b@y.com'])
    expect(parseAllowedEmails(undefined)).toEqual([])
  })
})

describe('allowlist matching is exact', () => {
  const allowed = parseAllowedEmails(ENV.ALLOWED_EMAILS)
  // Superstrings (contain an allowlisted address) and substrings (contained in one).
  const nearMisses = [
    'xowner@example.com',
    'owner@example.com.evil.example',
    'owner@example.comx',
    'owner@example.co',
    'wner@example.com',
    'example.com',
    '@example.com',
    'owner',
  ]

  it('matches only the exact address, case-insensitively', () => {
    expect(isAllowedEmail('owner@example.com', allowed)).toBe(true)
    expect(isAllowedEmail('OWNER@Example.COM', allowed)).toBe(true)
    for (const email of nearMisses) expect(isAllowedEmail(email, allowed), email).toBe(false)
    for (const bad of ['', undefined, null, 42]) expect(isAllowedEmail(bad, allowed)).toBe(false)
  })

  it.each(nearMisses)('callback: a verified Google account %s gets 403 and no session', async (email) => {
    const { res } = await completeLogin({ claims: (n) => goodClaims(n, { email }) })
    expect(res.status).toBe(403)
    expect(issuesSession(res)).toBe(false)
  })

  it.each(nearMisses)('readSession: a validly signed session for %s is refused', async (email) => {
    const { res, next } = await gate(req('/api/sites', { cookie: await sessionCookieFor(email) }))
    expect(res.status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('emails that are not printable ASCII are refused before comparing', () => {
  // U+212A KELVIN SIGN lower-cases to ASCII "k", so a naive toLowerCase() compare would
  // let "miKe@example.com" match an allowlisted mike@example.com.
  const KELVIN = 'miKe@example.com'
  const MIKE_ENV: AuthEnv = { ...ENV, ALLOWED_EMAILS: 'mike@example.com' }
  const mikeList = parseAllowedEmails(MIKE_ENV.ALLOWED_EMAILS)

  it('isAllowedEmail refuses the U+212A look-alike and other non-printable-ASCII forms', () => {
    expect(KELVIN.toLowerCase()).toBe('mike@example.com') // the trap being guarded against
    expect(isAllowedEmail('mike@example.com', mikeList)).toBe(true)
    for (const email of [KELVIN, ' mike@example.com', 'mike@example.com ', 'mike@example.com\u0000', 'mike@exam ple.com']) {
      expect(isAllowedEmail(email, mikeList), JSON.stringify(email)).toBe(false)
    }
  })

  it('callback: a U+212A look-alike ID-token email gets no session', async () => {
    const { res } = await completeLogin({ env: MIKE_ENV, claims: (n) => goodClaims(n, { email: KELVIN }) })
    expect(res.status).toBe(401)
    expect(issuesSession(res)).toBe(false)
    // Control: the genuine ASCII address signs in under the same allowlist.
    const ok = await completeLogin({ env: MIKE_ENV, claims: (n) => goodClaims(n, { email: 'Mike@example.com' }) })
    expect(ok.res.status).toBe(302)
    expect(issuesSession(ok.res)).toBe(true)
  })

  it('readSession: a validly signed U+212A look-alike session is refused', async () => {
    const bad = await gate(req('/api/sites', { cookie: await sessionCookieFor(KELVIN) }), MIKE_ENV)
    expect(bad.res.status).toBe(401)
    expect(bad.next).not.toHaveBeenCalled()
    const ok = await gate(req('/api/sites', { cookie: await sessionCookieFor('mike@example.com') }), MIKE_ENV)
    expect(ok.next).toHaveBeenCalledOnce()
  })

  it.each([KELVIN, 'owner @example.com', 'owner@exämple.com', 'owner@exam ple.com', 'owner@example.com\t', 'ÿowner@example.com'])(
    'the ID token check refuses %j as not plain ASCII (before any lower-casing)',
    (email) => {
      expect(validateIdTokenClaims(goodClaims('n', { email }), { clientId: CLIENT_ID, nonce: 'n' }, NOW)).toEqual({
        ok: false,
        reason: 'email is not plain ASCII',
      })
    },
  )

  it('an allowlist entry that is not plain ASCII is a configuration error (503)', async () => {
    for (const entry of [KELVIN, 'own er@example.com', 'owner@exämple.com']) {
      expect(readAuthConfig({ ...ENV, ALLOWED_EMAILS: `owner@example.com, ${entry}` }), entry).toEqual({
        ok: false,
        problems: ['ALLOWED_EMAILS has an entry that is not a plain ASCII address'],
      })
    }
    const r = readAuthConfig({ ...ENV, ALLOWED_EMAILS: `owner@example.com, ${KELVIN}` })
    expect(r).toEqual({ ok: false, problems: ['ALLOWED_EMAILS has an entry that is not a plain ASCII address'] })
    const { res, next } = await gate(req('/api/sites', { cookie: await sessionCookieFor('owner@example.com') }), {
      ...ENV,
      ALLOWED_EMAILS: KELVIN,
    })
    expect(res.status).toBe(503)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('SESSION_TTL_HOURS', () => {
  it('defaults when unset or blank, and accepts a plain number from 1 to 720', () => {
    expect(sessionTtlHours(undefined)).toBe(168)
    expect(sessionTtlHours('')).toBe(168)
    expect(sessionTtlHours('  ')).toBe(168)
    expect(sessionTtlHours(' 48 ')).toBe(48)
    expect(sessionTtlHours('1')).toBe(1)
    expect(sessionTtlHours('1.5')).toBe(1.5)
    expect(sessionTtlHours('720')).toBe(720)
    expect(readAuthConfig({ ...ENV, SESSION_TTL_HOURS: '1' })).toMatchObject({ ok: true, config: { ttlSeconds: 3600 } })
    expect(readAuthConfig({ ...ENV, SESSION_TTL_HOURS: '720' })).toMatchObject({ ok: true, config: { ttlSeconds: 720 * 3600 } })
    expect(readAuthConfig(ENV)).toMatchObject({ ok: true, config: { ttlSeconds: 168 * 3600 } })
  })

  const bad = ['abc', '12h', '0', '0.5', '0.9999', '0.0001', '-5', '721', '720.5', '1e2', '0x10', 'Infinity', 'NaN', '1,5']
  it.each(bad)('%s is a configuration error: 503, and even a valid cookie is refused', async (value) => {
    expect(sessionTtlHours(value)).toBeNull()
    const env = { ...ENV, SESSION_TTL_HOURS: value }
    expect(readAuthConfig(env)).toEqual({ ok: false, problems: ['SESSION_TTL_HOURS must be a number of hours from 1 to 720'] })
    const cookie = await sessionCookieFor('owner@example.com')
    const api = await gate(req('/api/sites', { cookie }), env)
    expect(api.res.status).toBe(503)
    expect(api.next).not.toHaveBeenCalled()
    expect(JSON.stringify(await api.res.json())).not.toContain(`"${value}"`)
    const page = await gate(req('/', { cookie }), env)
    expect(page.res.status).toBe(503)
    expect(page.next).not.toHaveBeenCalled()
  })
})

describe('fail closed when configuration is missing', () => {
  const cases: [string, AuthEnv][] = [
    ['no config at all', {}],
    ['GOOGLE_CLIENT_ID missing', { ...ENV, GOOGLE_CLIENT_ID: '' }],
    ['GOOGLE_CLIENT_SECRET missing', { ...ENV, GOOGLE_CLIENT_SECRET: undefined }],
    ['SESSION_SECRET missing', { ...ENV, SESSION_SECRET: undefined }],
    ['SESSION_SECRET too short', { ...ENV, SESSION_SECRET: 'short' }],
    ['ALLOWED_EMAILS empty', { ...ENV, ALLOWED_EMAILS: ' , ' }],
  ]
  for (const [name, env] of cases) {
    it(`${name}: API → 503 JSON, page → 503, nothing served`, async () => {
      // Even a cookie that is valid under the full config must not get through.
      const cookie = await sessionCookieFor('owner@example.com')
      const api = await gate(req('/api/stats', { method: 'POST', cookie }), env)
      expect(api.res.status).toBe(503)
      expect(api.res.headers.get('Content-Type')).toContain('application/json')
      expect(((await api.res.json()) as { error: string }).error).toBe('auth_not_configured')
      expect(api.next).not.toHaveBeenCalled()

      const page = await gate(req('/', { cookie }), env)
      expect(page.res.status).toBe(503)
      expect(page.next).not.toHaveBeenCalled()

      const login = await gate(req('/auth/google/login'), env)
      expect(login.res.status).toBe(503)
    })
  }

  it('names the missing variables but never their values', async () => {
    const { res } = await gate(req('/api/config'), { ...ENV, GOOGLE_CLIENT_ID: '' })
    const body = (await res.json()) as { problems: string[] }
    expect(body.problems).toEqual(['GOOGLE_CLIENT_ID is not set'])
    expect(JSON.stringify(body)).not.toContain(SECRET)
    expect(JSON.stringify(body)).not.toContain('test-client-secret')
  })
})

// ── 401 vs redirect ──────────────────────────────────────────────────────────────

describe('unauthenticated requests', () => {
  it('API calls get 401 JSON', async () => {
    for (const [path, method] of [
      ['/api/stats', 'POST'],
      ['/api/geo', 'POST'],
      ['/api/sites', 'GET'],
      ['/api/config', 'GET'],
      ['/api/config', 'PUT'],
      ['/api/anything-added-later', 'GET'],
    ] as const) {
      const { res, next } = await gate(req(path, { method }))
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(res.headers.get('Content-Type')).toContain('application/json')
      expect(await res.json()).toEqual({ error: 'unauthenticated', signIn: '/auth/google/login' })
      expect(next).not.toHaveBeenCalled()
    }
  })

  it('/auth/me gets 401 JSON', async () => {
    const { res } = await gate(req('/auth/me'))
    expect(res.status).toBe(401)
  })

  it('page loads and static assets redirect to sign-in, keeping the return path', async () => {
    const { res, next } = await gate(req('/?page=abc'))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/auth/google/login?next=%2F%3Fpage%3Dabc')
    expect(next).not.toHaveBeenCalled()

    const asset = await gate(req('/assets/index-abc123.js'))
    expect(asset.res.status).toBe(302)
    expect(asset.next).not.toHaveBeenCalled()
  })

  it('unknown /auth/* paths are 404, not a bypass', async () => {
    const { res, next } = await gate(req('/auth/whatever'))
    expect(res.status).toBe(404)
    expect(next).not.toHaveBeenCalled()
  })
})

// ── Sessions: valid, tampered, expired, de-listed ────────────────────────────────

describe('session cookie', () => {
  it('a valid session for an allowlisted email reaches pages and the API', async () => {
    const cookie = await sessionCookieFor('owner@example.com')
    expect(cookie.startsWith('__Host-gss_session=')).toBe(true)
    const page = await gate(req('/', { cookie }))
    expect(page.next).toHaveBeenCalledOnce()
    expect(await page.res.text()).toBe(PROTECTED_BODY)
    const api = await gate(req('/api/stats', { method: 'POST', cookie, headers: { Origin: ORIGIN } }))
    expect(api.next).toHaveBeenCalledOnce()
    const me = await gate(req('/auth/me', { cookie }))
    expect(await me.res.json()).toMatchObject({ email: 'owner@example.com' })
  })

  it('rejects a tampered payload (email swapped, signature kept)', async () => {
    const cookie = await sessionCookieFor('second@example.com')
    const [name, value] = cookie.split('=')
    const [payload, sig] = value.split('.')
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)!))
    claims.email = 'owner@example.com'
    claims.exp += 10 * 365 * 86400
    const forged = `${name}=${b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)))}.${sig}`
    const api = await gate(req('/api/config', { cookie: forged }))
    expect(api.res.status).toBe(401)
    expect(api.next).not.toHaveBeenCalled()
    // …and the bad cookie is cleared.
    expect(setCookies(api.res).some((c) => c.startsWith('__Host-gss_session=;') && c.includes('Max-Age=0'))).toBe(true)
    const page = await gate(req('/', { cookie: forged }))
    expect(page.res.status).toBe(302)
    expect(page.next).not.toHaveBeenCalled()
  })

  it('rejects a flipped signature, garbage, and an empty cookie', async () => {
    const cookie = await sessionCookieFor('owner@example.com')
    const last = cookie.at(-1) === 'A' ? 'B' : 'A'
    for (const bad of [cookie.slice(0, -1) + last, '__Host-gss_session=garbage', '__Host-gss_session=', '__Host-gss_session=a.b.c']) {
      const { res, next } = await gate(req('/api/sites', { cookie: bad }))
      expect(res.status, bad).toBe(401)
      expect(next).not.toHaveBeenCalled()
    }
  })

  it('rejects a cookie signed with a different secret (e.g. after rotation)', async () => {
    const cookie = await sessionCookieFor('owner@example.com', { env: { ...ENV, SESSION_SECRET: 'y'.repeat(48) } })
    const { res } = await gate(req('/api/sites', { cookie }))
    expect(res.status).toBe(401)
  })

  it('rejects a validly signed token minted for a different purpose (state cookie replayed as session)', async () => {
    const token = await signToken(SECRET, 'gss-stats/oauth-state/v1', {
      v: 1,
      email: 'owner@example.com',
      sub: 's',
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 3600,
    })
    const { res } = await gate(req('/api/sites', { cookie: `__Host-gss_session=${token}` }))
    expect(res.status).toBe(401)
  })

  it('rejects an expired session', async () => {
    const cookie = await sessionCookieFor('owner@example.com', { nowMs: NOW - 8 * 24 * 3600 * 1000 })
    const { res } = await gate(req('/api/sites', { cookie }))
    expect(res.status).toBe(401)
  })

  it("rejects a session past its own exp even when still inside the current TTL", async () => {
    const now = Math.floor(NOW / 1000)
    const token = await signToken(SECRET, 'gss-stats/session/v1', { v: 1, email: 'owner@example.com', sub: 's', iat: now - 60, exp: now - 1 })
    const { res } = await gate(req('/api/sites', { cookie: `__Host-gss_session=${token}` }))
    expect(res.status).toBe(401)
    // Control: the same shape with a future exp is accepted, so the rejection above is the exp check.
    const ok = await signToken(SECRET, 'gss-stats/session/v1', { v: 1, email: 'owner@example.com', sub: 's', iat: now - 60, exp: now + 60 })
    expect((await gate(req('/api/sites', { cookie: `__Host-gss_session=${ok}` }))).next).toHaveBeenCalled()
  })

  it('honours a shortened SESSION_TTL_HOURS for sessions issued under a longer one', async () => {
    const cookie = await sessionCookieFor('owner@example.com', { nowMs: NOW - 3 * 3600 * 1000 })
    expect((await gate(req('/api/sites', { cookie }))).res.status).not.toBe(401)
    expect((await gate(req('/api/sites', { cookie }), { ...ENV, SESSION_TTL_HOURS: '2' })).res.status).toBe(401)
  })

  it('locks out an email removed from the allowlist, even with a valid cookie', async () => {
    const cookie = await sessionCookieFor('second@example.com')
    expect((await gate(req('/api/sites', { cookie }))).next).toHaveBeenCalled()
    const { res, next } = await gate(req('/api/sites', { cookie }), { ...ENV, ALLOWED_EMAILS: 'owner@example.com' })
    expect(res.status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })
})

// ── The OAuth flow ───────────────────────────────────────────────────────────────

describe('Google sign-in flow', () => {
  it('login redirects to Google with state, nonce and PKCE, and sets a signed state cookie', async () => {
    const { google, stateCookie } = await startLogin('/?x=1')
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const p = google.searchParams
    expect(p.get('client_id')).toBe(CLIENT_ID)
    expect(p.get('redirect_uri')).toBe('https://stats.goodstuff.software/auth/google/callback')
    expect(p.get('response_type')).toBe('code')
    expect(p.get('scope')).toBe('openid email')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(p.get('nonce')).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(p.get('prompt')).toBe('select_account')
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) expect(stateCookie).toContain(attr)
    // The state cookie carries state + nonce + return path only: never the client secret
    // or the PKCE verifier.
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(cookiePair(stateCookie).split('=')[1].split('.')[0])!))
    expect(Object.keys(payload).sort()).toEqual(['iat', 'next', 'nonce', 'state', 'v'])
    expect(payload.state).toBe(p.get('state'))
    expect(payload.next).toBe('/?x=1')
    expect(stateCookie).not.toContain('test-client-secret')
  })

  it('callback exchanges the code with the PKCE verifier and issues a hardened session cookie', async () => {
    const { res, fetchMock, google } = await completeLogin({ next: '/?page=p2' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/?page=p2')

    // Token request: right endpoint, right params, verifier matches the challenge.
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(GOOGLE_TOKEN_ENDPOINT)
    const body = new URLSearchParams(String(init!.body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code')
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(body.get('client_secret')).toBe('test-client-secret')
    expect(body.get('redirect_uri')).toBe('https://stats.goodstuff.software/auth/google/callback')
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')!))
    expect(b64urlEncode(new Uint8Array(digest))).toBe(google.searchParams.get('code_challenge'))
    // Never follow a redirect away from the token endpoint (the unsigned-ID-token ruling
    // rests on TLS to that exact host). 'manual', not 'error': workerd rejects 'error'
    // outright (auth.workerd.test.ts proves the init inside the real runtime).
    expect(init!.method).toBe('POST')
    expect(init!.redirect).toBe('manual')

    const cookies = setCookies(res)
    const session = cookies.find((c) => c.startsWith('__Host-gss_session='))!
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${168 * 3600}`]) expect(session).toContain(attr)
    expect(session).not.toContain('Domain=')
    // State cookie is consumed.
    expect(cookies.some((c) => c.startsWith('__Host-gss_oauth=;') && c.includes('Max-Age=0'))).toBe(true)

    // And the issued cookie works.
    const me = await gate(req('/auth/me', { cookie: cookiePair(session) }))
    expect(await me.res.json()).toMatchObject({ email: 'owner@example.com' })
  })

  it('a verified Google account NOT on the allowlist gets 403 and no session', async () => {
    const { res } = await completeLogin({ claims: (n) => goodClaims(n, { email: 'stranger@gmail.com' }) })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('stranger@gmail.com')
    expect(setCookies(res).some((c) => /^__Host-gss_session=[^;]/.test(c))).toBe(false)
  })

  const badClaims: [string, (n: string) => Record<string, unknown>][] = [
    ['wrong audience', (n) => goodClaims(n, { aud: 'someone-else.apps.googleusercontent.com', azp: undefined })],
    ['wrong azp', (n) => goodClaims(n, { azp: 'someone-else' })],
    ['wrong issuer', (n) => goodClaims(n, { iss: 'https://evil.example' })],
    ['nonce mismatch', (n) => goodClaims(n, { nonce: n.split('').reverse().join('') })],
    ['unverified email', (n) => goodClaims(n, { email_verified: false })],
    ['expired ID token', (n) => goodClaims(n, { exp: Math.floor(NOW / 1000) - 3600 })],
    ['missing email', (n) => goodClaims(n, { email: undefined })],
  ]
  for (const [name, claims] of badClaims) {
    it(`rejects an ID token with ${name}`, async () => {
      const { res } = await completeLogin({ claims })
      expect(res.status).toBe(401)
      expect(setCookies(res).some((c) => /^__Host-gss_session=[^;]/.test(c))).toBe(false)
    })
  }

  it('rejects a callback whose state does not match the cookie, without calling Google', async () => {
    const { stateCookie } = await startLogin()
    const fetchMock = tokenEndpointReturning('unused')
    const { res } = await gate(
      req('/auth/google/callback?state=attacker-state&code=c', { cookie: cookiePair(stateCookie) }),
      ENV,
      { fetch: fetchMock as unknown as typeof fetch },
    )
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a callback with no state cookie (login CSRF), and an expired one', async () => {
    const fetchMock = tokenEndpointReturning('unused')
    const noCookie = await gate(req('/auth/google/callback?state=s&code=c'), ENV, { fetch: fetchMock as unknown as typeof fetch })
    expect(noCookie.res.status).toBe(400)

    const { google, stateCookie } = await startLogin()
    const late = await gate(
      req(`/auth/google/callback?state=${google.searchParams.get('state')}&code=c`, { cookie: cookiePair(stateCookie) }),
      ENV,
      { fetch: fetchMock as unknown as typeof fetch, now: () => NOW + 11 * 60 * 1000 },
    )
    expect(late.res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a failed token exchange is a 502, not a session', async () => {
    const { google, stateCookie } = await startLogin()
    const fetchMock = tokenEndpointReturning(null, 400)
    const { res } = await gate(
      req(`/auth/google/callback?state=${google.searchParams.get('state')}&code=c`, { cookie: cookiePair(stateCookie) }),
      ENV,
      { fetch: fetchMock as unknown as typeof fetch },
    )
    expect(res.status).toBe(502)
    expect(setCookies(res).some((c) => /^__Host-gss_session=[^;]/.test(c))).toBe(false)
  })

  it('a redirect from the token endpoint is refused (502, no session), never followed', async () => {
    const { google, stateCookie } = await startLogin()
    // Even a 3xx whose body holds a valid ID token is refused: it is not ok.
    const body = JSON.stringify({ id_token: fakeJwt(goodClaims(google.searchParams.get('nonce')!)) })
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(body, { status: 302, headers: { Location: 'https://evil.example/token', 'Content-Type': 'application/json' } }),
    )
    const { res } = await gate(
      req(`/auth/google/callback?state=${google.searchParams.get('state')}&code=c`, { cookie: cookiePair(stateCookie) }),
      ENV,
      { fetch: fetchMock as unknown as typeof fetch },
    )
    expect(res.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(issuesSession(res)).toBe(false)
  })
})

describe('validateIdTokenClaims', () => {
  const expected = { clientId: CLIENT_ID, nonce: 'n' }
  const now = Math.floor(NOW / 1000)

  it('accepts the legacy issuer form', () => {
    const r = validateIdTokenClaims(goodClaims('n', { iss: 'accounts.google.com' }), expected, NOW)
    expect(r).toEqual({ ok: true, email: 'owner@example.com', sub: '1234567890' })
  })

  it.each([['true'], ['false'], ['False'], [1], [0], [null], [undefined], ['yes'], [{}], [[true]]])(
    'refuses email_verified = %j (only the boolean true counts)',
    (value) => {
      expect(validateIdTokenClaims(goodClaims('n', { email_verified: value }), expected, NOW)).toEqual({
        ok: false,
        reason: 'email not verified',
      })
    },
  )

  it('a multi-audience token needs azp equal to our client ID', () => {
    const other = 'other-client.apps.googleusercontent.com'
    for (const azp of [undefined, other, '']) {
      expect(validateIdTokenClaims(goodClaims('n', { aud: [CLIENT_ID, other], azp }), expected, NOW), String(azp)).toEqual({
        ok: false,
        reason: 'wrong authorized party',
      })
    }
    expect(validateIdTokenClaims(goodClaims('n', { aud: [CLIENT_ID, other], azp: CLIENT_ID }), expected, NOW).ok).toBe(true)
    // A single-element array is just our audience; azp is optional there.
    expect(validateIdTokenClaims(goodClaims('n', { aud: [CLIENT_ID], azp: undefined }), expected, NOW).ok).toBe(true)
    expect(validateIdTokenClaims(goodClaims('n', { aud: [other], azp: undefined }), expected, NOW)).toEqual({
      ok: false,
      reason: 'wrong audience',
    })
  })

  it(`refuses an iat more than ${CLOCK_SKEW_SECONDS}s in the future, and a missing iat`, () => {
    const at = (iat: unknown) => validateIdTokenClaims(goodClaims('n', { iat, exp: now + 7200 }), expected, NOW)
    expect(at(now + CLOCK_SKEW_SECONDS).ok).toBe(true)
    for (const iat of [now + CLOCK_SKEW_SECONDS + 1, now + 3600, undefined, String(now)]) {
      expect(at(iat), String(iat)).toEqual({ ok: false, reason: 'issued in the future' })
    }
  })
})

describe('ID token checks, end to end through the callback', () => {
  const now = Math.floor(NOW / 1000)
  const other = 'other-client.apps.googleusercontent.com'
  const refused: [string, (n: string) => Record<string, unknown>][] = [
    ['email_verified "false"', (n) => goodClaims(n, { email_verified: 'false' })],
    ['email_verified "true" (a string)', (n) => goodClaims(n, { email_verified: 'true' })],
    ['email_verified 1', (n) => goodClaims(n, { email_verified: 1 })],
    ['email_verified missing', (n) => goodClaims(n, { email_verified: undefined })],
    ['aud [ours, other] with no azp', (n) => goodClaims(n, { aud: [CLIENT_ID, other], azp: undefined })],
    ['aud [ours, other] with azp other', (n) => goodClaims(n, { aud: [CLIENT_ID, other], azp: other })],
    ['iat an hour in the future', (n) => goodClaims(n, { iat: now + 3600, exp: now + 7200 })],
  ]
  it.each(refused)('%s → 401, no session', async (_name, claims) => {
    const { res } = await completeLogin({ claims })
    expect(res.status).toBe(401)
    expect(issuesSession(res)).toBe(false)
  })

  it('aud [ours, other] with azp = ours signs in (control)', async () => {
    const { res } = await completeLogin({ claims: (n) => goodClaims(n, { aud: [CLIENT_ID, other], azp: CLIENT_ID }) })
    expect(res.status).toBe(302)
    expect(issuesSession(res)).toBe(true)
  })
})

describe('session iat in the future', () => {
  const now = Math.floor(NOW / 1000)
  const base = { v: 1, email: 'owner@example.com', sub: 's' }

  it(`is refused beyond ${CLOCK_SKEW_SECONDS}s of skew, and accepted within it`, async () => {
    for (const iat of [now + CLOCK_SKEW_SECONDS + 1, now + 3600]) {
      const { res, next } = await gate(req('/api/sites', { cookie: await signedSession({ ...base, iat, exp: iat + 3600 }) }))
      expect(res.status, String(iat - now)).toBe(401)
      expect(next).not.toHaveBeenCalled()
    }
    const ok = await gate(req('/api/sites', { cookie: await signedSession({ ...base, iat: now + CLOCK_SKEW_SECONDS, exp: now + 3600 }) }))
    expect(ok.next).toHaveBeenCalledOnce()
  })
})

// ── Sign-out, CSRF, open redirects, transport ────────────────────────────────────

describe('sign-out', () => {
  it('POST clears the session cookie and lands on the signed-out page', async () => {
    const cookie = await sessionCookieFor('owner@example.com')
    const { res } = await gate(req('/auth/logout', { method: 'POST', cookie, headers: { Origin: ORIGIN } }))
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/auth/signed-out')
    const cleared = setCookies(res).find((c) => c.startsWith('__Host-gss_session='))!
    expect(cleared).toContain('Max-Age=0')
    const page = await gate(req('/auth/signed-out'))
    expect(page.res.status).toBe(200)
    expect(page.next).not.toHaveBeenCalled()
  })

  it('GET /auth/logout is refused (405)', async () => {
    const { res } = await gate(req('/auth/logout'))
    expect(res.status).toBe(405)
  })

  it('a cross-origin logout is refused', async () => {
    const { res } = await gate(req('/auth/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } }))
    expect(res.status).toBe(403)
  })
})

describe('response headers: no caching, no framing (review F2 + F9)', () => {
  /** What Pages' asset server sends for the app shell and hashed assets. */
  function pagesAsset(body: string, contentType: string, extra: Record<string, string> = {}): () => Promise<Response> {
    return async () =>
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: '"e1"', ...extra },
      })
  }

  async function gateWith(request: Request, upstream: () => Promise<Response>, env: AuthEnv = ENV) {
    const next = vi.fn(upstream)
    const res = await authGate(request, env, next, { now: () => NOW })
    return { res, next }
  }

  function expectGatedHeaders(res: Response, label: string) {
    expect(res.headers.get('Cache-Control'), label).toBe('private, no-store')
    expect(res.headers.get('Content-Security-Policy'), label).toContain("frame-ancestors 'none'")
    expect(res.headers.get('X-Frame-Options'), label).toBe('DENY')
  }

  it('the app shell, a static asset and an API response are private, no-store and unframeable', async () => {
    const cookie = await sessionCookieFor('owner@example.com')
    const cases: [Request, () => Promise<Response>, string][] = [
      [req('/', { cookie }), pagesAsset('<!doctype html>app', 'text/html; charset=utf-8'), 'text/html; charset=utf-8'],
      [req('/assets/index-abc123.js', { cookie }), pagesAsset('console.log(1)', 'application/javascript'), 'application/javascript'],
      [
        req('/api/stats', { method: 'POST', cookie, headers: { Origin: ORIGIN } }),
        async () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }),
        'application/json',
      ],
    ]
    for (const [request, upstream, contentType] of cases) {
      const { res, next } = await gateWith(request, upstream)
      const label = new URL(request.url).pathname
      expect(next, label).toHaveBeenCalledOnce()
      expect(res.status, label).toBe(200)
      expectGatedHeaders(res, label)
      // Everything else about the upstream response is passed through untouched.
      expect(res.headers.get('Content-Type'), label).toBe(contentType)
      expect((await res.text()).length, label).toBeGreaterThan(0)
    }
    const shell = await gateWith(req('/', { cookie }), pagesAsset('<!doctype html>app', 'text/html'))
    expect(shell.res.headers.get('ETag')).toBe('"e1"')
    expect(await shell.res.text()).toBe('<!doctype html>app')
  })

  it("keeps a CSP the asset already has, adding frame-ancestors 'none' alongside it", async () => {
    const cookie = await sessionCookieFor('owner@example.com')
    const { res } = await gateWith(
      req('/', { cookie }),
      pagesAsset('<html>', 'text/html', { 'Content-Security-Policy': "default-src 'self'" }),
    )
    const csp = res.headers.get('Content-Security-Policy')!
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('works on an upstream response with immutable headers (e.g. a redirect)', async () => {
    const cookie = await sessionCookieFor('owner@example.com')
    const { res } = await gateWith(req('/index.html', { cookie }), async () => Response.redirect(`${ORIGIN}/`, 308))
    expect(res.status).toBe(308)
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/`)
    expectGatedHeaders(res, 'redirect')
  })

  it('the dev bypass sends the same headers', async () => {
    const { res } = await gateWith(req('/', {}, 'http://localhost:8788'), pagesAsset('<html>', 'text/html'), { AUTH_DEV_BYPASS: '1' })
    expect(res.headers.get('X-Auth-Dev-Bypass')).toBe('1')
    expectGatedHeaders(res, 'bypass')
  })

  it('the gate’s own HTML pages (signed out, not allowed, not configured) are unframeable', async () => {
    const signedOut = (await gate(req('/auth/signed-out'))).res
    const notAllowed = (await completeLogin({ claims: (n) => goodClaims(n, { email: 'stranger@gmail.com' }) })).res
    const notConfigured = (await gate(req('/'), {})).res
    for (const [label, res] of [['signed-out', signedOut], ['403', notAllowed], ['503', notConfigured]] as const) {
      expect(res.headers.get('Content-Type'), label).toContain('text/html')
      expect(res.headers.get('Content-Security-Policy'), label).toContain("frame-ancestors 'none'")
      expect(res.headers.get('X-Frame-Options'), label).toBe('DENY')
      expect(res.headers.get('Cache-Control'), label).toBe('no-store')
    }
  })

  it('sign-out tells the browser to drop its cache for the site (and so does the dev-bypass sign-out)', async () => {
    const cookie = await sessionCookieFor('owner@example.com')
    const { res } = await gate(req('/auth/logout', { method: 'POST', cookie, headers: { Origin: ORIGIN } }))
    expect(res.status).toBe(303)
    expect(res.headers.get('Clear-Site-Data')).toBe('"cache"')
    const dev = await gate(req('/auth/logout', { method: 'POST' }, 'http://localhost:8788'), { AUTH_DEV_BYPASS: '1' })
    expect(dev.res.status).toBe(303)
    expect(dev.res.headers.get('Clear-Site-Data')).toBe('"cache"')
  })

  it('Clear-Site-Data is sent only by the sign-out redirect, never by any other response', async () => {
    // Clearing the cache on, say, every 401 would cost the owner a full reload each time.
    const cookie = await sessionCookieFor('owner@example.com')
    const LOCAL = 'http://localhost:8788'
    const BYPASS: AuthEnv = { AUTH_DEV_BYPASS: '1' }
    const cases: [string, number, Response][] = [
      ['API with no session (401 JSON)', 401, (await gate(req('/api/sites'))).res],
      ['page with no session (302 to sign-in)', 302, (await gate(req('/'))).res],
      ['page with a stale cookie (302 to sign-in)', 302, (await gate(req('/', { cookie: '__Host-gss_session=junk.junk' }))).res],
      ['gated app shell', 200, (await gateWith(req('/', { cookie }), pagesAsset('<html>', 'text/html'))).res],
      ['gated API', 200, (await gate(req('/api/sites', { cookie }))).res],
      ['/auth/me signed in', 200, (await gate(req('/auth/me', { cookie }))).res],
      ['/auth/me signed out', 401, (await gate(req('/auth/me'))).res],
      ['login (302 to Google)', 302, (await gate(req('/auth/google/login'))).res],
      ['callback success (302 with a session)', 302, (await completeLogin()).res],
      ['callback, account not allowed', 403, (await completeLogin({ claims: (n) => goodClaims(n, { email: 'x@gmail.com' }) })).res],
      ['callback with no state cookie', 400, (await gate(req('/auth/google/callback?state=s&code=c'))).res],
      ['signed-out page', 200, (await gate(req('/auth/signed-out'))).res],
      ['cross-origin sign-out (403)', 403, (await gate(req('/auth/logout', { method: 'POST', cookie, headers: { Origin: 'https://evil.example' } }))).res],
      ['GET /auth/logout (405)', 405, (await gate(req('/auth/logout', { cookie }))).res],
      ['not configured (503)', 503, (await gate(req('/'), {})).res],
      ['dev bypass: gated page', 200, (await gate(req('/', {}, LOCAL), BYPASS)).res],
      ['dev bypass: /auth/me', 200, (await gate(req('/auth/me', {}, LOCAL), BYPASS)).res],
      ['dev bypass: GET /auth/logout (405)', 405, (await gate(req('/auth/logout', {}, LOCAL), BYPASS)).res],
    ]
    for (const [label, status, res] of cases) {
      expect(res.status, label).toBe(status)
      expect(res.headers.get('Clear-Site-Data'), label).toBeNull()
    }
  })
})

describe('cross-origin writes', () => {
  it('refuses a cross-origin PUT even with a valid session (sibling subdomain case)', async () => {
    const cookie = await sessionCookieFor('owner@example.com')
    const { res, next } = await gate(
      req('/api/config', { method: 'PUT', cookie, headers: { Origin: 'https://www.goodstuff.software' }, body: '{}' }),
    )
    expect(res.status).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('safeNext (open-redirect guard)', () => {
  it.each([
    ['/', '/'],
    ['/?page=x', '/?page=x'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['/auth/google/login', '/'],
    ['/a\nb', '/'],
    [null, '/'],
    // Location must be ASCII: non-ASCII and spaces are encoded, existing escapes kept.
    ['/中', '/%E4%B8%AD'],
    ['/a b?q=é', '/a%20b?q=%C3%A9'],
    ['/?q=a%20b&x=%2F#h', '/?q=a%20b&x=%2F#h'],
    ['/%E4%B8%AD', '/%E4%B8%AD'],
    ['/\uD800', '/'], // a lone surrogate can't be encoded
    ['/' + '中'.repeat(700), '/'], // fits before encoding, too long after
  ])('%s → %s', (input, expected) => {
    expect(safeNext(input as string | null)).toBe(expected)
  })

  it('the post-sign-in Location is ASCII even for a non-ASCII next', async () => {
    const { google, stateCookie } = await startLogin('/中?q=é')
    const fetchMock = tokenEndpointReturning(fakeJwt(goodClaims(google.searchParams.get('nonce')!)))
    const { res } = await gate(
      req(`/auth/google/callback?state=${google.searchParams.get('state')}&code=c`, { cookie: cookiePair(stateCookie) }),
      ENV,
      { fetch: fetchMock as unknown as typeof fetch },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/%E4%B8%AD?q=%C3%A9')
  })

  it('login ignores a hostile next and returns to /', async () => {
    const { google, stateCookie } = await startLogin('//evil.example/phish')
    const fetchMock = tokenEndpointReturning(fakeJwt(goodClaims(google.searchParams.get('nonce')!)))
    const { res } = await gate(
      req(`/auth/google/callback?state=${google.searchParams.get('state')}&code=c`, { cookie: cookiePair(stateCookie) }),
      ENV,
      { fetch: fetchMock as unknown as typeof fetch },
    )
    expect(res.headers.get('Location')).toBe('/')
  })
})

describe('transport', () => {
  it('redirects plain http to https off loopback', async () => {
    const { res, next } = await gate(req('/api/sites', {}, 'http://stats.goodstuff.software'))
    expect(res.status).toBe(308)
    expect(res.headers.get('Location')).toBe('https://stats.goodstuff.software/api/sites')
    expect(next).not.toHaveBeenCalled()
  })
})

// ── Local-dev bypass ─────────────────────────────────────────────────────────────

describe('local dev bypass', () => {
  const LOCAL = 'http://localhost:8788'

  it('is OFF by default: loopback without the flag and without config is refused', async () => {
    const { res, next } = await gate(req('/api/sites', {}, LOCAL), {})
    expect(res.status).toBe(503)
    expect(next).not.toHaveBeenCalled()
  })

  it('AUTH_DEV_BYPASS=1 on loopback lets requests through with no Google config', async () => {
    const { res, next } = await gate(req('/api/sites', {}, LOCAL), { AUTH_DEV_BYPASS: '1' })
    expect(next).toHaveBeenCalledOnce()
    expect(res.headers.get('X-Auth-Dev-Bypass')).toBe('1')
    const me = await gate(req('/auth/me', {}, LOCAL), { AUTH_DEV_BYPASS: '1' })
    expect(await me.res.json()).toEqual({ email: 'dev@localhost', devBypass: true })
  })

  it('AUTH_DEV_BYPASS=1 is ignored on the production host', async () => {
    const api = await gate(req('/api/sites'), { ...ENV, AUTH_DEV_BYPASS: '1' })
    expect(api.res.status).toBe(401)
    expect(api.next).not.toHaveBeenCalled()
    const unconfigured = await gate(req('/api/sites'), { AUTH_DEV_BYPASS: '1' })
    expect(unconfigured.res.status).toBe(503)
  })

  it.each(['0', 'false', 'true', 'TRUE', 'yes', 'on', ' ', '', ' 1', '1 ', '01', '1.0'])(
    'AUTH_DEV_BYPASS=%j leaves the bypass off (only exactly "1" turns it on)',
    async (flag) => {
      const { res, next } = await gate(req('/api/sites', {}, LOCAL), { AUTH_DEV_BYPASS: flag })
      expect(res.status).toBe(503)
      expect(res.headers.get('X-Auth-Dev-Bypass')).toBeNull()
      expect(next).not.toHaveBeenCalled()
      const me = await gate(req('/auth/me', {}, LOCAL), { AUTH_DEV_BYPASS: flag })
      expect(me.res.status).toBe(503)
    },
  )

  it('the dev-bypass sign-out is POST-only, as in production (GET is 405, cache untouched)', async () => {
    const get = await gate(req('/auth/logout', {}, LOCAL), { AUTH_DEV_BYPASS: '1' })
    expect(get.res.status).toBe(405)
    expect(get.res.headers.get('Allow')).toBe('POST')
    expect(get.res.headers.get('Clear-Site-Data')).toBeNull()
    const head = await gate(req('/auth/logout', { method: 'HEAD' }, LOCAL), { AUTH_DEV_BYPASS: '1' })
    expect(head.res.status).toBe(405)
    const post = await gate(req('/auth/logout', { method: 'POST' }, LOCAL), { AUTH_DEV_BYPASS: '1' })
    expect(post.res.status).toBe(303)
    expect(post.res.headers.get('Location')).toBe('/auth/signed-out')
  })

  it('IPv6 loopback ([::1]) is not treated as loopback: no bypass, no plain-http', async () => {
    const { res, next } = await gate(req('/api/sites', {}, 'http://[::1]:8788'), { AUTH_DEV_BYPASS: '1' })
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toBe(308)
    expect(res.headers.get('Location')).toBe('https://[::1]:8788/api/sites')
  })

  it('without the flag, loopback runs the real flow with non-__Host- cookies over http', async () => {
    const { res } = await gate(req('/auth/google/login', {}, LOCAL))
    expect(new URL(res.headers.get('Location')!).searchParams.get('redirect_uri')).toBe(
      'http://localhost:8788/auth/google/callback',
    )
    const state = setCookies(res)[0]
    expect(state.startsWith('gss_oauth=')).toBe(true)
    expect(state).not.toContain('Secure')
  })
})

// ── The middleware wiring (host guard → auth gate) ───────────────────────────────

describe('functions/_middleware onRequest', () => {
  function ctx(request: Request, env: AuthEnv) {
    const next = nextSpy()
    return { ctx: { request, env, next } as unknown as Parameters<typeof onRequest>[0], next }
  }

  it('404s non-canonical hosts (pages.dev, previews) before auth', async () => {
    const { ctx: c, next } = ctx(new Request('https://feat-google-auth.gss-stats.pages.dev/'), ENV)
    const res = await onRequest(c)
    expect(res.status).toBe(404)
    expect(next).not.toHaveBeenCalled()
  })

  it('404s IPv6 loopback, even with the dev bypass on', async () => {
    const { ctx: c, next } = ctx(new Request('http://[::1]:8788/api/sites'), { AUTH_DEV_BYPASS: '1' })
    const res = await onRequest(c)
    expect(res.status).toBe(404)
    expect(next).not.toHaveBeenCalled()
  })

  it('gates the canonical host', async () => {
    const { ctx: c, next } = ctx(new Request(`${ORIGIN}/api/stats`, { method: 'POST' }), ENV)
    const res = await onRequest(c)
    expect(res.status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })
})
