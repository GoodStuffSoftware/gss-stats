// "Completions by mode × difficulty" across every chart type and breakdown the editor offers it.
// Each combination is fed the REAL /api/completions handler (over a D1 stub holding the Oct 8–15 ET
// counts read from prod, 87 completions) and drawn by buildChartConfig: the parts must sum to the
// total, and each mark must be the (mode, difficulty) cell, or the marginal, its labels promise.
import { describe, expect, it } from 'vitest'
import type { ChartType, StatsResponse, Widget } from '../types'
import { buildChartConfig, formatKey, sliceTitle } from './charts'
import { CHART_TYPES } from './catalog'
import { onRequestPost } from '../../functions/api/completions'

const PATHS: Record<string, number> = {
  '/game/complete/normal/easy': 42,
  '/game/complete/normal/hard': 19,
  '/game/complete/normal/expert': 14,
  '/game/complete/normal/medium': 10,
  '/game/complete/daily/medium': 1,
  '/game/complete/daily/easy': 1,
}
const TOTAL = 87

async function fetchCompletions(dimension: string, breakdown?: string): Promise<StatsResponse> {
  const d1 = { prepare: () => ({ bind: () => ({ all: async () => ({ results: Object.entries(PATHS).map(([path, c]) => ({ path, c })) }) }) }) }
  ;(globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } }
  const body = { dimension, breakdown, since: '2026-10-08', until: '2026-10-15', limit: 20 }
  const res = await onRequestPost({ request: { json: async () => body }, env: { gss_geo: d1 }, waitUntil: () => {} } as any)
  return (await res.json()) as StatsResponse
}

/** The expected count of each cell, keyed by its display labels. */
function expected(dim: string, bd?: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const [p, c] of Object.entries(PATHS)) {
    const [mode, difficulty] = p.split('/').slice(3)
    const v = { mode, difficulty } as Record<string, string>
    const k = bd ? `${formatKey(dim, v[dim])} · ${formatKey(bd, v[bd])}` : formatKey(dim, v[dim])
    out.set(k, (out.get(k) ?? 0) + c)
  }
  return out
}

// What the editor offers this card (ChartEditor typeChoices): every type but the retired rate tile,
// the world map (not offered for completions) and the note (not a chart). stat and table are drawn by
// ChartCard itself (ChartCard.completionsMatrix.test.ts).
const OFFERED = CHART_TYPES.map((t) => t.value).filter((t) => !['rate', 'map', 'note', 'stat', 'table'].includes(t)) as ChartType[]
const SERIES_TYPES: ChartType[] = ['stackedBar', 'breakdownBar', 'line', 'area']
const COMBOS: [string, string | undefined][] = [
  ['mode', 'difficulty'],
  ['difficulty', 'mode'],
  ['mode', undefined],
  ['difficulty', undefined],
]

const widget = (type: ChartType, dimension: string, breakdown?: string): Widget =>
  ({ id: 'ow-completions', i: 'ow-completions', title: 'Completions by mode × difficulty', type, dataset: 'completions', dimension, breakdown, metric: 'pageviews', limit: 20, x: 0, y: 0, w: 12, h: 10 }) as Widget

describe('Completions card: every offered chart type × breakdown shows the right counts', () => {
  it('the offered list is the one this test covers', () => {
    expect(OFFERED.sort()).toEqual(['area', 'bar', 'breakdownBar', 'doughnut', 'hbar', 'line', 'nestedDoughnut', 'pie', 'stackedBar'].sort())
  })

  for (const type of OFFERED) {
    for (const [dim, bd] of COMBOS) {
      it(`${type}, group by ${dim}, break down by ${bd ?? 'none'}`, async () => {
        const w = widget(type, dim, bd)
        const resp = await fetchCompletions(dim, bd)
        expect(resp.totals.pageviews).toBe(TOTAL)
        const cfg = buildChartConfig(w, resp) as any
        expect(cfg).toBeTruthy()
        const datasets = cfg.data.datasets as { label?: string; data: (number | null)[] }[]
        const labels = cfg.data.labels as string[]
        const got = new Map<string, number>()
        if (type === 'nestedDoughnut' && bd) {
          // Ring 0 is the dimension, ring 1 subdivides it: each ring sums to the total.
          expect(datasets.length).toBe(2)
          for (const ds of datasets) expect(ds.data.reduce<number>((a, v) => a + (v ?? 0), 0)).toBe(TOTAL)
          return
        }
        if (SERIES_TYPES.includes(type) && bd) {
          // One series per breakdown value over the dimension axis: cell (axis, series).
          datasets.forEach((ds) => ds.data.forEach((v, i) => v && got.set(`${labels[i]} · ${ds.label}`, (got.get(`${labels[i]} · ${ds.label}`) ?? 0) + v)))
        } else {
          expect(datasets.length).toBe(1)
          datasets[0].data.forEach((v, i) => v && got.set(labels[i], (got.get(labels[i]) ?? 0) + v))
        }
        expect(Object.fromEntries(got)).toEqual(Object.fromEntries(expected(dim, bd)))
        expect([...got.values()].reduce((a, v) => a + v, 0)).toBe(TOTAL)
        // A pie or doughnut names what a slice is in its legend title.
        if (type === 'pie' || type === 'doughnut' || type === 'nestedDoughnut') {
          const title = cfg.options.plugins.legend.title
          expect(title.display).toBe(true)
          expect(title.text).toBe(sliceTitle(w, !!bd))
          expect(title.text).toBe(bd ? `${dim === 'mode' ? 'Mode · Difficulty' : 'Difficulty · Mode'}` : dim === 'mode' ? 'Mode' : 'Difficulty')
        }
        if (SERIES_TYPES.includes(type) && bd) expect(cfg.options.plugins.legend.title.text).toBe(bd === 'difficulty' ? 'Difficulty' : 'Mode')
      })
    }
  }

  it('the prod card as it was stored (pie, no breakdown) draws mode only, and its legend says so', async () => {
    const w = widget('pie', 'mode')
    const cfg = buildChartConfig(w, await fetchCompletions('mode')) as any
    expect(cfg.data.labels).toEqual(['Normal', 'Daily'])
    expect(cfg.options.plugins.legend.title.text).toBe('Mode')
  })
})
