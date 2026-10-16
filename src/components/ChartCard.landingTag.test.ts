// @vitest-environment happy-dom
//
// The Flight 3 Apps hero-vs-features donut card: while the arm is staged (no registered campaign
// carries the landing tags) it says "Flight 3 isn't live yet" and sends NO query; once a campaign
// carries them it fetches and draws the donut. Made-up data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import { sitesLoaded } from '../sitesStore'
import { CAMPAIGNS, type CampaignFlight } from '../lib/campaigns'
import { f3HeroDonutWidget } from '../lib/defaults'
import { hideLiveFlight3 } from '../testing/stagedFlight3'
import { F3_APPS_FEATURES_TAG, F3_APPS_HERO_TAG, LANDING_NOT_LIVE_TEXT, LANDING_TAG_NOTE } from '../lib/landingTags'
import type { GlobalFilters, StatsResponse } from '../types'

const fetchStatsMock = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: fetchStatsMock }
})

const real = CAMPAIGNS.slice()
const live: CampaignFlight = {
  id: 'F3-TEST', label: 'F3 test', ucValues: [F3_APPS_HERO_TAG, F3_APPS_FEATURES_TAG], flightStart: '2026-10-10', flightEnd: '2026-10-16', status: 'active', kind: 'web', notes: 'test',
}
const resp = (rows: [string, number][]): StatsResponse => ({
  rows: rows.map(([tag, n]) => ({ key: { landingTag: tag }, pageviews: n, visits: n })),
  totals: { pageviews: rows.reduce((t, r) => t + r[1], 0), visits: 0 },
  meta: { site: 'all', host: null, since: '2026-10-13', until: '2026-10-13', dimensions: ['landingTag'], metric: 'pageviews' },
})
const filters: GlobalFilters = { siteSel: [], since: '2026-10-01', until: '2026-10-16', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
const widget = () => f3HeroDonutWidget({ x: 0, y: 0, w: 6, h: 10 })

// The staged state is pinned with flight 3 hidden, so filling STAGED_FLIGHT_3_DATES never turns these red.
let restoreFlight3: () => void
beforeEach(() => {
  restoreFlight3 = hideLiveFlight3()
  sitesLoaded.value = true
  fetchStatsMock.mockResolvedValue(resp([[F3_APPS_HERO_TAG, 6], [F3_APPS_FEATURES_TAG, 3]]))
})
afterEach(() => {
  fetchStatsMock.mockReset()
  CAMPAIGNS.splice(0, CAMPAIGNS.length, ...real)
  restoreFlight3()
})

const Stub = defineComponent({ props: ['config'], emits: ['point'], methods: { suppressForDrill() {} }, template: '<div class="chart-stub" />' })
async function card() {
  const c = mount(ChartCard, { props: { widget: widget(), filters, dark: false, drillOpen: false }, global: { stubs: { BaseChart: Stub } } })
  await flushPromises()
  return c
}

describe('ChartCard: Flight 3 hero-vs-features donut', () => {
  it('while the arm is staged it shows "Flight 3 isn\'t live yet", keeps the note, draws no chart and sends no query', async () => {
    const c = await card()
    expect(LANDING_NOT_LIVE_TEXT).toBe("Flight 3 isn't live yet")
    expect(c.text()).toContain("Flight 3 isn't live yet")
    expect(c.text()).toContain(LANDING_TAG_NOTE)
    expect(c.findComponent(Stub).exists()).toBe(false)
    expect(c.text()).not.toContain('Loading')
    expect(fetchStatsMock).not.toHaveBeenCalled()
  })

  it('a reload and a filter change while staged still send nothing', async () => {
    const c = await card()
    await c.setProps({ filters: { ...filters, since: '2026-10-05' } })
    await c.get('button[title="Reload"]').trigger('click')
    await flushPromises()
    expect(fetchStatsMock).not.toHaveBeenCalled()
  })

  it('once a registered campaign carries the tags it fetches once and draws the donut with count and share legend', async () => {
    CAMPAIGNS.splice(0, CAMPAIGNS.length, live)
    const c = await card()
    expect(fetchStatsMock).toHaveBeenCalledTimes(1)
    expect(c.text()).not.toContain("isn't live yet")
    const cfg = (c.findComponent(Stub).props('config') as any)
    expect(cfg.data.labels).toEqual(['No ads (hero) · 6 · 67%', 'Features · 3 · 33%'])
  })

  it('shows no cost, spend or impressions text, staged or live', async () => {
    expect((await card()).text()).not.toMatch(/cost|spend|impress|\$/i)
    CAMPAIGNS.splice(0, CAMPAIGNS.length, live)
    expect((await card()).text()).not.toMatch(/cost|spend|impress|\$/i)
  })

  it('live with no arrivals yet reads the ordinary "No data in range"', async () => {
    CAMPAIGNS.splice(0, CAMPAIGNS.length, live)
    fetchStatsMock.mockResolvedValue(resp([]))
    expect((await card()).text()).toContain('No data in range')
  })
})
