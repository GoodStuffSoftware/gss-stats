// PUT /api/budget/debts/:id/balance on the node:sqlite D1 fake (synthetic data).
import { beforeEach, describe, expect, it } from 'vitest'
import type { DebtDetail, DebtsResponse } from '../../../../../src/lib/budget/types'
import { callRoute, createBudgetDb, json, type FakeBudgetDb } from '../../../../_lib/testing/budgetDb'
import { onRequest as debts } from '../index'
import { onRequest as detail } from './index'
import { onRequest } from './balance'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })

const put = (id: string, body: unknown, over: { rawBody?: string; email?: string | null; method?: string } = {}) =>
  callRoute(onRequest, db, `/api/budget/debts/${id}/balance`, { method: 'PUT', params: { id }, body, ...over })
const stored = (id: string) => db.all<Record<string, unknown>>('SELECT * FROM debt_balances WHERE account_id = ? ORDER BY as_of', id)

describe('PUT /api/budget/debts/:id/balance', () => {
  it('stores a typed balance with who and when, and the debt list then shows it', async () => {
    const res = await put('mtg', { asOf: '2026-12-02', balanceCents: 21_500_000, aprBp: 450 })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await json(res)).toEqual({ ok: true })
    expect(stored('mtg')).toEqual([expect.objectContaining({ account_id: 'mtg', as_of: '2026-12-02', balance_cents: 21_500_000, apr_bp: 450, entered_by: 'user-a@example.com' })])
    expect(stored('mtg')[0]!.entered_at).toMatch(/^\d{4}-\d\d-\d\dT/)
    const { debts: list } = await json<DebtsResponse>(await callRoute(debts, db, '/api/budget/debts'))
    expect(list.find((d) => d.accountId === 'mtg')).toMatchObject({ balanceCents: 21_500_000, asOf: '2026-12-02', source: 'manual', aprBp: 450 })
    const d = await json<DebtDetail>(await callRoute(detail, db, '/api/budget/debts/mtg', { params: { id: 'mtg' } }))
    expect(d.history).toEqual([{ asOf: '2026-12-02', balanceCents: 21_500_000, source: 'manual', aprBp: 450 }])
  })

  it('the same day again replaces the earlier entry; zero is a valid balance; aprBp is optional', async () => {
    await put('store-card', { asOf: '2026-12-02', balanceCents: 5000 })
    await put('store-card', { asOf: '2026-12-02', balanceCents: 0, aprBp: 2499 })
    expect(stored('store-card')).toEqual([expect.objectContaining({ as_of: '2026-12-02', balance_cents: 0, apr_bp: 2499 })])
    await put('store-card', { asOf: '2026-12-03', balanceCents: 100 })
    expect(stored('store-card').map((r) => [r.as_of, r.apr_bp])).toEqual([['2026-12-02', 2499], ['2026-12-03', null]])
  })

  it('also works as an override on a debt that has statements', async () => {
    expect((await put('card-a', { asOf: '2026-12-09', balanceCents: 9000 })).status).toBe(200)
    const { debts: list } = await json<DebtsResponse>(await callRoute(debts, db, '/api/budget/debts'))
    expect(list.find((d) => d.accountId === 'card-a')).toMatchObject({ balanceCents: 9000, source: 'manual' })
  })

  it('400 for a bad date, bad or negative or fractional cents, bad rate, or a non-debt account; nothing is stored', async () => {
    const bad = async (id: string, body: unknown, field: string) => {
      const res = await put(id, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      const b = await json<{ error: string; message: string }>(res)
      expect(b.error).toBe('bad_request')
      expect(b.message.startsWith(field), b.message).toBe(true)
    }
    await bad('mtg', { balanceCents: 1 }, 'asOf')
    await bad('mtg', { asOf: '2026-02-30', balanceCents: 1 }, 'asOf')
    await bad('mtg', { asOf: 'today', balanceCents: 1 }, 'asOf')
    await bad('mtg', { asOf: '2026-12-02' }, 'balanceCents')
    await bad('mtg', { asOf: '2026-12-02', balanceCents: -1 }, 'balanceCents')
    await bad('mtg', { asOf: '2026-12-02', balanceCents: 1.5 }, 'balanceCents')
    await bad('mtg', { asOf: '2026-12-02', balanceCents: '100' }, 'balanceCents')
    await bad('mtg', { asOf: '2026-12-02', balanceCents: 2 ** 60 }, 'balanceCents')
    await bad('mtg', { asOf: '2026-12-02', balanceCents: 1, aprBp: -1 }, 'aprBp')
    await bad('mtg', { asOf: '2026-12-02', balanceCents: 1, aprBp: 10_001 }, 'aprBp')
    await bad('mtg', { asOf: '2026-12-02', balanceCents: 1, aprBp: 4.5 }, 'aprBp')
    await bad('chk-a', { asOf: '2026-12-02', balanceCents: 1 }, 'account')
    for (const rawBody of ['{nope', '[]', '"x"']) expect((await put('mtg', null, { rawBody })).status).toBe(400)
    expect(stored('mtg')).toEqual([])
    expect(stored('chk-a')).toEqual([])
  })

  it('404 for an unknown or malformed account id', async () => {
    for (const id of ['nope', "x'; --", 'a'.repeat(100)]) {
      const res = await put(id, { asOf: '2026-12-02', balanceCents: 1 })
      expect(res.status, id).toBe(404)
      expect((await json<{ error: string }>(res)).error).toBe('not_found')
    }
  })

  it('413 over 1 KB', async () => {
    const res = await put('mtg', { asOf: '2026-12-02', balanceCents: 1, note: 'x'.repeat(2000) })
    expect(res.status).toBe(413)
    expect((await json<{ error: string }>(res)).error).toBe('too_large')
  })

  it('PUT only (405 with Allow); 403 without identity', async () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const res = await put('mtg', method === 'GET' ? undefined : { asOf: '2026-12-02', balanceCents: 1 }, { method })
      expect(res.status, method).toBe(405)
      expect(res.headers.get('Allow')).toBe('PUT')
    }
    expect((await put('mtg', { asOf: '2026-12-02', balanceCents: 1 }, { email: null })).status).toBe(403)
    expect(stored('mtg')).toEqual([])
  })
})
