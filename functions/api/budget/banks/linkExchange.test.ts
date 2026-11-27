// POST /api/budget/banks/link-token and /exchange: consent, input checks (no Worker call on a bad request), what the Worker
// is sent, what comes back (the Link token by design, and the Budget item id; never an access token, Plaid item id,
// Plaid account id or cursor), Worker errors passed through as fixed codes, and update mode for the owner only.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRoute, createBudgetDb, json, TEST_EMAIL, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import { createFakeBanks, seedBankAccount, seedBankItem, SECRETS, type FakeBanks } from '../../../_lib/testing/banksFake'
import { onRequest as linkToken } from './link-token'
import { onRequest as exchange } from './exchange'

const ITEM = 'i000000000000a001'
const OTHER = 'user-b@example.com'
const LEAK = ['access-sandbox-secret-9', SECRETS.tokenCt, SECRETS.cursor, SECRETS.plaidItem, SECRETS.plaidAccount, 'plaid_item_id', 'accessToken']

let db: FakeBudgetDb
let banks: FakeBanks
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  db = await createBudgetDb()
  banks = createFakeBanks()
  seedBankItem(db, { id: ITEM, owner: TEST_EMAIL })
  seedBankAccount(db, { id: 'b000000000000c001', itemId: ITEM })
})

const link = (body: unknown, o: { email?: string; bound?: boolean } = {}) =>
  callRoute(linkToken as never, db, '/api/budget/banks/link-token', { method: 'POST', body, email: o.email, env: o.bound === false ? {} : { BANKS: banks.binding } })
const exch = (body: unknown, o: { email?: string } = {}) =>
  callRoute(exchange as never, db, '/api/budget/banks/exchange', { method: 'POST', body, email: o.email, env: { BANKS: banks.binding } })
const noLeak = (v: unknown) => {
  const text = JSON.stringify(v)
  for (const s of LEAK) expect(text, s).not.toContain(s)
}

describe('link-token: a new link', () => {
  beforeEach(() => banks.answer('/link-token', 200, { linkToken: 'link-sandbox-abc123', expiration: '2026-11-27T20:00:00Z', accessToken: 'access-sandbox-secret-9', plaidItemId: SECRETS.plaidItem }))

  it('needs the current consent: missing or old is 400 consent_required with no Worker call', async () => {
    for (const body of [{}, { consent: 0 }, { consent: 2 }, { consent: '1' }, { consent: true }]) {
      const res = await link(body)
      expect(res.status).toBe(400)
      expect((await json(res)).error).toBe('consent_required')
    }
    expect(banks.calls).toEqual([])
  })

  it('sends the Worker the lower-cased owner and the consent version, and returns only the token and expiry', async () => {
    const res = await link({ consent: 1 }, { email: ' User-A@Example.com ' })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toEqual({ linkToken: 'link-sandbox-abc123', expiration: '2026-11-27T20:00:00Z' })
    noLeak(body)
    expect(banks.calls).toEqual([{ path: '/link-token', body: { ownerEmail: 'user-a@example.com', consentVersion: 1 } }])
  })

  it('any listed person may start a new link (they become its owner at exchange)', async () => {
    expect((await link({ consent: 1 }, { email: OTHER })).status).toBe(200)
  })

  it('accountSelection without an itemId is 400 and the Worker is not called', async () => {
    const res = await link({ consent: 1, accountSelection: true })
    expect(res.status).toBe(400)
    expect(banks.calls).toEqual([])
  })

  it.each([
    ['itemId not an id', { consent: 1, itemId: 'nope' }],
    ['itemId wrong type', { consent: 1, itemId: 7 }],
    ['accountSelection not a boolean', { consent: 1, itemId: ITEM, accountSelection: 'yes' }],
  ])('400 for %s, no Worker call', async (_n, body) => {
    expect((await link(body)).status).toBe(400)
    expect(banks.calls).toEqual([])
  })

  it('passes a Worker slots_full through as 409 with its fixed code', async () => {
    banks.answer('/link-token', 409, { code: 'slots_full', detail: 'access-sandbox-secret-9' })
    const res = await link({ consent: 1 })
    expect(res.status).toBe(409)
    const body = await json(res)
    expect(body.error).toBe('slots_full')
    noLeak(body)
  })

  it('502 banks_failed when the Worker answers without a token', async () => {
    banks.answer('/link-token', 200, { expiration: 'x' })
    const res = await link({ consent: 1 })
    expect(res.status).toBe(502)
    expect((await json(res)).error).toBe('banks_failed')
  })
})

describe('link-token: update mode (owner only)', () => {
  beforeEach(() => banks.answer('/link-token', 200, { linkToken: 'link-sandbox-upd456', expiration: '2026-11-27T20:00:00Z' }))

  it('the owner gets a token for their Item (consent is not asked again); the Worker gets the Item id', async () => {
    const res = await link({ itemId: ITEM })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ linkToken: 'link-sandbox-upd456', expiration: '2026-11-27T20:00:00Z' })
    expect(banks.calls).toEqual([{ path: '/link-token', body: { ownerEmail: TEST_EMAIL, consentVersion: 1, itemId: ITEM } }])
  })

  it('accountSelection true with an itemId is forwarded; false is not', async () => {
    await link({ itemId: ITEM, accountSelection: true })
    await link({ itemId: ITEM, accountSelection: false })
    expect(banks.calls[0]!.body.accountSelection).toBe(true)
    expect('accountSelection' in banks.calls[1]!.body).toBe(false)
  })

  it('the other listed person gets 403 not_owner and no Worker call', async () => {
    const res = await link({ itemId: ITEM, accountSelection: true }, { email: OTHER })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('not_owner')
    expect(banks.calls).toEqual([])
  })

  it('404 for an unknown Item; 409 item_not_active for revoked and removed Items', async () => {
    expect((await link({ itemId: 'i000000000000a999' })).status).toBe(404)
    for (const status of ['revoked', 'removed']) {
      db.exec(`UPDATE bank_items SET status = '${status}', token_ct = NULL, token_iv = NULL, key_id = NULL, sync_cursor = NULL WHERE id = '${ITEM}'`)
      const res = await link({ itemId: ITEM })
      expect(res.status).toBe(409)
      expect((await json(res)).error).toBe('item_not_active')
    }
    expect(banks.calls).toEqual([])
  })

  it('works for a needs_reconnect Item (the reconnect case)', async () => {
    db.exec(`UPDATE bank_items SET status = 'needs_reconnect' WHERE id = '${ITEM}'`)
    expect((await link({ itemId: ITEM })).status).toBe(200)
  })

  it('503 banks_not_configured without the binding', async () => {
    const res = await link({ consent: 1 }, { bound: false })
    expect(res.status).toBe(503)
    expect((await json(res)).error).toBe('banks_not_configured')
  })
})

