// @vitest-environment happy-dom
//
// Phase 3 (editor entry points): "Add chart" no longer offers the overview and campaigns datasets
// (those cards are Metric card -> preset), there is no View picker, and every widget but a note
// gets a Filters row that edits widget.filters through the same FilterPopover ChartCard uses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import ChartCard from './ChartCard.vue'
import { __resetMetricsStateForTests } from '../composables/useMetrics'
import { CARD_PRESET_FOR_PANEL, defaultBestSudokuPopupsWidgets, syncCardWithView } from '../lib/defaults'
import { CAMPAIGNS_VIEWS, OVERVIEW_VIEWS } from '../lib/catalog'
import type { GlobalFilters, Widget } from '../types'

const mounted: VueWrapper[] = []
function mountEditor(widget: Widget, isNew = false, filters?: GlobalFilters) {
  const w = mount(ChartEditor, { props: { widget, isNew, filters }, attachTo: document.body })
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

const page: GlobalFilters = { siteSel: [], since: '2026-09-20T00:00:00.000Z', until: '2026-09-27T00:00:00.000Z', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
const override: GlobalFilters = { ...page, since: '2026-09-01T00:00:00.000Z', until: '2026-09-10T00:00:00.000Z', excludeOwnVisits: true }
const base: Widget = { id: 'new1', i: 'new1', title: 'New chart', type: 'bar', dataset: undefined, dimension: 'requestHost', metric: 'pageviews', limit: 10, x: 0, y: 9999, w: 6, h: 8 }
const stored = (dataset: 'overview' | 'campaigns', view: string): Widget =>
  syncCardWithView({ id: `${dataset}-${view}`, i: `${dataset}-${view}`, title: 'Stored', type: 'table', dataset, view, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 12, h: 8 })

const dataSourceLabels = (w: VueWrapper) => {
  const select = w.findAll('select').find((s) => s.findAll('option').some((o) => o.text().startsWith('RUM')))!
  return select.findAll('option').map((o) => o.text())
}
const filtersRow = (w: VueWrapper) => w.find('[data-testid="filters-row"]')
const rowButtons = (w: VueWrapper) => filtersRow(w).findAll('button').map((b) => b.text())

describe('"Add chart" entry points', () => {
  it('the Data source list no longer offers the overview or campaigns cards, and keeps the rest', async () => {
    const w = mountEditor(base, true)
    await flushPromises()
    const labels = dataSourceLabels(w)
    expect(labels.some((l) => l.startsWith('Best Sudoku overview cards'))).toBe(false)
    expect(labels.some((l) => l.startsWith('Best Sudoku campaign cards'))).toBe(false)
    expect(labels.some((l) => l.startsWith('Best Sudoku ads readings log'))).toBe(true)
    expect(labels.some((l) => l.startsWith('Best Sudoku completions'))).toBe(true)
    expect(labels.length).toBe(5)
  })
  it('says overview and campaign cards are presets, under the Metric card button', async () => {
    const w = mountEditor(base, true)
    await flushPromises()
    expect(w.text()).toContain('Overview and campaign cards are presets here.')
  })
  it('has no View picker', async () => {
    const w = mountEditor(base, true)
    await flushPromises()
    expect(w.findAll('label').some((l) => l.text() === 'View')).toBe(false)
  })

  const ALL: Array<['overview' | 'campaigns', string]> = [
    ...OVERVIEW_VIEWS.map((v) => ['overview', v.value] as ['overview', string]),
    ...CAMPAIGNS_VIEWS.map((v) => ['campaigns', v.value] as ['campaigns', string]),
  ]
  for (const [dataset, view] of ALL) {
    it(`${dataset}:${view}: Metric card -> preset saves the same card as the old View path`, async () => {
      const oldCard = stored(dataset, view).card as { preset: string }
      expect(oldCard.preset).toBe(CARD_PRESET_FOR_PANEL[`${dataset}:${view}`])
      const w = mountEditor(base, true)
      await flushPromises()
      await w.findAll('button').find((b) => b.text() === 'Make this a metric card instead')!.trigger('click')
      await flushPromises()
      const select = w.findAll('select').find((s) => s.findAll('option').some((o) => (o.element as HTMLOptionElement).value === oldCard.preset))!
      await select.setValue(oldCard.preset)
      await flushPromises()
      await w.find('button.btn-primary').trigger('click')
      const saved = w.emitted('save')![0][0] as Widget
      expect(saved.card).toEqual(oldCard)
    })
    it(`${dataset}:${view}: a stored widget still opens as a card`, async () => {
      const w = mountEditor(stored(dataset, view))
      await flushPromises()
      expect(w.text()).toContain('This chart is a metric card.')
      expect(w.find('.ce-root').exists()).toBe(true)
      expect(w.findAll('label').some((l) => l.text() === 'View')).toBe(false)
    })
  }


  it('a stored overview widget taken out of card mode still shows its own Data source; moving it drops the preset card', async () => {
    const w = mountEditor(stored('overview', 'kpis'))
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Switch to a regular chart')!.trigger('click')
    await flushPromises()
    expect(dataSourceLabels(w).some((l) => l.startsWith('Best Sudoku overview cards'))).toBe(true)
    const select = w.findAll('select').find((s) => s.findAll('option').some((o) => o.text().startsWith('RUM')))!
    await select.setValue('geo')
    await flushPromises()
    expect(dataSourceLabels(w).some((l) => l.startsWith('Best Sudoku overview cards'))).toBe(false)
    await w.find('button.btn-primary').trigger('click')
    const saved = w.emitted('save')![0][0] as Widget
    expect(saved.dataset).toBe('geo')
    expect(saved.card).toBeUndefined()
    expect(saved.view).toBeUndefined()
  })
})

describe('the default rate table and the editor-built popup-rates card', () => {
  // The pop-up rate table (type 'rateTable') is a preset card since layout version 11. The `rate`
  // tile (ADR 0005 slice 4, rateTileCard.ts) is a different widget; it is not in "Add chart" any
  // more (ChartEditor.typeChoices.test.ts) and is covered by defaults.rateTile.test.ts.
  const defaultRates = () => defaultBestSudokuPopupsWidgets().find((x) => x.type === 'rateTable')!
  it('the default rateTable carries the popup-rates card, and Metric card -> popup-rates saves that same card', async () => {
    expect(defaultRates().card).toEqual({ preset: 'popup-rates' })
    const w = mountEditor(base, true)
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Make this a metric card instead')!.trigger('click')
    await flushPromises()
    const select = w.findAll('select').find((s) => s.findAll('option').some((o) => (o.element as HTMLOptionElement).value === 'popup-rates'))!
    await select.setValue('popup-rates')
    await flushPromises()
    await w.find('button.btn-primary').trigger('click')
    expect((w.emitted('save')![0][0] as Widget).card).toEqual(defaultRates().card)
  })
  it('both render the same card body', async () => {
    const built: Widget = { ...base, id: 'built', i: 'built', title: defaultRates().title, card: { preset: 'popup-rates' } }
    const a = mount(ChartCard, { props: { widget: defaultRates(), filters: page, dark: false, drillOpen: false } })
    const b = mount(ChartCard, { props: { widget: built, filters: page, dark: false, drillOpen: false } })
    mounted.push(a, b)
    for (let i = 0; i < 4; i++) {
      await flushPromises()
      await new Promise((r) => setTimeout(r, 15))
    }
    expect(a.find('.metric-card-root').exists()).toBe(true)
    expect(b.find('.metric-card-root').html()).toBe(a.find('.metric-card-root').html())
  })
})

const buttonNamed = (w: VueWrapper, name: string) => w.findAll('button').find((b) => b.text() === name)!
const save = async (w: VueWrapper) => {
  await w.find('button.btn-primary').trigger('click')
  return w.emitted('save')![0][0] as Widget
}

describe('the Filters row', () => {
  it("a chart with no override reads \"Uses the page's filters\", with Edit and no Clear", async () => {
    const w = mountEditor(base, true, page)
    await flushPromises()
    expect(filtersRow(w).text()).toContain('Filters')
    expect(filtersRow(w).text()).toContain("Uses the page's filters")
    expect(rowButtons(w)).toEqual(['Edit'])
  })
  it('Edit opens the popover and a change saves widget.filters', async () => {
    const w = mountEditor(base, true, page)
    await flushPromises()
    expect(w.find('.fp').exists()).toBe(false)
    await buttonNamed(w, 'Edit').trigger('click')
    expect(w.find('.fp').exists()).toBe(true)
    // A quick-range chip applies at once (FilterPopover's own commit).
    await w.findAll('.fp .chip').find((c) => c.text() === '7d')!.trigger('click')
    await flushPromises()
    expect(filtersRow(w).text()).toContain('Overrides the page:')
    expect(rowButtons(w)).toContain('Clear')
    const saved = await save(w)
    expect(saved.filters).toBeTruthy()
    expect(saved.filters!.rangeRel).toBe('7d')
    expect(saved.filters!.siteSel).toEqual(page.siteSel)
  })
  it('an override reads "Overrides the page: <summary>", and Clear saves null', async () => {
    const w = mountEditor({ ...base, filters: override }, false, page)
    await flushPromises()
    expect(filtersRow(w).text()).toContain('Overrides the page: all sites')
    expect(filtersRow(w).text()).toContain('−me')
    expect(rowButtons(w)).toEqual(['Edit', 'Clear'])
    await buttonNamed(w, 'Clear').trigger('click')
    expect(filtersRow(w).text()).toContain("Uses the page's filters")
    expect((await save(w)).filters).toBeNull()
  })
  it('the popover "Use global filter" clears the override too', async () => {
    const w = mountEditor({ ...base, filters: override }, false, page)
    await flushPromises()
    await buttonNamed(w, 'Edit').trigger('click')
    await w.find('.fp .btn-link').trigger('click')
    expect(w.find('.fp').exists()).toBe(false)
    expect((await save(w)).filters).toBeNull()
  })
  it('Cancel leaves the stored override alone', async () => {
    const original: Widget = { ...base, filters: override }
    const w = mountEditor(original, false, page)
    await flushPromises()
    await buttonNamed(w, 'Clear').trigger('click')
    await buttonNamed(w, 'Cancel').trigger('click')
    expect(w.emitted('save')).toBeUndefined()
    expect(original.filters).toEqual(override)
  })
  it('a metric card shows the summary and Clear only: no Edit', async () => {
    const card = stored('overview', 'kpis')
    const none = mountEditor(card, false, page)
    await flushPromises()
    expect(filtersRow(none).text()).toContain("Uses the page's filters")
    expect(rowButtons(none)).toEqual([])
    const withOverride = mountEditor({ ...card, filters: override }, false, page)
    await flushPromises()
    expect(filtersRow(withOverride).text()).toContain('Overrides the page:')
    expect(rowButtons(withOverride)).toEqual(['Clear'])
    await filtersRow(withOverride).find('button').trigger('click')
    expect((await save(withOverride)).filters).toBeNull()
  })
  it('a widget that draws its own body (a pop-up rate tile) shows the summary and Clear only', async () => {
    const rate: Widget = { id: 'r', i: 'r', title: 'Rate', type: 'rate', dataset: 'popup', dimension: 'install:outcome:installed', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3, filters: override }
    const w = mountEditor(rate, false, page)
    await flushPromises()
    expect(rowButtons(w)).toEqual(['Clear'])
  })
  it('a note widget has no Filters row', async () => {
    const note: Widget = { id: 'n', i: 'n', title: 'Note', type: 'note', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 4, h: 3, note: 'hello' }
    const w = mountEditor(note, false, page)
    await flushPromises()
    expect(filtersRow(w).exists()).toBe(false)
    expect(w.text()).not.toContain("Uses the page's filters")
  })
})
