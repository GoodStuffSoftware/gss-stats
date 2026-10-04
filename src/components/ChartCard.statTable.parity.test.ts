// @vitest-environment happy-dom
//
// ADR 0005 slice 5, parity: a stat tile and a bar table now render through the shared StatTile and
// BarTable components, and keep reading through fetchStats (decision (a): their data path did not
// move). The numbers cannot change because the data path did not, so this test pins them: for every
// dataset fetchStats serves (RUM, geo, pop-up, completions) the same response is turned into the
// figures the retired inline markup showed (the oracle below restates its formulas), and the
// rendered tile / table must equal them. Differences are listed at the bottom and asserted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import { sitesLoaded } from '../sitesStore'
import { formatKey } from '../lib/charts'
import type { GlobalFilters, StatsResponse, Widget } from '../types'

const fetchStatsMock = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: fetchStatsMock }
})

const filters: GlobalFilters = { siteSel: [], since: '2026-09-01', until: '2026-09-26', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }

beforeEach(() => {
  sitesLoaded.value = true
  fetchStatsMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const widget = (over: Partial<Widget>): Widget => ({ id: 'w', i: 'w', title: 'W', type: 'stat', dimension: '', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 3, h: 3, ...over })
const mountCard = (w: Widget) => mount(ChartCard, { props: { widget: w, filters, dark: false, drillOpen: false } })
async function settle() {
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 5))
  }
}
const resp = (rows: { key: Record<string, string>; pageviews: number; visits: number }[], totals: { pageviews: number; visits: number }, meta: Record<string, unknown> = {}): StatsResponse =>
  ({ rows, totals, meta }) as unknown as StatsResponse

// ── The retired inline markup's figures (ChartCard.vue before slice 5), restated ───────────────
const fmt = (n: number) => n.toLocaleString('en-US')
function oldStat(w: Widget, r: StatsResponse) {
  const visits = w.metric === 'visits'
  return { number: fmt(visits ? r.totals.visits : r.totals.pageviews), label: w.metric, sub: `${fmt(visits ? r.totals.pageviews : r.totals.visits)} ${visits ? 'pageviews' : 'visits'}` }
}
function oldTable(w: Widget, r: StatsResponse) {
  const vals = r.rows.map((row) => (w.metric === 'visits' ? row.visits : row.pageviews))
  const max = Math.max(1, ...vals)
  return r.rows.map((row, i) => ({ label: formatKey(w.dimension, row.key[w.dimension] ?? ''), value: fmt(vals[i]), width: (vals[i] / max) * 100 }))
}

// ── What the page shows ────────────────────────────────────────────────────────────────────────
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
function readStat(w: VueWrapper) {
  const root = w.find('.stat-tile')
  return { number: text(root.find('.stat-tile-num').element), label: text(root.find('.stat-tile-label').element), sub: text(root.find('.stat-tile-sub').element) }
}
function readTable(w: VueWrapper) {
  return w.findAll('.bar-table tbody tr').map((tr) => ({
    label: text(tr.find('.bt-label').element),
    value: text(tr.find('.bt-val').element),
    width: parseFloat((tr.find('.bt-fill').element as HTMLElement).style.width),
  }))
}

const DATASETS: { name: string; dataset: Widget['dataset']; dimension: string; rows: { key: Record<string, string>; pageviews: number; visits: number }[] }[] = [
  { name: 'rum', dataset: undefined, dimension: 'deviceType', rows: [{ key: { deviceType: 'mobile' }, pageviews: 1234567, visits: 800 }, { key: { deviceType: 'desktop' }, pageviews: 40, visits: 31 }, { key: { deviceType: '' }, pageviews: 0, visits: 0 }] },
  { name: 'geo', dataset: 'geo', dimension: 'countryName', rows: [{ key: { countryName: 'US' }, pageviews: 900, visits: 450 }, { key: { countryName: 'GB' }, pageviews: 90, visits: 45 }, { key: { countryName: 'ZZ' }, pageviews: 3, visits: 2 }] },
  { name: 'popup', dataset: 'popup', dimension: 'kind', rows: [{ key: { kind: 'shown' }, pageviews: 120, visits: 100 }, { key: { kind: 'accepted' }, pageviews: 12, visits: 12 }] },
  { name: 'completions', dataset: 'completions', dimension: 'mode', rows: [{ key: { mode: 'classic' }, pageviews: 77, visits: 70 }, { key: { mode: 'killer' }, pageviews: 7, visits: 7 }] },
]

