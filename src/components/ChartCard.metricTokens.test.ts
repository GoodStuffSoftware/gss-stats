// @vitest-environment happy-dom
//
// `{=metric:<id>@<window>}` value tokens on a card (notes plan slice 1d, release 2): in a chart
// caption and in a note widget's text they are filled from ONE batched POST /api/metrics per
// page (shared with every other widget through useMetrics, deduped by request), with the loading
// dash while it is in flight (release 1's loading text) and for an error or an unknown id. A note widget also takes
// the fixed dates; `chart.*` is the dash there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import type { GlobalFilters, StatsResponse, Widget } from '../types'
import { __resetMetricsStateForTests } from '../composables/useMetrics'
import type { MetricsRequestBody, MetricsResponseBody, MetricValue } from '../lib/metrics/types'

const fetchStatsMock = vi.hoisted(() => vi.fn())
const fetchSeriesStatsMock = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: fetchStatsMock, fetchSeriesStats: fetchSeriesStatsMock }
})

const filters: GlobalFilters = { siteSel: [], since: '2026-09-01', until: '2026-09-30', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
const widget = (over: Partial<Widget> = {}): Widget =>
  ({ id: 'w1', i: 'w1', title: 'Countries', type: 'table', dataset: 'geo', dimension: 'country', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 6, ...over }) as Widget
const note = (text: string, over: Partial<Widget> = {}): Widget => widget({ id: 'n1', i: 'n1', type: 'note', title: 'Note', note: text, ...over })
const response = (): StatsResponse => ({
  rows: [{ key: { country: 'US' }, pageviews: 3000, visits: 900 }],
  totals: { pageviews: 4000, visits: 1300 },
  meta: { site: 'all', host: null, since: '2026-09-01', until: '2026-09-30', dimensions: ['country'], metric: 'pageviews' },
})

const mounted: VueWrapper[] = []
function card(w: Widget) {
  const c = mount(ChartCard, { props: { widget: w, filters, dark: false, drillOpen: false } })
  mounted.push(c)
  return c
}
/** Let the 10 ms coalescing window close and the (mocked) response land. */
async function settle() {
  await new Promise((r) => setTimeout(r, 40))
  await flushPromises()
}

let fetchMock: ReturnType<typeof vi.fn>
function serve(results: (spec: Record<string, unknown>) => MetricValue) {
  fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as MetricsRequestBody
    const out: Record<string, MetricValue> = {}
    for (const r of body.requests) out[r.key] = results(r as unknown as Record<string, unknown>)
    return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results: out, meta: { facts: 0, cacheHits: 0, statements: 0 } }) satisfies MetricsResponseBody }
  })
  vi.stubGlobal('fetch', fetchMock)
}
const posts = () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body) as MetricsRequestBody)

beforeEach(() => {
  __resetMetricsStateForTests()
  fetchStatsMock.mockReset().mockResolvedValue(response())
  fetchSeriesStatsMock.mockReset()
})
afterEach(() => {
  for (const c of mounted.splice(0)) c.unmount()
  vi.unstubAllGlobals()
  __resetMetricsStateForTests()
})

describe('ChartCard: metric tokens', () => {
  it('fills a caption token from the catalog, with the dash (the loading text) until the value arrives', async () => {
    serve((r) => ({ status: 'ok', value: r.metric === 'bsk.pageviews' ? 12345 : 7 }) as MetricValue)
    const c = card(widget({ caption: 'Site total {=metric:bsk.pageviews@page|number}.' }))
    await flushPromises()
    expect(c.get('.card-captions .note-block').text()).toBe('Site total —.')
    await settle()
    expect(c.get('.card-captions .note-block').text()).toBe('Site total 12,345.')
  })

  it('a note widget takes metric tokens and the fixed dates, and chart.* stays the dash', async () => {
    serve(() => ({ status: 'ok', value: 0.25 }) as MetricValue)
    const c = card(note('Tap rate {=metric:bsk.popupTapRate@page|pct}; live {=golive.web|date}; total {=chart.total|number}.'))
    await settle()
    const text = c.text()
    expect(text).toContain('Tap rate 25.0%')
    expect(text).toMatch(/live [A-Z][a-z]{2} \d{1,2}, \d{4}/)
    expect(text).toContain('total —.')
    expect(fetchStatsMock).not.toHaveBeenCalled() // a note loads no chart response
  })

  it('every widget on the page shares ONE request, and an identical token is asked for once', async () => {
    serve(() => ({ status: 'ok', value: 9 }) as MetricValue)
    card(note('{=metric:bsk.pageviews@page|number} and {=metric:bsk.pageviews@page|number} and {=metric:play.deviceInstalls@page|number}'))
    card(widget({ caption: '{=metric:bsk.pageviews@page|number}' }))
    card(note('{=metric:bsk.pageviews@page|number}', { id: 'n2', i: 'n2' }))
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const reqs = posts()[0].requests as unknown as { metric: string; window: string }[]
    expect(reqs.map((r) => `${r.metric}@${r.window}`).sort()).toEqual(['bsk.pageviews@page', 'play.deviceInstalls@page'])
    expect(posts()[0].context).toMatchObject({ since: expect.stringContaining('2026-09-01') })
  })

  it('an error, a not-measured value and an unknown id all show the dash', async () => {
    serve((r) => (r.metric === 'play.deviceInstalls' ? ({ status: 'error', reason: 'x' } as unknown as MetricValue) : ({ status: 'unmeasured', reason: 'x' } as unknown as MetricValue)))
    const c = card(note('{=metric:bsk.pageviews@page|number} / {=metric:play.deviceInstalls@page|number} / {=metric:nope.nothing@page|number} / {=metric:bsk.pageviews|number}'))
    await settle()
    expect(c.text()).toContain('— / — / — / —')
  })

  it('a request failure shows the dash, and nothing keeps loading', async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    const c = card(note('x {=metric:bsk.pageviews@page|number} y'))
    await settle()
    expect(c.text()).toContain('x — y')
  })

  it('a widget with no metric token makes no metrics request at all', async () => {
    serve(() => ({ status: 'ok', value: 1 }) as MetricValue)
    card(widget({ caption: 'Plain {=chart.total|number}' }))
    card(note('Plain {=golive.web|date}'))
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
