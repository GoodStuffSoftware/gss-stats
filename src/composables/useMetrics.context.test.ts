// useMetrics follows the page context (ADR 0003 slice 5): a card mounted under one filter-bar
// range must re-plan and reload when the range or sites change, drop the old context's
// requests, never show a response that arrives for a context or dispatch it no longer wants,
// and stop following once its scope is disposed. Also the reload race the slice-4 review found:
// a slow ordinary fetch resolving after a reload must not overwrite the fresher value.
import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetMetricsStateForTests, useMetrics, type MetricRequestSpec } from './useMetrics'
import type { MetricsContext, MetricsRequestBody } from '../lib/metrics/types'

const spec: MetricRequestSpec = { metric: 'bsk.pageviews', window: 'page' }
const spec2: MetricRequestSpec = { metric: 'bsk.authSuccess', window: 'page' }
const A: MetricsContext = { since: '2026-09-01T04:00:00.000Z', until: '2026-09-08T04:00:00.000Z' }
const B: MetricsContext = { since: '2026-09-10T04:00:00.000Z', until: '2026-09-17T04:00:00.000Z' }

interface Call {
  body: MetricsRequestBody
  signal: AbortSignal
  respond(values: Record<string, number>): void
  fail(): void
}
/** A fetch whose every call stays pending until the test answers it — and which, like a real
 * network response racing an abort, resolves even after its signal was aborted, so only the
 * composable's own guard can keep a stale answer out. */
function controllableFetch() {
  const calls: Call[] = []
  const fn = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as MetricsRequestBody
    return new Promise((resolve, reject) => {
      calls.push({
        body,
        signal: init.signal!,
        respond: (values) => {
          const results = Object.fromEntries(body.requests.map((r) => [r.key, { status: 'ok', value: values[r.metric ?? r.ratio ?? ''] ?? 0 }]))
          resolve({ ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) })
        },
        fail: () => reject(new Error('network down')),
      })
    })
  })
  return { fn, calls }
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  __resetMetricsStateForTests()
  vi.useFakeTimers({ now: Date.parse('2026-09-27T12:00:00Z') })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetMetricsStateForTests()
})

describe('useMetrics — following the page context', () => {
  it('re-plans every request in ONE new batch when the context changes, and reads the new value', async () => {
    const { fn, calls } = controllableFetch()
    vi.stubGlobal('fetch', fn)
    const ctx = ref<MetricsContext>(A)
    const scope = effectScope()
    const [pv, auth] = scope.run(() => {
      const m = useMetrics(ctx)
      return [m.request(spec), m.request(spec2)]
    })!
    await vi.advanceTimersByTimeAsync(15)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.context).toEqual(A)
    calls[0].respond({ 'bsk.pageviews': 100, 'bsk.authSuccess': 4 })
    await settle()
    expect(pv.value?.value).toBe(100)

    ctx.value = B
    expect(pv.value).toBeUndefined() // the new context's value is loading; never A's number
    await vi.advanceTimersByTimeAsync(15)
    expect(calls).toHaveLength(2)
    expect(calls[1].body.context).toEqual(B)
    expect(calls[1].body.requests).toHaveLength(2)
    calls[1].respond({ 'bsk.pageviews': 250, 'bsk.authSuccess': 9 })
    await settle()
    expect(pv.value?.value).toBe(250)
    expect(auth.value?.value).toBe(9)
    scope.stop()
  })

  it('accepts a getter, and a new-but-equal context object is not a change', async () => {
    const { fn, calls } = controllableFetch()
    vi.stubGlobal('fetch', fn)
    const holder = ref<{ context: MetricsContext }>({ context: { ...A } })
    const scope = effectScope()
    scope.run(() => useMetrics(() => holder.value.context).request(spec))
    await vi.advanceTimersByTimeAsync(15)
    holder.value = { context: { ...A, sites: [] } } // same stable key: no sites == empty sites
    holder.value = { context: { until: A.until, since: A.since } }
    await vi.advanceTimersByTimeAsync(15)
    expect(calls).toHaveLength(1)
    scope.stop()
  })

  it('a response for the old context, arriving after the switch, is never shown', async () => {
    const { fn, calls } = controllableFetch()
    vi.stubGlobal('fetch', fn)
    const ctx = ref<MetricsContext>(A)
    const scope = effectScope()
    const pv = scope.run(() => useMetrics(ctx).request(spec))!
    await vi.advanceTimersByTimeAsync(15) // A's POST is in flight
    ctx.value = B
    expect(calls[0].signal.aborted).toBe(true) // nobody wants A any more
    await vi.advanceTimersByTimeAsync(15)
    calls[1].respond({ 'bsk.pageviews': 250 })
    await settle()
    calls[0].respond({ 'bsk.pageviews': 100 }) // the stale answer lands last
    await settle()
    expect(pv.value?.value).toBe(250)
    scope.stop()
  })

  it('A → B → A while A is still in flight for another card: switches back to that shared request', async () => {
    const { fn, calls } = controllableFetch()
    vi.stubGlobal('fetch', fn)
    const ctx = ref<MetricsContext>(A)
    const pinned = effectScope() // another card that stays on A
    pinned.run(() => useMetrics(A).request(spec))
    const scope = effectScope()
    const pv = scope.run(() => useMetrics(ctx).request(spec))!
    await vi.advanceTimersByTimeAsync(15)
    expect(calls).toHaveLength(1)
    ctx.value = B
    ctx.value = A
    await vi.advanceTimersByTimeAsync(15)
    // B was queued and released before its batch left; A is still the one in-flight request.
    expect(calls).toHaveLength(1)
    expect(calls[0].signal.aborted).toBe(false)
    calls[0].respond({ 'bsk.pageviews': 100 })
    await settle()
    expect(pv.value?.value).toBe(100)
    scope.stop()
    pinned.stop()
  })

  it('stops following once its scope is disposed, and leaves nothing behind', async () => {
    const { fn, calls } = controllableFetch()
    vi.stubGlobal('fetch', fn)
    const ctx = ref<MetricsContext>(A)
    const scope = effectScope()
    scope.run(() => useMetrics(ctx).request(spec))
    await vi.advanceTimersByTimeAsync(15)
    calls[0].respond({ 'bsk.pageviews': 100 })
    await settle()
    scope.stop()
    ctx.value = B
    await vi.advanceTimersByTimeAsync(15)
    expect(calls).toHaveLength(1)
    // A fresh consumer on A must fetch again: the disposed one held the only reference.
    const scope2 = effectScope()
    scope2.run(() => useMetrics(A).request(spec))
    await vi.advanceTimersByTimeAsync(15)
    expect(calls).toHaveLength(2)
    scope2.stop()
  })
})

