// @vitest-environment happy-dom
//
// FeatureHealthCard and the step chart config, with fetch stubbed and made-up data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import FeatureHealthCard from './FeatureHealthCard.vue'
import { featureHealthWidget, defaultFeaturesWidgets } from '../lib/defaults'
import { buildStepChartConfig } from '../lib/featureHealthChart'
import { HEALTH_CAPTION, stepsViewFor, featureIdOfView, type FeatureHealth, type FeatureHealthModel } from '../lib/featureHealth'
import { COACH_TIPS_CAPTION, COACH_TIPS_EMPTY_NOTE, COACH_TIPS_VIEW } from '../lib/coachTips'
import type { GlobalFilters } from '../types'

const feature: FeatureHealth = {
  id: 'made-up',
  label: 'Made-up feature',
  blurb: 'A made-up blurb.',
  status: 'silent',
  statusNote: 'averaged 9 a day, none yesterday',
  latest: 0,
  prev: 9,
  range: 20,
  steps: [
    { id: 'shown', label: 'Shown', latest: 0, prev: 9, range: 20, perDay: [5, 6, 9, 0] },
    { id: 'tapped', label: 'Tapped', latest: 0, prev: 3, range: 8, perDay: [1, 2, 3, 0], ratio: { label: 'tapped per shown', latest: null, prev: 0.33, range: 0.4 } },
  ],
}
const model: FeatureHealthModel & { meta: Record<string, string> } = {
  days: ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'],
  latestDay: '2026-10-14',
  prevDay: '2026-10-13',
  features: [feature],
  meta: { since: '2026-10-11', until: '2026-10-14', rangeFrom: '2026-10-11', rangeTo: '2026-10-14', sites: '', today: '2026-10-15' },
}
const filters: GlobalFilters = { siteSel: [], since: '2026-10-11T04:00:00.000Z', until: '2026-10-15T04:00:00.000Z', excludeSelfReferrals: false, excludeOwnVisits: true, ownBrowser: 'Firefox', ownOS: 'Linux' }

const mounted: VueWrapper[] = []
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => model, text: async () => '' })))
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  vi.unstubAllGlobals()
})
let uniq = 0
async function mountCard(view: string) {
  // A distinct site selection per mount, so the shared in-flight request (api.ts) never crosses tests.
  const widget = { ...featureHealthWidget({ x: 0, y: 0, w: 12, h: 20 }), view, siteSel: ['made-up-site-' + view + '-' + ++uniq] }
  const w = mount(FeatureHealthCard, { props: { widget, filters, dark: false }, global: { stubs: { BaseChart: true } } })
  mounted.push(w)
  await flushPromises()
  return w
}

