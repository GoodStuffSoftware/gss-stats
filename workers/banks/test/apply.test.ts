// Sync, apply half (plan 4.4 and 4.7): decide, the D1 writes, the tick. Plaid is a stub that throws on any URL it did not
// expect; D1 is the fake over the real migrations. Every value is made up. The rule these tests guard (Mike's): a manual edit
// is never overwritten by a re-import, Plaid sync and pending-to-posted included.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBudgetDb, type FakeBudgetDb } from '../../../functions/_lib/testing/budgetDb'
import { keyFingerprint } from '../../receipts/src/tokenCrypto'
import { SQL, KEEP_RUNS, applyPlan, syncItem } from '../src/apply'
import { handleScheduled } from '../src/index'
import { createPlaidClient } from '../src/plaid'
import { openToken, sealToken, type Keys } from '../src/store'
import { plaidErrorCode } from '../src/sync'
import type { Env } from '../src/env'

const secret = (v: string) => ({ get: async () => v })
const SYNC = 'https://sandbox.plaid.com/transactions/sync'
const ITEM_GET = 'https://sandbox.plaid.com/item/get'
const NOW = new Date('2026-11-27T12:00:00Z')
const MIN = 60_000
const HOUR = 3_600_000
const ACCESS = 'access-sandbox-test-token'
const KEY = btoa('0123456789abcdef0123456789abcdef')
const KEY_OLD = btoa('fedcba9876543210fedcba9876543210')
const KEYS: Keys = { current: KEY, old: null }
const OWNER = 'owner@example.com'
const SYNC_FROM = '2026-11-10'

const ITEM = 'i00000000000000a1'
const BA_CHK = 'b00000000000000a1'
const BA_CRD = 'b00000000000000a2'
const BA_OFF = 'b00000000000000a3'
const BA_UNM = 'b00000000000000a4'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const plaidError = (code: string) => json({ error_type: 'ITEM_ERROR', error_code: code, error_message: 'text', request_id: 'r' }, 400)
const page = (o: Partial<{ added: unknown[]; modified: unknown[]; removed: unknown[]; next_cursor: string; has_more: boolean }> = {}) =>
  json({ added: [], modified: [], removed: [], next_cursor: 'cur-1', has_more: false, ...o })
/** A Plaid transaction on the checking account. Plaid sends money OUT as a positive amount. */
const ptxn = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id, account_id: 'acc-chk', amount: 12.34, iso_currency_code: 'USD', date: '2026-11-20', authorized_date: null,
  name: 'Corner Cafe', merchant_name: null, pending: false, pending_transaction_id: null, ...over,
})

let db: FakeBudgetDb
let t: Date
let queue: Array<() => Response>
let fetched: Array<{ url: string; body: Record<string, any> }>
let logs: string[]

const env = (over: Partial<Env> = {}): Env => ({
  BUDGET_DB: db.d1, PLAID_CLIENT_ID: secret('client-id-sandbox-test'), PLAID_SECRET: secret('secret-value-sandbox-test'),
  BANKS_TOKEN_KEY: secret(KEY), PLAID_ENV: 'sandbox', ...over,
})
const stubFetch = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url)
  fetched.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) })
  if (u !== SYNC) throw new Error(`unexpected fetch ${u}`)
  const next = queue.shift()
  if (!next) throw new Error('no response queued')
  return Promise.resolve(next())
}) as typeof fetch

const run = (sql: string, ...v: unknown[]) => void (db.sqlite.prepare(sql) as any).run(...v)
const q = <T = Record<string, any>>(sql: string, ...v: unknown[]) => db.all<T>(sql, ...v)
const one = <T = Record<string, any>>(sql: string, ...v: unknown[]) => db.get<T>(sql, ...v)

