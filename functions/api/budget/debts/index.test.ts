// GET /api/budget/debts on the node:sqlite D1 fake (synthetic data).
import { beforeEach, describe, expect, it } from 'vitest'
import type { DebtsResponse } from '../../../../src/lib/budget/types'
import { addPersonB, callRoute, createBudgetDb, json, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import { onRequest } from './index'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })
const get = (query: Record<string, string | undefined> = {}, over: { email?: string | null } = {}) => callRoute(onRequest, db, '/api/budget/debts', { query, ...over })

describe('GET /api/budget/debts', () => {
  it('every debt account with its latest balance, in the contract shape', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const { debts } = await json<DebtsResponse>(res)
    expect(debts.map((d) => d.accountId).sort()).toEqual(['card-a', 'loan-a', 'loc-a', 'mtg', 'store-card'])
    for (const d of debts) expect(Object.keys(d).sort()).toEqual(['accountId', 'aprBp', 'asOf', 'balanceCents', 'cosigned', 'creditLimitCents', 'kind', 'label', 'last4', 'personId', 'source'])
    expect(debts.find((d) => d.accountId === 'card-a')).toEqual({
      accountId: 'card-a', label: 'Card A', kind: 'card', last4: '0003', personId: 'pa', balanceCents: 18_000, asOf: '2026-12-04', source: 'statement', aprBp: 2199, creditLimitCents: 500_000, cosigned: false,
    })
    // a debt with no statement and no typed balance is listed with a null balance
    expect(debts.find((d) => d.accountId === 'mtg')).toMatchObject({ balanceCents: null, asOf: null, source: null, aprBp: 450, personId: null })
  })

  it('a typed balance newer than the statement wins and may carry its own rate', async () => {
    db.exec("INSERT INTO debt_balances VALUES ('card-a', '2026-12-10', 15500, 1999, '2026-12-10T00:00:00.000Z', 'x@example.com')")
    const { debts } = await json<DebtsResponse>(await get())
    expect(debts.find((d) => d.accountId === 'card-a')).toMatchObject({ balanceCents: 15_500, asOf: '2026-12-10', source: 'manual', aprBp: 1999 })
  })

  it('the person filter keeps shared debts and drops other people\'s', async () => {
    addPersonB(db)
    db.exec("UPDATE accounts SET kind = 'card', is_debt = 1, label = 'Card B' WHERE id = 'chk-b'")
    const pb = (await json<DebtsResponse>(await get({ person: 'pb' }))).debts.map((d) => d.accountId).sort()
    expect(pb).toEqual(['chk-b', 'mtg'])
    const pa = (await json<DebtsResponse>(await get({ person: 'pa' }))).debts.map((d) => d.accountId)
    expect(pa).not.toContain('chk-b')
    expect(pa).toContain('mtg')
    expect((await json<DebtsResponse>(await get({ person: 'all' }))).debts.length).toBe(6)
  })

  it('400 for an unknown person; archived debts are left out', async () => {
    const res = await get({ person: 'nobody' })
    expect(res.status).toBe(400)
    expect((await json<{ error: string; message: string }>(res)).message.startsWith('person')).toBe(true)
    db.exec("UPDATE accounts SET archived = 1 WHERE id = 'loan-a'")
    expect((await json<DebtsResponse>(await get())).debts.map((d) => d.accountId)).not.toContain('loan-a')
  })

  it('an empty database answers an empty list', async () => {
    const empty = await createBudgetDb({ seed: false })
    expect(await json(await callRoute(onRequest, empty, '/api/budget/debts'))).toEqual({ debts: [] })
  })

  it('only GET and HEAD (405 with Allow), 403 without identity', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await callRoute(onRequest, db, '/api/budget/debts', { method, body: {} })
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('GET, HEAD')
    }
    expect((await get({}, { email: null })).status).toBe(403)
  })
})
