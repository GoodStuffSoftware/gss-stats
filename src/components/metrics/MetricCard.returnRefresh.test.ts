// @vitest-environment happy-dom
//
// A tab that slept past midnight ET comes back: MetricCard moves its clock to "now" on the return
// event BEFORE the return refetch re-queues anything, so the day watcher re-plans first and only
// the new day's request goes out. Without that, the refetch would re-queue yesterday's entries
// (a wasted POST whose answer is discarded) and the card's 15 s tick would send the new day's
// POST after it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { __resetReturnRefreshForTests, RETURN_DEBOUNCE_MS } from '../../composables/useReturnRefresh'
import type { MetricsRequestBody } from '../../lib/metrics/types'

const RETEST = '24279250691'
// The retest's last serving day is 2026-10-02 (ET): 23:59 ET that day is 03:59Z on the 3rd.
const LAST_MINUTE = Date.parse('2026-10-03T03:59:00Z')
const NEXT_MORNING = Date.parse('2026-10-03T11:00:00Z')

const bodies: MetricsRequestBody[] = []
let wrapper: VueWrapper | null = null

beforeEach(() => {
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  bodies.length = 0
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  vi.useFakeTimers({ now: LAST_MINUTE })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as MetricsRequestBody
      bodies.push(body)
      const results = Object.fromEntries(body.requests.map((r) => [r.key, { status: 'ok', value: 42 }]))
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('MetricCard: return to the tab after midnight ET', () => {
  it('sends one POST, for the new day, and none for yesterday\'s entries', async () => {
    wrapper = mount(MetricCard, { props: { cardRef: { preset: 'bsk-kpis' } } })
    await vi.advanceTimersByTimeAsync(50)
    await flushPromises()
    expect(bodies).toHaveLength(1)
    const yesterdayRetest = bodies[0].requests.filter((r) => r.params?.campaignId === RETEST)
    expect(yesterdayRetest.length).toBeGreaterThan(0) // the card was still showing the flighting retest

    // The tab slept: the wall clock jumps, no timer (the card's 15 s tick) ever fired.
    vi.setSystemTime(NEXT_MORNING)
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 50)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(50)
    await flushPromises()

    const after = bodies.slice(1)
    expect(after).toHaveLength(1) // not two: no wasted POST for the old day before the new one
    expect(after.flatMap((b) => b.requests).some((r) => r.params?.campaignId === RETEST)).toBe(false)
    expect(after.flatMap((b) => b.requests).some((r) => r.window === 'todaySoFar')).toBe(true)
    for (const b of after) expect(b).not.toHaveProperty('fresh')
    expect(wrapper.find('.mp-tile-text').text()).toBe('no campaign flighting today')
  })
})
