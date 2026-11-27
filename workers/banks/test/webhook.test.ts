import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBudgetDb, type FakeBudgetDb } from '../../../functions/_lib/testing/budgetDb'
import { clearKeyCache, handleWebhook, markRepaired, verifyWebhook } from '../src/webhook'
import { createPlaidClient } from '../src/plaid'
import { sealToken } from '../src/store'
import type { Env } from '../src/env'
import type { RouteInput } from '../src/index'

const secret = (v: string) => ({ get: async () => v })
const OWNER = 'owner@example.com'
const KEY = btoa('0123456789abcdef0123456789abcdef')
const ACCESS = 'access-sandbox-aaaa-bbbb-cccc'
const KEY_URL = 'https://sandbox.plaid.com/webhook_verification_key/get'
const REMOVE = 'https://sandbox.plaid.com/item/remove'
const ITEM = 'i0123456789abcdef'
const PLAID_ITEM = 'item-sandbox-001'
const NOW = new Date('2026-11-27T12:00:00Z')
const NOW_S = Math.floor(NOW.getTime() / 1000)
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

let db: FakeBudgetDb
let calls: Array<{ url: string; body: Record<string, any> }>
let logs: string[]
let known: Record<string, () => Response | Promise<Response>>
let keyPair: CryptoKeyPair
let publicJwk: JsonWebKey

const b64url = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64urlText = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)))
const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) => x.toString(16).padStart(2, '0')).join('')

interface JwtOpts {
  alg?: string
  kid?: string | null
  iat?: number
  hash?: string
  signWith?: CryptoKey
}
/** A signed webhook JWT for `body`; ES256 over a key generated in this test (never a real Plaid key). */
async function makeJwt(body: Uint8Array<ArrayBuffer>, o: JwtOpts = {}): Promise<string> {
  const header: Record<string, unknown> = { alg: o.alg ?? 'ES256', typ: 'JWT' }
  if (o.kid !== null) header.kid = o.kid ?? 'kid-test-1'
  const payload = { iat: o.iat ?? NOW_S, request_body_sha256: o.hash ?? (await sha256Hex(body)) }
  const signing = `${b64urlText(header)}.${b64urlText(payload)}`
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, o.signWith ?? keyPair.privateKey, new TextEncoder().encode(signing))
  return `${signing}.${b64url(sig)}`
}

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    BUDGET_DB: db.d1,
    PLAID_CLIENT_ID: secret('client-id-sandbox-test'),
    PLAID_SECRET: secret('secret-value-sandbox-test'),
    BANKS_TOKEN_KEY: secret(KEY),
    RECEIPTS_ALLOWED_EMAILS: secret(OWNER),
    PLAID_ENV: 'sandbox',
    ...over,
  }
}
const stubFetch = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url)
  calls.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) })
  if (!Object.prototype.hasOwnProperty.call(known, u)) throw new Error(`unexpected fetch ${u}`)
  return Promise.resolve(known[u]())
}) as typeof fetch
const deps = { fetch: stubFetch, now: () => NOW }
const keyFetches = () => calls.filter((c) => c.url === KEY_URL).length

async function hook(payload: Record<string, unknown>, o: JwtOpts & { env?: Env; tamper?: boolean; header?: string | null } = {}): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify({ environment: 'sandbox', item_id: PLAID_ITEM, ...payload }))
  const jwt = o.header !== undefined ? o.header : await makeJwt(bytes, o)
  const sent = o.tamper ? Uint8Array.from(bytes, (b, i) => (i === 5 ? b ^ 1 : b)) : bytes
  const request = new Request('https://banks.internal/webhook', { method: 'POST', headers: jwt ? { 'plaid-verification': jwt } : {}, body: sent })
  const i: RouteInput = { request, env: o.env ?? makeEnv(), ctx: {} as ExecutionContext, raw: new TextDecoder().decode(sent), bytes: sent, body: {}, ownerEmail: '' }
  return handleWebhook(i, deps)
}
const row = () => db.all<Record<string, any>>('SELECT * FROM bank_items WHERE id = ?', ITEM)[0]
const runSql = (sql: string, ...v: unknown[]) => void (db.sqlite.prepare(sql) as any).run(...v)

