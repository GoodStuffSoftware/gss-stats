// POST /api/budget/banks/items/:id/{sync,reconnected,accounts-refresh,unlink}: who may act, which statuses, what reaches the
// Worker (exactly {ownerEmail, itemId}), what comes back (a count or ok, never a token, cursor or Plaid id), and that a
// Worker failure leaves the Item alone. The Worker is a fake that throws on any path a test did not register.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRoute, createBudgetDb, json, TEST_EMAIL, type FakeBudgetDb } from '../../../../_lib/testing/budgetDb'
import { createFakeBanks, seedBankAccount, seedBankItem, SECRETS, type FakeBanks } from '../../../../_lib/testing/banksFake'
import { onRequest as sync, SYNC_REQUEST_SQL } from './[id]/sync'
import { onRequest as reconnected, RECONNECTED_SQL } from './[id]/reconnected'
import { ITEM_OWNER_SQL } from '../../../../_lib/banks'
import { onRequest as refresh } from './[id]/accounts-refresh'
import { onRequest as unlink } from './[id]/unlink'

const ITEM = 'i000000000000a001'
const OTHER = 'user-b@example.com'
const LEAK = ['access-sandbox-secret-9', SECRETS.tokenCt, SECRETS.tokenIv, SECRETS.cursor, SECRETS.plaidItem, SECRETS.plaidAccount, '0a1b2c3d']

let db: FakeBudgetDb
let banks: FakeBanks
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  db = await createBudgetDb()
  banks = createFakeBanks()
  seedBankItem(db, { id: ITEM, owner: TEST_EMAIL })
  seedBankAccount(db, { id: 'b000000000000c001', itemId: ITEM })
})

type H = (ctx: never) => Promise<Response> | Response
const act = (h: unknown, action: string, id: string = ITEM, o: { email?: string; body?: unknown; rawBody?: string; bound?: boolean } = {}) =>
  callRoute(h as H, db, `/api/budget/banks/items/${id}/${action}`, { method: 'POST', params: { id }, body: o.body, rawBody: o.rawBody, email: o.email, env: o.bound === false ? {} : { BANKS: banks.binding } })
const row = (id = ITEM) => db.get<Record<string, unknown>>('SELECT * FROM bank_items WHERE id = ?', id)!
const setStatus = (status: string, id = ITEM) =>
  db.exec(
    ['revoked', 'removed'].includes(status)
      ? `UPDATE bank_items SET status = '${status}', token_ct = NULL, token_iv = NULL, key_id = NULL, sync_cursor = NULL WHERE id = '${id}'`
      : `UPDATE bank_items SET status = '${status}' WHERE id = '${id}'`,
  )
const noLeak = (v: unknown) => {
  const text = JSON.stringify(v)
  for (const s of LEAK) expect(text, s).not.toContain(s)
}

describe('sync (Sync now)', () => {
  it('stamps sync_requested_at on an active Item and calls no Worker', async () => {
    const res = await act(sync, 'sync')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true })
    expect(row().sync_requested_at).not.toBeNull()
    expect(banks.calls).toEqual([])
  })

  it('any listed person may ask, not only the owner', async () => {
    expect((await act(sync, 'sync', ITEM, { email: OTHER })).status).toBe(200)
    expect(row().sync_requested_at).not.toBeNull()
  })

  it.each(['needs_reconnect', 'pending_disconnect', 'revoked', 'removed'])('409 item_not_active for a %s Item, and nothing is stamped', async (status) => {
    setStatus(status)
    const res = await act(sync, 'sync')
    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('item_not_active')
    expect(row().sync_requested_at).toBeNull()
  })

  it('404 item_not_found for an unknown or malformed id', async () => {
    for (const id of ['i000000000000a999', 'nope', 'I000000000000A001']) {
      const res = await act(sync, 'sync', id)
      expect(res.status).toBe(404)
      expect((await json(res)).error).toBe('item_not_found')
    }
  })

  it('only touches the named Item', async () => {
    seedBankItem(db, { id: 'i000000000000a002', owner: TEST_EMAIL, plaidItemId: 'plaid-item-two-002' })
    await act(sync, 'sync')
    expect(row('i000000000000a002').sync_requested_at).toBeNull()
  })
})

