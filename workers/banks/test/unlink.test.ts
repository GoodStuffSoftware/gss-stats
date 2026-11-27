// POST /unlink (plan 3.3). Plaid is a stub that throws on any URL it was not told to expect; D1 is the fake over the real migrations.
// Every value is made up.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBudgetDb, type FakeBudgetDb } from '../../../functions/_lib/testing/budgetDb'
import { handleUnlink } from '../src/unlink'
import { sealToken, type Keys } from '../src/store'
import type { Env } from '../src/env'
import type { RouteInput } from '../src/index'

const secret = (v: string) => ({ get: async () => v })
const BASE = 'https://sandbox.plaid.com'
const REMOVE = `${BASE}/item/remove`
const ACCESS = 'access-sandbox-test-token'
const KEY = btoa('0123456789abcdef0123456789abcdef')
const KEYS: Keys = { current: KEY, old: null }
const ITEM = 'i000000000000a001'
const OWNER = 'owner@example.com'
const CHK = 'b000000000000c001', CARD = 'b000000000000c002'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const plaidError = (type: string, code: string) => json({ error_type: type, error_code: code, error_message: 'text that must never be kept', request_id: 'r' }, 400)

let db: FakeBudgetDb
let queue: Array<() => Response>
let fetched: Array<{ url: string; body: Record<string, unknown> }>
let allowed: Set<string>
let envOver: Partial<Env>

const makeEnv = (): Env => ({
  BUDGET_DB: db.d1, PLAID_CLIENT_ID: secret('client-id-sandbox-test'), PLAID_SECRET: secret('secret-value-sandbox-test'),
  BANKS_TOKEN_KEY: secret(KEY), PLAID_ENV: 'sandbox', ...envOver,
})
const stubFetch = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url)
  fetched.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) })
  if (!allowed.has(u)) throw new Error(`unexpected fetch ${u}`)
  const next = queue.shift()
  if (!next) throw new Error('no response queued')
  return Promise.resolve(next())
}) as typeof fetch

const unlink = (body: Record<string, unknown> = { itemId: ITEM }, ownerEmail = OWNER, env: Env = makeEnv()) => {
  const raw = JSON.stringify(body)
  const input: RouteInput = { request: new Request('https://banks.test/unlink', { method: 'POST', body: raw }), env, ctx: {} as ExecutionContext, raw, body, ownerEmail }
  return handleUnlink(input, { fetch: stubFetch, now: () => new Date('2026-11-27T12:00:00Z') })
}

const run = (sql: string, ...v: unknown[]) => void (db.sqlite.prepare(sql) as any).run(...v)
const q = <T = Record<string, any>>(sql: string, ...v: unknown[]) => db.all<T>(sql, ...v)
const one = <T = Record<string, any>>(sql: string, ...v: unknown[]) => db.get<T>(sql, ...v)
const item = () => one('SELECT * FROM bank_items WHERE id = ?', ITEM)!

