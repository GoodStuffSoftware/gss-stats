// @vitest-environment happy-dom
//
// ChartCard with a metric card (Widget.card, CONFIG_VERSION 10): it renders MetricCard instead of
// the bespoke Overview body, sends the page context (the filter bar's range and sites, or the
// widget's own override) and follows it as it changes, wires its own ↻ to the card's reload,
// and keeps zoom and reveal like every other chart.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import { __resetMetricsStateForTests } from '../composables/useMetrics'
import type { GlobalFilters, Widget } from '../types'
import type { MetricsRequestBody } from '../lib/metrics/types'

const bodies: MetricsRequestBody[] = []
const mounted: VueWrapper[] = []
beforeEach(() => {
  __resetMetricsStateForTests()
  bodies.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (!String(url).includes('/api/metrics')) throw new Error(`unexpected fetch ${url}`)
      const body = JSON.parse(init.body as string) as MetricsRequestBody
      bodies.push(body)
      const results = Object.fromEntries(body.requests.map((r) => [r.key, { status: 'ok', value: 42 }]))
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})
async function settle() {
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 15))
  }
}

const filters: GlobalFilters = { siteSel: [], since: '2026-09-20T04:00:00.000Z', until: '2026-09-27T04:00:00.000Z', excludeSelfReferrals: false, excludeOwnVisits: true, ownBrowser: 'Firefox', ownOS: 'Linux' }
const kpiWidget: Widget = { id: 'ow-kpis', i: 'ow-kpis', title: 'Today at a glance', type: 'table', dataset: 'overview', view: 'kpis', card: { preset: 'bsk-kpis' }, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 12, h: 8 }
function mountCard(widget: Widget = kpiWidget, f: GlobalFilters = filters) {
  const w = mount(ChartCard, { props: { widget, filters: f, dark: false, drillOpen: false }, attachTo: document.body })
  mounted.push(w)
  return w
}

describe('ChartCard × metric card', () => {
  it('renders MetricCard (not the bespoke body), with the page range as the metrics context', async () => {
    const w = mountCard()
    await settle()
    expect(w.find('.metric-card-plain').exists()).toBe(true)
    expect(w.find('.kpi-grid').exists()).toBe(false)
    expect(bodies[0].context).toEqual({ since: filters.since, until: filters.until })
    expect(JSON.stringify(bodies[0].context)).not.toMatch(/Firefox|Linux|excludeOwn/) // no own-visit fields
  })

  it('follows a filter-bar change: one new batch with the new range', async () => {
    const w = mountCard()
    await settle()
    const before = bodies.length
    await w.setProps({ filters: { ...filters, since: '2026-09-01T04:00:00.000Z' } })
    await settle()
    expect(bodies.length).toBe(before + 1)
    expect(bodies[before].context?.since).toBe('2026-09-01T04:00:00.000Z')
  })

  it('caps an over-long range at the server limit instead of failing the batch', async () => {
    mountCard(kpiWidget, { ...filters, since: '2020-01-01T00:00:00.000Z' })
    await settle()
    const { since, until } = bodies[0].context!
    expect(Date.parse(until!) - Date.parse(since!)).toBeLessThanOrEqual(399 * 86_400_000)
  })

  it("one reload control per card: the scorecard (no freshness line) uses the header's ↻, which reloads the card", async () => {
    const w = mountCard({ ...kpiWidget, id: 'ow-scorecard', i: 'ow-scorecard', view: 'scorecard', card: { preset: 'campaign-scorecard' } })
    await settle()
    expect(w.findAll('button[title="Reload"]')).toHaveLength(1)
    expect(w.find('button.mc-reload').exists()).toBe(false)
    await w.find('button[title="Reload"]').trigger('click')
    await settle()
    expect(bodies.some((b) => b.fresh === true)).toBe(true)
  })

  it("one reload control per card: the KPI card shows its own \"Updated ↻\", so the header's ↻ is hidden", async () => {
    const w = mountCard()
    await settle()
    expect(w.find('button[title="Reload"]').exists()).toBe(false)
    expect(w.findAll('button.mc-reload')).toHaveLength(1)
    await w.find('button.mc-reload').trigger('click')
    await settle()
    expect(bodies.some((b) => b.fresh === true)).toBe(true)
  })

  it("an untitled card's Notes toggle is named after the widget", async () => {
    const w = mountCard()
    await settle()
    expect(w.find('button.mc-notes-toggle').attributes('aria-label')).toBe('Notes: Today at a glance')
  })

  it('keeps zoom and reveal, and has no per-chart filter button', async () => {
    const w = mountCard()
    await settle()
    expect(w.find('.zoom-btn').exists()).toBe(true)
    expect(w.find('.reveal-btn').exists()).toBe(true)
    expect(w.find('button[title="Filter this chart"]').exists()).toBe(false)
    await w.find('.zoom-btn').trigger('click')
    await settle()
    // The zoomed card may be moved (teleported) out of the wrapper: look in the document.
    expect(document.querySelector('.zoom-btn[aria-label="Zoom out"]')).not.toBeNull()
    expect(document.querySelector('.metric-card-plain')).not.toBeNull() // still the card, zoomed
  })

  it('the scorecard card forwards its click-through as open-campaigns', async () => {
    const w = mountCard({ ...kpiWidget, id: 'ow-scorecard', i: 'ow-scorecard', view: 'scorecard', card: { preset: 'campaign-scorecard' } })
    await settle()
    await w.find('button.mc-title-link').trigger('click')
    expect(w.emitted('open-campaigns')).toBeTruthy()
  })

  it('an invalid saved card shows a short message, not a crash', async () => {
    const w = mountCard({ ...kpiWidget, card: { preset: 'invalid-card' } })
    await settle()
    expect(w.find('.metric-card-error').text()).toMatch(/could not be read/)
  })
})
