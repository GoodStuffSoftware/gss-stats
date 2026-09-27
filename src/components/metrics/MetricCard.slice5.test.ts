// @vitest-environment happy-dom
//
// MetricCard, slice 5: the freshness footer and its reload, following the page context after
// mount, omitting a section every item of which is gated away, the compact notes toggle, the
// accessible name of a row/tile, and a preset id that is an Object.prototype member.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import type { CardSpec, MetricValue, MetricsRequestBody } from '../../lib/metrics/types'

const mounted: VueWrapper[] = []
const bodies: MetricsRequestBody[] = []
let answer: (req: MetricsRequestBody['requests'][number], body: MetricsRequestBody) => MetricValue = () => ({ status: 'ok', value: 42 })

beforeEach(() => {
  __resetMetricsStateForTests()
  bodies.length = 0
  answer = () => ({ status: 'ok', value: 42 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as MetricsRequestBody
      bodies.push(body)
      const results = Object.fromEntries(body.requests.map((r) => [r.key, answer(r, body)]))
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})
async function settle() {
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 15))
  }
}
function mountCard(props: InstanceType<typeof MetricCard>['$props']) {
  const w = mount(MetricCard, { props })
  mounted.push(w)
  return w
}
const NOW = Date.parse('2026-09-27T16:00:00Z')

describe('MetricCard — slice 5', () => {
  it('an Object.prototype member as a preset id is an unknown card, not a crash', () => {
    for (const preset of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(mountCard({ cardRef: { preset } }).text()).toContain(`Unknown card preset "${preset}"`)
    }
  })

  it('showUpdated: "Updated just now" after the first load, and ↻ refetches the whole card fresh', async () => {
    const w = mountCard({ cardRef: { preset: 'bsk-kpis' }, nowMs: NOW })
    expect(w.find('.mc-updated').exists()).toBe(false) // nothing loaded yet
    await settle()
    expect(w.find('.mc-updated').text()).toBe('Updated just now')
    const firstBatch = bodies[0].requests.length
    await w.find('button.mc-reload').trigger('click')
    await settle()
    const fresh = bodies.filter((b) => b.fresh)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].requests).toHaveLength(firstBatch)
  })

  it('a card without showUpdated has no footer; reload() is exposed for ChartCard', async () => {
    const w = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: NOW })
    await settle()
    expect(w.find('.mc-footer').exists()).toBe(false)
    ;(w.vm as unknown as { reload(): void }).reload()
    await settle()
    expect(bodies.some((b) => b.fresh)).toBe(true)
  })

  it('follows the page context after mount: a new range re-requests every item in one batch', async () => {
    const spec: CardSpec = { v: 1, sections: [{ layout: 'rows', items: [{ id: 'pv', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'page' }, display: { as: 'number' } }, { id: 'auth', label: { metric: true }, data: { metric: 'bsk.authSuccess', window: 'page' }, display: { as: 'number' } }] }] }
    answer = (r, body) => ({ status: 'ok', value: body.context?.since?.startsWith('2026-09-01') ? 1 : 2 })
    const w = mountCard({ cardRef: { spec }, nowMs: NOW, context: { since: '2026-09-01T04:00:00.000Z', until: '2026-09-08T04:00:00.000Z' } })
    await settle()
    expect(w.findAll('.mi-value').map((v) => v.text())).toEqual(['1', '1'])
    const before = bodies.length
    await w.setProps({ context: { since: '2026-09-10T04:00:00.000Z', until: '2026-09-17T04:00:00.000Z' } })
    await settle()
    const after = bodies.slice(before)
    expect(after).toHaveLength(1)
    expect(after[0].context?.since).toBe('2026-09-10T04:00:00.000Z')
    expect(w.findAll('.mi-value').map((v) => v.text())).toEqual(['2', '2'])
  })

  it('a section every item of which is gated away is omitted, title included', async () => {
    const spec: CardSpec = {
      v: 1,
      repeat: { over: 'campaigns', ids: ['24215315197'] }, // closed: unmeasured items are omitted
      sections: [
        { layout: 'rows', title: 'Kept', items: [{ id: 'a', label: { metric: true }, data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }] },
        { layout: 'pills', title: 'Dropped', items: [{ id: 'c', label: { metric: true }, data: { metric: 'campaign.completions' }, display: { as: 'number' } }] },
      ],
    }
    answer = (r) => (r.metric === 'campaign.completions' ? { status: 'unmeasured', reason: 'not-live' } : { status: 'ok', value: 50 })
    const w = mountCard({ cardRef: { spec }, nowMs: NOW })
    await settle()
    expect(w.text()).toContain('Kept')
    expect(w.text()).not.toContain('Dropped')
    expect(w.findAll('.metric-section')).toHaveLength(1)
  })

  it('compact notes: collapsed by default, one click opens the caption, the card click is not triggered', async () => {
    answer = (r) => (r.metric === 'campaign.taggedArrivals' ? { status: 'ok', value: 7, noteIds: ['arrivals-caveat'] } : { status: 'ok', value: 1 })
    const w = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: NOW })
    await settle()
    const toggle = w.find('button.mi-notes-btn')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.attributes('title')).toMatch(/^Floor/)
    expect(w.find('.mi-caption').exists()).toBe(false)
    await toggle.trigger('click')
    expect(w.find('.mi-caption').text()).toMatch(/^Floor/)
    expect(w.emitted('open-campaigns')).toBeUndefined()
  })

  it('a row and a tile carry one accessible name: label, value and deltas', async () => {
    answer = () => ({ status: 'ok', value: 86, deltas: { yesterday: { delta: 31, deltaPct: 0.56 } } })
    const w = mountCard({ cardRef: { preset: 'bsk-kpis' }, nowMs: NOW })
    await settle()
    expect(w.find('.mi-tile').attributes('aria-label')).toBe('Page views: 86, vs yesterday +31 (+56%)')
  })
})
