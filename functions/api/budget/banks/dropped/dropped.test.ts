// POST /api/budget/banks/dropped/:txnId: Delete removes the row with its edits, receipt matches and bank mapping (an applied
// receipt match puts its receipt back to unmatched through the 0004 trigger); Keep leaves the row and its manual category
// exactly as they were and stops the bank touching it. Only a `dropped` mapping can be settled, once. Made-up rows.
import { beforeEach, describe, expect, it } from 'vitest'
import { callRoute, createBudgetDb, insertTxn, json, TEST_EMAIL, type FakeBudgetDb } from '../../../../_lib/testing/budgetDb'
import { createFakeBanks, seedBankAccount, seedBankItem, seedBankTxn, type FakeBanks } from '../../../../_lib/testing/banksFake'
import { onRequest } from './[txnId]'

const OTHER = 'user-b@example.com'
const NOW = '2026-11-20T10:00:00.000Z'
let db: FakeBudgetDb
let banks: FakeBanks
let dropped: string
beforeEach(async () => {
  db = await createBudgetDb()
  banks = createFakeBanks()
  seedBankItem(db)
  seedBankAccount(db, { sync: 'on', accountId: 'chk-a' })
  // A row the bank removed after a person edited it: manual category, an edit on record, an applied receipt match.
  dropped = insertTxn(db, { account_id: 'chk-a', posted_date: '2026-11-18', category_id: 'groceries', category_source: 'manual', description: 'DROPPED SHOP' })
  seedBankTxn(db, { plaidTxnId: 'plaid-txn-001', txnId: dropped, state: 'dropped' })
  db.sqlite.prepare(`INSERT INTO category_edits (txn_id, old_category_id, new_category_id, edited_at, edited_by) VALUES (?, NULL, 'groceries', ?, ?)`).run(dropped, NOW, TEST_EMAIL)
  db.sqlite.prepare(
    `INSERT INTO email_connections (id, owner_email, google_sub, status, token_ct, token_iv, key_id, scopes, consent_version, consented_at, created_at, updated_at)
     VALUES ('c0123456789abcdef', ?, 'sub-1', 'active', 'Q0lQSEVS', 'aXZpdml2aXZpaQ==', '0a1b2c3d', 'gmail.readonly', 1, ?, ?, ?)`,
  ).run(TEST_EMAIL, NOW, NOW, NOW)
  db.sqlite.prepare(
    `INSERT INTO receipts (id, connection_id, gmail_msg_id, email_date, status, kind, merchant, total_cents, created_at, updated_at, updated_by)
     VALUES ('r0000000000000001', 'c0123456789abcdef', 'ab000000001', '2026-11-18', 'applied', 'purchase', 'Invented Shop', 500, ?, ?, 'import:test')`,
  ).run(NOW, NOW)
  db.sqlite.prepare(
    `INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, proposed_category_id, txn_updated_at, created_at)
     VALUES ('r0000000000000001', ?, 'g1', 'exact', 500, 90, 'applied', 'groceries', ?, ?)`,
  ).run(dropped, NOW, NOW)
})

const settle = (id: string, body: unknown, o: { email?: string; bound?: boolean } = {}) =>
  callRoute(onRequest as never, db, `/api/budget/banks/dropped/${id}`, { method: 'POST', params: { txnId: id }, body, email: o.email, env: o.bound === false ? {} : { BANKS: banks.binding } })
const count = (table: string, where = '1=1') => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)!.n

describe('delete', () => {
  it('removes the Budget row with its category edits, receipt match and bank mapping, and returns the receipt to unmatched', async () => {
    expect(count('category_edits', `txn_id = '${dropped}'`)).toBe(1)
    const res = await settle(dropped, { action: 'delete' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true })
    expect(count('transactions', `id = '${dropped}'`)).toBe(0)
    expect(count('category_edits', `txn_id = '${dropped}'`)).toBe(0)
    expect(count('receipt_matches', `txn_id = '${dropped}'`)).toBe(0)
    expect(count('bank_txns', `txn_id = '${dropped}'`)).toBe(0)
    expect(db.get<{ status: string }>("SELECT status FROM receipts WHERE id = 'r0000000000000001'")!.status).toBe('unmatched')
    expect(banks.calls).toEqual([])
  })

  it('a second delete finds nothing and answers 404', async () => {
    expect((await settle(dropped, { action: 'delete' })).status).toBe(200)
    expect((await settle(dropped, { action: 'delete' })).status).toBe(404)
  })

  it('deletes only the one dropped row; every other row (live, kept, ordinary) stays', async () => {
    const live = insertTxn(db, { account_id: 'chk-a' })
    const kept = insertTxn(db, { account_id: 'chk-a' })
    const plain = insertTxn(db, { account_id: 'chk-a' })
    seedBankTxn(db, { plaidTxnId: 'plaid-txn-002', txnId: live })
    seedBankTxn(db, { plaidTxnId: 'plaid-txn-003', txnId: kept, state: 'kept' })
    const before = count('transactions')
    await settle(dropped, { action: 'delete' })
    expect(count('transactions')).toBe(before - 1)
    for (const id of [live, kept, plain]) expect(count('transactions', `id = '${id}'`)).toBe(1)
  })

  it('never deletes a row that is not dropped: live, kept and ordinary rows answer 404 and stay', async () => {
    const live = insertTxn(db, { account_id: 'chk-a' })
    const kept = insertTxn(db, { account_id: 'chk-a' })
    const plain = insertTxn(db, { account_id: 'chk-a' })
    seedBankTxn(db, { plaidTxnId: 'plaid-txn-002', txnId: live })
    seedBankTxn(db, { plaidTxnId: 'plaid-txn-003', txnId: kept, state: 'kept' })
    for (const id of [live, kept, plain]) {
      expect((await settle(id, { action: 'delete' })).status).toBe(404)
      expect(count('transactions', `id = '${id}'`)).toBe(1)
    }
  })
})

