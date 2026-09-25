/// <reference types="@cloudflare/workers-types" />
//
// Google sign-in gate for gss-stats. Every page and every /api/* route needs a
// signed-in Google account on the ALLOWED_EMAILS allowlist. Design and alternatives:
// docs/adr/0001-google-auth.md. Rollout order and owner setup: README "Auth".
//
// Shape (adapted from deckhand's core/oauth-google.mjs + routes/auth.mjs):
//   - OAuth 2.0 authorization-code flow, confidential client (the client secret is a
//     Pages secret, never sent to the browser), plus PKCE (S256) and an OIDC nonce.
//   - The login attempt's state + nonce live in a signed, HttpOnly, 10-minute cookie
//     that is cleared on every callback outcome; the PKCE verifier is derived from the
//     state with SESSION_SECRET, so it is never stored anywhere.
//   - Identity comes from the ID token Google returns on the direct, client-authenticated
//     token-endpoint exchange; iss/aud/azp/exp/iat/nonce/email_verified are all checked.
//   - The session is a STATELESS HMAC-SHA256-signed cookie (Pages has no SQLite, and one
//     allowlisted owner doesn't need a session table). The allowlist and the TTL are
//     re-checked on every request, so removing an email locks that account out at once,
//     and rotating SESSION_SECRET ends every session.
//
// FAIL CLOSED: if any required setting is missing or invalid, nobody gets in (503).
// The only way past the gate without Google is AUTH_DEV_BYPASS set to exactly "1", and
// even then only when the request host is loopback (wrangler pages dev), never a
// deployed hostname.

export interface AuthEnv {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  SESSION_SECRET?: string
  ALLOWED_EMAILS?: string
  SESSION_TTL_HOURS?: string
  AUTH_DEV_BYPASS?: string
  AUTH_DEV_EMAIL?: string
}

export interface AuthDeps {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch
  /** Injectable clock (ms since epoch) for tests. */
  now?: () => number
}

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

export const LOGIN_PATH = '/auth/google/login'
export const CALLBACK_PATH = '/auth/google/callback'
export const LOGOUT_PATH = '/auth/logout'
export const ME_PATH = '/auth/me'
export const SIGNED_OUT_PATH = '/auth/signed-out'

export const MIN_SESSION_SECRET_LENGTH = 32
export const DEFAULT_SESSION_TTL_HOURS = 168 // 7 days, deckhand's default
export const MIN_SESSION_TTL_HOURS = 1
export const MAX_SESSION_TTL_HOURS = 720 // 30 days
const STATE_TTL_SECONDS = 600 // one login attempt; deckhand's value
export const CLOCK_SKEW_SECONDS = 300
const MAX_COOKIE_TOKEN_LENGTH = 4096
const MAX_NEXT_LENGTH = 2048

// An email address is only ever compared as printable ASCII (no spaces, no controls,
// nothing non-ASCII). See isAllowedEmail for why.
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/

// Domain separation: a signed state cookie can never be replayed as a session cookie
// (or vice versa), because each purpose signs over a different prefix.
const PURPOSE_SESSION = 'gss-stats/session/v1'
const PURPOSE_STATE = 'gss-stats/oauth-state/v1'
const PURPOSE_PKCE = 'gss-stats/pkce/v1'

// ── Configuration ────────────────────────────────────────────────────────────────

export interface AuthConfig {
  clientId: string
  clientSecret: string
  sessionSecret: string
  allowedEmails: string[]
  ttlSeconds: number
}

export type ConfigResult = { ok: true; config: AuthConfig } | { ok: false; problems: string[] }

/** Deckhand's allowlist convention (DECKHAND_ADMIN_EMAILS): comma-separated,
 *  case-insensitive, exact addresses only, no wildcards. */