describe('FeatureHealthCard', () => {
  it('renders a row per feature with the status badge and the caption', async () => {
    const w = await mountCard('health')
    const row = w.find('tr[data-feature="made-up"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('Made-up feature')
    expect(row.text()).toContain('Went silent')
    expect(row.text()).toContain('Shown')
    expect(w.find('[data-testid="feature-health-caption"]').text()).toBe(HEALTH_CAPTION)
  })

  it('shows a dash for a zero-denominator ratio', async () => {
    const w = await mountCard('health')
    expect(w.find('tr[data-feature="made-up"]').text()).toContain('— · 0.33 · 0.40')
  })

  it('renders a step view as a chart with the status badge and no table', async () => {
    const w = await mountCard(stepsViewFor('made-up'))
    expect(w.find('table').exists()).toBe(false)
    expect(w.find('.fh-chart[data-feature="made-up"]').text()).toContain('Went silent')
  })
})

describe('step chart and defaults', () => {
  it('builds one dataset per step and one label per day', () => {
    const cfg = buildStepChartConfig(model, feature)
    expect(cfg.data.datasets.map((d) => d.label)).toEqual(['Shown', 'Tapped'])
    expect(cfg.data.labels).toHaveLength(4)
    expect(cfg.data.datasets[0].data).toEqual([5, 6, 9, 0])
  })

  it('maps feature ids to step views and back; the Features page has a chart per feature', () => {
    expect(featureIdOfView(stepsViewFor('abc'))).toBe('abc')
    expect(featureIdOfView('health')).toBeNull()
    const widgets = defaultFeaturesWidgets()
    for (const w of widgets.filter((x) => x.view !== COACH_TIPS_VIEW)) {
      expect(w.dataset).toBe('features')
      expect(featureIdOfView(w.view)).toBeTruthy()
    }
    // The Coach tips table sits under the charts, full width, and appears once.
    const tips = widgets.filter((x) => x.view === COACH_TIPS_VIEW)
    expect(tips).toHaveLength(1)
    expect(tips[0]).toMatchObject({ dataset: 'features', x: 0, w: 12, excludeKnownTraffic: true })
    expect(tips[0].y).toBeGreaterThanOrEqual(Math.max(...widgets.filter((x) => x !== tips[0]).map((x) => x.y + x.h)))
  })
})

describe('Coach tips card', () => {
  const coachFeature = (id: string, label: string, shown: [number, number], dismissed: [number, number], closed: [number, number]): FeatureHealth => ({
    id: `tip-${id}`,
    label,
    blurb: `The ${id} tip.`,
    status: 'ok',
    statusNote: '',
    latest: 0,
    prev: 0,
    range: 0,
    steps: [
      { id: 'shown', label: 'Shown', latest: shown[0], prev: 0, range: shown[1], perDay: [] },
      { id: 'dismissed', label: 'Dismissed', latest: dismissed[0], prev: 0, range: dismissed[1], perDay: [], ratio: { label: 'dismissed per shown', latest: shown[0] ? dismissed[0] / shown[0] : null, prev: null, range: shown[1] ? dismissed[1] / shown[1] : null } },
      { id: 'closed', label: 'Closed while showing', latest: closed[0], prev: 0, range: closed[1], perDay: [], ratio: { label: 'closed while showing per shown', latest: shown[0] ? closed[0] / shown[0] : null, prev: null, range: shown[1] ? closed[1] / shown[1] : null } },
    ],
  })
  const opened: FeatureHealth = {
    id: 'tour-opened',
    label: 'Show me around',
    blurb: 'Taps on "Show me around".',
    status: 'ok',
    statusNote: '',
    latest: 0,
    prev: 0,
    range: 0,
    steps: [{ id: 'opened', label: 'Opened', latest: 4, prev: 0, range: 9, perDay: [] }],
  }
  const coachModel = (everSeen: boolean) => ({
    ...model,
    everSeen,
    features: [coachFeature('place', 'Place', [10, 40], [5, 10], [2, 8]), coachFeature('hint', 'Hint', [0, 0], [0, 0], [0, 0]), opened],
  })
  const mountCoach = async (m: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => m, text: async () => '' })))
    return mountCard(COACH_TIPS_VIEW)
  }

  it('asks the features endpoint for the coach-tips view and nothing split by hour, place or device', async () => {
    await mountCoach(coachModel(true))
    const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.view).toBe(COACH_TIPS_VIEW)
    expect(Object.keys(body).sort()).toEqual(['excludeKnownTraffic', 'excludeOwnVisits', 'ownBrowser', 'ownOS', 'since', 'sites', 'until', 'view'])
  })

  it('draws a row per tip with counts, ratios and a dash for a zero denominator, and the tour total apart', async () => {
    const w = await mountCoach(coachModel(true))
    const place = w.find('tr[data-tip="tip-place"]')
    expect(place.find('[data-col="latest-shown"]').text()).toBe('10')
    expect(place.find('[data-col="range-shown"]').text()).toBe('40')
    expect(place.find('[data-col="latest-dismissed"]').text()).toBe('5')
    expect(place.find('[data-col="latest-closed"]').text()).toBe('2')
    expect(place.find('[data-col="latest-dismissed-ratio"]').text()).toBe('0.50')
    expect(place.find('[data-col="range-closed-ratio"]').text()).toBe('0.20')
    const hint = w.find('tr[data-tip="tip-hint"]')
    expect(hint.find('[data-col="latest-dismissed-ratio"]').text()).toBe('—')
    expect(hint.find('[data-col="range-closed-ratio"]').text()).toBe('—')
    const tour = w.find('tr[data-tip="tour-opened"]')
    expect(tour.find('[data-col="latest-opened"]').text()).toBe('4')
    expect(tour.find('[data-col="range-opened"]').text()).toBe('9')
    expect(w.findAll('tr[data-tip]').map((r) => r.attributes('data-tip'))).toEqual(['tip-place', 'tip-hint', 'tour-opened'])
    expect(w.find('[data-testid="coach-tips-caption"]').text()).toBe(COACH_TIPS_CAPTION)
  })

  it('says the game version has not shipped while no coach row has ever arrived', async () => {
    const w = await mountCoach(coachModel(false))
    expect(w.find('[data-testid="coach-tips-empty"]').text()).toBe(COACH_TIPS_EMPTY_NOTE)
    expect(w.find('[data-testid="coach-tips-empty"]').text()).toContain('No coach data yet')
  })

  it('shows no such note once rows exist', async () => {
    const w = await mountCoach(coachModel(true))
    expect(w.find('[data-testid="coach-tips-empty"]').exists()).toBe(false)
  })
})
