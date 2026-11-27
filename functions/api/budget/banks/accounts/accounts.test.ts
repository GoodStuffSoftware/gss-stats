// PATCH /api/budget/banks/accounts/:id: turning a feed on (an existing Budget account or a new one), sync_from, the kind
// check, account_taken, already_on, the cursor reset, and turning it off (every row stays). Owner only. D1 only: the
// Worker fake throws on any call. Made-up rows (example.com), the in-memory D1 stand-in.
import { beforeEach, describe, expect, it } from 'vitest'
import { callRoute, createBudgetDb, insertTxn, json, TEST_EMAIL, type FakeBudgetDb } from '../../../../_lib/testing/budgetDb'
import { createFakeBanks, seedBankAccount, seedBankItem, seedBankTxn, SECRETS, type FakeBanks } from '../../../../_lib/testing/banksFake'
import { MAP_SQL, TAKEN_SQL, TARGET_SQL, onRequest } from './[id]'

const ITEM = 'i000000000000a001'
const BA = 'b000000000000c001'
const OTHER = 'user-b@example.com'

let db: FakeBudgetDb
let banks: FakeBanks
beforeEach(async () => {
  db = await createBudgetDb()
  banks = createFakeBanks()
  seedBankItem(db, { id: ITEM, owner: TEST_EMAIL })
  seedBankAccount(db, { id: BA, itemId: ITEM, mask: '0042', type: 'depository', subtype: 'checking' })
})

const patch = (body: unknown, id: string = BA, o: { email?: string; bound?: boolean; rawBody?: string } = {}) =>
  callRoute(onRequest as never, db, `/api/budget/banks/accounts/${id}`, {
    method: 'PATCH', params: { id }, body, rawBody: o.rawBody, email: o.email, env: o.bound === false ? {} : { BANKS: banks.binding },
  })
const bankAcct = (id = BA) => db.get<Record<string, unknown>>('SELECT * FROM bank_accounts WHERE id = ?', id)!
const item = (id = ITEM) => db.get<Record<string, unknown>>('SELECT * FROM bank_items WHERE id = ?', id)!
const txnSnapshot = () => JSON.stringify(db.all('SELECT id, category_id, category_source, kind, updated_at, updated_by FROM transactions ORDER BY id'))
const newestChkA = () => db.get<{ d: string }>("SELECT MAX(posted_date) AS d FROM transactions WHERE account_id = 'chk-a'")!.d

