// GET/POST /api/budget/transactions/similar on the node:sqlite D1 fake (made-up merchants only).
import { beforeEach, describe, expect, it } from 'vitest'
import type { SimilarApplyResponse, SimilarResponse } from '../../../../src/lib/budget/types'
import { callRoute, createBudgetDb, insertTxn, json, TEST_EMAIL, type FakeBudgetDb, type TxnSeed } from '../../../_lib/testing/budgetDb'
import { onRequest } from './similar'
import { onRequest as patchRoute } from './[id]'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })

const STAMP = '2026-12-05T10:00:00.000Z'
const get = (id: string, over: { email?: string | null; method?: string } = {}) =>
  callRoute(onRequest, db, '/api/budget/transactions/similar', { query: { id }, ...over })
const post = (body: unknown, over: { email?: string | null; rawBody?: string; method?: string } = {}) =>
  callRoute(onRequest, db, '/api/budget/transactions/similar', { method: 'POST', body, ...over })
const row = (id: string) => db.get<Record<string, unknown>>('SELECT * FROM transactions WHERE id = ?', id)!
const edits = (id: string) => db.all<Record<string, unknown>>('SELECT * FROM category_edits WHERE txn_id = ?', id)
const shop = (o: TxnSeed = {}) => insertTxn(db, { merchant_key: 'acme-hardware', merchant_name: 'Acme Hardware', category_id: 'shopping', category_source: 'rule', ...o })
const item = (id: string) => ({ id, expectedUpdatedAt: STAMP })
/** An ordinary merchant: the source (already in 'fuel', as after the PATCH) and three others in 'shopping' on different months. */
function ordinary() {
  const src = shop({ category_id: 'fuel', category_source: 'manual', posted_date: '2026-11-01' })
  const a = shop({ posted_date: '2026-09-03', amount_cents: -1200 })
  const b = shop({ posted_date: '2026-10-03', amount_cents: -1300 })
  const c = shop({ posted_date: '2026-12-01', amount_cents: -1400 })
  return { src, a, b, c }
}

describe('access', () => {
  it('403 without identity for every method; 405 + Allow for the others', async () => {
    const { src } = ordinary()
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await callRoute(onRequest, db, '/api/budget/transactions/similar', { method, query: { id: src }, body: method === 'POST' ? { sourceId: src } : undefined, email: null })
      expect(res.status, method).toBe(403)
    }
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await callRoute(onRequest, db, '/api/budget/transactions/similar', { method, query: { id: src } })
      expect(res.status, method).toBe(405)
      expect(res.headers.get('Allow')).toBe('GET, POST, HEAD')
    }
    expect(db.all('SELECT * FROM category_edits')).toEqual([])
  })
})

