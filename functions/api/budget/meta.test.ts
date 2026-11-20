// GET /api/budget/meta on the node:sqlite D1 fake (synthetic data).
import { beforeEach, describe, expect, it } from 'vitest'
import type { MetaResponse } from '../../../src/lib/budget/types'
import { callRoute, createBudgetDb, json, type FakeBudgetDb } from '../../_lib/testing/budgetDb'
import { onRequest } from './meta'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })

describe('GET /api/budget/meta', () => {
  it('answers people, accounts, categories and the data range in the contract shape', async () => {
    const res = await callRoute(onRequest, db, '/api/budget/meta')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await json<MetaResponse>(res)
    expect(Object.keys(body).sort()).toEqual(['accounts', 'categories', 'people', 'range'])
    expect(body.people).toEqual([{ id: 'pa', label: 'Person A' }, { id: 'pb', label: 'Person B' }])
    expect(body.accounts.map((a) => a.id)).toEqual(['chk-a', 'sav-a', 'card-a', 'loc-a', 'loan-a', 'mtg', 'store-card'])
    expect(body.accounts[2]).toEqual({ id: 'card-a', label: 'Card A', kind: 'card', personId: 'pa', last4: '0003', isDebt: true, inSpending: true, creditLimitCents: 500_000, aprBp: 2199 })
    expect(body.accounts.find((a) => a.id === 'mtg')?.personId).toBeNull()
    expect(body.categories.find((c) => c.id === 'pets')).toEqual({ id: 'pets', label: 'Pets', color: '#a1b2c3', sort: 125 })
    expect(body.categories[0]).toMatchObject({ id: 'groceries', color: null })
    expect(body.categories.map((c) => c.sort)).toEqual([...body.categories.map((c) => c.sort)].sort((a, b) => a - b))
    expect(body.range).toEqual({ min: '2026-11-02', max: '2026-12-01' })
  })

  it('an empty database has a null range, and archived accounts and categories are left out', async () => {
    db.exec('DELETE FROM transactions')
    db.exec("UPDATE accounts SET archived = 1 WHERE id = 'sav-a'; UPDATE categories SET archived = 1 WHERE id = 'travel'")
    const body = await json<MetaResponse>(await callRoute(onRequest, db, '/api/budget/meta'))
    expect(body.range).toEqual({ min: null, max: null })
    expect(body.accounts.map((a) => a.id)).not.toContain('sav-a')
    expect(body.categories.map((c) => c.id)).not.toContain('travel')
  })

  it('one batch of four small reads, nothing else', async () => {
    db.statements.length = 0
    await callRoute(onRequest, db, '/api/budget/meta')
    expect(db.statements.length).toBe(4)
  })

  it('HEAD works; every other method is 405 with Allow; a missing identity is 403; a missing database is 503', async () => {
    expect((await callRoute(onRequest, db, '/api/budget/meta', { method: 'HEAD' })).status).toBe(200)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await callRoute(onRequest, db, '/api/budget/meta', { method, body: method === 'OPTIONS' ? undefined : {} })
      expect(res.status, method).toBe(405)
      expect(res.headers.get('Allow')).toBe('GET, HEAD')
      expect(res.headers.get('Cache-Control')).toBe('private, no-store')
      expect(await json(res)).toEqual({ error: 'method_not_allowed' })
    }
    expect((await callRoute(onRequest, db, '/api/budget/meta', { email: null })).status).toBe(403)
    const ctx = { request: new Request('https://x.test/api/budget/meta'), env: {}, data: { budgetEmail: 'a@example.com' }, params: {} } as never
    expect((await onRequest(ctx)).status).toBe(503)
  })
})