export function parseAllowedEmails(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** Exact, case-insensitive match: never a substring, superstring or domain match.
 *  Anything that isn't printable ASCII is refused BEFORE lower-casing, because
 *  toLowerCase() folds some non-ASCII letters onto ASCII ones (U+212A KELVIN SIGN
 *  becomes "k"), which would let a look-alike address match an allowlisted one. */
export function isAllowedEmail(email: unknown, allowed: string[]): boolean {
  if (typeof email !== 'string' || !PRINTABLE_ASCII.test(email)) return false
  return allowed.includes(email.toLowerCase())
}

/** SESSION_TTL_HOURS in hours. Unset or blank → the default. A plain decimal number
 *  from MIN to MAX → that number. Anything else (text, 0, 1e3, 0x10, over the cap) →
 *  null, which readAuthConfig reports as a configuration error, so a typo locks the
 *  gate instead of silently falling back or issuing zero-length sessions. */
export function sessionTtlHours(raw: unknown): number | null {
  const s = String(raw ?? '').trim()
  if (s === '') return DEFAULT_SESSION_TTL_HOURS
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return n >= MIN_SESSION_TTL_HOURS && n <= MAX_SESSION_TTL_HOURS ? n : null
}

/** Resolve the auth settings. Any problem → not ok, and the caller must refuse
 *  everyone (fail closed). Problems name the variable only, never its value. */
export function readAuthConfig(env: AuthEnv): ConfigResult {
  const problems: string[] = []
  const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim()
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? '').trim()
  const sessionSecret = (env.SESSION_SECRET ?? '').trim()
  const allowedEmails = parseAllowedEmails(env.ALLOWED_EMAILS)
  const ttlHours = sessionTtlHours(env.SESSION_TTL_HOURS)
  if (!clientId) problems.push('GOOGLE_CLIENT_ID is not set')
  if (!clientSecret) problems.push('GOOGLE_CLIENT_SECRET is not set')
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET is not set or shorter than ${MIN_SESSION_SECRET_LENGTH} characters`)
  }
  if (allowedEmails.length === 0) problems.push('ALLOWED_EMAILS is empty')
  // Checked on the raw entries, before parseAllowedEmails lower-cases them (see isAllowedEmail).
  const rawEntries = String(env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (rawEntries.some((e) => !PRINTABLE_ASCII.test(e))) {
    problems.push('ALLOWED_EMAILS has an entry that is not a plain ASCII address')
  }
  if (ttlHours === null) {
    problems.push(`SESSION_TTL_HOURS must be a number of hours from ${MIN_SESSION_TTL_HOURS} to ${MAX_SESSION_TTL_HOURS}`)
  }
  if (problems.length || ttlHours === null) return { ok: false, problems }
  return {
    ok: true,
    config: {
      clientId,
      clientSecret,
      sessionSecret,
      allowedEmails,
      ttlSeconds: Math.floor(ttlHours * 3600),
    },
  }
}

/** The loopback hostnames local dev uses. Must stay in step with ALLOWED_HOSTS in
 *  functions/_middleware.ts (IPv6 loopback is served by neither). */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

/** The local-dev bypass identity, or null. Needs BOTH the flag set to exactly "1" AND a
 *  loopback request host, so setting the flag on a deployed project does nothing, and
 *  "0", "false" or a stray value never switch it on. */
export function devBypassEmail(env: AuthEnv, url: URL): string | null {
  if (env.AUTH_DEV_BYPASS !== '1') return null
  if (!isLoopbackHost(url.hostname)) return null
  return (env.AUTH_DEV_EMAIL ?? '').trim().toLowerCase() || 'dev@localhost'
}

// ── Encoding + HMAC helpers (Web Crypto; no Node APIs on Pages) ─────────────────────

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  try {
    const bin = atob(padded)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return b64urlEncode(bytes)
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

/** `<base64url(JSON)>.<base64url(HMAC-SHA256(purpose + "." + payload))>` */
export async function signToken(secret: string, purpose: string, data: unknown): Promise<string> {
  const payload = b64urlEncode(encoder.encode(JSON.stringify(data)))
  const key = await hmacKey(secret)
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${purpose}.${payload}`)))
  return `${payload}.${b64urlEncode(sig)}`
}

/** Verify with crypto.subtle.verify (constant-time). Any malformation → null. */
export async function verifyToken(secret: string, purpose: string, token: unknown): Promise<unknown> {
  if (typeof token !== 'string' || !token || token.length > MAX_COOKIE_TOKEN_LENGTH) return null
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0]) return null
  const sig = b64urlDecode(parts[1])
  if (!sig || sig.length !== 32) return null
  const key = await hmacKey(secret)
  const ok = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(`${purpose}.${parts[0]}`))
  if (!ok) return null
  const body = b64urlDecode(parts[0])
  if (!body) return null
  try {
    return JSON.parse(decoder.decode(body))
  } catch {
    return null
  }
}

