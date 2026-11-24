// Gmail connect + callback flow (receipts stage 8). Emails are made up (example.com); the session secret
// is generated at run time. The Worker behind the RECEIPTS binding is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pkceVerifier, b64urlEncode, signToken } from './auth'
import { finishConnect, startConnect, connectCookieName, type ReceiptsConnectEnv } from './gmailConnect'

const ORIGIN = 'https://stats.goodstuff.software'
const ME = 'kristen@example.com'
const OTHER = 'mike@example.com'
const SECRET = b64urlEncode(crypto.getRandomValues(new Uint8Array(48)))
const COOKIE = connectCookieName(new URL(ORIGIN))

interface Harness {
  env: ReceiptsConnectEnv
  exchange: ReturnType<typeof vi.fn>
  kv: Map<string, string>
}

function harness(reply: unknown = { ok: true }): Harness {
  const kv = new Map<string, string>()
  const exchange = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(reply)))
  const env = {
    SESSION_SECRET: SECRET,
    RECEIPTS_GMAIL_CLIENT_ID: 'test-gmail-client.apps.googleusercontent.com',
    RECEIPTS: { fetch: exchange } as unknown as Fetcher,
    STATS_CONFIG: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
    },
  } as unknown as ReceiptsConnectEnv
  return { env, exchange, kv }
}

