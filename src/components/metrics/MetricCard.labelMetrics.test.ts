// @vitest-environment happy-dom
//
// `{=metric:<id>@<window>}` in a metric card's labels (value-tokens release 3): the title, a
// section heading, an item's label, caption and hint take the same tokens a chart caption does. The
// card fetches them with its own items in ONE batched POST /api/metrics (and not at all when no
// label carries one), shows "—" for anything but a measured value, and follows the ET day.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { __resetReturnRefreshForTests } from '../../composables/useReturnRefresh'
import type { CardSpec, MetricsContext, MetricsRequestBody, MetricValue } from '../../lib/metrics/types'

const CTX: MetricsContext = { since: '2026-09-01T04:00:00.000Z', until: '2026-10-01T04:00:00.000Z' }
const NOW = Date.parse('2026-10-03T16:00:00Z')

const itemOf = (label: string, extra: Record<string, unknown> = {}) => ({ id: 'views', label, data: { metric: 'bsk.gameViews', window: 'page' }, display: { as: 'number' }, ...extra })
const fieldItem = { id: 'f', label: 'Name', data: { field: 'campaign.label' }, display: { as: 'number' } }
const spec = (over: Partial<CardSpec> = {}): CardSpec => ({ v: 1, sections: [{ layout: 'rows', items: [itemOf('Views') as never] }], ...over })

let fetchMock: ReturnType<typeof vi.fn>
let served = 0
function serve(results: (spec: Record<string, unknown>) => MetricValue) {
  fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as MetricsRequestBody
    served++
    const out: Record<string, MetricValue> = {}
    for (const r of body.requests) out[r.key] = results(r as unknown as Record<string, unknown>)
    return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results: out, meta: { facts: 0, cacheHits: 0, statements: 0 } }) }
  })
  vi.stubGlobal('fetch', fetchMock)
}
const posts = () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body) as MetricsRequestBody)
const keysOf = (b: MetricsRequestBody) => (b.requests as unknown as { metric?: string; ratio?: string; window: string }[]).map((r) => `${r.metric ?? r.ratio}@${r.window}`).sort()

const mounted: VueWrapper[] = []
function card(s: CardSpec, props: Record<string, unknown> = {}) {
  const w = mount(MetricCard, { props: { cardRef: { spec: s }, context: CTX, nowMs: NOW, ...props } })
  mounted.push(w)
  return w
}
async function settle() {
  await new Promise((r) => setTimeout(r, 40))
  await flushPromises()
}

beforeEach(() => {
  served = 0
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
})

