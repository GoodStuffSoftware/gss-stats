// @vitest-environment happy-dom
//
// A card with a breakdown draws one entry per dimension x breakdown pair in EVERY type, including
// the table the card renders itself. Before, the table listed only the dimension, so "Normal"
// appeared once per difficulty with no way to tell the rows apart.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import { sitesLoaded } from '../sitesStore'
import type { GlobalFilters, StatsResponse, Widget } from '../types'

const fetchStatsMock = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: fetchStatsMock }
})

const resp = (): StatsResponse => ({
  rows: [
    { key: { mode: 'normal', difficulty: 'easy' }, pageviews: 30, visits: 30 },
    { key: { mode: 'normal', difficulty: 'hard' }, pageviews: 12, visits: 12 },
    { key: { mode: 'daily', difficulty: 'medium' }, pageviews: 8, visits: 8 },
  ],
  totals: { pageviews: 50, visits: 50 },
  meta: { site: 'all', host: null, since: '2026-10-01', until: '2026-10-01', dimensions: ['mode', 'difficulty'], metric: 'pageviews' },
})
const widget = (over: Partial<Widget> = {}): Widget => ({
  id: 'w1', i: 'w1', title: 'Completions by mode x difficulty', type: 'table', dataset: 'completions', dimension: 'mode', breakdown: 'difficulty',
  metric: 'pageviews', limit: 20, x: 0, y: 0, w: 12, h: 8, ...over,
})
const filters: GlobalFilters = { siteSel: [], since: '2026-10-01', until: '2026-10-01', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }

beforeEach(() => {
  sitesLoaded.value = true
  fetchStatsMock.mockResolvedValue(resp())
})
afterEach(() => fetchStatsMock.mockReset())

async function card(w: Widget) {
  const c = mount(ChartCard, { props: { widget: w, filters, dark: false, drillOpen: false }, global: { stubs: { BaseChart: true } } })
  await flushPromises()
  return c
}

describe('ChartCard table with a breakdown', () => {
  it('lists every mode x difficulty pair, labelled <mode> · <difficulty>', async () => {
    const text = (await card(widget())).text()
    for (const l of ['Normal · Easy', 'Normal · Hard', 'Daily · Medium']) expect(text).toContain(l)
  })

  it('without a breakdown it lists the dimension values as before', async () => {
    fetchStatsMock.mockResolvedValue({ ...resp(), rows: [{ key: { mode: 'normal' }, pageviews: 42, visits: 42 }, { key: { mode: 'daily' }, pageviews: 8, visits: 8 }] })
    const text = (await card(widget({ breakdown: undefined }))).text()
    expect(text).toContain('Normal')
    expect(text).toContain('Daily')
    expect(text).not.toContain('·')
  })
})
