// @vitest-environment happy-dom
//
// Refetch on return to the tab, for metric values (useMetrics.ts refetchStaleEntries): the held
// entries that are old enough and idle go out again as the NORMAL batched POST /api/metrics,
// one per page context, never `fresh: true`, never one request per card. A failure on that
// background refetch keeps the value already on screen.
import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetMetricsStateForTests, useMetrics, type MetricRequestSpec } from './useMetrics'
import { __resetReturnRefreshForTests, RETURN_DEBOUNCE_MS, RETURN_MIN_AGE_MS } from './useReturnRefresh'
import type { MetricsRequestBody } from '../lib/metrics/types'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}
/** Come back to the tab (visibility + focus together), then let the debounce and the 10 ms coalescing window pass. */
async function comeBack() {
  setVisibility('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 20)
}
const posts = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body) as MetricsRequestBody)

function okFetch(value = 1) {
  return vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as MetricsRequestBody
    const results: Record<string, unknown> = {}
    for (const r of body.requests) results[r.key] = { status: 'ok', value }
    return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
  })
}

const a: MetricRequestSpec = { metric: 'campaign.taggedArrivals', params: { campaignId: '24279250691' }, window: 'attribution' }
const b: MetricRequestSpec = { metric: 'campaign.authSuccess', params: { campaignId: '24279250691' }, window: 'attribution' }
const c: MetricRequestSpec = { metric: 'campaign.taggedArrivals', params: { campaignId: '99' }, window: 'attribution' }

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

/** Two cards (two useMetrics instances) on one page, three distinct requests between them. */
function mountTwoCards() {
  const s1 = effectScope()
  const s2 = effectScope()
  s1.run(() => {
    const m = useMetrics()
    m.request(a)
    m.request(b)
  })
  s2.run(() => {
    const m = useMetrics()
    m.request(c)
  })
  return { stop: () => (s1.stop(), s2.stop()) }
}

describe('useMetrics: refetch on return', () => {
  it('hidden -> visible after 60 s: every held request goes out again as ONE ordinary batched POST', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mountTwoCards()
    await vi.advanceTimersByTimeAsync(20)
    expect(posts(fetchMock)).toHaveLength(1)

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    expect(fetchMock).toHaveBeenCalledTimes(1) // hidden: nothing, and no timer fetches

    await comeBack()
    const all = posts(fetchMock)
    expect(all).toHaveLength(2) // the load, plus exactly one refetch for both cards
    expect(all[1].requests).toHaveLength(3)
    expect(all[1].requests.map((r) => r.key).sort()).toEqual(all[0].requests.map((r) => r.key).sort())
    stop()
  })

  it('never sends fresh:true, on the load or on the return refetch', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mountTwoCards()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(posts(fetchMock)).toHaveLength(2)
    for (const body of posts(fetchMock)) expect(body).not.toHaveProperty('fresh')
    stop()
  })

  it('focus and visibilitychange together (one return) refetch once', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mountTwoCards()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    stop()
  })

  it('a return under 60 s after the last load refetches nothing', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mountTwoCards()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS - 5000)
    await comeBack()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    stop()
  })

  it('a load still in flight is not fetched a second time', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchMock = vi.fn().mockImplementation(async () => {
      await gate
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mountTwoCards()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000) // flushed, response still pending
    await comeBack()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    release()
    stop()
  })

  it('lastUpdated ("Updated X ago") moves to the new load', async () => {
    vi.stubGlobal('fetch', okFetch())
    const s = effectScope()
    let m!: ReturnType<typeof useMetrics>
    s.run(() => {
      m = useMetrics()
      m.request(a)
    })
    await vi.advanceTimersByTimeAsync(20)
    const first = m.lastUpdated.value
    expect(first).not.toBeNull()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(m.lastUpdated.value!).toBeGreaterThan(first! + RETURN_MIN_AGE_MS)
    s.stop()
  })

  it('a failed refetch keeps the value already shown instead of flipping the card to an error', async () => {
    vi.stubGlobal('fetch', okFetch(7))
    const s = effectScope()
    let m!: ReturnType<typeof useMetrics>
    let v!: ReturnType<ReturnType<typeof useMetrics>['request']>
    s.run(() => {
      m = useMetrics()
      v = m.request(a)
    })
    await vi.advanceTimersByTimeAsync(20)
    expect(v.value).toEqual({ status: 'ok', value: 7 })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')))
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(v.value).toEqual({ status: 'ok', value: 7 })
    expect(m.hasError.value).toBe(false)
    s.stop()
  })

  it('stops listening once every card is gone', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { stop } = mountTwoCards()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    stop()
    await comeBack()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
