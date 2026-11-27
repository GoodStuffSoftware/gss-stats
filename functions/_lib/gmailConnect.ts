/// <reference types="@cloudflare/workers-types" />
//
// Gmail connect for Budget receipts (docs/adr/0008-email-receipts.md, plan section 4). Pages only starts
// the redirect and relays the one-time code: the Gmail client secret, the AES key and every token live in
// the gss-budget-receipts Worker, reached through the RECEIPTS Service Binding (POST /exchange). The Worker
// checks the token response (id_token audience and nonce, granted scope, refresh token present), encrypts
// the refresh token with the connection id as AAD and stores only the ciphertext.
//
// The state cookie is signed with its own purpose, carries the signed-in Budget email, expires in 10
// minutes, and is single use (cleared on every outcome, plus a server-side used marker in STATS_CONFIG).
// Nothing but a status code ever goes into a redirect URL or a log line.

import {
  GOOGLE_AUTH_ENDPOINT,
  MIN_SESSION_SECRET_LENGTH,
  b64urlEncode,
  clearCookie,
  getCookie,
  pkceVerifier,
  randomToken,
  sameString,
  setCookie,
  signToken,
  verifyToken,
  CLOCK_SKEW_SECONDS,
} from './auth'
import { budgetJson, noStore, type BudgetEnv } from './budgetAccess'

/** The consent wording version the Connect step shows ("Receipts you connect are also shown to the other Budget person." is v1). */
export const CONSENT_VERSION = 1
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
export const CONNECT_CALLBACK_PATH = '/api/budget/email/callback'
export const RECEIPTS_PAGE = '/?section=budget&b_page=receipts'
export const EXCHANGE_URL = 'https://receipts.internal/exchange'
const PURPOSE = 'gss-stats/gmail-connect/v1'
const STATE_TTL_SECONDS = 600
const USED_PREFIX = 'gmail-state-used:'

/** The KV slice the one-use marker needs (STATS_CONFIG is a real KV namespace; the viewer type only declares get). */
export interface UsedStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export interface ReceiptsConnectEnv extends BudgetEnv {
  /** Pages secret: the Gmail OAuth client id (public identifier, but kept out of the repo). */
  RECEIPTS_GMAIL_CLIENT_ID?: string
  /** Service Binding to the gss-budget-receipts Worker (root wrangler.toml [[services]]). */
  RECEIPTS?: Fetcher
}

/** The codes a callback redirect may carry in `email=`. Anything else becomes `exchange_failed`. */
export const CONNECT_CODES = [
  'connected',
  'denied',
  'google_error',
  'state_invalid',
  'state_used',
  'not_configured',
  'invalid_grant',
  'scope_missing',
  'no_refresh_token',
  'token_invalid',
  'not_allowed',
  'exchange_failed',
] as const
export type ConnectCode = (typeof CONNECT_CODES)[number]
const CODE_SET: ReadonlySet<string> = new Set(CONNECT_CODES)

/** Counts and codes only. The one console use in the connect path. */
export function logConnect(event: string, code: string): void {
  console.info(`receipts: ${event} ${code}`)
}

interface ConnectState {
  v: 1
  state: string
  nonce: string
  email: string
  cv: number
  iat: number
}

export function connectCookieName(url: URL): string {
  return url.protocol === 'https:' ? '__Host-gss_gmail' : 'gss_gmail'
}

function configured(env: ReceiptsConnectEnv): { clientId: string; secret: string; binding: Fetcher } | null {
  const clientId = (env.RECEIPTS_GMAIL_CLIENT_ID ?? '').trim()
  const secret = env.SESSION_SECRET ?? ''
  if (!clientId || secret.length < MIN_SESSION_SECRET_LENGTH || !env.RECEIPTS) return null
  return { clientId, secret, binding: env.RECEIPTS }
}

