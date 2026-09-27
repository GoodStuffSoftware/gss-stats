// @vitest-environment happy-dom
//
// A light mounting smoke test on top of the exhaustive pure-function coverage in
// lib/metrics/render.test.ts, lib/metrics/scope.test.ts and composables/useMetrics.test.ts:
// confirms MetricCard actually wires CardRef resolution, repeat expansion and the
// 'open-campaigns' click-through together end to end, through real DOM mounting.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { CAMPAIGNS } from '../../lib/campaigns'
import type { MetricsResponseBody } from '../../lib/metrics/types'

// useMetrics' cache/batch state is module-level (intentionally — see useMetrics.ts), so it
// persists across tests in this file unless reset; unmounting drops each test's own components
// (and their pending 10ms coalescing timers) before the next test swaps the global fetch stub,
// so a late timer never fires against a real network call.
const mounted: VueWrapper[] = []
function mountCard(props: InstanceType<typeof MetricCard>['$props']) {
  const wrapper = mount(MetricCard, { props })
  mounted.push(wrapper)
  return wrapper
}
beforeEach(() => __resetMetricsStateForTests())
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})

function mockMetricsFetch() {
  return vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { requests: { key: string }[] }
    const results: MetricsResponseBody['results'] = {}
    for (const r of body.requests) results[r.key] = { status: 'ok', value: 42 }
    return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
  })
}

describe('MetricCard', () => {
  it('a repeated preset (campaign-scorecard) renders one bordered card per campaign, with its title', async () => {
    vi.stubGlobal('fetch', mockMetricsFetch())
    const wrapper = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: Date.parse('2026-09-27T12:00:00Z') })
    await flushPromises()
    const cards = wrapper.findAll('.metric-card')
    expect(cards).toHaveLength(CAMPAIGNS.length)
    expect(wrapper.text()).toContain(CAMPAIGNS[0].label)
  })

  it('clicking a linked card emits open-campaigns', async () => {
    vi.stubGlobal('fetch', mockMetricsFetch())
    const wrapper = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: Date.parse('2026-09-27T12:00:00Z') })
    await flushPromises()
    await wrapper.find('.metric-card').trigger('click')
    expect(wrapper.emitted('open-campaigns')).toBeTruthy()
  })

  it('an unrepeated preset (bsk-kpis) renders its section directly, with no bordered card wrapper', async () => {
    vi.stubGlobal('fetch', mockMetricsFetch())
    const wrapper = mountCard({ cardRef: { preset: 'bsk-kpis' }, nowMs: Date.parse('2026-09-27T12:00:00Z') })
    await flushPromises()
    expect(wrapper.find('.metric-card').exists()).toBe(false)
    expect(wrapper.find('.metric-card-plain').exists()).toBe(true)
    expect(wrapper.findAll('.mi-tile').length).toBeGreaterThan(0)
  })

  it('an unknown preset id renders an error message instead of throwing', () => {
    const wrapper = mountCard({ cardRef: { preset: 'nope-not-real' } })
    expect(wrapper.text()).toContain('nope-not-real')
  })
})
