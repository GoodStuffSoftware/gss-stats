// GET /api/budget/transactions on the node:sqlite D1 fake (synthetic data).
import { beforeEach, describe, expect, it } from 'vitest'
import type { SummaryResponse, TxnPage } from '../../../../src/lib/budget/types'
import { defaultViewState, summaryQueryOf, txnQueryOf, type BudgetViewState } from '../../../../src/lib/budget/viewState'
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
      'kind', 'kindSource', 'merchantKey', 'merchantName', 'needsReview', 'note', 'pairId', 'postedDate', 'principalCents', 'reviewReason', 'ruleId', 'ruleSafe', 'storeNo', 'txnDate', 'updatedAt', 'updatedBy'])
  })

  it('ruleSafe: true only on a manual row whose key has one display name and is no payment service', async () => {
    const mk = (key: string, name: string, manual = true) => insertTxn(db, {
      merchant_key: key, merchant_name: name, posted_date: '2026-12-03', ...(manual ? { category_id: 'shopping', category_source: 'manual' } : {}),
    })
    const single = mk('solo-shop', 'Solo Shop')
    const auto = mk('solo-shop', 'Solo Shop', false)
    const sharedA = mk('shared-key', 'Merchant One')
    mk('shared-key', 'Merchant Two', false)
    const rail = mk('paypal-purchase', 'Made Up Merchant')
    const page = await json<TxnPage>(await get({ from: '2026-11-01', to: '2026-12-31', limit: '200' }))
    const flag = (id: string) => page.rows.find((r) => r.id === id)!.ruleSafe
    expect([flag(single), flag(auto), flag(sharedA), flag(rail)]).toEqual([true, false, false, false])
  })

  it('returns a stored note, and null when there is none', async () => {
    const id = insertTxn(db, { merchant_name: 'Note Cafe', posted_date: '2026-12-02', kind: 'spend' })
    db.sqlite.prepare('UPDATE transactions SET note = ? WHERE id = ?').run('Team lunch (made-up)', id)
    const page = await json<TxnPage>(await get({ from: '2026-11-01', to: '2026-12-31', limit: '200' }))
    expect(page.rows.find((r) => r.id === id)!.note).toBe('Team lunch (made-up)')
    expect(page.rows.filter((r) => r.id !== id).every((r) => r.note === null)).toBe(true)
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
    expect((await ids({ category: 'groceries', merchant: 'Chain X' })).length).toBe(2)
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

  it('review list and reviewCount are the same set: a flagged row of any kind is listed, with its kind', async () => {
    const xfer = insertTxn(db, { kind: 'transfer', amount_cents: -50_000, needs_review: 1, review_reason: 'rule', merchant_key: 'acct-move', merchant_name: 'Acct Move' })
    const pay = insertTxn(db, { kind: 'card_payment', amount_cents: -9000, needs_review: 1, review_reason: 'rule', merchant_key: 'card-pay', merchant_name: 'Card Pay' })
    const pieAll = await json<SummaryResponse>(await callRoute(summary, db, '/api/budget/summary', { query: { from: RANGE.from, to: RANGE.to, person: 'all' } }))
    // both scopes list the same rows once review=1 is on, and the count agrees with them
    for (const scope of ['spending', 'all']) {
      const rows = (await json<TxnPage>(await get({ ...RANGE, scope, review: '1', limit: '200' }))).rows
      expect(rows.length, scope).toBe(pieAll.reviewCount)
      expect(rows.find((r) => r.id === xfer)).toMatchObject({ kind: 'transfer', needsReview: true })
      expect(rows.find((r) => r.id === pay)?.kind).toBe('card_payment')
    }
    // without review=1 the spending scope still hides non-spending kinds
    expect((await json<TxnPage>(await get({ ...RANGE, limit: '200' }))).rows.some((r) => r.id === xfer)).toBe(false)
    // the count follows the drill, like the list does
    const drilled = { from: RANGE.from, to: RANGE.to, person: 'all', category: 'groceries' }
    const pie = await json<SummaryResponse>(await callRoute(summary, db, '/api/budget/summary', { query: drilled }))
    const rows = (await json<TxnPage>(await get({ ...RANGE, category: 'groceries', review: '1', limit: '200' }))).rows
    expect(pie.reviewCount).toBe(rows.length)
    expect(pie.reviewCount).toBeLessThan(pieAll.reviewCount)
  })

  it('an account drill: the view state feeds /summary and /transactions the same account, so slice total = table total', async () => {
    const state: BudgetViewState = {
      ...defaultViewState('2026-12-15'), from: RANGE.from, to: RANGE.to, groupBy: 'account',
      path: [{ level: 'category', key: 'dining', label: 'Dining' }, { level: 'merchant', key: 'chk-a', label: 'Checking A' }],
    }
    const sq = summaryQueryOf(state)
    const tq = txnQueryOf(state)
    expect(sq.account).toBe('chk-a')
    expect(tq.account).toBe('chk-a')
    const toQuery = (q: object) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])) as Record<string, string>
    const pie = await json<SummaryResponse>(await callRoute(summary, db, '/api/budget/summary', { query: toQuery(sq) }))
    const table = await json<TxnPage>(await get({ ...toQuery(tq), limit: '200' }))
    expect(table.rows.length).toBeGreaterThan(0)
    expect(table.rows.every((r) => r.accountId === 'chk-a')).toBe(true)
    expect(pie.level).toBe('purchase')
    expect(pie.totalCents).toBe(-table.rows.reduce((t, r) => t + r.amountCents, 0))
    // one level up, the account slice total is the same number as that table
    const up = await json<SummaryResponse>(await callRoute(summary, db, '/api/budget/summary', { query: toQuery(summaryQueryOf({ ...state, path: state.path.slice(0, 1) })) }))
    expect(up.slices.find((x) => x.key === 'chk-a')?.netCents).toBe(pie.totalCents)
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