describe('useMetrics — the reload race (slice-4 review finding)', () => {
  it('a slow ordinary fetch resolving AFTER a reload never overwrites the fresh value', async () => {
    const { fn, calls } = controllableFetch()
    vi.stubGlobal('fetch', fn)
    const scope = effectScope()
    const m = scope.run(() => useMetrics(A))!
    const pv = scope.run(() => m.request(spec))!
    await vi.advanceTimersByTimeAsync(15) // the slow ordinary POST
    scope.run(() => m.reload([spec]))
    await vi.advanceTimersByTimeAsync(15) // the fresh POST
    expect(calls).toHaveLength(2)
    expect(calls[1].body.fresh).toBe(true)
    calls[1].respond({ 'bsk.pageviews': 300 })
    await settle()
    expect(pv.value?.value).toBe(300)
    calls[0].respond({ 'bsk.pageviews': 100 }) // the slow one lands last
    await settle()
    expect(pv.value?.value).toBe(300)
    scope.stop()
  })

  it('a slow ordinary fetch resolving BEFORE the reload lands is also ignored, and a stale failure never clobbers either', async () => {
    const { fn, calls } = controllableFetch()
    vi.stubGlobal('fetch', fn)
    const scope = effectScope()
    const m = scope.run(() => useMetrics(A))!
    const pv = scope.run(() => m.request(spec))!
    await vi.advanceTimersByTimeAsync(15)
    scope.run(() => m.reload([spec]))
    await vi.advanceTimersByTimeAsync(15)
    calls[0].fail()
    await settle()
    expect(pv.value).toBeUndefined()
    calls[1].respond({ 'bsk.pageviews': 300 })
    await settle()
    expect(pv.value?.value).toBe(300)
    scope.stop()
  })
})

describe('useMetrics — freshness', () => {
  it('lastUpdated is the latest successful load; reloadAll re-requests everything fresh', async () => {
    const { fn, calls } = controllableFetch()
    vi.stubGlobal('fetch', fn)
    const scope = effectScope()
    const m = scope.run(() => useMetrics(A))!
    scope.run(() => {
      m.request(spec)
      m.request(spec2)
    })
    expect(m.lastUpdated.value).toBeNull()
    await vi.advanceTimersByTimeAsync(15)
    calls[0].respond({})
    await settle()
    const first = m.lastUpdated.value
    expect(first).toBe(Date.now())
    await vi.advanceTimersByTimeAsync(60_000)
    m.reloadAll()
    await vi.advanceTimersByTimeAsync(15)
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toMatchObject({ fresh: true })
    expect(calls[1].body.requests).toHaveLength(2)
    calls[1].respond({})
    await settle()
    expect(m.lastUpdated.value).toBeGreaterThan(first!)
    scope.stop()
  })
})
