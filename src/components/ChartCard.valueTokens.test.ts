// @vitest-environment happy-dom
//
// Value tokens on a card (notes plan slice 1d, release 1): the caption's `{=…}` tokens are filled
// from the chart's own response and the fixed dates, with no extra fetch; a value never becomes
// markup; other notes keep the dash. Uses a geo table, which needs neither the site tree nor a
// canvas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import type { GlobalFilters, StatsResponse, Widget } from '../types'
import { TRACKING_ACTIVATION_DATE_ET } from '../lib/popupEvents'
import { formatDateYmd } from '../lib/valueTokens'
import { __resetReturnRefreshForTests, RETURN_DEBOUNCE_MS, RETURN_MIN_AGE_MS } from '../composables/useReturnRefresh'

const fetchStatsMock = vi.hoisted(() => vi.fn())
const fetchSeriesStatsMock = vi.hoisted(() => vi.fn())

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: fetchStatsMock, fetchSeriesStats: fetchSeriesStatsMock }
})

const filters: GlobalFilters = {
  siteSel: [],
  since: '2026-09-01',
  until: '2026-09-30',
  excludeSelfReferrals: false,
  excludeOwnVisits: false,
  ownBrowser: '',
  ownOS: '',
}

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
  rows: [
    { key: { country: 'US' }, pageviews: 3000, visits: 900 },
    { key: { country: 'CA' }, pageviews: 1000, visits: 400 },
  ],
  totals: { pageviews: 4000, visits: 1300 },
  meta: { site: 'all', host: null, since: '2026-09-01', until: '2026-09-30', dimensions: ['country'], metric: 'pageviews' },
  ...extra,
})

async function mountCard(over: Partial<Widget>) {
  const w = mount(ChartCard, { props: { widget: widget(over), filters, dark: false, drillOpen: false } })
  await flushPromises()
  return w
}
const caption = (w: Awaited<ReturnType<typeof mountCard>>) => w.findAll('.card-captions .note-block')[0]

beforeEach(() => {
  fetchStatsMock.mockReset()
  fetchSeriesStatsMock.mockReset()
})

describe('ChartCard: value tokens in the caption', () => {
  it("fills the chart's own total, top item, share and days, and the fixed dates", async () => {
    fetchStatsMock.mockResolvedValue(response())
    const w = await mountCard({
      caption: '{=chart.total|number} views; {=chart.top} led with {=chart.topValue|number} ({=chart.topShare|pct}), {=chart.from|date} – {=chart.to|date}. Live since {=golive.web|date}.',
    })
    expect(caption(w).text()).toBe(
      `4,000 views; United States led with 3,000 (75.0%), Sep 1, 2026 – Sep 30, 2026. Live since ${formatDateYmd(TRACKING_ACTIVATION_DATE_ET!)}.`,
    )
    expect(fetchStatsMock).toHaveBeenCalledTimes(1) // no extra request for the values
  })

  it('a malformed, unknown or mismatched token shows —', async () => {
    fetchStatsMock.mockResolvedValue(response())
    const w = await mountCard({ caption: 'a {=chart.total|pct} b {=today.pageviews} c {=chart total} d {=metric:returns@7d|number}' })
    expect(caption(w).text()).toBe('a — b — c — d —')
  })

  it('a value never becomes markup: a top item that looks like a link or bold renders as text', async () => {
    fetchStatsMock.mockResolvedValue(
      response({
        rows: [{ key: { refererHost: '[x](javascript:alert(1)) **b**' }, pageviews: 9, visits: 9 }],
        totals: { pageviews: 9, visits: 9 },
      }),
    )
    const w = await mountCard({ dimension: 'refererHost', caption: 'Top: {=chart.top}' })
    const block = caption(w)
    expect(block.text()).toBe('Top: [x](javascript:alert(1)) **b**')
    expect(block.find('a').exists()).toBe(false)
    expect(block.find('strong').exists()).toBe(false)
  })

  it('bold and links around a token keep working; a token inside them shows —', async () => {
    fetchStatsMock.mockResolvedValue(response())
    const w = await mountCard({ caption: '**Total** {=chart.total} — **{=chart.total}** [see {=chart.top}](https://example.com)' })
    const block = caption(w)
    expect(block.findAll('strong').map((s) => s.text())).toEqual(['Total', '—'])
    expect(block.get('a').text()).toBe('see —')
    expect(block.get('a').attributes('href')).toBe('https://example.com')
    expect(block.text()).toContain('Total 4,000 —')
  })

  it('a failed request shows — for chart values but still fills the fixed dates', async () => {
    fetchStatsMock.mockRejectedValue(new Error('stats 502'))
    const w = await mountCard({ caption: '{=chart.total} since {=golive.web|date}' })
    expect(w.findAll('.card-captions .note-block').map((n) => n.text())).toContain(`— since ${formatDateYmd(TRACKING_ACTIVATION_DATE_ET!)}`)
  })

  it('only the caption takes values: a response note keeps the dash', async () => {
    fetchStatsMock.mockResolvedValue(response({ note: 'Server note {=chart.total}.' }))
    const w = await mountCard({ caption: 'Mine {=chart.total}.' })
    const texts = w.findAll('.card-captions .note-block').map((n) => n.text())
    expect(texts[0]).toBe('Mine 4,000.')
    expect(texts).toContain('Server note —.')
  })
})

describe('ChartCard: value tokens while the chart reloads (review N1)', () => {
  afterEach(() => {
    vi.useRealTimers()
    __resetReturnRefreshForTests()
  })

  it('a reload for a new range shows — until the new response arrives, never the old values', async () => {
    fetchStatsMock.mockResolvedValueOnce(response())
    const w = await mountCard({ caption: 'Total {=chart.total|number}, {=chart.from|date}' })
    expect(caption(w).text()).toBe('Total 4,000, Sep 1, 2026')
    let release!: (r: StatsResponse) => void
    fetchStatsMock.mockImplementationOnce(() => new Promise<StatsResponse>((r) => (release = r)))
    await w.setProps({ filters: { ...filters, since: '2026-10-01', until: '2026-10-02' } })
    await flushPromises()
    expect(fetchStatsMock).toHaveBeenCalledTimes(2)
    expect(caption(w).text()).toBe('Total —, —')
    release(
      response({
        rows: [{ key: { country: 'US' }, pageviews: 7, visits: 7 }],
        totals: { pageviews: 7, visits: 7 },
        meta: { site: 'all', host: null, since: '2026-10-01', until: '2026-10-02', dimensions: ['country'], metric: 'pageviews' },
      }),
    )
    await flushPromises()
    expect(caption(w).text()).toBe('Total 7, Oct 1, 2026')
  })

  it('a background refetch (the user came back to the tab) keeps the values up: no flash of —', async () => {
    __resetReturnRefreshForTests()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    vi.useFakeTimers()
    fetchStatsMock.mockResolvedValueOnce(response())
    const w = mount(ChartCard, { props: { widget: widget({ caption: 'Total {=chart.total|number}' }), filters, dark: false, drillOpen: false } })
    await vi.advanceTimersByTimeAsync(0)
    expect(caption(w).text()).toBe('Total 4,000')
    let release!: (r: StatsResponse) => void
    fetchStatsMock.mockImplementationOnce(() => new Promise<StatsResponse>((r) => (release = r)))
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 20)
    expect(fetchStatsMock).toHaveBeenCalledTimes(2) // the refetch is in flight
    expect(caption(w).text()).toBe('Total 4,000')
    release(response({ totals: { pageviews: 4100, visits: 1300 } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(caption(w).text()).toBe('Total 4,100')
    w.unmount()
  })
})
