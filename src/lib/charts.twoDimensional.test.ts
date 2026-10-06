// A 2-D response (a breakdown is set: one row per dimension x breakdown pair) must read correctly
// in EVERY chart type the editor offers. Regression: "Completions by mode x difficulty" switched to
// a pie drew ONE slice ("Normal") because the editor dropped the breakdown (the type did not allow
// one) and the pie then plotted only the first dimension, summing the difficulties away.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildChartConfig, formatKey, pairBreakdown, pairColors, pairRows } from './charts'
import { CHART_TYPES } from './catalog'
import { defaultOverviewWidgets } from './defaults'
import { etWallTimeMs } from './etTime'
import type { ChartType, StatsResponse, Widget } from '../types'
import { onRequestPost } from '../../functions/api/completions'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../../functions/_lib/testing/hitsDb'

const resp = (rows: [string, string, number][], dims = ['mode', 'difficulty']): StatsResponse => ({
  rows: rows.map(([a, b, c]) => ({ key: { [dims[0]]: a, [dims[1]]: b }, pageviews: c, visits: c + 1 })),
  totals: { pageviews: rows.reduce((t, r) => t + r[2], 0), visits: 0 },
  meta: { site: 'all', host: null, since: '2026-10-01', until: '2026-10-01', dimensions: dims, metric: 'pageviews' },
})
// Count order, as the server sends it.
const ROWS: [string, string, number][] = [
  ['normal', 'easy', 30],
  ['normal', 'hard', 12],
  ['daily', 'medium', 8],
  ['normal', 'medium', 5],
]
const widget = (over: Partial<Widget> = {}): Widget => ({
  id: 'w', i: 'w', title: 'Completions by mode x difficulty', type: 'pie', dataset: 'completions', dimension: 'mode', breakdown: 'difficulty',
  metric: 'pageviews', limit: 20, x: 0, y: 0, w: 12, h: 10, ...over,
})
const LABELS = ['Normal · Easy', 'Normal · Hard', 'Daily · Medium', 'Normal · Medium']
const VALUES = [30, 12, 8, 5]

describe('pairRows / pairBreakdown', () => {
  it('one entry per pair, labelled <dimension> · <breakdown>, in response order', () => {
    const p = pairRows(widget(), resp(ROWS))!
    expect(p.map((x) => x.label)).toEqual(LABELS)
    expect(p.map((x) => x.value)).toEqual(VALUES)
  })
  it('reads the visits metric when asked', () => {
    expect(pairRows(widget({ metric: 'visits' }), resp(ROWS))!.map((x) => x.value)).toEqual([31, 13, 9, 6])
  })
  it('a repeated pair is summed, not listed twice', () => {
    const p = pairRows(widget(), resp([['normal', 'easy', 2], ['normal', 'easy', 3]]))!
    expect(p).toHaveLength(1)
    expect(p[0].value).toBe(5)
  })
  it('no breakdown, the same dimension twice, or a date axis: nothing to pair', () => {
    expect(pairBreakdown(widget({ breakdown: undefined }))).toBeNull()
    expect(pairBreakdown(widget({ breakdown: 'mode' }))).toBeNull()
    expect(pairBreakdown(widget({ dimension: 'date' }))).toBeNull()
    expect(pairBreakdown(widget({ breakdown: 'dateEt' }))).toBeNull()
    expect(pairRows(widget({ breakdown: undefined }), resp(ROWS))).toBeNull()
  })
  it('colors: one hue per dimension value, a different shade per breakdown value', () => {
    const p = pairRows(widget(), resp(ROWS))!
    const c = pairColors(widget(), p)
    expect(new Set(c).size).toBe(4)
    expect(c[0]).not.toBe(c[1])
    expect(c[0]).not.toBe(c[3])
    expect(pairColors(widget(), p)).toEqual(c)
  })
})

