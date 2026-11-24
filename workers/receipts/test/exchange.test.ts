// Worker /exchange and /disconnect against the real budget schema (node:sqlite). Google is mocked; every value is made up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBudgetDb, type FakeBudgetDb } from '../../../functions/_lib/testing/budgetDb'
import { CONNECT_CODES } from '../../../functions/_lib/gmailConnect'
import { handleDisconnect, type ReceiptsSecretsEnv, type SecretBinding } from '../src/disconnect'
import { handleExchange } from '../src/exchange'
import { decryptToken } from '../src/tokenCrypto'

const CLIENT_ID = 'fake-client-id.apps.example.com'
const CLIENT_SECRET = 'fake-client-secret-2222'
const REFRESH = 'fake-refresh-token-0000'
const ACCESS = 'fake-access-token-1111'
const OWNER = 'user-a@example.com'
const OTHER = 'user-b@example.com'
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly'
const NONCE = 'nonce-aaaaaaaaaaaaaaaaaaaaaaaa'
const VERIFIER = 'verifier-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const CODE = 'fake-auth-code-3333'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

const secret = (v: string): SecretBinding => ({ get: async () => v })
const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8))
const KEY = b64(crypto.getRandomValues(new Uint8Array(32)))
const KEY2 = b64(crypto.getRandomValues(new Uint8Array(32)))

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function idToken(over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: 'google-sub-1', email: 'gmail-user@example.com',
    email_verified: true, nonce: NONCE, iat: now, exp: now + 3600, ...over,
  }
  // The signature segment is arbitrary: the token came straight from the token endpoint, and the Worker does not check it.
  return `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.c2ln`
}

let db: FakeBudgetDb
let env: ReceiptsSecretsEnv
let calls: Array<{ url: string; body: string }>
let tokenResponse: () => Response
let revokeResponse: () => Response | Promise<Response>
let logs: string[]

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const goodTokens = (over: Record<string, unknown> = {}) => ({
  access_token: ACCESS, refresh_token: REFRESH, scope: `openid email ${GMAIL}`, id_token: idToken(), expires_in: 3599, token_type: 'Bearer', ...over,
})

