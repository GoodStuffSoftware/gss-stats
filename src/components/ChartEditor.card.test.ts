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
import { CAMPAIGNS } from '../lib/campaigns'
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
    expect(w.text()).toContain('Campaign scorecard') // the default preset, pre-selected, by its plain name

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

describe('Save is disabled while the card is invalid (review fix, 2026-09-27)', () => {
  it('disables Save with a visible reason while CardEditor reports errors, and re-enables once valid', async () => {
    const w = mountEditor(kpiWidget) // starts valid: { preset: 'bsk-kpis' }
    await flushPromises()
    const saveBtn = () => w.findAll('button').find((b) => b.text() === 'Save')!
    expect(saveBtn().attributes('disabled')).toBeUndefined()
    expect(w.find('.save-reason').exists()).toBe(false)

    // "Blank card" with no Customize yet is CardEditor's own invalid state (no CardRef of its
    // own) — drives errors non-empty without needing to fabricate anything.
    await w.find('select').setValue('')
    await flushPromises()
    expect(saveBtn().attributes('disabled')).toBeDefined()
    expect(w.find('.save-reason').exists()).toBe(true)
    expect(w.find('.save-reason').text()).toBe('Fix the highlighted fields to save.')

    // Clicking Save while disabled must be a no-op: no new emission past whatever the last
    // VALID state emitted (there was none here, so still nothing).
    await saveBtn().trigger('click')
    expect(w.emitted('save')).toBeUndefined()

    await w.find('select').setValue('bsk-kpis')
    await flushPromises()
    expect(saveBtn().attributes('disabled')).toBeUndefined()
    expect(w.find('.save-reason').exists()).toBe(false)
  })
})

describe('Save gating never affects a non-card chart (review fix, 2026-09-27)', () => {
  it('a plain chart\'s Save is never disabled by the card validity mechanism', async () => {
    const plainWidget: Widget = { id: 'plain1', i: 'plain1', title: 'A bar chart', type: 'bar', dataset: undefined, dimension: 'requestHost', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 8 }
    const w = mountEditor(plainWidget)
    await flushPromises()
    const saveBtn = w.findAll('button').find((b) => b.text() === 'Save')!
    expect(saveBtn.attributes('disabled')).toBeUndefined()
    expect(w.find('.save-reason').exists()).toBe(false)
    expect(w.find('.ce-root').exists()).toBe(false) // CardEditor never even mounts for this widget
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

// Widget.campaignIds narrows a card repeated over campaigns (MetricCard campaignIds), as it
// narrowed the old campaign panels; the Campaign(s) picker shows for such a card only.
describe('a campaign card honours the widget\'s campaign selection', () => {
  const funnelWidget: Widget = { id: 'cw-funnel', i: 'cw-funnel', title: 'Funnel per campaign', type: 'table', dataset: 'campaigns', view: 'funnel', card: { preset: 'campaign-funnel' }, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 12, h: 10 }
  const RETEST = '24279250691'
  // The funnel preset draws one card per beacon-tracked campaign (Play-direct is spend-only, so it has none).
  const TRACKED_TITLES = CAMPAIGNS.filter((c) => c.measurement !== 'spend-only').map((c) => c.label)
  const campaignBoxes = (w: VueWrapper) => w.findAll('.campaign-list .campaign-row').filter((r) => /Android launch|US\+CA web retest|Play-direct/.test(r.text()))
  const titles = (w: VueWrapper) => w.findAll('.metric-card .mc-title').map((t) => t.text())

  it('the picker shows for a campaign-repeated card, not for the KPI tiles', async () => {
    const kpi = mountEditor(kpiWidget)
    await flushPromises()
    expect(kpi.text()).not.toContain('Campaign(s)')
    const funnel = mountEditor(funnelWidget)
    await flushPromises()
    expect(funnel.text()).toContain('Campaign(s)')
    expect(campaignBoxes(funnel).length).toBeGreaterThanOrEqual(3)
  })

  it('checking one campaign narrows the preview and is saved on the widget', async () => {
    const w = mountEditor(funnelWidget)
    await flushPromises()
    expect(titles(w)).toEqual(TRACKED_TITLES)
    const retestBox = campaignBoxes(w).find((r) => r.text().includes('US+CA web retest'))!.find('input')
    await retestBox.setValue(true)
    await flushPromises()
    expect(titles(w)).toEqual(['US+CA web retest'])
    await w.find('button.btn-primary').trigger('click')
    const widget = w.emitted('save')![0][0] as Widget
    expect(widget.campaignIds).toEqual([RETEST])
    expect(widget.card).toEqual({ preset: 'campaign-funnel' })
  })

  it('a saved selection narrows the rendered card (ChartCard → MetricCard)', async () => {
    const all = mount(ChartCard, { props: { widget: funnelWidget, filters, dark: false, drillOpen: false } })
    const one = mount(ChartCard, { props: { widget: { ...funnelWidget, campaignIds: [RETEST] }, filters, dark: false, drillOpen: false } })
    mounted.push(all, one)
    await flushPromises()
    expect(titles(all)).toEqual(TRACKED_TITLES)
    expect(titles(one)).toEqual(['US+CA web retest'])
  })
})

describe('a pop-up rate tile in the editor (ADR 0005 slice 4 follow-ups)', () => {
  const rate: Widget = { id: 'r', i: 'r', title: 'Rate', type: 'rate', dataset: 'popup', dimension: 'install:outcome:installed', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3 }
  const row = (w: VueWrapper) => w.find('.caveat-row[data-key="runtime:popup-note"]')
  it('has no "This chart" value group, only Dates (it renders its own body)', async () => {
    const w = mountEditor(rate)
    await flushPromises()
    const groups = w.findAll('optgroup').map((g) => g.attributes('label'))
    expect(groups).toContain('Dates')
    expect(groups).not.toContain('This chart')
  })
  it('offers a Show/Hide row for the pop-up note with no data loaded; hide then show round-trips', async () => {
    const w = mountEditor(rate)
    await flushPromises()
    const box = () => row(w).get('input[type="checkbox"]')
    expect((box().element as HTMLInputElement).checked).toBe(true)
    await box().setValue(false)
    await w.get('button.btn-primary').trigger('click')
    expect((w.emitted('save')!.at(-1)![0] as Widget).hiddenCaveats).toEqual(['popup-note'])
    await box().setValue(true)
    await w.get('button.btn-primary').trigger('click')
    expect('hiddenCaveats' in (w.emitted('save')!.at(-1)![0] as Widget)).toBe(false)
  })
  it('has no pop-up note row on a key with no install-fix note (upsell:tap)', async () => {
    const w = mountEditor({ ...rate, dimension: 'upsell:tap' })
    await flushPromises()
    expect(row(w).exists()).toBe(false)
  })
  it('a stored hide shows as an unchecked row (one row, not two)', async () => {
    const w = mountEditor({ ...rate, hiddenCaveats: ['popup-note'] })
    await flushPromises()
    expect((row(w).get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    expect(w.findAll('.caveat-row[data-key$="popup-note"]')).toHaveLength(1)
  })
})