async function seed(o: { status?: string } = {}): Promise<void> {
  const status = o.status ?? 'active'
  const live = status === 'active' || status === 'needs_reconnect' || status === 'pending_disconnect'
  const enc = await sealToken(ACCESS, ITEM, KEYS)
  run(`INSERT INTO accounts (id, label, kind, is_debt) VALUES ('chk', 'Everyday Checking', 'checking', 0), ('crd', 'Pine Ridge Card', 'card', 1)`)
  run(
    `INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, status, token_ct, token_iv, key_id, sync_cursor, initial_done,
       consent_version, consented_at, created_at, updated_at)
     VALUES (?, ?, 'sandbox', 'item-plaid-001', ?, ?, ?, ?, ?, 1, 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    ITEM, OWNER, status, live ? enc.token_ct : null, live ? enc.token_iv : null, live ? enc.key_id : null, live ? 'cur-0' : null,
  )
  const ba = (id: string, plaid: string, name: string, type: string, acct: string) =>
    run(`INSERT INTO bank_accounts (id, item_id, plaid_account_id, name, type, account_id, sync, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'on', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`, id, ITEM, plaid, name, type, acct)
  ba(CHK, 'acc-chk', 'Everyday Checking', 'depository', 'chk')
  ba(CARD, 'acc-card', 'Pine Ridge Card', 'credit', 'crd')
  run(`INSERT INTO bank_liabilities (bank_account_id, kind, apr_bp, fetched_at) VALUES (?, 'credit', 2199, '2026-11-26T00:00:00Z')`, CARD)
  // Budget data that must outlive the link: an import, one synced transaction and its bank_txns claim.
  run(`INSERT INTO imports (id, source_label, created_at, created_by, rows_in) VALUES ('imp-1', 'sync', '2026-11-02T00:00:00Z', 'seed@example.com', 1)`)
  run(
    `INSERT INTO transactions (id, account_id, import_id, posted_date, amount_cents, description, kind, kind_source, category_source, confidence,
       needs_review, updated_at, updated_by) VALUES ('t0000000000000000000000000000001', 'chk', 'imp-1', '2026-11-20', -1250, 'Corner Cafe', 'spend', 'auto', 'none', 60, 0,
       '2026-11-20T00:00:00.000Z', 'seed@example.com')`,
  )
  run(`INSERT INTO bank_txns (plaid_txn_id, bank_account_id, txn_id, role, seen_at, updated_at)
       VALUES ('ptx-1', ?, 't0000000000000000000000000000001', 'inserted', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z')`, CHK)
  run(`INSERT INTO plaid_slot_log (environment, status, plaid_item_id, created_at, created_by, finished_at)
       VALUES ('sandbox', 'done', 'item-plaid-001', '2026-11-01T00:00:00Z', ?, '2026-11-01T00:00:01Z')`, OWNER)
}

/** Everything the unlink must leave alone. */
const keptState = () => ({
  transactions: q('SELECT * FROM transactions'),
  bank_txns: q('SELECT * FROM bank_txns'),
  slots: q('SELECT * FROM plaid_slot_log'),
  accounts: q('SELECT * FROM accounts'),
  mappings: q('SELECT id, account_id, plaid_account_id FROM bank_accounts ORDER BY id'),
})

beforeEach(async () => {
  db = await createBudgetDb({ seed: false })
  queue = []
  fetched = []
  allowed = new Set([REMOVE])
  envOver = {}
  await seed()
})
afterEach(() => vi.restoreAllMocks())

describe('unlink: the good path', () => {
  it('removes the Item at Plaid (reason OTHER, the stored token), then wipes the token, turns sync off and deletes liabilities', async () => {
    queue.push(() => json({ request_id: 'r' }))
    const before = keptState()
    const res = await unlink()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(fetched).toHaveLength(1)
    expect(fetched[0]!.url).toBe(REMOVE)
    expect(fetched[0]!.body).toMatchObject({ access_token: ACCESS, reason_code: 'OTHER' })
    expect(fetched[0]!.body).not.toHaveProperty('reason_note')
    expect(item()).toMatchObject({ status: 'removed', token_ct: null, token_iv: null, key_id: null, sync_cursor: null })
    expect(q('SELECT sync FROM bank_accounts').map((r) => r.sync)).toEqual(['off', 'off'])
    expect(q('SELECT * FROM bank_liabilities')).toEqual([])
    expect(keptState()).toEqual(before)
  })

  it('keeps the transactions, the bank_txns claim, the slot log and the account mappings exactly as they were', async () => {
    queue.push(() => json({ request_id: 'r' }))
    const before = keptState()
    await unlink()
    const after = keptState()
    expect(after.transactions).toHaveLength(1)
    expect(after.bank_txns).toHaveLength(1)
    expect(after.slots).toHaveLength(1)
    expect(after).toEqual(before)
  })

  it('the slot log row is never freed: still counted, append-only triggers still in force', async () => {
    queue.push(() => json({ request_id: 'r' }))
    await unlink()
    expect(q('SELECT status, plaid_item_id FROM plaid_slot_log')).toEqual([{ status: 'done', plaid_item_id: 'item-plaid-001' }])
    expect(() => run('DELETE FROM plaid_slot_log')).toThrow(/append-only/)
  })

  it('a needs_reconnect Item (token kept) can be unlinked too', async () => {
    run(`UPDATE bank_items SET status = 'needs_reconnect' WHERE id = ?`, ITEM)
    queue.push(() => json({ request_id: 'r' }))
    expect((await unlink()).status).toBe(200)
    expect(item().status).toBe('removed')
  })

  it('logs counts and codes only', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    queue.push(() => json({ request_id: 'r' }))
    await unlink()
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toMatch(/^\{"event":"[a-z_]+"(,"[a-z_]+":\d+)*(,"code":"[a-z_]+")?\}$/)
    expect(lines.join('\n')).not.toContain(ACCESS)
    expect(lines.join('\n')).not.toContain('item-plaid-001')
  })
})

describe('unlink: Plaid answers', () => {
  it('ITEM_NOT_FOUND counts as done: the wipe still happens', async () => {
    queue.push(() => plaidError('ITEM_ERROR', 'ITEM_NOT_FOUND'))
    const res = await unlink()
    expect(res.status).toBe(200)
    expect(item()).toMatchObject({ status: 'removed', token_ct: null })
    expect(q('SELECT * FROM bank_liabilities')).toEqual([])
  })

  it('any other Plaid error answers 502 and wipes nothing: the Item can still be removed later', async () => {
    queue.push(() => plaidError('API_ERROR', 'INTERNAL_SERVER_ERROR'))
    const beforeItem = item()
    const res = await unlink()
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false, code: 'plaid_api_error' })
    expect(item()).toEqual(beforeItem)
    expect(q('SELECT sync FROM bank_accounts').map((r) => r.sync)).toEqual(['on', 'on'])
    expect(q('SELECT * FROM bank_liabilities')).toHaveLength(1)
    // and a retry works once Plaid is back
    queue.push(() => json({ request_id: 'r' }))
    expect((await unlink()).status).toBe(200)
    expect(item().status).toBe('removed')
  })
})

