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
import type { CardSpec, MetricsResponseBody } from '../../lib/metrics/types'
import { PRESETS } from '../../lib/metrics/presets'
import NoteBlock from '../NoteBlock.vue'

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

// Slice 1c, decision D7: a card's own spec captions stay with the spec, and the widget can hide
// them (Widget.hiddenCaveats, passed as hiddenCaptions). A data-cut note (hideable: false) and an
// unknown id are never hidden.
describe('MetricCard — hiddenCaptions', () => {
  const NOW = Date.parse('2026-09-27T12:00:00Z')
  const withCaptions = (captions: string[]): CardSpec => ({ ...JSON.parse(JSON.stringify(PRESETS['bsk-kpis'])), captions })
  const captionIds = (w: VueWrapper) => (w.find('.mc-captions').exists() ? w.findAllComponents(NoteBlock).map((c) => c.props('noteId')).filter(Boolean) : [])

  it('shows every spec caption when nothing is hidden', async () => {
    vi.stubGlobal('fetch', mockMetricsFetch())
    const w = mountCard({ cardRef: { spec: withCaptions(['small-sample', 'country-split-excludes-refused', 'not-a-note']) }, nowMs: NOW })
    await flushPromises()
    expect(captionIds(w)).toEqual(['small-sample', 'country-split-excludes-refused', 'not-a-note'])
  })

  it('hides a hideable caption, and ignores a hidden data-cut note or an unknown id', async () => {
    vi.stubGlobal('fetch', mockMetricsFetch())
    const w = mountCard({
      cardRef: { spec: withCaptions(['small-sample', 'country-split-excludes-refused', 'not-a-note']) },
      hiddenCaptions: ['small-sample', 'country-split-excludes-refused', 'not-a-note'],
      nowMs: NOW,
    })
    await flushPromises()
    expect(captionIds(w)).toEqual(['country-split-excludes-refused', 'not-a-note'])
  })

  it('drops the captions area when every caption is hidden, and a preset caption hides by its registry id', async () => {
    vi.stubGlobal('fetch', mockMetricsFetch())
    const [presetId] = Object.entries(PRESETS).find(([, s]) => s.captions?.includes('release-before-partial'))!
    const shown = mountCard({ cardRef: { preset: presetId }, nowMs: NOW })
    const hidden = mountCard({ cardRef: { preset: presetId }, hiddenCaptions: ['release-before-partial'], nowMs: NOW })
    await flushPromises()
    expect(shown.find('.mc-captions').exists()).toBe(true)
    expect(hidden.find('.mc-captions').exists()).toBe(false)
  })
})