describe('sync on with an existing Budget account', () => {
  it('maps the account, sets sync_from to the day after its newest row, resets the cursor and requests a sync', async () => {
    const newest = newestChkA()
    const expected = db.get<{ d: string }>("SELECT date(?, '+1 day') AS d", newest)!.d
    expect(item().sync_cursor).toBe(SECRETS.cursor)
    const res = await patch({ sync: 'on', accountId: 'chk-a' })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toEqual({ ok: true, accountId: 'chk-a', created: false, syncFrom: expected })
    expect(bankAcct()).toMatchObject({ sync: 'on', account_id: 'chk-a', sync_from: expected })
    expect(item().sync_cursor).toBeNull()
    expect(item().sync_requested_at).not.toBeNull()
    expect(banks.calls).toEqual([])
  })

  it('sync_from is NULL when the Budget account has no rows', async () => {
    db.exec("INSERT INTO accounts (id, label, kind, sort) VALUES ('chk-empty', 'Empty Checking', 'checking', 99)")
    const res = await patch({ sync: 'on', accountId: 'chk-empty' })
    expect(res.status).toBe(200)
    expect((await json(res)).syncFrom).toBeNull()
    expect(bankAcct().sync_from).toBeNull()
  })

  it('the cursor reset touches only this Item', async () => {
    seedBankItem(db, { id: 'i000000000000a002', owner: TEST_EMAIL, plaidItemId: 'plaid-item-other-002', cursor: 'cursor-other-002' })
    await patch({ sync: 'on', accountId: 'chk-a' })
    expect(item('i000000000000a002').sync_cursor).toBe('cursor-other-002')
    expect(item('i000000000000a002').sync_requested_at).toBeNull()
  })

  it('writes no transaction row: manual category edits and every Budget row stay exactly as they were', async () => {
    insertTxn(db, { account_id: 'chk-a', category_id: 'groceries', category_source: 'manual', posted_date: '2026-11-30' })
    const before = txnSnapshot()
    await patch({ sync: 'on', accountId: 'chk-a' })
    expect(txnSnapshot()).toBe(before)
    await patch({ sync: 'off' })
    expect(txnSnapshot()).toBe(before)
  })

  it('409 account_taken when another bank account already feeds that Budget account, and nothing changes', async () => {
    seedBankAccount(db, { id: 'b000000000000c002', itemId: ITEM, sync: 'on', accountId: 'chk-a' })
    const res = await patch({ sync: 'on', accountId: 'chk-a' })
    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('account_taken')
    expect(bankAcct().sync).toBe('unmapped')
    expect(item().sync_cursor).toBe(SECRETS.cursor)
  })

  it('an account whose own feed is off does not block another one (only sync = on counts)', async () => {
    seedBankAccount(db, { id: 'b000000000000c002', itemId: ITEM, sync: 'off', accountId: 'chk-a' })
    expect((await patch({ sync: 'on', accountId: 'chk-a' })).status).toBe(200)
  })

  it.each([
    ['depository', 'card-a'],
    ['depository', 'loan-a'],
    ['credit', 'chk-a'],
    ['credit', 'loan-a'],
    ['loan', 'chk-a'],
    ['loan', 'card-a'],
    ['investment', 'chk-a'],
    ['depository', 'mtg'],
  ])('400 kind_mismatch for a %s bank account onto %s', async (type, target) => {
    db.exec(`UPDATE bank_accounts SET type = '${type}' WHERE id = '${BA}'`)
    const res = await patch({ sync: 'on', accountId: target })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('kind_mismatch')
    expect(bankAcct().sync).toBe('unmapped')
    expect(item().sync_cursor).toBe(SECRETS.cursor)
  })

  it.each([
    ['depository', 'chk-a'],
    ['depository', 'sav-a'],
    ['credit', 'card-a'],
    ['credit', 'loc-a'],
    ['loan', 'loan-a'],
  ])('a %s bank account may feed %s', async (type, target) => {
    db.exec(`UPDATE bank_accounts SET type = '${type}' WHERE id = '${BA}'`)
    expect((await patch({ sync: 'on', accountId: target })).status).toBe(200)
  })

  it('404 for an unknown or archived Budget account', async () => {
    expect((await patch({ sync: 'on', accountId: 'no-such' })).status).toBe(404)
    db.exec("UPDATE accounts SET archived = 1 WHERE id = 'sav-a'")
    expect((await patch({ sync: 'on', accountId: 'sav-a' })).status).toBe(404)
  })

  it('409 already_on when the bank account is already syncing', async () => {
    db.exec(`UPDATE bank_accounts SET sync = 'on', account_id = 'chk-a' WHERE id = '${BA}'`)
    const res = await patch({ sync: 'on', accountId: 'sav-a' })
    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('already_on')
    expect(bankAcct().account_id).toBe('chk-a')
  })

  it('409 item_not_active for a revoked Item', async () => {
    db.exec(`UPDATE bank_items SET status = 'revoked', token_ct = NULL, token_iv = NULL, key_id = NULL, sync_cursor = NULL WHERE id = '${ITEM}'`)
    const res = await patch({ sync: 'on', accountId: 'chk-a' })
    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('item_not_active')
  })

  it('works for a needs_reconnect Item (the token is still held)', async () => {
    db.exec(`UPDATE bank_items SET status = 'needs_reconnect' WHERE id = '${ITEM}'`)
    expect((await patch({ sync: 'on', accountId: 'chk-a' })).status).toBe(200)
  })
})

