// @vitest-environment happy-dom
//
// A date chart over a range the server cut (the reported "Jan 1 - Sep 30" Overview range) draws
// only the days that were served. These tests run the REAL /api/stats handler (Cloudflare's
// GraphQL endpoint stubbed) and feed its response to the chart code, so they cover the contract
// between the two: the response's `meta` is the axis the chart builds. Before the fix `meta`
// kept the requested range, and the chart zero-filled ~180 days nobody queried, under a note
// saying only the last 93 were shown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import { sitesLoaded } from '../sitesStore'
import { buildChartConfig, buildSeriesLineConfig, seriesRows } from '../lib/charts'
import { itemsInRange, overlayItems } from '../lib/timelineOverlay'
import type { GlobalFilters, StatsResponse, Widget } from '../types'
import { onRequestPost } from '../../functions/api/stats'
import { installCaches, memoryCache, pagesContext, postJson } from '../../functions/_lib/testing/hitsDb'

const NOW = Date.parse('2026-10-03T16:00:00Z')
// Requested Jan 1 - Sep 30; served (93 d ending Oct 1 00:00Z, on a UTC day) Jun 30 - Sep 30.
const SERVED_FIRST = '2026-06-30'
const SERVED_DAYS = 93

const fetchStatsMock = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: fetchStatsMock }
})

let undoCaches: () => void
let dateRows: { date: string; count: number }[]

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
  dateRows = [
    { date: '2026-07-05', count: 10 },
    { date: '2026-09-30', count: 7 },
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const s0 = dateRows.map((r) => ({ count: r.count, sum: { visits: 1 }, dimensions: { date: r.date } }))
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{ s0, s1: [], s2: [] }] } }, errors: null }), { status: 200 })
    }),
  )
  sitesLoaded.value = true
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  undoCaches()
})

/** What the browser would get from POST /api/stats for a `date` chart, via the real handler. */
async function serve(since: string, until: string): Promise<StatsResponse> {
  const waited: Promise<unknown>[] = []
  const req = postJson('/api/stats', { site: 'all', dimensions: ['date'], metric: 'pageviews', limit: 500, since, until })
  const res = await onRequestPost(pagesContext(req, { CF_ANALYTICS_TOKEN: 'test-token-not-real', STATS_CONFIG: {} as KVNamespace }, waited))
  await Promise.all(waited)
  return (await res.json()) as StatsResponse
}

const widget = (over: Partial<Widget> = {}): Widget => ({
  id: 'w1',
  i: 'w1',
  title: 'Pageviews per day',
  type: 'line',
  dimension: 'date',
  metric: 'pageviews',
  limit: 500,
  x: 0,
  y: 0,
  w: 12,
  h: 8,
  ...over,
})

const filters: GlobalFilters = { siteSel: [], since: '2026-01-01', until: '2026-09-30', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }

describe('date chart over a clamped /api/stats range', () => {
  it('seriesRows draws only the served days (was 273 points, 272 of them zero)', async () => {
    const resp = await serve('2026-01-01', '2026-09-30')
    expect(resp.notice).toMatchObject({ reason: 'both' })
    const rows = seriesRows('date', resp)
    expect(rows).toHaveLength(SERVED_DAYS)
    expect(rows[0].key.date).toBe(SERVED_FIRST)
    expect(rows[rows.length - 1].key.date).toBe('2026-09-30')
    expect(rows.reduce((a, r) => a + r.pageviews, 0)).toBe(17) // every served row is in the axis
  })

  it('an unclamped range still zero-fills exactly the requested days', async () => {
    const resp = await serve('2026-09-01', '2026-09-30')
    expect(resp.notice).toBeUndefined()
    expect(seriesRows('date', resp)).toHaveLength(30)
  })

  it('a bar/line chart config plots the served days only', async () => {
    const resp = await serve('2026-01-01', '2026-09-30')
    const cfg = buildChartConfig(widget(), resp, undefined, filters)!
    expect(cfg.data.labels).toHaveLength(SERVED_DAYS)
    expect(cfg.data.datasets[0].data).toHaveLength(SERVED_DAYS)
  })

  it('a series line chart whose series has no traffic in the served window plots the served days, not the requested ones', async () => {
    dateRows = [] // a series with nothing in the window: no leading zeros to trim, so the axis is the whole range
    const resp = await serve('2026-01-01', '2026-09-30')
    const w = widget({ dataset: 'geo', series: [{ label: 'installs', filter: [{ field: 'keyEvent', value: 'install' }] }] as Widget['series'] })
    const cfg = buildSeriesLineConfig(w, [resp])!
    expect(cfg.data.labels).toHaveLength(SERVED_DAYS)
  })

  it('the card lists overlay markers only for the days the chart plots', async () => {
    // The overlay items (releases, go-lives, flights) begin on Aug 31 2026, so look from Dec 20:
    // "Jun 1 - Dec 16" is cut to the 93 days from Sep 15, and everything before it was never queried.
    vi.setSystemTime(Date.parse('2026-12-20T16:00:00Z'))
    const asked = { ...filters, since: '2026-06-01', until: '2026-12-16' }
    const all = overlayItems({ releases: true, goLive: true, flights: true })
    const inServed = itemsInRange(all, '2026-09-15', '2026-12-16')
    const inRequested = itemsInRange(all, '2026-06-01', '2026-12-16')
    expect(inServed.length).toBeGreaterThan(0)
    expect(inRequested.length).toBeGreaterThan(inServed.length) // else the check below proves nothing

    fetchStatsMock.mockImplementation(async () => serve('2026-06-01', '2026-12-16'))
    const Stub = defineComponent({ props: ['config'], template: '<div class="chart-stub" />' })
    const w = mount(ChartCard, {
      props: { widget: widget({ dataset: 'rum', markers: 'releases', goLiveMarkers: true, flightBands: true }), filters: asked, dark: false, drillOpen: false },
      global: { stubs: { BaseChart: Stub } },
    })
    await flushPromises()
    expect(w.get('.overlay-list summary').text()).toBe(`Markers and bands (${inServed.length})`)
    // and the chart itself got the served axis
    expect(w.findComponent(Stub).props('config').data.labels).toHaveLength(SERVED_DAYS)
  })
})
