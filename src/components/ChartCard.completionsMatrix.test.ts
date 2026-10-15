// @vitest-environment happy-dom
//
// The two types of "Completions by mode × difficulty" that ChartCard draws itself, stat and table, for
// every breakdown the editor offers: fed the real /api/completions handler over the Oct 8–15 ET prod
// counts (87). The chart types are in lib/charts.completionsMatrix.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import BarTable from './metrics/BarTable.vue'
import StatTile from './metrics/StatTile.vue'
import { sitesLoaded } from '../sitesStore'
import { onRequestPost } from '../../functions/api/completions'
import type { GlobalFilters, StatsResponse, Widget } from '../types'

const fetchStatsMock = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: fetchStatsMock }
})

const PATHS: Record<string, number> = {
  '/game/complete/normal/easy': 42,
  '/game/complete/normal/hard': 19,
  '/game/complete/normal/expert': 14,
  '/game/complete/normal/medium': 10,
  '/game/complete/daily/medium': 1,
  '/game/complete/daily/easy': 1,
}
async function completions(w: Widget): Promise<StatsResponse> {
  const d1 = { prepare: () => ({ bind: () => ({ all: async () => ({ results: Object.entries(PATHS).map(([path, c]) => ({ path, c })) }) }) }) }
  ;(globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } }
  const body = { dimension: w.dimension || 'mode', breakdown: w.breakdown, since: '2026-10-08', until: '2026-10-15', limit: w.limit }
  const res = await onRequestPost({ request: { json: async () => body }, env: { gss_geo: d1 }, waitUntil: () => {} } as any)
  return (await res.json()) as StatsResponse
}

const widget = (over: Partial<Widget>): Widget =>
  ({ id: 'ow-completions', i: 'ow-completions', title: 'Completions by mode × difficulty', type: 'table', dataset: 'completions', dimension: 'mode', metric: 'pageviews', limit: 20, x: 0, y: 0, w: 12, h: 10, ...over }) as Widget
const filters: GlobalFilters = { siteSel: [], since: '2026-10-08', until: '2026-10-15', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }

beforeEach(() => {
  sitesLoaded.value = true
  fetchStatsMock.mockImplementation((w: Widget) => completions(w))
})
afterEach(() => fetchStatsMock.mockReset())

async function card(w: Widget) {
  const c = mount(ChartCard, { props: { widget: w, filters, dark: false, drillOpen: false }, global: { stubs: { BaseChart: true } } })
  await flushPromises()
  return c
}

describe('Completions card drawn by ChartCard', () => {
  it.each([
    ['mode', 'difficulty', { 'Normal · Easy': 42, 'Normal · Hard': 19, 'Normal · Expert': 14, 'Normal · Medium': 10, 'Daily · Medium': 1, 'Daily · Easy': 1 }],
    ['difficulty', 'mode', { 'Easy · Normal': 42, 'Hard · Normal': 19, 'Expert · Normal': 14, 'Medium · Normal': 10, 'Medium · Daily': 1, 'Easy · Daily': 1 }],
    ['mode', undefined, { Normal: 85, Daily: 2 }],
    ['difficulty', undefined, { Easy: 43, Hard: 19, Expert: 14, Medium: 11 }],
  ])('table, group by %s, break down by %s', async (dimension, breakdown, want) => {
    const rows = (await card(widget({ type: 'table', dimension, breakdown }))).findComponent(BarTable).props('rows') as { label: string; value: number }[]
    expect(Object.fromEntries(rows.map((r) => [r.label, r.value]))).toEqual(want)
    expect(rows.reduce((a, r) => a + r.value, 0)).toBe(87)
  })

  it('stat shows the total completions', async () => {
    const c = await card(widget({ type: 'stat', dimension: '' }))
    expect(c.findComponent(StatTile).props('number')).toBe('87')
  })
})