async function seedWorld(o: { sealKeys?: Keys; environment?: string; syncFrom?: string | null; status?: string; lastOk?: string | null } = {}): Promise<void> {
  const enc = await sealToken(ACCESS, ITEM, o.sealKeys ?? KEYS)
  run(`INSERT INTO accounts (id, label, kind) VALUES ('chk', 'Everyday Checking', 'checking'), ('crd', 'Everyday Card', 'card')`)
  run(
    `INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, status, token_ct, token_iv, key_id, sync_cursor, initial_done,
       consent_version, consented_at, last_ok_at, created_at, updated_at)
     VALUES (?, ?, ?, 'item-plaid-001', ?, ?, ?, ?, 'cur-0', 1, 1, '2026-11-01T00:00:00Z', ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    ITEM, OWNER, o.environment ?? 'sandbox', o.status ?? 'active', enc.token_ct, enc.token_iv, enc.key_id, o.lastOk ?? null,
  )
  const syncFrom = o.syncFrom === undefined ? SYNC_FROM : o.syncFrom
  const ba = (id: string, plaid: string, name: string, acct: string | null, sync: string) =>
    run(`INSERT INTO bank_accounts (id, item_id, plaid_account_id, name, type, account_id, sync, sync_from, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'depository', ?, ?, ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`, id, ITEM, plaid, name, acct, sync, sync === 'on' ? syncFrom : null)
  ba(BA_CHK, 'acc-chk', 'Everyday Checking', 'chk', 'on')
  ba(BA_CRD, 'acc-crd', 'Everyday Card', 'crd', 'on')
  ba(BA_OFF, 'acc-off', 'Old Savings', null, 'off')
  ba(BA_UNM, 'acc-unm', 'New Savings', null, 'unmapped')
}

/** One sync of the item, 20 minutes after the last (the claim window is 15). */
async function sync(res: Response | (() => Response), keys: Keys = KEYS): Promise<boolean> {
  queue.push(typeof res === 'function' ? res : () => res)
  t = new Date(t.getTime() + 20 * MIN)
  return syncItem(db.d1, env(), createPlaidClient({ env: env(), fetch: stubFetch, now: () => t }), keys, ITEM, t)
}
const lastRun = () => one('SELECT * FROM bank_sync_runs ORDER BY id DESC LIMIT 1')!
const item = () => one('SELECT * FROM bank_items WHERE id = ?', ITEM)!
const txnOf = (plaidId: string) => one<{ txn_id: string }>('SELECT txn_id FROM bank_txns WHERE plaid_txn_id = ?', plaidId)?.txn_id
const txn = (id: string) => one('SELECT * FROM transactions WHERE id = ?', id)!
const EDIT_COLS = 'category_id, category_source, kind, kind_source, included, note, updated_by'
const editState = (id: string) => one(`SELECT ${EDIT_COLS} FROM transactions WHERE id = ?`, id)!

/** A statement row (import 'imp-stmt'), as the load wrote it: 32-char id, no bank_ref, unmapped. */
function stmtRow(key: string, account: string, date: string, cents: number, desc: string, over: Record<string, unknown> = {}): string {
  const id = key.padEnd(32, '0')
  if (!one(`SELECT 1 AS x FROM imports WHERE id = 'imp-stmt'`)) {
    run(`INSERT INTO imports (id, source_label, created_at, created_by, rows_in) VALUES ('imp-stmt', 'Statements', '2026-11-05T00:00:00Z', 'seed@example.com', 1)`)
  }
  const r = { kind: 'transfer_external', kind_source: 'auto', category_source: 'none', updated_by: 'seed@example.com', ...over }
  run(
    `INSERT INTO transactions (id, account_id, import_id, posted_date, amount_cents, description, kind, kind_source, category_source, confidence,
       needs_review, updated_at, updated_by) VALUES (?, ?, 'imp-stmt', ?, ?, ?, ?, ?, ?, 60, 0, '2026-11-05T00:00:00.000Z', ?)`,
    id, account, date, cents, desc, r.kind, r.kind_source, r.category_source, r.updated_by,
  )
  return id
}

/** A person's edit of one row: category, kind, included, note, an audit row. */
function personEdit(id: string): void {
  run(`UPDATE transactions SET category_id = 'groceries', category_source = 'manual', kind = 'spend', kind_source = 'manual', included = 0,
         note = 'split with a friend', updated_by = 'kristen@example.com', updated_at = '2026-11-26T09:00:00.000Z' WHERE id = ?`, id)
  run(`INSERT INTO category_edits (txn_id, old_category_id, new_category_id, edited_at, edited_by) VALUES (?, NULL, 'groceries', '2026-11-26T09:00:00.000Z', 'kristen@example.com')`, id)
}
function receiptMatch(id: string): void {
  run(`INSERT INTO email_connections (id, owner_email, google_sub, status, token_ct, token_iv, key_id, scopes, consent_version, consented_at, created_at, updated_at)
       VALUES ('c00000000000000a1', 'mail@example.com', 'sub-1', 'active', 'QUJD', 'AAAAAAAAAAAAAAAA', 'abcdef01', 'read', 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')
       ON CONFLICT(id) DO NOTHING`)
  run(`INSERT INTO receipts (id, connection_id, gmail_msg_id, email_date, status, created_at, updated_at, updated_by)
       VALUES ('r00000000000000a1', 'c00000000000000a1', 'aabbccdd11', '2026-11-20', 'applied', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', 'x')
       ON CONFLICT(id) DO NOTHING`)
  run(`INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, txn_updated_at, created_at)
       VALUES ('r00000000000000a1', ?, 'g1', 'exact', -1234, 90, 'applied', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z')`, id)
}

beforeEach(async () => {
  db = await createBudgetDb({ seed: false })
  t = new Date(NOW)
  queue = []
  fetched = []
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')))
})
afterEach(() => vi.restoreAllMocks())

describe('inserts', () => {
  beforeEach(() => seedWorld())

  it('inserts posted and pending rows, maps them, counts the run and records the import', async () => {
    expect(await sync(page({ added: [ptxn('plaid-a'), ptxn('plaid-b', { amount: 5, pending: true, name: 'Hardware Store' }), ptxn('plaid-c', { account_id: 'acc-crd', amount: 40, date: '2026-11-22' })] }))).toBe(true)
    const a = txn(txnOf('plaid-a')!)
    expect(a).toMatchObject({ account_id: 'chk', posted_date: '2026-11-20', amount_cents: -1234, description: 'Corner Cafe', bank_ref: 'plaid:plaid-a', pending: 0, included: 1, updated_by: 'sync:plaid', pair_id: null })
    expect(a.id).toHaveLength(32)
    expect(txn(txnOf('plaid-b')!)).toMatchObject({ pending: 1, amount_cents: -500 })
    expect(txn(txnOf('plaid-c')!)).toMatchObject({ account_id: 'crd', amount_cents: -4000 })
    expect(q('SELECT role, state FROM bank_txns')).toEqual([{ role: 'inserted', state: 'live' }, { role: 'inserted', state: 'live' }, { role: 'inserted', state: 'live' }])

    const r = lastRun()
    expect(r).toMatchObject({ item_id: ITEM, finished_at: t.toISOString(), pages: 1, added: 3, modified: 0, removed: 0, inserted: 3, matched: 0, flagged: 0, posted: 0, dropped: 0, skipped: 0, error_code: null })
    expect(q('SELECT id, source_label, created_by, rows_in FROM imports')).toEqual([{ id: `bank-${ITEM}-${r.id}`, source_label: 'Bank sync', created_by: 'sync:plaid', rows_in: 3 }])
    expect(one('SELECT import_id FROM transactions WHERE id = ?', txnOf('plaid-a'))!.import_id).toBe(`bank-${ITEM}-${r.id}`)
    expect(item()).toMatchObject({ sync_cursor: 'cur-1', last_ok_at: t.toISOString(), last_error: null })
    expect(fetched).toHaveLength(1)
    expect(fetched[0].body.access_token).toBe(ACCESS)
  })

  it('rows before sync_from, on a sync-off or unmapped account, an unknown account, or not USD never arrive', async () => {
    await sync(page({
      added: [
        ptxn('plaid-old', { date: '2026-11-09' }),
        ptxn('plaid-off', { account_id: 'acc-off' }),
        ptxn('plaid-unm', { account_id: 'acc-unm' }),
        ptxn('plaid-zzz', { account_id: 'acc-zzz' }),
        ptxn('plaid-eur', { iso_currency_code: 'EUR' }),
        ptxn('plaid-ok'),
      ],
    }))
    expect(q('SELECT plaid_txn_id FROM bank_txns')).toEqual([{ plaid_txn_id: 'plaid-ok' }])
    expect(one('SELECT count(*) AS n FROM transactions')!.n).toBe(1)
    expect(lastRun()).toMatchObject({ added: 5, inserted: 1, skipped: 5 })
  })

  it('a modified id we have never seen is handled as added', async () => {
    await sync(page({ modified: [ptxn('plaid-new')] }))
    expect(txnOf('plaid-new')).toBeTruthy()
    expect(lastRun()).toMatchObject({ added: 0, modified: 1, inserted: 1 })
  })

  it('the same id twice in one update inserts one row with the last fields', async () => {
    await sync(page({ added: [ptxn('plaid-a'), ptxn('plaid-a', { amount: 20 })] }))
    expect(one('SELECT count(*) AS n FROM transactions')!.n).toBe(1)
    expect(txn(txnOf('plaid-a')!).amount_cents).toBe(-2000)
  })

  it('added and removed in the same update leaves nothing', async () => {
    await sync(page({ added: [ptxn('plaid-a')], removed: [{ transaction_id: 'plaid-a' }] }))
    expect(one('SELECT count(*) AS n FROM transactions')!.n).toBe(0)
    expect(lastRun()).toMatchObject({ inserted: 0 })
    expect(q('SELECT count(*) AS n FROM imports')[0].n).toBe(0)
  })

  it('a noop update closes the run and writes nothing', async () => {
    await sync(page({ next_cursor: '' }))
    expect(lastRun()).toMatchObject({ pages: 1, added: 0, error_code: null })
    expect(lastRun().finished_at).toBe(t.toISOString())
    expect(item().sync_cursor).toBe('cur-0')
  })
})

describe('apply twice is apply once', () => {
  beforeEach(() => seedWorld())
  const snapshot = () => ({
    txns: q('SELECT * FROM transactions ORDER BY id'),
    map: q('SELECT plaid_txn_id, bank_account_id, txn_id, role, state, dup_of FROM bank_txns ORDER BY plaid_txn_id'),
    imports: q('SELECT id, rows_in FROM imports ORDER BY id'),
  })

  it('a first update repeated from the old cursor ends in the same state', async () => {
    const first = () => page({ added: [ptxn('plaid-a'), ptxn('plaid-b', { pending: true, amount: 8 }), ptxn('plaid-c', { name: 'Online Transfer To Card', amount: 50, date: '2026-11-21' }),
      ptxn('plaid-d', { account_id: 'acc-crd', name: 'Payment Thank You', amount: -50, date: '2026-11-21' })] })
    await sync(first())
    const once = snapshot()
    expect(once.txns).toHaveLength(4)
    run(`UPDATE bank_items SET sync_cursor = 'cur-0' WHERE id = ?`, ITEM)
    await sync(first())
    expect(snapshot()).toEqual(once)
    expect(one('SELECT count(*) AS n FROM bank_sync_runs')!.n).toBe(2)
  })

  it('an update with a modify, a pending-to-posted and a remove repeated ends in the same state', async () => {
    await sync(page({ added: [ptxn('plaid-a'), ptxn('plaid-p', { pending: true, amount: 20 }), ptxn('plaid-gone'), ptxn('plaid-kept', { amount: 3 })] }))
    personEdit(txnOf('plaid-kept')!)
    const u2 = () => page({
      added: [ptxn('plaid-p2', { pending_transaction_id: 'plaid-p', amount: 20.5, date: '2026-11-21' })],
      modified: [ptxn('plaid-a', { amount: 13 })],
      removed: [{ transaction_id: 'plaid-gone' }, { transaction_id: 'plaid-kept' }],
      next_cursor: 'cur-2',
    })
    await sync(u2())
    const once = snapshot()
    run(`UPDATE bank_items SET sync_cursor = 'cur-1' WHERE id = ?`, ITEM)
    await sync(u2())
    expect(snapshot()).toEqual(once)
    expect(item().sync_cursor).toBe('cur-2')
    expect(txnOf('plaid-gone')).toBeUndefined()
    expect(q('SELECT state FROM bank_txns WHERE plaid_txn_id = ?', 'plaid-kept')).toEqual([{ state: 'dropped' }])
  })
})

describe('a manual edit is never overwritten', () => {
  beforeEach(() => seedWorld())
  const edited = async (plaidId = 'plaid-a', over: Record<string, unknown> = {}) => {
    await sync(page({ added: [ptxn(plaidId, over)] }))
    const id = txnOf(plaidId)!
    personEdit(id)
    return id
  }

  it('survives a modify that changes the bank fields', async () => {
    const id = await edited()
    const before = editState(id)
    expect(before).toMatchObject({ category_id: 'groceries', category_source: 'manual', kind: 'spend', kind_source: 'manual', included: 0, note: 'split with a friend', updated_by: 'kristen@example.com' })
    await sync(page({ modified: [ptxn('plaid-a', { amount: 15, date: '2026-11-21', name: 'Corner Cafe Downtown' })] }))
    expect(editState(id)).toEqual(before)
    expect(txn(id)).toMatchObject({ amount_cents: -1500, posted_date: '2026-11-21', description: 'Corner Cafe Downtown' })
    expect(txn(id).updated_at > '2026-11-26T09:00:00.000Z').toBe(true)
    expect(one('SELECT count(*) AS n FROM category_edits')!.n).toBe(1)
  })

  it('survives a pending-to-posted in place, and keeps the id, audit rows and receipt match', async () => {
    const id = await edited('plaid-p', { pending: true, amount: 20 })
    receiptMatch(id)
    const before = editState(id)
    await sync(page({ added: [ptxn('plaid-p2', { pending_transaction_id: 'plaid-p', amount: 20.5, date: '2026-11-21' })] }))
    expect(txnOf('plaid-p2')).toBe(id)
    expect(txnOf('plaid-p')).toBeUndefined()
    expect(editState(id)).toEqual(before)
    expect(txn(id)).toMatchObject({ pending: 0, amount_cents: -2050, posted_date: '2026-11-21', bank_ref: 'plaid:plaid-p2' })
    expect(one('SELECT count(*) AS n FROM transactions')!.n).toBe(1)
    expect(one('SELECT count(*) AS n FROM category_edits WHERE txn_id = ?', id)!.n).toBe(1)
    expect(one('SELECT count(*) AS n FROM receipt_matches WHERE txn_id = ?', id)!.n).toBe(1)
    expect(lastRun()).toMatchObject({ posted: 1, inserted: 0 })
  })

  it('survives a resync (cursor NULL, the same added again)', async () => {
    const id = await edited()
    const before = editState(id)
    const upd = txn(id).updated_at
    run(`UPDATE bank_items SET sync_cursor = NULL WHERE id = ?`, ITEM)
    await sync(page({ added: [ptxn('plaid-a')] }))
    expect(lastRun().run_trigger).toBe('resync')
    expect(editState(id)).toEqual(before)
    expect(txn(id).updated_at).toBe(upd)
    expect(one('SELECT count(*) AS n FROM transactions')!.n).toBe(1)
  })

  it('a posted row pending-to-posted that was dropped (removed while edited) posts in place too', async () => {
    const id = await edited('plaid-p', { pending: true })
    await sync(page({ removed: [{ transaction_id: 'plaid-p' }] }))
    expect(q('SELECT state FROM bank_txns WHERE plaid_txn_id = ?', 'plaid-p')).toEqual([{ state: 'dropped' }])
    const before = editState(id)
    await sync(page({ added: [ptxn('plaid-p2', { pending_transaction_id: 'plaid-p', date: '2026-11-21' })] }))
    expect(txnOf('plaid-p2')).toBe(id)
    expect(editState(id)).toEqual(before)
    expect(one('SELECT count(*) AS n FROM transactions')!.n).toBe(1)
  })

  const touches: Array<[string, (id: string) => void]> = [
    ['a manual category', (id) => run(`UPDATE transactions SET category_id = 'groceries', category_source = 'manual' WHERE id = ?`, id)],
    ['a manual kind', (id) => run(`UPDATE transactions SET kind = 'fee', kind_source = 'manual' WHERE id = ?`, id)],
    ['a note', (id) => run(`UPDATE transactions SET note = 'keep me' WHERE id = ?`, id)],
    ['excluded from spending', (id) => run(`UPDATE transactions SET included = 0 WHERE id = ?`, id)],
    ['a person as updated_by', (id) => run(`UPDATE transactions SET updated_by = 'kristen@example.com' WHERE id = ?`, id)],
    ['a receipt match', (id) => receiptMatch(id)],
  ]
  it.each(touches)('removed by Plaid with %s: the row stays and the map is dropped', async (_n, touch) => {
    await sync(page({ added: [ptxn('plaid-a')] }))
    const id = txnOf('plaid-a')!
    touch(id)
    const before = editState(id)
    await sync(page({ removed: [{ transaction_id: 'plaid-a' }] }))
    expect(txn(id)).toBeTruthy()
    expect(editState(id)).toEqual(before)
    expect(q('SELECT state, role FROM bank_txns WHERE plaid_txn_id = ?', 'plaid-a')).toEqual([{ state: 'dropped', role: 'inserted' }])
    expect(lastRun()).toMatchObject({ removed: 1, dropped: 1 })
  })

  it('removed by Plaid and untouched: the row and the map are gone, and the partner pair is cleared', async () => {
    await sync(page({ added: [ptxn('plaid-a'),
      ptxn('plaid-c', { name: 'Online Transfer To Card', amount: 50, date: '2026-11-21' }),
      ptxn('plaid-d', { account_id: 'acc-crd', name: 'Payment Thank You', amount: -50, date: '2026-11-21' })] }))
    const c = txnOf('plaid-c')!, d = txnOf('plaid-d')!
    expect(txn(c).pair_id).toBe(d)
    expect(txn(d).pair_id).toBe(c)
    await sync(page({ removed: [{ transaction_id: 'plaid-a' }, { transaction_id: 'plaid-c' }, { transaction_id: 'plaid-nobody' }] }))
    expect(one('SELECT 1 AS x FROM transactions WHERE id = ?', c)).toBeUndefined()
    expect(txnOf('plaid-c')).toBeUndefined()
    expect(txnOf('plaid-a')).toBeUndefined()
    expect(txn(d).pair_id).toBeNull()
    expect(lastRun()).toMatchObject({ removed: 3, dropped: 0 })
  })

  it('the delete is guarded again at write time: an edit made after the read still keeps the row', async () => {
    await sync(page({ added: [ptxn('plaid-a')] }))
    const id = txnOf('plaid-a')!
    personEdit(id) // lands after the plan was read as "untouched"
    const zero = { added: 0, modified: 0, removed: 1, inserted: 0, matched: 0, flagged: 0, posted: 0, dropped: 0, skipped: 0 }
    const plan = { inserts: [], matches: [], inPlace: [], updates: [], unmap: [], dropped: [], deletes: [{ txnId: id, pairId: null }], pairs: [], counts: zero }
    const runId = one<{ id: number }>('SELECT id FROM bank_sync_runs ORDER BY id DESC LIMIT 1')!.id
    await applyPlan(db.d1, plan, { itemId: ITEM, runId, now: t, runStart: t.toISOString(), pages: 1, nextCursor: 'cur-9' })
    expect(txn(id)).toBeTruthy()
    expect(item().sync_cursor).toBe('cur-9')
  })

  it('a removed matched row only loses its map; the statement row is untouched', async () => {
    const stmt = stmtRow('stmt1', 'chk', '2026-11-09', -1234, 'Corner Cafe', { kind: 'spend' })
    await sync(page({ added: [ptxn('plaid-a', { date: '2026-11-10' })] }))
    expect(q('SELECT role FROM bank_txns')).toEqual([{ role: 'matched' }])
    const before = txn(stmt)
    await sync(page({ removed: [{ transaction_id: 'plaid-a' }] }))
    expect(q('SELECT * FROM bank_txns')).toEqual([])
    expect(txn(stmt)).toEqual(before)
  })
})

describe('the sync_from boundary', () => {
  beforeEach(() => seedWorld())

  it('one candidate: matched, no transaction written', async () => {
    const stmt = stmtRow('stmt1', 'chk', '2026-11-08', -1234, 'Corner Cafe', { kind: 'spend' })
    const before = txn(stmt)
    await sync(page({ added: [ptxn('plaid-a', { date: '2026-11-10' })] }))
    expect(one('SELECT count(*) AS n FROM transactions')!.n).toBe(1)
    expect(q('SELECT txn_id, role, state, dup_of FROM bank_txns')).toEqual([{ txn_id: stmt, role: 'matched', state: 'live', dup_of: null }])
    expect(txn(stmt)).toEqual(before)
    expect(lastRun()).toMatchObject({ matched: 1, inserted: 0, flagged: 0 })
    // a later modify of a matched row changes nothing
    await sync(page({ modified: [ptxn('plaid-a', { date: '2026-11-10', amount: 99 })] }))
    expect(txn(stmt)).toEqual(before)
  })

  it('two candidates: inserted, flagged possible_duplicate, dup_of the nearest', async () => {
    const far = stmtRow('stmt1', 'chk', '2026-11-08', -1234, 'Corner Cafe', { kind: 'spend' })
    const near = stmtRow('stmt2', 'chk', '2026-11-11', -1234, 'Corner Cafe', { kind: 'spend' })
    await sync(page({ added: [ptxn('plaid-a', { date: '2026-11-10' })] }))
    const id = txnOf('plaid-a')!
    expect(id).not.toBe(far)
    expect(txn(id)).toMatchObject({ needs_review: 1, review_reason: 'possible_duplicate' })
    expect(one('SELECT dup_of, role FROM bank_txns WHERE plaid_txn_id = ?', 'plaid-a')).toEqual({ dup_of: near, role: 'inserted' })
    expect(lastRun()).toMatchObject({ inserted: 1, flagged: 1, matched: 0 })
  })

  it('no candidate (other amount, far date, other account, or already mapped): inserted', async () => {
    stmtRow('stmt1', 'chk', '2026-11-08', -999, 'Corner Cafe', { kind: 'spend' }) // other amount
    stmtRow('stmt2', 'chk', '2026-11-06', -1234, 'Corner Cafe', { kind: 'spend' }) // outside the 3-day window of the row
    stmtRow('stmt3', 'crd', '2026-11-09', -1234, 'Corner Cafe', { kind: 'spend' }) // other account
    await sync(page({ added: [ptxn('plaid-a', { date: '2026-11-10' })] }))
    expect(q('SELECT role FROM bank_txns')).toEqual([{ role: 'inserted' }])
    expect(txn(txnOf('plaid-a')!).review_reason).not.toBe('possible_duplicate')
    expect(lastRun()).toMatchObject({ inserted: 1, matched: 0, flagged: 0 })
  })

  it('one candidate serves one Plaid row; the second equal row is inserted', async () => {
    const stmt = stmtRow('stmt1', 'chk', '2026-11-09', -1234, 'Corner Cafe', { kind: 'spend' })
    await sync(page({ added: [ptxn('plaid-a', { date: '2026-11-10' }), ptxn('plaid-b', { date: '2026-11-10' })] }))
    expect(q('SELECT plaid_txn_id, role, txn_id FROM bank_txns ORDER BY plaid_txn_id')).toEqual([
      { plaid_txn_id: 'plaid-a', role: 'matched', txn_id: stmt },
      { plaid_txn_id: 'plaid-b', role: 'inserted', txn_id: txnOf('plaid-b') },
    ])
    expect(lastRun()).toMatchObject({ matched: 1, inserted: 1 })
  })

  it('a pending row at the boundary is not matched', async () => {
    stmtRow('stmt1', 'chk', '2026-11-09', -1234, 'Corner Cafe', { kind: 'spend' })
    await sync(page({ added: [ptxn('plaid-a', { date: '2026-11-10', pending: true })] }))
    expect(q('SELECT role FROM bank_txns')).toEqual([{ role: 'inserted' }])
  })
})

describe('pairing', () => {
  beforeEach(() => seedWorld())

  it('pairs a new checking transfer out with a new card payment in, both sides, written by the sync', async () => {
    await sync(page({ added: [
      ptxn('plaid-c', { name: 'Online Transfer To Card', amount: 50, date: '2026-11-21' }),
      ptxn('plaid-d', { account_id: 'acc-crd', name: 'Payment Thank You', amount: -50, date: '2026-11-22' }),
      ptxn('plaid-e'),
    ] }))
    const c = txn(txnOf('plaid-c')!), d = txn(txnOf('plaid-d')!)
    expect(c.pair_id).toBe(d.id)
    expect(d.pair_id).toBe(c.id)
    expect(c).toMatchObject({ kind: 'transfer', updated_by: 'sync:plaid' })
    expect(txn(txnOf('plaid-e')!).pair_id).toBeNull()
  })

  // What the production statement load writes to updated_by: scripts/budget/build-load-sql.ts passes who = 'tool:build-load-sql'
  // to planImportDetailed (no '@'; planImport has no other caller), so loaded rows are not "person edits" and can pair.
  it('pairs a new row with an existing unpaired statement row, stamped the way the production load stamps it', async () => {
    const stmt = stmtRow('stmt1', 'crd', '2026-11-19', 5000, 'Payment Thank You', { kind: 'card_payment', updated_by: 'tool:build-load-sql' })
    await sync(page({ added: [ptxn('plaid-c', { name: 'Online Transfer To Card', amount: 50, date: '2026-11-21' })] }))
    expect(txn(txnOf('plaid-c')!).pair_id).toBe(stmt)
    expect(txn(stmt).pair_id).toBe(txnOf('plaid-c'))
  })

  it('an existing row whose updated_by holds an address (a person touched it, even only a note) is not paired or rewritten', async () => {
    const stmt = stmtRow('stmt1', 'crd', '2026-11-19', 5000, 'Payment Thank You', { kind: 'card_payment', updated_by: 'kristen@example.com' })
    const before = txn(stmt)
    await sync(page({ added: [ptxn('plaid-c', { name: 'Online Transfer To Card', amount: 50, date: '2026-11-21' })] }))
    expect(txn(stmt)).toEqual(before)
    expect(txn(txnOf('plaid-c')!).pair_id).toBeNull()
  })

  it('never pairs a pending row, and never touches an existing row a person edited', async () => {
    const mine = stmtRow('stmt1', 'crd', '2026-11-19', 5000, 'Payment Thank You', { kind: 'card_payment', category_source: 'manual', updated_by: 'kristen@example.com' })
    const before = txn(mine)
    await sync(page({ added: [
      ptxn('plaid-c', { name: 'Online Transfer To Card', amount: 50, date: '2026-11-21' }),
      ptxn('plaid-p', { name: 'Online Transfer To Card', amount: 70, date: '2026-11-21', pending: true }),
      ptxn('plaid-q', { account_id: 'acc-crd', name: 'Payment Thank You', amount: -70, date: '2026-11-21', pending: true }),
    ] }))
    expect(txn(mine)).toEqual(before)
    expect(txn(txnOf('plaid-c')!).pair_id).toBeNull()
    expect(txn(txnOf('plaid-p')!).pair_id).toBeNull()
    expect(txn(txnOf('plaid-q')!).pair_id).toBeNull()
  })
})

describe('the run row, the cursor flag, trigger and token', () => {
  beforeEach(() => seedWorld())

  it('keeps the newest 200 runs of the item', async () => {
    for (let i = 0; i < 205; i++) run(`INSERT INTO bank_sync_runs (item_id, run_trigger, started_at, finished_at) VALUES (?, 'cron', '2026-11-01T00:00:00Z', '2026-11-01T00:00:01Z')`, ITEM)
    await sync(page({ added: [ptxn('plaid-a')] }))
    expect(KEEP_RUNS).toBe(200)
    const ids = q<{ id: number }>('SELECT id FROM bank_sync_runs WHERE item_id = ? ORDER BY id', ITEM).map((r) => r.id)
    expect(ids).toHaveLength(200)
    expect(ids[ids.length - 1]).toBe(206)
    expect(ids[0]).toBe(7)
  })

  it('a sync flag set before the run is cleared; one set after run_start survives', async () => {
    run(`UPDATE bank_items SET sync_requested_at = ? WHERE id = ?`, new Date(t.getTime() + 10 * MIN).toISOString(), ITEM) // before the next run_start (t + 20 min)
    await sync(page({ added: [ptxn('plaid-a')] }))
    expect(item().sync_requested_at).toBeNull()
    const late = new Date(t.getTime() + 20 * MIN + 5_000).toISOString() // 5 s after run_start
    await sync(() => { run(`UPDATE bank_items SET sync_requested_at = ? WHERE id = ?`, late, ITEM); return page({ added: [ptxn('plaid-b')], next_cursor: 'cur-2' }) })
    expect(item().sync_requested_at).toBe(late)
    expect(item().sync_cursor).toBe('cur-2')
  })

  it('names the trigger: webhook when the webhook came with the flag, manual when not, cron otherwise', async () => {
    run(`UPDATE bank_items SET sync_requested_at = ?, last_webhook_at = ? WHERE id = ?`, new Date(t.getTime() + 5 * MIN).toISOString(), new Date(t.getTime() + 6 * MIN).toISOString(), ITEM)
    await sync(page({ added: [ptxn('plaid-a')] }))
    expect(lastRun().run_trigger).toBe('webhook')
    run(`UPDATE bank_items SET sync_requested_at = ?, last_webhook_at = NULL WHERE id = ?`, new Date(t.getTime() + 5 * MIN).toISOString(), ITEM)
    await sync(page({ next_cursor: 'cur-2', added: [ptxn('plaid-b')] }))
    expect(lastRun().run_trigger).toBe('manual')
    await sync(page({ next_cursor: 'cur-3', added: [ptxn('plaid-c')] }))
    expect(lastRun().run_trigger).toBe('cron')
  })

  it('an Item in another Plaid environment than the Worker is skipped: no run, no call', async () => {
    run(`UPDATE bank_items SET environment = 'production' WHERE id = ?`, ITEM)
    expect(await sync(page())).toBe(false)
    expect(fetched).toHaveLength(0)
    expect(one('SELECT count(*) AS n FROM bank_sync_runs')!.n).toBe(0)
    expect(logs.join('\n')).toContain('environment_mismatch')
  })

  it('a second tick inside the claim window skips', async () => {
    await sync(page({ added: [ptxn('plaid-a')] }))
    queue.push(() => page())
    expect(await syncItem(db.d1, env(), createPlaidClient({ env: env(), fetch: stubFetch, now: () => t }), KEYS, ITEM, new Date(t.getTime() + 5 * MIN))).toBe(false)
    expect(fetched).toHaveLength(1)
  })
})

describe('token rotation', () => {
  it('a token sealed with the old key is read, used, and sealed again with the current key', async () => {
    await seedWorld({ sealKeys: { current: KEY_OLD, old: null } })
    const rotated: Keys = { current: KEY, old: KEY_OLD }
    expect(item().key_id).toBe(await keyFingerprint(KEY_OLD))
    await sync(page({ added: [ptxn('plaid-a')] }), rotated)
    expect(fetched[0].body.access_token).toBe(ACCESS)
    expect(item().key_id).toBe(await keyFingerprint(KEY))
    const row = one<any>('SELECT id, token_ct, token_iv, key_id FROM bank_items WHERE id = ?', ITEM)!
    expect(await openToken(row, { current: KEY, old: null })).toBe(ACCESS)
    expect(logs.join('\n')).toContain('token_resealed')
  })
})

describe('errors', () => {
  beforeEach(() => seedWorld())

  it('ITEM_LOGIN_REQUIRED: needs_reconnect, the code on the item and the run, the flag and cursor kept', async () => {
    const flag = new Date(t.getTime() + 10 * MIN).toISOString()
    run(`UPDATE bank_items SET sync_requested_at = ? WHERE id = ?`, flag, ITEM)
    await sync(plaidError('ITEM_LOGIN_REQUIRED'))
    expect(item()).toMatchObject({ status: 'needs_reconnect', last_error: 'plaid_item_login_required', sync_cursor: 'cur-0', sync_requested_at: flag })
    expect(lastRun()).toMatchObject({ error_code: 'plaid_item_login_required', finished_at: t.toISOString() })
    expect(one('SELECT count(*) AS n FROM transactions')!.n).toBe(0)
  })

  it('another Plaid error: last_error is its code, status stays, the flag is kept', async () => {
    const flag = new Date(t.getTime() + 10 * MIN).toISOString()
    run(`UPDATE bank_items SET sync_requested_at = ? WHERE id = ?`, flag, ITEM)
    await sync(plaidError('INSTITUTION_DOWN'))
    expect(item()).toMatchObject({ status: 'active', last_error: plaidErrorCode('INSTITUTION_DOWN'), sync_requested_at: flag, sync_cursor: 'cur-0' })
    expect(lastRun().error_code).toBe(plaidErrorCode('INSTITUTION_DOWN'))
  })

  it('a token that cannot be opened ends the run with token_unreadable and calls nothing', async () => {
    expect(await sync(page(), { current: KEY_OLD, old: null })).toBe(true)
    expect(fetched).toHaveLength(0)
    expect(lastRun().error_code).toBe('token_unreadable')
  })

  it('a batch that fails leaves the cursor where it was (no partial move)', async () => {
    db.failNextBatch()
    await sync(page({ added: [ptxn('plaid-a')] }))
    expect(item().sync_cursor).toBe('cur-0')
    expect(lastRun().error_code).toBe('internal_error')
  })
})

describe('the cron entry', () => {
  it('syncs a due Item through the scheduled handler', async () => {
    await seedWorld()
    queue.push(() => page({ added: [ptxn('plaid-a')] }))
    await handleScheduled(env(), { fetch: stubFetch, now: () => t })
    expect(txnOf('plaid-a')).toBeTruthy()
    expect(fetched.map((f) => f.url)).toEqual([SYNC])
  })

  it('does nothing and calls nothing when the token key is missing', async () => {
    await seedWorld()
    await handleScheduled(env({ BANKS_TOKEN_KEY: undefined }), { fetch: stubFetch, now: () => t })
    expect(fetched).toHaveLength(0)
    expect(logs.join('\n')).toContain('keys_missing')
  })

  it('an Item in needs_reconnect is not synced here', async () => {
    await seedWorld({ status: 'needs_reconnect' })
    await handleScheduled(env(), { fetch: stubFetch, now: () => t })
    expect(fetched.filter((f) => f.url === SYNC)).toHaveLength(0)
  })

  it('the daily check runs after the sync in the same tick', async () => {
    await seedWorld({ status: 'needs_reconnect' })
    const f = ((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      fetched.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) })
      if (u !== ITEM_GET) throw new Error(`unexpected fetch ${u}`)
      return Promise.resolve(json({ item: { error: null }, request_id: 'r' }))
    }) as typeof fetch
    await handleScheduled(env(), { fetch: f, now: () => t })
    expect(item()).toMatchObject({ status: 'active', last_error: null, sync_requested_at: t.toISOString() })
  })
})

describe('reads and writes are keyed', () => {
  beforeEach(() => seedWorld())
  const plan = (sql: string, ...values: unknown[]) => db.explain(sql, values).join('\n')

  it('every read uses an index or a primary key (accounts and rules are whole small config tables, read whole)', () => {
    expect(plan(SQL.bankAccounts, ITEM)).toMatch(/idx_bank_acct_item/)
    const mapped = plan(SQL.mapped(2), 'plaid-a', 'plaid-b')
    expect(mapped).toMatch(/SEARCH b USING .*(PRIMARY KEY|autoindex)/)
    expect(mapped).toMatch(/SEARCH t USING (INTEGER )?PRIMARY KEY|SEARCH t USING .*autoindex/)
    expect(mapped).not.toMatch(/SCAN/)
    const cand = plan(SQL.candidates, 'chk', SYNC_FROM)
    expect(cand).toMatch(/idx_txn_account/)
    expect(cand).toMatch(/idx_bank_txn_txn/)
    const touched = plan(SQL.touched(2), 'x', 'y')
    expect(touched).toMatch(/SEARCH t USING .*(PRIMARY KEY|autoindex)/)
    expect(touched).toMatch(/idx_match_txn/)
    expect(plan(SQL.pairCandidates, '2026-11-01', '2026-11-30')).toMatch(/idx_txn_date/)
    expect(plan(SQL.pairCandidates, '2026-11-01', '2026-11-30')).not.toMatch(/SCAN transactions(?! USING)/)
  })

  it('the item, run and bank_txns writes are keyed by primary key or index', () => {
    for (const [sql, ...vals] of [
      [`UPDATE bank_txns SET state = 'dropped', updated_at = ?2 WHERE plaid_txn_id = ?1 AND role = 'inserted'`, 'x', 'y'],
      ['DELETE FROM bank_txns WHERE plaid_txn_id = ?1', 'x'],
      ['DELETE FROM bank_sync_runs WHERE item_id = ?1 AND id NOT IN (SELECT id FROM bank_sync_runs WHERE item_id = ?1 ORDER BY id DESC LIMIT 200)', ITEM],
    ] as Array<[string, ...string[]]>) expect(plan(sql, ...vals)).not.toMatch(/SCAN (bank_txns|bank_sync_runs)(?! USING)/)
  })
})

describe('the transaction updates carry no person-owned column', () => {
  const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'src')
  const OWNED = /\b(category_id|category_source|kind|kind_source|included|note|updated_by)\s*=/

  it('every UPDATE transactions SET in the Worker (before its WHERE) sets none of them', () => {
    let seen = 0
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8')
      for (const m of src.matchAll(/UPDATE transactions SET([\s\S]*?)WHERE/g)) {
        seen++
        expect(m[1], `${f}: ${m[0].slice(0, 60)}`).not.toMatch(OWNED)
      }
    }
    expect(seen).toBeGreaterThanOrEqual(3)
  })

  it('the statements the sync actually ran against transactions are only the known ones', async () => {
    await seedWorld()
    await sync(page({ added: [ptxn('plaid-p', { pending: true }), ptxn('plaid-a')] }))
    await sync(page({ added: [ptxn('plaid-p2', { pending_transaction_id: 'plaid-p', date: '2026-11-21' })], modified: [ptxn('plaid-a', { amount: 13 })], next_cursor: 'cur-2' }))
    const updates = db.statements.filter((s) => /^\s*UPDATE transactions SET/i.test(s))
    expect(updates.length).toBeGreaterThan(0)
    for (const s of updates) expect(s.split(/WHERE/)[0]).not.toMatch(OWNED)
  })
})

describe('logs carry counts and codes only', () => {
  it('no description, id, token, cursor or amount reaches a log line', async () => {
    await seedWorld()
    await sync(page({ added: [ptxn('plaid-secret-id', { name: 'Corner Cafe Private Name' })] }))
    await sync(plaidError('ITEM_LOGIN_REQUIRED'))
    expect(logs.length).toBeGreaterThan(0)
    for (const line of logs) {
      const o = JSON.parse(line) as Record<string, unknown>
      for (const [k, v] of Object.entries(o)) {
        expect(k).toMatch(/^[a-z0-9_]{1,40}$/)
        if (typeof v === 'string') expect(v).toMatch(/^[a-z0-9_]{1,40}$/)
        else expect(typeof v).toBe('number')
      }
    }
    const all = logs.join('\n')
    for (const bad of ['Corner', 'plaid-secret-id', ACCESS, 'cur-', 'acc-chk', 'item-plaid-001', OWNER, '12.34', '1234']) expect(all).not.toContain(bad)
    expect(all).toContain('sync_ok')
    expect(all).toContain('plaid_item_login_required')
  })
})
