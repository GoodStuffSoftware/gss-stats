// @vitest-environment happy-dom
//
// ADR 0005 slice 3, step B2: a legacy Ads readings widget (dataset 'ads-readings', no card) is
// drawn by MetricCard with the readings-log preset, mapped at render time; a widget that already
// has a card renders as it always did; the stored widget is never written to.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import MetricCard from './metrics/MetricCard.vue'
import { __resetMetricsStateForTests } from '../composables/useMetrics'
import { __resetReturnRefreshForTests } from '../composables/useReturnRefresh'
import { fetchAdsReadings } from '../api'
import { CAMPAIGNS } from '../lib/campaigns'
import type { GlobalFilters, Widget } from '../types'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchAdsReadings: vi.fn() }
})
const mocked = vi.mocked(fetchAdsReadings)
const [X, Y] = [CAMPAIGNS[0].id, CAMPAIGNS[2].id]

const camp = (campaignId: string, asks: number) => ({
  campaignId,
  label: campaignId,
  status: 'active',
  spend: {},
  spendThrough: '2026-10-02',
  lastSync: '2026-10-03T11:30:00Z',
  stale: false,
  thresholdsFired: null,
  readings: [
    { v: 1, id: `r-${campaignId}`, campaignId, kind: 'daily', readAt: '2026-09-26T19:00:00Z', etDate: '2026-09-26', spendThroughEt: '2026-09-25', cumulativeSpend: 10, thresholds: [], complete: true, rules: null, proposal: null, decision: null, counts: { taggedArrivals: 1, asks, accepts: 2, authSuccess: 3, signUpsAtMost: 4, signUpsExact: 0 }, notes: [] },
  ],
})
const response = () => ({ generatedAt: '2026-10-03T12:00:00Z', storeBound: true, storeReadable: true, campaigns: [camp(X, 111), camp(Y, 222)], syncAlerts: [] }) as never

const filters: GlobalFilters = { siteSel: [], since: '2026-09-20T00:00:00.000Z', until: '2026-09-27T00:00:00.000Z', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
const legacy = (over: Partial<Widget> = {}): Widget => ({ id: 'ar', i: 'ar', title: 'Ads readings', type: 'table', dataset: 'ads-readings', view: 'log', dimension: '', metric: 'pageviews', limit: 30, x: 0, y: 0, w: 12, h: 10, ...over })

const mounted: VueWrapper[] = []
async function mountCard(widget: Widget) {
  const w = mount(ChartCard, { props: { widget, filters, dark: false, drillOpen: false }, attachTo: document.body })
  mounted.push(w)
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 10))
  }
  return w
}
beforeEach(() => {
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  mocked.mockReset()
  mocked.mockResolvedValue(response())
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } }) }))
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})

describe('ChartCard maps a legacy ads-readings widget onto the readings-log card', () => {
  it('renders MetricCard with the preset, and shows every campaign with a reading', async () => {
    const w = await mountCard(legacy())
    const mc = w.findComponent(MetricCard)
    expect(mc.exists()).toBe(true)
    expect(mc.props('cardRef')).toEqual({ preset: 'ads-readings-log' })
    expect(w.text()).toContain('111')
    expect(w.text()).toContain('222')
  })
  it('passes campaignIds, so the readings narrow to the chosen campaign', async () => {
    const w = await mountCard(legacy({ campaignIds: [X] }))
    expect(w.findComponent(MetricCard).props('campaignIds')).toEqual([X])
    expect(w.text()).toContain('111')
    expect(w.text()).not.toContain('222')
  })
  it('honours the widget limit through an inline clone, leaving the stored widget untouched', async () => {
    const widget = legacy({ limit: 50, view: 'something-later' })
    const frozen = JSON.stringify(widget)
    const w = await mountCard(widget)
    const ref = w.findComponent(MetricCard).props('cardRef') as { spec: { sections: { repeat?: { over: string; limit?: number } }[] } }
    expect(ref.spec.sections.find((s) => s.repeat?.over === 'readings')?.repeat?.limit).toBe(50)
    expect(JSON.stringify(widget)).toBe(frozen)
  })
  it('a widget that already has a card is rendered with that card', async () => {
    const w = await mountCard(legacy({ card: { preset: 'campaign-scorecard' } }))
    expect(w.findComponent(MetricCard).props('cardRef')).toEqual({ preset: 'campaign-scorecard' })
  })
})
