// @vitest-environment happy-dom
//
// FeatureHealthCard and the step chart config, with fetch stubbed and made-up data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import FeatureHealthCard from './FeatureHealthCard.vue'
import { featureHealthWidget, defaultFeaturesWidgets } from '../lib/defaults'
import { buildStepChartConfig } from '../lib/featureHealthChart'
import { HEALTH_CAPTION, stepsViewFor, featureIdOfView, type FeatureHealth, type FeatureHealthModel } from '../lib/featureHealth'
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
async function mountCard(view: string) {
  const widget = { ...featureHealthWidget({ x: 0, y: 0, w: 12, h: 20 }), view, siteSel: ['made-up-site-' + view] }
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
    for (const w of defaultFeaturesWidgets()) {
      expect(w.dataset).toBe('features')
      expect(featureIdOfView(w.view)).toBeTruthy()
    }
  })
})
