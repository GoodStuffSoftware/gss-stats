// The receipts Worker's run loop and entry point against the real budget schema in SQLite, with fetch mocked.
// Everything is made up: example.com, fake merchants, fake keys (generated at run time), fake Google and Anthropic answers.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBudgetDb, insertTxn, type FakeBudgetDb } from '../../../functions/_lib/testing/budgetDb'
import { handleFetch, handleScheduled, ROUTES } from '../src/index'
import { log } from '../src/log'
import { runConnection, type Env } from '../src/run'
import * as S from '../src/store'
import { decryptToken, encryptToken, keyFingerprint } from '../src/tokenCrypto'

const NOW = new Date('2026-12-05T10:00:00.000Z')
const CONN = 'c0123456789abcdef'
const CONN_B = 'cfedcba9876543210'
const OWNER = 'user-a@example.com'
const OTHER = 'user-b@example.com'
const REFRESH = 'fake-refresh-token-0000'
let db: FakeBudgetDb

const makeKey = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const sec = (v: string) => ({ get: async () => v })
const b64url = (s: string): string => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const hexId = (n: number): string => (0x18c3f2a9b7d4e600n + BigInt(n)).toString(16).padStart(16, '0')
const MSG_DAY = Date.parse('2026-12-01T12:00:00.000Z')

let KEY = makeKey()

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    BUDGET_DB: db.d1, RECEIPTS_GMAIL_CLIENT_ID: sec('fake-client-id'), RECEIPTS_GMAIL_CLIENT_SECRET: sec('fake-client-secret'),
    RECEIPTS_TOKEN_KEY: sec(KEY), RECEIPTS_ANTHROPIC_KEY: sec('fake-anthropic-key'), RECEIPTS_ALLOWED_EMAILS: sec(`${OWNER}, ${OTHER}`),
    RECEIPTS_MODEL: 'test-model', RECEIPTS_MAX_PER_RUN: '60', RECEIPTS_DAILY_CAP: '150', RECEIPTS_BACKFILL_DAYS: '14', RECEIPTS_AUTO_APPLY: '0',
    ...over,
  }
}

async function addConn(id = CONN, email = OWNER, key = KEY): Promise<void> {
  const e = await encryptToken(REFRESH, id, key)
  db.sqlite.prepare(`INSERT INTO email_connections (id, owner_email, google_sub, status, token_ct, token_iv, key_id, scopes, consent_version, consented_at, created_at, updated_at)
    VALUES (?, ?, '1234567890', 'active', ?, ?, ?, 'gmail.readonly', 1, '2026-12-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')`)
    .run(id, email, e.token_ct, e.token_iv, e.key_id)
}

