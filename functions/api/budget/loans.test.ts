// GET /api/budget/loans on the node:sqlite D1 fake (synthetic data).
import { beforeEach, describe, expect, it } from 'vitest'
import type { LoansResponse } from '../../../src/lib/budget/types'
import { lastFullMonths } from '../../_lib/budgetDb'
import { addPersonB, callRoute, createBudgetDb, insertTxn, json, type FakeBudgetDb } from '../../_lib/testing/budgetDb'
import { onRequest } from './loans'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })
const get = (query: Record<string, string | undefined> = {}) => callRoute(onRequest, db, '/api/budget/loans', { query })
const row = (r: LoansResponse, id: string) => r.debts.find((d) => d.accountId === id)!

describe('GET /api/budget/loans', () => {
  it('every debt as /debts has it, plus terms, latest statement, promos and 3 full months of payments', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await json<LoansResponse>(res)
    expect(body.months).toEqual(lastFullMonths(new Date()).months)
    expect(body.debts.map((d) => d.accountId).sort()).toEqual(['card-a', 'loan-a', 'loc-a', 'mtg', 'store-card'])
    expect(Object.keys(row(body, 'card-a')).sort()).toEqual([
      'accountId', 'aprBp', 'asOf', 'balanceCents', 'cosigned', 'creditLimitCents', 'kind', 'label', 'last4', 'latest', 'payments', 'personId', 'promos', 'source', 'terms',
    ])
    expect(row(body, 'card-a')).toMatchObject({ balanceCents: 18_000, asOf: '2026-12-04', source: 'statement', aprBp: 2199 })
    expect(row(body, 'card-a').latest).toMatchObject({ periodEnd: '2026-12-04', payoffCents: null, escrowCents: null, interestCents: 1900 })
    expect(row(body, 'mtg')).toMatchObject({ balanceCents: null, terms: null, latest: null, promos: [] })
    // zero months are listed
    expect(row(body, 'mtg').payments.map((p) => p.amountCents)).toEqual([0, 0, 0])
  })

  it('terms, escrow, payoff and the promos of the NEWEST statement only', async () => {
    db.exec(`INSERT INTO debt_terms (account_id, original_cents, payment_cents, payment_every, cosigned, updated_at, updated_by)
             VALUES ('mtg', 30000000, 150000, 'monthly', 1, '2026-12-01T00:00:00.000Z', 'x@example.com')`)
    db.exec(`INSERT INTO statements (account_id, period_start, period_end, closing_balance_cents, min_due_cents, due_date, escrow_cents, payoff_cents)
             VALUES ('store-card', '2026-10-05', '2026-11-04', 9000, 2500, '2026-11-28', NULL, NULL), ('store-card', '2026-11-05', '2026-12-04', 8000, 2000, '2026-12-28', 500, 8100)`)
    db.exec(`INSERT INTO statement_promos VALUES ('store-card', '2026-11-04', 1, 999, 0, '2027-01-01', 50),
             ('store-card', '2026-12-04', 2, 4000, 0, '2027-03-01', 300), ('store-card', '2026-12-04', 1, 1000, 1999, '2027-02-01', NULL)`)
    const r = await json<LoansResponse>(await get())
    expect(row(r, 'mtg').terms).toMatchObject({ originalCents: 30_000_000, paymentCents: 150_000, paymentEvery: 'monthly', cosigned: true })
    const sc = row(r, 'store-card')
    expect(sc.latest).toMatchObject({ periodEnd: '2026-12-04', minDueCents: 2000, dueDate: '2026-12-28', escrowCents: 500, payoffCents: 8100 })
    expect(sc.promos.map((p) => [p.seq, p.balanceCents, p.endsOn])).toEqual([[1, 1000, '2027-02-01'], [2, 4000, '2027-03-01']])
  })

  it('person filter as /debts: shared debts stay, other people\'s go; unknown person is 400', async () => {
    addPersonB(db)
    expect((await json<LoansResponse>(await get({ person: 'pb' }))).debts.map((d) => d.accountId)).toEqual(['mtg'])
    expect((await get({ person: 'nobody' })).status).toBe(400)
  })

  it('payments are summed per month over the last 3 full months, from both link styles, bounded by posted_date', async () => {
    const { months } = lastFullMonths(new Date())
    const [m1, m2, m3] = months as [string, string, string]
    insertTxn(db, { account_id: 'card-a', kind: 'card_payment', posted_date: `${m1}-31`, amount_cents: 1000 })
    insertTxn(db, { account_id: 'card-a', kind: 'card_payment', posted_date: `${m3}-01`, amount_cents: 2500 })
    insertTxn(db, { account_id: 'card-a', kind: 'card_payment', posted_date: `${m3}-20`, amount_cents: 500 })
    insertTxn(db, { account_id: 'card-a', kind: 'spend', posted_date: `${m3}-20`, amount_cents: 700 }) // not a payment
    insertTxn(db, { account_id: 'chk-a', kind: 'transfer', posted_date: `${m2}-10`, amount_cents: -90_000, merchant_key: 'x' })
    db.exec(`UPDATE transactions SET debt_account_id = 'mtg' WHERE posted_date = '${m2}-10'`)
    // outside the window: the month before it and the current month
    const before = lastFullMonths(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)))
    insertTxn(db, { account_id: 'card-a', kind: 'card_payment', posted_date: `${before.months[0]}-15`, amount_cents: 9999 })
    insertTxn(db, { account_id: 'card-a', kind: 'card_payment', posted_date: `${lastFullMonths(new Date()).to}`, amount_cents: 8888 })
    const r = await json<LoansResponse>(await get())
    expect(row(r, 'card-a').payments).toEqual([{ month: m1, amountCents: 1000 }, { month: m2, amountCents: 0 }, { month: m3, amountCents: 3000 }])
    expect(row(r, 'mtg').payments).toEqual([{ month: m1, amountCents: 0 }, { month: m2, amountCents: 90_000 }, { month: m3, amountCents: 0 }])
  })

  it('an empty database answers no debts', async () => {
    const empty = await createBudgetDb({ seed: false })
    expect(await json(await callRoute(onRequest, empty, '/api/budget/loans'))).toMatchObject({ debts: [] })
  })
})

describe('lastFullMonths', () => {
  it('the three months before the current one, across a year boundary', () => {
    expect(lastFullMonths(new Date(Date.UTC(2027, 1, 10)))).toEqual({ months: ['2026-11', '2026-12', '2027-01'], from: '2026-11-01', to: '2027-02-01' })
  })
})