describe('keep', () => {
  it('marks the mapping kept and leaves the row, its manual category and its edits exactly as they were', async () => {
    const before = JSON.stringify(db.get('SELECT * FROM transactions WHERE id = ?', dropped))
    const res = await settle(dropped, { action: 'keep' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true })
    expect(db.get<{ state: string }>('SELECT state FROM bank_txns WHERE txn_id = ?', dropped)!.state).toBe('kept')
    expect(JSON.stringify(db.get('SELECT * FROM transactions WHERE id = ?', dropped))).toBe(before)
    expect(db.get<{ category_id: string; category_source: string }>('SELECT category_id, category_source FROM transactions WHERE id = ?', dropped)).toEqual({ category_id: 'groceries', category_source: 'manual' })
    expect(count('category_edits', `txn_id = '${dropped}'`)).toBe(1)
    expect(count('receipt_matches', `txn_id = '${dropped}'`)).toBe(1)
  })

  it('a second keep, or a delete after a keep, answers 404 (the row is no longer waiting)', async () => {
    expect((await settle(dropped, { action: 'keep' })).status).toBe(200)
    expect((await settle(dropped, { action: 'keep' })).status).toBe(404)
    expect((await settle(dropped, { action: 'delete' })).status).toBe(404)
    expect(count('transactions', `id = '${dropped}'`)).toBe(1)
  })

  it('a row that is not dropped answers 404 and its mapping stays live', async () => {
    const live = insertTxn(db, { account_id: 'chk-a' })
    seedBankTxn(db, { plaidTxnId: 'plaid-txn-002', txnId: live })
    expect((await settle(live, { action: 'keep' })).status).toBe(404)
    expect(db.get<{ state: string }>('SELECT state FROM bank_txns WHERE txn_id = ?', live)!.state).toBe('live')
  })
})

describe('refusals', () => {
  it('any listed person may settle a row (like a row edit)', async () => {
    expect((await settle(dropped, { action: 'keep' }, { email: OTHER })).status).toBe(200)
  })

  it('400 for a missing or unknown action, and 404 for a malformed or unknown id', async () => {
    expect((await settle(dropped, {})).status).toBe(400)
    expect((await settle(dropped, { action: 'purge' })).status).toBe(400)
    expect((await settle('not-a-txn-id', { action: 'keep' })).status).toBe(404)
    expect((await settle('f'.repeat(32), { action: 'keep' })).status).toBe(404)
    expect(count('transactions', `id = '${dropped}'`)).toBe(1)
  })

  it('503 banks_not_configured without the binding, and the row is untouched', async () => {
    const res = await settle(dropped, { action: 'delete' }, { bound: false })
    expect(res.status).toBe(503)
    expect((await json(res)).error).toBe('banks_not_configured')
    expect(count('transactions', `id = '${dropped}'`)).toBe(1)
  })
})

describe('query plans', () => {
  it('the delete guard finds its mapping by the unique txn_id index and the cascade children by their indexes', () => {
    const plan = db.explain(
      "DELETE FROM transactions WHERE id = ?1 AND EXISTS (SELECT 1 FROM bank_txns b WHERE b.txn_id = ?1 AND b.state = 'dropped')", [dropped],
    ).join('\n')
    expect(plan).toMatch(/idx_bank_txn_txn/)
    expect(plan).not.toMatch(/SCAN bank_txns/)
  })

  it('the keep update is an index search on txn_id', () => {
    const plan = db.explain("UPDATE bank_txns SET state = 'kept', updated_at = ? WHERE txn_id = ? AND state = 'dropped'", [NOW, dropped]).join('\n')
    expect(plan).toMatch(/idx_bank_txn_txn/)
    expect(plan).not.toMatch(/SCAN bank_txns/)
  })
})
