// @vitest-environment happy-dom
//
// The range notice inside a chart card: when /api/stats cut the date range to what the data
// source can serve, the card says so under the chart (runtime only; nothing is saved). Uses a
// geo stat widget, which needs neither the site tree nor a canvas.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import type { GlobalFilters, StatsResponse, Widget } from '../types'
import type { RangeNotice } from '../lib/rangeNotice'
import { REFUSED_WHOLE_DAYS_CAPTION, SPLIT_GUARD_CAPTION } from '../lib/splitGuard'

const fetchStatsMock = vi.hoisted(() => vi.fn())

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: fetchStatsMock }
})

const filters: GlobalFilters = {
  siteSel: [],
  since: '2026-01-01',
  until: '2026-09-30',
  excludeSelfReferrals: false,
  excludeOwnVisits: false,
  ownBrowser: '',
  ownOS: '',
}

const widget: Widget = {
  id: 'w1',
  i: 'w1',
  title: 'Pageviews',
  type: 'stat',
  dataset: 'geo',
  dimension: '',
  metric: 'pageviews',
  limit: 1,
  x: 0,
  y: 0,
  w: 3,
  h: 3,
}

const notice: RangeNotice = {
  kind: 'range-clamped',
  source: 'cf-rum',
  reason: 'both',
  requested: { from: '2026-01-01T05:00:00.000Z', to: '2026-10-01T04:00:00.000Z' },
  served: { from: '2026-07-01T04:00:00.000Z', to: '2026-10-01T04:00:00.000Z' },
  limitDays: 93,
  lookbackDays: 184,
}

const response = (extra: Partial<StatsResponse> = {}): StatsResponse => ({
  rows: [{ key: {}, pageviews: 5, visits: 3 }],
  totals: { pageviews: 5, visits: 3 },
  meta: { site: 'all', host: null, since: '2026-01-01', until: '2026-09-30', dimensions: [], metric: 'pageviews' },
  ...extra,
})

async function mountCard() {
  const w = mount(ChartCard, { props: { widget, filters, dark: false, drillOpen: false } })
  await flushPromises()
  return w
}

// Braces: a returned function would be run by vitest as a cleanup hook (it would call the mock).
beforeEach(() => {
  fetchStatsMock.mockReset()
})

describe('ChartCard — range notice', () => {
  it('shows the note inside the card when the response carries a notice', async () => {
    fetchStatsMock.mockResolvedValue(response({ notice }))
    const w = await mountCard()
    const note = w.get('[data-testid="range-notice"]')
    expect(note.text()).toContain('Jul 1 – Sep 30 shown')
    expect(note.text()).toContain('Cloudflare limits: 93-day span, 184 days kept')
    expect(w.element.contains(note.element)).toBe(true)
  })

  it('shows the generic note when Cloudflare itself refused the range', async () => {
    fetchStatsMock.mockResolvedValue(response({ rows: [], totals: { pageviews: 0, visits: 0 }, notice: { ...notice, reason: 'upstream-rejected', served: null, limitDays: null, lookbackDays: null } }))
    const w = await mountCard()
    expect(w.get('[data-testid="range-notice"]').text()).toContain("couldn't serve this range")
  })

  it('shows no note when the range was not cut', async () => {
    fetchStatsMock.mockResolvedValue(response())
    const w = await mountCard()
    expect(w.find('[data-testid="range-notice"]').exists()).toBe(false)
  })

  it('shows no note when the request failed (the error state keeps its own message)', async () => {
    fetchStatsMock.mockImplementation(async () => {
      throw new Error('stats 502')
    })
    const w = await mountCard()
    expect(w.get('.state.error').text()).toBe('stats 502')
    expect(w.find('[data-testid="range-notice"]').exists()).toBe(false)
  })

  // The "keep both" order, pinned in one place (the order itself is unit-tested in lib/chartNotes.test.ts).
  it('shows the range note together with the attached captions, in order, in the one captions area', async () => {
    fetchStatsMock.mockResolvedValue(response({ note: 'A pop-up caveat.', notice, meta: { site: 'all', host: null, since: '2026-01-01', until: '2026-09-30', dimensions: [], metric: 'pageviews', splitGuard: true, refusedWholeDays: true } }))
    const w = mount(ChartCard, { props: { widget: { ...widget, notes: ['small-sample'] }, filters, dark: false, drillOpen: false } })
    await flushPromises()
    const texts = w.findAll('.card-captions .note-block').map((n) => n.text())
    expect(texts).toHaveLength(5)
    expect(texts[0]).toContain('small')
    expect(texts[1]).toBe('A pop-up caveat.')
    expect(texts[2]).toContain(SPLIT_GUARD_CAPTION)
    expect(texts[3]).toContain(REFUSED_WHOLE_DAYS_CAPTION)
    expect(texts[4]).toContain('Jul 1 – Sep 30 shown')
    expect(w.findAll('.card-captions')).toHaveLength(1)
    expect(w.findAll('[data-testid="range-notice"]')).toHaveLength(1)
    expect(w.findAll('.card-captions .note-block')[4].classes()).toContain('range-notice')
  })
})
