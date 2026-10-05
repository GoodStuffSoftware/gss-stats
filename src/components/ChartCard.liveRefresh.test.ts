// @vitest-environment happy-dom
//
// A chart card refetches on a live push (composables/useLiveChanges.ts -> useReturnRefresh.ts
// emitLiveChange) only when EVERY query behind its last response was flagged `meta.liveSafe === true`
// (counts-only guarantee 5: a flag that is absent, false, or missing on one side of a series never
// refetches), never for a bespoke body, a /api/completions chart or an includeEventBeacons geo chart,
// at most once an hour per chart (guarantee 6), never while hidden, and as a quiet background load.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import { __resetReturnRefreshForTests, emitLiveChange, RETURN_MIN_AGE_MS } from '../composables/useReturnRefresh'
import { fetchSeriesStats, fetchStats } from '../api'
import { sitesLoaded } from '../sitesStore'
import { stubAppFetch, type AppFetch } from '../testing/appFetch'
import type { Widget, GlobalFilters } from '../types'

const HOUR = 3_600_000

const resp = (n: number, liveSafe?: boolean) =>
  ({
    rows: [{ key: {}, pageviews: n, visits: n }],
    totals: { pageviews: n, visits: n },
    meta: { site: 'all', host: null, since: 'a', until: 'b', dimensions: [], metric: 'pageviews', ...(liveSafe === undefined ? {} : { liveSafe }) },
  }) as never

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: vi.fn(), fetchSeriesStats: vi.fn() }
})
vi.mock('../session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session')>()
  return { ...actual, checkSessionExpired: vi.fn(async () => {}) }
})

const filters: GlobalFilters = { siteSel: [], since: '2026-09-01', until: '2026-09-26', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
const stat: Widget = { id: 'w1', i: 'w1', title: 'Pageviews', type: 'stat', dataset: 'geo', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3 }
// NOTE (fixture realism): the real server never flags a keyEvent-filtered series liveSafe (keyEvent lifts
// the refused-path exclusion). The unit mock below flags every side so the CLIENT's every-side rule can
// be exercised; it is not the server contract (see functions/api/geo.ts).
const series: Widget = {
  ...stat,
  type: 'line',
  dimension: 'date',
  limit: 30,
  series: [{ label: 'Installs', filter: [{ field: 'keyEvent', value: 'install' }] }, { label: 'Opens', filter: [{ field: 'keyEvent', value: 'open' }] }],
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibility' + 'State', { value: state, configurable: true })
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0)
}
async function live() {
  emitLiveChange()
  await settle()
}

const stats = vi.mocked(fetchStats)
const seriesStats = vi.mocked(fetchSeriesStats)
let wrapper: VueWrapper | null = null
let appFetch: AppFetch
async function mountCard(widget: Widget, f: GlobalFilters = filters) {
  wrapper = mount(ChartCard, { props: { widget, filters: f, dark: false, drillOpen: false } })
  await settle()
  return wrapper
}

beforeEach(() => {
  __resetReturnRefreshForTests()
  setVisibility('visible')
  stats.mockReset()
  seriesStats.mockReset()
  stats.mockImplementation(async () => resp(5, true))
  seriesStats.mockImplementation(async () => [resp(5, true), resp(6, true)])
  appFetch = stubAppFetch()
  vi.useFakeTimers()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetReturnRefreshForTests()
  sitesLoaded.value = false
  expect(appFetch.unexpected).toEqual([])
})

