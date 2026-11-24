// /api/budget/email/status, /sync and /disconnect: the access matrix (every method x identity through the root gate and
// the scoped middleware), status redaction, the sync rate limit and Worker contract, disconnect (cascade, purge,
// failed revoke still clears locally), and counts-and-codes-only logging. Made-up data only; the Service Binding and
// Google are fetch mocks, D1 is the in-memory SQLite stand-in.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authGate, createSessionCookie, readAuthConfig, type ViewerStore } from '../../../_lib/auth'
import type { BudgetData, BudgetEnv } from '../../../_lib/budgetAccess'
import { createBudgetDb, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import { onRequest as catchAll } from '../[[path]]'
import { onRequest as middleware } from '../_middleware'
import { onRequest as disconnect } from './disconnect'
import { nextRunAt, onRequest as status } from './status'
import { onRequest as sync, SYNC_MIN_GAP_MS } from './sync'

const ORIGIN = 'https://stats.goodstuff.software'
const A = 'user-a@example.com'
const B = 'user-b@example.com'
const UNLISTED = 'unlisted@example.com'
const NOW = '2026-12-05T10:00:00.000Z'
const CONN_A = 'c0123456789abcdef'
const CONN_B = 'cfedcba9876543210'
const SUB_A = 'sub-secret-aaaa-111'
const SUB_B = 'sub-secret-bbbb-222'
const KEY_ID = '0a1b2c3d'
const TOKEN_CT = 'Q0lQSEVSVEVYVC1BLVNFQ1JFVA=='
const MARKER_ERR = 'api_rejected'

const HANDLERS = { status, sync, disconnect } as const
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const SUPPORTED: Record<keyof typeof HANDLERS, string[]> = { status: ['GET', 'HEAD'], sync: ['POST'], disconnect: ['POST'] }

function env(db: FakeBudgetDb, extra: Partial<BudgetEnv> & Record<string, unknown> = {}): BudgetEnv {
  return {
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'c'.repeat(48),
    ALLOWED_EMAILS: `${A},${B},${UNLISTED}`,
    BUDGET_ALLOWED_EMAILS: `${A},${B}`,
    STATS_CONFIG: { get: async () => null, put: async () => undefined } as unknown as ViewerStore as never,
    BUDGET_DB: db.d1,
    ...extra,
  } as BudgetEnv
}

interface Bound {
  fetch: ReturnType<typeof vi.fn>
}
function binding(impl: (url: string, init: RequestInit) => Response | Promise<Response>): Bound {
  return { fetch: vi.fn(async (url: string, init: RequestInit) => impl(url, init)) }
}
const okBinding = (): Bound =>
  binding((url) => (url.endsWith('/sync') ? new Response('{"ok":true}', { status: 202 }) : new Response('{"revoked":true}', { status: 200 })))

async function call(
  e: BudgetEnv,
  who: string | null,
  name: keyof typeof HANDLERS,
  method: string,
  body?: unknown,
  path = `/api/budget/email/${name}`,
): Promise<{ res: Response; reached: boolean }> {
  const headers = new Headers()
  if (who) {
    const r = readAuthConfig(e)
    if (!r.ok) throw new Error(r.problems.join('; '))
    const session = { email: who, sub: `s-${who}` }
    headers.set('Cookie', (await createSessionCookie(new URL(ORIGIN), r.config, session as never, Date.now())).split(';')[0])
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('Origin', ORIGIN)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  const request = new Request(ORIGIN + path, {
    method,
    headers,
    body: body === undefined || ['GET', 'HEAD'].includes(method) ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const data: BudgetData = {}
  let reached = false
  const ctx = {
    request,
    env: e,
    data,
    params: {},
    next: async () => {
      reached = true
      return HANDLERS[name]({ request, env: e, data, params: {} } as never)
    },
  }
  const res = await authGate(request, e, () => Promise.resolve(middleware(ctx as never)) as Promise<Response>)
  return { res, reached }
}

const j = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T

let db: FakeBudgetDb
beforeEach(async () => {
  db = await createBudgetDb({ seed: false })
})
afterEach(() => vi.restoreAllMocks())

function conn(id: string, owner: string, sub: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id,
    owner_email: owner,
    google_sub: sub,
    status: 'active',
    token_ct: TOKEN_CT,
    token_iv: 'aXZpdml2aXZpaQ==',
    key_id: KEY_ID,
    scopes: 'gmail.readonly',
    consent_version: 1,
    consented_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
  const keys = Object.keys(row)
  db.sqlite.prepare(`INSERT INTO email_connections (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(keys.map((k) => row[k]) as never[]))
}
function run(connection: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = { connection_id: connection, run_trigger: 'cron', started_at: NOW, ...over }
  const keys = Object.keys(row)
  db.sqlite.prepare(`INSERT INTO receipt_sync_runs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(keys.map((k) => row[k]) as never[]))
}
function receipt(id: string, connection: string, msg: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO receipts (id, connection_id, gmail_msg_id, email_date, status, created_at, updated_at, updated_by) VALUES (?, ?, ?, '2026-11-10', 'unmatched', ?, ?, 'test')`,
    )
    .run(id, connection, msg, NOW, NOW)
  db.sqlite.prepare('INSERT INTO receipt_items (receipt_id, seq, description) VALUES (?, 1, ?)').run(id, 'made-up item')
}
const count = (table: string, where = '1=1'): number => (db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`) as { n: number }).n

describe('access matrix: every method x identity on every path', () => {
  for (const name of Object.keys(HANDLERS) as (keyof typeof HANDLERS)[]) {
    for (const method of METHODS) {
      it(`${method} /email/${name}`, async () => {
        conn(CONN_A, A, SUB_A)
        const rb = okBinding()
        const e = env(db, { RECEIPTS: rb, RECEIPTS_GMAIL_CLIENT_ID: 'x' })
        const body = method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? undefined : { purge: false }
        for (const who of [null, UNLISTED, A] as const) {
          const label = `${who} ${method} ${name}`
          const { res, reached } = await call(e, who, name, method, body)
          if (who === null) expect(res.status, label).toBe(401)
          else if (who === UNLISTED) {
            expect(res.status, label).toBe(403)
            expect(reached, label).toBe(false)
          } else if (SUPPORTED[name].includes(method)) expect([200, 202, 429]).toContain(res.status)
          else expect(res.status, label).toBe(405)
          if (who !== null && who !== A) expect(rb.fetch, label).not.toHaveBeenCalled()
        }
      })
    }
  }

  it('the handlers alone answer 403 when the middleware did not set an identity', async () => {
    for (const h of Object.values(HANDLERS)) {
      const res = await h({ request: new Request(ORIGIN + '/x', { method: 'POST' }), env: env(db), data: {}, params: {} } as never)
      expect(res.status).toBe(403)
    }
  })

  it('an unknown email path is still 404 for a listed person and 403 for others (catch-all)', async () => {
    const e = env(db)
    const mk = async (who: string) => {
      const r = readAuthConfig(e)
      if (!r.ok) throw new Error('cfg')
      const cookie = (await createSessionCookie(new URL(ORIGIN), r.config, { email: who, sub: 's' }, Date.now())).split(';')[0]
      const request = new Request(ORIGIN + '/api/budget/email/nope', { headers: { Cookie: cookie } })
      const data: BudgetData = {}
      const ctx = { request, env: e, data, next: async () => catchAll({ request, env: e, data, params: {} } as never) }
      return authGate(request, e, () => Promise.resolve(middleware(ctx as never)) as Promise<Response>)
    }
    expect((await mk(A)).status).toBe(404)
    expect((await mk(UNLISTED)).status).toBe(403)
  })
})

describe('GET status', () => {
  it('returns the caller\'s own connection and last runs, and never a token, key id or sub', async () => {
    conn(CONN_A, A, SUB_A, { last_run_at: NOW, last_ok_at: NOW, last_error: MARKER_ERR })
    conn(CONN_B, B, SUB_B, { last_error: 'rate_limited' })
    for (let i = 0; i < 7; i++) run(CONN_A, { started_at: `2026-12-05T0${i}:00:00.000Z`, listed: i, error_code: i === 6 ? 'api_limited' : null })
    run(CONN_B, { listed: 99, error_code: 'needs_reconnect' })
    const e = env(db, { RECEIPTS: okBinding(), RECEIPTS_GMAIL_CLIENT_ID: 'x' })
    const { res } = await call(e, A, 'status', 'GET')
    expect(res.status).toBe(200)
    const text = await res.text()
    for (const secret of [TOKEN_CT, KEY_ID, SUB_A, SUB_B, CONN_A, CONN_B, 'aXZpdml2aXZpaQ==', B, 'needs_reconnect', 'google_sub', 'token', 'key_id']) {
      expect(text, secret).not.toContain(secret)
    }
    const body = JSON.parse(text) as { configured: boolean; connection: Record<string, unknown>; lastRuns: Record<string, unknown>[]; nextRunAt: string }
    expect(body.configured).toBe(true)
    expect(body.connection).toEqual({ status: 'active', lastRunAt: NOW, lastOkAt: NOW, lastError: MARKER_ERR, consentVersion: 1 })
    expect(body.lastRuns).toHaveLength(5)
    expect(body.lastRuns[0].errorCode).toBe('api_limited') // newest first; a distinct code is surfaced
    expect(body.lastRuns.every((r) => (r.listed as number) < 99)).toBe(true) // none of B's runs
    expect(Object.keys(body.lastRuns[0]).sort()).toEqual(
      ['autoApplied', 'errorCode', 'extracted', 'fetched', 'finishedAt', 'listed', 'matched', 'skipped', 'startedAt', 'trigger'],
    )
    expect(Date.parse(body.nextRunAt)).toBeGreaterThan(Date.now())
  })

  it('says not connected, and not configured when the binding or client id is missing', async () => {
    const { res } = await call(env(db), A, 'status', 'GET')
    expect(await j(res)).toEqual({ configured: false, connection: null, lastRuns: [], nextRunAt: null })
    const full = await call(env(db, { RECEIPTS: okBinding(), RECEIPTS_GMAIL_CLIENT_ID: 'x' }), B, 'status', 'GET')
    expect((await j<{ configured: boolean }>(full.res)).configured).toBe(true)
  })

  it('shows another person nothing of the caller, and no next run for an unusable connection', async () => {
    conn(CONN_A, A, SUB_A, { status: 'needs_reconnect', token_ct: null, token_iv: null, key_id: null, last_error: 'needs_reconnect' })
    const b = await j<{ connection: unknown }>((await call(env(db), B, 'status', 'GET')).res)
    expect(b.connection).toBeNull()
    const a = await j<{ connection: { status: string }; nextRunAt: unknown }>((await call(env(db), A, 'status', 'GET')).res)
    expect(a.connection.status).toBe('needs_reconnect')
    expect(a.nextRunAt).toBeNull()
  })

  it('is one batch of two reads', async () => {
    conn(CONN_A, A, SUB_A)
    const before = db.statements.length
    await call(env(db), A, 'status', 'GET')
    expect(db.statements.length - before).toBe(2)
  })

  it('computes the next :23 UTC cron time', () => {
    expect(nextRunAt(new Date('2026-12-05T10:10:30Z'))).toBe('2026-12-05T10:23:00.000Z')
    expect(nextRunAt(new Date('2026-12-05T10:23:00Z'))).toBe('2026-12-05T11:23:00.000Z')
    expect(nextRunAt(new Date('2026-12-05T23:50:00Z'))).toBe('2026-12-06T00:23:00.000Z')
  })
})

describe('POST sync', () => {
  it('asks the Worker for this caller\'s connection only, with the run id it just reserved', async () => {
    conn(CONN_A, A, SUB_A)
    conn(CONN_B, B, SUB_B)
    const rb = okBinding()
    const { res } = await call(env(db, { RECEIPTS: rb }), A, 'sync', 'POST', {})
    expect(res.status).toBe(202)
    expect(rb.fetch).toHaveBeenCalledOnce()
    const [url, init] = rb.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://receipts.internal/sync')
    const sent = JSON.parse(init.body as string) as { connectionId: string; runId: number; email: string }
    expect(sent.connectionId).toBe(CONN_A)
    expect(sent.email).toBe(A)
    expect(db.get<{ connection_id: string; run_trigger: string }>('SELECT connection_id, run_trigger FROM receipt_sync_runs WHERE id = ?', sent.runId)).toEqual({
      connection_id: CONN_A,
      run_trigger: 'manual',
    })
    expect(count('receipt_sync_runs', `connection_id = '${CONN_B}'`)).toBe(0)
  })

  it('rate limits: a second Check now within 5 minutes is 429 and never reaches the Worker', async () => {
    conn(CONN_A, A, SUB_A)
    const rb = okBinding()
    const e = env(db, { RECEIPTS: rb })
    expect((await call(e, A, 'sync', 'POST', {})).res.status).toBe(202)
    for (let i = 0; i < 5; i++) {
      const { res } = await call(e, A, 'sync', 'POST', {})
      expect(res.status).toBe(429)
      expect((await j<{ error: string; retryAfterSec: number }>(res)).error).toBe('rate_limited')
      expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    }
    expect(rb.fetch).toHaveBeenCalledOnce()
    expect(count('receipt_sync_runs')).toBe(1)
  })

  it('a recent cron run counts, an older one does not, and the other person has their own limit', async () => {
    conn(CONN_A, A, SUB_A)
    conn(CONN_B, B, SUB_B)
    run(CONN_A, { started_at: new Date(Date.now() - 60_000).toISOString() })
    const rb = okBinding()
    const e = env(db, { RECEIPTS: rb })
    expect((await call(e, A, 'sync', 'POST', {})).res.status).toBe(429)
    expect((await call(e, B, 'sync', 'POST', {})).res.status).toBe(202)
    db.exec(`UPDATE receipt_sync_runs SET started_at = '${new Date(Date.now() - SYNC_MIN_GAP_MS - 1000).toISOString()}' WHERE connection_id = '${CONN_A}'`)
    expect((await call(e, A, 'sync', 'POST', {})).res.status).toBe(202)
  })

  it('a missing binding is the fixed code receipts_unavailable and uses no run slot', async () => {
    conn(CONN_A, A, SUB_A)
    const { res } = await call(env(db), A, 'sync', 'POST', {})
    expect(res.status).toBe(503)
    expect(await j(res)).toEqual({ error: 'receipts_unavailable' })
    expect(count('receipt_sync_runs')).toBe(0)
  })

  it('refuses when there is no usable connection', async () => {
    const e = env(db, { RECEIPTS: okBinding() })
    expect(await j((await call(e, A, 'sync', 'POST', {})).res)).toEqual({ error: 'not_connected' })
    conn(CONN_A, A, SUB_A, { status: 'needs_reconnect', token_ct: null, token_iv: null, key_id: null })
    const r = await call(e, A, 'sync', 'POST', {})
    expect(r.res.status).toBe(409)
    expect(await j(r.res)).toEqual({ error: 'reconnect_needed' })
  })

  it('a Worker failure is 502 and closes the reserved run with a code', async () => {
    conn(CONN_A, A, SUB_A)
    for (const rb of [binding(() => new Response('boom', { status: 500 })), binding(() => { throw new Error('down') })]) {
      db.exec('DELETE FROM receipt_sync_runs')
      const { res } = await call(env(db, { RECEIPTS: rb }), A, 'sync', 'POST', {})
      expect(res.status).toBe(502)
      expect(await j(res)).toEqual({ error: 'receipts_failed' })
      expect(db.get<{ error_code: string; finished_at: string }>('SELECT error_code, finished_at FROM receipt_sync_runs')?.error_code).toBe('worker_failed')
    }
  })
})

describe('POST disconnect', () => {
  function seed(): void {
    conn(CONN_A, A, SUB_A)
    conn(CONN_B, B, SUB_B)
    receipt('r0000000000000a01', CONN_A, '18c3f2a9b7d4e610')
    receipt('r0000000000000b01', CONN_B, '18c3f2a9b7d4e611')
    run(CONN_A)
    run(CONN_B)
    db.sqlite.prepare("INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, txn_updated_at, created_at) SELECT 'r0000000000000a01', id, 'g', 'exact', 100, 90, 'suggested', ?, ? FROM transactions LIMIT 1").run(NOW, NOW)
  }

  it('needs an explicit boolean purge in the body', async () => {
    seed()
    const e = env(db, { RECEIPTS: okBinding() })
    for (const body of [undefined, {}, { purge: 'yes' }, { purge: 1 }, { purge: true, extra: 1 }, '[]', 'not json']) {
      const { res } = await call(e, A, 'disconnect', 'POST', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(db.get<{ status: string }>(`SELECT status FROM email_connections WHERE id = '${CONN_A}'`)?.status).toBe('active')
  })

  it('revokes via the Worker, clears the token material and keeps the receipts when purge is false', async () => {
    seed()
    const rb = okBinding()
    const { res } = await call(env(db, { RECEIPTS: rb }), A, 'disconnect', 'POST', { purge: false })
    expect(await j(res)).toEqual({ ok: true, revoked: true, purged: false })
    const [url, init] = rb.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://receipts.internal/disconnect')
    expect(JSON.parse(init.body as string)).toEqual({ connectionId: CONN_A })
    expect(db.get(`SELECT status, token_ct, token_iv, key_id FROM email_connections WHERE id = '${CONN_A}'`)).toEqual({ status: 'revoked', token_ct: null, token_iv: null, key_id: null })
    expect(count('receipts', `connection_id = '${CONN_A}'`)).toBe(1)
  })

  it('purge:true cascades receipts, items, matches and runs for the caller only', async () => {
    seed()
    const { res } = await call(env(db, { RECEIPTS: okBinding() }), A, 'disconnect', 'POST', { purge: true })
    expect(await j(res)).toEqual({ ok: true, revoked: true, purged: true })
    expect(count('receipts', `connection_id = '${CONN_A}'`)).toBe(0)
    expect(count('receipt_items', "receipt_id = 'r0000000000000a01'")).toBe(0)
    expect(count('receipt_matches', "receipt_id = 'r0000000000000a01'")).toBe(0)
    expect(count('receipt_sync_runs', `connection_id = '${CONN_A}'`)).toBe(0)
    expect(count('receipts', `connection_id = '${CONN_B}'`)).toBe(1)
    expect(count('receipt_items', "receipt_id = 'r0000000000000b01'")).toBe(1)
    expect(count('receipt_sync_runs', `connection_id = '${CONN_B}'`)).toBe(1)
    expect(db.get<{ status: string }>(`SELECT status FROM email_connections WHERE id = '${CONN_B}'`)?.status).toBe('active')
  })

  it('a failed or absent revoke still clears locally and says revoked:false', async () => {
    for (const rb of [
      binding(() => new Response('{"revoked":false}', { status: 200 })),
      binding(() => new Response('x', { status: 500 })),
      binding(() => { throw new Error('down') }),
      undefined,
    ]) {
      db = await createBudgetDb({ seed: false })
      seed()
      const { res } = await call(env(db, rb ? { RECEIPTS: rb } : {}), A, 'disconnect', 'POST', { purge: true })
      expect(await j(res)).toEqual({ ok: true, revoked: false, purged: true })
      expect(db.get<{ status: string; token_ct: null }>(`SELECT status, token_ct FROM email_connections WHERE id = '${CONN_A}'`)).toEqual({ status: 'revoked', token_ct: null })
      expect(count('receipts', `connection_id = '${CONN_A}'`)).toBe(0)
    }
  })

  it('404 when there is no connection; another person\'s connection is never touched', async () => {
    conn(CONN_B, B, SUB_B)
    const rb = okBinding()
    const { res } = await call(env(db, { RECEIPTS: rb }), A, 'disconnect', 'POST', { purge: true })
    expect(res.status).toBe(404)
    expect(rb.fetch).not.toHaveBeenCalled()
    expect(db.get<{ status: string }>(`SELECT status FROM email_connections WHERE id = '${CONN_B}'`)?.status).toBe('active')
  })
})

describe('logging is counts and codes only', () => {
  it('the three route files never call console', () => {
    for (const f of ['status', 'sync', 'disconnect']) {
      expect(readFileSync(`functions/api/budget/email/${f}.ts`, 'utf8'), f).not.toMatch(/console\./)
    }
  })

  it('a full set of calls logs nothing that names an address, id, token or sub', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
    conn(CONN_A, A, SUB_A)
    const e = env(db, { RECEIPTS: binding(() => { throw new Error(`down ${A} ${TOKEN_CT}`) }), RECEIPTS_GMAIL_CLIENT_ID: 'x' })
    await call(e, A, 'status', 'GET')
    await call(e, A, 'sync', 'POST', {})
    await call(e, A, 'disconnect', 'POST', { purge: true })
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls))
    for (const secret of [A, TOKEN_CT, SUB_A, CONN_A, KEY_ID]) expect(logged).not.toContain(secret)
  })
})