interface Net { fetch: typeof fetch; urls: string[]; anthropic: number; gets: number; queries: string[] }
interface NetOpts { messages?: number; anthropicStatus?: number; tokenError?: boolean; times?: number[]; tokenStatus?: number }
const pageToken = (n: number): string => `pt-${n}`
/** Google token + Gmail list/get + Anthropic. Message i (0 = oldest) has internalDate one hour after the previous; receipt n totals 1234 + 111n cents. */
function makeNet(o: NetOpts = {}): Net {
  const count = o.times ? o.times.length : (o.messages ?? 2)
  const timeOf = (i: number): number => (o.times ? o.times[i] : MSG_DAY + i * 3_600_000)
  const net: Net = { urls: [], queries: [], anthropic: 0, gets: 0, fetch: undefined as never }
  net.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    net.urls.push(u)
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      if (o.tokenStatus) return new Response(JSON.stringify({ error: 'invalid_client' }), { status: o.tokenStatus })
      return o.tokenError ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) : new Response(JSON.stringify({ access_token: 'fake-access-token-1111' }))
    }
    if (u.startsWith('https://api.anthropic.com/')) {
      const n = net.anthropic++
      if (o.anthropicStatus) return new Response('{}', { status: o.anthropicStatus })
      void init
      const receipt = { is_receipt: true, kind: 'purchase', merchant: 'Fake Mart', payment_via: 'card', card_last4: null, order_ref: `FM-${n}`, receipt_date: '2026-12-01', related_date: null,
        currency: 'USD', total_cents: 1234 + 111 * n, tax_cents: null, shipping_cents: null, charges: [], items: [{ description: 'Widget', amount_cents: 1234 + 111 * n, quantity: 1, category_hint: 'shopping' }] }
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(receipt) }], usage: { input_tokens: 400, output_tokens: 90 } }))
    }
    const get = /\/messages\/([0-9a-f]+)\?format=full/.exec(u)
    if (get) {
      net.gets++
      const i = Number(BigInt(`0x${get[1]}`) - 0x18c3f2a9b7d4e600n)
      const text = 'Thanks for your order from Fake Mart. Your order has shipped.'
      return new Response(JSON.stringify({ id: get[1], internalDate: String(timeOf(i)), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Fake Mart <orders@shop.example.com>' }], body: { data: b64url(text) } } }))
    }
    // messages.list: newest first, filtered by after:/before: (epoch seconds), paged by maxResults and pageToken
    const lu = new URL(u)
    const q = lu.searchParams.get('q') ?? ''
    net.queries.push(q)
    const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000
    const before = /before:(\d+)/.exec(q) ? Number(/before:(\d+)/.exec(q)?.[1]) * 1000 : Infinity
    const all = Array.from({ length: count }, (_, i) => i).filter((i) => timeOf(i) > after && timeOf(i) < before).reverse()
    const size = Number(lu.searchParams.get('maxResults') ?? 100)
    const off = lu.searchParams.get('pageToken') ? Number(lu.searchParams.get('pageToken')!.slice(3)) : 0
    const page = all.slice(off, off + size)
    return new Response(JSON.stringify({ messages: page.map((i) => ({ id: hexId(i) })), ...(off + size < all.length ? { nextPageToken: pageToken(off + size) } : {}) }))
  }) as unknown as typeof fetch
  return net
}

const lastRun = () => db.get<Record<string, unknown>>('SELECT * FROM receipt_sync_runs ORDER BY id DESC LIMIT 1') as Record<string, unknown>
const conn = (id = CONN) => db.get<Record<string, unknown>>('SELECT * FROM email_connections WHERE id = ?', id) as Record<string, unknown>
const count = (table: string): number => (db.get<{ n: number }>(`SELECT count(*) n FROM ${table}`) as { n: number }).n
const snapshotTxns = (): string => JSON.stringify(db.all('SELECT * FROM transactions ORDER BY id'))
const run = (env: Env, net: Net, id = CONN, extra: Partial<Parameters<typeof runConnection>[4]> = {}) => runConnection(env, id, null, 'cron', { fetch: net.fetch, now: () => NOW, ...extra })

beforeEach(async () => {
  db = await createBudgetDb()
  KEY = makeKey()
  await addConn()
})

