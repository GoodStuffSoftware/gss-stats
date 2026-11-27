// POST /webhook (plan section 3.3): Plaid's signed webhook. The only path here that is not an owner route: it proves
// itself with Plaid's JWT (Plaid [P6], https://plaid.com/docs/api/webhooks/webhook-verification/) and does nothing else
// unauthenticated. Verification takes the raw body BYTES (no JSON round trip before hashing). Every verification
// failure is a bare 401 (Plaid does not retry 4xx); a key fetch that could not reach Plaid is a 503 so Plaid retries.
// Logs: counts and codes only.
import type { RouteInput } from './index'
import { LIVE_STATUSES, openToken, readKeys, type ItemRow } from './store'
import { PlaidError, PlaidTimeoutError, createPlaidClient, type PlaidClient } from './plaid'
import { planDeps, reply, type BankDeps } from './exchange'
import { log } from './log'
import { releasedStamp } from './sync'

const IAT_WINDOW_SECONDS = 300
const KID = /^[A-Za-z0-9_-]{1,64}$/
const KEY_CACHE_MAX = 16
const NEGATIVE_TTL_MS = 60_000

interface CachedKey {
  key: CryptoKey
  /** Unix seconds, or null when Plaid sets no expiry. */
  expiredAt: number | null
}
const keyCache = new Map<string, CachedKey>()
const unknownKids = new Map<string, number>() // kid -> ms until which a refetch is skipped

