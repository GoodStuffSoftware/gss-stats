// @vitest-environment happy-dom
//
// Caption display on a card (Widget.captionDisplay, lib/captionDisplay.ts): the notes under a chart
// (its caption plus the notes the data brings), and a metric card's own captions, fold with a
// "Show more" button in 'collapsible' and (past the length threshold) 'auto'. A widget saved with no
// value renders exactly as before. happy-dom does no layout, so a stub reports a tall text element
// that is 32px once folded, as a browser does for text that runs past two lines.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import MetricCard from './metrics/MetricCard.vue'
import { __resetMetricsStateForTests } from '../composables/useMetrics'
import { CAPTION_AUTO_CHARS } from '../lib/captionDisplay'
import { noteTemplate } from '../lib/notes'
import { PRESETS } from '../lib/metrics/presets'
import type { CardSpec, MetricsResponseBody } from '../lib/metrics/types'
import type { GlobalFilters, StatsResponse, Widget } from '../types'

const fetchStatsMock = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: fetchStatsMock }
})

const proto = HTMLElement.prototype as unknown as Record<string, unknown>
const saved = { scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'), clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight') }
const mounted: VueWrapper[] = []
beforeEach(() => {
  fetchStatsMock.mockReset()
  __resetMetricsStateForTests()
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 100 })
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains('cc-folded') ? 32 : 100
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { requests: { key: string }[] }
      const results: MetricsResponseBody['results'] = {}
      for (const r of body.requests) results[r.key] = { status: 'ok', value: 42 }
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  for (const [k, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(proto, k, d)
    else delete proto[k]
  }
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})

