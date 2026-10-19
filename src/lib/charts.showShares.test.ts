// "Show shares" for a doughnut or pie, and the dimension traits (labels, colours, share default, "nothing to
// count yet") that came out of the landing-tag special cases in shared code. The hero-vs-features donut
// must draw EXACTLY what it drew before (pinned here as literals, including a layout stored before the
// option existed); a doughnut of any other dimension can opt in. Made-up data.
import { afterEach, describe, expect, it } from 'vitest'
import chartsSource from './charts.ts?raw'
import chartCardSource from '../components/ChartCard.vue?raw'
import { buildChartConfig, formatKey, PALETTE, seriesColors } from './charts'
import { CAMPAIGNS, type CampaignFlight } from './campaigns'
import { dimensionDefOf, widgetShowsShares, widgetUnavailableText } from './catalog'
import { f3HeroDonutWidget, normalizeConfig } from './defaults'
import { F3_APPS_BARE_TAG, F3_APPS_FEATURES_TAG, F3_APPS_HERO_TAG, LANDING_NOT_LIVE_TEXT } from './landingTags'
import { hideLiveFlight3 } from '../testing/stagedFlight3'
import type { StatsResponse, Widget } from '../types'

const resp = (dim: string, rows: [string, number][]): StatsResponse => ({
  rows: rows.map(([v, n]) => ({ key: { [dim]: v }, pageviews: n, visits: n })),
  totals: { pageviews: rows.reduce((t, r) => t + r[1], 0), visits: 0 },
  meta: { site: 'all', host: null, since: '2026-10-13', until: '2026-10-13', dimensions: [dim], metric: 'pageviews' },
})
const hero = () => f3HeroDonutWidget({ x: 0, y: 0, w: 6, h: 10 })
const heroRows = resp('landingTag', [[F3_APPS_HERO_TAG, 6], [F3_APPS_FEATURES_TAG, 3], [F3_APPS_BARE_TAG, 1]])

describe('the hero-vs-features donut draws what it always drew', () => {
  // The pre-change output, written out by hand: labels with count and share, the fixed colours (teal for the
  // hero tag, amber for Features, the muted grey for the bare tag), white slice borders, the "Landing tag" legend
  // title, the empty tooltip title and the count-and-share tooltip line.
  function expectHeroDrawing(w: Widget) {
    const cfg = buildChartConfig(w, heroRows)!
    expect(cfg.type).toBe('doughnut')
    expect(cfg.data.labels).toEqual(['No ads (hero) · 6 · 60%', 'Features · 3 · 30%', 'Untagged · 1 · 10%'])
    expect(cfg.data.datasets).toHaveLength(1)
    const ds = cfg.data.datasets[0] as any
    expect(ds.data).toEqual([6, 3, 1])
    expect(ds.backgroundColor).toEqual(['#2C7DA0', '#E0722C', '#8A8278'])
    expect(ds.borderWidth).toBe(2)
    expect(ds.borderColor).toBe('#FFFFFF')
    const plugins = (cfg.options as any).plugins
    expect(plugins.legend.position).toBe('right')
    expect(plugins.legend.title.text).toBe('Flight 3 Apps landing tag')
    expect(plugins.tooltip.callbacks.title()).toBe('')
    expect(plugins.tooltip.callbacks.label({ dataIndex: 0 })).toBe(' No ads (hero) · 6 · 60%')
    expect(plugins.tooltip.callbacks.label({ dataIndex: 2 })).toBe(' Untagged · 1 · 10%')
  }

  it('the shipped widget', () => expectHeroDrawing(hero()))

  it('a layout saved before "show shares" existed (no such key on the widget) still shows the shares', () => {
    const stored = JSON.parse(JSON.stringify(hero()))
    delete stored.showShares
    expect('showShares' in stored).toBe(false)
    expectHeroDrawing(stored)
    const loaded = normalizeConfig({ version: 19, pages: [{ id: 'p', title: 'P', widgets: [stored] }] } as any).pages[0].widgets[0]
    expect('showShares' in loaded).toBe(false) // nothing was added to the stored widget
    expectHeroDrawing(loaded)
  })

  it('the chart editor can turn the shares off for it, and that choice survives a load', () => {
    const off = { ...hero(), showShares: false }
    expect(buildChartConfig(off, heroRows)!.data.labels).toEqual(['No ads (hero)', 'Features', 'Untagged'])
    const loaded = normalizeConfig({ version: 19, pages: [{ id: 'p', title: 'P', widgets: [JSON.parse(JSON.stringify(off))] }] } as any).pages[0].widgets[0]
    expect(loaded.showShares).toBe(false)
    expect(widgetShowsShares(loaded)).toBe(false)
  })

  it('formatKey and seriesColors come from the dimension definition', () => {
    expect(dimensionDefOf('landingTag', 'geo')?.sharesByDefault).toBe(true)
    expect(formatKey('landingTag', F3_APPS_HERO_TAG)).toBe('No ads (hero)')
    expect(formatKey('landingTag', 'something_else')).toBe('something_else')
    expect(formatKey('landingTag', '')).toBe('(none)')
    expect(seriesColors('landingTag', [F3_APPS_HERO_TAG, F3_APPS_FEATURES_TAG, F3_APPS_BARE_TAG, 'other'])).toEqual([PALETTE[1], PALETTE[0], PALETTE[7], PALETTE[3]])
  })

  it('nothing in the shared chart code or card is keyed on the landingTag dimension name', () => {
    expect(chartsSource).not.toMatch(/landingTag|LANDING_TAG/i)
    expect(chartCardSource).not.toMatch(/landingTag|LANDING_/i)
  })
})