/** Test hook: forget every cached verification key. */
export function clearKeyCache(): void {
  keyCache.clear()
  unknownKids.clear()
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

function b64urlJson(s: string): Record<string, unknown> | null {
  const bytes = b64urlBytes(s)
  if (!bytes) return null
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const hexOf = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')

/** Constant-time equality of two strings (the length is not secret here: both are 64 hex chars when honest). */
function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

/** Why a webhook was not accepted: 'bad' (401) or 'unavailable' (503, Plaid could not be asked for the key). */
type Verdict = 'ok' | 'bad' | 'unavailable'

async function keyFor(kid: string, plaid: PlaidClient, nowMs: number): Promise<CachedKey | 'bad' | 'unavailable'> {
  const hit = keyCache.get(kid)
  if (hit) return hit
  if ((unknownKids.get(kid) ?? 0) > nowMs) return 'bad'
  let res: { key?: Record<string, unknown> }
  try {
    res = await plaid.post<{ key?: Record<string, unknown> }>('/webhook_verification_key/get', { key_id: kid })
  } catch (e) {
    if (e instanceof PlaidError && e.type !== 'CONFIG' && e.type !== 'NETWORK' && e.status >= 400 && e.status < 500) {
      if (unknownKids.size >= KEY_CACHE_MAX * 2) unknownKids.clear()
      unknownKids.set(kid, nowMs + NEGATIVE_TTL_MS)
      return 'bad'
    }
    if (e instanceof PlaidError || e instanceof PlaidTimeoutError) return 'unavailable'
    throw e
  }
  const jwk = res.key
  if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return 'bad'
  const expiredAt = typeof jwk.expired_at === 'number' && Number.isFinite(jwk.expired_at) ? jwk.expired_at : null
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  } catch {
    return 'bad'
  }
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear()
  const entry = { key, expiredAt }
  keyCache.set(kid, entry)
  return entry
}

/**
 * Verify a Plaid webhook: ES256 JWT in the plaid-verification header, key by kid from Plaid, signature over
 * `header.payload`, iat within five minutes, and request_body_sha256 equal to the SHA-256 of the raw body bytes.
 */
export async function verifyWebhook(rawBody: Uint8Array<ArrayBuffer>, header: string | null, plaid: PlaidClient, now: Date): Promise<Verdict> {
  if (!header) return 'bad'
  const parts = header.split('.')
  if (parts.length !== 3) return 'bad'
  const head = b64urlJson(parts[0])
  const payload = b64urlJson(parts[1])
  const sig = b64urlBytes(parts[2])
  if (!head || !payload || !sig) return 'bad'
  if (head.alg !== 'ES256') return 'bad'
  const kid = head.kid
  if (typeof kid !== 'string' || !KID.test(kid)) return 'bad'
  if (sig.byteLength !== 64) return 'bad'

  const entry = await keyFor(kid, plaid, now.getTime())
  if (entry === 'bad' || entry === 'unavailable') return entry
  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (entry.expiredAt !== null && entry.expiredAt <= nowSeconds) return 'bad'

  let valid = false
  try {
    valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, entry.key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  } catch {
    return 'bad'
  }
  if (!valid) return 'bad'

  const iat = payload.iat
  if (typeof iat !== 'number' || !Number.isFinite(iat) || Math.abs(nowSeconds - iat) > IAT_WINDOW_SECONDS) return 'bad'
  const claimed = payload.request_body_sha256
  if (typeof claimed !== 'string') return 'bad'
  const actual = hexOf(await crypto.subtle.digest('SHA-256', rawBody))
  return timingSafeEqual(claimed.toLowerCase(), actual) ? 'ok' : 'bad'
}

/** An Item is working again (LOGIN_REPAIRED, or the daily reconnect check): active, error cleared, sync due now. */
export async function markRepaired(db: D1Database, itemId: string, now: Date): Promise<number> {
  const at = now.toISOString()
  const r = await db
    .prepare(
      `UPDATE bank_items SET status = 'active', last_error = NULL, sync_requested_at = ?2, updated_at = ?2,
        last_sync_at = CASE WHEN last_sync_at > ?3 THEN ?3 ELSE last_sync_at END
        WHERE id = ?1 AND status IN ('needs_reconnect','pending_disconnect')`,
    )
    .bind(itemId, at, releasedStamp(now))
    .run()
  return r.meta?.changes ?? 0
}

/** The wipes shared by an unlink and a revoked Item: no token material, no cursor, accounts off, liabilities gone. */
export function wipeItemStatements(db: D1Database, itemId: string, status: 'revoked' | 'removed', now: Date): D1PreparedStatement[] {
  const at = now.toISOString()
  return [
    db.prepare(`DELETE FROM bank_liabilities WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE item_id = ?1)`).bind(itemId),
    db.prepare(`UPDATE bank_accounts SET sync = 'off', updated_at = ?2 WHERE item_id = ?1 AND sync <> 'off'`).bind(itemId, at),
    db
      .prepare(
        `UPDATE bank_items SET status = ?2, token_ct = NULL, token_iv = NULL, key_id = NULL, sync_cursor = NULL, sync_cursor_base = NULL, updated_at = ?3
          WHERE id = ?1`,
      )
      .bind(itemId, status, at),
  ]
}

const okReply = (code?: string): Response => reply(200, code ? { ok: true, code } : { ok: true })
const isLive = (s: string): boolean => (LIVE_STATUSES as readonly string[]).includes(s)

async function revoke(db: D1Database, item: ItemRow, plaid: PlaidClient, input: RouteInput, now: Date): Promise<void> {
  // The user already withdrew access at their bank, so the removal is best effort; the wipe happens either way.
  let code = 'removed'
  try {
    const keys = await readKeys(input.env)
    if (!keys) throw new Error('no_keys')
    const token = await openToken(item, keys)
    await plaid.post('/item/remove', { access_token: token, reason_code: 'OTHER' })
  } catch (e) {
    code = e instanceof PlaidError ? `plaid_${e.type.toLowerCase()}` : e instanceof PlaidTimeoutError ? 'plaid_timeout' : 'remove_skipped'
  }
  await db.batch(wipeItemStatements(db, item.id, 'revoked', now))
  log('webhook_revoked', {}, code)
}

export async function handleWebhook(input: RouteInput, deps: Partial<BankDeps> = {}): Promise<Response> {
  const { env } = input
  const { fetch: doFetch, now } = planDeps(deps)
  const db = env.BUDGET_DB
  const t = now()
  const plaid = createPlaidClient({ env, fetch: doFetch, now })

  const verdict = await verifyWebhook(input.bytes ?? new Uint8Array(0), input.request.headers.get('plaid-verification'), plaid, t)
  if (verdict === 'bad') {
    log('webhook_rejected', {}, 'bad_signature')
    return reply(401, { ok: false, code: 'bad_signature' })
  }
  if (verdict === 'unavailable') {
    log('webhook_rejected', {}, 'key_unavailable')
    return reply(503, { ok: false, code: 'key_unavailable' })
  }

  let hook: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(input.bytes))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return okReply('ignored')
    hook = parsed as Record<string, unknown>
  } catch {
    return okReply('ignored')
  }
  if (hook.environment !== env.PLAID_ENV) {
    log('webhook_ignored', {}, 'environment_mismatch')
    return okReply('environment_mismatch')
  }
  const plaidItemId = hook.item_id
  if (typeof plaidItemId !== 'string' || plaidItemId.length < 1 || plaidItemId.length > 64) return okReply('unknown_item')
  const item = await db
    .prepare('SELECT id, owner_email, environment, status, token_ct, token_iv, key_id FROM bank_items WHERE plaid_item_id = ?1')
    .bind(plaidItemId)
    .first<ItemRow>()
  if (!item || item.environment !== env.PLAID_ENV) {
    log('webhook_ignored', {}, 'unknown_item')
    return okReply('unknown_item')
  }
  if (!isLive(item.status)) return okReply('item_inactive')

  const type = hook.webhook_type
  const wcode = hook.webhook_code
  const at = t.toISOString()
  const errorCode = (hook.error as { error_code?: unknown } | null | undefined)?.error_code
  const run = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).run()
  let handled = ''

  if (type === 'TRANSACTIONS' && wcode === 'SYNC_UPDATES_AVAILABLE') {
    await run(
      `UPDATE bank_items SET sync_requested_at = ?2, last_webhook_at = ?2, updated_at = ?2,
              initial_done = MAX(initial_done, ?3), historical_done = MAX(historical_done, ?4) WHERE id = ?1`,
      item.id, at, hook.initial_update_complete === true ? 1 : 0, hook.historical_update_complete === true ? 1 : 0,
    )
    handled = 'sync_updates'
  } else if (type === 'ITEM' && wcode === 'ERROR' && errorCode === 'ITEM_LOGIN_REQUIRED') {
    await run(`UPDATE bank_items SET status = 'needs_reconnect', last_error = 'item_login_required', updated_at = ?2 WHERE id = ?1`, item.id, at)
    handled = 'login_required'
  } else if (type === 'ITEM' && wcode === 'LOGIN_REPAIRED') {
    await markRepaired(db, item.id, t)
    handled = 'login_repaired'
  } else if (type === 'ITEM' && (wcode === 'PENDING_DISCONNECT' || wcode === 'PENDING_EXPIRATION')) {
    await run(`UPDATE bank_items SET status = 'pending_disconnect', updated_at = ?2 WHERE id = ?1 AND status = 'active'`, item.id, at)
    handled = 'pending_disconnect'
  } else if (type === 'ITEM' && (wcode === 'USER_PERMISSION_REVOKED' || wcode === 'USER_ACCOUNT_REVOKED')) {
    await revoke(db, item, plaid, input, t)
    handled = 'revoked'
  } else if (type === 'ITEM' && wcode === 'NEW_ACCOUNTS_AVAILABLE') {
    await run(`UPDATE bank_items SET new_accounts = 1, updated_at = ?2 WHERE id = ?1`, item.id, at)
    handled = 'new_accounts'
  } else if (type === 'LIABILITIES' && wcode === 'DEFAULT_UPDATE') {
    await run(`UPDATE bank_items SET liabilities_at = NULL, updated_at = ?2 WHERE id = ?1`, item.id, at)
    handled = 'liabilities_due'
  }
  log('webhook_handled', {}, handled || 'no_action')
  return okReply()
}
