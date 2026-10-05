// @vitest-environment happy-dom
//
// Refetch on a live push, for metric values (useMetrics.ts refetchLiveEntries). Counts-only
// guarantee 5: only entries whose last value carried `liveSafe === true` go out again. A value
// without the flag, with `liveSafe: false` (a ratio with a refused side, any metric that can count a
// refused row), still loading, or an error is left alone. The refetch is the ordinary batched,
// background path: no spinner flash, a failure keeps the value on screen, never `fresh: true`.
import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetMetricsStateForTests, useMetrics, type MetricRequestSpec } from './useMetrics'
import { __resetReturnRefreshForTests, emitLiveChange, RETURN_DEBOUNCE_MS, RETURN_MIN_AGE_MS } from './useReturnRefresh'
import type { MetricsRequestBody } from '../lib/metrics/types'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}
const posts = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body) as MetricsRequestBody)

/** The server's side of the contract, by metric id: which answers carry `liveSafe`. */
const flagFor: Record<string, boolean | undefined> = {
  'campaign.taggedArrivals': true, // never counts a refused row
  'campaign.authSuccess': undefined, // no flag at all (old server, or a metric that can count refused rows)
  'campaign.gamesStarted': false, // explicitly unsafe
}
function serverFetch(value = 1) {
  return vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as MetricsRequestBody
    const results: Record<string, unknown> = {}
    for (const r of body.requests) {
      const id = (r.metric ?? r.ratio) as string
      const flag = flagFor[id]
      results[r.key] = { status: 'ok', value, ...(flag === undefined ? {} : { liveSafe: flag }) }
    }
    return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
  })
}

const safe: MetricRequestSpec = { metric: 'campaign.taggedArrivals', params: { campaignId: '1' }, window: 'attribution' }
const noFlag: MetricRequestSpec = { metric: 'campaign.authSuccess', params: { campaignId: '1' }, window: 'attribution' }
const unsafe: MetricRequestSpec = { metric: 'campaign.gamesStarted', params: { campaignId: '1' }, window: 'attribution' }

beforeEach(() => {
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  setVisibility('visible')
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
})

function mount(specs: MetricRequestSpec[]) {
  const scope = effectScope()
  const values = scope.run(() => {
    const m = useMetrics()
    return specs.map((s) => m.request(s))
  })!
  return { values, stop: () => scope.stop() }
}
async function live() {
  emitLiveChange()
  await vi.advanceTimersByTimeAsync(20) // the 10 ms coalescing window
}

