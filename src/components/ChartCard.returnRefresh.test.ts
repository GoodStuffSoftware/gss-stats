// @vitest-environment happy-dom
//
// A chart card refetches when the user comes back to the tab (composables/useReturnRefresh.ts):
// only if its last load is 60 s or more old and nothing is loading, never while hidden, with the
// same request as any other load (the api layer is not told to bypass the edge cache), and
// without flashing "Loading…" or replacing good data with an error.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import { __resetReturnRefreshForTests, RETURN_DEBOUNCE_MS, RETURN_MIN_AGE_MS } from '../composables/useReturnRefresh'
import { fetchStats } from '../api'
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
async function mountCard() {
  wrapper = mount(ChartCard, { props: { widget, filters, dark: false, drillOpen: false } })
  await settle()
  return wrapper
}

beforeEach(() => {
  __resetReturnRefreshForTests()
  setVisibility('visible')
  mocked.mockClear()
  vi.useFakeTimers()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  __resetReturnRefreshForTests()
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
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000) // the first load is still pending
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
