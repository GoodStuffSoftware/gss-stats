// @vitest-environment happy-dom
// The banks browser client: request shapes and the plain-English message for every fixed code (plan 3.1 and 3.3).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  banksMessage,
  BanksApiError,
  createLinkToken,
  exchangeLink,
  fetchBanksStatus,
  markReconnected,
  refreshAccounts,
  requestSync,
  resolveDropped,
  setBankAccount,
  unlinkItem,
} from './banksClient'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}
function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
  return { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined }
}

describe('banksClient requests', () => {
  it('status is a GET', async () => {
    reply({ configured: true, linkEnabled: true, slots: { used: 0, limit: 10, left: 10 }, items: [], dropped: [] })
    expect((await fetchBanksStatus()).configured).toBe(true)
    expect(lastCall()).toMatchObject({ url: '/api/budget/banks/status', method: 'GET' })
  })
  it('a new link token posts only the consent version', async () => {
    reply({ linkToken: 'link-sandbox-aaa', expiration: '2026-11-27T20:00:00Z' })
    await createLinkToken()
    expect(lastCall()).toMatchObject({ url: '/api/budget/banks/link-token', method: 'POST', body: { consent: 1 } })
  })
  it('update mode names the item; share-new-accounts asks for account selection', async () => {
    reply({ linkToken: 'link-sandbox-bbb', expiration: 'x' })
    await createLinkToken({ itemId: 'item-1' })
    expect(lastCall().body).toEqual({ consent: 1, itemId: 'item-1' })
    reply({ linkToken: 'link-sandbox-ccc', expiration: 'x' })
    await createLinkToken({ itemId: 'item-1', accountSelection: true })
    expect(lastCall().body).toEqual({ consent: 1, itemId: 'item-1', accountSelection: true })
  })
  it('exchange sends the public token, the institution and the accounts', async () => {
    reply({ itemId: 'item-9' })
    const r = { publicToken: 'public-sandbox-ddd', institution: { id: 'ins_1', name: 'Example Bank' }, accounts: [{ id: 'acc-a', name: 'Everyday', mask: '0042', type: 'depository', subtype: 'checking' }] }
    expect(await exchangeLink(r)).toEqual({ itemId: 'item-9' })
    expect(lastCall()).toMatchObject({ url: '/api/budget/banks/exchange', method: 'POST', body: { consent: 1, ...r } })
  })
  it('the account switch is a PATCH with the body as given', async () => {
    reply({ ok: true })
    await setBankAccount('ba 1', { sync: 'on', accountId: 'acct-1' })
    expect(lastCall()).toMatchObject({ url: '/api/budget/banks/accounts/ba%201', method: 'PATCH', body: { sync: 'on', accountId: 'acct-1' } })
  })
  it('item actions post to their own path', async () => {
    reply({ ok: true })
    await requestSync('i1')
    expect(lastCall()).toMatchObject({ url: '/api/budget/banks/items/i1/sync', method: 'POST', body: undefined })
    reply({ ok: true })
    await markReconnected('i1')
    expect(lastCall().url).toBe('/api/budget/banks/items/i1/reconnected')
    reply({ added: 2 })
    expect(await refreshAccounts('i1')).toEqual({ added: 2 })
    expect(lastCall().url).toBe('/api/budget/banks/items/i1/accounts-refresh')
    reply({ ok: true })
    await unlinkItem('i1')
    expect(lastCall()).toMatchObject({ url: '/api/budget/banks/items/i1/unlink', method: 'POST', body: { confirm: true } })
  })
  it('a dropped row is settled with delete or keep', async () => {
    reply({ ok: true })
    await resolveDropped('t1', 'keep')
    expect(lastCall()).toMatchObject({ url: '/api/budget/banks/dropped/t1', method: 'POST', body: { action: 'keep' } })
  })
})

describe('banksClient errors', () => {
  it('throws BanksApiError with the status, the code and the plain message', async () => {
    reply({ error: 'banks_not_configured' }, 503)
    const e = await fetchBanksStatus().catch((x) => x)
    expect(e).toBeInstanceOf(BanksApiError)
    expect(e.status).toBe(503)
    expect(e.code).toBe('banks_not_configured')
    expect(e.message).toBe('Bank links are not set up here.')
  })
  it('an answer with no code falls back on the status', async () => {
    reply('nope', 403)
    expect((await fetchBanksStatus().catch((x) => x)).message).toBe('Budget access is needed for bank links.')
    reply('nope', 404)
    expect((await fetchBanksStatus().catch((x) => x)).message).toBe('That is no longer there. Reload and try again.')
    reply('nope', 500)
    expect((await fetchBanksStatus().catch((x) => x)).message).toBe('Something went wrong. Please try again.')
  })
})

describe('banksMessage', () => {
  // Every fixed code the routes (3.1), the Worker (3.3) and an Item's lastError can return.
  const CODES = [
    'banks_not_configured', 'consent_required', 'not_owner', 'not_found', 'item_not_found', 'item_not_active', 'duplicate_item', 'slots_full',
    'store_failed', 'binding_timeout', 'banks_failed', 'kind_mismatch', 'account_taken', 'already_on', 'account_synced', 'bad_request',
    'too_large', 'method_not_allowed', 'forbidden', 'budget_denied', 'unauthorized', 'server_error',
    'not_allowed', 'bad_signature', 'key_unavailable', 'secrets_missing', 'decrypt_failed', 'plaid_timeout', 'plaid_api_error', 'plaid_setup',
    'item_login_required', 'needs_reconnect', 'too_many_pages', 'sync_mutation', 'bad_response',
  ]
  it('has its own sentence for every fixed code', () => {
    const generic = banksMessage('some_unknown_code')
    for (const c of CODES) {
      const m = banksMessage(c)
      expect(m, c).not.toBe(generic)
      expect(m, c).not.toContain(c)
      expect(m.length, c).toBeGreaterThan(10)
    }
  })
  it('a setup refusal says so, while a bank-side Plaid code keeps the retry line', () => {
    expect(banksMessage('plaid_setup')).toBe('Bank links need a setup fix in the Plaid dashboard. Nothing was linked.')
    expect(banksMessage('plaid_item_error')).toBe('The bank reported a problem. It retries on its own.')
  })
  it('names the ten-link limit and the reconnect hint', () => {
    expect(banksMessage('slots_full')).toContain('10')
    expect(banksMessage('duplicate_item')).toContain('Reconnect')
  })
  it('an unknown code or an empty one reads as a generic line; a Plaid code is never shown', () => {
    expect(banksMessage(null)).toBe('Something went wrong. Please try again.')
    expect(banksMessage(undefined)).toBe('Something went wrong. Please try again.')
    expect(banksMessage('totally_new')).toBe('Something went wrong. Please try again.')
    const p = banksMessage('plaid_ITEM_LOGIN_REQUIRED')
    expect(p).not.toContain('ITEM_LOGIN_REQUIRED')
    expect(p).toContain('retries')
  })
  it('does not read inherited object keys as codes', () => {
    expect(banksMessage('toString')).toBe('Something went wrong. Please try again.')
  })
})