async function seedItem(status = 'active', environment = 'sandbox'): Promise<void> {
  const enc = await sealToken(ACCESS, ITEM, { current: KEY, old: null })
  const live = status !== 'revoked' && status !== 'removed'
  runSql(
    `INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, institution_id, institution_name, status, token_ct, token_iv, key_id,
       sync_cursor, consent_version, consented_at, created_at, updated_at, last_error)
     VALUES (?, ?, ?, ?, 'ins_sandbox_1', 'Pine Ridge Credit Union', ?, ?, ?, ?, ?, 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', ?)`,
    ITEM, OWNER, environment, PLAID_ITEM, status,
    live ? enc.token_ct : null, live ? enc.token_iv : null, live ? enc.key_id : null, live ? 'cursor-aaaa' : null,
    status === 'needs_reconnect' ? 'item_login_required' : null,
  )
}
function seedAccount(id = 'b0123456789abcdef', sync = 'unmapped'): void {
  runSql(
    `INSERT INTO bank_accounts (id, item_id, plaid_account_id, name, type, sync, created_at, updated_at)
     VALUES (?, ?, 'acc-sandbox-001', 'Pine Ridge Card', 'credit', ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    id, ITEM, sync,
  )
}

beforeEach(async () => {
  db = await createBudgetDb({ seed: false })
  clearKeyCache()
  calls = []
  logs = []
  keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  known = {
    [KEY_URL]: () => json({ key: { ...publicJwk, kid: 'kid-test-1', use: 'sig', alg: 'ES256', created_at: NOW_S - 100, expired_at: null }, request_id: 'r1' }),
    [REMOVE]: () => json({ request_id: 'r2' }),
  }
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')))
})
afterEach(() => vi.restoreAllMocks())

describe('verification', () => {
  const plaid = () => createPlaidClient({ env: makeEnv(), fetch: stubFetch, now: () => NOW })
  const verify = async (bytes: Uint8Array<ArrayBuffer>, header: string | null) => verifyWebhook(bytes, header, plaid(), NOW)
  const body = new TextEncoder().encode('{"a":1}')

  it('accepts a good JWT over the raw bytes', async () => {
    expect(await verify(body, await makeJwt(body))).toBe('ok')
  })

  it('hashes the raw bytes, not a JSON round trip (extra whitespace and key order still verify)', async () => {
    const odd = new TextEncoder().encode('{ "b" : 2,\n  "a":   1 }')
    expect(await verify(odd, await makeJwt(odd))).toBe('ok')
    expect(await verify(new TextEncoder().encode(JSON.stringify(JSON.parse('{ "b" : 2, "a": 1 }'))), await makeJwt(odd))).toBe('bad')
  })

  it('rejects alg HS256 and none, and a missing kid', async () => {
    expect(await verify(body, await makeJwt(body, { alg: 'HS256' }))).toBe('bad')
    expect(await verify(body, await makeJwt(body, { alg: 'none' }))).toBe('bad')
    expect(await verify(body, await makeJwt(body, { kid: null }))).toBe('bad')
    expect(keyFetches()).toBe(0)
  })

  it('rejects a missing, malformed or wrongly signed header', async () => {
    expect(await verify(body, null)).toBe('bad')
    expect(await verify(body, 'not.a.jwt')).toBe('bad')
    expect(await verify(body, 'only-one-part')).toBe('bad')
    const other = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    expect(await verify(body, await makeJwt(body, { signWith: other.privateKey }))).toBe('bad')
  })

  it('fetches an unknown kid once, then serves two hooks from the cache', async () => {
    expect(await verify(body, await makeJwt(body))).toBe('ok')
    expect(await verify(body, await makeJwt(body))).toBe('ok')
    expect(keyFetches()).toBe(1)
    expect(calls[0].body.key_id).toBe('kid-test-1')
  })

  it('rejects an expired key', async () => {
    known[KEY_URL] = () => json({ key: { ...publicJwk, kid: 'kid-test-1', expired_at: NOW_S - 1 }, request_id: 'r1' })
    expect(await verify(body, await makeJwt(body))).toBe('bad')
  })

  it('rejects an iat older than 5 minutes (and one 5 minutes in the future), accepts 4 minutes', async () => {
    expect(await verify(body, await makeJwt(body, { iat: NOW_S - 301 }))).toBe('bad')
    expect(await verify(body, await makeJwt(body, { iat: NOW_S + 301 }))).toBe('bad')
    expect(await verify(body, await makeJwt(body, { iat: NOW_S - 240 }))).toBe('ok')
  })

  it('rejects a wrong body hash', async () => {
    expect(await verify(body, await makeJwt(body, { hash: 'a'.repeat(64) }))).toBe('bad')
  })

  it('does not call Plaid again for a kid Plaid just refused', async () => {
    known[KEY_URL] = () => json({ error_type: 'INVALID_INPUT', error_code: 'INVALID_FIELD', error_message: 'x' }, 400)
    expect(await verify(body, await makeJwt(body))).toBe('bad')
    expect(await verify(body, await makeJwt(body))).toBe('bad')
    expect(keyFetches()).toBe(1)
  })

  it('answers unavailable (so Plaid retries) when the key fetch cannot reach Plaid', async () => {
    known[KEY_URL] = () => {
      throw new Error('offline')
    }
    expect(await verify(body, await makeJwt(body))).toBe('unavailable')
  })
})

describe('POST /webhook', () => {
  it('401 on a changed body byte, a bad alg and a missing header, with no write and no detail', async () => {
    await seedItem()
    const before = JSON.stringify(row())
    for (const r of [
      await hook({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' }, { tamper: true }),
      await hook({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' }, { alg: 'HS256' }),
      await hook({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' }, { kid: null }),
      await hook({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' }, { header: null }),
    ]) {
      expect(r.status).toBe(401)
      expect(await r.json()).toEqual({ ok: false, code: 'bad_signature' })
    }
    expect(JSON.stringify(row())).toBe(before)
  })

  it('503 when the key cannot be fetched', async () => {
    await seedItem()
    known[KEY_URL] = () => {
      throw new Error('offline')
    }
    expect((await hook({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' })).status).toBe(503)
    expect(row().new_accounts).toBe(0)
  })

  it('SYNC_UPDATES_AVAILABLE sets sync_requested_at, last_webhook_at and the done flags (never back to 0)', async () => {
    await seedItem()
    const r = await hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', initial_update_complete: true, historical_update_complete: false })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
    expect(row()).toMatchObject({ sync_requested_at: NOW.toISOString(), last_webhook_at: NOW.toISOString(), initial_done: 1, historical_done: 0, status: 'active' })
    await hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', initial_update_complete: false, historical_update_complete: true })
    expect(row()).toMatchObject({ initial_done: 1, historical_done: 1 })
  })

  it('ITEM ERROR ITEM_LOGIN_REQUIRED -> needs_reconnect; another error code changes nothing', async () => {
    await seedItem()
    await hook({ webhook_type: 'ITEM', webhook_code: 'ERROR', error: { error_code: 'INTERNAL_SERVER_ERROR' } })
    expect(row().status).toBe('active')
    await hook({ webhook_type: 'ITEM', webhook_code: 'ERROR', error: { error_code: 'ITEM_LOGIN_REQUIRED' } })
    expect(row()).toMatchObject({ status: 'needs_reconnect', last_error: 'item_login_required' })
  })

  it('LOGIN_REPAIRED on a needs_reconnect item -> active, last_error NULL, sync_requested_at set', async () => {
    await seedItem('needs_reconnect')
    const r = await hook({ webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED' })
    expect(r.status).toBe(200)
    expect(row()).toMatchObject({ status: 'active', last_error: null, sync_requested_at: NOW.toISOString(), updated_at: NOW.toISOString() })
    expect(calls.filter((c) => c.url !== KEY_URL)).toEqual([])
  })

  it('PENDING_DISCONNECT and PENDING_EXPIRATION -> pending_disconnect', async () => {
    await seedItem()
    await hook({ webhook_type: 'ITEM', webhook_code: 'PENDING_EXPIRATION' })
    expect(row().status).toBe('pending_disconnect')
    runSql(`UPDATE bank_items SET status = 'active' WHERE id = ?`, ITEM)
    await hook({ webhook_type: 'ITEM', webhook_code: 'PENDING_DISCONNECT' })
    expect(row().status).toBe('pending_disconnect')
  })

  it('USER_PERMISSION_REVOKED: /item/remove with the decrypted token, then revoked with every wipe', async () => {
    await seedItem()
    seedAccount('b0123456789abcdef')
    runSql(`INSERT INTO bank_liabilities (bank_account_id, kind, fetched_at) VALUES ('b0123456789abcdef', 'credit', '2026-11-01T00:00:00Z')`)
    const r = await hook({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED' })
    expect(r.status).toBe(200)
    const removes = calls.filter((c) => c.url === REMOVE)
    expect(removes).toHaveLength(1)
    expect(removes[0].body.access_token).toBe(ACCESS)
    expect(row()).toMatchObject({ status: 'revoked', token_ct: null, token_iv: null, key_id: null, sync_cursor: null })
    expect(db.all('SELECT sync FROM bank_accounts')).toEqual([{ sync: 'off' }])
    expect(db.all('SELECT * FROM bank_liabilities')).toEqual([])
    expect(logs.join('\n')).not.toContain(ACCESS)
  })

  it('USER_ACCOUNT_REVOKED still wipes when /item/remove answers a Plaid error', async () => {
    await seedItem()
    known[REMOVE] = () => json({ error_type: 'ITEM_ERROR', error_code: 'ITEM_NOT_FOUND', error_message: 'x' }, 400)
    expect((await hook({ webhook_type: 'ITEM', webhook_code: 'USER_ACCOUNT_REVOKED' })).status).toBe(200)
    expect(row()).toMatchObject({ status: 'revoked', token_ct: null })
  })

  it('NEW_ACCOUNTS_AVAILABLE sets new_accounts = 1 and changes nothing but updated_at: no Plaid call, no account row', async () => {
    await seedItem()
    const before = row()
    const r = await hook({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' })
    expect(r.status).toBe(200)
    const after = row()
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]).sort()
    expect(changed).toEqual(['new_accounts', 'updated_at'])
    expect(after.new_accounts).toBe(1)
    expect(calls.filter((c) => c.url !== KEY_URL)).toEqual([])
    expect(db.all('SELECT * FROM bank_accounts')).toEqual([])
  })

  it('LIABILITIES DEFAULT_UPDATE clears liabilities_at', async () => {
    await seedItem()
    runSql(`UPDATE bank_items SET liabilities_at = '2026-11-26T00:00:00Z' WHERE id = ?`, ITEM)
    await hook({ webhook_type: 'LIABILITIES', webhook_code: 'DEFAULT_UPDATE' })
    expect(row().liabilities_at).toBeNull()
  })

  it('any other type or code: 200, no write', async () => {
    await seedItem()
    const before = JSON.stringify(row())
    expect((await hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'RECURRING_TRANSACTIONS_UPDATE' })).status).toBe(200)
    expect((await hook({ webhook_type: 'ITEM', webhook_code: 'WEBHOOK_UPDATE_ACKNOWLEDGED' })).status).toBe(200)
    expect(JSON.stringify(row())).toBe(before)
  })

  it('environment mismatch -> 200, no write', async () => {
    await seedItem()
    const before = JSON.stringify(row())
    const r = await hook({ environment: 'production', webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' })
    expect(r.status).toBe(200)
    expect(JSON.stringify(row())).toBe(before)
  })

  it('an item of the other environment is treated as unknown', async () => {
    await seedItem('active', 'production')
    const before = JSON.stringify(row())
    expect((await hook({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' })).status).toBe(200)
    expect(JSON.stringify(row())).toBe(before)
  })

  it('unknown item -> 200 unknown_item, no write', async () => {
    await seedItem()
    const before = JSON.stringify(row())
    const r = await hook({ item_id: 'item-sandbox-nope', webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, code: 'unknown_item' })
    expect(JSON.stringify(row())).toBe(before)
  })

  it('a revoked item ignores every hook', async () => {
    await seedItem('revoked')
    const before = JSON.stringify(row())
    expect((await hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE' })).status).toBe(200)
    expect(JSON.stringify(row())).toBe(before)
  })

  it('logs counts and codes only: no item id, token or key id', async () => {
    await seedItem()
    await hook({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED' })
    await hook({ item_id: 'item-sandbox-nope', webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' })
    const text = logs.join('\n')
    for (const s of [PLAID_ITEM, ITEM, ACCESS, KEY, 'kid-test-1']) expect(text).not.toContain(s)
  })
})

describe('markRepaired', () => {
  it('sets active, clears last_error, stamps sync_requested_at and updated_at', async () => {
    await seedItem('needs_reconnect')
    expect(await markRepaired(db.d1, ITEM, NOW)).toBe(1)
    expect(row()).toMatchObject({ status: 'active', last_error: null, sync_requested_at: NOW.toISOString(), updated_at: NOW.toISOString() })
  })
  it('leaves a revoked item alone', async () => {
    await seedItem('revoked')
    expect(await markRepaired(db.d1, ITEM, NOW)).toBe(0)
    expect(row().status).toBe('revoked')
  })
})