describe('a run', () => {
  it('happy path: lists, gets, extracts, stores, matches, and leaves transactions untouched with AUTO_APPLY off', async () => {
    const t1 = insertTxn(db, { posted_date: '2026-12-02', amount_cents: -1234, updated_at: '2026-12-03T00:00:00.000Z' })
    db.exec(`UPDATE transactions SET updated_by = 'script:load' WHERE id = '${t1}'`)
    const before = snapshotTxns()
    const net = makeNet({ messages: 2 })
    const out = await run(makeEnv(), net)
    expect(out.errorCode).toBeNull()
    const r = lastRun()
    expect(r).toMatchObject({ listed: 2, fetched: 2, extracted: 2, skipped: 0, matched: 1, auto_applied: 0, error_code: null })
    expect(r.finished_at).toBe(NOW.toISOString())
    expect(count('receipts')).toBe(2)
    expect(db.get<{ sender_domain: string }>('SELECT sender_domain FROM receipts LIMIT 1')?.sender_domain).toBe('shop.example.com')
    expect(db.all<{ status: string }>('SELECT status FROM receipt_matches').map((x) => x.status)).toEqual(['suggested'])
    expect(snapshotTxns()).toBe(before)
    expect(conn()).toMatchObject({ last_run_at: NOW.toISOString(), last_ok_at: NOW.toISOString(), last_error: null, watermark_at: new Date(NOW.getTime() - 1000).toISOString() })
    expect(net.urls.some((u) => u.includes('/messages/') && !u.includes('format=full'))).toBe(false)
  })

  it('a second run dedupes: no new gets, no model calls, no new receipts', async () => {
    const net = makeNet({ times: [NOW.getTime() - 26 * 3_600_000, NOW.getTime() - 25 * 3_600_000] })
    await run(makeEnv(), net)
    const calls = net.anthropic
    const gets = net.gets
    await run(makeEnv(), net)
    expect(net.anthropic).toBe(calls)
    expect(net.gets).toBe(gets)
    expect(count('receipts')).toBe(2)
    expect(lastRun()).toMatchObject({ listed: 2, fetched: 0, extracted: 0, error_code: null })
  })

  it('RECEIPTS_MAX_PER_RUN limits one run to the oldest messages; the rest wait for the next run', async () => {
    const net = makeNet({ messages: 5 })
    await run(makeEnv({ RECEIPTS_MAX_PER_RUN: '2' }), net)
    expect(lastRun()).toMatchObject({ fetched: 2, extracted: 2 })
    expect(db.all<{ gmail_msg_id: string }>('SELECT gmail_msg_id FROM receipts ORDER BY gmail_msg_id').map((x) => x.gmail_msg_id)).toEqual([hexId(0), hexId(1)])
    await run(makeEnv({ RECEIPTS_MAX_PER_RUN: '2' }), net)
    expect(count('receipts')).toBe(4)
  })

  it('records the model tokens of each call on the run row', async () => {
    await run(makeEnv(), makeNet({ messages: 3 }))
    expect(lastRun()).toMatchObject({ extracted: 3, model_in_tokens: 1200, model_out_tokens: 270 })
  })

  it('the daily cap counts every fetched email (invalid answers included), not just extracted + skipped', async () => {
    const earlier = await S.createRun(db.d1, CONN, 'cron', new Date(NOW.getTime() - 3_600_000))
    await S.finishRun(db.d1, earlier, { ...S.ZERO_COUNTS, fetched: 3, extracted: 1 }, null, new Date(NOW.getTime() - 3_500_000))
    const net = makeNet({ messages: 2 })
    const out = await run(makeEnv({ RECEIPTS_DAILY_CAP: '3' }), net)
    expect(out.errorCode).toBe('daily_cap')
    expect(net.anthropic).toBe(0)
  })

  it('a cron run does nothing while another run of the mailbox is open and fresh, and starts again once it is closed or old', async () => {
    const open = await S.createRun(db.d1, CONN, 'manual', new Date(NOW.getTime() - 30_000))
    const net = makeNet({ messages: 2 })
    const skipped = await run(makeEnv(), net)
    expect(skipped.errorCode).toBe('run_busy')
    expect(net.urls).toEqual([])
    expect(count('receipt_sync_runs')).toBe(1)
    expect(conn().last_run_at).toBeNull()
    await S.finishRun(db.d1, open, S.ZERO_COUNTS, null, NOW)
    expect((await run(makeEnv(), net)).errorCode).toBeNull()
    expect(count('receipt_sync_runs')).toBe(2)
    // a crashed run row (open for over 2 minutes) never blocks forever
    db.exec(`UPDATE receipt_sync_runs SET finished_at = NULL, started_at = '${new Date(NOW.getTime() - 5 * 60_000).toISOString()}' WHERE id = ${open}`)
    db.exec(`DELETE FROM receipt_sync_runs WHERE id <> ${open}`)
    expect((await run(makeEnv(), makeNet({ messages: 1 }))).errorCode).toBeNull()
  })

  it('the daily cap counts extracted + skipped from run rows and ends further runs that day with daily_cap', async () => {
    const net = makeNet({ messages: 5 })
    await run(makeEnv({ RECEIPTS_DAILY_CAP: '3' }), net)
    expect(lastRun()).toMatchObject({ extracted: 3, skipped: 0 })
    const gets = net.gets
    const out = await run(makeEnv({ RECEIPTS_DAILY_CAP: '3' }), net)
    expect(out.errorCode).toBe('daily_cap')
    expect(lastRun()).toMatchObject({ error_code: 'daily_cap', fetched: 0 })
    expect(net.gets).toBe(gets)
    expect(count('receipts')).toBe(3)
  })

  it('skipped emails (an empty body) are recorded as skipped and count toward the cap', async () => {
    const net = makeNet({ messages: 1 })
    const f = net.fetch
    net.fetch = (async (u: string | URL | Request, i?: RequestInit) => {
      const res = await f(u, i)
      if (!/format=full/.test(String(u))) return res
      const j = (await res.json()) as { payload: { body: { data: string } } }
      j.payload.body.data = ''
      return new Response(JSON.stringify(j))
    }) as typeof fetch
    await run(makeEnv(), net)
    expect(lastRun()).toMatchObject({ extracted: 0, skipped: 1 })
    expect(db.get<{ status: string }>('SELECT status FROM receipts')?.status).toBe('skipped')
    expect(net.anthropic).toBe(0)
  })

  it.each([[400, 'api_rejected'], [429, 'api_limited'], [529, 'api_limited'], [503, 'api_unavailable']])('a %i from the model stops the run as %s, stores nothing and uses no attempt', async (status, reason) => {
    const net = makeNet({ messages: 3, anthropicStatus: status })
    const out = await run(makeEnv(), net)
    expect(out.errorCode).toBe(reason)
    expect(lastRun()).toMatchObject({ error_code: reason, extracted: 0 })
    expect(net.anthropic).toBe(1)
    expect(count('receipts')).toBe(0)
    expect(conn()).toMatchObject({ status: 'active', last_error: reason, last_ok_at: null })
    // The next run (limit gone) picks the same messages up.
    await run(makeEnv(), makeNet({ messages: 3 }))
    expect(count('receipts')).toBe(3)
  })

  it('a Google invalid_grant sets needs_reconnect and clears the token', async () => {
    const out = await run(makeEnv(), makeNet({ tokenError: true }))
    expect(out.errorCode).toBe('needs_reconnect')
    expect(conn()).toMatchObject({ status: 'needs_reconnect', token_ct: null, token_iv: null, key_id: null, last_error: 'needs_reconnect' })
    expect(lastRun()).toMatchObject({ error_code: 'needs_reconnect' })
    expect(await S.loadActiveConnectionIds(db.d1)).toEqual([])
  })

  it('a token that will not decrypt is decrypt_failed -> needs_reconnect, with no Gmail or model call and no retry', async () => {
    const net = makeNet()
    const out = await run(makeEnv({ RECEIPTS_TOKEN_KEY: sec(makeKey()) }), net)
    expect(out.errorCode).toBe('decrypt_failed')
    expect(conn()).toMatchObject({ status: 'needs_reconnect', token_ct: null })
    expect(net.urls).toEqual([])
    const again = await run(makeEnv(), net)
    expect(again.errorCode).toBe('not_active')
  })

  it('a token on the old key decrypts, is re-encrypted with the current key, and still syncs', async () => {
    const oldKey = KEY
    KEY = makeKey()
    const net = makeNet({ messages: 1 })
    const env = makeEnv({ RECEIPTS_TOKEN_KEY_OLD: sec(oldKey) })
    const out = await run(env, net)
    expect(out.errorCode).toBeNull()
    const c = conn()
    expect(c.key_id).toBe(await keyFingerprint(KEY))
    const dec = await decryptToken({ token_ct: c.token_ct as string, token_iv: c.token_iv as string, key_id: c.key_id as string }, CONN, { current: KEY })
    expect(dec).toEqual({ plaintext: REFRESH, usedOldKey: false })
    expect(count('receipts')).toBe(1)
  })

  it('an owner removed from the allowlist is paused with no Gmail call', async () => {
    const net = makeNet()
    const out = await run(makeEnv({ RECEIPTS_ALLOWED_EMAILS: sec(OTHER) }), net)
    expect(out.errorCode).toBe('not_allowed')
    expect(conn()).toMatchObject({ status: 'paused' })
    expect(net.urls).toEqual([])
  })

  it('a missing secret is a fixed code, not a throw', async () => {
    const net = makeNet()
    const broken = { get: async (): Promise<string> => { throw new Error('boom: secret-ish text') } }
    for (const over of [{ RECEIPTS_ANTHROPIC_KEY: undefined }, { RECEIPTS_TOKEN_KEY: broken }, { RECEIPTS_GMAIL_CLIENT_SECRET: sec('  ') }] as Partial<Env>[]) {
      const out = await run(makeEnv(over), net)
      expect(out.errorCode).toBe('secrets_missing')
    }
    expect(lastRun()).toMatchObject({ error_code: 'secrets_missing' })
    expect(net.urls).toEqual([])
  })

  it('a manual run past its time budget ends cleanly between messages and the next run continues', async () => {
    let t = NOW.getTime()
    const net = makeNet({ messages: 5 })
    const out = await run(makeEnv(), net, CONN, { now: () => new Date((t += 200)), budgetMs: 2_000 })
    expect(out.errorCode).toBeNull()
    expect(count('receipts')).toBeGreaterThan(0)
    expect(count('receipts')).toBeLessThan(5)
    await run(makeEnv(), net)
    expect(count('receipts')).toBe(5)
  })

  it('a placeholder (invalid) old key counts as absent: runs still work on the current key', async () => {
    const net = makeNet({ messages: 1 })
    const out = await run(makeEnv({ RECEIPTS_TOKEN_KEY_OLD: sec('placeholder') }), net)
    expect(out.errorCode).toBeNull()
    expect(count('receipts')).toBe(1)
    expect(conn()).toMatchObject({ status: 'active' })
  })

  it('a disconnect during a run stores no receipt and stops the loop before the next message', async () => {
    const net = makeNet({ messages: 3 })
    const f = net.fetch
    net.fetch = (async (u: string | URL | Request, i?: RequestInit) => {
      if (String(u).startsWith('https://api.anthropic.com/')) db.exec(`UPDATE email_connections SET status = 'paused' WHERE id = '${CONN}'`)
      return f(u, i)
    }) as typeof fetch
    const out = await runConnection(makeEnv(), CONN, null, 'cron', { fetch: net.fetch, now: () => NOW })
    expect(count('receipts')).toBe(0)
    expect(count('receipt_items')).toBe(0)
    expect(net.anthropic).toBe(1)
    expect(out.errorCode).toBe('not_active')
  })

  /** A fetch that runs `onModelCall(n)` (1-based) just before the n-th model answer, to land a disconnect mid-run. */
  function disconnectAt(net: Net, n: number, sql: string): void {
    const f = net.fetch
    let calls = 0
    net.fetch = (async (u: string | URL | Request, i?: RequestInit) => {
      if (String(u).startsWith('https://api.anthropic.com/') && ++calls === n) db.exec(sql)
      return f(u, i)
    }) as typeof fetch
  }
  const REVOKE_SQL = `UPDATE email_connections SET status = 'revoked', token_ct = NULL, token_iv = NULL, key_id = NULL, watermark_at = NULL, last_error = NULL, google_email = NULL WHERE id = '${CONN}'`

  it('a run still going when the person disconnects writes no watermark and no error back onto the disconnected row', async () => {
    const net = makeNet({ messages: 3 })
    disconnectAt(net, 2, REVOKE_SQL)
    const out = await runConnection(makeEnv(), CONN, null, 'cron', { fetch: net.fetch, now: () => NOW })
    expect(out.errorCode).toBe('not_active')
    expect(count('receipts')).toBe(1) // the first message, stored before the disconnect; the second was dropped by the insert guard
    expect(conn()).toMatchObject({ status: 'revoked', watermark_at: null, last_error: null })
  })

  it('the same for a disconnect that has only paused the row so far', async () => {
    const net = makeNet({ messages: 3 })
    disconnectAt(net, 2, `UPDATE email_connections SET status = 'paused', watermark_at = NULL, last_error = NULL WHERE id = '${CONN}'`)
    await runConnection(makeEnv(), CONN, null, 'cron', { fetch: net.fetch, now: () => NOW })
    expect(conn()).toMatchObject({ status: 'paused', watermark_at: null, last_error: null })
  })

  it('a disconnect during a run (no purge) suggests and applies nothing afterwards, even with auto-apply on', async () => {
    const t1 = insertTxn(db, { posted_date: '2026-12-02', amount_cents: -1234, updated_at: '2026-12-03T00:00:00.000Z' })
    db.exec(`UPDATE transactions SET updated_by = 'script:load' WHERE id = '${t1}'`)
    const before = snapshotTxns()
    const net = makeNet({ messages: 3 })
    disconnectAt(net, 2, `UPDATE email_connections SET status = 'paused' WHERE id = '${CONN}'`)
    const out = await runConnection(makeEnv({ RECEIPTS_AUTO_APPLY: '1' }), CONN, null, 'cron', { fetch: net.fetch, now: () => NOW })
    expect(out.errorCode).toBe('not_active')
    expect(count('receipts')).toBe(1)
    expect(count('receipt_matches')).toBe(0)
    expect(snapshotTxns()).toBe(before)
  })

  it('a token-endpoint failure is a run code and burns no message attempt', async () => {
    await S.insertReceipt(db.d1, { connectionId: CONN, gmailMsgId: hexId(0), emailDate: '2026-12-01', extracted: null, failureCode: 'extract_invalid' }, NOW)
    expect(db.get<{ attempts: number }>('SELECT attempts FROM receipts')?.attempts).toBe(1)
    const out = await run(makeEnv(), makeNet({ messages: 1, tokenStatus: 401 }))
    expect(out.errorCode).toBe('client_error')
    expect(db.get<{ attempts: number }>('SELECT attempts FROM receipts')?.attempts).toBe(1)
  })
})

