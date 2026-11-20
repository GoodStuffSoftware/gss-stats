// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../session', () => ({ checkSessionExpired: vi.fn(async () => {}) }))
import { checkSessionExpired } from '../../session'
import {
  BudgetApiError, fetchDebtDetail, fetchDebts, fetchMeta, fetchSummary, probeAccess, putManualBalance, resetAccessProbe,
} from './clientRead'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  resetAccessProbe()
  vi.mocked(checkSessionExpired).mockClear()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('probeAccess', () => {
  it('200 -> ok with the email', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, email: 'a@example.com' }))
    expect(await probeAccess()).toEqual({ state: 'ok', email: 'a@example.com' })
  })
  it('403 -> denied, 401 -> expired (and raises the sign-in banner path), 500 and network failure -> error', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'budget_denied' }, 403))
    expect(await probeAccess()).toEqual({ state: 'denied' })
    resetAccessProbe()
    fetchMock.mockResolvedValueOnce(json({ error: 'x' }, 401))
    expect(await probeAccess()).toEqual({ state: 'expired' })
    expect(checkSessionExpired).toHaveBeenCalledTimes(1)
    resetAccessProbe()
    fetchMock.mockResolvedValueOnce(json({}, 500))
    expect(await probeAccess()).toEqual({ state: 'error' })
    resetAccessProbe()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await probeAccess()).toEqual({ state: 'error' })
  })
  it('a 200 without ok:true is not access', async () => {
    fetchMock.mockResolvedValue(json({ hello: 1 }))
    expect(await probeAccess()).toEqual({ state: 'error' })
  })
  it('asks once per load: later calls share the answer, no retry after a failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await probeAccess()
    await probeAccess()
    await probeAccess()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/budget/access')
  })
})

describe('reads', () => {
  it('fetchSummary sends only the params it has', async () => {
    fetchMock.mockImplementation(async () => json({ level: 'category', slices: [], totalCents: 0, reviewCount: 0 }))
    await fetchSummary({ from: '2026-11-01', to: '2026-11-20', person: 'all' })
    await fetchSummary({ from: '2026-11-01', to: '2026-11-20', person: 'p1', category: 'fuel', groupBy: 'account', merchant: 'chain-x' })
    const u1 = new URL(fetchMock.mock.calls[0][0], 'http://x')
    expect(u1.pathname).toBe('/api/budget/summary')
    expect(Object.fromEntries(u1.searchParams)).toEqual({ from: '2026-11-01', to: '2026-11-20', person: 'all' })
    const u2 = new URL(fetchMock.mock.calls[1][0], 'http://x')
    expect(Object.fromEntries(u2.searchParams)).toEqual({
      from: '2026-11-01', to: '2026-11-20', person: 'p1', category: 'fuel', groupBy: 'account', merchant: 'chain-x',
    })
  })
  it('meta, debts and debt detail hit their routes (ids are encoded)', async () => {
    fetchMock.mockImplementation(async () => json({}))
    await fetchMeta()
    await fetchDebts('p1')
    await fetchDebtDetail('a/b c')
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/budget/meta', '/api/budget/debts?person=p1', '/api/budget/debts/a%2Fb%20c'])
  })
  it('putManualBalance PUTs JSON', async () => {
    fetchMock.mockImplementation(async () => json({ ok: true }))
    await putManualBalance('debt-1', { asOf: '2026-11-20', balanceCents: 123456, aprBp: 599 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/budget/debts/debt-1/balance')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ asOf: '2026-11-20', balanceCents: 123456, aprBp: 599 })
  })
  it('an error answer throws BudgetApiError with status and code; 401 raises the banner path', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'bad_request', message: 'from is required' }, 400))
    await expect(fetchMeta()).rejects.toMatchObject({ name: 'BudgetApiError', status: 400, code: 'bad_request', message: 'from is required' })
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 502 }))
    const e = await fetchMeta().catch((x) => x)
    expect(e).toBeInstanceOf(BudgetApiError)
    expect(e.status).toBe(502)
    expect(e.code).toBeNull()
    fetchMock.mockResolvedValueOnce(json({}, 401))
    await expect(fetchMeta()).rejects.toMatchObject({ status: 401 })
    expect(checkSessionExpired).toHaveBeenCalledTimes(1)
  })
})
