// @vitest-environment happy-dom
//
// Phase 3 (editor entry points): "Add chart" no longer offers the overview and campaigns datasets
// (those cards are Metric card -> preset), there is no View picker, and every widget but a note
// gets a Filters row that edits widget.filters through the same FilterPopover ChartCard uses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import ChartCard from './ChartCard.vue'
import { __resetMetricsStateForTests } from '../composables/useMetrics'
import { defaultBestSudokuPopupsWidgets, defaultRetentionWidgets, syncCardWithView } from '../lib/defaults'
import { autoCaveatIds } from '../lib/notes'
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

  // Each view the old picker offered, with the preset it must give: written out so that breaking one
  // mapping in CARD_PRESET_FOR_PANEL fails here (the table is not read back from it).
  const ALL: Array<['overview' | 'campaigns', string, string]> = [
    ['overview', 'kpis', 'bsk-kpis'],
    ['overview', 'scorecard', 'campaign-scorecard'],
    ['overview', 'releasePanel', 'release-before-after'],
    ['campaigns', 'funnel', 'campaign-funnel'],
    ['campaigns', 'country', 'campaign-country'],
    ['campaigns', 'cost', 'campaign-cost'],
    ['campaigns', 'returns', 'campaign-returns'],
  ]
  const pickPreset = async (w: VueWrapper, preset: string) => {
    const select = w.findAll('select').find((s) => s.findAll('option').some((o) => (o.element as HTMLOptionElement).value === preset))!
    await select.setValue(preset)
    await flushPromises()
  }
  const makeCardAndPick = async (w: VueWrapper, preset: string) => {
    await w.findAll('button').find((b) => b.text() === 'Make this a metric card instead')!.trigger('click')
    await flushPromises()
    await pickPreset(w, preset)
  }
  for (const [dataset, view, preset] of ALL) {
    it(`${dataset}:${view}: Metric card -> preset saves the whole widget the old View path saved`, async () => {
      const old = stored(dataset, view)
      expect(old.card).toEqual({ preset })
      const w = mountEditor(base, true)
      await flushPromises()
      await makeCardAndPick(w, preset)
      await w.find('button.btn-primary').trigger('click')
      const saved = w.emitted('save')![0][0] as Widget
      // The whole saved shape, not only the card: dataset and view decide the widget's note scope.
      expect({ dataset: saved.dataset, view: saved.view, card: saved.card, dimension: saved.dimension, metric: saved.metric }).toEqual({
        dataset: old.dataset,
        view: old.view,
        card: old.card,
        dimension: old.dimension,
        metric: old.metric,
      })
      expect(autoCaveatIds(saved)).toEqual(autoCaveatIds(old))
      if (dataset === 'campaigns') expect(autoCaveatIds(saved)).toEqual(['play-tracking-status', 'min-cohort-caveat'])
    })
    it(`${dataset}:${view}: a stored widget still opens as a card`, async () => {
      const w = mountEditor(stored(dataset, view))
      await flushPromises()
      expect(w.text()).toContain('This chart is a metric card.')
      expect(w.find('.ce-root').exists()).toBe(true)
      expect(w.findAll('label').some((l) => l.text() === 'View')).toBe(false)
    })
    it(`${dataset}:${view}: opening and saving a stored widget changes nothing`, async () => {
      const old = stored(dataset, view)
      const w = mountEditor(old)
      await flushPromises()
      await w.find('button.btn-primary').trigger('click')
      expect(w.emitted('save')![0][0]).toEqual({ ...old, i: old.id })
    })
  }

  it('a preset pick off the overview/campaigns panels puts the widget back as it was', async () => {
    const w = mountEditor({ ...base, dataset: 'geo', dimension: 'country' }, true)
    await flushPromises()
    await makeCardAndPick(w, 'campaign-funnel')
    await pickPreset(w, 'popup-rates')
    await w.find('button.btn-primary').trigger('click')
    const saved = w.emitted('save')![0][0] as Widget
    expect(saved.card).toEqual({ preset: 'popup-rates' })
    expect(saved.dataset).toBe('geo')
    expect(saved.view).toBeUndefined()
    expect(saved.dimension).toBe('country')
  })

  const switchToChart = async (w: VueWrapper) => {
    await w.findAll('button').find((b) => b.text() === 'Switch to a regular chart')!.trigger('click')
    await flushPromises()
  }
  const sourceSelect = (w: VueWrapper) => w.findAll('select').find((s) => s.findAll('option').some((o) => o.text().startsWith('RUM')))!
  it('"Switch to a regular chart" on an overview panel falls back to the default source; the author picks another', async () => {
    const w = mountEditor(stored('overview', 'kpis'))
    await flushPromises()
    await switchToChart(w)
    expect(dataSourceLabels(w).some((l) => l.startsWith('Best Sudoku overview cards'))).toBe(false)
    expect((sourceSelect(w).element as HTMLSelectElement).selectedOptions[0].text).toMatch(/^RUM/)
    await sourceSelect(w).setValue('geo')
    await flushPromises()
    const saved = await save(w)
    expect(saved.dataset).toBe('geo')
    expect(saved.card).toBeUndefined()
    expect(saved.view).toBeUndefined()
  })
  // The retention page's cards are campaigns widgets with no view (rt-returns has one): switching one
  // to a regular chart must never save "campaigns, no card, no view" (ChartCard draws the retired-panel text).
  for (const id of ['rt-verdict', 'rt-engagement', 'rt-play', 'rt-returns']) {
    it(`${id}: Switch to a regular chart, then Save, never leaves a campaigns widget with no card and no view`, async () => {
      const rt = defaultRetentionWidgets().find((x) => x.id === id)!
      expect(rt.dataset).toBe('campaigns')
      const w = mountEditor(rt)
      await flushPromises()
      await switchToChart(w)
      const saved = await save(w)
      expect(saved.dataset).toBeUndefined() // RUM, the default source
      expect(saved.card).toBeUndefined()
      expect(saved.view).toBeUndefined()
      expect(saved.dimension).not.toBe('') // a dimension the RUM source has
    })
  }
  it('a widget stored as a non-creatable dataset with no card and no view is repaired on save', async () => {
    const w = mountEditor({ ...base, id: 'stranded', i: 'stranded', dataset: 'campaigns', dimension: '', type: 'table' })
    await flushPromises()
    const saved = await save(w)
    expect(saved.dataset).toBeUndefined()
    expect(saved.card).toBeUndefined()
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
  it('a card on a regular dataset shows the summary and Clear only (the card guard on its own)', async () => {
    const w = mountEditor({ ...base, dataset: 'geo', card: { preset: 'popup-rates' }, filters: override }, false, page)
    await flushPromises()
    expect(rowButtons(w)).toEqual(['Clear'])
  })
  // The chart's own filter button shows for a rate tile with a card (ChartCard), so the editor offers Edit too.
  const rateTile = (dimension: string): Widget => ({ id: 'r', i: 'r', title: 'Rate', type: 'rate', dataset: 'popup', dimension, metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3, filters: override })
  it('a pop-up rate tile has Edit and Clear, and an edit saves', async () => {
    const w = mountEditor(rateTile('upsell:tap'), false, page)
    await flushPromises()
    expect(rowButtons(w)).toEqual(['Edit', 'Clear'])
    await buttonNamed(w, 'Edit').trigger('click')
    await w.findAll('.fp .chip').find((c) => c.text() === '7d')!.trigger('click')
    await flushPromises()
    expect((await save(w)).filters!.rangeRel).toBe('7d')
  })
  it('a rate tile whose rate this build does not know has no Edit (the chart has no filter button either)', async () => {
    const w = mountEditor(rateTile('nope:tap'), false, page)
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

describe('the Filters row: keyboard and focus', () => {
  const escape = (el: { trigger: (e: string, o: object) => Promise<void> }) => el.trigger('keydown', { key: 'Escape' })
  const active = () => document.activeElement as HTMLElement | null
  const panelOf = (w: VueWrapper) => w.find('.panel').element as HTMLElement

  it('Escape in the popover closes only the popover and returns focus to Edit; a second Escape cancels', async () => {
    const w = mountEditor({ ...base, title: 'Edited' }, true, page)
    await flushPromises()
    await buttonNamed(w, 'Edit').trigger('click')
    expect(w.find('.fp').exists()).toBe(true)
    await escape(w.find('.fp'))
    await flushPromises()
    expect(w.find('.fp').exists()).toBe(false)
    expect(w.emitted('cancel')).toBeUndefined()
    expect(w.find('.panel').exists()).toBe(true)
    expect(active()).toBe(buttonNamed(w, 'Edit').element)
    await escape(w.find('.panel'))
    expect(w.emitted('cancel')).toHaveLength(1)
  })
  it('Escape with the popover closed still cancels at once', async () => {
    const w = mountEditor(base, true, page)
    await flushPromises()
    await escape(w.find('.panel'))
    expect(w.emitted('cancel')).toHaveLength(1)
  })
  it('after Clear, focus stays in the panel on Edit', async () => {
    const w = mountEditor({ ...base, filters: override }, false, page)
    await flushPromises()
    ;(buttonNamed(w, 'Clear').element as HTMLElement).focus()
    await buttonNamed(w, 'Clear').trigger('click')
    await nextTick()
    expect(panelOf(w).contains(active())).toBe(true)
    expect(active()).toBe(buttonNamed(w, 'Edit').element)
  })
  it('after Clear on a card (no Edit), focus stays in the panel on the summary line', async () => {
    const w = mountEditor({ ...stored('overview', 'kpis'), filters: override }, false, page)
    await flushPromises()
    ;(buttonNamed(w, 'Clear').element as HTMLElement).focus()
    await buttonNamed(w, 'Clear').trigger('click')
    await nextTick()
    expect(panelOf(w).contains(active())).toBe(true)
    expect(active()).toBe(w.find('.filters-summary').element)
  })
  it('after "Use global filter" in the popover, focus is on Edit', async () => {
    const w = mountEditor({ ...base, filters: override }, false, page)
    await flushPromises()
    await buttonNamed(w, 'Edit').trigger('click')
    ;(w.find('.fp .btn-link').element as HTMLElement).focus()
    await w.find('.fp .btn-link').trigger('click')
    await nextTick()
    expect(panelOf(w).contains(active())).toBe(true)
    expect(active()).toBe(buttonNamed(w, 'Edit').element)
  })
  it('after Done in the popover, focus is on Edit', async () => {
    const w = mountEditor(base, true, page)
    await flushPromises()
    await buttonNamed(w, 'Edit').trigger('click')
    await w.find('.fp .btn-done').trigger('click')
    await nextTick()
    expect(active()).toBe(buttonNamed(w, 'Edit').element)
  })
})