describe('every chart type on a 2-D (dimension x breakdown) response', () => {
  const r = resp(ROWS)

  it.each(['doughnut', 'pie'] as const)('%s: one slice per pair, none collapsed', (type) => {
    const cfg: any = buildChartConfig(widget({ type }), r)
    expect(cfg.type).toBe(type === 'pie' ? 'pie' : 'doughnut')
    expect(cfg.data.labels).toEqual(LABELS)
    expect(cfg.data.datasets).toHaveLength(1)
    expect(cfg.data.datasets[0].data).toEqual(VALUES)
    expect(cfg.data.datasets[0].backgroundColor).toHaveLength(4)
  })

  it.each(['bar', 'hbar'] as const)('%s: one bar per pair, none collapsed', (type) => {
    const cfg: any = buildChartConfig(widget({ type }), r)
    expect(cfg.type).toBe('bar')
    expect(cfg.options.indexAxis).toBe(type === 'hbar' ? 'y' : 'x')
    expect(cfg.data.labels).toEqual(LABELS)
    expect(cfg.data.datasets[0].data).toEqual(VALUES)
    expect(cfg.data.datasets[0].backgroundColor).toHaveLength(4)
  })

  it('stackedBar / breakdownBar: one series per breakdown value over the dimension axis', () => {
    for (const type of ['stackedBar', 'breakdownBar'] as const) {
      const cfg: any = buildChartConfig(widget({ type, barMode: 'stacked' }), r)
      expect(cfg.data.labels).toEqual(['Normal', 'Daily'])
      expect(cfg.data.datasets.map((d: any) => d.label)).toEqual(['Easy', 'Medium', 'Hard'])
      const sum = (cfg.data.datasets as any[]).reduce((t, d) => t + d.data.reduce((a: number, v: number | null) => a + (v ?? 0), 0), 0)
      expect(sum).toBe(55)
    }
  })

  it.each(['line', 'area'] as const)('%s: one line per breakdown value over the dimension axis', (type) => {
    const cfg: any = buildChartConfig(widget({ type }), r)
    expect(cfg.type).toBe('line')
    expect(cfg.data.labels).toEqual(['Normal', 'Daily'])
    expect(cfg.data.datasets.map((d: any) => d.label)).toEqual(['Easy', 'Medium', 'Hard'])
    expect(cfg.data.datasets.map((d: any) => d.data)).toEqual([[30, 0], [5, 8], [12, 0]])
    // an area stacks (and fills) its series; a line does not
    expect(!!cfg.options.scales.y.stacked).toBe(type === 'area')
    expect(cfg.data.datasets.map((d: any) => d.fill)).toEqual(type === 'area' ? ['origin', '-1', '-1'] : [undefined, undefined, undefined])
  })

  it('nestedDoughnut: an inner ring of modes and an outer ring of mode x difficulty', () => {
    const cfg: any = buildChartConfig(widget({ type: 'nestedDoughnut' }), r)
    expect(cfg.data.datasets).toHaveLength(2)
    // dataset 0 is the OUTER ring (every pair), the last is the inner (the dimension alone)
    expect(cfg.data.datasets[0].data.reduce((a: number, v: number) => a + v, 0)).toBe(55)
    expect(cfg.data.datasets[1].data).toEqual([47, 8])
  })

  it('table, stat, map, rate: no Chart.js config (the card draws them itself)', () => {
    for (const type of ['table', 'stat', 'map', 'rate', 'rateTable'] as ChartType[]) expect(buildChartConfig(widget({ type }), r)).toBeNull()
  })

  it('a chart with no breakdown is unchanged: one mark per dimension value', () => {
    const one: StatsResponse = { ...r, rows: [{ key: { mode: 'normal' }, pageviews: 47, visits: 47 }, { key: { mode: 'daily' }, pageviews: 8, visits: 8 }] }
    for (const type of ['pie', 'doughnut', 'bar', 'hbar'] as const) {
      const cfg: any = buildChartConfig(widget({ type, breakdown: undefined }), one)
      expect(cfg.data.labels).toEqual(['Normal', 'Daily'])
      expect(cfg.data.datasets[0].data).toEqual([47, 8])
    }
  })

  it('covers every type the editor offers (a new type must be added to this suite)', () => {
    const covered = new Set<ChartType>(['doughnut', 'pie', 'bar', 'hbar', 'stackedBar', 'breakdownBar', 'line', 'area', 'nestedDoughnut', 'table', 'stat', 'map', 'rate', 'note'])
    for (const t of CHART_TYPES) expect(covered.has(t.value), t.value).toBe(true)
  })

  it('every type that draws a dimension takes a breakdown in the editor catalog', () => {
    const allowing = new Set(CHART_TYPES.filter((t) => t.allowsBreakdown).map((t) => t.value))
    for (const t of ['bar', 'hbar', 'pie', 'doughnut', 'area', 'line', 'stackedBar', 'breakdownBar', 'nestedDoughnut', 'table'] as ChartType[]) expect(allowing.has(t), t).toBe(true)
  })
})

