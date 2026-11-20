// POST /api/budget/rules/apply on the node:sqlite D1 fake (synthetic data): re-run the rules over stored rows.
import { beforeEach, describe, expect, it } from 'vitest'
import { D1_MAX_SQL_BYTES, callRoute, createBudgetDb, insertTxn, json, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import { onRequest } from './apply'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })

const apply = (body: unknown, over: { rawBody?: string; email?: string | null } = {}) =>
  callRoute(onRequest, db, '/api/budget/rules/apply', { method: 'POST', body, ...over })
const row = (id: string) => db.get<Record<string, unknown>>('SELECT * FROM transactions WHERE id = ?', id)!
const paws = (over: Record<string, unknown> = {}) => insertTxn(db, { merchant_key: 'paws-and-claws', merchant_name: 'Paws And Claws', ...over })

describe('POST /api/budget/rules/apply', () => {
  it('re-applies the active rules to every merchant that has one when no keys are sent; answers the count', async () => {
    const a = paws()
    const b = paws({ posted_date: '2026-11-21' })
    const c = insertTxn(db, { merchant_key: 'depot-y', merchant_name: 'Depot Y', amount_cents: -2000 })
    const none = insertTxn(db, { merchant_key: 'no-rule-here', merchant_name: 'No Rule Here' })
    const res = await apply({})
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await json(res)).toEqual({ changed: 3 })
    expect(row(a)).toMatchObject({ category_id: 'pets', category_source: 'rule' })
    expect(row(b)).toMatchObject({ category_id: 'pets', category_source: 'rule' })
    expect(row(c)).toMatchObject({ category_id: 'shopping', category_source: 'rule' }) // banded rule: $20 is in 10 to 50
    expect(row(none)).toMatchObject({ category_id: null, category_source: 'none' })
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM category_edits')!.n).toBe(3)
    // idempotent
    expect(await json(await apply({}))).toEqual({ changed: 0 })
  })

  it('merchantKeys limits the run to those merchants', async () => {
    const a = paws()
    const c = insertTxn(db, { merchant_key: 'depot-y', merchant_name: 'Depot Y', amount_cents: -2000 })
    expect(await json(await apply({ merchantKeys: ['paws-and-claws'] }))).toEqual({ changed: 1 })
    expect(row(a).category_id).toBe('pets')
    expect(row(c).category_id).toBeNull()
    expect(await json(await apply({ merchantKeys: [] }))).toEqual({ changed: 0 })
    expect(row(c).category_id).toBeNull()
    expect(await json(await apply({ merchantKeys: ['depot-y', 'depot-y'] }))).toEqual({ changed: 1 })
  })

  it('never changes a manual row (manual category or manual kind), whatever the rule says', async () => {
    const manualCat = paws({ category_id: 'gifts', category_source: 'manual' })
    const manualKind = paws({ kind: 'transfer', kind_source: 'manual' })
    const auto = paws()
    expect(await json(await apply({ merchantKeys: ['paws-and-claws'] }))).toEqual({ changed: 1 })
    expect(row(manualCat)).toMatchObject({ category_id: 'gifts', category_source: 'manual', updated_at: '2026-12-05T10:00:00.000Z' })
    expect(row(manualKind)).toMatchObject({ category_id: null, kind: 'transfer', kind_source: 'manual', updated_at: '2026-12-05T10:00:00.000Z' })
    expect(row(auto).category_id).toBe('pets')
  })

  it('a rule beats an auto value; an inactive rule does nothing; the seed rows stay as they were', async () => {
    const seedState = db.all('SELECT id, category_id, kind, updated_at FROM transactions ORDER BY id')
    const x = paws({ category_id: 'other', category_source: 'auto' })
    expect(await json(await apply({}))).toEqual({ changed: 1 })
    expect(row(x)).toMatchObject({ category_id: 'pets', category_source: 'rule' })
    db.exec("UPDATE merchant_rules SET active = 0 WHERE merchant_key = 'paws-and-claws'")
    const y = paws()
    expect(await json(await apply({ merchantKeys: ['paws-and-claws'] }))).toEqual({ changed: 0 })
    expect(row(y).category_id).toBeNull()
    const now = db.all('SELECT id, category_id, kind, updated_at FROM transactions WHERE id NOT IN (?, ?) ORDER BY id', x, y)
    expect(now).toEqual(seedState)
  })

  it('a long list of rows is written in chunks inside one transaction', async () => {
    for (let i = 0; i < 700; i++) paws({ description: `PAWSX ${i}` })
    expect(await json(await apply({ merchantKeys: ['paws-and-claws'] }))).toEqual({ changed: 700 })
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM transactions WHERE category_id = 'pets' AND description LIKE 'PAWSX %'")!.n).toBe(700)
    // the fake refuses a statement over D1's limits (100 bound parameters, 100 KB), so reaching here means every chunk fit
    expect(db.statements.every((s) => s.length <= D1_MAX_SQL_BYTES)).toBe(true)
  })

  it('400 for bad merchantKeys; 413 over 32 KB; 400 for a bad body', async () => {
    const bad = async (body: unknown) => {
      const res = await apply(body)
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400)
      const b = await json<{ error: string; message: string }>(res)
      expect(b.error).toBe('bad_request')
      expect(b.message.startsWith('merchantKeys')).toBe(true)
    }
    await bad({ merchantKeys: 'paws-and-claws' })
    await bad({ merchantKeys: [5] })
    await bad({ merchantKeys: [''] })
    await bad({ merchantKeys: ['x'.repeat(81)] })
    await bad({ merchantKeys: ['a\u0000b'] })
    await bad({ merchantKeys: Array.from({ length: 201 }, (_, i) => `m${i}`) })
    expect((await apply({ merchantKeys: Array.from({ length: 200 }, (_, i) => `m${i}`) })).status).toBe(200)
    expect((await apply({ merchantKeys: ['x'.repeat(40_000)] })).status).toBe(413)
    for (const rawBody of ['{nope', '[]', '"x"']) expect((await apply(null, { rawBody })).status).toBe(400)
  })

  it('POST only (405 with Allow); 403 without identity; nothing is written when refused', async () => {
    const a = paws()
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const res = await callRoute(onRequest, db, '/api/budget/rules/apply', { method, body: method === 'GET' ? undefined : {} })
      expect(res.status, method).toBe(405)
      expect(res.headers.get('Allow')).toBe('POST')
    }
    expect((await apply({}, { email: null })).status).toBe(403)
    expect(row(a).category_id).toBeNull()
  })

  it('records the signed-in person as the editor', async () => {
    const a = paws()
    await apply({ merchantKeys: ['paws-and-claws'] })
    expect(row(a).updated_by).toBe('user-a@example.com')
    expect(db.get<{ edited_by: string }>('SELECT edited_by FROM category_edits WHERE txn_id = ?', a)!.edited_by).toBe('user-a@example.com')
  })
})