describe('ChartCard: refetch on a live change', () => {
  it('a liveSafe chart refetches once, with the same request as the first load (no fresh flag)', async () => {
    await mountCard(stat)
    expect(stats).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await live()
    expect(stats).toHaveBeenCalledTimes(2)
    expect(stats.mock.calls[1]).toEqual(stats.mock.calls[0])
    expect(stats.mock.calls[1]).toHaveLength(2)
  })

  describe('guarantee 5: fail-closed on the flag', () => {
    it('liveSafe absent: never refetches', async () => {
      stats.mockImplementation(async () => resp(5))
      await mountCard(stat)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(1)
    })

    it('liveSafe false: never refetches', async () => {
      stats.mockImplementation(async () => resp(5, false))
      await mountCard(stat)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(1)
    })

    it('a series chart where one side is not flagged (a ratio with one unsafe side): never refetches', async () => {
      seriesStats.mockImplementation(async () => [resp(5, true), resp(6, false)])
      await mountCard(series)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(seriesStats).toHaveBeenCalledTimes(1)
    })

    it('a series chart where every side is flagged: refetches', async () => {
      await mountCard(series)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(seriesStats).toHaveBeenCalledTimes(2)
    })

    it('a series chart with a response missing the flag on one side: never refetches', async () => {
      seriesStats.mockImplementation(async () => [resp(5, true), resp(6)])
      await mountCard(series)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(seriesStats).toHaveBeenCalledTimes(1)
    })

    it('an includeEventBeacons geo chart never refetches, even if a response claimed liveSafe', async () => {
      await mountCard({ ...stat, includeEventBeacons: true })
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(1)
    })

    it('the page-level includeEventBeacons filter blocks it too', async () => {
      await mountCard(stat, { ...filters, includeEventBeacons: true })
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(1)
    })

    it('any /api/completions chart never refetches, even if a response claimed liveSafe', async () => {
      sitesLoaded.value = true // a non-geo dataset waits for the site tree before its first load
      await mountCard({ ...stat, dataset: 'completions', dimension: 'mode' })
      expect(stats).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(1)
    })

    it('a chart whose first load failed has no flag: never refetches', async () => {
      stats.mockRejectedValueOnce(new Error('network down'))
      await mountCard(stat)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(1)
    })

    it('a bespoke body (note) never refetches', async () => {
      await mountCard({ ...stat, type: 'note', dataset: undefined as never })
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).not.toHaveBeenCalled()
    })

    it('a refetch that comes back without the flag ends the live refetching of that chart', async () => {
      await mountCard(stat)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      stats.mockImplementation(async () => resp(5)) // an old server answers without the flag
      await live()
      expect(stats).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(HOUR + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(2)
    })
  })

  describe('guarantee 6: gates and the hourly cap', () => {
    it('one live refetch per chart per hour', async () => {
      await mountCard(stat)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      await live()
      expect(stats).toHaveBeenCalledTimes(2) // 15 min later: inside the hour
      await vi.advanceTimersByTimeAsync(44 * 60_000)
      await live()
      expect(stats).toHaveBeenCalledTimes(2) // 59 min later
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      await live()
      expect(stats).toHaveBeenCalledTimes(3) // past the hour
    })

    it('a live refetch does not stop a return refetch, and the cap is not charged by the first load', async () => {
      await mountCard(stat)
      // the first load happened just now, but the live cap only counts live refetches
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(2)
    })

    it('under 60 s since the last load: nothing', async () => {
      await mountCard(stat)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS - 5000)
      await live()
      expect(stats).toHaveBeenCalledTimes(1)
    })

    it('never fetches while hidden', async () => {
      await mountCard(stat)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      setVisibility('hidden')
      await live()
      expect(stats).toHaveBeenCalledTimes(1)
    })

    it('a load already in flight is not doubled', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      stats.mockImplementationOnce(async () => {
        await gate
        return resp(1, true)
      })
      await mountCard(stat)
      await vi.advanceTimersByTimeAsync(20_000)
      await live()
      expect(stats).toHaveBeenCalledTimes(1)
      release()
      await settle()
    })

    it('after unmount, no refetch', async () => {
      const w = await mountCard(stat)
      w.unmount()
      wrapper = null
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(1)
    })
  })

  describe('a live refetch is quiet', () => {
    it('shows no "Loading…" while pending, and a failure keeps the chart on screen', async () => {
      const w = await mountCard(stat)
      expect(w.text()).toContain('5')
      let reject!: (e: Error) => void
      stats.mockImplementationOnce(() => new Promise((_r, rj) => (reject = rj)))
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(2)
      expect(w.text()).not.toContain('Loading')
      expect(w.find('.state').exists()).toBe(false)
      reject(new Error('network down'))
      await settle()
      expect(w.find('.state.error').exists()).toBe(false)
      expect(w.text()).toContain('5')
    })

    it('a successful refetch swaps in the new numbers', async () => {
      const w = await mountCard(stat)
      stats.mockImplementationOnce(async () => resp(321, true))
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(w.text()).toContain('321')
    })
  })

  // The editor saves a NEW widget object with the same id: the card stays mounted. A response's
  // `liveSafe` answers only the request it was fetched for, so any change to the request must drop
  // the flag until a response for the new request arrives flagged. These pin the review of PR #93
  // (S1-1): the ping used to refetch the edited, refused-capable request on the old flag.
  describe('the flag belongs to the request it answered', () => {
    const geo: Widget = { ...stat, type: 'doughnut' as never, dimension: 'region', breakdown: 'device', limit: 10 }
    // The server's side: a query that can reach a refused row (keyEvent lifts the exclusion) or any
    // dataset but geo comes back unflagged.
    const refusedCapable = (w: Widget) =>
      w.dataset !== 'geo' ||
      (w.rings ?? []).includes('keyEvent') ||
      w.breakdown === 'keyEvent' ||
      (w.type !== 'map' && w.dimension === 'keyEvent')
    beforeEach(() => {
      stats.mockImplementation(async (w) => resp(5, refusedCapable(w) ? undefined : true))
    })
    async function editThenPing(before: Widget, after: Widget) {
      const w = await mountCard(before)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await w.setProps({ widget: after })
      await settle()
      const afterEdit = stats.mock.calls.length
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      return { afterEdit, afterPing: stats.mock.calls.length }
    }

    it('adding a keyEvent ring: the ping does not refetch the new, refused-capable request', async () => {
      const { afterEdit, afterPing } = await editThenPing(geo, { ...geo, rings: ['keyEvent'] })
      expect(afterPing).toBe(afterEdit)
    })

    it('changing the type from map to bar (a stored keyEvent dimension now reaches the query): no refetch on the ping', async () => {
      const map: Widget = { ...geo, type: 'map', dimension: 'keyEvent', breakdown: undefined }
      const { afterEdit, afterPing } = await editThenPing(map, { ...map, type: 'bar' })
      expect(afterPing).toBe(afterEdit)
    })

    it('changing the dataset: no refetch on the ping (only /api/geo answers are ever flagged)', async () => {
      const { afterEdit, afterPing } = await editThenPing(geo, { ...geo, dataset: 'popup' })
      expect(afterPing).toBe(afterEdit)
    })

    it('a request field that is NOT in the reload key still drops the flag (fail-closed by construction)', async () => {
      const { afterEdit, afterPing } = await editThenPing(geo, { ...geo, campaignIds: ['1'] })
      expect(afterEdit).toBe(1) // no reload for this edit: only the flag clearing protects the ping
      expect(afterPing).toBe(afterEdit)
    })

    it('a page filter change that is still loading (a hung response) is not doubled by the ping', async () => {
      const w = await mountCard(geo)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      stats.mockImplementation(() => new Promise(() => {}))
      await w.setProps({ filters: { ...filters, drill: [{ key: 'device', value: 'mobile', label: 'mobile' }] } })
      await settle()
      expect(stats).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(2)
    })

    it('after an edit, the NEW response flags the card again and live refetching resumes', async () => {
      const { afterEdit, afterPing } = await editThenPing(geo, { ...geo, limit: 20 })
      expect(afterEdit).toBe(2) // the edit reloaded (limit is in the reload key) and came back flagged
      expect(afterPing).toBe(3)
    })

    it('moving or resizing the card, or renaming it, keeps the flag (not part of the request)', async () => {
      const { afterEdit, afterPing } = await editThenPing(geo, { ...geo, x: 6, y: 2, w: 6, h: 5, title: 'Renamed', caption: 'new' })
      expect(afterEdit).toBe(1)
      expect(afterPing).toBe(2)
    })

    it('an edit that is undone before the ping still needs a new response', async () => {
      const w = await mountCard(geo)
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      stats.mockImplementation(() => new Promise(() => {})) // the edited request never answers
      await w.setProps({ widget: { ...geo, rings: ['keyEvent'] } })
      await settle()
      await w.setProps({ widget: geo })
      await settle()
      const n = stats.mock.calls.length
      await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
      await live()
      expect(stats).toHaveBeenCalledTimes(n)
    })
  })
})
