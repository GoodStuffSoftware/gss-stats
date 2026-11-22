// GET /api/budget/debts/:id on the node:sqlite D1 fake (synthetic data).
import { beforeEach, describe, expect, it } from 'vitest'
import type { DebtDetail } from '../../../../../src/lib/budget/types'
import { callRoute, createBudgetDb, insertTxn, json, type FakeBudgetDb } from '../../../../_lib/testing/budgetDb'
import { onRequest } from './index'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })
const get = (id: string, over: { email?: string | null } = {}) => callRoute(onRequest, db, `/api/budget/debts/${id}`, { params: { id }, ...over })

describe('GET /api/budget/debts/:id', () => {
  it('a card: account, balance history, per-period rate and interest, payments toward it', async () => {
    const res = await get('card-a')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const d = await json<DebtDetail>(res)
    expect(Object.keys(d).sort()).toEqual(['account', 'history', 'latest', 'payments', 'periods', 'promos', 'terms'])
    expect(d.account).toMatchObject({ id: 'card-a', kind: 'card', isDebt: true, aprBp: 2199, creditLimitCents: 500_000 })
    expect(d.history).toEqual([{ asOf: '2026-12-04', balanceCents: 18_000, source: 'statement', aprBp: 2199 }])
    expect(d.periods).toEqual([{ periodEnd: '2026-12-04', aprBp: 2199, interestCents: 1900, principalPaidCents: null, advancesCents: null }])
    expect(d.payments.length).toBe(1)
    expect(d.payments[0]).toMatchObject({ postedDate: '2026-11-12', amountCents: 20_000, principalCents: null, interestCents: null })
    expect(d.payments[0]!.id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('terms, the newest statement extras and its promos ride along (null / empty when not loaded)', async () => {
    expect(await json<DebtDetail>(await get('mtg'))).toMatchObject({ terms: null, latest: null, promos: [] })
    db.exec("INSERT INTO debt_terms (account_id, original_cents, payment_cents, payment_every, cosigned, updated_at, updated_by) VALUES ('card-a', 500000, 4500, 'biweekly', 0, '2026-12-01T00:00:00.000Z', 'x@example.com')")
    db.exec("UPDATE statements SET min_due_cents = 3500, due_date = '2026-12-28', escrow_cents = 100, payoff_cents = 18100 WHERE account_id = 'card-a'")
    db.exec("INSERT INTO statement_promos VALUES ('card-a', '2026-12-04', 1, 5000, 0, '2027-02-01', 400)")
    const d = await json<DebtDetail>(await get('card-a'))
    expect(d.terms).toMatchObject({ accountId: 'card-a', originalCents: 500_000, paymentCents: 4500, paymentEvery: 'biweekly', cosigned: false })
    expect(d.latest).toEqual({ periodEnd: '2026-12-04', minDueCents: 3500, dueDate: '2026-12-28', payoffCents: 18_100, escrowCents: 100, interestCents: 1900 })
    expect(d.promos).toEqual([{ accountId: 'card-a', periodEnd: '2026-12-04', seq: 1, balanceCents: 5000, aprBp: 0, endsOn: '2027-02-01', deferredInterestCents: 400 }])
  })

  it('a payments-only debt shows the payments made from other accounts toward it, as positive amounts', async () => {
    const d = await json<DebtDetail>(await get('mtg'))
    expect(d.account).toMatchObject({ id: 'mtg', kind: 'external_debt', personId: null })
    expect(d.history).toEqual([])
    expect(d.periods).toEqual([])
    expect(d.payments).toEqual([expect.objectContaining({ postedDate: '2026-11-15', amountCents: 120_000 })])
  })

  it('typed balances join the history, oldest first, and a statement wins a same-day tie by sorting first', async () => {
    db.exec(`INSERT INTO debt_balances VALUES ('card-a', '2026-11-04', 21000, NULL, 'x', 'y'), ('card-a', '2026-12-04', 17999, NULL, 'x', 'y'), ('card-a', '2026-12-20', 12000, NULL, 'x', 'y')`)
    const d = await json<DebtDetail>(await get('card-a'))
    expect(d.history.map((h) => [h.asOf, h.source])).toEqual([['2026-11-04', 'manual'], ['2026-12-04', 'statement'], ['2026-12-04', 'manual'], ['2026-12-20', 'manual']])
  })

  it('history is capped at the newest 24 of each kind; payments at the newest 60', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => `('card-a', '2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + Math.floor(i / 12)).padStart(2, '0')}', ${i}, NULL, 'x', 'y')`)
    db.exec(`INSERT INTO debt_balances VALUES ${rows.join(', ')}`)
    for (let i = 0; i < 70; i++) insertTxn(db, { account_id: 'card-a', kind: 'card_payment', kind_source: 'auto', amount_cents: 1000 + i, posted_date: '2026-10-01' })
    const d = await json<DebtDetail>(await get('card-a'))
    expect(d.history.filter((h) => h.source === 'manual').length).toBe(24)
    expect(d.payments.length).toBe(60)
    expect(d.payments[0]!.postedDate).toBe('2026-11-12') // newest first
  })

  it('404 for an account that is not a debt, an unknown id, or a malformed id', async () => {
    for (const id of ['chk-a', 'sav-a', 'nope', "x'; --", '..%2Fetc', 'a'.repeat(100)]) {
      const res = await get(id)
      expect(res.status, id).toBe(404)
      expect((await json<{ error: string }>(res)).error).toBe('not_found')
    }
  })

  it('only GET and HEAD (405 with Allow), 403 without identity', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await callRoute(onRequest, db, '/api/budget/debts/card-a', { method, params: { id: 'card-a' }, body: {} })
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('GET, HEAD')
    }
    expect((await get('card-a', { email: null })).status).toBe(403)
  })
})