const post = (consent: unknown) =>
  new Request(`${ORIGIN}/api/budget/email/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ consent }),
  })

/** Start a connect as `email`; returns the auth URL and the state cookie pair. */
async function start(h: Harness, email = ME, now = Date.now()) {
  const res = await startConnect(post(1), h.env, email, now)
  expect(res.status).toBe(200)
  const url = new URL(((await res.json()) as { url: string }).url)
  const cookie = res.headers.get('Set-Cookie')!.split(';')[0]
  return { url, cookie }
}

const callback = (query: string, cookie?: string) =>
  new Request(`${ORIGIN}/api/budget/email/callback?${query}`, { headers: cookie ? { Cookie: cookie } : {} })

const codeOf = (res: Response) => new URL(res.headers.get('Location')!, ORIGIN).searchParams.get('email')

const logs: string[] = []
beforeEach(() => {
  logs.length = 0
  for (const m of ['info', 'error', 'log', 'warn'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')))
})
afterEach(() => vi.restoreAllMocks())

describe('connect', () => {
  it('needs the consent version', async () => {
    const h = harness()
    for (const c of [undefined, 0, 2, '1', null]) expect((await startConnect(post(c), h.env, ME, Date.now())).status).toBe(400)
    expect((await startConnect(post(1), h.env, ME, Date.now())).status).toBe(200)
  })

  it('builds the Google request: scope, offline, consent, PKCE S256, nonce, separate client', async () => {
    const { url, cookie } = await start(harness())
    const p = url.searchParams
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(p.get('client_id')).toBe('test-gmail-client.apps.googleusercontent.com')
    expect(p.get('scope')).toBe('openid email https://www.googleapis.com/auth/gmail.readonly')
    expect(p.get('access_type')).toBe('offline')
    expect(p.get('prompt')).toBe('consent')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('redirect_uri')).toBe(`${ORIGIN}/api/budget/email/callback`)
    expect(p.get('nonce')).toBeTruthy()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(await pkceVerifier(SECRET, p.get('state')!)))
    expect(p.get('code_challenge')).toBe(b64urlEncode(new Uint8Array(digest)))
    expect(cookie.startsWith(`${COOKIE}=`)).toBe(true)
  })

  it('missing config is a fixed code, never a stack', async () => {
    for (const drop of ['RECEIPTS', 'RECEIPTS_GMAIL_CLIENT_ID', 'SESSION_SECRET'] as const) {
      const h = harness()
      delete (h.env as unknown as Record<string, unknown>)[drop]
      const res = await startConnect(post(1), h.env, ME, Date.now())
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'receipts_not_configured' })
    }
  })
})

describe('callback', () => {
  it('success: the Worker gets the code, the derived PKCE verifier and the nonce; the redirect has only a code', async () => {
    const h = harness()
    const { url, cookie } = await start(h)
    const res = await finishConnect(callback(`code=abc123&state=${url.searchParams.get('state')}`, cookie), h.env, ME, Date.now())
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/?section=budget&b_page=receipts&email=connected')
    expect(res.headers.get('Set-Cookie')).toMatch(/Max-Age=0/)
    const [target, init] = h.exchange.mock.calls[0] as [string, RequestInit]
    expect(target).toBe('https://receipts.internal/exchange')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      code: 'abc123',
      nonce: url.searchParams.get('nonce'),
      ownerEmail: ME,
      consentVersion: 1,
      redirectUri: `${ORIGIN}/api/budget/email/callback`,
    })
    expect(body.verifier).toBe(await pkceVerifier(SECRET, url.searchParams.get('state')!))
  })

  it('a tampered cookie, a mismatched state param, no cookie, no state: state_invalid, no exchange', async () => {
    const h = harness()
    const { url, cookie } = await start(h)
    const state = url.searchParams.get('state')!
    const flipped = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA')
    const cases: Array<[string, string | undefined]> = [
      [`code=x&state=${state}`, flipped],
      [`code=x&state=${state}x`, cookie],
      [`code=x&state=${state}`, undefined],
      ['code=x', cookie],
    ]
    for (const [q, c] of cases) expect(codeOf(await finishConnect(callback(q, c), h.env, ME, Date.now()))).toBe('state_invalid')
    expect(h.exchange).not.toHaveBeenCalled()
  })

  it('a cookie signed for another purpose (the sign-in state) is refused', async () => {
    const h = harness()
    const forged = await signToken(SECRET, 'gss-stats/oauth-state/v1', { v: 1, state: 's', nonce: 'n', email: ME, cv: 1, iat: Math.floor(Date.now() / 1000) })
    expect(codeOf(await finishConnect(callback('code=x&state=s', `${COOKIE}=${forged}`), h.env, ME, Date.now()))).toBe('state_invalid')
  })

  it('expiry: fine inside 10 minutes, refused after', async () => {
    const t0 = Date.now()
    const h = harness()
    const a = await start(h, ME, t0)
    expect(codeOf(await finishConnect(callback(`code=x&state=${a.url.searchParams.get('state')}`, a.cookie), h.env, ME, t0 + 599_000))).toBe('connected')
    const h2 = harness()
    const b = await start(h2, ME, t0)
    expect(codeOf(await finishConnect(callback(`code=x&state=${b.url.searchParams.get('state')}`, b.cookie), h2.env, ME, t0 + 601_000))).toBe('state_invalid')
    expect(h2.exchange).not.toHaveBeenCalled()
  })

  it("another Budget person's state is refused", async () => {
    const h = harness()
    const { url, cookie } = await start(h, OTHER)
    const res = await finishConnect(callback(`code=x&state=${url.searchParams.get('state')}`, cookie), h.env, ME, Date.now())
    expect(codeOf(res)).toBe('state_invalid')
    expect(h.exchange).not.toHaveBeenCalled()
  })

  it('a state is single use even when the cookie is replayed', async () => {
    const h = harness()
    const { url, cookie } = await start(h)
    const req = () => callback(`code=x&state=${url.searchParams.get('state')}`, cookie)
    expect(codeOf(await finishConnect(req(), h.env, ME, Date.now()))).toBe('connected')
    expect(codeOf(await finishConnect(req(), h.env, ME, Date.now()))).toBe('state_used')
    expect(h.exchange).toHaveBeenCalledOnce()
  })

  it('Worker failure codes pass through only from the allowlist (invalid_grant included)', async () => {
    const cases: Array<[unknown, string]> = [
      [{ ok: false, code: 'invalid_grant' }, 'invalid_grant'],
      [{ ok: false, code: 'scope_missing' }, 'scope_missing'],
      [{ ok: false, code: 'user@example.com' }, 'exchange_failed'],
      [{ ok: false, code: 'connected' }, 'exchange_failed'],
      ['garbage', 'exchange_failed'],
    ]
    for (const [reply, want] of cases) {
      const h = harness(reply)
      const { url, cookie } = await start(h)
      const res = await finishConnect(callback(`code=x&state=${url.searchParams.get('state')}`, cookie), h.env, ME, Date.now())
      expect(codeOf(res)).toBe(want)
    }
  })

  it('a throwing binding and a Google error are codes, not stacks', async () => {
    const h = harness()
    h.exchange.mockRejectedValue(new Error('boom at /secret/path'))
    const a = await start(h)
    expect(codeOf(await finishConnect(callback(`code=x&state=${a.url.searchParams.get('state')}`, a.cookie), h.env, ME, Date.now()))).toBe('exchange_failed')
    const b = await start(h)
    expect(codeOf(await finishConnect(callback(`error=access_denied&state=${b.url.searchParams.get('state')}`, b.cookie), h.env, ME, Date.now()))).toBe('denied')
    const c = await start(h)
    expect(codeOf(await finishConnect(callback(`error=who%40example.com&state=${c.url.searchParams.get('state')}`, c.cookie), h.env, ME, Date.now()))).toBe('google_error')
  })

  it('missing config redirects with not_configured', async () => {
    const h = harness()
    const { url, cookie } = await start(h)
    delete (h.env as unknown as Record<string, unknown>).RECEIPTS
    expect(codeOf(await finishConnect(callback(`code=x&state=${url.searchParams.get('state')}`, cookie), h.env, ME, Date.now()))).toBe('not_configured')
  })

  it('no token, email, code or state appears in any redirect URL or log line', async () => {
    const h = harness({ ok: false, code: 'invalid_grant' })
    const { url, cookie } = await start(h)
    const state = url.searchParams.get('state')!
    const res = await finishConnect(callback(`code=SECRETCODE&state=${state}`, cookie), h.env, ME, Date.now())
    const loc = res.headers.get('Location')!
    for (const needle of ['SECRETCODE', state, url.searchParams.get('nonce')!, ME, '@', 'token']) {
      expect(loc).not.toContain(needle)
      for (const line of logs) expect(line).not.toContain(needle)
    }
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.every((l) => /^receipts: (connect|callback) [a-z_]+$/.test(l))).toBe(true)
  })
})
