// PATCH /api/budget/transactions/:id on the node:sqlite D1 fake (synthetic data).
import { beforeEach, describe, expect, it } from 'vitest'
import type { Txn, TxnPatchResponse } from '../../../../src/lib/budget/types'
import { callRoute, createBudgetDb, insertTxn, json, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import { onRequest } from './[id]'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })

const SEED_STAMP = '2026-12-05T10:00:00.000Z'
const idOf = (where: string) => db.get<{ id: string }>(`SELECT id FROM transactions WHERE ${where}`)!.id
const patch = (id: string, body: unknown, over: { email?: string | null; rawBody?: string } = {}) =>
  callRoute(onRequest, db, `/api/budget/transactions/${id}`, { method: 'PATCH', params: { id }, body, ...over })
const row = (id: string) => db.get<Record<string, unknown>>('SELECT * FROM transactions WHERE id = ?', id)!

describe('PATCH /api/budget/transactions/:id', () => {
  it('a category edit: manual source, review cleared, audit row, stamp and editor, response = the new row', async () => {
    const id = idOf("store_no = '9999'") // chain-x unknown store: groceries by the fallback rule, flagged ambiguous_store
    expect(row(id)).toMatchObject({ needs_review: 1, review_reason: 'ambiguous_store', category_source: 'rule' })
    const res = await patch(id, { categoryId: 'fuel', expectedUpdatedAt: SEED_STAMP })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const { txn } = await json<TxnPatchResponse>(res)
    expect(txn).toMatchObject({ id, categoryId: 'fuel', categorySource: 'manual', kind: 'spend', kindSource: 'auto', needsReview: false, reviewReason: null, updatedBy: 'user-a@example.com' })
    expect(txn.updatedAt > SEED_STAMP).toBe(true)
    expect(row(id)).toMatchObject({ category_id: 'fuel', category_source: 'manual', updated_at: txn.updatedAt, rule_id: null })
    expect(db.all('SELECT txn_id, old_category_id, new_category_id, old_kind, new_kind, edited_at, edited_by FROM category_edits'))
      .toEqual([{ txn_id: id, old_category_id: 'groceries', new_category_id: 'fuel', old_kind: 'spend', new_kind: 'spend', edited_at: txn.updatedAt, edited_by: 'user-a@example.com' }])
  })

  it('the edited row comes back with ruleSafe: true for a single-merchant key, false for a shared or payment-service key', async () => {
    const solo = insertTxn(db, { merchant_key: 'solo-shop', merchant_name: 'Solo Shop' })
    const a = insertTxn(db, { merchant_key: 'shared-key', merchant_name: 'Merchant One' })
    insertTxn(db, { merchant_key: 'shared-key', merchant_name: 'Merchant Two' })
    const rail = insertTxn(db, { merchant_key: 'venmo-sam', merchant_name: 'Made Up Merchant' })
    const flags: Array<boolean | undefined> = []
    for (const id of [solo, a, rail]) flags.push((await json<TxnPatchResponse>(await patch(id, { categoryId: 'fuel', expectedUpdatedAt: SEED_STAMP }))).txn.ruleSafe)
    expect(flags).toEqual([true, false, false])
  })

  it('the same category as it stands is accepted: it becomes a manual edit and the review flag clears ("Looks right")', async () => {
    const id = idOf("store_no = '9999'")
    expect(row(id)).toMatchObject({ needs_review: 1, review_reason: 'ambiguous_store', category_id: 'groceries', category_source: 'rule' })
    const res = await patch(id, { categoryId: 'groceries', expectedUpdatedAt: SEED_STAMP })
    expect(res.status).toBe(200)
    const { txn } = await json<TxnPatchResponse>(res)
    expect(txn).toMatchObject({ id, categoryId: 'groceries', categorySource: 'manual', needsReview: false, reviewReason: null })
    expect(row(id)).toMatchObject({ category_id: 'groceries', category_source: 'manual', needs_review: 0, review_reason: null, confidence: 100 })
    expect(db.all('SELECT txn_id, old_category_id, new_category_id FROM category_edits')).toEqual([{ txn_id: id, old_category_id: 'groceries', new_category_id: 'groceries' }])
  })

  it('a kind edit makes kind_source manual; a null category means uncategorized and stays manual', async () => {
    const id = idOf("merchant_key = 'paypal'")
    const { txn } = await json<TxnPatchResponse>(await patch(id, { kind: 'transfer', expectedUpdatedAt: SEED_STAMP }))
    expect(txn).toMatchObject({ kind: 'transfer', kindSource: 'manual', categorySource: 'none', needsReview: false })
    const id2 = idOf("store_no = '1001'")
    const r2 = await json<TxnPatchResponse>(await patch(id2, { categoryId: null, expectedUpdatedAt: SEED_STAMP }))
    expect(r2.txn).toMatchObject({ categoryId: null, categorySource: 'manual', kind: 'spend', kindSource: 'auto' })
    const edit = db.get<Record<string, unknown>>('SELECT * FROM category_edits WHERE txn_id = ?', id2)!
    expect(edit).toMatchObject({ old_category_id: 'fuel', new_category_id: null })
  })

  it('category and kind together; a note alone does not mark the row reviewed or write an edit', async () => {
    const id = idOf("merchant_key = 'paypal'")
    const both = await json<TxnPatchResponse>(await patch(id, { categoryId: 'shopping', kind: 'spend', note: 'gift', expectedUpdatedAt: SEED_STAMP }))
    expect(both.txn).toMatchObject({ categoryId: 'shopping', categorySource: 'manual', kindSource: 'manual', note: 'gift', needsReview: false })
    const id2 = idOf("store_no = '9999'")
    const noteOnly = await json<TxnPatchResponse>(await patch(id2, { note: '  fuel? ', expectedUpdatedAt: SEED_STAMP }))
    expect(noteOnly.txn).toMatchObject({ note: '  fuel? ', needsReview: true, categorySource: 'rule' })
    expect(db.all('SELECT * FROM category_edits WHERE txn_id = ?', id2)).toEqual([])
    const cleared = await json<TxnPatchResponse>(await patch(id2, { note: null, expectedUpdatedAt: noteOnly.txn.updatedAt }))
    expect(cleared.txn.note).toBeNull()
  })

  it('409 conflict on a stale expectedUpdatedAt: nothing is written and the body carries the current row', async () => {
    const id = idOf("store_no = '1001'")
    const first = await json<TxnPatchResponse>(await patch(id, { categoryId: 'dining', expectedUpdatedAt: SEED_STAMP }))
    const res = await patch(id, { categoryId: 'gifts', expectedUpdatedAt: SEED_STAMP })
    expect(res.status).toBe(409)
    const body = await json<{ error: string; message: string; current: Txn }>(res)
    expect(body.error).toBe('conflict')
    expect(body.current).toEqual({ ...first.txn, ruleSafe: undefined }) // the conflict copy carries no flag
    expect(row(id).category_id).toBe('dining')
    expect(db.all('SELECT * FROM category_edits').length).toBe(1)
    // and with the fresh stamp it goes through
    expect((await patch(id, { categoryId: 'gifts', expectedUpdatedAt: first.txn.updatedAt })).status).toBe(200)
  })

  it('409 also when the row changes between the read and the write (the UPDATE is guarded by updated_at)', async () => {
    const id = idOf("store_no = '1001'")
    const real = db.d1.prepare.bind(db.d1)
    ;(db.d1 as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
      if (sql.startsWith('UPDATE transactions SET')) db.exec(`UPDATE transactions SET note = 'raced', updated_at = '2030-01-01T00:00:00.000Z' WHERE id = '${id}'`)
      return real(sql)
    }
    const res = await patch(id, { categoryId: 'gifts', expectedUpdatedAt: SEED_STAMP })
    expect(res.status).toBe(409)
    expect((await json<{ current: Txn }>(res)).current).toMatchObject({ note: 'raced', categoryId: 'fuel' })
    expect(db.all('SELECT * FROM category_edits')).toEqual([])
  })

  it('two writes in the same millisecond still get distinct stamps', async () => {
    const id = idOf("store_no = '1001'")
    db.exec(`UPDATE transactions SET updated_at = '2999-01-01T00:00:00.000Z' WHERE id = '${id}'`)
    const a = await json<TxnPatchResponse>(await patch(id, { categoryId: 'gifts', expectedUpdatedAt: '2999-01-01T00:00:00.000Z' }))
    expect(a.txn.updatedAt).toBe('2999-01-01T00:00:00.001Z')
  })

  it('404 for an unknown or malformed id', async () => {
    for (const id of ['f'.repeat(32), 'nope', "x'--", '../etc']) {
      const res = await patch(id, { categoryId: 'fuel', expectedUpdatedAt: SEED_STAMP })
      expect(res.status, id).toBe(404)
      expect((await json<{ error: string }>(res)).error).toBe('not_found')
    }
  })

  it('400 bad_request for every invalid body, naming the field; nothing is written', async () => {
    const id = idOf("store_no = '1001'")
    const before = row(id)
    const cases: Array<[unknown, string]> = [
      [{ categoryId: 'fuel' }, 'expectedUpdatedAt'],
      [{ categoryId: 'fuel', expectedUpdatedAt: 5 }, 'expectedUpdatedAt'],
      [{ expectedUpdatedAt: SEED_STAMP }, 'body'],
      [{ categoryId: 'nonesuch', expectedUpdatedAt: SEED_STAMP }, 'categoryId'],
      [{ categoryId: 7, expectedUpdatedAt: SEED_STAMP }, 'categoryId'],
      [{ kind: 'bogus', expectedUpdatedAt: SEED_STAMP }, 'kind'],
      [{ note: 5, expectedUpdatedAt: SEED_STAMP }, 'note'],
      [{ note: 'x'.repeat(501), expectedUpdatedAt: SEED_STAMP }, 'note'],
    ]
    for (const [body, field] of cases) {
      const res = await patch(id, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      const b = await json<{ error: string; message: string }>(res)
      expect(b.error).toBe('bad_request')
      expect(b.message.startsWith(field), b.message).toBe(true)
    }
    for (const rawBody of ['{bad json', '[]', '"s"']) expect((await patch(id, null, { rawBody })).status).toBe(400)
    expect(row(id)).toEqual(before)
  })

  it('413 for a body over 4 KB', async () => {
    const id = idOf("store_no = '1001'")
    const res = await patch(id, { note: 'x'.repeat(5000), expectedUpdatedAt: SEED_STAMP })
    expect(res.status).toBe(413)
    expect((await json<{ error: string }>(res)).error).toBe('too_large')
  })

  it('a hostile id or note is bound, never run as SQL', async () => {
    const id = insertTxn(db, {})
    const { txn } = await json<TxnPatchResponse>(await patch(id, { note: "'); DROP TABLE transactions; --", expectedUpdatedAt: SEED_STAMP }))
    expect(txn.note).toBe("'); DROP TABLE transactions; --")
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM transactions')!.n).toBeGreaterThan(20)
  })

  it('all-or-nothing: a failing batch leaves the row and the audit table untouched', async () => {
    const id = idOf("store_no = '1001'")
    const before = row(id)
    db.failNextBatch()
    const res = await patch(id, { categoryId: 'gifts', expectedUpdatedAt: SEED_STAMP })
    expect(res.status).toBe(500)
    expect(row(id)).toEqual(before)
    expect(db.all('SELECT * FROM category_edits')).toEqual([])
  })

  it('PATCH only (405 with Allow for the rest); 403 without identity', async () => {
    const id = idOf("store_no = '1001'")
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const res = await callRoute(onRequest, db, `/api/budget/transactions/${id}`, { method, params: { id }, body: {} })
      expect(res.status, method).toBe(405)
      expect(res.headers.get('Allow')).toBe('PATCH')
    }
    expect((await patch(id, { categoryId: 'fuel', expectedUpdatedAt: SEED_STAMP }, { email: null })).status).toBe(403)
    expect(row(id).category_id).toBe('fuel')
  })

  it('included: false excludes (stamped manual edit, audited), true restores; category, kind and review are untouched', async () => {
    const id = idOf("store_no = '9999'")
    const b = row(id)
    expect(b.included).toBe(1)
    const off = await json<TxnPatchResponse>(await patch(id, { included: false, expectedUpdatedAt: SEED_STAMP }))
    expect(off.txn).toMatchObject({ included: false, kind: 'spend', categoryId: b.category_id, needsReview: true, updatedBy: 'user-a@example.com' })
    expect(row(id)).toMatchObject({ included: 0, kind: b.kind, kind_source: b.kind_source, category_source: b.category_source, needs_review: 1, updated_by: 'user-a@example.com' })
    const on = await json<TxnPatchResponse>(await patch(id, { included: true, expectedUpdatedAt: off.txn.updatedAt }))
    expect(on.txn).toMatchObject({ included: true, kind: b.kind, categoryId: b.category_id })
    expect(db.all('SELECT old_included, new_included, old_kind, new_kind, edited_by FROM category_edits ORDER BY id')).toEqual([
      { old_included: 1, new_included: 0, old_kind: 'spend', new_kind: 'spend', edited_by: 'user-a@example.com' },
      { old_included: 0, new_included: 1, old_kind: 'spend', new_kind: 'spend', edited_by: 'user-a@example.com' },
    ])
    // a category edit leaves the included flag alone and audits NULLs
    await patch(id, { categoryId: 'fuel', expectedUpdatedAt: on.txn.updatedAt })
    expect(db.all('SELECT old_included, new_included FROM category_edits ORDER BY id DESC LIMIT 1')).toEqual([{ old_included: null, new_included: null }])
  })

  it('included equal to the current value changes nothing: no stamp bump, no audit row', async () => {
    const id = idOf("store_no = '9999'")
    const same = await json<TxnPatchResponse>(await patch(id, { included: true, expectedUpdatedAt: SEED_STAMP }))
    expect(same.txn).toMatchObject({ included: true, updatedAt: SEED_STAMP })
    expect(row(id).updated_at).toBe(SEED_STAMP)
    expect(db.all('SELECT id FROM category_edits')).toEqual([])
  })

  it('included must be a boolean; a stale stamp is a 409 and writes nothing', async () => {
    const id = idOf("store_no = '1001'")
    for (const v of ['no', 0, null]) expect((await patch(id, { included: v, expectedUpdatedAt: SEED_STAMP })).status, String(v)).toBe(400)
    expect((await patch(id, { included: false, expectedUpdatedAt: 'stale' })).status).toBe(409)
    expect(row(id).included).toBe(1)
    expect(db.all('SELECT * FROM category_edits')).toEqual([])
  })

  it('included: 403 without identity changes nothing; 405 with Allow for the other methods', async () => {
    const id = idOf("store_no = '1001'")
    expect((await patch(id, { included: false, expectedUpdatedAt: SEED_STAMP }, { email: null })).status).toBe(403)
    expect(row(id).included).toBe(1)
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const res = await callRoute(onRequest, db, `/api/budget/transactions/${id}`, { method, params: { id }, body: {} })
      expect(res.status, method).toBe(405)
      expect(res.headers.get('Allow')).toBe('PATCH')
    }
  })

  it('an exclusion survives a rule apply and a re-import of the same load', async () => {
    const id = idOf("store_no = '2002'")
    await patch(id, { included: false, expectedUpdatedAt: SEED_STAMP })
    const { applyRules } = await import('../../../_lib/budgetDb')
    await applyRules(db.d1, ['chain-x'], 'user-b@example.com')
    const { syntheticSeedSql } = await import('../../../_lib/testing/budgetDb')
    db.exec(await syntheticSeedSql())
    expect(row(id).included).toBe(0)
    expect(String(row(id).updated_by)).toContain('@')
  })

  it('a manual edit survives a later rule apply and a re-import of the same load', async () => {
    const id = idOf("store_no = '2002'")
    await patch(id, { categoryId: 'gifts', expectedUpdatedAt: SEED_STAMP })
    const { applyRules } = await import('../../../_lib/budgetDb')
    await applyRules(db.d1, ['chain-x'], 'user-b@example.com')
    expect(row(id)).toMatchObject({ category_id: 'gifts', category_source: 'manual' })
    const { syntheticSeedSql } = await import('../../../_lib/testing/budgetDb')
    db.exec(await syntheticSeedSql())
    expect(row(id)).toMatchObject({ category_id: 'gifts', category_source: 'manual' })
  })
})