async function readConsent(request: Request): Promise<number | null> {
  try {
    const type = request.headers.get('Content-Type') ?? ''
    if (type.includes('application/json')) {
      const body = (await request.json()) as { consent?: unknown }
      return typeof body?.consent === 'number' ? body.consent : null
    }
    const form = await request.formData()
    const n = Number(form.get('consent'))
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

/** POST /api/budget/email/connect: returns {url} for Google and sets the state cookie. */
export async function startConnect(request: Request, env: ReceiptsConnectEnv, email: string, nowMs: number): Promise<Response> {
  const cfg = configured(env)
  if (!cfg) {
    logConnect('connect', 'not_configured')
    return budgetJson(503, { error: 'receipts_not_configured' })
  }
  if ((await readConsent(request)) !== CONSENT_VERSION) return budgetJson(400, { error: 'consent_required' })

  const url = new URL(request.url)
  const pending: ConnectState = {
    v: 1,
    state: randomToken(24),
    nonce: randomToken(24),
    email,
    cv: CONSENT_VERSION,
    iat: Math.floor(nowMs / 1000),
  }
  const verifier = await pkceVerifier(cfg.secret, pending.state)
  const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const stateToken = await signToken(cfg.secret, PURPOSE, pending)

  const auth = new URL(GOOGLE_AUTH_ENDPOINT)
  auth.searchParams.set('client_id', cfg.clientId)
  auth.searchParams.set('redirect_uri', `${url.origin}${CONNECT_CALLBACK_PATH}`)
  auth.searchParams.set('response_type', 'code')
  auth.searchParams.set('scope', `openid email ${GMAIL_SCOPE}`)
  auth.searchParams.set('state', pending.state)
  auth.searchParams.set('nonce', pending.nonce)
  auth.searchParams.set('code_challenge', challenge)
  auth.searchParams.set('code_challenge_method', 'S256')
  auth.searchParams.set('access_type', 'offline')
  auth.searchParams.set('prompt', 'consent')
  auth.searchParams.set('login_hint', email)

  logConnect('connect', 'started')
  return budgetJson(200, { url: auth.toString() }, { 'Set-Cookie': setCookie(url, connectCookieName(url), stateToken, STATE_TTL_SECONDS) })
}

async function readState(request: Request, secret: string, nowMs: number): Promise<ConnectState | null> {
  const url = new URL(request.url)
  const data = await verifyToken(secret, PURPOSE, getCookie(request, connectCookieName(url)))
  if (!data || typeof data !== 'object') return null
  const s = data as Record<string, unknown>
  if (s.v !== 1 || s.cv !== CONSENT_VERSION) return null
  for (const k of ['state', 'nonce', 'email'] as const) if (typeof s[k] !== 'string' || !s[k]) return null
  if (typeof s.iat !== 'number') return null
  const now = Math.floor(nowMs / 1000)
  if (s.iat > now + CLOCK_SKEW_SECONDS || s.iat + STATE_TTL_SECONDS <= now) return null
  return s as unknown as ConnectState
}

function back(url: URL, code: ConnectCode): Response {
  logConnect('callback', code)
  const res = new Response(null, {
    status: 302,
    headers: { Location: `${RECEIPTS_PAGE}&email=${code}` },
  })
  res.headers.append('Set-Cookie', clearCookie(url, connectCookieName(url))) // cleared on every outcome
  return noStore(res)
}

/** GET /api/budget/email/callback: Google returns here. Always a 302 to the Receipts page with a status code. */
export async function finishConnect(request: Request, env: ReceiptsConnectEnv, email: string, nowMs: number): Promise<Response> {
  const url = new URL(request.url)
  const cfg = configured(env)
  if (!cfg) return back(url, 'not_configured')

  const pending = await readState(request, cfg.secret, nowMs)
  const presented = url.searchParams.get('state') ?? ''
  // The state must be ours, unexpired, presented back unchanged, and minted for THIS signed-in Budget email.
  if (!pending || !presented || !sameString(presented, pending.state) || pending.email !== email) return back(url, 'state_invalid')

  const googleError = url.searchParams.get('error')
  if (googleError) return back(url, googleError === 'access_denied' ? 'denied' : 'google_error')
  const code = url.searchParams.get('code')
  if (!code) return back(url, 'google_error')

  // Single use: mark the state used before the exchange (fail closed when the store is unavailable).
  const store = env.STATS_CONFIG as unknown as UsedStore | undefined
  if (!store || typeof store.put !== 'function') return back(url, 'not_configured')
  try {
    if (await store.get(USED_PREFIX + pending.state)) return back(url, 'state_used')
    await store.put(USED_PREFIX + pending.state, '1', { expirationTtl: 3600 })
  } catch {
    return back(url, 'exchange_failed')
  }

  let result: unknown
  try {
    const res = await bindingFetch(cfg.binding, EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        verifier: await pkceVerifier(cfg.secret, pending.state),
        nonce: pending.nonce,
        ownerEmail: email,
        consentVersion: pending.cv,
        redirectUri: `${url.origin}${CONNECT_CALLBACK_PATH}`,
      }),
    }, BINDING_TIMEOUT_MS.exchange)
    result = await res.json()
  } catch {
    return back(url, 'exchange_failed')
  }
  const r = (result ?? {}) as { ok?: unknown; code?: unknown }
  if (r.ok === true) return back(url, 'connected')
  return back(url, typeof r.code === 'string' && CODE_SET.has(r.code) && r.code !== 'connected' ? (r.code as ConnectCode) : 'exchange_failed')
}

/** Time limits for the Pages-to-Worker calls (ms): sync answers 202 at once; disconnect waits on Google's revoke; the exchange talks to Google twice; an upload or image call moves one small JPEG. */
export const BINDING_TIMEOUT_MS = { sync: 8_000, disconnect: 10_000, exchange: 20_000, upload: 15_000 } as const

/** Service Binding fetch with a hard time limit (abort signal plus a race, in case the binding ignores the signal). Rejects on timeout. */
export async function bindingFetch(binding: { fetch: (url: string, init?: RequestInit) => Promise<Response> }, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort()
      reject(new Error('binding_timeout'))
    }, ms)
  })
  try {
    return await Promise.race([binding.fetch(url, { ...init, signal: ctl.signal }), timeout])
  } finally {
    clearTimeout(timer)
  }
}
