// GET /api/budget/banks/status: slot math (production pending, done and prior count; failed and sandbox do not; never
// below zero; linkEnabled off at 10), what the page lists (live Items, mine, accounts masked), no secret in the body,
// the dropped list, and the query plans. Made-up rows (example.com), the in-memory D1 stand-in.
import { beforeEach, describe, expect, it } from 'vitest'
import type { BanksStatus } from '../../../../src/lib/budget/types'
import { callRoute, createBudgetDb, insertTxn, json, TEST_EMAIL, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import { createFakeBanks, seedBankAccount, seedBankItem, seedBankTxn, seedSlot, SECRETS, type FakeBanks } from '../../../_lib/testing/banksFake'
import { ACCOUNTS_SQL, DROPPED_SQL, ITEMS_SQL, SLOTS_USED_SQL, MAX_DROPPED, onRequest } from './status'

const OTHER = 'user-b@example.com'
let db: FakeBudgetDb
let banks: FakeBanks
beforeEach(async () => {
  db = await createBudgetDb()
  banks = createFakeBanks()
})

const get = (o: { bound?: boolean; email?: string } = {}) =>
  callRoute(onRequest as never, db, '/api/budget/banks/status', { email: o.email, env: o.bound === false ? {} : { BANKS: banks.binding } })

describe('slot math', () => {
  it('counts production pending, done and prior rows; failed and sandbox rows do not count', async () => {
    for (const s of ['done', 'done', 'done', 'pending', 'pending', 'prior'] as const) seedSlot(db, s)
    for (const s of ['failed', 'failed'] as const) seedSlot(db, s)
    for (const s of ['done', 'pending', 'prior'] as const) seedSlot(db, s, 'sandbox')
    const body = await json<BanksStatus>(await get())
    expect(body.slots).toEqual({ used: 6, limit: 10, left: 4 })
    expect(body.linkEnabled).toBe(true)
    expect(body.configured).toBe(true)
  })

  it('linkEnabled turns off at 10 used and left never goes below 0', async () => {
    for (let i = 0; i < 9; i++) seedSlot(db, 'done')
    expect((await json<BanksStatus>(await get())).linkEnabled).toBe(true)
    seedSlot(db, 'prior')
    let body = await json<BanksStatus>(await get())
    expect(body.slots).toEqual({ used: 10, limit: 10, left: 0 })
    expect(body.linkEnabled).toBe(false)
    seedSlot(db, 'pending')
    body = await json<BanksStatus>(await get())
    expect(body.slots.used).toBe(11)
    expect(body.slots.left).toBe(0)
    expect(body.linkEnabled).toBe(false)
  })

  it('an empty log is 0 used, 10 left', async () => {
    expect((await json<BanksStatus>(await get())).slots).toEqual({ used: 0, limit: 10, left: 10 })
  })

  it('without the BANKS binding: 200, configured false, no link button, the numbers still shown', async () => {
    seedSlot(db, 'done')
    const res = await get({ bound: false })
    expect(res.status).toBe(200)
    const body = await json<BanksStatus>(res)
    expect(body.configured).toBe(false)
    expect(body.linkEnabled).toBe(false)
    expect(body.slots.used).toBe(1)
  })
})

describe('items, accounts and the dropped list', () => {
  function world(): void {
    seedBankItem(db, { id: 'i000000000000a001', owner: TEST_EMAIL, institutionName: 'Pine Ridge Bank', createdAt: '2026-11-01T00:00:00.000Z', syncRequestedAt: '2026-11-02T00:00:00.000Z', lastOkAt: '2026-11-03T00:00:00.000Z' })
    seedBankItem(db, { id: 'i000000000000a002', owner: OTHER, institutionName: 'Cedar Credit Union', status: 'needs_reconnect', lastError: 'item_login_required', createdAt: '2026-11-05T00:00:00.000Z' })
    seedBankItem(db, { id: 'i000000000000a003', owner: OTHER, status: 'revoked', createdAt: '2026-11-06T00:00:00.000Z' })
    seedBankItem(db, { id: 'i000000000000a004', owner: OTHER, status: 'removed', createdAt: '2026-11-07T00:00:00.000Z' })
    seedBankAccount(db, { id: 'b000000000000c001', itemId: 'i000000000000a001', name: 'Everyday Checking', mask: '0042', sync: 'on', accountId: 'chk-a', syncFrom: '2026-11-10', balanceCents: 250050 })
    seedBankAccount(db, { id: 'b000000000000c002', itemId: 'i000000000000a001', name: 'Rainy Day', mask: null, type: 'depository', subtype: 'savings' })
    seedBankAccount(db, { id: 'b000000000000c003', itemId: 'i000000000000a002', name: 'Pine Card', mask: '0099', type: 'credit', subtype: 'credit card' })
    seedBankAccount(db, { id: 'b000000000000c004', itemId: 'i000000000000a004', name: 'Gone Account' })
  }

  it('lists live and revoked Items oldest first, never removed ones, with mine set for the caller', async () => {
    world()
    const body = await json<BanksStatus>(await get())
    expect(body.items.map((i) => i.id)).toEqual(['i000000000000a001', 'i000000000000a002', 'i000000000000a003'])
    expect(body.items.map((i) => i.mine)).toEqual([true, false, false])
    expect(body.items[1]).toMatchObject({ status: 'needs_reconnect', lastError: 'item_login_required', institutionName: 'Cedar Credit Union' })
    expect(body.items[0]).toMatchObject({ syncRequested: true, lastOkAt: '2026-11-03T00:00:00.000Z', newAccounts: false })
    const other = await json<BanksStatus>(await get({ email: OTHER }))
    expect(other.items.map((i) => i.mine)).toEqual([false, true, true])
  })

  it('lists each Item accounts: the last-4 mask, the mapping, sync_from and balances', async () => {
    world()
    const body = await json<BanksStatus>(await get())
    const accts = body.items[0]!.accounts
    expect(accts.map((a) => a.id)).toEqual(['b000000000000c001', 'b000000000000c002'])
    expect(accts[0]).toMatchObject({ name: 'Everyday Checking', mask: '0042', sync: 'on', accountId: 'chk-a', syncFrom: '2026-11-10', balanceCents: 250050, type: 'depository' })
    expect(accts[1]).toMatchObject({ mask: null, sync: 'unmapped', accountId: null, syncFrom: null, balanceCents: null })
    expect(body.items[1]!.accounts.map((a) => a.mask)).toEqual(['0099'])
    for (const a of body.items.flatMap((i) => i.accounts)) expect(a.mask === null || /^\d{4}$/.test(a.mask)).toBe(true)
    expect(JSON.stringify(body)).not.toContain('Gone Account')
  })

  it('no token, cursor, Plaid id, key id or owner address reaches the body', async () => {
    world()
    const text = JSON.stringify(await json(await get()))
    for (const secret of [SECRETS.tokenCt, SECRETS.tokenIv, SECRETS.cursor, SECRETS.plaidItem, SECRETS.plaidAccount, '0a1b2c3d', TEST_EMAIL, OTHER, 'owner@example.com', 'owner_email', 'plaid_item_id', 'sync_cursor', 'token_']) {
      expect(text, secret).not.toContain(secret)
    }
  })

  it('lists the dropped rows newest first, capped, with the Budget ids only', async () => {
    seedBankItem(db)
    seedBankAccount(db, { sync: 'on', accountId: 'chk-a' })
    const a = insertTxn(db, { posted_date: '2026-11-10', description: 'OLD DROP' })
    const b = insertTxn(db, { posted_date: '2026-11-20', description: 'NEW DROP', amount_cents: -1234 })
    const live = insertTxn(db, { posted_date: '2026-11-21', description: 'LIVE ROW' })
    const kept = insertTxn(db, { posted_date: '2026-11-22', description: 'KEPT ROW' })
    seedBankTxn(db, { plaidTxnId: 'plaid-txn-001', txnId: a, state: 'dropped' })
    seedBankTxn(db, { plaidTxnId: 'plaid-txn-002', txnId: b, state: 'dropped' })
    seedBankTxn(db, { plaidTxnId: 'plaid-txn-003', txnId: live })
    seedBankTxn(db, { plaidTxnId: 'plaid-txn-004', txnId: kept, state: 'kept' })
    const body = await json<BanksStatus>(await get())
    expect(body.dropped.map((d) => d.txnId)).toEqual([b, a])
    expect(body.dropped[0]).toEqual({ txnId: b, postedDate: '2026-11-20', amountCents: -1234, description: 'NEW DROP', accountId: 'chk-a' })
    expect(JSON.stringify(body)).not.toContain('plaid-txn-')
    expect(MAX_DROPPED).toBe(200)
  })

  it('an empty database answers empty lists', async () => {
    const body = await json<BanksStatus>(await get())
    expect(body.items).toEqual([])
    expect(body.dropped).toEqual([])
  })

  it('reads only what the page needs: four statements, none touching transactions beyond the dropped join', async () => {
    world()
    db.statements.length = 0
    await get()
    expect(db.statements).toEqual([SLOTS_USED_SQL, ITEMS_SQL, ACCOUNTS_SQL, DROPPED_SQL])
  })
})

describe('query plans', () => {
  const planOf = (sql: string, values: unknown[] = []) => db.explain(sql, values).join('\n')
  beforeEach(() => {
    seedBankItem(db)
    seedBankAccount(db)
  })

  it('the Item list is a bank_items index search by status, not a full scan', () => {
    const plan = planOf(ITEMS_SQL)
    expect(plan).toMatch(/SEARCH bank_items USING (COVERING )?INDEX idx_bank_items_due/)
    expect(plan).not.toMatch(/SCAN bank_items/)
  })

  it('the account list is one json_each driven search on idx_bank_acct_item', () => {
    const plan = planOf(ACCOUNTS_SQL, [JSON.stringify(['i000000000000a001'])])
    expect(plan).toMatch(/SEARCH bank_accounts USING INDEX idx_bank_acct_item/)
    expect(plan).not.toMatch(/SCAN bank_accounts/)
  })

  it('the dropped list uses the partial index idx_bank_txn_dropped and a primary-key lookup of transactions', () => {
    const plan = planOf(DROPPED_SQL)
    expect(plan).toMatch(/idx_bank_txn_dropped/)
    expect(plan).not.toMatch(/SCAN (t|transactions)\b/)
    expect(plan).toMatch(/SEARCH t USING (INTEGER )?PRIMARY KEY|SEARCH t USING INDEX sqlite_autoindex_transactions/)
  })

  it('the slot count scans only the append-only slot log (ten rows by design), never a transactions table', () => {
    const plan = planOf(SLOTS_USED_SQL)
    expect(plan).toMatch(/plaid_slot_log/)
    expect(plan).not.toMatch(/transactions|bank_txns|bank_accounts/)
  })
})