const filters: GlobalFilters = { siteSel: [], since: '2026-09-01', until: '2026-09-30', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
const widget = (over: Partial<Widget> = {}): Widget => ({
  id: 'w1',
  i: 'w1',
  title: 'Countries',
  type: 'table',
  dataset: 'geo',
  dimension: 'country',
  metric: 'pageviews',
  limit: 10,
  x: 0,
  y: 0,
  w: 6,
  h: 6,
  ...over,
})
const response = (extra: Partial<StatsResponse> = {}): StatsResponse => ({
  rows: [{ key: { country: 'US' }, pageviews: 3000, visits: 900 }],
  totals: { pageviews: 3000, visits: 900 },
  meta: { site: 'all', host: null, since: '2026-09-01', until: '2026-09-30', dimensions: ['country'], metric: 'pageviews' },
  ...extra,
})
async function mountCard(over: Partial<Widget>) {
  const w = mount(ChartCard, { props: { widget: widget(over), filters, dark: false, drillOpen: false }, attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  await flushPromises()
  return w
}
const LONG = 'Counts every visit, once per device per day, and leaves out our own browsers. '.repeat(4).trim() // over 250
const MID = 'Counts every visit, once per device per day.' // well under 250
const toggle = (w: VueWrapper) => w.find('[data-testid="caption-toggle"]')
const region = (w: VueWrapper) => w.get('.card-captions [data-testid="caption-body"]')

describe('ChartCard: the notes under a chart follow captionDisplay', () => {
  it('a widget with no value shows a long caption in full, with no button (as saved before the option)', async () => {
    fetchStatsMock.mockResolvedValue(response())
    const w = await mountCard({ caption: LONG })
    expect(LONG.length).toBeGreaterThan(CAPTION_AUTO_CHARS)
    expect(region(w).classes()).not.toContain('cc-folded')
    expect(region(w).classes()).not.toContain('cc-folding')
    expect(toggle(w).exists()).toBe(false)
    expect(w.get('.card-captions .note-block').text()).toBe(LONG)
  })

  it("'always' is the same as no value", async () => {
    fetchStatsMock.mockResolvedValue(response())
    const w = await mountCard({ caption: LONG, captionDisplay: 'always' })
    expect(region(w).classes()).not.toContain('cc-folded')
    expect(toggle(w).exists()).toBe(false)
  })

  it("'collapsible' folds the caption, and Show more / Show less open and fold it in place", async () => {
    fetchStatsMock.mockResolvedValue(response())
    const w = await mountCard({ caption: LONG, captionDisplay: 'collapsible' })
    expect(region(w).classes()).toContain('cc-folded')
    expect(toggle(w).text()).toBe('Show more')
    expect(toggle(w).attributes('aria-expanded')).toBe('false')
    await toggle(w).trigger('click')
    expect(region(w).classes()).not.toContain('cc-folded')
    expect(toggle(w).text()).toBe('Show less')
    expect(toggle(w).attributes('aria-expanded')).toBe('true')
    expect(w.get('.card-captions .note-block').text()).toBe(LONG) // the same element, the full text
    await toggle(w).trigger('click')
    expect(region(w).classes()).toContain('cc-folded')
  })

  it("'auto' leaves a short caption alone and folds a long one", async () => {
    fetchStatsMock.mockResolvedValue(response())
    const short = await mountCard({ caption: MID, captionDisplay: 'auto' })
    expect(region(short).classes()).not.toContain('cc-folded')
    expect(toggle(short).exists()).toBe(false)
    const long = await mountCard({ caption: LONG, captionDisplay: 'auto' })
    expect(region(long).classes()).toContain('cc-folded')
    expect(toggle(long).exists()).toBe(true)
  })

  it('the notes under it count with the caption: a short caption plus a long data note folds under auto, and shows in full under always', async () => {
    const dataNote = 'This count leaves out visits from devices we could not place, so it reads a little low. '.repeat(3).trim()
    fetchStatsMock.mockResolvedValue(response({ note: dataNote }))
    expect(MID.length).toBeLessThan(CAPTION_AUTO_CHARS)
    expect(MID.length + dataNote.length).toBeGreaterThan(CAPTION_AUTO_CHARS)
    const auto = await mountCard({ caption: MID, captionDisplay: 'auto' })
    expect(auto.findAll('.card-captions .note-block')).toHaveLength(2)
    expect(region(auto).classes()).toContain('cc-folded')
    expect(toggle(auto).exists()).toBe(true)
    const always = await mountCard({ caption: MID })
    expect(always.findAll('.card-captions .note-block')).toHaveLength(2)
    expect(toggle(always).exists()).toBe(false)
  })
})

describe('a metric card: its own captions and the release / measurement notes follow captionDisplay', () => {
  const NOW = Date.parse('2026-10-29T12:00:00Z')
  const spec = (captions: string[]): CardSpec => ({ ...JSON.parse(JSON.stringify(PRESETS['bsk-kpis'])), captions })
  function mountMetric(props: InstanceType<typeof MetricCard>['$props']) {
    const w = mount(MetricCard, { props, attachTo: document.body })
    mounted.push(w)
    return w
  }
  const measurement = noteTemplate('measurement-change-note')

  it("the measurement-change note is long enough for 'auto' (so a card showing it folds)", () => {
    expect(measurement.length).toBeGreaterThan(CAPTION_AUTO_CHARS)
  })

  it('no value shows every spec caption in full', async () => {
    const w = mountMetric({ cardRef: { spec: spec(['measurement-change-note', 'small-sample']) }, nowMs: NOW })
    await flushPromises()
    expect(w.find('.mc-captions').exists()).toBe(true)
    expect(w.find('[data-testid="caption-body"]').classes()).not.toContain('cc-folded')
    expect(w.find('[data-testid="caption-toggle"]').exists()).toBe(false)
  })

  it("'collapsible' folds the card's captions, with the toggle", async () => {
    const w = mountMetric({ cardRef: { spec: spec(['measurement-change-note', 'small-sample']) }, captionDisplay: 'collapsible', nowMs: NOW })
    await flushPromises()
    const body = w.get('.mc-captions [data-testid="caption-body"]')
    expect(body.classes()).toContain('cc-folded')
    const btn = w.get('.mc-captions [data-testid="caption-toggle"]')
    expect(btn.text()).toBe('Show more')
    await btn.trigger('click')
    expect(body.classes()).not.toContain('cc-folded')
  })

  it("a card widget in ChartCard passes captionDisplay to its metric card and folds the widget's own caption too", async () => {
    const w = mount(ChartCard, {
      props: {
        widget: widget({ type: 'table', dataset: 'overview', card: { spec: spec(['measurement-change-note']) }, caption: LONG, captionDisplay: 'collapsible' }),
        filters,
        dark: false,
        drillOpen: false,
      },
      attachTo: document.body,
    })
    mounted.push(w)
    await flushPromises()
    await flushPromises()
    const bodies = w.findAll('[data-testid="caption-body"]')
    expect(bodies.length).toBe(2) // the card's captions, then the widget's own caption
    for (const b of bodies) expect(b.classes()).toContain('cc-folded')
  })
})