describe('GET', () => {
  it('lists the merchant\'s other rows from every month, newest first, as one statement, with no merchant text in the URL', async () => {
    const { src, a, b, c } = ordinary()
    shop({ category_id: 'fuel' }) // already in the target category: excluded
    insertTxn(db, { merchant_key: 'other-store', merchant_name: 'Other Store' }) // another merchant
    const before = db.statements.length
    const res = await get(src)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await json<SimilarResponse>(res)
    expect(db.statements.length - before).toBe(1)
    expect(body.rows.map((r) => r.id)).toEqual([c, b, a])
    expect(body).toMatchObject({ mixed: false, mixedReasons: [], truncated: false, ruleOffer: { allowed: true }, source: { id: src, merchantKey: 'acme-hardware', categoryId: 'fuel' } })
    expect(body.rows[0]).toMatchObject({ personSet: false, scriptSet: false, suggestTick: true, categoryId: 'shopping', sameAmount: false })
  })

  it('bad input is 400, an unknown id is 404, an empty merchant key has no rows', async () => {
    for (const id of ['', 'x', 'A'.repeat(32), '../etc', 'a'.repeat(31)]) expect((await get(id)).status, id).toBe(400)
    expect((await callRoute(onRequest, db, '/api/budget/transactions/similar')).status).toBe(400)
    expect((await get('f'.repeat(32))).status).toBe(404)
    const blank = insertTxn(db, { merchant_key: '', merchant_name: '' })
    insertTxn(db, { merchant_key: '', merchant_name: '' })
    const body = await json<SimilarResponse>(await get(blank))
    expect(body.rows).toEqual([])
  })

  it('mixed by several categories, by two display names, by a payment-service key; same-amount flag', async () => {
    const m1 = shop({ category_id: 'fuel', merchant_key: 'megamart', merchant_name: 'Megamart', amount_cents: -2399 })
    shop({ merchant_key: 'megamart', merchant_name: 'Megamart', category_id: 'shopping', amount_cents: -2399 })
    shop({ merchant_key: 'megamart', merchant_name: 'Megamart', category_id: 'dining', amount_cents: -500 })
    const many = await json<SimilarResponse>(await get(m1))
    expect(many).toMatchObject({ mixed: true, mixedReasons: ['many_categories'], ruleOffer: { allowed: false } })
    expect(many.rows.map((r) => r.sameAmount).sort()).toEqual([false, true])

    const n1 = shop({ merchant_key: 'shared-key', merchant_name: 'Name One', category_id: 'fuel' })
    shop({ merchant_key: 'shared-key', merchant_name: 'Name Two' })
    expect((await json<SimilarResponse>(await get(n1))).mixedReasons).toEqual(['shared_name'])

    const p1 = shop({ merchant_key: 'paypal-someone', merchant_name: 'Someone', category_id: 'fuel' })
    shop({ merchant_key: 'paypal-someone', merchant_name: 'Someone' })
    expect((await json<SimilarResponse>(await get(p1))).mixedReasons).toEqual(['payment_service'])
  })

  it('a non-spending source gets only rows of its own kind', async () => {
    const t1 = insertTxn(db, { merchant_key: 'transfer-x', kind: 'transfer', category_id: 'fuel' })
    const t2 = insertTxn(db, { merchant_key: 'transfer-x', kind: 'transfer' })
    insertTxn(db, { merchant_key: 'transfer-x', kind: 'spend' })
    expect((await json<SimilarResponse>(await get(t1))).rows.map((r) => r.id)).toEqual([t2])
  })

  it('a spending source also gets refunds and fees, not transfers', async () => {
    const s = shop({ category_id: 'fuel' })
    const refund = shop({ kind: 'refund', amount_cents: 500 })
    shop({ kind: 'transfer' })
    expect((await json<SimilarResponse>(await get(s))).rows.map((r) => r.id)).toEqual([refund])
  })

  it('caps at 300 and says truncated', async () => {
    const src = shop({ category_id: 'fuel' })
    db.exec('BEGIN')
    for (let i = 0; i < 305; i++) shop({ posted_date: `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}` })
    db.exec('COMMIT')
    const body = await json<SimilarResponse>(await get(src))
    expect(body.rows).toHaveLength(300)
    expect(body.truncated).toBe(true)
  })

  it('a person-edited row is never suggested; a script-set row is unticked on a mixed merchant only; a rule-moved row stays ticked', async () => {
    const src = shop({ category_id: 'fuel', category_source: 'manual' })
    // 1. set through the real PATCH by a person
    const byPerson = shop()
    const pr = await callRoute(patchRoute, db, `/api/budget/transactions/${byPerson}`, { method: 'PATCH', params: { id: byPerson }, body: { categoryId: 'shopping', expectedUpdatedAt: STAMP } })
    expect(pr.status).toBe(200)
    // 2. a note-only PATCH by a person on a script-manual row
    const scripted = shop({ category_source: 'manual' })
    db.exec(`UPDATE transactions SET updated_by = 'fix-script' WHERE id = '${scripted}'`)
    // 3. a rule re-apply stamped the editor's address on a rule-sourced row
    const ruled = shop({ category_source: 'rule' })
    db.exec(`INSERT INTO category_edits (txn_id, old_category_id, new_category_id, old_kind, new_kind, edited_at, edited_by) VALUES ('${ruled}', 'fuel', 'shopping', 'spend', 'spend', '${STAMP}', '${TEST_EMAIL}')`)
    const body = await json<SimilarResponse>(await get(src))
    const by = new Map(body.rows.map((r) => [r.id, r]))
    expect(by.get(byPerson)).toMatchObject({ personSet: true, scriptSet: false, suggestTick: false })
    expect(by.get(scripted)).toMatchObject({ personSet: false, scriptSet: true, suggestTick: true }) // ordinary merchant
    expect(by.get(ruled)).toMatchObject({ personSet: false, scriptSet: false, suggestTick: true })

    // a person's later edit on the script row (an '@' audit row, new category differs) makes it personSet
    db.exec(`INSERT INTO category_edits (txn_id, old_category_id, new_category_id, old_kind, new_kind, edited_at, edited_by) VALUES ('${scripted}', 'fuel', 'shopping', 'spend', 'spend', '${STAMP}', '${TEST_EMAIL}')`)
    expect((await json<SimilarResponse>(await get(src))).rows.find((r) => r.id === scripted)).toMatchObject({ personSet: true, suggestTick: false })
  })

  it('the receipt-script row on a mixed merchant is shown unticked', async () => {
    const src = shop({ merchant_key: 'megamart', merchant_name: 'Megamart', category_id: 'fuel', category_source: 'manual' })
    const scripted = shop({ merchant_key: 'megamart', merchant_name: 'Megamart', category_source: 'manual' })
    db.exec(`UPDATE transactions SET updated_by = 'receipt-script' WHERE id = '${scripted}'`)
    const plain = shop({ merchant_key: 'megamart', merchant_name: 'Megamart', category_id: 'dining' })
    shop({ merchant_key: 'megamart', merchant_name: 'Megamart', category_id: 'travel' })
    const body = await json<SimilarResponse>(await get(src))
    expect(body.mixed).toBe(true)
    expect(body.rows.find((r) => r.id === scripted)).toMatchObject({ scriptSet: true, personSet: false, suggestTick: false })
    expect(body.rows.find((r) => r.id === plain)!.suggestTick).toBe(true)
  })

  it('uses the merchant and audit indexes', async () => {
    const { src } = ordinary()
    const plan = db.explain((await import('../../../_lib/budgetDb')).SIMILAR_SQL, [src]).join('\n')
    expect(plan).toMatch(/idx_txn_merchant/)
    expect(plan).toMatch(/idx_edits_txn/)
    expect(plan).not.toMatch(/SCAN t\b/)
  })
})