describe('unlink: guards', () => {
  it('another owner gets 403 not_owner and no Plaid call', async () => {
    const res = await unlink({ itemId: ITEM }, 'other@example.com')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ ok: false, code: 'not_owner' })
    expect(fetched).toEqual([])
    expect(item().status).toBe('active')
  })

  it('a bad or unknown item id: 400 bad_request, 404 item_not_found, no Plaid call', async () => {
    expect((await unlink({ itemId: 'nope' })).status).toBe(400)
    expect((await unlink({})).status).toBe(400)
    expect((await unlink({ itemId: 'i0000000000000fff' })).status).toBe(404)
    expect(fetched).toEqual([])
  })

  it('an Item already removed or revoked answers 200 with no Plaid call and no change', async () => {
    for (const status of ['removed', 'revoked']) {
      db = await createBudgetDb({ seed: false })
      await seed({ status })
      const before = item()
      const res = await unlink()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(item()).toEqual(before)
    }
    expect(fetched).toEqual([])
  })

  it('an Item from the other Plaid environment answers 409 item_not_active, no Plaid call', async () => {
    expect((await unlink(undefined, OWNER, { ...makeEnv(), PLAID_ENV: 'production' })).status).toBe(409)
    expect(fetched).toEqual([])
    expect(item().status).toBe('active')
  })

  it('missing token key answers 503 secrets_missing, no Plaid call, nothing wiped', async () => {
    const res = await unlink(undefined, OWNER, { ...makeEnv(), BANKS_TOKEN_KEY: secret('') })
    expect(res.status).toBe(503)
    expect(fetched).toEqual([])
    expect(item().status).toBe('active')
  })

  it('the stub throws on any URL other than /item/remove', async () => {
    allowed = new Set()
    queue.push(() => json({}))
    const res = await unlink()
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(fetched.map((f) => f.url)).toEqual([REMOVE])
    expect(item().status).toBe('active')
  })
})

describe('unlink and the webhook share one wipe', () => {
  it('unlink.ts imports wipeItemStatements from webhook.ts and writes no wipe SQL of its own', () => {
    const src = readFileSync(new URL('../src/unlink.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/import \{ wipeItemStatements \} from '\.\/webhook'/)
    expect(src).not.toMatch(/DELETE FROM|UPDATE bank_items|UPDATE bank_accounts/)
  })

  it('a revoke and an unlink leave the same state apart from the status word', async () => {
    const { wipeItemStatements } = await import('../src/webhook')
    queue.push(() => json({ request_id: 'r' }))
    await unlink()
    const unlinked = { item: { ...item(), status: 'x', updated_at: 'x' }, accts: q('SELECT id, sync FROM bank_accounts ORDER BY id'), liab: q('SELECT * FROM bank_liabilities') }

    db = await createBudgetDb({ seed: false })
    await seed()
    await db.d1.batch(wipeItemStatements(db.d1, ITEM, 'revoked', new Date('2026-11-27T12:00:00Z')))
    expect(item().status).toBe('revoked')
    const revoked = { item: { ...item(), status: 'x', updated_at: 'x' }, accts: q('SELECT id, sync FROM bank_accounts ORDER BY id'), liab: q('SELECT * FROM bank_liabilities') }
    expect(revoked).toEqual(unlinked)
  })
})
