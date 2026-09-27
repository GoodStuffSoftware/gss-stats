// @vitest-environment happy-dom
//
// ChartEditor × metric card (ADR 0003 phase B integration): a widget with `card` set shows
// CardEditor in place of the chart-only fields; "Add chart" gets a "Metric card" choice that
// starts from a default preset; Cancel discards the draft untouched; a saved edit survives
// normalizeConfig and shows up in a real render (ChartCard -> MetricCard).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import ChartCard from './ChartCard.vue'
import { __resetMetricsStateForTests } from '../composables/useMetrics'
import { normalizeConfig } from '../lib/defaults'
import { presetById } from '../lib/metrics/presets'
import type { CardSpec } from '../lib/metrics/types'
import type { DashboardConfig, GlobalFilters, Widget } from '../types'

const mounted: VueWrapper[] = []
function mountEditor(widget: Widget, isNew = false, filters?: GlobalFilters) {
  const w = mount(ChartEditor, { props: { widget, isNew, filters } })
  mounted.push(w)
  return w
}
beforeEach(() => {
  __resetMetricsStateForTests()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { requests: { key: string }[] }
      const results: Record<string, unknown> = {}
      for (const r of body.requests) results[r.key] = { status: 'ok', value: 42 }
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})

const filters: GlobalFilters = { siteSel: [], since: '2026-09-20T00:00:00.000Z', until: '2026-09-27T00:00:00.000Z', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
const kpiWidget: Widget = { id: 'ow-kpis', i: 'ow-kpis', title: 'Today at a glance', type: 'table', dataset: 'overview', view: 'kpis', card: { preset: 'bsk-kpis' }, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 3, w: 12, h: 8 }

describe('a widget with card shows CardEditor', () => {
  it('replaces the chart-only fields, but keeps the Title field', async () => {
    const w = mountEditor(kpiWidget)
    await flushPromises()
    expect(w.find('input[placeholder="Chart title"]').exists()).toBe(true) // Title stays
    expect(w.find('label').text()).not.toBe('Data source') // chart-only fields are gone
    expect(w.text()).toContain('This chart is a metric card.')
    expect(w.find('.ce-root').exists()).toBe(true) // CardEditor mounted
  })

  it('editing the card and saving updates the emitted widget in place, keeping id/position', async () => {
    const w = mountEditor(kpiWidget)
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Customize…')!.trigger('click') // CardEditor's own
    await flushPromises()
    const titleCheckbox = w.findAll('.field.check input[type=checkbox]')[0]
    await titleCheckbox.setValue(true)
    await flushPromises()
    const titleInput = w.find('input[placeholder="Card title"]')
    await titleInput.setValue('Today, live')
    await flushPromises()

    await w.find('button.btn-primary').trigger('click') // ChartEditor's own Save
    const saved = w.emitted('save')
    expect(saved).toBeTruthy()
    const widget = saved![0][0] as Widget
    expect(widget.id).toBe('ow-kpis')
    expect(widget.x).toBe(0)
    expect(widget.y).toBe(3)
    expect(widget.w).toBe(12)
    expect(widget.h).toBe(8)
    expect(widget.card && 'spec' in widget.card ? (widget.card.spec as CardSpec).title : undefined).toBe('Today, live')
  })
})

describe('the edit survives normalizeConfig and a real render', () => {
  it('normalizeConfig keeps the customized card, and ChartCard renders the new title', async () => {
    const w = mountEditor(kpiWidget)
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Customize…')!.trigger('click')
    await flushPromises()
    await w.findAll('.field.check input[type=checkbox]')[0].setValue(true)
    await flushPromises()
    await w.find('input[placeholder="Card title"]').setValue('Today, live')
    await flushPromises()
    await w.find('button.btn-primary').trigger('click')
    const savedWidget = w.emitted('save')![0][0] as Widget

    const raw: DashboardConfig = { version: 10, activePageId: 'p1', pages: [{ id: 'p1', name: 'P', filters: { siteSel: [] } as any, widgets: [savedWidget] }] } as any
    const normalized = normalizeConfig(raw)
    const normWidget = normalized.pages[0].widgets[0]
    expect(normWidget.card && 'spec' in normWidget.card ? (normWidget.card.spec as CardSpec).title : undefined).toBe('Today, live')

    const cardWrapper = mount(ChartCard, { props: { widget: normWidget, filters, dark: false, drillOpen: false }, attachTo: document.body })
    mounted.push(cardWrapper)
    for (let i = 0; i < 4; i++) {
      await flushPromises()
      await new Promise((r) => setTimeout(r, 15))
    }
    expect(cardWrapper.text()).toContain('Today, live')
  })
})

describe('"Add chart" -> "Metric card"', () => {
  const newWidget: Widget = { id: 'new1', i: 'new1', title: 'New chart', type: 'bar', dataset: undefined, dimension: 'requestHost', metric: 'pageviews', limit: 10, x: 0, y: 9999, w: 6, h: 8 }

  it('starts a brand-new widget from a default preset the owner can customize', async () => {
    const w = mountEditor(newWidget, true)
    await flushPromises()
    expect(w.find('.ce-root').exists()).toBe(false) // not a card yet
    const makeCardBtn = w.findAll('button').find((b) => b.text() === 'Make this a metric card instead')!
    await makeCardBtn.trigger('click')
    await flushPromises()
    expect(w.find('.ce-root').exists()).toBe(true)
    expect(w.text()).toContain('Campaign Scorecard') // the default preset, pre-selected

    await w.find('button.btn-primary').trigger('click')
    const saved = w.emitted('save')![0][0] as Widget
    expect(saved.card).toEqual({ preset: 'campaign-scorecard' })
    expect(presetById('campaign-scorecard')).toBeDefined()
  })

  it('"Switch to a regular chart" leaves card mode', async () => {
    const w = mountEditor(newWidget, true)
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Make this a metric card instead')!.trigger('click')
    await flushPromises()
    expect(w.find('.ce-root').exists()).toBe(true)
    await w.findAll('button').find((b) => b.text() === 'Switch to a regular chart')!.trigger('click')
    await flushPromises()
    expect(w.find('.ce-root').exists()).toBe(false)
  })
})

describe('Cancel leaves the widget unchanged', () => {
  it('emits cancel, never save, and never mutates the original widget prop', async () => {
    const original: Widget = { ...kpiWidget }
    const before = JSON.parse(JSON.stringify(original))
    const w = mountEditor(original)
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Customize…')!.trigger('click')
    await flushPromises()
    await w.findAll('.field.check input[type=checkbox]')[0].setValue(true)
    await w.find('input[placeholder="Card title"]').setValue('Should not persist')
    await flushPromises()

    const cancelBtn = w.findAll('button').find((b) => b.text() === 'Cancel')!
    await cancelBtn.trigger('click')

    expect(w.emitted('cancel')).toBeTruthy()
    expect(w.emitted('save')).toBeUndefined()
    expect(original).toEqual(before) // the prop object itself was never mutated
  })
})
