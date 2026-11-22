// GET /api/budget/summary on the node:sqlite D1 fake (synthetic data).
import { beforeEach, describe, expect, it } from 'vitest'
import type { SummaryResponse } from '../../../src/lib/budget/types'
import { addPersonB, callRoute, createBudgetDb, insertTxn, json, type FakeBudgetDb } from '../../_lib/testing/budgetDb'
import { onRequest } from './summary'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })
const RANGE = { from: '2026-11-01', to: '2026-12-31', person: 'all' }
const get = (query: Record<string, string | undefined>) => callRoute(onRequest, db, '/api/budget/summary', { query })

describe('GET /api/budget/summary', () => {
  it('level category: slices, total, review count; private, no-store', async () => {
    const res = await get(RANGE)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await json<SummaryResponse>(res)
    expect(body.level).toBe('category')
    expect(Object.keys(body).sort()).toEqual(['level', 'reviewCount', 'slices', 'totalCents'])
    for (const s of body.slices) expect(Object.keys(s).sort()).toEqual(['count', 'key', 'label', 'netCents'])
    expect(body.slices.find((s) => s.key === 'fuel')).toEqual({ key: 'fuel', label: 'Fuel', netCents: 15_200, count: 2 })
    expect(body.totalCents).toBe(body.slices.reduce((s, x) => s + x.netCents, 0))
    expect(body.reviewCount).toBe(6)
  })

  it('level merchant: category drills to merchants; `__none__` is uncategorized; groupBy=account swaps the key', async () => {
    const m = await json<SummaryResponse>(await get({ ...RANGE, category: 'groceries' }))
    expect(m.level).toBe('merchant')
    // the slice key is the display name (several merchant keys can share one); one name, one slice
    expect(m.slices).toEqual([
      { key: 'Chain X Grocery', label: 'Chain X Grocery', netCents: 8400, count: 1 },
      { key: 'Chain X', label: 'Chain X', netCents: 2150, count: 2 },
    ])
    const none = await json<SummaryResponse>(await get({ ...RANGE, category: '__none__' }))
    expect(none.slices.map((s) => s.key).sort()).toEqual(['Bramblewood Market', 'Paypal'])
    const acc = await json<SummaryResponse>(await get({ ...RANGE, category: 'dining', groupBy: 'account' }))
    expect(acc.level).toBe('merchant')
    expect(acc.slices.map((s) => [s.key, s.label])).toEqual([['card-a', 'Card A'], ['chk-a', 'Checking A']])
  })

  it('level purchase: by merchant, or by account when the pie is grouped by account', async () => {
    const p = await json<SummaryResponse>(await get({ ...RANGE, category: 'dining', merchant: 'Quillfeather Cafe' }))
    expect(p.level).toBe('purchase')
    expect(p.slices.map((s) => s.netCents)).toEqual([7800, 450, 450])
    expect(p.slices.every((s) => s.count === 1 && /^[0-9a-f]{32}$/.test(s.key))).toBe(true)
    expect(p.totalCents).toBe(8700)
    // each purchase also carries its date and store (the pie builds a short legend label from them)
    expect(p.slices.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date ?? '') && s.merchant === 'Quillfeather Cafe')).toBe(true)
    const byAcc = await json<SummaryResponse>(await get({ ...RANGE, category: 'dining', groupBy: 'account', account: 'chk-a' }))
    expect(byAcc.level).toBe('purchase')
    expect(byAcc.slices.map((s) => s.netCents)).toEqual([450, 450])
    // a purchase list is capped at 200 rows but the total is the whole slice
    for (let i = 0; i < 230; i++) insertTxn(db, { amount_cents: -100, merchant_key: 'bulk-shop', merchant_name: 'Bulk Shop', category_id: 'other', category_source: 'manual', posted_date: '2026-11-11' })
    const big = await json<SummaryResponse>(await get({ ...RANGE, category: 'other', merchant: 'Bulk Shop' }))
    expect(big.slices.length).toBe(200)
    expect(big.totalCents).toBe(23_000)
  })

  it('one store is one slice even when several merchant keys share its display name; drilling lists every purchase', async () => {
    for (const [key, cents] of [['maple-mart', -1000], ['maple-mart-online', -2500], ['maple-mart-www', -400]] as const) {
      insertTxn(db, { amount_cents: cents, merchant_key: key, merchant_name: 'Maple Mart', category_id: 'shopping', category_source: 'manual', posted_date: '2026-11-12' })
    }
    insertTxn(db, { amount_cents: -700, merchant_key: 'oak-outlet', merchant_name: 'Oak Outlet', category_id: 'shopping', category_source: 'manual', posted_date: '2026-11-12' })
    const m = await json<SummaryResponse>(await get({ ...RANGE, category: 'shopping' }))
    expect(m.slices.filter((s) => s.label === 'Maple Mart')).toEqual([{ key: 'Maple Mart', label: 'Maple Mart', netCents: 3900, count: 3 }])
    expect(new Set(m.slices.map((s) => s.label)).size).toBe(m.slices.length)
    const p = await json<SummaryResponse>(await get({ ...RANGE, category: 'shopping', merchant: 'Maple Mart' }))
    expect(p.level).toBe('purchase')
    expect(p.totalCents).toBe(3900)
    expect(p.slices.map((s) => s.netCents)).toEqual([2500, 1000, 400])
    expect(m.slices.find((s) => s.key === 'Maple Mart')!.netCents).toBe(p.totalCents)
  })

  it('refunds net against spend', async () => {
    insertTxn(db, { kind: 'refund', amount_cents: 2000, category_id: 'fuel', category_source: 'manual', merchant_key: 'chain-x', merchant_name: 'Chain X' })
    const body = await json<SummaryResponse>(await get({ ...RANGE, category: 'fuel' }))
    expect(body.slices[0]).toMatchObject({ key: 'Chain X', netCents: 9000 - 2000, count: 2 })
  })

  it('person filter', async () => {
    addPersonB(db)
    insertTxn(db, { account_id: 'chk-b', amount_cents: -4321, category_id: 'kids', category_source: 'manual', merchant_key: 'toy-box', merchant_name: 'Toy Box' })
    const b = await json<SummaryResponse>(await get({ ...RANGE, person: 'pb' }))
    expect(b.slices).toEqual([{ key: 'kids', label: 'Kids', netCents: 4321, count: 1 }])
    const a = await json<SummaryResponse>(await get({ ...RANGE, person: 'pa' }))
    expect(a.slices.map((s) => s.key)).not.toContain('kids')
  })

  it('400 bad_request, naming the field, for every bad input', async () => {
    const bad = async (query: Record<string, string | undefined>, field: string) => {
      const res = await get(query)
      expect(res.status, JSON.stringify(query)).toBe(400)
      const body = await json<{ error: string; message: string }>(res)
      expect(body.error).toBe('bad_request')
      expect(body.message.startsWith(field), body.message).toBe(true)
    }
    await bad({ to: '2026-12-31' }, 'from')
    await bad({ ...RANGE, from: '2026-02-30' }, 'from')
    await bad({ ...RANGE, from: 'yesterday' }, 'from')
    await bad({ ...RANGE, from: '2026-12-31', to: '2026-01-01' }, 'from')
    await bad({ ...RANGE, from: '2025-01-01', to: '2026-02-06' }, 'to') // 401 days
    await bad({ ...RANGE, category: 'fuel', groupBy: 'level2' }, 'groupBy')
    await bad({ ...RANGE, category: 'nonesuch' }, 'category')
    await bad({ ...RANGE, person: 'nobody' }, 'person')
    await bad({ ...RANGE, merchant: 'chain-x' }, 'category')
  })

  it('a 400-day range is allowed', async () => {
    expect((await get({ from: '2025-01-01', to: '2026-02-05', person: 'all' })).status).toBe(200)
  })

  it('ignores unknown params; binds hostile values instead of running them', async () => {
    expect((await get({ ...RANGE, utm: 'x', category: 'fuel', merchant: "x'; DROP TABLE transactions; --" })).status).toBe(200)
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM transactions')!.n).toBeGreaterThan(20)
  })

  it('excluded purchases leave every total, pie level and drill; parity: total before - total after = the excluded sum', async () => {
    const patchRoute = (await import('./transactions/[id]')).onRequest
    const SEED_STAMP = '2026-12-05T10:00:00.000Z'
    const ids = db.all<{ id: string; amount_cents: number }>(
      "SELECT id, amount_cents FROM transactions WHERE kind = 'spend' AND category_id = 'groceries' AND posted_date BETWEEN '2026-11-01' AND '2026-12-31' ORDER BY id LIMIT 2")
    expect(ids.length).toBe(2)
    const before = await json<SummaryResponse>(await get(RANGE))
    const cat = (b: SummaryResponse, k: string) => b.slices.find((s) => s.key === k)
    const drillBefore = await json<SummaryResponse>(await get({ ...RANGE, category: 'groceries' }))
    for (const r of ids) {
      const res = await callRoute(patchRoute, db, `/api/budget/transactions/${r.id}`, { method: 'PATCH', params: { id: r.id }, body: { included: false, expectedUpdatedAt: SEED_STAMP } })
      expect(res.status).toBe(200)
    }
    const excluded = ids.reduce((s, r) => s - r.amount_cents, 0)
    expect(excluded).toBeGreaterThan(0)
    const after = await json<SummaryResponse>(await get(RANGE))
    expect(before.totalCents - after.totalCents).toBe(excluded)
    expect(cat(before, 'groceries')!.netCents - cat(after, 'groceries')!.netCents).toBe(excluded)
    expect(after.reviewCount).toBe(before.reviewCount)
    const drillAfter = await json<SummaryResponse>(await get({ ...RANGE, category: 'groceries' }))
    const sum = (b: SummaryResponse) => b.slices.reduce((s, x) => s + x.netCents, 0)
    expect(sum(drillBefore) - sum(drillAfter)).toBe(excluded)
    // the purchase level's true total agrees with its slices, and the excluded rows are not among them
    const store = drillBefore.slices[0].key
    const purchases = await json<SummaryResponse>(await get({ ...RANGE, category: 'groceries', merchant: store }))
    expect(purchases.totalCents).toBe(sum(purchases))
    for (const r of ids) expect(purchases.slices.some((s) => s.key === r.id)).toBe(false)
    // the excluded rows stay in the table's list
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE included = 0')!.n).toBe(2)
  })

  it('only GET and HEAD (405 with Allow), 403 without identity', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await callRoute(onRequest, db, '/api/budget/summary', { method, query: RANGE, body: {} })
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('GET, HEAD')
    }
    expect((await callRoute(onRequest, db, '/api/budget/summary', { query: RANGE, email: null })).status).toBe(403)
  })
})
