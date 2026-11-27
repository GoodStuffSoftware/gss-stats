// Sync fetch half: pick, claim, run row, fetchUpdate and normalize (plan 4.1 to 4.3). Plaid is a stub that throws on any
// URL it did not expect. Every value is made up.
import { beforeEach, describe, expect, it } from 'vitest'
import { createBudgetDb, type FakeBudgetDb } from '../../../functions/_lib/testing/budgetDb'
import { createPlaidClient } from '../src/plaid'
import type { Env } from '../src/env'
import {
  CLAIM_SQL, DUE_SQL, MAPPED_SQL, RECONNECT_SQL, RECONNECT_WINDOW_MS, chooseTrigger, claim, fetchUpdate, finishRun, normalize,
  pickDue, pickReconnect, plaidErrorCode, release, startRun, toCents,
} from '../src/sync'

const secret = (v: string) => ({ get: async () => v })
const SYNC = 'https://sandbox.plaid.com/transactions/sync'
const NOW = new Date('2026-11-27T12:00:00Z')
const HOUR = 3_600_000
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const plaidError = (code: string, type = 'ITEM_ERROR') => json({ error_type: type, error_code: code, error_message: 'text', request_id: 'r' }, 400)

let db: FakeBudgetDb
let calls: Array<Record<string, any>>
let responder: (call: Record<string, any>, n: number) => Response

const env: Env = { BUDGET_DB: {} as D1Database, PLAID_CLIENT_ID: secret('client-id-sandbox-test'), PLAID_SECRET: secret('secret-value-sandbox-test'), PLAID_ENV: 'sandbox' }
const stubFetch = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url)
  if (u !== SYNC) throw new Error(`unexpected fetch ${u}`)
  const body = JSON.parse(String(init?.body ?? '{}'))
  calls.push(body)
  return Promise.resolve(responder(body, calls.length))
}) as typeof fetch
const client = () => createPlaidClient({ env, fetch: stubFetch, now: () => NOW })

const page = (o: Partial<{ added: any[]; modified: any[]; removed: any[]; next_cursor: string; has_more: boolean }> = {}) =>
  json({ added: [], modified: [], removed: [], next_cursor: 'cur-1', has_more: false, ...o })
const txn = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id, account_id: 'acc-sandbox-001', amount: 12.34, iso_currency_code: 'USD', date: '2026-11-20', authorized_date: null,
  name: 'Corner Cafe', merchant_name: null, pending: false, pending_transaction_id: null, ...over,
})

