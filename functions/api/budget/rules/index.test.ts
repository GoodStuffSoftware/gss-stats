// POST /api/budget/rules on the node:sqlite D1 fake (synthetic data): a manual edit becomes a merchant rule.
import { beforeEach, describe, expect, it } from 'vitest'
import type { RuleResponse, TxnPatchResponse } from '../../../../src/lib/budget/types'
import { callRoute, createBudgetDb, insertTxn, json, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import { onRequest as patchRoute } from '../transactions/[id]'
import { onRequest } from './index'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })

const post = (body: unknown, over: { rawBody?: string; email?: string | null; method?: string } = {}) =>
  callRoute(onRequest, db, '/api/budget/rules', { method: 'POST', body, ...over })
const row = (id: string) => db.get<Record<string, unknown>>('SELECT * FROM transactions WHERE id = ?', id)!
const shop = { merchant_key: 'gadget-hut', merchant_name: 'Gadget Hut' }
const manualRow = (over: Record<string, unknown> = {}) => insertTxn(db, { ...shop, category_id: 'shopping', category_source: 'manual', ...over })
const autoRow = (over: Record<string, unknown> = {}) => insertTxn(db, { ...shop, needs_review: 1, review_reason: 'low_confidence', ...over })

describe('POST /api/budget/rules', () => {
  it('turns a manual edit into a merchant rule and reapplies it to the non-manual rows of that merchant', async () => {
    const taught = manualRow()
    const a = autoRow()
    const b = autoRow({ account_id: 'card-a', posted_date: '2026-11-20' })
    const otherManual = manualRow({ category_id: 'gifts' })
    const otherMerchant = insertTxn(db, { merchant_key: 'elsewhere', merchant_name: 'Elsewhere' })
    const res = await post({ txnId: taught, scope: 'merchant' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await json<RuleResponse>(res)
    expect(body.reapplied).toBe(2)
    expect(body.rule).toMatchObject({
      merchantKey: 'gadget-hut', storeNo: null, accountId: null, amountMinCents: null, amountMaxCents: null, setCategoryId: 'shopping', setKind: null,
      debtAccountId: null, displayName: null, confidence: 90, review: false, reviewReason: null, source: 'edit', active: true,
    })
    expect(body.rule.id).toMatch(/^r[0-9a-f]{16}$/)
    for (const id of [a, b]) expect(row(id)).toMatchObject({ category_id: 'shopping', category_source: 'rule', rule_id: body.rule.id, needs_review: 0 })
    // manual rows never change; other merchants are not touched
    expect(row(taught)).toMatchObject({ category_id: 'shopping', category_source: 'manual', updated_at: '2026-12-05T10:00:00.000Z' })
    expect(row(otherManual)).toMatchObject({ category_id: 'gifts', category_source: 'manual', updated_at: '2026-12-05T10:00:00.000Z' })
    expect(row(otherMerchant)).toMatchObject({ category_id: null, category_source: 'none' })
    const edits = db.all<{ txn_id: string; new_category_id: string; edited_by: string }>('SELECT txn_id, new_category_id, edited_by FROM category_edits ORDER BY txn_id')
    expect(edits.map((e) => e.txn_id).sort()).toEqual([a, b].sort())
    expect(edits.every((e) => e.new_category_id === 'shopping' && e.edited_by === 'user-a@example.com')).toBe(true)
  })

  describe('keys a rule would stretch past one merchant', () => {
    const sharedRow = (name: string, over: Record<string, unknown> = {}) => insertTxn(db, { merchant_key: 'shared-key', merchant_name: name, ...over })
    const ruleCount = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM merchant_rules WHERE source = 'edit'")!.n

    it('refuses with 409 when rows under the key carry more than one display name, and writes nothing', async () => {
      const taught = sharedRow('Merchant One', { category_id: 'shopping', category_source: 'manual', store_no: '5' })
      const other = sharedRow('Merchant Two')
      const res = await post({ txnId: taught, scope: 'merchant' })
      expect(res.status).toBe(409)
      expect((await json<{ error: string; message: string }>(res)).message).toContain('other merchants')
      expect(ruleCount()).toBe(0)
      expect(row(other)).toMatchObject({ category_id: null, category_source: 'none' })
      expect((await post({ txnId: taught, scope: 'merchant_store' })).status).toBe(409)
    })

    it('a key whose rows all carry one display name is still fine', async () => {
      const taught = sharedRow('Merchant One', { category_id: 'shopping', category_source: 'manual' })
      sharedRow('Merchant One')
      expect((await post({ txnId: taught, scope: 'merchant' })).status).toBe(200)
      expect(ruleCount()).toBe(1)
    })

    it.each(['paypal', 'ach-debit-paypal', 'venmo-sam', 'zelle-pat', 'cash-app-lee'])('refuses the payment-service key %s even with one name', async (key) => {
      const taught = insertTxn(db, { merchant_key: key, merchant_name: 'Made Up Merchant', category_id: 'shopping', category_source: 'manual' })
      const res = await post({ txnId: taught, scope: 'merchant' })
      expect(res.status).toBe(409)
      expect((await json<{ message: string }>(res)).message).toContain('payment-service')
      expect(ruleCount()).toBe(0)
    })
  })

  it('scope merchant_store makes a rule for that store only', async () => {
    const taught = manualRow({ store_no: '77' })
    const same = autoRow({ store_no: '77' })
    const otherStore = autoRow({ store_no: '88' })
    const body = await json<RuleResponse>(await post({ txnId: taught, scope: 'merchant_store' }))
    expect(body.rule).toMatchObject({ merchantKey: 'gadget-hut', storeNo: '77', setCategoryId: 'shopping' })
    expect(body.reapplied).toBe(1)
    expect(row(same).category_id).toBe('shopping')
    expect(row(otherStore)).toMatchObject({ category_id: null, category_source: 'none' })
  })

  it('repeating the call upserts the same rule and changes nothing more', async () => {
    const taught = manualRow()
    autoRow()
    const first = await json<RuleResponse>(await post({ txnId: taught, scope: 'merchant' }))
    const second = await json<RuleResponse>(await post({ txnId: taught, scope: 'merchant' }))
    expect(second.rule.id).toBe(first.rule.id)
    expect(second.reapplied).toBe(0)
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM merchant_rules WHERE merchant_key = 'gadget-hut'")!.n).toBe(1)
  })

  it('teaching a different category for the same merchant replaces the rule category (and a rule that was off is on again)', async () => {
    const taught = manualRow()
    const { rule } = await json<RuleResponse>(await post({ txnId: taught, scope: 'merchant' }))
    db.exec(`UPDATE merchant_rules SET active = 0 WHERE id = '${rule.id}'`)
    db.exec(`UPDATE transactions SET category_id = 'gifts' WHERE id = '${taught}'`)
    const again = await json<RuleResponse>(await post({ txnId: taught, scope: 'merchant' }))
    expect(again.rule).toMatchObject({ id: rule.id, setCategoryId: 'gifts', active: true })
  })

  it('refuses to teach a category that was archived after the edit', async () => {
    const taught = manualRow()
    const a = autoRow()
    db.exec("UPDATE categories SET archived = 1 WHERE id = 'shopping'")
    const res = await post({ txnId: taught, scope: 'merchant' })
    expect(res.status).toBe(400)
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM merchant_rules WHERE merchant_key = 'gadget-hut'")!.n).toBe(0)
    expect(row(a)).toMatchObject({ category_id: null, category_source: 'none' })
  })

  it('a kind-only manual edit teaches a kind rule', async () => {
    const taught = insertTxn(db, { ...shop, kind: 'transfer', kind_source: 'manual' })
    const a = autoRow({ account_id: 'card-a' })
    const body = await json<RuleResponse>(await post({ txnId: taught, scope: 'merchant' }))
    expect(body.rule).toMatchObject({ setCategoryId: null, setKind: 'transfer' })
    expect(body.reapplied).toBe(1)
    expect(row(a)).toMatchObject({ kind: 'transfer', kind_source: 'rule' })
  })

  it('a more specific existing rule still wins: the seed store rules keep their rows', async () => {
    // The fixture's store rules give chain-x rows two display names; this test is about rule specificity, so make it one merchant.
    db.sqlite.prepare("UPDATE transactions SET merchant_name = 'Chain X' WHERE merchant_key = 'chain-x'").run()
    const taught = insertTxn(db, { merchant_key: 'chain-x', merchant_name: 'Chain X', store_no: '7777', category_id: 'dining', category_source: 'manual' })
    const unknownStore = insertTxn(db, { merchant_key: 'chain-x', merchant_name: 'Chain X', store_no: '6666', category_id: 'groceries', category_source: 'rule' })
    const specific = "SELECT id, category_id, updated_at FROM transactions WHERE merchant_key = 'chain-x' AND (store_no IN ('1001', '2002') OR (store_no = '3003' AND amount_cents = -9000)) ORDER BY id"
    const before = db.all(specific)
    const rulesBefore = db.get<{ n: number }>('SELECT COUNT(*) n FROM merchant_rules')!.n
    const body = await json<RuleResponse>(await post({ txnId: taught, scope: 'merchant' }))
    // the store-less chain-x seed rule is the one that was taught (same id), so no second rule appears
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM merchant_rules')!.n).toBe(rulesBefore)
    expect(body.rule).toMatchObject({ storeNo: null, setCategoryId: 'dining', review: false, reviewReason: null })
    // the unknown-store rows (this one, a seed row, and the small 3003 purchase outside its band) follow the fallback rule
    expect(body.reapplied).toBe(3)
    expect(row(unknownStore).category_id).toBe('dining')
    expect(db.all(specific)).toEqual(before)
  })

  it('works end to end after a PATCH edit (edit, then "use for all")', async () => {
    const taught = autoRow()
    autoRow()
    const patched = await callRoute(patchRoute, db, `/api/budget/transactions/${taught}`, {
      method: 'PATCH', params: { id: taught }, body: { categoryId: 'shopping', expectedUpdatedAt: '2026-12-05T10:00:00.000Z' },
    })
    expect((await json<TxnPatchResponse>(patched)).txn.categorySource).toBe('manual')
    const body = await json<RuleResponse>(await post({ txnId: taught, scope: 'merchant' }))
    expect(body.reapplied).toBe(1)
    expect(body.rule.setCategoryId).toBe('shopping')
  })

  it('400 for a missing or invalid body, a row with nothing manual to learn from, no merchant, no store', async () => {
    const auto = autoRow()
    const noMerchant = insertTxn(db, { merchant_key: '', category_id: 'shopping', category_source: 'manual' })
    const noStore = manualRow()
    const bad = async (body: unknown, field: string) => {
      const res = await post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      const b = await json<{ error: string; message: string }>(res)
      expect(b.error).toBe('bad_request')
      expect(b.message.startsWith(field), b.message).toBe(true)
    }
    await bad({ scope: 'merchant' }, 'txnId')
    await bad({ txnId: '', scope: 'merchant' }, 'txnId')
    await bad({ txnId: 5, scope: 'merchant' }, 'txnId')
    await bad({ txnId: auto }, 'scope')
    await bad({ txnId: auto, scope: 'everything' }, 'scope')
    await bad({ txnId: auto, scope: 'merchant' }, 'txnId') // not manual: nothing to learn
    await bad({ txnId: noMerchant, scope: 'merchant' }, 'txnId')
    await bad({ txnId: noStore, scope: 'merchant_store' }, 'scope')
    for (const rawBody of ['{nope', '[]', '']) expect((await post(null, { rawBody })).status).toBe(400)
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM merchant_rules WHERE merchant_key = 'gadget-hut'")!.n).toBe(0)
  })

  it('a seed rule row (category from a rule, not from you) is not "manual": nothing to learn', async () => {
    const id = db.get<{ id: string }>("SELECT id FROM transactions WHERE store_no = '1001'")!.id
    expect((await post({ txnId: id, scope: 'merchant' })).status).toBe(400)
  })

  it('404 for an unknown or malformed transaction id', async () => {
    for (const txnId of ['a'.repeat(32), 'nope', "x'; --"]) {
      const res = await post({ txnId, scope: 'merchant' })
      expect(res.status, txnId).toBe(404)
      expect((await json<{ error: string }>(res)).error).toBe('not_found')
    }
  })

  it('413 over 1 KB', async () => {
    const res = await post({ txnId: manualRow(), scope: 'merchant', junk: 'x'.repeat(2000) })
    expect(res.status).toBe(413)
    expect((await json<{ error: string }>(res)).error).toBe('too_large')
  })

  it('POST only (405 with Allow); 403 without identity', async () => {
    const id = manualRow()
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const res = await callRoute(onRequest, db, '/api/budget/rules', { method, body: method === 'GET' ? undefined : { txnId: id, scope: 'merchant' } })
      expect(res.status, method).toBe(405)
      expect(res.headers.get('Allow')).toBe('POST')
    }
    expect((await post({ txnId: id, scope: 'merchant' }, { email: null })).status).toBe(403)
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM merchant_rules WHERE merchant_key = 'gadget-hut'")!.n).toBe(0)
  })
})