describe('slice 5 parity: stat tile', () => {
  for (const d of DATASETS) {
    for (const metric of ['pageviews', 'visits'] as const) {
      it(`${d.name} / ${metric}: number, label and the other measure equal the retired tile`, async () => {
        const totals = { pageviews: 1234607, visits: 831 }
        const r = resp(d.rows, totals)
        fetchStatsMock.mockResolvedValue(r)
        const w = widget({ type: 'stat', dataset: d.dataset, metric })
        const card = mountCard(w)
        await settle()
        expect(fetchStatsMock).toHaveBeenCalledTimes(1)
        expect(readStat(card)).toEqual(oldStat(w, r))
        expect(readStat(card).number).toBe(metric === 'visits' ? '831' : '1,234,607')
      })
    }
  }

  it('is empty on its rows, not its totals: "No data in range" even when the totals are not zero', async () => {
    fetchStatsMock.mockResolvedValue(resp([], { pageviews: 50, visits: 40 }))
    const card = mountCard(widget({ type: 'stat', dataset: 'geo' }))
    await settle()
    expect(card.text()).toContain('No data in range')
    expect(card.find('.stat-tile').exists()).toBe(false)
  })

  it('a zero total still draws the tile when there are rows', async () => {
    fetchStatsMock.mockResolvedValue(resp([{ key: {}, pageviews: 0, visits: 0 }], { pageviews: 0, visits: 0 }))
    const card = mountCard(widget({ type: 'stat', dataset: 'geo' }))
    await settle()
    expect(readStat(card)).toEqual({ number: '0', label: 'pageviews', sub: '0 visits' })
  })

  it('a pop-up stat tile before go-live says "Tracking not yet active" (loading and errors keep their own states)', async () => {
    fetchStatsMock.mockResolvedValue(resp([{ key: {}, pageviews: 1, visits: 1 }], { pageviews: 1, visits: 1 }, { activationPending: true }))
    const card = mountCard(widget({ type: 'stat', dataset: 'popup' }))
    await settle()
    expect(card.text()).toContain('Tracking not yet active')
    expect(card.find('.stat-tile').exists()).toBe(false)
  })

  it('shows the error text on a failed load', async () => {
    fetchStatsMock.mockRejectedValue(new Error('boom'))
    const card = mountCard(widget({ type: 'stat', dataset: 'geo' }))
    await settle()
    expect(card.find('.state.error').text()).toBe('boom')
  })
})

describe('slice 5 parity: bar table', () => {
  for (const d of DATASETS) {
    for (const metric of ['pageviews', 'visits'] as const) {
      it(`${d.name} / ${metric}: label, value and bar width of every row equal the retired table`, async () => {
        const r = resp(d.rows, { pageviews: 1234607, visits: 831 })
        fetchStatsMock.mockResolvedValue(r)
        const w = widget({ type: 'table', dataset: d.dataset, dimension: d.dimension, metric })
        const card = mountCard(w)
        await settle()
        expect(readTable(card)).toEqual(oldTable(w, r))
        expect(readTable(card)).toHaveLength(d.rows.length)
      })
    }
  }

  it('a date dimension reads "Jun 24", and an all-zero table scales to 1 (no divide by zero)', async () => {
    const r = resp([{ key: { date: '2026-06-24' }, pageviews: 0, visits: 0 }], { pageviews: 0, visits: 0 })
    fetchStatsMock.mockResolvedValue(r)
    const w = widget({ type: 'table', dimension: 'date' })
    const card = mountCard(w)
    await settle()
    expect(readTable(card)).toEqual([{ label: 'Jun 24', value: '0', width: 0 }])
  })

  it('the longest bar is the largest value, the rest are scaled to it', async () => {
    fetchStatsMock.mockResolvedValue(resp([{ key: { deviceType: 'a' }, pageviews: 200, visits: 1 }, { key: { deviceType: 'b' }, pageviews: 50, visits: 1 }], { pageviews: 250, visits: 2 }))
    const card = mountCard(widget({ type: 'table', dimension: 'deviceType' }))
    await settle()
    expect(readTable(card).map((r) => r.width)).toEqual([100, 25])
  })

  it('a long label keeps its full text in the title attribute', async () => {
    fetchStatsMock.mockResolvedValue(resp([{ key: { requestPath: '/a/very/long/path' }, pageviews: 1, visits: 1 }], { pageviews: 1, visits: 1 }))
    const card = mountCard(widget({ type: 'table', dimension: 'requestPath' }))
    await settle()
    expect(card.find('.bt-label').attributes('title')).toBe('/a/very/long/path')
  })

  it('no rows: "No data in range"; a pop-up table before go-live: "Tracking not yet active"', async () => {
    fetchStatsMock.mockResolvedValue(resp([], { pageviews: 0, visits: 0 }))
    const empty = mountCard(widget({ type: 'table', dimension: 'deviceType' }))
    await settle()
    expect(empty.text()).toContain('No data in range')
    expect(empty.find('.bar-table').exists()).toBe(false)

    fetchStatsMock.mockResolvedValue(resp([{ key: { kind: 'shown' }, pageviews: 1, visits: 1 }], { pageviews: 1, visits: 1 }, { activationPending: true }))
    const pending = mountCard(widget({ type: 'table', dataset: 'popup', dimension: 'kind' }))
    await settle()
    expect(pending.text()).toContain('Tracking not yet active')
    expect(pending.find('.bar-table').exists()).toBe(false)
  })

  it('ignores a breakdown (the editor allows one for Table; the table never drew it)', async () => {
    const r = resp([{ key: { deviceType: 'mobile', countryName: 'US' }, pageviews: 9, visits: 3 }], { pageviews: 9, visits: 3 })
    fetchStatsMock.mockResolvedValue(r)
    const w = widget({ type: 'table', dimension: 'deviceType', breakdown: 'countryName' })
    const card = mountCard(w)
    await settle()
    expect(readTable(card)).toEqual(oldTable(w, r))
  })
})