describe('sync on with a new Budget account', () => {
  it('creates the account with the bank mask as last4, a fresh id and sort at the end, and maps it with sync_from NULL', async () => {
    const maxSort = db.get<{ m: number }>('SELECT MAX(sort) AS m FROM accounts')!.m
    const res = await patch({ sync: 'on', newAccount: { name: '  Pine Ridge Checking  ', kind: 'checking', personId: 'pb' } })
    expect(res.status).toBe(200)
    const body = await json<{ accountId: string; created: boolean; syncFrom: string | null }>(res)
    expect(body.created).toBe(true)
    expect(body.accountId).toMatch(/^bk-[0-9a-f]{12}$/)
    expect(body.syncFrom).toBeNull()
    const a = db.get<Record<string, unknown>>('SELECT * FROM accounts WHERE id = ?', body.accountId)!
    expect(a).toMatchObject({ label: 'Pine Ridge Checking', kind: 'checking', person_id: 'pb', last4: '0042', is_debt: 0, in_spending: 1, archived: 0, sort: maxSort + 10 })
    expect(bankAcct()).toMatchObject({ sync: 'on', account_id: body.accountId, sync_from: null })
    expect(item().sync_cursor).toBeNull()
  })

  it('a credit bank account makes a card (debt, in spending) and a line of credit (debt, not in spending)', async () => {
    db.exec(`UPDATE bank_accounts SET type = 'credit' WHERE id = '${BA}'`)
    const card = await json<{ accountId: string }>(await patch({ sync: 'on', newAccount: { name: 'Pine Card', kind: 'card' } }))
    expect(db.get('SELECT is_debt, in_spending, person_id FROM accounts WHERE id = ?', card.accountId)).toMatchObject({ is_debt: 1, in_spending: 1, person_id: null })
    db.exec(`UPDATE bank_accounts SET sync = 'off', account_id = NULL WHERE id = '${BA}'`)
    const loc = await json<{ accountId: string }>(await patch({ sync: 'on', newAccount: { name: 'Pine Line', kind: 'line_of_credit' } }))
    expect(db.get('SELECT is_debt, in_spending FROM accounts WHERE id = ?', loc.accountId)).toMatchObject({ is_debt: 1, in_spending: 0 })
  })

  it('a kind that does not fit the bank type is 400 kind_mismatch and no Budget account is created', async () => {
    const before = db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')!.n
    const res = await patch({ sync: 'on', newAccount: { name: 'Wrong', kind: 'card' } })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('kind_mismatch')
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')!.n).toBe(before)
    expect(bankAcct().sync).toBe('unmapped')
  })

  it.each([
    ['empty name', { name: '   ', kind: 'checking' }],
    ['name over 40', { name: 'x'.repeat(41), kind: 'checking' }],
    ['no kind', { name: 'Fine' }],
    ['person not a string', { name: 'Fine', kind: 'checking', personId: 7 }],
    ['person with capitals', { name: 'Fine', kind: 'checking', personId: 'PB' }],
    ['no such person', { name: 'Fine', kind: 'checking', personId: 'zz' }],
  ])('400 for %s', async (_n, newAccount) => {
    const res = await patch({ sync: 'on', newAccount })
    expect(res.status).toBe(400)
    expect(bankAcct().sync).toBe('unmapped')
  })

  it('400 when neither or both of accountId and newAccount are sent', async () => {
    expect((await patch({ sync: 'on' })).status).toBe(400)
    expect((await patch({ sync: 'on', accountId: 'chk-a', newAccount: { name: 'X', kind: 'checking' } })).status).toBe(400)
    expect(bankAcct().sync).toBe('unmapped')
  })
})

