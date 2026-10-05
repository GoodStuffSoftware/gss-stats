// @vitest-environment happy-dom
//
// Regression: ChartCard's live-refresh flag (`liveSafe`) is bound to the request it answered
// (`requestKey`). Inside the REAL Dashboard, grid-layout-plus writes its own `moved` bookkeeping onto
// every widget AFTER ChartCard's first load; if that counted as part of the request, the key would
// change under the flag, the flag would clear and never re-arm, and an open dashboard would never
// refetch on a push. ChartCard.liveRefresh.test.ts mounts bare widgets, which cannot see this.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import Dashboard from './Dashboard.vue'
import { __resetReturnRefreshForTests, emitLiveChange } from '../composables/useReturnRefresh'
import { sitesLoaded } from '../sitesStore'
import { stubAppFetch } from '../testing/appFetch'
import type { Widget, GlobalFilters } from '../types'

let wrapper: VueWrapper | null = null
let geoCalls = 0

beforeEach(() => {
  __resetReturnRefreshForTests()
  const base = stubAppFetch()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== '/api/geo') return base.fetch(input, init)
    geoCalls++
    return new Response(
      JSON.stringify({
        rows: [{ key: { country: 'US' }, pageviews: 3, visits: 3 }],
        totals: { pageviews: 3, visits: 3 },
        meta: { site: 'all', host: null, since: 'a', until: 'b', dimensions: ['country'], metric: 'pageviews', liveSafe: true },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  vi.useFakeTimers()
  geoCalls = 0
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetReturnRefreshForTests()
  sitesLoaded.value = false
})

const filters: GlobalFilters = {
  siteSel: [], since: '2026-09-01', until: '2026-09-30',
  excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '',
}
const geoChart = (id: string, y: number): Widget => ({
  id, i: id, title: id, type: 'doughnut', dataset: 'geo', dimension: 'country', metric: 'pageviews', limit: 10, x: 0, y, w: 4, h: 4,
})

describe('ChartCard live refresh inside the real Dashboard / GridLayout', () => {
  it('two liveSafe geo charts both refetch on a push after the layout wrote `moved` onto them', async () => {
    const widgets = reactive([geoChart('a', 0), geoChart('b', 4)]) as Widget[]
    wrapper = mount(Dashboard, {
      props: { widgets, filters, dark: false, drillOpenId: null, controlsVisible: false },
      attachTo: document.body,
    })
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()
    await vi.advanceTimersByTimeAsync(50)
    expect(geoCalls).toBe(2) // one first load per chart
    // The library really did write its bookkeeping onto our widgets (guards the premise of this test).
    expect((widgets[0] as Widget & { moved?: boolean }).moved).toBe(false)
    await vi.advanceTimersByTimeAsync(61_000) // past the 60 s stale gate
    emitLiveChange()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(50)
    expect(geoCalls).toBe(4) // both charts refetched
  })
})
