// POST /exchange (Service Binding RECEIPTS): the Gmail connect token exchange (plan section 1; stage 8 callback).
//
// The Pages callback has verified its state cookie and relays {code, verifier, nonce, ownerEmail, consentVersion,
// redirectUri}. Here, and only here, the client secret, the AES key and the refresh token exist:
//   1. ownerEmail must be on RECEIPTS_ALLOWED_EMAILS (before any call to Google).
//   2. code + PKCE verifier + client secret -> Google's token endpoint (redirect: 'manual', never followed).
//   3. id_token claims checked with the shared validateIdTokenClaims: iss, aud/azp, exp, iat, nonce, sub, email,
//      email_verified === true. The signature is NOT checked, and no JWKS is fetched: the token came straight from
//      Google's token endpoint over TLS on a request authenticated with our client secret, which OIDC Core 3.1.3.7
//      step 6 allows in place of a signature check (the same ruling the sign-in path in functions/_lib/auth.ts
//      rests on). This token never leaves this function.
//   4. granted scope must include gmail.readonly; a refresh token is required.
//   5. The refresh token is encrypted with encryptToken(token, connectionId, key) (AAD = connection id) and the
//      email_connections row is created or updated. The Google email need not equal ownerEmail: the row is keyed
//      by ownerEmail (the signed-in Budget person) and records google_sub.
// Any failure after Google issued tokens revokes what it issued (best effort). Replies {ok:true} or {ok:false, code}
// with a code from CONNECT_CODES (functions/_lib/gmailConnect.ts). Logs and replies carry codes and counts only:
// never a token, code, email or Google response body.
//
// Single use: stage 8's STATS_CONFIG marker is eventually consistent, and the schema (0004) has no table or column
// for an atomic used-state record, so this handler cannot add a D1 guard without a schema change. Google's
// authorization code is single use, and a replayed code comes back invalid_grant, which maps to `invalid_grant`.
// That is the backstop; see the report for the proposed table.

import {
  GOOGLE_TOKEN_ENDPOINT,
  b64urlDecode,
  isAllowedEmail,
  parseAllowedEmails,
  tokenRequestInit,
  validateIdTokenClaims,
} from '../../../functions/_lib/auth'
import type { ConnectCode } from '../../../functions/_lib/gmailConnect'
import { GMAIL_SCOPE } from './gmail'
import { logReceipts, readSecret, revokeAtGoogle, type ReceiptsSecretsEnv } from './disconnect'
import { encryptToken, TokenCryptoError } from './tokenCrypto'

const MAX_FIELD = 2048
const MAX_SCOPES_COLUMN = 512

type ExchangeResult = { ok: true } | { ok: false; code: ConnectCode }

const reply = (r: ExchangeResult): Response =>
  new Response(JSON.stringify(r), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

function claimsOf(jwt: unknown): Record<string, unknown> | null {
  if (typeof jwt !== 'string') return null
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  const bytes = b64urlDecode(parts[1])
  if (!bytes) return null
  try {
    const obj = JSON.parse(new TextDecoder().decode(bytes))
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function newConnectionId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8))
  return 'c' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

interface ExchangeBody {
  code: string
  verifier: string
  nonce: string
  ownerEmail: string
  consentVersion: number
  redirectUri: string
}

function parseBody(raw: unknown): ExchangeBody | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  for (const k of ['code', 'verifier', 'nonce', 'ownerEmail', 'redirectUri'] as const) {
    const v = o[k]
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_FIELD) return null
  }
  const cv = o.consentVersion
  if (typeof cv !== 'number' || !Number.isInteger(cv) || cv < 1 || cv > 1000) return null
  try {
    new URL(o.redirectUri as string)
  } catch {
    return null
  }
  return o as unknown as ExchangeBody
}

