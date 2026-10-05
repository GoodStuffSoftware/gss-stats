// @vitest-environment happy-dom
//
// Metric tokens in a card's labels, from the editor (value-tokens release 3): the live preview is a
// real MetricCard, so a label's `{=metric:…}` shows its current value there, and every label's
// "Insert value" menu (the editor hands its page context to them) shows the value the page already
// holds for each metric, as the chart caption's does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import CardEditor from './CardEditor.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import type { CardSpec, MetricsContext } from '../../lib/metrics/types'

const CTX: MetricsContext = { since: '2026-09-01T04:00:00.000Z', until: '2026-10-01T04:00:00.000Z' }
const SPEC: CardSpec = {
  v: 1,
  title: 'Traffic {=metric:bsk.pageviews@page|number}',
  sections: [{ layout: 'rows', items: [{ id: 'views', label: 'Views', data: { metric: 'bsk.gameViews', window: 'page' }, display: { as: 'number' } }] }],
}

const mounted: VueWrapper[] = []
beforeEach(() => {
  __resetMetricsStateForTests()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { requests: { key: string }[] }
      const results: Record<string, unknown> = {}
      for (const r of body.requests) results[r.key] = { status: 'ok', value: 4321 }
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
  await new Promise((r) => setTimeout(r, 40))
  await flushPromises()
}

describe('CardEditor: metric tokens in labels', () => {
  it('the preview shows a label token\'s current value, and every label\'s Insert menu shows the value the page holds', async () => {
    const w = mount(CardEditor, { props: { modelValue: { spec: SPEC }, context: CTX }, attachTo: document.body })
    mounted.push(w)
    await settle()
    expect(w.text()).toContain('Traffic 4,321') // the preview card, filled from the batched request
    const option = w.find('select.insert-value option[value="{=metric:bsk.pageviews@page|number}"]')
    expect(option.exists()).toBe(true)
    expect(option.text()).toMatch(/\(4,321\)$/) // the value the preview already loaded, read from the cache
  })
})
