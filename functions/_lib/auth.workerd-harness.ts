/// <reference types="@cloudflare/workers-types" />
//
// Auth-gate checks that only mean something INSIDE workerd, the Workers runtime. Node's
// fetch accepts RequestInit values that workerd rejects: `redirect: 'error'` passed every
// Node test, yet it made every production sign-in fail with a 502. auth.workerd.test.mjs
// transpiles this file and auth.ts and runs them with `workerd test` (each named export
// below is one test). It is test code and is never deployed.
//
// Every fetch() made here, including the callback's own token exchange, goes to the
// mock in auth.workerd.test.mjs (the Worker's globalOutbound), never to the network.
// The mock token endpoint replies with whatever the authorization code asks for.

import { authGate, b64urlEncode, GOOGLE_TOKEN_ENDPOINT, tokenRequestInit, type AuthEnv } from './auth'

const ORIGIN = 'https://stats.goodstuff.software'
const CLIENT_ID = 'workerd-check.apps.googleusercontent.com'
const ENV: AuthEnv = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: 'workerd-check-client-secret',
  SESSION_SECRET: 'w'.repeat(48),
  ALLOWED_EMAILS: 'owner@example.com',
}

interface MockReply {
  status: number
  headers?: Record<string, string>
  body?: string
}

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

const b64json = (value: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(value)))

/** An authorization code that makes the mock token endpoint send `reply`. */
const codeFor = (reply: MockReply) => b64json(reply)

/** A token-endpoint reply carrying an ID token that passes every claim check. */
function idTokenReply(nonce: string): MockReply {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: '42',
    email: 'owner@example.com',
    email_verified: true,
    nonce,
    iat: now,
    exp: now + 3600,
  }
  const idToken = `${b64json({ alg: 'RS256', typ: 'JWT' })}.${b64json(claims)}.c2ln`
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: 'at', id_token: idToken }),
  }
}

const next = async () => new Response('protected')

/** /auth/google/login, then the callback with a code that makes the mock token endpoint
 *  send `reply(nonce)`. No deps.fetch: the callback uses the runtime's own fetch, exactly
 *  as in production. */
async function signIn(reply: (nonce: string) => MockReply): Promise<Response> {
  const login = await authGate(new Request(`${ORIGIN}/auth/google/login?next=/dash`), ENV, next)
  check(login.status === 302, `login: expected 302, got ${login.status}`)
  const google = new URL(login.headers.get('Location') ?? '')
  const stateCookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0]
  const callback = new URL(`${ORIGIN}/auth/google/callback`)
  callback.searchParams.set('state', google.searchParams.get('state') ?? '')
  callback.searchParams.set('code', codeFor(reply(google.searchParams.get('nonce') ?? '')))
  return authGate(new Request(callback, { headers: { Cookie: stateCookie } }), ENV, next)
}

const issuesSession = (res: Response) => res.headers.getSetCookie().some((c) => /^__Host-gss_session=[^;]/.test(c))

/** The exact init the callback sends is valid here: `new Request` and `fetch` accept it,
 *  and it reaches the token endpoint as a form POST. */
export const tokenRequestInitIsValidInWorkerd = {
  async test() {
    check(navigator.userAgent === 'Cloudflare-Workers', `not running in workerd: ${navigator.userAgent}`)
    const init = tokenRequestInit({
      code: codeFor({ status: 400, body: '{"error":"invalid_grant"}' }),
      clientId: CLIENT_ID,
      clientSecret: 'workerd-check-client-secret',
      redirectUri: `${ORIGIN}/auth/google/callback`,
      codeVerifier: 'v'.repeat(43),
    })
    const request = new Request(GOOGLE_TOKEN_ENDPOINT, init) // throws on an init workerd rejects
    check(request.method === 'POST', `method is ${request.method}`)
    check(request.redirect === 'manual', `redirect is ${request.redirect}`)
    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, init)
    check(res.status === 400, `fetch: expected the mock's 400, got ${res.status}: ${await res.text()}`)
    const saw = res.headers.get('X-Mock-Saw')
    check(saw === `POST application/x-www-form-urlencoded authorization_code ${CLIENT_ID}`, `the mock saw: ${saw}`)
  },
}

/** The whole callback works on the runtime's fetch: a good token response signs in. */
export const callbackSignsInWithTheRuntimeFetch = {
  async test() {
    const res = await signIn(idTokenReply)
    const where = `${res.status} ${res.headers.get('Location')}`
    check(res.status === 302 && res.headers.get('Location') === '/dash', `expected 302 to /dash, got ${where}: ${await res.text()}`)
    check(issuesSession(res), 'no session cookie was issued')
  },
}

/** A 3xx from the token endpoint is refused, not followed, even when the redirect target
 *  would hand back an ID token that passes every check, and even when the 3xx body
 *  itself holds one: a 3xx is not ok. */
export const callbackRefusesATokenEndpointRedirect = {
  async test() {
    const res = await signIn((nonce) => ({
      status: 302,
      headers: {
        Location: `https://evil.example/token?reply=${encodeURIComponent(JSON.stringify(idTokenReply(nonce)))}`,
        'Content-Type': 'application/json',
      },
      body: idTokenReply(nonce).body,
    }))
    check(res.status === 502, `expected 502, got ${res.status} ${res.headers.get('Location')}`)
    check(!issuesSession(res), 'a session was issued from a redirected token response')
  },
}

/** Google refusing the exchange (4xx) is a 502 with no session. */
export const callbackTurnsAGoogleRejectionInto502 = {
  async test() {
    const res = await signIn(() => ({
      status: 401,
      headers: { 'Content-Type': 'application/json' },
      body: '{"error":"invalid_client"}',
    }))
    check(res.status === 502, `expected 502, got ${res.status}`)
    check(!issuesSession(res), 'a session was issued after Google refused the exchange')
  },
}
