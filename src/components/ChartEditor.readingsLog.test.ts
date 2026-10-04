// @vitest-environment happy-dom
//
// ADR 0005 slice 3, step B2: the readings log is a metric card, so the editor's View picker no
// longer offers "Readings log"; a new "Ads readings" chart starts as the preset card; an existing
// legacy widget is not converted by opening it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import { __resetMetricsStateForTests } from '../composables/useMetrics'
import type { Widget } from '../types'

const mounted: VueWrapper[] = []
const mountEditor = (widget: Widget, isNew = false) => {
  const w = mount(ChartEditor, { props: { widget, isNew } })
  mounted.push(w)
  return w
}
beforeEach(() => {
  __resetMetricsStateForTests()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{"requests":[]}') as { requests: { key: string }[] }
      const results: Record<string, unknown> = {}
      for (const r of body.requests) results[r.key] = { status: 'ok', value: 1 }
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})
const base: Widget = { id: 'new1', i: 'new1', title: 'New chart', type: 'bar', dataset: undefined, dimension: 'requestHost', metric: 'pageviews', limit: 10, x: 0, y: 9999, w: 6, h: 8 }
const legacy: Widget = { ...base, id: 'ar', i: 'ar', title: 'Ads readings', type: 'table', dataset: 'ads-readings', view: 'log', dimension: '', limit: 30 }

describe('ChartEditor and the ads readings log', () => {
  it('choosing the Ads readings data source starts a preset card', async () => {
    const w = mountEditor(base, true)
    await flushPromises()
    const select = w.findAll('select').find((s) => s.findAll('option').some((o) => o.text() === 'Best Sudoku ads readings log'))!
    const option = select.findAll('option').find((o) => o.text() === 'Best Sudoku ads readings log')!
    await select.setValue((option.element as HTMLOptionElement).value)
    await flushPromises()
    expect(w.find('.ce-root').exists()).toBe(true)
    expect(w.text()).toContain('This chart is a metric card.')
    await w.find('button.btn-primary').trigger('click')
    const saved = w.emitted('save')![0][0] as Widget
    expect(saved.dataset).toBe('ads-readings')
    expect(saved.card).toEqual({ preset: 'ads-readings-log' })
  })
  it('no View picker offers a Readings log option', async () => {
    const w = mountEditor(legacy)
    await flushPromises()
    expect(w.text()).not.toContain('Readings log')
  })
  it('opening a legacy widget does not convert it; saving it keeps it a legacy widget', async () => {
    const w = mountEditor(legacy)
    await flushPromises()
    expect(w.find('.ce-root').exists()).toBe(false)
    await w.find('button.btn-primary').trigger('click')
    const saved = w.emitted('save')![0][0] as Widget
    expect(saved.card).toBeUndefined()
    expect(saved).toMatchObject({ dataset: 'ads-readings', view: 'log', limit: 30 })
  })
  it('the View picker stays for the other datasets', async () => {
    const w = mountEditor({ ...base, dataset: 'campaigns', view: 'scorecard', type: 'table', dimension: '' })
    await flushPromises()
    expect(w.findAll('label').some((l) => l.text() === 'View')).toBe(true)
  })
})