describe('sync off', () => {
  it('stops the feed and keeps every row (Budget rows, the mapping, the bank txn claims)', async () => {
    const t = insertTxn(db, { account_id: 'chk-a', posted_date: '2026-11-25' })
    db.exec(`UPDATE bank_accounts SET sync = 'on', account_id = 'chk-a' WHERE id = '${BA}'`)
    seedBankTxn(db, { plaidTxnId: 'plaid-txn-001', txnId: t, bankAccountId: BA })
    const txns = db.get<{ n: number }>('SELECT count(*) AS n FROM transactions')!.n
    const res = await patch({ sync: 'off' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true })
    expect(bankAcct()).toMatchObject({ sync: 'off', account_id: 'chk-a' })
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM transactions')!.n).toBe(txns)
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM bank_txns')!.n).toBe(1)
    expect(item().sync_cursor).toBe(SECRETS.cursor)
  })

  it('works on an Item that is no longer active', async () => {
    db.exec(`UPDATE bank_items SET status = 'revoked', token_ct = NULL, token_iv = NULL, key_id = NULL, sync_cursor = NULL WHERE id = '${ITEM}'`)
    expect((await patch({ sync: 'off' })).status).toBe(200)
  })
})

describe('refusals', () => {
  it('404 for an unknown or malformed bank account id', async () => {
    expect((await patch({ sync: 'off' }, 'b000000000000c999')).status).toBe(404)
    expect((await patch({ sync: 'off' }, 'not-an-id')).status).toBe(404)
    expect((await patch({ sync: 'off' }, `${BA}' OR 1=1`)).status).toBe(404)
  })

  it('400 for a bad sync value, a bad body, and a non-object body', async () => {
    expect((await patch({ sync: 'maybe' })).status).toBe(400)
    expect((await patch({})).status).toBe(400)
    expect((await patch(undefined, BA, { rawBody: '[1,2]' })).status).toBe(400)
    expect((await patch(undefined, BA, { rawBody: '{nope' })).status).toBe(400)
  })

  it('403 not_owner for the other listed person (both on and off), nothing changes', async () => {
    for (const body of [{ sync: 'on', accountId: 'chk-a' }, { sync: 'off' }]) {
      const res = await patch(body, BA, { email: OTHER })
      expect(res.status).toBe(403)
      expect((await json(res)).error).toBe('not_owner')
    }
    expect(bankAcct().sync).toBe('unmapped')
  })

  it('503 banks_not_configured without the binding', async () => {
    const res = await patch({ sync: 'off' }, BA, { bound: false })
    expect(res.status).toBe(503)
    expect((await json(res)).error).toBe('banks_not_configured')
  })

  it('no response carries a token, cursor, Plaid id or key id', async () => {
    const texts = [
      JSON.stringify(await json(await patch({ sync: 'on', accountId: 'chk-a' }))),
      JSON.stringify(await json(await patch({ sync: 'on', accountId: 'chk-a' }))),
      JSON.stringify(await json(await patch({ sync: 'off' }))),
      JSON.stringify(await json(await patch({ sync: 'on', accountId: 'card-a' }))),
    ]
    for (const t of texts) {
      for (const s of [SECRETS.tokenCt, SECRETS.tokenIv, SECRETS.cursor, SECRETS.plaidItem, SECRETS.plaidAccount, '0a1b2c3d']) expect(t).not.toContain(s)
    }
  })
})

describe('query plans', () => {
  const plan = (sql: string, values: unknown[]) => db.explain(sql, values).join('\n')

  it('the target read is a primary-key search of the account joined to its Item by primary key', () => {
    const p = plan(TARGET_SQL, [BA])
    expect(p).toMatch(/SEARCH a USING (INTEGER )?PRIMARY KEY|SEARCH a USING INDEX sqlite_autoindex_bank_accounts/)
    expect(p).toMatch(/SEARCH i USING/)
    expect(p).not.toMatch(/SCAN/)
  })

  it('the account_taken probe uses idx_bank_acct_on', () => {
    const p = plan(TAKEN_SQL, ['chk-a', BA])
    expect(p).toMatch(/idx_bank_acct_on/)
    expect(p).not.toMatch(/SCAN bank_accounts/)
  })

  it('the mapping update searches by primary key and the sync_from MAX uses idx_txn_account', () => {
    const p = plan(MAP_SQL, ['chk-a', '2026-11-20T10:00:00.000Z', BA])
    expect(p).toMatch(/idx_txn_account/)
    expect(p).not.toMatch(/SCAN (bank_accounts|transactions)/)
  })
})
