// @vitest-environment happy-dom
//
// MetricSection.vue's barMax/anyVisible reactivity (review fix, 2026-09-27 — the same
// staleness useMetricItem.ts had): both used to be computed once, at setup, from a frozen
// snapshot of flattenSectionItems() — editing a 'bars' card's items, or a section's item list,
// left the bar scale or the show/hide decision reading stale data forever. These tests drive it
// through real prop changes (as CardEditor's live preview would) and assert both follow the
// edit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import MetricSection from './MetricSection.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { ROOT_SCOPE } from '../../lib/metrics/scope'
import type { MetricItem, MetricsRequestBody, MetricsResponseBody, Section } from '../../lib/metrics/types'

const mounted: VueWrapper[] = []
function mountSection(section: Section) {
  const w = mount(MetricSection, { props: { section, outerScope: ROOT_SCOPE, ctx: { todayEt: '2026-09-27' } } })
  mounted.push(w)
  return w
}
beforeEach(() => __resetMetricsStateForTests())
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})

function mockFetch(valueFor: (metric: string | undefined) => number) {
  return vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as MetricsRequestBody
    const results: MetricsResponseBody['results'] = {}
    for (const r of body.requests) results[r.key] = { status: 'ok', value: valueFor(r.metric) }
    return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
  })
}
async function settle() {
  await flushPromises()
  await new Promise((r) => setTimeout(r, 15))
  await flushPromises()
}

const barItem = (id: string, metric: string): MetricItem => ({ id, label: id, data: { metric, window: 'todaySoFar' }, display: { as: 'bar' } })

describe('MetricSection — bars layout scale follows a live edit', () => {
  it('editing an item (a different metric, a different value) rescales every bar, not just the new one', async () => {
    vi.stubGlobal('fetch', mockFetch((m) => (m === 'bsk.pageviews' ? 50 : m === 'bsk.gameViews' ? 30 : m === 'bsk.completions' ? 400 : 0)))
    const w = mountSection({ layout: 'bars', items: [barItem('a', 'bsk.pageviews'), barItem('b', 'bsk.gameViews')] })
    await settle()

    const widthOf = (i: number) => Number((w.findAll('.mi-bar-fill')[i].attributes('style') ?? '').match(/width:\s*([\d.]+)%/)?.[1])
    expect(widthOf(0)).toBe(100) // 50 / max(50,30)
    expect(widthOf(1)).toBeCloseTo(60, 0) // 30 / 50 * 100

    // Edit item 'b' to a metric with a much larger value — CardEditor round-trips a NEW item
    // object with the same id, same shape as a real edit.
    await w.setProps({ section: { layout: 'bars', items: [barItem('a', 'bsk.pageviews'), barItem('b', 'bsk.completions')] } })
    await settle()

    expect(widthOf(0)).toBe(13) // round(50 / 400 * 100) — item 'a' rescales too, not just 'b'
    expect(widthOf(1)).toBe(100) // 400 / max(50,400)
  })
})

describe('MetricSection — anyVisible follows the item list', () => {
  it('removing the last visible item hides the section; adding one back shows it', async () => {
    vi.stubGlobal('fetch', mockFetch(() => 1))
    const w = mountSection({ layout: 'rows', items: [{ id: 'a', label: 'A', data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: { as: 'number' } }] })
    await settle()
    expect(w.find('.metric-section').exists()).toBe(true)

    await w.setProps({ section: { layout: 'rows', items: [] } })
    await settle()
    expect(w.find('.metric-section').exists()).toBe(false)

    await w.setProps({ section: { layout: 'rows', items: [{ id: 'a', label: 'A', data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: { as: 'number' } }] } })
    await settle()
    expect(w.find('.metric-section').exists()).toBe(true)
    expect(w.text()).toContain('A')
  })
})

describe('MetricSection — the row table', () => {
  const tableSection: Section = {
    layout: 'table',
    repeat: { over: 'readings' },
    items: [
      { id: 'when', label: 'Read', data: { field: 'reading.readAt' }, display: { as: 'datetime-et' } },
      { id: 'asks', label: 'Asks', data: { field: 'reading.count.asks' }, display: { as: 'number' } },
      { id: 'kind', label: 'Kind', data: { field: 'reading.kind' }, display: { as: 'text' } },
    ],
  }
  const mountTable = () => {
    const w = mount(MetricSection, {
      props: {
        section: tableSection,
        outerScope: ROOT_SCOPE,
        ctx: { todayEt: '2026-09-27', readings: [{ campaignId: 'c1', readAt: '2026-09-26T19:00:00Z', kind: 'daily', spend: 1, counts: { asks: 7 } }] },
      },
    })
    mounted.push(w)
    return w
  }

  it('sits in a .metric-table-wrap, so a wide table scrolls inside its card instead of being clipped', () => {
    const w = mountTable()
    const wrap = w.find('.metric-table-wrap')
    expect(wrap.exists()).toBe(true)
    expect(wrap.find('table.metric-table').exists()).toBe(true)
    expect(w.findAll('.metric-table')).toHaveLength(1)
  })

  it('right-aligns a number column (header and cells), not a text one', () => {
    const w = mountTable()
    expect(w.findAll('th').map((th) => th.classes().includes('num'))).toEqual([false, true, false])
    expect(w.findAll('tbody td').map((td) => td.classes().includes('num'))).toEqual([false, true, false])
  })
})
