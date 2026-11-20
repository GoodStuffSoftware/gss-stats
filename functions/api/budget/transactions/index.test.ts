// GET /api/budget/transactions on the node:sqlite D1 fake (synthetic data).
import { beforeEach, describe, expect, it } from 'vitest'
import type { SummaryResponse, TxnPage } from '../../../../src/lib/budget/types'
import { addPersonB, callRoute, createBudgetDb, insertTxn, json, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import { onRequest } from './index'
import { onRequest as summary } from '../summary'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })
const RANGE = { from: '2026-11-01', to: '2026-12-31', person: 'all', scope: 'spending' }
const get = (query: Record<string, string | undefined>) => callRoute(onRequest, db, '/api/budget/transactions', { query })

describe('GET /api/budget/transactions', () => {
  it('a page in the contract shape, newest first, spending scope by default', async () => {
    const res = await get({ from: '2026-11-01', to: '2026-12-31' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const page = await json<TxnPage>(res)
    expect(Object.keys(page).sort()).toEqual(['nextCursor', 'rows'])
    expect(page.nextCursor).toBeNull()
    expect(page.rows.length).toBe(17) // spend + refund + fee rows
    expect(page.rows.every((r) => ['spend', 'refund', 'fee'].includes(r.kind))).toBe(true)
    expect(page.rows[0]).toMatchObject({ postedDate: '2026-12-01', merchantKey: 'bramblewood-market', needsReview: true, reviewReason: 'low_confidence' })
    const fuel = page.rows.find((r) => r.storeNo === '1001')!
    expect(fuel).toMatchObject({ amountCents: -6200, categoryId: 'fuel', categorySource: 'rule', kind: 'spend', kindSource: 'auto', accountId: 'chk-a', note: null })
    expect(Object.keys(fuel).sort()).toEqual(['accountId', 'amountCents', 'categoryId', 'categorySource', 'confidence', 'debtAccountId', 'description', 'id', 'interestCents',
      'kind', 'kindSource', 'merchantKey', 'merchantName', 'needsReview', 'note', 'pairId', 'postedDate', 'principalCents', 'reviewReason', 'ruleId', 'storeNo', 'txnDate', 'updatedAt', 'updatedBy'])
  })

  it('scope all includes transfers, payments and income', async () => {
    const page = await json<TxnPage>(await get({ ...RANGE, scope: 'all', limit: '200' }))
    expect(new Set(page.rows.map((r) => r.kind))).toContain('card_payment')
    expect(page.rows.length).toBe(db.get<{ n: number }>('SELECT COUNT(*) n FROM transactions')!.n)
  })

  it('keyset cursor paging is stable and complete', async () => {
    const all: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await json<TxnPage>(await get({ ...RANGE, limit: '5', cursor }))
      expect(page.rows.length).toBeLessThanOrEqual(5)
      all.push(...page.rows.map((r) => r.id))
      cursor = page.nextCursor ?? undefined
      pages++
    } while (cursor)
    expect(pages).toBe(4)
    expect(new Set(all).size).toBe(17)
    const whole = await json<TxnPage>(await get({ ...RANGE, limit: '200' }))
    expect(all).toEqual(whole.rows.map((r) => r.id))
  })

  it('filters: category, uncategorized, merchant, account, review, person', async () => {
    const ids = async (q: Record<string, string>) => (await json<TxnPage>(await get({ ...RANGE, limit: '200', ...q }))).rows
    expect((await ids({ category: 'fuel' })).length).toBe(2)
    expect((await ids({ category: '__none__' })).every((r) => r.categoryId === null)).toBe(true)
    expect((await ids({ category: 'groceries', merchant: 'chain-x' })).length).toBe(3)
    expect((await ids({ category: 'dining', account: 'card-a' })).map((r) => r.amountCents)).toEqual([-7800])
    expect((await ids({ review: '1' })).length).toBe(6)
    expect((await ids({ review: '1', category: 'groceries' })).length).toBe(2)
    addPersonB(db)
    insertTxn(db, { account_id: 'chk-b', needs_review: 1, review_reason: 'low_confidence' })
    expect((await ids({ person: 'pb' })).length).toBe(1)
    expect((await ids({ person: 'pb', review: '1' })).length).toBe(1)
    expect((await ids({ person: 'pa' })).length).toBe(17)
  })

  it('the pie levels sum to the same numbers as the matching pages', async () => {
    const pie = await json<SummaryResponse>(await callRoute(summary, db, '/api/budget/summary', { query: { from: RANGE.from, to: RANGE.to, person: 'all', category: 'dining', groupBy: 'account' } }))
    for (const s of pie.slices) {
      const rows = (await json<TxnPage>(await get({ ...RANGE, category: 'dining', account: s.key, limit: '200' }))).rows
      expect(-rows.reduce((t, r) => t + r.amountCents, 0)).toBe(s.netCents)
    }
  })

  it('400 for bad dates, range over 400 days, bad limit, scope, review, cursor, category, person', async () => {
    const bad = async (q: Record<string, string | undefined>, field: string) => {
      const res = await get(q)
      expect(res.status, JSON.stringify(q)).toBe(400)
      const body = await json<{ error: string; message: string }>(res)
      expect(body.error).toBe('bad_request')
      expect(body.message.startsWith(field)).toBe(true)
    }
    await bad({ from: '2026-11-01' }, 'to')
    await bad({ ...RANGE, to: '2026-13-01' }, 'to')
    await bad({ ...RANGE, from: '2025-01-01', to: '2026-02-06' }, 'to')
    for (const limit of ['0', '201', '-3', 'x', '2.5']) await bad({ ...RANGE, limit }, 'limit')
    await bad({ ...RANGE, scope: 'wild' }, 'scope')
    await bad({ ...RANGE, review: 'perhaps' }, 'review')
    await bad({ ...RANGE, cursor: 'not-a-cursor' }, 'cursor')
    await bad({ ...RANGE, category: 'nonesuch' }, 'category')
    await bad({ ...RANGE, person: 'nobody' }, 'person')
  })

  it('limit 200 is the most a page returns; the default page is 100', async () => {
    for (let i = 0; i < 260; i++) insertTxn(db, { posted_date: '2026-11-12', amount_cents: -100 - i })
    const dflt = await json<TxnPage>(await get({ ...RANGE }))
    expect(dflt.rows.length).toBe(100)
    expect(dflt.nextCursor).not.toBeNull()
    expect((await json<TxnPage>(await get({ ...RANGE, limit: '200' }))).rows.length).toBe(200)
  })

  it('only GET and HEAD (405 with Allow), 403 without identity', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await callRoute(onRequest, db, '/api/budget/transactions', { method, query: RANGE, body: {} })
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('GET, HEAD')
    }
    expect((await callRoute(onRequest, db, '/api/budget/transactions', { query: RANGE, email: null })).status).toBe(403)
  })
})