function sameString(a: string, b: string): boolean {
  // Length leaks nothing useful here (both sides are fixed-length random tokens).
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ── Cookies ──────────────────────────────────────────────────────────────────────

// On HTTPS the cookies carry the __Host- prefix: the browser then insists on Secure,
// Path=/ and no Domain attribute, so a sibling *.goodstuff.software site can't plant or
// overwrite them. Plain-http loopback dev can't use Secure, so it gets unprefixed names.
export function sessionCookieName(url: URL): string {
  return url.protocol === 'https:' ? '__Host-gss_session' : 'gss_session'
}
export function stateCookieName(url: URL): string {
  return url.protocol === 'https:' ? '__Host-gss_oauth' : 'gss_oauth'
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

function setCookie(url: URL, name: string, value: string, maxAgeSeconds: number): string {
  const attrs = [`${name}=${value}`, 'Path=/', `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`, 'HttpOnly', 'SameSite=Lax']
  if (url.protocol === 'https:') attrs.push('Secure')
  return attrs.join('; ')
}

function clearCookie(url: URL, name: string): string {
  return setCookie(url, name, '', 0)
}

// ── Session ──────────────────────────────────────────────────────────────────────

export interface Session {
  email: string
  sub: string
  iat: number
  exp: number
}

export async function createSessionCookie(
  url: URL,
  config: AuthConfig,
  identity: { email: string; sub: string },
  nowMs: number,
): Promise<string> {
  const iat = Math.floor(nowMs / 1000)
  const session: Session & { v: 1 } = { v: 1, email: identity.email, sub: identity.sub, iat, exp: iat + config.ttlSeconds }
  const token = await signToken(config.sessionSecret, PURPOSE_SESSION, session)
  return setCookie(url, sessionCookieName(url), token, config.ttlSeconds)
}

/** The request's valid session, or null. Valid = signature checks out, not expired
 *  under BOTH its own exp and the CURRENT TTL setting, not issued in the future (beyond
 *  a small clock skew), and the email is STILL on the allowlist. */
export async function readSession(request: Request, config: AuthConfig, nowMs: number): Promise<Session | null> {
  const url = new URL(request.url)
  const data = await verifyToken(config.sessionSecret, PURPOSE_SESSION, getCookie(request, sessionCookieName(url)))
  if (!data || typeof data !== 'object') return null
  const s = data as Record<string, unknown>
  if (s.v !== 1 || typeof s.email !== 'string' || typeof s.sub !== 'string') return null
  if (typeof s.iat !== 'number' || typeof s.exp !== 'number') return null
  const now = Math.floor(nowMs / 1000)
  if (s.exp <= now) return null
  if (s.iat > now + CLOCK_SKEW_SECONDS) return null
  if (s.iat + config.ttlSeconds <= now) return null
  if (!isAllowedEmail(s.email, config.allowedEmails)) return null
  return { email: s.email, sub: s.sub, iat: s.iat, exp: s.exp }
}

// ── OAuth flow ───────────────────────────────────────────────────────────────────

export function callbackUrl(url: URL): string {
  // Derived from the request origin. The host guard in functions/_middleware.ts only
  // lets the canonical domain (and loopback for dev) reach this code, so the only
  // production value is https://stats.goodstuff.software/auth/google/callback.
  return `${url.origin}${CALLBACK_PATH}`
}

/** A same-origin path to return to after sign-in, or '/'. Blocks open redirects
 *  (`//evil`, `/\evil`, absolute URLs) and loops back into /auth/. The result goes
 *  into a Location header, so it is made ASCII: runs outside printable ASCII (a space,
 *  non-ASCII text) are encodeURI'd, and existing %XX escapes are left untouched (a
 *  blanket encodeURI would turn them into %25XX and break the return path). */
export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_NEXT_LENGTH) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return '/'
  if (raw === '/auth' || raw.startsWith('/auth/')) return '/'
  let encoded: string
  try {
    encoded = raw.replace(/[^\x21-\x7e]+/gu, (run) => encodeURI(run))
  } catch {
    return '/' // a lone surrogate can't be encoded
  }
  return encoded.length > MAX_NEXT_LENGTH ? '/' : encoded
}

interface OAuthState {
  v: 1
  state: string
  nonce: string
  next: string
  iat: number
}