// The reported card, through the REAL /api/completions handler on a real SQLite engine.
describe('regression: "Completions by mode x difficulty" in every chart type', () => {
  let undo: () => void
  beforeEach(() => {
    undo = installCaches(memoryCache())
  })
  afterEach(() => undo())

  async function served(w: Widget): Promise<StatsResponse> {
    const db = openHitsDb()
    const ts = etWallTimeMs('2026-10-01') + 12 * 3_600_000
    insertHits(db, [
      { ts, site: 'bestsudoku', path: '/game/complete/normal/easy', n: 6 },
      { ts, site: 'bestsudoku', path: '/game/complete/normal/hard', n: 3 },
      { ts, site: 'bestsudoku', path: '/game/complete/daily/medium', n: 2 },
      { ts, site: 'bestsudoku', path: '/game/complete/normal/medium', n: 1 },
    ])
    const waited: Promise<unknown>[] = []
    // Exactly the body src/api.ts sends for this widget.
    const req = postJson('/api/completions', { dimension: w.dimension, breakdown: w.breakdown || undefined, since: '2026-10-01', until: '2026-10-01', limit: w.limit })
    const res = await onRequestPost(pagesContext(req, { gss_geo: sqliteD1(db) }, waited))
    await Promise.all(waited)
    return (await res.json()) as StatsResponse
  }
  const card = () => defaultOverviewWidgets().find((x) => x.id === 'ow-completions')!

  it('the shipped card is a mode x difficulty breakdown', () => {
    expect(card()).toMatchObject({ dataset: 'completions', dimension: 'mode', breakdown: 'difficulty', type: 'stackedBar' })
  })

  it('as a pie: one slice per mode x difficulty pair, four of them, not one', async () => {
    const w = { ...card(), type: 'pie' as const }
    const cfg: any = buildChartConfig(w, await served(w))
    expect(cfg.data.labels).toEqual(['Normal · Easy', 'Normal · Hard', 'Daily · Medium', 'Normal · Medium'])
    expect(cfg.data.datasets[0].data).toEqual([6, 3, 2, 1])
  })

  it.each(['doughnut', 'bar', 'hbar'] as const)('as %s: every pair is drawn', async (type) => {
    const w = { ...card(), type }
    const cfg: any = buildChartConfig(w, await served(w))
    expect(cfg.data.labels).toHaveLength(4)
    expect(cfg.data.datasets[0].data.reduce((a: number, v: number) => a + v, 0)).toBe(12)
  })

  it.each(['stackedBar', 'breakdownBar', 'line', 'area'] as const)('as %s: the difficulties are series over the modes', async (type) => {
    const w = { ...card(), type }
    const cfg: any = buildChartConfig(w, await served(w))
    expect(cfg.data.labels).toEqual(['Normal', 'Daily'])
    expect(cfg.data.datasets.map((d: any) => d.label)).toEqual(['Easy', 'Medium', 'Hard'])
  })

  it('as a nested doughnut: two rings', async () => {
    const w = { ...card(), type: 'nestedDoughnut' as const }
    expect((buildChartConfig(w, await served(w)) as any).data.datasets).toHaveLength(2)
  })

  it('formatKey still capitalises both dimensions (the pair label is built from it)', () => {
    expect(formatKey('mode', 'daily')).toBe('Daily')
    expect(formatKey('difficulty', 'hard')).toBe('Hard')
  })
})