describe('time slices (a backfill larger than one list loses nothing)', () => {
  const T0 = NOW.getTime() - 13 * 86_400_000
  const times = Array.from({ length: 250 }, (_, i) => T0 + i * 1_800_000) // 250 matches, 30 minutes apart, about 5 days
  const idsStored = (): string[] => db.all<{ gmail_msg_id: string }>('SELECT gmail_msg_id FROM receipts ORDER BY gmail_msg_id').map((r) => r.gmail_msg_id)
  const big = (over: Partial<Env> = {}): Env => makeEnv({ RECEIPTS_MAX_PER_RUN: '1000', RECEIPTS_DAILY_CAP: '1000', ...over })

  it('250 matches (more than the 200 one list can hold) are all handled, oldest first', async () => {
    const net = makeNet({ times })
    const out = await run(big(), net)
    expect(out.errorCode).toBeNull()
    expect(count('receipts')).toBe(250)
    expect(idsStored()).toEqual(Array.from({ length: 250 }, (_, i) => hexId(i)))
    // The first list (7-day slice) had more pages, so a smaller slice was listed after it.
    expect(net.queries.length).toBeGreaterThan(1)
    expect(net.queries.every((q) => /after:\d+/.test(q))).toBe(true)
    expect(net.queries.some((q) => /before:\d+/.test(q))).toBe(true)
  })

  it('with a small per-run cap the watermark never passes an unhandled message and later runs finish the list', async () => {
    const net = makeNet({ times })
    const env = big({ RECEIPTS_MAX_PER_RUN: '100' })
    await run(env, net)
    expect(idsStored()).toEqual(Array.from({ length: 100 }, (_, i) => hexId(i)))
    expect(conn().watermark_at).toBe(new Date(times[99]).toISOString())
    await run(env, net)
    expect(idsStored()).toEqual(Array.from({ length: 200 }, (_, i) => hexId(i)))
    expect(new Date(String(conn().watermark_at)).getTime()).toBeLessThanOrEqual(times[199])
    await run(env, net)
    expect(idsStored()).toEqual(Array.from({ length: 250 }, (_, i) => hexId(i)))
  })

  it('a slice that had more pages than one list holds is halved, not truncated to its newest 200', async () => {
    const net = makeNet({ times })
    await run(big({ RECEIPTS_MAX_PER_RUN: '1' }), net)
    // The oldest message, which a newest-first list of 200 would have dropped, is the one handled.
    expect(idsStored()).toEqual([hexId(0)])
  })

  it('a slice that fit lets the next slice grow back, so one dense stretch does not spend the whole run on short lists', async () => {
    const net = makeNet({ times })
    await run(big(), net)
    // Halved once (7 d -> 3.5 d), then grown back to a week for the next slice: 3 lists reach 250 matches, not 5.
    expect(new Set(net.queries).size).toBeLessThanOrEqual(4) // one query per list call (a list may read two pages)
    expect(count('receipts')).toBe(250)
  })

  it('a one-hour slice that still has more pages is not complete: the watermark stays at the newest message handled', async () => {
    const start = NOW.getTime() - 14 * 86_400_000 + 60_000
    const dense = Array.from({ length: 250 }, (_, i) => start + i * 1_000) // 250 matches inside one hour
    const net = makeNet({ times: dense })
    await run(big({ RECEIPTS_BACKFILL_DAYS: '14' }), net, CONN, { maxLists: 20 })
    const wm = new Date(String(conn().watermark_at)).getTime()
    expect(wm).toBe(dense[249])
    expect(wm).toBeLessThan(start - 60_000 + 3_600_000) // not the slice end
  })
})