describe('POST', () => {
  it('changes the ticked rows: manual, editor, one audit row each under the signed-in person; unlisted rows untouched', async () => {
    const { src, a, b, c } = ordinary()
    const res = await post({ sourceId: src, categoryId: 'fuel', items: [item(a), item(b)] })
    expect(res.status).toBe(200)
    const body = await json<SimilarApplyResponse>(res)
    expect(body.conflicts).toEqual([])
    expect(body.changed.map((x) => x.id)).toEqual([a, b])
    for (const id of [a, b]) {
      expect(row(id)).toMatchObject({ category_id: 'fuel', category_source: 'manual', updated_by: TEST_EMAIL, rule_id: null, needs_review: 0 })
      expect(String(row(id).updated_at) > STAMP).toBe(true)
      expect(edits(id)).toEqual([expect.objectContaining({ old_category_id: 'shopping', new_category_id: 'fuel', old_kind: 'spend', new_kind: 'spend', edited_by: TEST_EMAIL, edited_at: row(id).updated_at })])
    }
    expect(row(c)).toMatchObject({ category_id: 'shopping', category_source: 'rule' })
    expect(edits(c)).toEqual([])
    expect(db.all("SELECT * FROM merchant_rules WHERE source = 'edit'")).toEqual([])
  })

  it('a stale row is a conflict (with its current state), unwritten and unaudited; the rest still land', async () => {
    const { src, a, b, c } = ordinary()
    db.exec(`UPDATE transactions SET updated_at = '2026-12-06T00:00:00.000Z' WHERE id = '${b}'`)
    const body = await json<SimilarApplyResponse>(await post({ sourceId: src, categoryId: 'fuel', items: [item(a), item(b), item(c)] }))
    expect(body.changed.map((x) => x.id)).toEqual([a, c])
    expect(body.conflicts).toHaveLength(1)
    expect(body.conflicts[0]).toMatchObject({ id: b, current: { id: b, categoryId: 'shopping', updatedAt: '2026-12-06T00:00:00.000Z' } })
    expect(row(b).category_id).toBe('shopping')
    expect(edits(b)).toEqual([])
    expect(edits(a)).toHaveLength(1)
  })

  it('an id from another merchant (or an unknown id) is a conflict and is never written', async () => {
    const { src, a } = ordinary()
    const other = insertTxn(db, { merchant_key: 'other-store', merchant_name: 'Other Store', category_id: 'shopping' })
    const body = await json<SimilarApplyResponse>(await post({ sourceId: src, categoryId: 'fuel', items: [item(a), item(other), item('e'.repeat(32))] }))
    expect(body.changed.map((x) => x.id)).toEqual([a])
    expect(body.conflicts.map((x) => x.id)).toEqual([other, 'e'.repeat(32)])
    expect(body.conflicts[1].current).toBeNull()
    expect(row(other)).toMatchObject({ category_id: 'shopping', category_source: 'none' })
    expect(edits(other)).toEqual([])
  })

  it('a transfer row of the merchant is never given a spending category, and a row already in the category is skipped, not rewritten as manual', async () => {
    const { src, a } = ordinary()
    const xfer = shop({ kind: 'transfer', category_id: null, category_source: 'none' })
    const already = shop({ category_id: 'fuel', category_source: 'rule' })
    const body = await json<SimilarApplyResponse>(await post({ sourceId: src, categoryId: 'fuel', items: [item(a), item(xfer), item(already)] }))
    expect(body.changed.map((x) => x.id)).toEqual([a])
    expect(body.conflicts.map((x) => x.id)).toEqual([xfer, already])
    expect(row(xfer)).toMatchObject({ category_id: null, category_source: 'none', updated_at: STAMP })
    expect(edits(xfer)).toEqual([])
    expect(row(already)).toMatchObject({ category_id: 'fuel', category_source: 'rule', updated_at: STAMP })
    expect(edits(already)).toEqual([])
  })

  it('a non-spending source only reaches rows of its own kind', async () => {
    const t1 = insertTxn(db, { merchant_key: 'transfer-x', kind: 'transfer', category_id: 'fuel' })
    const t2 = insertTxn(db, { merchant_key: 'transfer-x', kind: 'transfer', category_id: null })
    const sp = insertTxn(db, { merchant_key: 'transfer-x', kind: 'spend', category_id: null })
    const body = await json<SimilarApplyResponse>(await post({ sourceId: t1, categoryId: 'fuel', items: [item(t2), item(sp)] }))
    expect(body.changed.map((x) => x.id)).toEqual([t2])
    expect(row(sp).category_id).toBeNull()
  })

  it('a null category (uncategorized) is allowed', async () => {
    const { src, a } = ordinary()
    const body = await json<SimilarApplyResponse>(await post({ sourceId: src, categoryId: null, items: [item(a)] }))
    expect(body.changed).toHaveLength(1)
    expect(row(a)).toMatchObject({ category_id: null, category_source: 'manual' })
  })

  it('strict validation: 400 for bad shapes, 404 for an unknown source, 413 for a large body', async () => {
    const { src, a } = ordinary()
    const bad: unknown[] = [
      { categoryId: 'fuel', items: [item(a)] },
      { sourceId: 'nope', categoryId: 'fuel', items: [item(a)] },
      { sourceId: src, items: [item(a)] },
      { sourceId: src, categoryId: 7, items: [item(a)] },
      { sourceId: src, categoryId: 'no-such-category', items: [item(a)] },
      { sourceId: src, categoryId: 'fuel', items: [] },
      { sourceId: src, categoryId: 'fuel', items: 'x' },
      { sourceId: src, categoryId: 'fuel', items: [item(a), item(a)] },
      { sourceId: src, categoryId: 'fuel', items: [item(src)] },
      { sourceId: src, categoryId: 'fuel', items: [{ id: a }] },
      { sourceId: src, categoryId: 'fuel', items: [{ id: 'zz', expectedUpdatedAt: STAMP }] },
      { sourceId: src, categoryId: 'fuel', items: [{ id: a, expectedUpdatedAt: 'x'.repeat(41) }] },
      { sourceId: src, categoryId: 'fuel', items: [null] },
      { sourceId: src, categoryId: 'fuel', items: Array.from({ length: 301 }, (_, i) => item(i.toString(16).padStart(32, '0'))) },
      { sourceId: src, categoryId: 'fuel', items: [item(a)], makeRule: 'yes' },
      { sourceId: src, categoryId: null, items: [item(a)], makeRule: true },
    ]
    for (const body of bad) expect((await post(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400)
    expect((await post({ sourceId: 'c'.repeat(32), categoryId: 'fuel', items: [item(a)] })).status).toBe(404)
    expect((await post(undefined, { rawBody: 'not json' })).status).toBe(400)
    expect((await post(undefined, { rawBody: '{"x":"' + 'y'.repeat(33_000) + '"}' })).status).toBe(413)
    db.exec("UPDATE categories SET archived = 1 WHERE id = 'travel'")
    expect((await post({ sourceId: src, categoryId: 'travel', items: [item(a)] })).status).toBe(400)
    expect(db.all('SELECT * FROM category_edits')).toEqual([])
  })

  it('the batch is one transaction: a failure leaves no row and no audit row changed', async () => {
    const { src, a, b } = ordinary()
    db.failNextBatch()
    const res = await post({ sourceId: src, categoryId: 'fuel', items: [item(a), item(b)] })
    expect(res.status).toBe(500)
    expect(row(a).category_id).toBe('shopping')
    expect(db.all('SELECT * FROM category_edits')).toEqual([])
  })

  it('makeRule on an ordinary merchant writes one merchant-wide edit rule and re-applies nothing; repeating upserts', async () => {
    const { src, a, b } = ordinary()
    const first = await json<SimilarApplyResponse>(await post({ sourceId: src, categoryId: 'fuel', items: [item(a)], makeRule: true }))
    expect(first.rule).toMatchObject({ created: true })
    const rules = db.all<Record<string, unknown>>("SELECT * FROM merchant_rules WHERE source = 'edit'")
    expect(rules).toEqual([expect.objectContaining({ id: first.rule!.id, merchant_key: 'acme-hardware', store_no: null, set_category_id: 'fuel', source: 'edit', created_by: TEST_EMAIL })])
    expect(row(b)).toMatchObject({ category_id: 'shopping', category_source: 'rule' }) // not ticked: untouched
    const again = await json<SimilarApplyResponse>(await post({ sourceId: src, categoryId: 'fuel', items: [item(b)], makeRule: true }))
    expect(again.rule).toEqual({ id: first.rule!.id, created: false })
    expect(db.all("SELECT * FROM merchant_rules WHERE source = 'edit'")).toHaveLength(1)
  })

  it('makeRule on a mixed merchant is 409 rule_unsafe and nothing is written; a source not in the category is 400', async () => {
    const m = shop({ merchant_key: 'megamart', merchant_name: 'Megamart', category_id: 'fuel' })
    const m2 = shop({ merchant_key: 'megamart', merchant_name: 'Megamart', category_id: 'dining' })
    shop({ merchant_key: 'megamart', merchant_name: 'Megamart', category_id: 'travel' })
    const res = await post({ sourceId: m, categoryId: 'fuel', items: [item(m2)], makeRule: true })
    expect(res.status).toBe(409)
    expect((await json<{ error: string }>(res)).error).toBe('rule_unsafe')
    expect(row(m2).category_id).toBe('dining')
    expect(db.all("SELECT * FROM merchant_rules WHERE source = 'edit'")).toEqual([])
    expect((await post({ sourceId: m, categoryId: 'shopping', items: [item(m2)], makeRule: true })).status).toBe(400)
  })

  it('a re-import keeps the spread (rows are never overwritten by the load)', async () => {
    const { src, a } = ordinary()
    await post({ sourceId: src, categoryId: 'fuel', items: [item(a)] })
    const { renderPlanSql } = await import('../../../../src/lib/budget/sqlFile')
    const { planImport } = await import('../../../../src/lib/budget/import')
    const { emptyContext, syntheticRequest } = await import('../../../../src/lib/budget/__fixtures__/synthetic')
    const plan = await planImport(syntheticRequest('imp-synth-2', true), emptyContext(), 'seed@example.com', '2026-12-07T10:00:00.000Z')
    db.exec(renderPlanSql(plan))
    expect(row(a)).toMatchObject({ category_id: 'fuel', category_source: 'manual' })
  })
})
