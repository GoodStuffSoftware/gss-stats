// A "today so far" metric token on a tab nobody touches rolls over at ET midnight (review SHOULD-1):
// the day key follows the shared ET clock MetricCard uses, so the token re-plans to the new day
// and refetches, instead of showing yesterday's figure under its own refcount until a filter
// change or a return to the tab. Fake timers only; nothing is re-rendered or re-filtered.
import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetMetricsStateForTests } from './useMetrics'
import { __resetReturnRefreshForTests } from './useReturnRefresh'
import { useMetricTokenValues } from './useMetricTokens'
import type { MetricsContext, MetricsRequestBody } from '../lib/metrics/types'

const TEXT = 'Today {=metric:bsk.pageviews@todaySoFar|number}'
const PATH = 'metric:bsk.pageviews@todaySoFar'
const ctx: MetricsContext = { since: '2026-09-01T04:00:00.000Z', until: '2026-10-01T04:00:00.000Z' }

let served: number[]
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  vi.useFakeTimers({ now: Date.parse('2026-10-04T03:50:00Z') }) // 23:50 ET on 2026-10-03
  served = []
  fetchMock = vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as MetricsRequestBody
    const value = 999 + served.length // yesterday's figure first, then a new one per request
    served.push(value)
    const results = Object.fromEntries(body.requests.map((r) => [r.key, { status: 'ok', value }]))
    return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
})

describe('useMetricTokenValues across ET midnight', () => {
  it('refetches under the new day and shows the new value, with no filter change and no tab return', async () => {
    const scope = effectScope()
    const values = scope.run(() => useMetricTokenValues(() => [TEXT], () => ctx))!
    await vi.advanceTimersByTimeAsync(50)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(values.value[PATH]).toEqual({ kind: 'number', value: 999 })

    await vi.advanceTimersByTimeAsync(5 * 60_000) // 23:55, still the same ET day
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10 * 60_000) // 00:05 ET on 2026-10-04: the clock has ticked past midnight
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(values.value[PATH]).toEqual({ kind: 'number', value: 1000 }) // the new day's figure, not yesterday's 999
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).context).toEqual(ctx) // the request itself is unchanged
    scope.stop()
  })

  it('stops ticking with its scope, and nothing is re-planned after it is gone', async () => {
    const scope = effectScope()
    scope.run(() => useMetricTokenValues(() => [TEXT], () => ctx))
    await vi.advanceTimersByTimeAsync(50)
    scope.stop()
    const timers = vi.getTimerCount()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(vi.getTimerCount()).toBe(timers)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a text with no metric token starts no clock and asks for nothing', async () => {
    const scope = effectScope()
    scope.run(() => useMetricTokenValues(() => ['Plain {=chart.total|number}'], () => ctx))
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(fetchMock).not.toHaveBeenCalled()
    scope.stop()
  })
})