beforeEach(async () => {
  db = await createBudgetDb({ seed: false })
  env = {
    BUDGET_DB: db.d1,
    RECEIPTS_GMAIL_CLIENT_ID: secret(CLIENT_ID),
    RECEIPTS_GMAIL_CLIENT_SECRET: secret(CLIENT_SECRET),
    RECEIPTS_TOKEN_KEY: secret(KEY),
    RECEIPTS_ALLOWED_EMAILS: secret(`${OWNER}, ${OTHER}`),
  }
  calls = []
  logs = []
  tokenResponse = () => json(goodTokens())
  revokeResponse = () => new Response('', { status: 200 })
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, body: String(init?.body ?? '') })
    if (u === TOKEN_URL) return tokenResponse()
    if (u === REVOKE_URL) return revokeResponse()
    throw new Error(`unexpected fetch ${u}`)
  })
  for (const m of ['info', 'log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function exchange(over: Record<string, unknown> = {}, e: ReceiptsSecretsEnv = env) {
  return handleExchange(
    new Request('https://receipts.internal/exchange', {
      method: 'POST',
      body: JSON.stringify({
        code: CODE, verifier: VERIFIER, nonce: NONCE, ownerEmail: OWNER, consentVersion: 1,
        redirectUri: 'https://stats.example.com/api/budget/email/callback', ...over,
      }),
    }),
    e,
  )
}
const rows = () => db.all<Record<string, any>>('SELECT * FROM email_connections')
async function result(res: Response) {
  expect(res.status).toBe(200)
  return (await res.json()) as { ok: boolean; code?: string }
}
function expectNoLeak(text: string) {
  for (const s of [CLIENT_SECRET, REFRESH, ACCESS, CODE, VERIFIER, NONCE, OWNER, OTHER, 'gmail-user@example.com', KEY]) expect(text).not.toContain(s)
}

describe('POST /exchange', () => {
  it('connects: posts the code with secret and verifier, stores ciphertext only, replies ok', async () => {
    const res = await exchange()
    const text = await res.clone().text()
    expect(await result(res)).toEqual({ ok: true })
    const form = new URLSearchParams(calls[0].body)
    expect(form.get('code')).toBe(CODE)
    expect(form.get('client_secret')).toBe(CLIENT_SECRET)
    expect(form.get('code_verifier')).toBe(VERIFIER)
    expect(form.get('grant_type')).toBe('authorization_code')
    const [row] = rows()
    expect(rows()).toHaveLength(1)
    expect(row).toMatchObject({ owner_email: OWNER, google_sub: 'google-sub-1', status: 'active', consent_version: 1 })
    expect(row.scopes).toContain(GMAIL)
    // ciphertext only: nothing in the row is the token, and it decrypts with the connection id as AAD
    expect(JSON.stringify(row)).not.toContain(REFRESH)
    const dec = await decryptToken({ token_ct: row.token_ct, token_iv: row.token_iv, key_id: row.key_id }, row.id, { current: KEY })
    expect(dec.plaintext).toBe(REFRESH)
    await expect(decryptToken({ token_ct: row.token_ct, token_iv: row.token_iv, key_id: row.key_id }, 'c0000000000000000', { current: KEY })).rejects.toThrow()
    expect(calls.filter((c) => c.url === REVOKE_URL)).toHaveLength(0)
    expectNoLeak(text)
    expectNoLeak(logs.join('\n'))
    expect(logs.join('\n')).toContain('"code":"connected"')
  })

  it('does not require the Google email to equal ownerEmail', async () => {
    tokenResponse = () => json(goodTokens({ id_token: idToken({ email: 'someone-else@example.com' }) }))
    expect(await result(await exchange())).toEqual({ ok: true })
    expect(rows()[0].owner_email).toBe(OWNER)
  })

  it('a reconnect updates the existing row in place (same id, new ciphertext, cleared error)', async () => {
    await exchange()
    const first = rows()[0]
    db.exec(`UPDATE email_connections SET status='needs_reconnect', token_ct=NULL, token_iv=NULL, key_id=NULL, last_error='token_revoked', watermark_at='2026-11-01T00:00:00.000Z'`)
    tokenResponse = () => json(goodTokens({ refresh_token: 'fake-refresh-token-9999', id_token: idToken({ sub: 'google-sub-2' }) }))
    expect(await result(await exchange({ consentVersion: 2 }))).toEqual({ ok: true })
    expect(rows()).toHaveLength(1)
    const row = rows()[0]
    expect(row.id).toBe(first.id)
    expect(row).toMatchObject({ status: 'active', google_sub: 'google-sub-2', consent_version: 2, last_error: null, watermark_at: '2026-11-01T00:00:00.000Z' })
    const dec = await decryptToken({ token_ct: row.token_ct, token_iv: row.token_iv, key_id: row.key_id }, row.id, { current: KEY })
    expect(dec.plaintext).toBe('fake-refresh-token-9999')
  })

  it.each([
    ['wrong aud', { aud: 'other-client' }],
    ['wrong azp', { azp: 'other-client' }],
    ['wrong iss', { iss: 'https://evil.example.com' }],
    ['wrong nonce', { nonce: 'not-the-nonce' }],
    ['unverified email', { email_verified: false }],
    ['string email_verified', { email_verified: 'true' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ])('%s -> token_invalid, nothing stored, issued token revoked', async (_n, claims) => {
    tokenResponse = () => json(goodTokens({ id_token: idToken(claims) }))
    const res = await exchange()
    const text = await res.clone().text()
    expect(await result(res)).toEqual({ ok: false, code: 'token_invalid' })
    expect(rows()).toHaveLength(0)
    const revokes = calls.filter((c) => c.url === REVOKE_URL)
    expect(revokes).toHaveLength(1)
    expect(new URLSearchParams(revokes[0].body).get('token')).toBe(REFRESH)
    expectNoLeak(text)
    expectNoLeak(logs.join('\n'))
  })

  it('a malformed id_token -> token_invalid', async () => {
    tokenResponse = () => json(goodTokens({ id_token: 'not-a-jwt' }))
    expect(await result(await exchange())).toEqual({ ok: false, code: 'token_invalid' })
    expect(rows()).toHaveLength(0)
  })

  it('no refresh token -> no_refresh_token, access token revoked', async () => {
    tokenResponse = () => json(goodTokens({ refresh_token: undefined }))
    expect(await result(await exchange())).toEqual({ ok: false, code: 'no_refresh_token' })
    expect(rows()).toHaveLength(0)
    const revokes = calls.filter((c) => c.url === REVOKE_URL)
    expect(new URLSearchParams(revokes[0].body).get('token')).toBe(ACCESS)
  })

  it('gmail.readonly not granted -> scope_missing, revoked', async () => {
    tokenResponse = () => json(goodTokens({ scope: 'openid email' }))
    expect(await result(await exchange())).toEqual({ ok: false, code: 'scope_missing' })
    expect(rows()).toHaveLength(0)
    expect(calls.filter((c) => c.url === REVOKE_URL)).toHaveLength(1)
  })

  it('an ownerEmail off the allowlist -> not_allowed, Google never called', async () => {
    expect(await result(await exchange({ ownerEmail: 'stranger@example.com' }))).toEqual({ ok: false, code: 'not_allowed' })
    expect(calls).toHaveLength(0)
    expect(rows()).toHaveLength(0)
  })

  it('a look-alike ownerEmail is refused', async () => {
    expect(await result(await exchange({ ownerEmail: 'user-a@example.com.evil.test' }))).toEqual({ ok: false, code: 'not_allowed' })
  })

  it('Google invalid_grant (a replayed code) -> invalid_grant; other failures -> exchange_failed', async () => {
    tokenResponse = () => json({ error: 'invalid_grant', error_description: CODE }, 400)
    const res = await exchange()
    const text = await res.clone().text()
    expect(await result(res)).toEqual({ ok: false, code: 'invalid_grant' })
    expectNoLeak(text)
    tokenResponse = () => json({ error: 'server_error' }, 500)
    expect(await result(await exchange())).toEqual({ ok: false, code: 'exchange_failed' })
    tokenResponse = () => new Response('', { status: 302, headers: { location: 'https://evil.example.com' } })
    expect(await result(await exchange())).toEqual({ ok: false, code: 'exchange_failed' })
    expect(rows()).toHaveLength(0)
  })

  it('a network error -> exchange_failed', async () => {
    tokenResponse = () => {
      throw new Error(`boom ${CODE}`)
    }
    const res = await exchange()
    expect(await result(res)).toEqual({ ok: false, code: 'exchange_failed' })
    expectNoLeak(logs.join('\n'))
  })

  it.each(['RECEIPTS_GMAIL_CLIENT_ID', 'RECEIPTS_GMAIL_CLIENT_SECRET', 'RECEIPTS_TOKEN_KEY', 'RECEIPTS_ALLOWED_EMAILS'] as const)(
    'a missing %s -> not_configured',
    async (name) => {
      const e = { ...env, [name]: undefined }
      expect(await result(await exchange({}, e))).toEqual({ ok: false, code: 'not_configured' })
      expect(calls).toHaveLength(0)
    },
  )

  it('a malformed body or wrong method fails closed', async () => {
    expect(await result(await exchange({ code: '' }))).toEqual({ ok: false, code: 'exchange_failed' })
    expect(await result(await exchange({ consentVersion: 0 }))).toEqual({ ok: false, code: 'exchange_failed' })
    expect(await result(await exchange({ redirectUri: 'nope' }))).toEqual({ ok: false, code: 'exchange_failed' })
    expect((await handleExchange(new Request('https://receipts.internal/exchange'), env)).status).toBe(405)
    expect(calls).toHaveLength(0)
  })

  it('every reply code is a CONNECT_CODE', async () => {
    tokenResponse = () => json(goodTokens({ scope: 'openid' }))
    const r = await result(await exchange())
    expect(CONNECT_CODES).toContain(r.code)
  })
})

describe('POST /disconnect', () => {
  const disconnect = (body: unknown, e: ReceiptsSecretsEnv = env) =>
    handleDisconnect(new Request('https://receipts.internal/disconnect', { method: 'POST', body: JSON.stringify(body) }), e)

  it('decrypts the token and revokes it at Google', async () => {
    await exchange()
    calls.length = 0
    const id = rows()[0].id
    const res = await disconnect({ connectionId: id })
    const text = await res.clone().text()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(REVOKE_URL)
    expect(new URLSearchParams(calls[0].body).get('token')).toBe(REFRESH)
    expectNoLeak(text)
    expectNoLeak(logs.join('\n'))
    // the Pages route does the D1 writes: the row is untouched here
    expect(rows()[0].status).toBe('active')
  })

  it('a revoke failure (500 or network error) still replies 200 {revoked:false}', async () => {
    await exchange()
    const id = rows()[0].id
    revokeResponse = () => new Response('nope', { status: 500 })
    let res = await disconnect({ connectionId: id })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: false })
    revokeResponse = () => {
      throw new Error(`down ${REFRESH}`)
    }
    res = await disconnect({ connectionId: id })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: false })
    expectNoLeak(logs.join('\n'))
  })

  it('a wrong key or a token-less / unknown connection replies 200 {revoked:false}', async () => {
    await exchange()
    const id = rows()[0].id
    let res = await disconnect({ connectionId: id }, { ...env, RECEIPTS_TOKEN_KEY: secret(KEY2) })
    expect(await res.json()).toEqual({ revoked: false })
    db.exec(`UPDATE email_connections SET status='revoked', token_ct=NULL, token_iv=NULL, key_id=NULL`)
    res = await disconnect({ connectionId: id })
    expect(await res.json()).toEqual({ revoked: false })
    res = await disconnect({ connectionId: 'c0000000000000000' })
    expect(await res.json()).toEqual({ revoked: false })
    expect(calls.filter((c) => c.url === REVOKE_URL)).toHaveLength(0)
  })

  it('a missing key replies a fixed code; a bad body is a 400', async () => {
    await exchange()
    const id = rows()[0].id
    const res = await disconnect({ connectionId: id }, { ...env, RECEIPTS_TOKEN_KEY: undefined })
    expect(await res.json()).toEqual({ revoked: false, code: 'not_configured' })
    expect((await disconnect({ connectionId: 'x; DROP TABLE' })).status).toBe(400)
    expect((await disconnect({})).status).toBe(400)
  })
})
