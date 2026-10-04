// @vitest-environment happy-dom
//
// A chart card refetches when the user comes back to the tab (composables/useReturnRefresh.ts):
// only if its last load is 60 s or more old and nothing is loading, never while hidden, with the
// same request as any other load (the api layer is not told to bypass the edge cache), and
// without flashing "Loading…" or replacing good data with an error.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import { __resetReturnRefreshForTests, RETURN_DEBOUNCE_MS, RETURN_INFLIGHT_MAX_MS, RETURN_MIN_AGE_MS } from '../composables/useReturnRefresh'
import { fetchStats } from '../api'
import { stubAppFetch, type AppFetch } from '../testing/appFetch'
import type { Widget, GlobalFilters } from '../types'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    fetchStats: vi.fn(async () => ({
      rows: [{ key: {}, pageviews: 5, visits: 5 }],
      totals: { pageviews: 5, visits: 5 },
      meta: { site: 'all', host: null, since: '2026-09-26', until: '2026-09-27', dimensions: [], metric: 'pageviews' },
    })),
  }
})

// A failed load runs the sign-in probe (GET /api/config); the tests here are not about that.
vi.mock('../session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session')>()
  return { ...actual, checkSessionExpired: vi.fn(async () => {}) }
})

const filters: GlobalFilters = { siteSel: [], since: '2026-09-01', until: '2026-09-26', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
const widget: Widget = { id: 'w1', i: 'w1', title: 'Pageviews', type: 'stat', dataset: 'geo', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3 }

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0)
}
async function comeBack() {
  setVisibility('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 20)
}

const mocked = vi.mocked(fetchStats)
let wrapper: VueWrapper | null = null
// fetchStats is mocked above, but the card also asks the metrics runtime for its caption values:
// without a stand-in that is a real request to happy-dom's localhost:3000 (ECONNREFUSED noise).
let appFetch: AppFetch
async function mountCard() {
  wrapper = mount(ChartCard, { props: { widget, filters, dark: false, drillOpen: false } })
  await settle()
  return wrapper
}

beforeEach(() => {
  __resetReturnRefreshForTests()
  setVisibility('visible')
  mocked.mockClear()
  appFetch = stubAppFetch()
  vi.useFakeTimers()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetReturnRefreshForTests()
  expect(appFetch.unexpected).toEqual([])
})

describe('ChartCard: refetch on return to the tab', () => {
  it('loads once on mount; a return after 60 s refetches once (visibility + focus together)', async () => {
    await mountCard()
    expect(mocked).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2)
  })

  it('does not send a fresh flag: the refetch is called exactly like the first load', async () => {
    await mountCard()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked.mock.calls[1]).toEqual(mocked.mock.calls[0])
    expect(mocked.mock.calls[1]).toHaveLength(2) // (widget, filters): no extra constraints or options
  })

  it('a return under 60 s after the last load refetches nothing', async () => {
    await mountCard()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS - 5000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(1)
  })

  it('never fetches while hidden', async () => {
    await mountCard()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 1000)
    expect(mocked).toHaveBeenCalledTimes(1)
  })

  it('a load already in flight is not doubled', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    mocked.mockImplementationOnce(async () => {
      await gate
      return { rows: [], totals: { pageviews: 1, visits: 1 }, meta: { site: 'all', host: null, since: 'a', until: 'b', dimensions: [], metric: 'pageviews' } } as never
    })
    await mountCard()
    await vi.advanceTimersByTimeAsync(RETURN_INFLIGHT_MAX_MS - 5000) // the first load is still pending, not yet hung
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(1)
    release()
    await settle()
  })

  it('a failed refetch keeps the chart on screen instead of showing an error', async () => {
    const w = await mountCard()
    expect(w.text()).toContain('5')
    mocked.mockRejectedValueOnce(new Error('network down'))
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(w.find('.state.error').exists()).toBe(false)
    expect(w.text()).toContain('5')
  })

  it('a card that never listens after unmount: no refetch once gone', async () => {
    const w = await mountCard()
    w.unmount()
    wrapper = null
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(1)
  })
})

const statResponse = (n: number) =>
  ({ rows: [{ key: {}, pageviews: n, visits: n }], totals: { pageviews: n, visits: n }, meta: { site: 'all', host: null, since: 'a', until: 'b', dimensions: [], metric: 'pageviews' } }) as never
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('ChartCard: a background refetch is quiet', () => {
  it('shows no "Loading…" and keeps the chart on screen while the refetch is pending', async () => {
    const w = await mountCard()
    expect(w.text()).toContain('5')
    const slow = deferred<never>()
    mocked.mockImplementationOnce(() => slow.promise)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2) // the refetch is under way and has not answered
    expect(w.text()).not.toContain('Loading')
    expect(w.find('.state').exists()).toBe(false)
    expect(w.text()).toContain('5')
    slow.resolve(statResponse(321))
    await settle()
    expect(w.text()).toContain('321')
    expect(w.text()).not.toContain('Loading')
  })

  it('keeps an error that is already showing, and clears it only when the refetch succeeds', async () => {
    mocked.mockRejectedValueOnce(new Error('first load failed'))
    const w = await mountCard()
    expect(w.find('.state.error').exists()).toBe(true)
    const slow = deferred<never>()
    mocked.mockImplementationOnce(() => slow.promise)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack() // a failed first load is retried on return, under the same throttle
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(w.find('.state.error').exists()).toBe(true) // not swapped for a spinner
    expect(w.text()).not.toContain('Loading')
    slow.resolve(statResponse(5))
    await settle()
    expect(w.find('.state.error').exists()).toBe(false)
    expect(w.text()).toContain('5')
  })
})

describe('ChartCard: a hung load does not block the return refetch forever', () => {
  it('is still treated as in flight before the age limit', async () => {
    mocked.mockImplementationOnce(() => new Promise(() => {}))
    await mountCard()
    await vi.advanceTimersByTimeAsync(RETURN_INFLIGHT_MAX_MS - 5000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(1)
  })

  it('past the age limit a return refetches, and the hung request answering late cannot overwrite the newer data', async () => {
    const hung = deferred<never>()
    mocked.mockImplementationOnce(() => hung.promise)
    mocked.mockImplementationOnce(async () => statResponse(2222))
    const w = await mountCard()
    await vi.advanceTimersByTimeAsync(RETURN_INFLIGHT_MAX_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(w.text()).toContain('2,222')
    hung.resolve(statResponse(1111)) // the socket finally answers, long after
    await settle()
    expect(w.text()).toContain('2,222')
    expect(w.text()).not.toContain('1,111')
  })
})
