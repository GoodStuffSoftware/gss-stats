// @vitest-environment happy-dom
// The receipts browser client: request shapes and the plain-English message for every fixed code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyReceipts,
  disconnectReceipts,
  dismissReceipt,
  fetchReceiptLinks,
  fetchReceipts,
  fetchReceiptsStatus,
  receiptsMessage,
  ReceiptsApiError,
  startReceiptsConnect,
  syncReceiptsNow,
} from './receiptsClient'

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

describe('receiptsClient requests', () => {
  it('status is a GET', async () => {
    reply({ configured: true, connection: null, lastRuns: [], nextRunAt: null })
    expect((await fetchReceiptsStatus()).configured).toBe(true)
    expect(lastCall()).toMatchObject({ url: '/api/budget/email/status', method: 'GET' })
  })
  it('connect posts the consent version', async () => {
    reply({ url: 'https://accounts.example.com/o' })
    expect((await startReceiptsConnect()).url).toBe('https://accounts.example.com/o')
    expect(lastCall()).toMatchObject({ url: '/api/budget/email/connect', method: 'POST', body: { consent: 1 } })
  })
  it('sync posts with no body', async () => {
    reply({ ok: true }, 202)
    await syncReceiptsNow()
    expect(lastCall()).toMatchObject({ url: '/api/budget/email/sync', method: 'POST' })
  })
  it('disconnect keeps by default and purges on request', async () => {
    reply({ ok: true, revoked: true, purged: false })
    await disconnectReceipts()
    expect(lastCall().body).toEqual({ purge: false })
    reply({ ok: true, revoked: true, purged: true })
    await disconnectReceipts(true)
    expect(lastCall().body).toEqual({ purge: true })
  })
  it('lists with a status and a cursor', async () => {
    reply({ receipts: [], nextCursor: null })
    await fetchReceipts({ status: 'suggested', cursor: 'abc' })
    expect(lastCall().url).toBe('/api/budget/email/receipts?status=suggested&cursor=abc')
    reply({ receipts: [], nextCursor: null })
    await fetchReceipts()
    expect(lastCall().url).toBe('/api/budget/email/receipts')
  })
  it('dismiss patches the opaque id', async () => {
    reply({ id: 'r1', status: 'dismissed' })
    await dismissReceipt('r1')
    expect(lastCall()).toMatchObject({ url: '/api/budget/email/receipts/r1', method: 'PATCH', body: { dismissed: true } })
  })
  it('apply posts items and rejects', async () => {
    reply({ applied: [], rejected: ['m2'], skipped: [] })
    await applyReceipts([{ matchId: 'm1', expectedUpdatedAt: '2026-01-01T00:00:00Z', categoryId: 'c1' }], ['m2'])
    expect(lastCall().body).toEqual({ items: [{ matchId: 'm1', expectedUpdatedAt: '2026-01-01T00:00:00Z', categoryId: 'c1' }], reject: ['m2'] })
  })
  it('links post the ids and return the map', async () => {
    reply({ links: { t1: { merchant: 'Acme Hardware', items: [] } } })
    const links = await fetchReceiptLinks(['t1'])
    expect(links.t1.merchant).toBe('Acme Hardware')
    expect(lastCall()).toMatchObject({ url: '/api/budget/email/links', body: { txnIds: ['t1'] } })
  })
})

describe('receiptsClient errors', () => {
  it('throws ReceiptsApiError with the status, code and plain message', async () => {
    reply({ error: 'rate_limited', retryAfterSec: 120 }, 429)
    const e = (await syncReceiptsNow().catch((x) => x)) as ReceiptsApiError
    expect(e).toBeInstanceOf(ReceiptsApiError)
    expect([e.status, e.code, e.retryAfterSec]).toEqual([429, 'rate_limited', 120])
    expect(e.message).toBe(receiptsMessage('rate_limited'))
  })
  it('falls back to a generic line for a body with no code', async () => {
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500 }))
    const e = (await fetchReceiptsStatus().catch((x) => x)) as ReceiptsApiError
    expect(e.code).toBeNull()
    expect(e.message).toBe('Something went wrong. Please try again.')
  })

  const CODES = [
    'connected', 'denied', 'google_error', 'state_invalid', 'state_used', 'not_configured', 'invalid_grant', 'scope_missing',
    'no_refresh_token', 'token_invalid', 'not_allowed', 'exchange_failed', 'receipts_not_configured', 'consent_required',
    'receipts_unavailable', 'receipts_failed', 'worker_failed', 'rate_limited', 'not_connected', 'reconnect_needed', 'paused',
    'needs_reconnect', 'api_rejected', 'api_limited',
  ]
  it.each(CODES)('has its own message for %s', (code) => {
    const m = receiptsMessage(code)
    expect(m).not.toBe(receiptsMessage('no_such_code'))
    expect(m.length).toBeGreaterThan(8)
    expect(m).not.toContain('_')
  })
  it('uses the exact paused wording', () => {
    expect(receiptsMessage('api_rejected')).toBe('Receipts paused: the API rejected the request')
    expect(receiptsMessage('api_limited')).toBe('Receipts paused: API limit reached, retrying next hour')
  })
  it('an unknown or prototype-named code gets the generic line', () => {
    expect(receiptsMessage('constructor')).toBe(receiptsMessage(null))
  })
})
