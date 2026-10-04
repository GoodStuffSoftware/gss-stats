// @vitest-environment happy-dom
//
// A legacy pop-up rate tile (type 'rate', ADR 0005 slice 4) is drawn as a one-item metric card: no
// /api/stats or /api/popups fetch of its own, the percentage big with its (n/d) under it, the per-chart
// filter button kept (the tile always had one), and an unknown key says so instead of "—".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import { sitesLoaded } from '../sitesStore'
import { __resetMetricsStateForTests } from '../composables/useMetrics'
import type { GlobalFilters, Widget } from '../types'

const fetchStatsMock = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: fetchStatsMock }
})

const filters: GlobalFilters = { siteSel: [], since: '2026-09-20T04:00:00.000Z', until: '2026-09-27T04:00:00.000Z', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
const rate = (dimension: string): Widget => ({ id: 'r', i: 'r', title: 'Upsell tap rate', type: 'rate', dataset: 'popup', dimension, metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3 })

const fetchMock = vi.fn()
beforeEach(() => {
  sitesLoaded.value = true
  fetchStatsMock.mockReset()
  fetchMock.mockReset()
  // A ratio answer: 4 of 11.
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { requests: { key: string }[] }
    const results = Object.fromEntries(req.requests.map((r) => [r.key, { status: 'ok', value: 4 / 11, numerator: 4, denominator: 11 }]))
    return new Response(JSON.stringify({ results, meta: { statements: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})

const mountCard = (widget: Widget) => mount(ChartCard, { props: { widget, filters, dark: false, drillOpen: false } })
async function settle() {
  for (let i = 0; i < 6; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('ChartCard: a legacy rate tile', () => {
  it('draws the one-item card (percentage big, n/d under it) and makes no fetchStats call', async () => {
    const w = mountCard(rate('upsell:tap'))
    await settle()
    expect(fetchStatsMock).not.toHaveBeenCalled()
    expect(w.find('.mi-tile-num').text()).toBe('36.4%')
    expect(w.find('.mi-tile-sub').text()).toBe('(4/11)')
    expect(w.find('.mi-tile-label').text()).toBe('Upsell — tap rate (accept / shown)')
    expect(w.find('.stat-tile.is-page').exists()).toBe(false) // the old inline tile markup is gone
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(sent.requests[0]).toMatchObject({ ratio: 'popup.tapRate', params: { popup: 'upsell' }, window: 'page' })
    expect(sent.context).toMatchObject({ since: filters.since, until: filters.until })
  })

  it('keeps the per-chart filter button and the reload', async () => {
    const w = mountCard(rate('upsell:tap'))
    await settle()
    expect(w.find('button[title="Filter this chart"]').exists()).toBe(true)
    expect(w.find('button[title="Reload"]').exists()).toBe(true)
  })

  it('an unknown rate key says so, with no card and no fetch', async () => {
    const w = mountCard(rate('nope:tap'))
    await settle()
    expect(fetchStatsMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(w.find('.mi-tile').exists()).toBe(false)
    expect(w.find('.state').text()).toMatch(/not one this version knows/)
  })

  // The retired tile showed the install-fix note as the hideable runtime note `popup-note`
  // (chartNotes.ts); on the card the same text is the tile's caption, and the stored hide still works.
  describe('the install-fix note (popup-note)', () => {
    const INSTALL = 'install:outcome:installed'
    beforeEach(() => {
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        const req = JSON.parse(String(init.body)) as { requests: { key: string }[] }
        const results = Object.fromEntries(req.requests.map((r) => [r.key, { status: 'ok', value: 0.3, numerator: 6, denominator: 20, noteIds: ['install-fix-note'] }]))
        return new Response(JSON.stringify({ results, meta: { statements: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      })
    })

    it('shows by default', async () => {
      const w = mountCard(rate(INSTALL))
      await settle()
      expect(w.find('.mi-tile-num').text()).toBe('30.0%')
      expect(w.find('.mi-tile-caption').text()).toMatch(/earlier prompt-driven installs not recorded/)
    })

    it('is hidden when the widget stores a hide of popup-note, the figures unchanged', async () => {
      const w = mountCard({ ...rate(INSTALL), hiddenCaveats: ['popup-note'] })
      await settle()
      expect(w.find('.mi-tile-num').text()).toBe('30.0%')
      expect(w.find('.mi-tile-sub').text()).toBe('(6/20)')
      expect(w.text()).not.toMatch(/earlier prompt-driven installs not recorded/)
    })

    it('another stored hide does not hide it', async () => {
      const w = mountCard({ ...rate(INSTALL), hiddenCaveats: ['some-other-caveat'] })
      await settle()
      expect(w.find('.mi-tile-caption').text()).toMatch(/earlier prompt-driven installs not recorded/)
    })
  })

  it('a stat tile is not a rate tile: it keeps its own body and fetch', async () => {
    fetchStatsMock.mockResolvedValue({ rows: [{ key: {}, pageviews: 5, visits: 3 }], totals: { pageviews: 5, visits: 3 }, meta: {} })
    const w = mountCard({ ...rate(''), type: 'stat', dataset: undefined, dimension: '' })
    await settle()
    expect(fetchStatsMock).toHaveBeenCalled()
    expect(w.find('.stat-tile-num').text()).toBe('5')
    expect(w.find('.mi-tile').exists()).toBe(false)
  })
})