const run = (sql: string, ...v: unknown[]) => void (db.sqlite.prepare(sql) as any).run(...v)
function seedItem(id: string, over: Partial<{ status: string; last_ok_at: string | null; last_sync_at: string | null; sync_requested_at: string | null; initial_done: number; sync_cursor: string | null }> = {}): void {
  const o = { status: 'active', last_ok_at: ago(HOUR), last_sync_at: null, sync_requested_at: null, initial_done: 1, sync_cursor: 'cur-0', ...over }
  const live = o.status === 'active' || o.status === 'needs_reconnect' || o.status === 'pending_disconnect'
  run(
    `INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, status, token_ct, token_iv, key_id, sync_cursor, initial_done,
       sync_requested_at, consent_version, consented_at, last_sync_at, last_ok_at, created_at, updated_at)
     VALUES (?, 'owner@example.com', 'sandbox', ?, ?, ?, ?, ?, ?, ?, ?, 1, '2026-11-01T00:00:00Z', ?, ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    id, `item-${id}`, o.status, live ? 'QUJD' : null, live ? 'AAAAAAAAAAAAAAAA' : null, live ? 'abcdef01' : null,
    live ? o.sync_cursor : null, o.initial_done, o.sync_requested_at, o.last_sync_at, o.last_ok_at,
  )
}
const iid = (n: number) => `i${n.toString(16).padStart(16, '0')}`

beforeEach(async () => {
  db = await createBudgetDb({ seed: false })
  calls = []
  responder = () => page()
})

describe('pickDue', () => {
  it('picks due items, requested first, at most 3, active and pending_disconnect only', async () => {
    seedItem(iid(1), { last_ok_at: ago(HOUR) }) // fresh: not due
    seedItem(iid(2), { last_ok_at: ago(21 * HOUR) }) // stale
    seedItem(iid(3), { last_ok_at: null }) // never synced
    seedItem(iid(4), { last_ok_at: ago(HOUR), sync_requested_at: ago(2 * HOUR) }) // requested, oldest
    seedItem(iid(5), { last_ok_at: ago(HOUR), sync_requested_at: ago(HOUR) }) // requested, newer
    seedItem(iid(6), { last_ok_at: null, status: 'needs_reconnect' }) // not in the sync pick
    seedItem(iid(7), { last_ok_at: null, status: 'revoked' })
    seedItem(iid(8), { last_ok_at: ago(30 * HOUR), status: 'pending_disconnect' })
    const ids = await pickDue(db.d1, NOW, 'sandbox')
    expect(ids).toHaveLength(3)
    expect(ids.slice(0, 2)).toEqual([iid(4), iid(5)])
    expect([iid(2), iid(3), iid(8)]).toContain(ids[2])
    expect(ids).not.toContain(iid(1))
    expect(ids).not.toContain(iid(6))
  })

  it('nothing due returns an empty list', async () => {
    seedItem(iid(1))
    expect(await pickDue(db.d1, NOW, 'sandbox')).toEqual([])
  })

  it('every pick and claim read uses an index', () => {
    const due = db.explain(DUE_SQL, [ago(20 * HOUR), ago(15 * 60_000), 'sandbox']).join('\n')
    expect(due).toMatch(/idx_bank_items_due/)
    expect(due).not.toMatch(/SCAN bank_items(?! USING)/)
    expect(db.explain(RECONNECT_SQL, [ago(24 * HOUR)]).join('\n')).toMatch(/idx_bank_items_due/)
    expect(db.explain(CLAIM_SQL, [iid(1), NOW.toISOString(), ago(15 * 60_000)]).join('\n')).toMatch(/PRIMARY KEY|sqlite_autoindex_bank_items/)
    const mapped = db.explain(MAPPED_SQL, [iid(1)]).join('\n')
    expect(mapped).toMatch(/idx_bank_acct_item/)
    expect(mapped).toMatch(/idx_bank_txn_acct/)
  })
})

describe('pickReconnect', () => {
  it('picks needs_reconnect items not looked at for 24 h', async () => {
    seedItem(iid(1), { status: 'needs_reconnect', last_sync_at: null })
    seedItem(iid(2), { status: 'needs_reconnect', last_sync_at: ago(25 * HOUR) })
    seedItem(iid(3), { status: 'needs_reconnect', last_sync_at: ago(HOUR) })
    seedItem(iid(4), { status: 'active', last_sync_at: null })
    expect((await pickReconnect(db.d1, NOW)).sort()).toEqual([iid(1), iid(2)])
    expect(await claim(db.d1, iid(1), NOW, RECONNECT_WINDOW_MS)).toBe(true)
    expect(await pickReconnect(db.d1, NOW)).toEqual([iid(2)])
  })
})

describe('claim', () => {
  it('a second claim inside 15 minutes skips; after 15 minutes it takes', async () => {
    seedItem(iid(1))
    expect(await claim(db.d1, iid(1), NOW)).toBe(true)
    expect(await claim(db.d1, iid(1), new Date(NOW.getTime() + 14 * 60_000))).toBe(false)
    expect(db.get<{ last_sync_at: string }>('SELECT last_sync_at FROM bank_items WHERE id = ?', iid(1))?.last_sync_at).toBe(NOW.toISOString())
    expect(await claim(db.d1, iid(1), new Date(NOW.getTime() + 16 * 60_000))).toBe(true)
  })

  it('an unknown id claims nothing', async () => {
    expect(await claim(db.d1, iid(9), NOW)).toBe(false)
  })

  it('touches only last_sync_at', async () => {
    seedItem(iid(1), { sync_requested_at: ago(HOUR) })
    const before = db.get<Record<string, unknown>>('SELECT * FROM bank_items WHERE id = ?', iid(1))!
    await claim(db.d1, iid(1), NOW)
    const after = db.get<Record<string, unknown>>('SELECT * FROM bank_items WHERE id = ?', iid(1))!
    for (const k of Object.keys(before)) if (k !== 'last_sync_at') expect(after[k]).toEqual(before[k])
  })
})

describe('run row and trigger', () => {
  it('startRun inserts the row and finishRun closes it', async () => {
    seedItem(iid(1))
    const id = await startRun(db.d1, iid(1), 'cron', NOW)
    expect(db.get<Record<string, any>>('SELECT * FROM bank_sync_runs WHERE id = ?', id)).toMatchObject({ item_id: iid(1), run_trigger: 'cron', started_at: NOW.toISOString(), finished_at: null, pages: 0 })
    await finishRun(db.d1, id, NOW, 2, 'sync_mutation')
    expect(db.get<Record<string, any>>('SELECT * FROM bank_sync_runs WHERE id = ?', id)).toMatchObject({ finished_at: NOW.toISOString(), pages: 2, error_code: 'sync_mutation' })
  })

  it('chooses initial, resync, the flag source, or cron', async () => {
    seedItem(iid(1))
    const f = { initial_done: 1, sync_cursor: 'c' as string | null, sync_requested_at: null as string | null }
    expect(await chooseTrigger(db.d1, iid(1), { ...f, initial_done: 0 })).toBe('initial')
    expect(await chooseTrigger(db.d1, iid(1), f)).toBe('cron')
    expect(await chooseTrigger(db.d1, iid(1), { ...f, sync_requested_at: ago(HOUR) }, 'webhook')).toBe('webhook')
    expect(await chooseTrigger(db.d1, iid(1), { ...f, sync_requested_at: ago(HOUR) }, 'manual')).toBe('manual')
    // cursor NULL with no mapped rows is not a resync
    expect(await chooseTrigger(db.d1, iid(1), { ...f, sync_cursor: null })).toBe('cron')
    run('PRAGMA foreign_keys = OFF')
    run(`INSERT INTO bank_accounts (id, item_id, plaid_account_id, name, type, created_at, updated_at) VALUES ('b0000000000000001', ?, 'acc-sandbox-001', 'Checking', 'depository', 'x', 'x')`, iid(1))
    run(`INSERT INTO bank_txns (plaid_txn_id, bank_account_id, txn_id, role, seen_at, updated_at) VALUES ('txn-sandbox-001', 'b0000000000000001', 'tt', 'inserted', 'x', 'x')`)
    expect(await chooseTrigger(db.d1, iid(1), { ...f, sync_cursor: null })).toBe('resync')
  })
})

describe('release and the fair pick', () => {
  const MIN = 60_000
  const at = (n: number) => new Date(NOW.getTime() + n * MIN)
  const stamp = (id: string) => db.get<{ last_sync_at: string | null }>('SELECT last_sync_at FROM bank_items WHERE id = ?', id)?.last_sync_at ?? null
  const standingError = (id: string) => run(`UPDATE bank_items SET last_error = 'plaid_rate_limit' WHERE id = ?`, id)

  it('a claimed Item (a run in flight, or one that crashed) is not picked for 15 minutes; a released one is picked at once', async () => {
    seedItem(iid(1), { last_ok_at: null })
    expect(await claim(db.d1, iid(1), NOW)).toBe(true)
    expect(await pickDue(db.d1, at(5), 'sandbox')).toEqual([]) // in flight or crashed: skipped inside the window
    expect(await pickDue(db.d1, at(16), 'sandbox')).toEqual([iid(1)]) // a crashed run lapses by itself
    await release(db.d1, iid(1), NOW)
    expect(await pickDue(db.d1, at(5), 'sandbox')).toEqual([iid(1)]) // a finished run does not hold the Item
    expect(await claim(db.d1, iid(1), at(5))).toBe(true)
  })

  it('release keeps a newer claim and only moves back the stamp it was given', async () => {
    seedItem(iid(1), { last_ok_at: null })
    await claim(db.d1, iid(1), NOW)
    await claim(db.d1, iid(1), at(20)) // a later run took the Item
    await release(db.d1, iid(1), NOW) // the earlier run's release must not free the later claim
    expect(stamp(iid(1))).toBe(at(20).toISOString())
  })

  it('Items with a standing error sort after the rest: the healthy requested Item is picked first', async () => {
    for (const n of [1, 2, 3]) { seedItem(iid(n), { last_ok_at: ago(HOUR), sync_requested_at: ago(3 * HOUR) }); standingError(iid(n)) }
    seedItem(iid(4), { last_ok_at: ago(HOUR), sync_requested_at: ago(HOUR) })
    expect((await pickDue(db.d1, NOW, 'sandbox'))[0]).toBe(iid(4))
  })

  it('five Items with a standing error are all retried within a few ticks, none skipped forever; a healthy Item is never starved', async () => {
    for (const n of [1, 2, 3, 4, 5]) { seedItem(iid(n), { last_ok_at: ago(HOUR), sync_requested_at: ago(3 * HOUR) }); standingError(iid(n)) }
    seedItem(iid(6), { last_ok_at: null })
    const picked = new Map<string, number>()
    for (let tick = 0; tick < 4; tick++) {
      const now = at(tick) // one minute apart: far inside the claim window, so only release lets an Item back in
      for (const id of await pickDue(db.d1, now, 'sandbox')) {
        expect(await claim(db.d1, id, now)).toBe(true)
        picked.set(id, (picked.get(id) ?? 0) + 1)
        await release(db.d1, id, now) // the run failed again: it finished with its error
      }
    }
    for (const n of [1, 2, 3, 4, 5, 6]) expect(picked.get(iid(n)) ?? 0, `Item ${n} was picked`).toBeGreaterThanOrEqual(1)
    // the rotation is least recently run first: after 4 ticks of 3 slots no Item was picked twice before every other was picked once
    expect(Math.max(...picked.values()) - Math.min(...picked.values())).toBeLessThanOrEqual(1)
  })

  it('more due Items than one tick can take: every Item runs within ceil(n / 3) ticks', async () => {
    for (let n = 1; n <= 8; n++) seedItem(iid(n), { last_ok_at: null })
    const seen = new Set<string>()
    for (let tick = 0; tick < 3; tick++) {
      const now = at(tick)
      for (const id of await pickDue(db.d1, now, 'sandbox')) {
        await claim(db.d1, id, now)
        seen.add(id)
        run(`UPDATE bank_items SET last_ok_at = ? WHERE id = ?`, now.toISOString(), id) // done: no longer due
        await release(db.d1, id, now)
      }
    }
    expect(seen.size).toBe(8)
  })
})

describe('fetchUpdate', () => {
  it('maxPages stops after that many pages with more: true and the cursor to resume from', async () => {
    responder = (_c, n) => page({ added: [txn(`t${n}`)], next_cursor: `cur-${n}`, has_more: n < 5 })
    const r = await fetchUpdate(client(), 'access-sandbox-aaaa', 'cur-0', { maxPages: 2 })
    expect(r).toMatchObject({ kind: 'ok', nextCursor: 'cur-2', pages: 2, more: true })
    expect(calls).toHaveLength(2)
    const rest = await fetchUpdate(client(), 'access-sandbox-aaaa', 'cur-2', { maxPages: 10 })
    expect(rest).toMatchObject({ kind: 'ok', nextCursor: 'cur-5', pages: 3, more: false })
  })

  it('loops while has_more, passes each next_cursor and collects every page', async () => {
    responder = (c, n) =>
      n === 1 ? page({ added: [txn('t1')], next_cursor: 'cur-a', has_more: true })
      : n === 2 ? page({ modified: [txn('t2')], next_cursor: 'cur-b', has_more: true })
      : page({ removed: [{ transaction_id: 't3', account_id: 'acc-sandbox-001' }], next_cursor: 'cur-c', has_more: false })
    const r = await fetchUpdate(client(), 'access-sandbox-aaaa', 'cur-0')
    expect(r).toMatchObject({ kind: 'ok', nextCursor: 'cur-c', pages: 3 })
    if (r.kind !== 'ok') throw new Error('x')
    expect([r.added.length, r.modified.length, r.removed.length]).toEqual([1, 1, 1])
    expect(calls.map((c) => c.cursor)).toEqual(['cur-0', 'cur-a', 'cur-b'])
    expect(calls.every((c) => c.count === 500 && c.access_token === 'access-sandbox-aaaa')).toBe(true)
  })

  it('omits the cursor when there is none', async () => {
    await fetchUpdate(client(), 'access-sandbox-aaaa', null)
    expect('cursor' in calls[0]).toBe(false)
  })

  it('a mutation drops what was collected and restarts from cursor0', async () => {
    responder = (_c, n) =>
      n === 1 ? page({ added: [txn('t1')], next_cursor: 'cur-a', has_more: true })
      : n === 2 ? plaidError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'TRANSACTIONS_ERROR')
      : n === 3 ? page({ added: [txn('t9')], next_cursor: 'cur-z', has_more: false })
      : page()
    const r = await fetchUpdate(client(), 'access-sandbox-aaaa', 'cur-0')
    expect(r).toMatchObject({ kind: 'ok', nextCursor: 'cur-z', pages: 3 })
    if (r.kind !== 'ok') throw new Error('x')
    expect(r.added.map((t) => t.transaction_id)).toEqual(['t9']) // t1 was dropped
    expect(calls.map((c) => c.cursor)).toEqual(['cur-0', 'cur-a', 'cur-0'])
  })

  it('stops with sync_mutation after the third restart, applying nothing', async () => {
    responder = () => plaidError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'TRANSACTIONS_ERROR')
    const r = await fetchUpdate(client(), 'access-sandbox-aaaa', 'cur-0')
    expect(r).toEqual({ kind: 'error', code: 'sync_mutation', pages: 4 }) // first try plus 3 restarts
    expect(calls.every((c) => c.cursor === 'cur-0')).toBe(true)
  })

  it('stops with too_many_pages at the 61st page', async () => {
    responder = (_c, n) => page({ added: [txn(`t${n}`)], next_cursor: `cur-${n}`, has_more: true })
    const r = await fetchUpdate(client(), 'access-sandbox-aaaa', null)
    expect(r).toEqual({ kind: 'error', code: 'too_many_pages', pages: 60 })
    expect(calls).toHaveLength(60)
  })

  it('exactly 60 pages with the last one final is fine', async () => {
    responder = (_c, n) => page({ added: [txn(`t${n}`)], next_cursor: `cur-${n}`, has_more: n < 60 })
    const r = await fetchUpdate(client(), 'access-sandbox-aaaa', null)
    expect(r).toMatchObject({ kind: 'ok', pages: 60, nextCursor: 'cur-60' })
  })

  it('an empty next_cursor with empty arrays is a no-op', async () => {
    responder = () => page({ next_cursor: '' })
    expect(await fetchUpdate(client(), 'access-sandbox-aaaa', 'cur-0')).toEqual({ kind: 'noop', pages: 1 })
  })

  it('PRODUCT_NOT_READY is a no-op', async () => {
    responder = () => plaidError('PRODUCT_NOT_READY', 'ITEM_ERROR')
    expect(await fetchUpdate(client(), 'access-sandbox-aaaa', null)).toEqual({ kind: 'noop', pages: 1 })
  })

  it('ITEM_LOGIN_REQUIRED means needs_reconnect', async () => {
    responder = () => plaidError('ITEM_LOGIN_REQUIRED')
    expect(await fetchUpdate(client(), 'access-sandbox-aaaa', 'cur-0')).toEqual({ kind: 'needs_reconnect', pages: 1 })
  })

  it('another Plaid error becomes a plaid_<code> code, cut to 40', async () => {
    responder = () => plaidError('INTERNAL_SERVER_ERROR', 'API_ERROR')
    expect(await fetchUpdate(client(), 'access-sandbox-aaaa', 'cur-0')).toEqual({ kind: 'error', code: 'plaid_internal_server_error', pages: 1 })
    expect(plaidErrorCode('A'.repeat(80))).toHaveLength(40)
    expect(plaidErrorCode('ODD-code.1')).toBe('plaid_odd_code_1')
  })

  it('a malformed answer is bad_response and a non-empty answer without a cursor too', async () => {
    responder = () => json({ added: 'x', next_cursor: 'c', has_more: false })
    expect(await fetchUpdate(client(), 'access-sandbox-aaaa', null)).toMatchObject({ kind: 'error', code: 'bad_response' })
    responder = () => page({ added: [txn('t1')], next_cursor: '' })
    expect(await fetchUpdate(client(), 'access-sandbox-aaaa', null)).toMatchObject({ kind: 'error', code: 'bad_response' })
  })

  it('writes nothing to D1', async () => {
    seedItem(iid(1))
    const before = db.statements.length
    await fetchUpdate(client(), 'access-sandbox-aaaa', 'cur-0')
    expect(db.statements.length).toBe(before)
  })
})

describe('normalize', () => {
  it('flips the sign: Plaid positive (money out) is negative here', () => {
    expect(normalize(txn('t1', { amount: 12.34 }))?.amountCents).toBe(-1234)
    expect(normalize(txn('t1', { amount: -250 }))?.amountCents).toBe(25000)
    expect(Object.is(normalize(txn('t1', { amount: 0 }))?.amountCents, 0)).toBe(true)
  })

  it('rounds cents from float sums', () => {
    expect(toCents(12.34)).toBe(-1234) // 12.34 * 100 = 1233.9999999999998
    expect(toCents(0.1 + 0.2)).toBe(-30) // 0.30000000000000004
    expect(toCents(-0.1 - 0.2)).toBe(30)
    expect(toCents(2.5)).toBe(-250)
  })

  it('skips non-USD and untrusted rows', () => {
    expect(normalize(txn('t1', { iso_currency_code: 'EUR' }))).toBeNull()
    expect(normalize(txn('t1', { iso_currency_code: null, unofficial_currency_code: 'BTC' }))).toBeNull()
    expect(normalize(txn('bad id!'))).toBeNull()
    expect(normalize(txn('t1', { date: '2026-02-30' }))).toBeNull()
    expect(normalize(txn('t1', { amount: '12.34' }))).toBeNull()
    expect(normalize(txn('t1', { amount: Number.NaN }))).toBeNull()
  })

  it('masks digits and cuts the description to 300', () => {
    const d = normalize(txn('t1', { name: 'Card payment 123456789012 ref' }))!.description
    expect(d).not.toMatch(/\d{5}/)
    expect(d).toContain('9012')
    expect(normalize(txn('t1', { name: 'x'.repeat(500) }))!.description).toHaveLength(300)
    expect(normalize(txn('t1', { name: '  Corner   Cafe ' }))!.description).toBe('Corner Cafe')
  })

  it('falls back to merchant_name when name is missing', () => {
    expect(normalize(txn('t1', { name: null, merchant_name: 'Pine Ridge Market' }))!.description).toBe('Pine Ridge Market')
  })

  it('maps dates, pending, ref and the pending id', () => {
    const n = normalize(txn('t1', { date: '2026-11-21', authorized_date: '2026-11-20', pending: true, pending_transaction_id: 'tp-1' }))!
    expect(n).toMatchObject({ postedDate: '2026-11-21', txnDate: '2026-11-20', pending: 1, pendingTransactionId: 'tp-1', bankRef: 'plaid:t1', plaidTxnId: 't1', plaidAccountId: 'acc-sandbox-001' })
    expect(normalize(txn('t1'))).toMatchObject({ txnDate: null, pending: 0, pendingTransactionId: null })
  })
})