describe('MetricCard: metric tokens in labels', () => {
  it('fills a token in the title, a section heading, an item label and a caption from /api/metrics', async () => {
    serve((r) => ({ status: 'ok', value: r.metric === 'bsk.pageviews' ? 12345 : r.metric === 'bsk.completions' ? 77 : 5 }) as MetricValue)
    const w = card(
      spec({
        title: 'Traffic {=metric:bsk.pageviews@page|number}',
        sections: [
          {
            layout: 'rows',
            title: 'Done {=metric:bsk.completions@page|number}',
            items: [itemOf('Views of {=metric:bsk.pageviews@page|number}', { caption: 'out of {=metric:bsk.completions@page|number}' }) as never],
          },
        ],
      }),
    )
    await flushPromises()
    expect(w.text()).toContain('Traffic —') // the dash until the value arrives
    await settle()
    const text = w.text()
    expect(text).toContain('Traffic 12,345')
    expect(text).toContain('Done 77')
    expect(text).toContain('Views of 12,345')
    expect(text).toContain('out of 77')
  })

  it('sends ONE request for the card\'s own items and every label token, each metric once', async () => {
    serve(() => ({ status: 'ok', value: 3 }) as MetricValue)
    // The live clock (no `nowMs` seam): the card's day and the tokens' day are the same one, as on a page.
    card(
      spec({
        title: '{=metric:bsk.pageviews@page|number}',
        sections: [{ layout: 'rows', title: '{=metric:bsk.pageviews@page|number}', items: [itemOf('{=metric:bsk.completions@page|number} / {=metric:bsk.completions@todaySoFar|number}') as never] }],
      }),
      { nowMs: undefined },
    )
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(keysOf(posts()[0])).toEqual(['bsk.completions@page', 'bsk.completions@todaySoFar', 'bsk.gameViews@page', 'bsk.pageviews@page'])
    expect(posts()[0].context).toEqual(CTX)
  })

  it('a card with no metric token in any label fetches nothing for its labels', async () => {
    serve(() => ({ status: 'ok', value: 3 }) as MetricValue)
    // Fixed dates fill locally; the only item is a field binding, so the card has nothing to ask for.
    const w = card({ v: 1, title: 'Since {=golive.web|date}', sections: [{ layout: 'rows', items: [fieldItem as never] }] })
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(w.text()).toMatch(/Since [A-Z][a-z]{2} \d{1,2}, \d{4}/)
  })

  it('without a token the card sends only its own item', async () => {
    serve(() => ({ status: 'ok', value: 3 }) as MetricValue)
    card(spec({ title: 'Plain title' }))
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(keysOf(posts()[0])).toEqual(['bsk.gameViews@page'])
  })

  it('shows the dash for every status but a measured value, and for an unknown or malformed token', async () => {
    const byMetric = new Map<string, MetricValue>([
      ['bsk.pageviews', { status: 'ok', value: 10 } as MetricValue],
      ['bsk.completions', { status: 'too-few', reason: 'x' } as unknown as MetricValue],
      ['bsk.popupShown', { status: 'unmeasured', reason: 'x' } as unknown as MetricValue],
      ['bsk.authSuccess', { status: 'error', reason: 'x' } as unknown as MetricValue],
    ])
    serve((r) => byMetric.get(r.metric as string) ?? ({ status: 'ok', value: 1 } as MetricValue))
    const w = card(
      spec({
        title: '{=metric:bsk.pageviews@page|number} | {=metric:bsk.completions@page|number} | {=metric:bsk.popupShown@page|number} | {=metric:bsk.authSuccess@page|number} | {=metric:nope.nothing@page|number} | {=metric:bsk.pageviews|number}',
      }),
    )
    await settle()
    expect(w.text()).toContain('10 | — | — | — | — | —')
  })

  it('a request failure leaves the dash and nothing keeps loading', async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    const w = card(spec({ title: 'x {=metric:bsk.pageviews@page|number} y' }))
    await settle()
    expect(w.text()).toContain('x — y')
  })

  it('a "today so far" token refetches after ET midnight, with no filter change', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-04T03:50:00Z') }) // 23:50 ET on 2026-10-03
    serve(() => ({ status: 'ok', value: 999 + served - 1 }) as MetricValue)
    // Only the title asks (the sole item is a field), so the second request is the label token's own.
    const w = mount(MetricCard, {
      props: { cardRef: { spec: { v: 1, title: 'Today {=metric:bsk.pageviews@todaySoFar|number}', sections: [{ layout: 'rows', items: [fieldItem as never] }] } }, context: CTX },
    })
    mounted.push(w)
    await vi.advanceTimersByTimeAsync(50)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('Today 999')
    await vi.advanceTimersByTimeAsync(5 * 60_000) // 23:55, same ET day
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * 60_000) // 00:05 ET: the clock has passed midnight
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(w.text()).toContain('Today 1,000')
  })

  // ── Surfaces beyond the title and item labels: each is a separate branch in cardLabelTexts or a
  // separate prop threading, so each gets its own guard (a missed one silently shows "—") ──
  const tokenOf = (m: string) => `{=metric:${m}@page|number}`
  const byMetric = (r: Record<string, unknown>) => ({ status: 'ok', value: ({ 'bsk.pageviews': 111, 'bsk.completions': 222, 'bsk.popupShown': 333, 'bsk.authSuccess': 444, 'bsk.gameViews': 555 } as Record<string, number>)[r.metric as string] ?? 1 }) as MetricValue

  it("a table section's column heading and row-label heading take tokens, fetched in the card's one request", async () => {
    serve(byMetric)
    const w = card(
      spec({
        sections: [
          {
            layout: 'table',
            columns: { over: 'windows' },
            columnLabel: `Col ${tokenOf('bsk.pageviews')}`,
            rowsLabel: `Rows ${tokenOf('bsk.completions')}`,
            items: [itemOf('Views') as never],
          } as never,
        ],
      }),
      { nowMs: undefined }, // the live clock, as on a page: the card's day and the tokens' day agree
    )
    await settle()
    expect(w.text()).toContain('Col 111')
    expect(w.text()).toContain('Rows 222')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(keysOf(posts()[0])).toEqual(['bsk.completions@page', 'bsk.gameViews@page', 'bsk.pageviews@page'])
  })

  it("a card repeat's empty heading and message take tokens", async () => {
    serve(byMetric)
    const w = card({
      v: 1,
      repeat: { over: 'campaigns', ids: ['__none__'], empty: { label: `None ${tokenOf('bsk.pageviews')}`, text: `Add one ${tokenOf('bsk.completions')}` } } as never,
      sections: [{ layout: 'rows', items: [fieldItem as never] }],
    })
    await settle()
    expect(w.text()).toContain('None 111')
    expect(w.text()).toContain('Add one 222')
    expect(keysOf(posts()[0])).toEqual(['bsk.completions@page', 'bsk.pageviews@page'])
  })

  it("a section's own repeat empty heading and message are fetched too", async () => {
    serve(byMetric)
    card({
      v: 1,
      sections: [
        {
          layout: 'rows',
          repeat: { over: 'campaigns', ids: ['__none__'], empty: { label: tokenOf('bsk.popupShown'), text: tokenOf('bsk.authSuccess') } },
          items: [fieldItem as never],
        } as never,
      ],
    })
    await settle()
    expect(keysOf(posts()[0])).toEqual(expect.arrayContaining(['bsk.authSuccess@page', 'bsk.popupShown@page']))
  })

  it("a column repeat's empty heading and message, and an item repeat's, are fetched too", async () => {
    serve(byMetric)
    card(
      {
        v: 1,
        sections: [
          {
            layout: 'table',
            columns: { over: 'windows', ids: ['__none__'], empty: { label: tokenOf('bsk.popupShown'), text: tokenOf('bsk.authSuccess') } },
            items: [itemOf('Views') as never],
          } as never,
        ],
      },
      { nowMs: undefined },
    )
    await settle()
    expect(keysOf(posts()[0])).toEqual(expect.arrayContaining(['bsk.authSuccess@page', 'bsk.popupShown@page']))
    __resetMetricsStateForTests()
    fetchMock.mockClear()
    card(
      { v: 1, sections: [{ layout: 'rows', items: [itemOf('Views', { repeat: { over: 'campaigns', ids: ['__none__'], empty: { label: tokenOf('bsk.completions'), text: tokenOf('bsk.pageviews') } } }) as never] }] },
      { nowMs: undefined },
    )
    await settle()
    expect(keysOf(posts()[0])).toEqual(expect.arrayContaining(['bsk.completions@page', 'bsk.pageviews@page']))
  })

  it("a table column's hint takes tokens: fetched, and shown as the header's tooltip", async () => {
    serve(byMetric)
    const w = card({
      v: 1,
      sections: [{ layout: 'table', repeat: { over: 'campaigns' }, items: [itemOf('Views', { hint: `Of ${tokenOf('bsk.pageviews')} loads` }) as never] } as never],
    })
    await settle()
    expect(keysOf(posts()[0])).toContain('bsk.pageviews@page')
    expect(w.findAll('th').some((th) => th.attributes('title') === 'Of 111 loads')).toBe(true)
  })

  it('a campaign-repeat card fills tokens in its instance labels (the repeat branch passes the values down)', async () => {
    serve(byMetric)
    const w = card({
      v: 1,
      repeat: { over: 'campaigns' } as never,
      title: `{campaign.label} ${tokenOf('bsk.pageviews')}`,
      sections: [{ layout: 'rows', title: `S ${tokenOf('bsk.completions')}`, items: [itemOf(`L ${tokenOf('bsk.popupShown')}`, { caption: `C ${tokenOf('bsk.authSuccess')}` }) as never] }],
    })
    await settle()
    const text = w.text()
    expect(text).toContain('111')
    expect(text).toContain('S 222')
    expect(text).toContain('L 333')
    expect(text).toContain('C 444')
    expect(text.match(/S 222/g)!.length).toBeGreaterThan(1) // every instance, not just the first
    expect(text).not.toMatch(/[SLC] —/) // no unfilled label token
  })

  // ── Reload and Retry refresh the label tokens too (review SHOULD-1) ──
  const reloadBtn = (w: VueWrapper) => w.get('button.mc-reload')
  const freshOf = (b: MetricsRequestBody) => (b as unknown as { fresh?: boolean }).fresh

  it("Reload refetches a title token fresh, with the card's own items", async () => {
    let pv = 7
    serve((r) => ({ status: 'ok', value: r.metric === 'bsk.pageviews' ? pv : 50 }) as MetricValue)
    const w = card(spec({ title: `T ${tokenOf('bsk.pageviews')}`, showUpdated: 'header' }))
    await settle()
    expect(w.text()).toContain('T 7')
    const before = fetchMock.mock.calls.length
    pv = 99
    await reloadBtn(w).trigger('click')
    await settle()
    const after = posts().slice(before)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every(freshOf)).toBe(true)
    expect(after.flatMap(keysOf)).toEqual(expect.arrayContaining(['bsk.pageviews@page', 'bsk.gameViews@page']))
    expect(w.text()).toContain('T 99')
  })

  it('Reload on a card whose only metric values are label tokens still sends a fresh request', async () => {
    serve(() => ({ status: 'ok', value: 5 }) as MetricValue)
    const w = card({ v: 1, title: `T ${tokenOf('bsk.pageviews')}`, showUpdated: 'header', sections: [{ layout: 'rows', items: [fieldItem as never] }] })
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(w.find('.mc-updated').exists()).toBe(true) // the stamp follows the token load, not only item loads
    await reloadBtn(w).trigger('click')
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(freshOf(posts()[1])).toBe(true)
    expect(keysOf(posts()[1])).toEqual(['bsk.pageviews@page'])
  })

  it("a label token that failed shows the card's error, not a fresh stamp, and Retry refetches it", async () => {
    let ok = false
    serve((r) => (r.metric === 'bsk.pageviews' && !ok ? ({ status: 'error', reason: 'boom' } as unknown as MetricValue) : ({ status: 'ok', value: 8 } as MetricValue)))
    const w = card({ v: 1, title: `T ${tokenOf('bsk.pageviews')}`, showUpdated: 'header', sections: [{ layout: 'rows', items: [fieldItem as never] }] })
    await settle()
    expect(w.find('.mc-error').exists()).toBe(true)
    expect(w.find('.mc-updated').exists()).toBe(false)
    expect(w.text()).toContain('T —')
    ok = true
    await w.get('button.mc-retry').trigger('click')
    await settle()
    expect(w.find('.mc-error').exists()).toBe(false)
    expect(w.text()).toContain('T 8')
  })

  it('Reload on a card with no metric token sends only its own items', async () => {
    serve(() => ({ status: 'ok', value: 3 }) as MetricValue)
    const w = card(spec({ title: 'Plain', showUpdated: 'header' }))
    await settle()
    await reloadBtn(w).trigger('click')
    await settle()
    expect(posts().flatMap(keysOf).every((k) => k === 'bsk.gameViews@page')).toBe(true)
  })
})