describe('reconnected', () => {
  it.each(['needs_reconnect', 'pending_disconnect', 'active'])('a %s Item goes active, clears the error and requests a sync', async (status) => {
    setStatus(status)
    db.exec(`UPDATE bank_items SET last_error = 'item_login_required' WHERE id = '${ITEM}'`)
    const res = await act(reconnected, 'reconnected')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true })
    expect(row()).toMatchObject({ status: 'active', last_error: null })
    expect(row().sync_requested_at).not.toBeNull()
    expect(row().sync_cursor).toBe(SECRETS.cursor)
    expect(banks.calls).toEqual([])
  })

  it('releases a fresh claim stamp so the next tick picks the Item, and leaves an older stamp alone', async () => {
    setStatus('needs_reconnect')
    const fresh = new Date().toISOString()
    db.exec(`UPDATE bank_items SET last_sync_at = '${fresh}' WHERE id = '${ITEM}'`)
    await act(reconnected, 'reconnected')
    expect(String(row().last_sync_at) < new Date(Date.now() - 15 * 60_000).toISOString()).toBe(true)
    db.exec(`UPDATE bank_items SET status = 'needs_reconnect', last_sync_at = '2026-01-01T00:00:00.000Z' WHERE id = '${ITEM}'`)
    await act(reconnected, 'reconnected')
    expect(row().last_sync_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it.each(['active', 'pending_disconnect'])('a %s Item with a fresh claim keeps its stamp (a run may be in flight)', async (status) => {
    setStatus(status)
    const fresh = new Date().toISOString()
    db.exec(`UPDATE bank_items SET last_sync_at = '${fresh}' WHERE id = '${ITEM}'`)
    await act(reconnected, 'reconnected')
    expect(row()).toMatchObject({ status: 'active', last_sync_at: fresh })
  })

  it.each(['revoked', 'removed'])('409 item_not_active for a %s Item, status unchanged', async (status) => {
    setStatus(status)
    const res = await act(reconnected, 'reconnected')
    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('item_not_active')
    expect(row().status).toBe(status)
  })

  it('404 for a missing Item and 403 not_owner for the other person, who changes nothing', async () => {
    expect((await act(reconnected, 'reconnected', 'i000000000000a999')).status).toBe(404)
    setStatus('needs_reconnect')
    const res = await act(reconnected, 'reconnected', ITEM, { email: OTHER })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('not_owner')
    expect(row().status).toBe('needs_reconnect')
  })
})

describe('accounts-refresh', () => {
  it('passes exactly {ownerEmail, itemId} to the Worker and returns only the count it answered', async () => {
    banks.answer('/accounts-refresh', 200, { added: 2, accessToken: 'access-sandbox-secret-9', plaidItemId: SECRETS.plaidItem, cursor: SECRETS.cursor })
    const res = await act(refresh, 'accounts-refresh')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toEqual({ added: 2 })
    noLeak(body)
    expect(banks.calls).toEqual([{ path: '/accounts-refresh', body: { ownerEmail: TEST_EMAIL, itemId: ITEM } }])
  })

  it('403 not_owner for the other person with no Worker call; 404 for a missing Item', async () => {
    const res = await act(refresh, 'accounts-refresh', ITEM, { email: OTHER })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('not_owner')
    expect((await act(refresh, 'accounts-refresh', 'i000000000000a999')).status).toBe(404)
    expect(banks.calls).toEqual([])
  })

  it('passes a Worker error through as its fixed code and status, hiding any other text', async () => {
    banks.answer('/accounts-refresh', 409, { code: 'item_not_active', message: 'access-sandbox-secret-9 leaked?', accessToken: 'access-sandbox-secret-9' })
    const res = await act(refresh, 'accounts-refresh')
    expect(res.status).toBe(409)
    const body = await json(res)
    expect(body.error).toBe('item_not_active')
    noLeak(body)
  })

  it('502 banks_failed when the Worker answers 200 without a count; 502 when the binding throws', async () => {
    banks.answer('/accounts-refresh', 200, { nothing: true })
    let res = await act(refresh, 'accounts-refresh')
    expect(res.status).toBe(502)
    expect((await json(res)).error).toBe('banks_failed')
    banks.fail('/accounts-refresh')
    res = await act(refresh, 'accounts-refresh')
    expect(res.status).toBe(502)
    expect((await json(res)).error).toBe('banks_failed')
  })
})

describe('unlink', () => {
  it('needs { confirm: true }: anything else is 400 and the Worker is not called', async () => {
    for (const body of [{}, { confirm: 'true' }, { confirm: false }, { confirm: 1 }]) {
      const res = await act(unlink, 'unlink', ITEM, { body })
      expect(res.status).toBe(400)
    }
    expect(banks.calls).toEqual([])
    expect(row().status).toBe('active')
  })

  it('calls the Worker with exactly {ownerEmail, itemId} and answers { ok: true } only', async () => {
    banks.answer('/unlink', 200, { ok: true, accessToken: 'access-sandbox-secret-9' })
    const res = await act(unlink, 'unlink', ITEM, { body: { confirm: true } })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toEqual({ ok: true })
    noLeak(body)
    expect(banks.calls).toEqual([{ path: '/unlink', body: { ownerEmail: TEST_EMAIL, itemId: ITEM } }])
  })

  it('a Worker failure leaves the Item as it was (Pages writes nothing here)', async () => {
    banks.answer('/unlink', 502, { code: 'plaid_failed' })
    const before = JSON.stringify(row())
    const res = await act(unlink, 'unlink', ITEM, { body: { confirm: true } })
    expect(res.status).toBe(502)
    expect((await json(res)).error).toBe('plaid_failed')
    expect(JSON.stringify(row())).toBe(before)
  })

  it('403 not_owner for the other person and 404 for a missing Item, with no Worker call', async () => {
    const res = await act(unlink, 'unlink', ITEM, { body: { confirm: true }, email: OTHER })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('not_owner')
    expect((await act(unlink, 'unlink', 'i000000000000a999', { body: { confirm: true } })).status).toBe(404)
    expect(banks.calls).toEqual([])
  })

  it('the owner address is compared lower-cased and trimmed', async () => {
    banks.answer('/unlink', 200, { ok: true })
    const res = await act(unlink, 'unlink', ITEM, { body: { confirm: true }, email: `  ${TEST_EMAIL.toUpperCase()} ` })
    expect(res.status).toBe(200)
    expect(banks.calls[0]!.body.ownerEmail).toBe(TEST_EMAIL)
  })
})

describe('query plans', () => {
  const plan = (sql: string, values: unknown[]) => db.explain(sql, values).join('\n')
  const NOW = '2026-11-20T10:00:00.000Z'

  it('the owner lookup every item route starts with is a primary-key search', () => {
    const p = plan(ITEM_OWNER_SQL, [ITEM])
    expect(p).toMatch(/SEARCH bank_items USING/)
    expect(p).not.toMatch(/SCAN/)
  })

  it('Sync now and reconnected update by primary key, never a scan', () => {
    for (const sql of [SYNC_REQUEST_SQL, RECONNECTED_SQL]) {
      const p = plan(sql, sql === RECONNECTED_SQL ? [NOW, ITEM, NOW] : [NOW, ITEM])
      expect(p).toMatch(/SEARCH bank_items USING/)
      expect(p).not.toMatch(/SCAN/)
    }
  })
})