/** The PKCE code_verifier for one login attempt, derived server-side from its state
 *  (HMAC under SESSION_SECRET), so the verifier itself is never written to a cookie.
 *  32 bytes → 43 base64url chars, within RFC 7636's 43..128. */
export async function pkceVerifier(secret: string, state: string): Promise<string> {
  const key = await hmacKey(secret)
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${PURPOSE_PKCE}.${state}`))
  return b64urlEncode(new Uint8Array(mac))
}

export async function handleLogin(request: Request, config: AuthConfig, nowMs: number): Promise<Response> {
  const url = new URL(request.url)
  const pending: OAuthState = {
    v: 1,
    state: randomToken(24),
    nonce: randomToken(24),
    next: safeNext(url.searchParams.get('next')),
    iat: Math.floor(nowMs / 1000),
  }
  const verifier = await pkceVerifier(config.sessionSecret, pending.state)
  const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))
  const stateToken = await signToken(config.sessionSecret, PURPOSE_STATE, pending)

  const auth = new URL(GOOGLE_AUTH_ENDPOINT)
  auth.searchParams.set('client_id', config.clientId)
  auth.searchParams.set('redirect_uri', callbackUrl(url))
  auth.searchParams.set('response_type', 'code')
  auth.searchParams.set('scope', 'openid email')
  auth.searchParams.set('state', pending.state)
  auth.searchParams.set('nonce', pending.nonce)
  auth.searchParams.set('code_challenge', challenge)
  auth.searchParams.set('code_challenge_method', 'S256')
  auth.searchParams.set('access_type', 'online')
  auth.searchParams.set('prompt', 'select_account')

  return redirect(auth.toString(), [setCookie(url, stateCookieName(url), stateToken, STATE_TTL_SECONDS)])
}

async function readOAuthState(request: Request, config: AuthConfig, nowMs: number): Promise<OAuthState | null> {
  const url = new URL(request.url)
  const data = await verifyToken(config.sessionSecret, PURPOSE_STATE, getCookie(request, stateCookieName(url)))
  if (!data || typeof data !== 'object') return null
  const s = data as Record<string, unknown>
  if (s.v !== 1) return null
  for (const k of ['state', 'nonce', 'next'] as const) if (typeof s[k] !== 'string' || !s[k]) return null
  if (typeof s.iat !== 'number') return null
  const now = Math.floor(nowMs / 1000)
  if (s.iat > now + CLOCK_SKEW_SECONDS || s.iat + STATE_TTL_SECONDS <= now) return null
  return s as unknown as OAuthState
}

export type IdTokenResult = { ok: true; email: string; sub: string } | { ok: false; reason: string }

/** The claims of the ID token in OUR token-endpoint response, decoded WITHOUT checking
 *  its signature. That is only sound because the token arrived directly from Google's
 *  token endpoint over TLS, on a request authenticated with our client secret (OIDC
 *  Core 3.1.3.7 step 6; see the ADR). Deliberately not exported: never call this on a
 *  token that came through the browser or any other channel; verify that one against
 *  Google's JWKS instead. */
function unverifiedClaimsFromTokenEndpoint(jwt: string): Record<string, unknown> | null {
  if (typeof jwt !== 'string') return null
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  const bytes = b64urlDecode(parts[1])
  if (!bytes) return null
  try {
    const obj = JSON.parse(decoder.decode(bytes))
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
  } catch {
    return null
  }
}

export function validateIdTokenClaims(
  claims: Record<string, unknown> | null,
  expected: { clientId: string; nonce: string },
  nowMs: number,
): IdTokenResult {
  if (!claims) return { ok: false, reason: 'malformed ID token' }
  const now = Math.floor(nowMs / 1000)
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) return { ok: false, reason: 'wrong issuer' }
  const aud = claims.aud
  const audOk = aud === expected.clientId || (Array.isArray(aud) && aud.includes(expected.clientId))
  if (!audOk) return { ok: false, reason: 'wrong audience' }
  if (Array.isArray(aud) && aud.length > 1 && claims.azp !== expected.clientId) {
    return { ok: false, reason: 'wrong authorized party' }
  }
  if (claims.azp !== undefined && claims.azp !== expected.clientId) return { ok: false, reason: 'wrong authorized party' }
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= now) return { ok: false, reason: 'expired' }
  if (typeof claims.iat !== 'number' || claims.iat > now + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'issued in the future' }
  if (typeof claims.nonce !== 'string' || !sameString(claims.nonce, expected.nonce)) {
    return { ok: false, reason: 'nonce mismatch' }
  }
  if (typeof claims.sub !== 'string' || !claims.sub) return { ok: false, reason: 'missing subject' }
  if (typeof claims.email !== 'string' || !claims.email) return { ok: false, reason: 'missing email' }
  // Refused before lower-casing, which could fold a non-ASCII look-alike onto an
  // allowlisted address (see isAllowedEmail).
  if (!PRINTABLE_ASCII.test(claims.email)) return { ok: false, reason: 'email is not plain ASCII' }
  // Only a VERIFIED email is an identity claim (deckhand's rule too), and only the JSON
  // boolean true counts: never "true", "false", 1 or any other truthy value.
  if (claims.email_verified !== true) return { ok: false, reason: 'email not verified' }
  return { ok: true, email: claims.email.toLowerCase(), sub: claims.sub }
}

export interface TokenRequestParams {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  codeVerifier: string
}

/** The init for the authorization-code exchange POSTed to GOOGLE_TOKEN_ENDPOINT.
 *  `redirect: 'manual'`: the unsigned-ID-token ruling rests on TLS to THIS endpoint, so
 *  a redirect must never be followed. With 'manual', a 3xx comes back as a response that
 *  is not ok, and handleCallback refuses it (502, no session). Not 'error': the Workers
 *  runtime rejects that value with a TypeError before sending anything, so every sign-in
 *  would fail. Not omitted either: the default is 'follow'. Node accepts all three, so
 *  auth.workerd-harness.ts (run by auth.workerd.test.mjs) builds a Request and fetches
 *  from this init inside workerd. */
export function tokenRequestInit(p: TokenRequestParams): RequestInit {
  return {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: p.codeVerifier,
    }).toString(),
  }
}

export async function handleCallback(
  request: Request,
  config: AuthConfig,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url)
  // The one-time state cookie is cleared on EVERY outcome, success or failure.
  const clearState = clearCookie(url, stateCookieName(url))

  const pending = await readOAuthState(request, config, nowMs)
  const presented = url.searchParams.get('state') ?? ''
  if (!pending || !presented || !sameString(presented, pending.state)) {
    return htmlPage(
      400,
      'Sign-in expired',
      'That sign-in attempt is invalid or has expired. Please start again.',
      [clearState],
      { label: 'Sign in with Google', href: LOGIN_PATH },
    )
  }

  const googleError = url.searchParams.get('error')
  if (googleError) {
    return htmlPage(
      400,
      'Sign-in cancelled',
      `Google did not complete the sign-in (${googleError}).`,
      [clearState],
      { label: 'Try again', href: LOGIN_PATH },
    )
  }

  const code = url.searchParams.get('code')
  if (!code) {
    return htmlPage(400, 'Sign-in failed', 'Google returned no authorization code.', [clearState], {
      label: 'Try again',
      href: LOGIN_PATH,
    })
  }

  let idToken: string
  try {
    const init = tokenRequestInit({
      code,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: callbackUrl(url),
      codeVerifier: await pkceVerifier(config.sessionSecret, pending.state),
    })
    const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, init)
    // A 3xx lands here too (the request is sent with redirect: 'manual'), so a redirect
    // away from the token endpoint is refused, never followed.
    if (!res.ok) {
      console.error(`auth: token exchange failed: HTTP ${res.status}`)
      return htmlPage(502, 'Sign-in failed', 'Google rejected the sign-in (token exchange failed).', [clearState], {
        label: 'Try again',
        href: LOGIN_PATH,
      })
    }
    const json = (await res.json()) as Record<string, unknown>
    if (typeof json?.id_token !== 'string' || !json.id_token) throw new Error('no id_token in token response')
    idToken = json.id_token
  } catch (err) {
    console.error(`auth: token exchange error: ${String((err as Error)?.message ?? err)}`)
    return htmlPage(502, 'Sign-in failed', 'Could not complete the sign-in with Google.', [clearState], {
      label: 'Try again',
      href: LOGIN_PATH,
    })
  }

  const result = validateIdTokenClaims(
    unverifiedClaimsFromTokenEndpoint(idToken),
    { clientId: config.clientId, nonce: pending.nonce },
    nowMs,
  )
  if (!result.ok) {
    console.error(`auth: ID token rejected: ${result.reason}`)
    return htmlPage(401, 'Sign-in failed', 'Google’s identity token did not pass verification.', [clearState], {
      label: 'Try again',
      href: LOGIN_PATH,
    })
  }

  if (!isAllowedEmail(result.email, config.allowedEmails)) {
    return htmlPage(
      403,
      'Not allowed',
      `The Google account ${result.email} is not allowed to view this dashboard.`,
      [clearState, clearCookie(url, sessionCookieName(url))],
      { label: 'Use a different account', href: LOGIN_PATH },
    )
  }

  const sessionCookie = await createSessionCookie(url, config, result, nowMs)
  return redirect(pending.next, [clearState, sessionCookie])
}

export function handleLogout(request: Request): Response {
  const url = new URL(request.url)
  return signOutRedirect([clearCookie(url, sessionCookieName(url))])
}

/** 303 to the signed-out page. Clear-Site-Data also drops this origin's HTTP cache, so
 *  dashboard pages or data a browser kept from before can't be shown again. */
function signOutRedirect(cookies: string[]): Response {
  const res = redirect(SIGNED_OUT_PATH, cookies, 303)
  res.headers.set('Clear-Site-Data', '"cache"')
  return res
}

// ── Gate ─────────────────────────────────────────────────────────────────────────

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

/**
 * The auth gate. Runs after the host guard for EVERY request (pages, static assets,
 * /api/*, /auth/*). `next` continues to the static asset or the /api Function.
 */
export async function authGate(
  request: Request,
  env: AuthEnv,
  next: () => Promise<Response>,
  deps: AuthDeps = {},
): Promise<Response> {
  const url = new URL(request.url)
  const nowMs = (deps.now ?? Date.now)()
  // Wrapped rather than passed as a bare reference, so the runtime's fetch is always
  // invoked with the global `this` (Workers throws "Illegal invocation" otherwise).
  const fetchImpl: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init))
  const path = url.pathname
  const method = request.method.toUpperCase()

  // Never serve (or set cookies) over plain http off loopback.
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    url.protocol = 'https:'
    return Response.redirect(url.toString(), 308)
  }

  // CSRF backstop for anything that changes state (PUT /api/config, POST /auth/logout,
  // …). SameSite=Lax already keeps the cookie off cross-SITE posts; this also refuses
  // cross-ORIGIN ones from sibling *.goodstuff.software sites (same site, other origin).
  if (!isSafeMethod(method)) {
    const origin = request.headers.get('Origin')
    if (origin !== null && origin !== url.origin) {
      return jsonResponse(403, { error: 'cross-origin request refused' })
    }
  }

  // Local-dev bypass (explicit flag + loopback host only).
  const devEmail = devBypassEmail(env, url)
  if (devEmail) {
    if (path === ME_PATH) return jsonResponse(200, { email: devEmail, devBypass: true })
    if (path === LOGIN_PATH || path === CALLBACK_PATH) return redirect(safeNext(url.searchParams.get('next')))
    // POST only, as in production, so a link or prefetch can't sign out (or clear the cache).
    if (path === LOGOUT_PATH) return method === 'POST' ? signOutRedirect([]) : methodNotAllowed('POST')
    if (path === SIGNED_OUT_PATH) return signedOutPage()
    const out = gatedResponse(await next())
    out.headers.set('X-Auth-Dev-Bypass', '1')
    return out
  }

  const resolved = readAuthConfig(env)
  if (!resolved.ok) {
    console.error(`auth: refusing all requests, not configured: ${resolved.problems.join('; ')}`)
    const detail = { error: 'auth_not_configured', problems: resolved.problems }
    if (isApiPath(path) || path === ME_PATH) return jsonResponse(503, detail)
    return htmlPage(
      503,
      'Sign-in not configured',
      `This dashboard is locked because sign-in is not configured: ${resolved.problems.join('; ')}.`,
    )
  }
  const config = resolved.config

  // Public sign-in routes: the login mechanism itself can't require a session.
  if (path === LOGIN_PATH) {
    return method === 'GET' || method === 'HEAD' ? handleLogin(request, config, nowMs) : methodNotAllowed('GET')
  }
  if (path === CALLBACK_PATH) {
    return method === 'GET' ? handleCallback(request, config, nowMs, fetchImpl) : methodNotAllowed('GET')
  }
  if (path === LOGOUT_PATH) {
    return method === 'POST' ? handleLogout(request) : methodNotAllowed('POST')
  }
  if (path === SIGNED_OUT_PATH) return signedOutPage()

  const session = await readSession(request, config, nowMs)

  if (path === ME_PATH) {
    return session ? jsonResponse(200, { email: session.email, exp: session.exp }) : unauthenticated(request, url)
  }
  if (path === '/auth' || path.startsWith('/auth/')) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } })
  }

  if (session) return gatedResponse(await next())

  // No valid session. APIs get a machine-readable 401; page loads go to sign-in.
  if (isApiPath(path) || !(method === 'GET' || method === 'HEAD')) return unauthenticated(request, url)
  const loginUrl = `${LOGIN_PATH}?next=${encodeURIComponent(safeNext(path + url.search))}`
  return redirect(loginUrl, staleSessionCookies(request, url))
}

// ── Responses ────────────────────────────────────────────────────────────────────

/** Anti-framing (clickjacking): no site, same-site siblings included, may frame us.
 *  The CSP is appended, not set, so a policy the asset already carries is kept (the
 *  browser enforces every CSP header it gets). */
function denyFraming(headers: Headers): void {
  headers.append('Content-Security-Policy', "frame-ancestors 'none'")
  headers.set('X-Frame-Options', 'DENY')
}

/** Every response that passed the gate (the app shell, its static assets, /api/*):
 *  - `private, no-store` replaces Pages' `public, max-age=0, must-revalidate`, so no
 *    shared cache (e.g. a zone "Cache Everything" rule) can keep it and the browser
 *    doesn't store it, which also keeps the page out of the back/forward cache: Back
 *    after Sign out can't bring the dashboard back;
 *  - it can't be framed. */
function gatedResponse(res: Response): Response {
  const out = new Response(res.body, res)
  out.headers.set('Cache-Control', 'private, no-store')
  denyFraming(out.headers)
  return out
}

function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' })
  for (const c of cookies) headers.append('Set-Cookie', c)
  return new Response(null, { status, headers })
}

function jsonResponse(status: number, body: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  for (const c of cookies) headers.append('Set-Cookie', c)
  return new Response(JSON.stringify(body), { status, headers })
}

/** A stale/invalid session cookie, if one was presented, is cleared so the browser
 *  stops sending it. */
function staleSessionCookies(request: Request, url: URL): string[] {
  return getCookie(request, sessionCookieName(url)) !== null ? [clearCookie(url, sessionCookieName(url))] : []
}

function unauthenticated(request: Request, url: URL): Response {
  return jsonResponse(401, { error: 'unauthenticated', signIn: LOGIN_PATH }, staleSessionCookies(request, url))
}

function methodNotAllowed(allow: string): Response {
  return new Response('Method not allowed', {
    status: 405,
    headers: { Allow: allow, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  })
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function htmlPage(
  status: number,
  title: string,
  message: string,
  cookies: string[] = [],
  action?: { label: string; href: string },
): Response {
  const button = action ? `<a class="btn" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>` : ''
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Stats</title>
<style>
  :root { --bg: #faf8f5; --ink: #2b2622; --ink-2: #6b625a; --card: #fff; --amber: #d98e04; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1916; --ink: #f1ece6; --ink-2: #b3aaa0; --card: #26231f; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink);
         font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; padding: 16px; box-sizing: border-box; }
  main { background: var(--card); border-radius: 14px; padding: 28px 32px; max-width: 420px; width: 100%;
         box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: var(--ink-2); margin: 0 0 20px; overflow-wrap: anywhere; }
  .btn { display: inline-block; background: var(--amber); color: #fff; text-decoration: none; font-weight: 600;
         padding: 10px 18px; border-radius: 10px; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${button}</main></body>
</html>`
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  denyFraming(headers)
  for (const c of cookies) headers.append('Set-Cookie', c)
  return new Response(body, { status, headers })
}

function signedOutPage(): Response {
  return htmlPage(200, 'Signed out', 'You are signed out of Good Stuff Software Stats.', [], {
    label: 'Sign in with Google',
    href: LOGIN_PATH,
  })
}
