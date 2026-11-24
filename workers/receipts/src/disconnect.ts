// POST /disconnect (Service Binding RECEIPTS): revoke one connection's refresh token at Google, best effort.
// The Pages route does every D1 write (status 'revoked', token columns NULL, optional purge); this only revokes.
// Reply: 200 {revoked: boolean}. Never a token, email or Google body in a response or a log line. Counts and codes only.

import { decryptToken } from './tokenCrypto'
import { loadConnection } from './store'

export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

/** A Secrets Store binding (await env.X.get()). */
export interface SecretBinding {
  get(): Promise<string>
}

export interface ReceiptsSecretsEnv {
  BUDGET_DB: D1Database
  RECEIPTS_GMAIL_CLIENT_ID?: SecretBinding
  RECEIPTS_GMAIL_CLIENT_SECRET?: SecretBinding
  RECEIPTS_TOKEN_KEY?: SecretBinding
  RECEIPTS_TOKEN_KEY_OLD?: SecretBinding
  RECEIPTS_ALLOWED_EMAILS?: SecretBinding
}

/** A secret's value, or '' when the binding is missing, empty or unreadable. */
export async function readSecret(b: SecretBinding | undefined): Promise<string> {
  if (!b || typeof b.get !== 'function') return ''
  try {
    return String((await b.get()) ?? '').trim()
  } catch {
    return ''
  }
}

/** Counts and codes only. */
export function logReceipts(event: string, code: string): void {
  console.info(`receipts: ${event} ${code}`)
}

/** Revoke a token at Google. True only when Google answers 2xx; any failure is false, never thrown. */
export async function revokeAtGoogle(token: string): Promise<boolean> {
  try {
    const res = await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    })
    return res.ok
  } catch {
    return false
  }
}

const CONNECTION_ID = /^c[0-9a-f]{16}$/
const reply = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export async function handleDisconnect(request: Request, env: ReceiptsSecretsEnv): Promise<Response> {
  if (request.method !== 'POST') return reply(405, { revoked: false })
  let connectionId = ''
  try {
    const body = (await request.json()) as Record<string, unknown>
    if (typeof body?.connectionId === 'string') connectionId = body.connectionId
  } catch {
    // falls through to the 400 below
  }
  if (!CONNECTION_ID.test(connectionId)) {
    logReceipts('disconnect', 'bad_request')
    return reply(400, { revoked: false })
  }

  const key = await readSecret(env.RECEIPTS_TOKEN_KEY)
  if (!key) {
    logReceipts('disconnect', 'not_configured')
    return reply(200, { revoked: false, code: 'not_configured' })
  }
  const keyOld = await readSecret(env.RECEIPTS_TOKEN_KEY_OLD)

  try {
    const row = await loadConnection(env.BUDGET_DB, connectionId)
    if (!row || !row.tokenCt || !row.tokenIv || !row.keyId) {
      logReceipts('disconnect', 'no_token')
      return reply(200, { revoked: false })
    }
    const { plaintext } = await decryptToken(
      { token_ct: row.tokenCt, token_iv: row.tokenIv, key_id: row.keyId },
      row.id,
      { current: key, old: keyOld || null },
    )
    const revoked = await revokeAtGoogle(plaintext)
    logReceipts('disconnect', revoked ? 'revoked' : 'revoke_failed')
    return reply(200, { revoked })
  } catch {
    logReceipts('disconnect', 'revoke_failed')
    return reply(200, { revoked: false })
  }
}
