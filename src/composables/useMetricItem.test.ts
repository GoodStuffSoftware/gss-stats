// useMetricItemViewModel (ADR 0003; review fix 2026-09-27, "an edit to an existing item never
// reaches the preview"): item/scope must be reactive getters, re-planning the underlying
// useMetrics() request only when the PLANNED request actually changes, and releasing the old
// entry rather than leaking it. Exercised directly (no component mount needed — this is a plain
// composable), following useMetrics.test.ts's own effectScope() + fake-timers pattern.
import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMetricItemViewModel } from './useMetricItem'
import { __resetMetricsStateForTests } from './useMetrics'
import { ROOT_SCOPE, type ScopeInstance } from '../lib/metrics/scope'
import type { MetricItem, MetricsRequestBody, MetricsResponseBody } from '../lib/metrics/types'

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }
}

const arrivalsItem: MetricItem = { id: 'a', label: 'Arrivals', data: { metric: 'campaign.taggedArrivals', params: { campaignId: '24279250691' } }, display: { as: 'number' } }
const authItem: MetricItem = { id: 'a', label: 'Auth', data: { metric: 'campaign.authSuccess', params: { campaignId: '24279250691' } }, display: { as: 'number' } }

beforeEach(() => {
  __resetMetricsStateForTests()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})

function mockFetch(valueFor: (metric: string | undefined) => number) {
  return vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as MetricsRequestBody
    const results: MetricsResponseBody['results'] = {}
    for (const r of body.requests) results[r.key] = { status: 'ok', value: valueFor(r.metric) }
    return jsonResponse({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } })
  })
}

describe('useMetricItemViewModel — reactive item/scope', () => {
  it('mounts with one fetch and formats the resolved value', async () => {
    const fetchMock = mockFetch(() => 353)
    vi.stubGlobal('fetch', fetchMock)
    const item = ref<MetricItem>(arrivalsItem)
    const scope = ref<ScopeInstance>(ROOT_SCOPE)
    const scope_ = effectScope()
    const vm = scope_.run(() => useMetricItemViewModel(() => item.value, () => scope.value, () => undefined, '2026-09-27'))!

    await vi.advanceTimersByTimeAsync(15)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vm.value.primary).toBe('353')
    scope_.stop()
  })

  it('changing the data binding (a real edit) re-plans: exactly one new fetch, and the view model updates to the new value', async () => {
    const fetchMock = mockFetch((m) => (m === 'campaign.taggedArrivals' ? 353 : 97))
    vi.stubGlobal('fetch', fetchMock)
    const item = ref<MetricItem>(arrivalsItem)
    const scope = ref<ScopeInstance>(ROOT_SCOPE)
    const scope_ = effectScope()
    const vm = scope_.run(() => useMetricItemViewModel(() => item.value, () => scope.value, () => undefined, '2026-09-27'))!

    await vi.advanceTimersByTimeAsync(15)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vm.value.primary).toBe('353')

    item.value = authItem // the "saved card" case: same item.id, a genuinely different metric
    await nextTick()
    await vi.advanceTimersByTimeAsync(15)

    expect(fetchMock).toHaveBeenCalledTimes(2) // exactly one NEW batch, not zero and not a pile-up
    expect(vm.value.primary).toBe('97') // and the preview/card actually shows the new metric's value
    scope_.stop()
  })

  it('editing something that does NOT change the request (label text) touches no fetch at all', async () => {
    const fetchMock = mockFetch(() => 353)
    vi.stubGlobal('fetch', fetchMock)
    const item = ref<MetricItem>(arrivalsItem)
    const scope = ref<ScopeInstance>(ROOT_SCOPE)
    const scope_ = effectScope()
    const vm = scope_.run(() => useMetricItemViewModel(() => item.value, () => scope.value, () => undefined, '2026-09-27'))!

    await vi.advanceTimersByTimeAsync(15)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    item.value = { ...arrivalsItem, label: 'Tagged arrivals (relabelled)' }
    await nextTick()
    await vi.advanceTimersByTimeAsync(15)

    expect(fetchMock).toHaveBeenCalledTimes(1) // no new request — the plan didn't change
    expect(vm.value.labelTokens.map((t) => t.value).join('')).toBe('Tagged arrivals (relabelled)') // but the label DID update
    scope_.stop()
  })

  it('no request storm: 20 rapid item edits inside one coalescing window produce only a few POSTs, not 20', async () => {
    const fetchMock = mockFetch(() => 1)
    vi.stubGlobal('fetch', fetchMock)
    const item = ref<MetricItem>(arrivalsItem)
    const scope = ref<ScopeInstance>(ROOT_SCOPE)
    const scope_ = effectScope()
    scope_.run(() => useMetricItemViewModel(() => item.value, () => scope.value, () => undefined, '2026-09-27'))

    // Simulate 20 keystrokes' worth of edits landing before the fetch layer's own 10ms
    // coalescing window elapses (the realistic case: CardEditor's live-preview watcher is
    // itself debounced 300ms, so a burst of edits collapses to far fewer distinct plans long
    // before any of them reaches here).
    for (let i = 0; i < 20; i++) {
      item.value = { ...arrivalsItem, gating: { minCohort: 5 + i } } // a genuinely different plan each time
      await nextTick()
    }
    await vi.advanceTimersByTimeAsync(15)

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3)
    scope_.stop()
  })

  it('never leaks: the old cache entry is released when the plan changes (no growth in outstanding requests)', async () => {
    const fetchMock = mockFetch(() => 1)
    vi.stubGlobal('fetch', fetchMock)
    const item = ref<MetricItem>(arrivalsItem)
    const scope = ref<ScopeInstance>(ROOT_SCOPE)
    const scope_ = effectScope()
    scope_.run(() => useMetricItemViewModel(() => item.value, () => scope.value, () => undefined, '2026-09-27'))
    await vi.advanceTimersByTimeAsync(15)

    for (let i = 0; i < 10; i++) {
      item.value = { ...arrivalsItem, gating: { minCohort: 5 + i } }
      await nextTick()
      await vi.advanceTimersByTimeAsync(15)
    }
    // Each edit here lands in its OWN coalescing window (timers advanced between them), so each
    // is its own batch — the point is each batch stays small (one request for the one live
    // consumer), never accumulating every prior plan's now-abandoned request alongside it.
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body as string) as MetricsRequestBody
      expect(body.requests.length).toBe(1)
    }
    scope_.stop()
  })
})