describe('useMetrics: refetch on a live change', () => {
  it('guarantee 5: refetches ONLY the entry flagged liveSafe; absent and false stay put', async () => {
    const fetchMock = serverFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mount([safe, noFlag, unsafe])
    await vi.advanceTimersByTimeAsync(20)
    const first = posts(fetchMock)
    expect(first).toHaveLength(1)
    expect(first[0].requests).toHaveLength(3)

    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await live()
    const all = posts(fetchMock)
    expect(all).toHaveLength(2)
    expect(all[1].requests).toHaveLength(1)
    const safeKey = first[0].requests.find((r) => r.metric === 'campaign.taggedArrivals')!.key
    expect(all[1].requests[0].key).toBe(safeKey)
    stop()
  })

  it('with no liveSafe entry at all, a live change sends nothing', async () => {
    const fetchMock = serverFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mount([noFlag, unsafe])
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await live()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    stop()
  })

  it('an entry still loading, or one whose load failed, is never refetched by a push', async () => {
    const never = vi.fn().mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', never)
    const m1 = mount([safe])
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000) // never settled, never carried the flag
    await live()
    expect(never).toHaveBeenCalledTimes(1)
    m1.stop()
    __resetMetricsStateForTests()

    const failing = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', failing)
    const m2 = mount([safe])
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await live()
    expect(failing).toHaveBeenCalledTimes(1)
    m2.stop()
  })

  it('under 60 s since the last load: nothing (same isStale gate as a return)', async () => {
    const fetchMock = serverFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mount([safe])
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS - 5000)
    await live()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    stop()
  })

  it('never sends fresh:true, and is one ordinary batched POST for every liveSafe entry across cards', async () => {
    const fetchMock = serverFetch()
    vi.stubGlobal('fetch', fetchMock)
    const other: MetricRequestSpec = { metric: 'campaign.taggedArrivals', params: { campaignId: '2' }, window: 'attribution' }
    const s1 = mount([safe, noFlag])
    const s2 = mount([other])
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await live()
    const all = posts(fetchMock)
    expect(all).toHaveLength(2)
    expect(all[1].requests).toHaveLength(2) // both liveSafe entries, one POST
    for (const body of all) expect(body).not.toHaveProperty('fresh')
    s1.stop()
    s2.stop()
  })

  it('is a background load: the value stays on screen while pending, and a failure keeps it', async () => {
    vi.stubGlobal('fetch', serverFetch(7))
    const { values, stop } = mount([safe])
    await vi.advanceTimersByTimeAsync(20)
    expect(values[0].value?.value).toBe(7)

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        await gate
        throw new Error('network down')
      }),
    )
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await live()
    expect(values[0].value?.value).toBe(7) // pending refetch: nothing replaced
    release()
    await vi.advanceTimersByTimeAsync(20)
    expect(values[0].value?.status).toBe('ok')
    expect(values[0].value?.value).toBe(7) // failed refetch: the last good value stays
    stop()
  })

  it('a refetch answer that DROPS the flag ends the live refetching of that entry', async () => {
    let flagged = true
    const fetchMock = vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as MetricsRequestBody
      const results = Object.fromEntries(body.requests.map((r) => [r.key, { status: 'ok', value: 1, ...(flagged ? { liveSafe: true } : {}) }]))
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mount([safe])
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    flagged = false
    await live() // refetch #1: the answer comes back without the flag
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await live()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    stop()
  })

  it('never fires while hidden', async () => {
    const fetchMock = serverFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mount([safe])
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    setVisibility('hidden')
    await live()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    stop()
  })

  it('after unmount, no refetch', async () => {
    const fetchMock = serverFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mount([safe])
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    stop()
    await live()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the return refetch is unchanged: it still refetches EVERY entry, flagged or not', async () => {
    const fetchMock = serverFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mount([safe, noFlag, unsafe])
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 20)
    const all = posts(fetchMock)
    expect(all).toHaveLength(2)
    expect(all[1].requests).toHaveLength(3)
    stop()
  })

  // The flag lives on the cache entry of ONE request (context + canonical spec). A spec change in a
  // card is a different request, so a new entry that starts with no value and no flag: the old
  // request's flag cannot carry over to it (the class of bug PR #93's review found in ChartCard).
  describe('the flag belongs to the request it answered', () => {
    // campaign 1 answers flagged; any other campaign answers without the flag
    function perCampaignFetch(hangFor?: string) {
      return vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as MetricsRequestBody
        if (hangFor && body.requests.every((r) => r.params?.campaignId === hangFor)) return new Promise(() => {})
        const results = Object.fromEntries(
          body.requests.map((r) => [r.key, { status: 'ok', value: 1, ...(r.params?.campaignId === '1' ? { liveSafe: true } : {}) }]),
        )
        return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results }) }
      })
    }
    const edited = (patch: Partial<MetricRequestSpec>): MetricRequestSpec => ({ ...safe, ...patch })

    it('a card whose spec changes (another campaign, another window): only the answer that came back flagged refetches', async () => {
      const fetchMock = perCampaignFetch()
      vi.stubGlobal('fetch', fetchMock)
      const scope = effectScope()
      const m = scope.run(() => useMetrics())!
      m.request(safe)
      await vi.advanceTimersByTimeAsync(20)
      m.request(edited({ params: { campaignId: '2' } })) // the spec changed: a new request, answered without the flag
      m.request(edited({ window: 'flight' as never })) // ...and a new window (a new request; its own answer is flagged)
      await vi.advanceTimersByTimeAsync(20)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      const last = posts(fetchMock).at(-1)!
      expect(last.requests).toHaveLength(2) // campaign 1 under both windows (each answered flagged on its own); campaign 2 is left out
      expect(last.requests.every((r) => r.params?.campaignId === '1')).toBe(true)
      scope.stop()
    })

    it('a changed spec whose answer is still on its way is not refetched by a push', async () => {
      const fetchMock = perCampaignFetch('2')
      vi.stubGlobal('fetch', fetchMock)
      const scope = effectScope()
      const m = scope.run(() => useMetrics())!
      m.request(safe)
      await vi.advanceTimersByTimeAsync(20)
      m.request(edited({ params: { campaignId: '2' } })) // hangs: never settles, never carries a flag
      await vi.advanceTimersByTimeAsync(20)
      const before = fetchMock.mock.calls.length
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      const sent = posts(fetchMock).slice(before)
      expect(sent.flatMap((b) => b.requests).filter((r) => r.params?.campaignId === '2')).toHaveLength(0)
      scope.stop()
    })
  })
})