describe('exchange', () => {
  const good = () => ({
    consent: 1,
    publicToken: 'public-sandbox-1a2b3c4d-5e6f',
    institution: { id: 'ins_100001', name: 'Pine Ridge Bank' },
    accounts: [
      { id: 'acc-001', name: 'Everyday Checking', mask: '0042', type: 'depository', subtype: 'checking' },
      { id: 'acc-002', name: 'Pine Card', mask: '0099', type: 'credit', subtype: 'credit card' },
    ],
  })
  beforeEach(() => banks.answer('/exchange', 200, { itemId: 'i000000000000a009', accessToken: 'access-sandbox-secret-9', plaidItemId: SECRETS.plaidItem, accounts: [{ plaidAccountId: SECRETS.plaidAccount }] }))

  it('forwards the checked body with the lower-cased owner and returns only the Budget item id', async () => {
    const res = await exch(good(), { email: 'User-A@Example.com' })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toEqual({ itemId: 'i000000000000a009' })
    noLeak(body)
    expect(banks.calls).toEqual([{
      path: '/exchange',
      body: {
        ownerEmail: 'user-a@example.com', consentVersion: 1, publicToken: 'public-sandbox-1a2b3c4d-5e6f',
        institution: { id: 'ins_100001', name: 'Pine Ridge Bank' }, accounts: good().accounts,
      },
    }])
  })

  it('needs the current consent first (400 consent_required, no Worker call)', async () => {
    const res = await exch({ ...good(), consent: undefined })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('consent_required')
    expect(banks.calls).toEqual([])
  })

  it.each([
    ['no public token', { publicToken: undefined }],
    ['access token in place of a public token', { publicToken: 'access-sandbox-secret-9' }],
    ['public token with a space', { publicToken: 'public-sandbox-abc def' }],
    ['institution not an object', { institution: 'Pine Ridge' }],
    ['institution id with a bad character', { institution: { id: 'ins 1', name: 'X' } }],
    ['institution name too long', { institution: { id: 'ins_1', name: 'x'.repeat(121) } }],
    ['accounts missing', { accounts: undefined }],
    ['accounts not a list', { accounts: {} }],
    ['an account without an id', { accounts: [{ name: 'No Id' }] }],
    ['an account id with a bad character', { accounts: [{ id: 'acc 1' }] }],
    ['an account mask over 16 characters', { accounts: [{ id: 'acc-1', mask: 'x'.repeat(17) }] }],
    ['more than 50 accounts', { accounts: Array.from({ length: 51 }, (_v, i) => ({ id: `acc-${i}` })) }],
  ])('400 for %s, with no Worker call', async (_n, over) => {
    const res = await exch({ ...good(), ...over })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('bad_request')
    expect(banks.calls).toEqual([])
  })

  it.each([['duplicate_item', 409], ['slots_full', 409], ['exchange_failed', 502]])('passes a Worker %s (%i) through with its fixed code only', async (code, status) => {
    banks.answer('/exchange', status, { code, accessToken: 'access-sandbox-secret-9' })
    const res = await exch(good())
    expect(res.status).toBe(status)
    const body = await json(res)
    expect(body.error).toBe(code)
    noLeak(body)
  })

  it('a Worker answer whose itemId is not a Budget item id is 502 banks_failed and nothing from it reaches the browser', async () => {
    banks.answer('/exchange', 200, { itemId: SECRETS.plaidItem })
    const res = await exch(good())
    expect(res.status).toBe(502)
    const body = await json(res)
    expect(body.error).toBe('banks_failed')
    noLeak(body)
  })

  it('a Worker code that is not a plain lower-case code becomes banks_failed (no free text reaches the browser)', async () => {
    banks.answer('/exchange', 400, { code: 'Bad Code: access-sandbox-secret-9' })
    const res = await exch(good())
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.error).toBe('banks_failed')
    noLeak(body)
  })

  it('502 banks_failed when the Worker answers 200 without an item id', async () => {
    banks.answer('/exchange', 200, { ok: true })
    const res = await exch(good())
    expect(res.status).toBe(502)
    expect((await json(res)).error).toBe('banks_failed')
  })

  it('writes nothing to D1 itself (the Worker owns the Item and the slot log)', async () => {
    const before = JSON.stringify([db.all('SELECT * FROM bank_items'), db.all('SELECT * FROM plaid_slot_log')])
    await exch(good())
    expect(JSON.stringify([db.all('SELECT * FROM bank_items'), db.all('SELECT * FROM plaid_slot_log')])).toBe(before)
  })
})