/** Create the owner's connection, or update it in place on a reconnect (same id, so the AAD stays valid). */
async function storeConnection(
  env: ReceiptsSecretsEnv,
  key: string,
  b: ExchangeBody,
  googleSub: string,
  scopes: string,
  refreshToken: string,
  now: Date,
): Promise<void> {
  const ownerEmail = b.ownerEmail.toLowerCase()
  const stamp = now.toISOString()
  const db = env.BUDGET_DB
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await db
      .prepare('SELECT id FROM email_connections WHERE owner_email = ?1')
      .bind(ownerEmail)
      .first<{ id: string }>()
    if (existing) {
      const enc = await encryptToken(refreshToken, existing.id, key)
      await db
        .prepare(
          `UPDATE email_connections SET google_sub = ?2, status = 'active', token_ct = ?3, token_iv = ?4, key_id = ?5, scopes = ?6,
             consent_version = ?7, consented_at = ?8, last_error = NULL, updated_at = ?8 WHERE id = ?1`,
        )
        .bind(existing.id, googleSub, enc.token_ct, enc.token_iv, enc.key_id, scopes, b.consentVersion, stamp)
        .run()
      return
    }
    const id = newConnectionId()
    const enc = await encryptToken(refreshToken, id, key)
    try {
      await db
        .prepare(
          `INSERT INTO email_connections (id, owner_email, google_sub, status, token_ct, token_iv, key_id, scopes, consent_version, consented_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9)`,
        )
        .bind(id, ownerEmail, googleSub, enc.token_ct, enc.token_iv, enc.key_id, scopes, b.consentVersion, stamp)
        .run()
      return
    } catch (err) {
      // A concurrent connect for the same owner won the UNIQUE(owner_email) race: loop once and update that row.
      if (attempt === 1) throw err
    }
  }
}

export async function handleExchange(request: Request, env: ReceiptsSecretsEnv): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  const fail = (code: ConnectCode): Response => {
    logReceipts('exchange', code)
    return reply({ ok: false, code })
  }

  let body: ExchangeBody | null = null
  try {
    body = parseBody(await request.json())
  } catch {
    body = null
  }
  if (!body) return fail('exchange_failed')

  const [clientId, clientSecret, key, allowedRaw] = await Promise.all([
    readSecret(env.RECEIPTS_GMAIL_CLIENT_ID),
    readSecret(env.RECEIPTS_GMAIL_CLIENT_SECRET),
    readSecret(env.RECEIPTS_TOKEN_KEY),
    readSecret(env.RECEIPTS_ALLOWED_EMAILS),
  ])
  if (!clientId || !clientSecret || !key || !allowedRaw) return fail('not_configured')
  if (!isAllowedEmail(body.ownerEmail, parseAllowedEmails(allowedRaw))) return fail('not_allowed')

  // Google token endpoint.
  let tokens: Record<string, unknown>
  try {
    const res = await fetch(
      GOOGLE_TOKEN_ENDPOINT,
      tokenRequestInit({
        code: body.code,
        clientId,
        clientSecret,
        redirectUri: body.redirectUri,
        codeVerifier: body.verifier,
      }),
    )
    if (!res.ok) {
      let google = ''
      try {
        const e = (await res.json()) as Record<string, unknown>
        google = typeof e?.error === 'string' ? e.error : ''
      } catch {
        // no body
      }
      return fail(res.status === 400 && google === 'invalid_grant' ? 'invalid_grant' : 'exchange_failed')
    }
    tokens = (await res.json()) as Record<string, unknown>
  } catch {
    return fail('exchange_failed')
  }

  const refreshToken = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : ''
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : ''
  // Whatever Google issued, a failure below takes it back.
  const failAndRevoke = async (code: ConnectCode): Promise<Response> => {
    const issued = refreshToken || accessToken
    if (issued) await revokeAtGoogle(issued)
    return fail(code)
  }

  const verdict = validateIdTokenClaims(claimsOf(tokens?.id_token), { clientId, nonce: body.nonce }, Date.now())
  if (!verdict.ok) return failAndRevoke('token_invalid')
  if (verdict.sub.length > 255) return failAndRevoke('token_invalid')

  const granted = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : []
  if (!granted.includes(GMAIL_SCOPE)) return failAndRevoke('scope_missing')
  if (!refreshToken) return failAndRevoke('no_refresh_token')

  const scopeText = granted.join(' ')
  try {
    await storeConnection(
      env,
      key,
      body,
      verdict.sub,
      scopeText.length <= MAX_SCOPES_COLUMN ? scopeText : GMAIL_SCOPE,
      refreshToken,
      new Date(),
    )
  } catch (err) {
    if (err instanceof TokenCryptoError) return failAndRevoke('not_configured')
    return failAndRevoke('exchange_failed')
  }
  logReceipts('exchange', 'connected')
  return reply({ ok: true })
}