describe('scheduled', () => {
  it('runs every active connection once, each into its own run row, and prunes nothing it should keep', async () => {
    await addConn(CONN_B, OTHER)
    db.sqlite.prepare(`UPDATE email_connections SET status = 'paused' WHERE id = ?`).run(CONN_B)
    const net = makeNet({ messages: 1 })
    vi.stubGlobal('fetch', net.fetch)
    try {
      await handleScheduled(makeEnv())
    } finally {
      vi.unstubAllGlobals()
    }
    expect(db.all<{ connection_id: string; run_trigger: string }>('SELECT connection_id, run_trigger FROM receipt_sync_runs')).toEqual([{ connection_id: CONN, run_trigger: 'cron' }])
    expect(count('receipts')).toBe(1)
  })
})

describe('POST /sync', () => {
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext
  const post = (body: unknown, env = makeEnv(), method = 'POST') =>
    handleFetch(new Request('https://receipts.internal/sync', { method, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined }), env, ctx)
  const bodyOf = async (r: Response) => (await r.json()) as { ok: boolean; code?: string }
  let runId: number
  beforeEach(async () => {
    pending.length = 0
    await addConn(CONN_B, OTHER)
    runId = await S.createRun(db.d1, CONN, 'manual', NOW)
  })

  it('answers 202 at once and fills run row runId in waitUntil', async () => {
    const net = makeNet({ messages: 2 })
    vi.stubGlobal('fetch', net.fetch)
    try {
      const res = await post({ connectionId: CONN, runId, email: OWNER })
      expect(res.status).toBe(202)
      expect(await bodyOf(res)).toEqual({ ok: true })
      expect(lastRun().finished_at).toBeNull() // the work has not been awaited yet
      await Promise.all(pending)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(lastRun()).toMatchObject({ id: runId, run_trigger: 'manual', fetched: 2, extracted: 2, error_code: null })
    expect(lastRun().finished_at).not.toBeNull()
    expect(count('receipt_sync_runs')).toBe(1)
  })

  it('ownership: another person, an unknown connection and an off-list address all get the same 403', async () => {
    for (const b of [
      { connectionId: CONN, runId, email: OTHER },
      { connectionId: CONN_B, runId, email: OWNER },
      { connectionId: 'c0000000000000000', runId, email: OWNER },
      { connectionId: CONN, runId, email: 'stranger@example.com' },
    ]) {
      const res = await post(b)
      expect([res.status, await bodyOf(res)]).toEqual([403, { ok: false, code: 'forbidden' }])
    }
    // On the connection but off the allowlist.
    const res = await post({ connectionId: CONN, runId, email: OWNER }, makeEnv({ RECEIPTS_ALLOWED_EMAILS: sec(OTHER) }))
    expect(res.status).toBe(403)
    expect(pending).toHaveLength(0)
    expect(lastRun().finished_at).toBeNull()
  })

  it('fixed 4xx codes for a bad body, method, size, state and a run row that is not open', async () => {
    const code = async (r: Response) => [r.status, (await bodyOf(r)).code]
    expect(await code(await post('not json'))).toEqual([400, 'bad_request'])
    expect(await code(await post({ connectionId: CONN, runId: '1', email: OWNER }))).toEqual([400, 'bad_request'])
    expect(await code(await post({ connectionId: 'x', runId, email: OWNER }))).toEqual([400, 'bad_request'])
    expect(await code(await post('x'.repeat(5000)))).toEqual([413, 'too_large'])
    expect(await code(await post({}, makeEnv(), 'GET'))).toEqual([405, 'method_not_allowed'])
    expect(await code(await post({ connectionId: CONN, runId: runId + 50, email: OWNER }))).toEqual([409, 'run_invalid'])
    expect(await code(await post({ connectionId: CONN, runId, email: OWNER }, makeEnv({ RECEIPTS_ALLOWED_EMAILS: undefined })))).toEqual([503, 'secrets_missing'])
    db.sqlite.prepare(`UPDATE email_connections SET status = 'paused' WHERE id = ?`).run(CONN)
    expect(await code(await post({ connectionId: CONN, runId, email: OWNER }))).toEqual([409, 'not_active'])
  })
})

describe('router', () => {
  it('GET to /exchange and /disconnect is non-2xx, and a POST reaches the handler', async () => {
    const ctx = { waitUntil() {} } as unknown as ExecutionContext
    for (const p of ['/exchange', '/disconnect']) {
      const get = await handleFetch(new Request(`https://receipts.internal${p}`), makeEnv(), ctx)
      expect(get.status).toBeGreaterThanOrEqual(400)
      // A bad POST body gets the handler's own fixed answer (never the router's 404): the handler was reached.
      const post = await handleFetch(new Request(`https://receipts.internal${p}`, { method: 'POST', body: '{}' }), makeEnv(), ctx)
      expect([post.status, await post.json()]).toEqual(p === '/exchange' ? [200, { ok: false, code: 'exchange_failed' }] : [400, { revoked: false }])
    }
  })

  it('has exactly the sync, exchange and disconnect routes; every other path is a 404 with a fixed body', async () => {
    expect(Object.keys(ROUTES)).toEqual(['/sync', '/exchange', '/disconnect'])
    const ctx = { waitUntil() {} } as unknown as ExecutionContext
    for (const p of ['/', '/sync/', '/SYNC', '/exchange-x', '/__proto__', '/constructor', '/toString', '/sync/../x', '/%73ync']) {
      const res = await handleFetch(new Request(`https://receipts.internal${p}`, { method: 'POST', body: '{}' }), makeEnv(), ctx)
      expect([res.status, await res.json()]).toEqual([404, { ok: false, code: 'not_found' }])
    }
  })
})

describe('logging', () => {
  it('log() writes only an event, numbers and one code; anything else is dropped', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log('run_done', { listed: 3, fetched: 2.9, 'bad key!': 1, nan: Number.NaN, str: 'x@example.com' as unknown as number }, 'api_limited')
    log('Bad Event With Spaces', {}, 'not a code!')
    expect(spy.mock.calls.map((c) => JSON.parse(c[0] as string))).toEqual([{ event: 'run_done', listed: 3, fetched: 2, code: 'api_limited' }, { event: 'invalid_event' }])
    spy.mockRestore()
  })

  it('a run logs counts and codes only: no address, id, token or key reaches the console', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await run(makeEnv(), makeNet({ messages: 2 }))
    const text = spy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(text).toContain('run_done')
    for (const secret of [OWNER, REFRESH, KEY, 'fake-anthropic-key', hexId(0), 'Fake Mart', 'shop.example.com']) expect(text).not.toContain(secret)
    expect(err).not.toHaveBeenCalled()
    spy.mockRestore()
    err.mockRestore()
  })

  it('workers/receipts/src has no console.* except the one in log.ts', () => {
    const dir = join(fileURLToPath(import.meta.url), '..', '..', 'src')
    const hits: string[] = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const code = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      const n = (code.match(/\bconsole\s*[.[]/g) ?? []).length
      if (n > 0) hits.push(`${f}:${n}`)
    }
    expect(hits).toEqual(['log.ts:1'])
  })
})