describe('show shares on any doughnut or pie', () => {
  const dev = (type: 'doughnut' | 'pie', extra: Partial<Widget> = {}): Widget =>
    ({ id: 'd', i: 'd', title: 'Devices', type, dataset: 'geo', dimension: 'device', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 8, ...extra }) as Widget
  const rows = resp('device', [['mobile', 3], ['desktop', 1]])

  it('is off by default: plain labels, no custom tooltip', () => {
    for (const type of ['doughnut', 'pie'] as const) {
      const cfg = buildChartConfig(dev(type), rows)!
      expect(cfg.data.labels).toEqual(['mobile', 'desktop'])
      expect((cfg.options as any).plugins.tooltip).toBeUndefined()
    }
  })

  it('when set: "Label · N · P%" in the legend and the same line in the tooltip, for both types', () => {
    for (const type of ['doughnut', 'pie'] as const) {
      const cfg = buildChartConfig(dev(type, { showShares: true }), rows)!
      expect(cfg.type).toBe(type)
      expect(cfg.data.labels).toEqual(['mobile · 3 · 75%', 'desktop · 1 · 25%'])
      expect((cfg.options as any).plugins.tooltip.callbacks.label({ dataIndex: 1 })).toBe(' desktop · 1 · 25%')
    }
  })

  it('a chart can opt out of what its dimension defaults to, and in to what it does not', () => {
    expect(widgetShowsShares(dev('doughnut'))).toBe(false)
    expect(widgetShowsShares(dev('doughnut', { showShares: true }))).toBe(true)
    expect(widgetShowsShares({ dataset: 'geo', dimension: 'landingTag' })).toBe(true)
    expect(widgetShowsShares({ dataset: 'geo', dimension: 'landingTag', showShares: false })).toBe(false)
  })

  it('the stored option is kept as a boolean and nothing else', () => {
    const w = (v: unknown) => normalizeConfig({ version: 19, pages: [{ id: 'p', title: 'P', widgets: [{ ...dev('pie'), showShares: v }] }] } as any).pages[0].widgets[0]
    expect(w(true).showShares).toBe(true)
    expect(w(false).showShares).toBe(false)
    expect(w('yes').showShares).toBeUndefined()
    expect('showShares' in w(undefined) && w(undefined).showShares !== undefined).toBe(false)
  })
})

describe('a dimension with nothing to count yet', () => {
  const restoreFns: (() => void)[] = []
  afterEach(() => {
    while (restoreFns.length) restoreFns.pop()!()
  })
  it('landingTag says so while its arm is staged, sends no data, and is silent once a campaign carries the tags', () => {
    restoreFns.push(hideLiveFlight3())
    const real = CAMPAIGNS.slice()
    restoreFns.push(() => CAMPAIGNS.splice(0, CAMPAIGNS.length, ...real))
    expect(widgetUnavailableText(hero())).toBe(LANDING_NOT_LIVE_TEXT)
    const live: CampaignFlight = { id: 'F3-TEST', label: 'F3 test', ucValues: [F3_APPS_HERO_TAG, F3_APPS_FEATURES_TAG], flightStart: '2026-10-10', flightEnd: '2026-10-16', status: 'active', kind: 'web', notes: 'test' }
    CAMPAIGNS.splice(0, CAMPAIGNS.length, live)
    expect(widgetUnavailableText(hero())).toBeNull()
  })
  it('no other dimension, dataset or widget type has one', () => {
    expect(widgetUnavailableText({ type: 'doughnut', dataset: 'geo', dimension: 'device' })).toBeNull()
    expect(widgetUnavailableText({ type: 'doughnut', dataset: 'rum', dimension: 'landingTag' })).toBeNull() // RUM has no such dimension
    expect(widgetUnavailableText({ type: 'note', dataset: 'geo', dimension: 'landingTag' })).toBeNull()
  })
})
