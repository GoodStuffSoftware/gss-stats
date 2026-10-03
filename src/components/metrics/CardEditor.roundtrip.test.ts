// @vitest-environment happy-dom
//
// "Customize must not drop template settings": for every preset, Customize → a no-op pass over
// every control the editor renders (re-select each select's current value, switch every checkbox
// off and back on, re-click each active tab and selected metric/ratio, switch every repeat to
// another kind and to none and back) → the emitted spec is still exactly the preset. Then the
// controls for template fields the form used to hide (badge colours, card actions, label vars,
// repeat.empty, window/country ids, column/row headings, whenZero, the column frame) round-trip,
// and a `{ preset }` card opens showing its settings, read-only, until Customize. Fields the
// editor has no control for (Widget.fit, a sparkline's `series`, repeat.organic) ride through
// every no-op pass, a genuine data edit, and a ChartEditor save + reload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import CardEditor from './CardEditor.vue'
import ChartEditor from '../ChartEditor.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { normalizeConfig } from '../../lib/defaults'
import { validateCard } from '../../lib/metrics/validate'
import { PRESETS } from '../../lib/metrics/presets'
import type { CardRef, CardSpec } from '../../lib/metrics/types'
import type { Widget } from '../../types'

const mounted: VueWrapper[] = []
beforeEach(() => {
  __resetMetricsStateForTests()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { requests: { key: string }[] }
      const results: Record<string, unknown> = {}
      for (const r of body.requests) results[r.key] = { status: 'ok', value: 1 }
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
  vi.stubGlobal('confirm', () => true)
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})

const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
function mountEditor(modelValue: CardRef) {
  const w = mount(CardEditor, { props: { modelValue }, attachTo: document.body })
  mounted.push(w)
  return w
}
function lastEmitted(w: VueWrapper): CardRef {
  const ev = w.emitted('update:modelValue')
  expect(ev).toBeTruthy()
  return ev![ev!.length - 1][0] as CardRef
}
function lastSpec(w: VueWrapper): CardSpec {
  const r = lastEmitted(w)
  expect('spec' in r).toBe(true)
  return (r as { spec: CardSpec }).spec
}
async function customize(w: VueWrapper) {
  await w.findAll('button').find((b) => b.text() === 'Customize…')!.trigger('click')
  await flushPromises()
}
const controls = (w: VueWrapper) => w.find('.ce-controls')
/** Opens every item and every "More" block (repeatedly: opening one can reveal more). */
async function expandAll(w: VueWrapper) {
  for (const b of controls(w).findAll('.ce-item-summary')) if (b.attributes('aria-expanded') !== 'true') await b.trigger('click')
  await flushPromises()
  for (const d of controls(w).findAll('details')) (d.element as HTMLDetailsElement).open = true
  await flushPromises()
}
const selects = (w: VueWrapper) => controls(w).findAll('select')
const byId = (w: VueWrapper, id: string) => controls(w).find(`#${CSS.escape(id)}`)
type Wrapped = { element: unknown }
const sel = (s: Wrapped) => s.element as HTMLSelectElement
const firstOption = (s: Wrapped) => sel(s).options[0]?.text ?? ''
const isRepeatSelect = (s: Wrapped) => firstOption(s).startsWith('None — a single')
const isInsertVar = (s: Wrapped) => firstOption(s).startsWith('+ Insert variable')

/** Every control, used without changing anything. */
async function noOpPass(w: VueWrapper) {
  await expandAll(w)
  // 1. Every select re-picks the value it shows (the "Insert variable" menu is an action, not a value).
  for (const s of selects(w)) {
    if (isInsertVar(s) || sel(s).disabled) continue
    await s.setValue(sel(s).value)
  }
  await flushPromises()
  // 2. Every text/number input "changes" to what it already holds.
  for (const i of controls(w).findAll('input:not([type=checkbox])')) {
    const el = i.element as HTMLInputElement
    await i.setValue(el.value)
    await i.trigger('change')
  }
  await flushPromises()
  // 3. Every checkbox off and back on (or on and back off). Re-queried each time: switching one
  //    off can hide controls below it, and switching it back must bring them back.
  const nBoxes = controls(w).findAll('input[type=checkbox]').length
  for (let k = 0; k < nBoxes; k++) {
    const box = () => controls(w).findAll('input[type=checkbox]')[k]
    const was = (box().element as HTMLInputElement).checked
    await box().setValue(!was)
    await flushPromises()
    await box().setValue(was)
    await flushPromises()
    await expandAll(w)
  }
  // 4. The active tab of every tab group (label kind, data kind, display), and the selected
  //    metric/ratio, clicked again.
  for (const t of controls(w).findAll('.tab.active')) await t.trigger('click')
  for (const o of controls(w).findAll('.option-row.selected')) await o.trigger('click')
  await flushPromises()
  // 5. Every repeat switched to another kind and back, and to none and back.
  const repeatIds = selects(w)
    .filter(isRepeatSelect)
    .map((s) => s.attributes('id')!)
  for (const id of repeatIds) {
    const cur = sel(byId(w, id)).value
    const others = [...sel(byId(w, id)).options].map((o) => o.value).filter((v) => v !== cur)
    for (const other of [others.find((v) => v !== ''), ''].filter((v): v is string => v !== undefined)) {
      await byId(w, id).setValue(other)
      await flushPromises()
      await byId(w, id).setValue(cur)
      await flushPromises()
    }
  }
  await expandAll(w)
}

describe('Customize, then use every control without changing anything: still exactly the preset', () => {
  for (const [id, preset] of Object.entries(PRESETS)) {
    it(id, async () => {
      const w = mountEditor({ preset: id })
      await flushPromises()
      await customize(w)
      expect(lastSpec(w)).toStrictEqual(plain(preset))
      await noOpPass(w)
      const ref = lastEmitted(w) as { spec: CardSpec; from?: string }
      expect(ref.from).toBe(id)
      expect(ref.spec).toStrictEqual(plain(preset))
      expect(controls(w).findAll('.errors li').map((e) => e.text())).toEqual([])
    }, 60_000)
  }
})

describe('through ChartEditor: customize, save and reload keeps every preset', () => {
  for (const [id, preset] of Object.entries(PRESETS)) {
    it(id, async () => {
      const widget: Widget = { id: 'w1', i: 'w1', title: 'Card', type: 'table', dimension: '', metric: 'pageviews', limit: 50, card: { preset: id }, fit: 'content', x: 0, y: 0, w: 4, h: 8 }
      const w = mount(ChartEditor, { props: { widget, isNew: false }, attachTo: document.body })
      mounted.push(w)
      await flushPromises()
      await w.findAll('button').find((b) => b.text() === 'Customize…')!.trigger('click')
      await flushPromises()
      for (const b of w.findAll('.ce-item-summary')) await b.trigger('click')
      await flushPromises()
      await w.find('button.btn-primary').trigger('click')
      const saved = w.emitted('save')!.at(-1)![0] as Widget
      expect(saved.card).toStrictEqual({ spec: plain(preset), from: id })
      expect(saved.fit).toBe('content')
      const reloaded = normalizeConfig({ version: 99, activePageId: 'p', pages: [{ id: 'p', name: 'p', filters: {}, widgets: [saved] }] } as never)
      expect(reloaded.pages[0].widgets[0].card).toStrictEqual({ spec: plain(preset), from: id })
      expect(reloaded.pages[0].widgets[0].fit).toBe('content')
    }, 30_000)
  }
})

describe('a { preset } card opens showing its settings, read-only', () => {
  it('shows the sections and items, disabled, and still emits the preset until Customize', async () => {
    const w = mountEditor({ preset: 'campaign-cost' })
    await flushPromises()
    expect(w.text()).toContain("The preset's settings")
    expect(controls(w).findAll('.ce-section')).toHaveLength(PRESETS['campaign-cost'].sections.length)
    // Card-level controls: present, disabled.
    const cardFields = controls(w).find('fieldset.ce-fieldset')
    expect((cardFields.element as HTMLFieldSetElement).disabled).toBe(true)
    // An item still opens for reading; its controls are disabled; no reorder/remove buttons.
    expect(controls(w).findAll('.ce-item-controls')).toHaveLength(0)
    await controls(w).find('.ce-item-summary').trigger('click')
    await flushPromises()
    expect((controls(w).find('.ce-item-body').element as HTMLFieldSetElement).disabled).toBe(true)
    expect(lastEmitted(w)).toEqual({ preset: 'campaign-cost' })
    // The card's action shows as checked — a template field the form used to hide.
    const action = controls(w).findAll('label').find((l) => l.text().includes('Refresh Google Ads spend'))!
    expect((action.find('input').element as HTMLInputElement).checked).toBe(true)
    // Choosing another preset shows that one's settings.
    await controls(w).find('select').setValue('bsk-kpis')
    await flushPromises()
    expect(controls(w).findAll('.ce-item')).toHaveLength(PRESETS['bsk-kpis'].sections[0].items.length)
    // Customize still converts to { spec, from }.
    await customize(w)
    expect(lastEmitted(w)).toStrictEqual({ spec: plain(PRESETS['bsk-kpis']), from: 'bsk-kpis' })
    expect((controls(w).find('fieldset.ce-fieldset').element as HTMLFieldSetElement).disabled).toBe(false)
  })
})

describe('the controls for fields the form used to hide round-trip', () => {
  async function customized(id: string) {
    const w = mountEditor({ preset: id })
    await flushPromises()
    await customize(w)
    return w
  }
  const checkbox = (w: VueWrapper, text: string) => controls(w).findAll('label').find((l) => l.text().includes(text) && l.find('input[type=checkbox]').exists())!.find('input[type=checkbox]')
  const exactCheckbox = (w: VueWrapper, text: string) => controls(w).findAll('label.campaign-row').find((l) => l.text() === text)!.find('input[type=checkbox]')

  it('badge colours: add, edit, remove', async () => {
    const w = await customized('campaign-scorecard')
    expect(lastSpec(w).badge!.display.tones).toEqual({ 'flighting today': 'live' })
    await controls(w).findAll('button').find((b) => b.text() === '+ Add a colour')!.trigger('click')
    await flushPromises()
    const inputs = controls(w).findAll('input[type=text]').filter((i) => i.attributes('id')?.includes('-v'))
    await inputs[1].setValue('closed')
    await inputs[1].trigger('change')
    const tones = controls(w).findAll('select').filter((s) => s.attributes('id')?.endsWith('-t1'))[0]
    await tones.setValue('warn')
    await flushPromises()
    expect(lastSpec(w).badge!.display.tones).toEqual({ 'flighting today': 'live', closed: 'warn' })
    const removeBtn = () => controls(w).findAll('button').find((b) => b.attributes('title')?.startsWith('Remove the colour'))
    while (removeBtn()) {
      await removeBtn()!.trigger('click')
      await flushPromises()
    }
    expect(lastSpec(w).badge!.display).toEqual({ as: 'badge' })
  })

  it('card actions: the ads refresh control switches off and on', async () => {
    const w = await customized('campaign-cost')
    await checkbox(w, 'Refresh Google Ads spend').setValue(false)
    await flushPromises()
    expect(lastSpec(w).actions).toBeUndefined()
    await checkbox(w, 'Refresh Google Ads spend').setValue(true)
    await flushPromises()
    expect(lastSpec(w).actions).toEqual(['ads-refresh'])
  })

  it('label vars: a note label shows its placeholder, bound to a scope field, and can be unbound and rebound', async () => {
    const w = await customized('bsk-kpis')
    await controls(w).findAll('.ce-item-summary')[1].trigger('click')
    await flushPromises()
    const varSelect = () => controls(w).findAll('select').find((s) => s.attributes('id')?.endsWith('-var-campaign'))!
    expect((varSelect().element as HTMLSelectElement).value).toBe('campaign.label')
    await varSelect().setValue('')
    await flushPromises()
    expect(lastSpec(w).sections[0].items[1].label).toEqual({ note: 'label.card.taggedArrivalsFor' })
    await varSelect().setValue('campaign.label')
    await flushPromises()
    expect(lastSpec(w).sections[0].items[1].label).toEqual({ note: 'label.card.taggedArrivalsFor', vars: { campaign: 'campaign.label' } })
  })

  it('repeat.empty: shown, switched off and back on restores it, and editable', async () => {
    const w = await customized('campaign-returns')
    const box = () => checkbox(w, 'When there is nothing to repeat')
    expect((box().element as HTMLInputElement).checked).toBe(true)
    await box().setValue(false)
    await flushPromises()
    expect(lastSpec(w).repeat).toEqual({ over: 'campaigns', tracked: true, organic: true })
    await box().setValue(true)
    await flushPromises()
    expect(lastSpec(w).repeat).toEqual(plain(PRESETS['campaign-returns'].repeat))
    const heading = controls(w).find('input[placeholder="Heading (optional)"]')
    await heading.setValue('No returns')
    await flushPromises()
    expect(lastSpec(w).repeat!.empty!.label).toBe('No returns')
  })

  it('window and country ids: the repeat lists them and a pick is saved', async () => {
    const w = await customized('release-before-after')
    const before = () => exactCheckbox(w, 'Release: before')
    expect((before().element as HTMLInputElement).checked).toBe(true)
    await before().setValue(false)
    await flushPromises()
    expect(lastSpec(w).sections[1].columns).toEqual({ over: 'windows', ids: ['after'] })
    const c = await customized('campaign-country')
    const us = exactCheckbox(c, 'US')
    await us.setValue(true)
    await flushPromises()
    expect(lastSpec(c).sections[0].columns).toEqual({ over: 'countries', ids: ['US'] })
  })

  it('column heading and row-label heading: shown, off and back on restores, and survive clearing the columns', async () => {
    const w = await customized('campaign-country')
    const rows = () => checkbox(w, 'Heading over the row labels')
    expect((rows().element as HTMLInputElement).checked).toBe(true)
    await rows().setValue(false)
    await flushPromises()
    expect(lastSpec(w).sections[0].rowsLabel).toBeUndefined()
    await rows().setValue(true)
    await flushPromises()
    expect(lastSpec(w).sections[0].rowsLabel).toEqual({ note: 'label.card.step' })
    await checkbox(w, 'Column heading').setValue(true)
    await flushPromises()
    const colText = controls(w).find('input[placeholder="Column heading"]')
    await colText.setValue('Country')
    await flushPromises()
    expect(lastSpec(w).sections[0].columnLabel).toBe('Country')
  })

  it('gating.whenZero: shown checked for the returns d0 row, and switchable', async () => {
    const w = await customized('campaign-returns')
    await controls(w).findAll('.ce-item-summary')[1].trigger('click')
    await flushPromises()
    const box = checkbox(w, 'Leave out a measured 0')
    expect((box.element as HTMLInputElement).checked).toBe(true)
    await box.setValue(false)
    await flushPromises()
    expect(lastSpec(w).sections[0].items[1].gating).toBeUndefined()
  })

  it("frame 'column' is offered", async () => {
    const w = await customized('signin-eligibility')
    await controls(w).find('.ce-item-summary').trigger('click')
    await flushPromises()
    const frame = controls(w).findAll('select').find((s) => s.findAll('option').some((o) => o.text() === 'Column'))!
    await frame.setValue('column')
    await flushPromises()
    expect(lastSpec(w).sections[0].items[0].frame).toBe('column')
    expect(validateCard(lastSpec(w))).toEqual([])
  })

  it('the window select shows "Default" for a binding with no stored window, and never writes one on its own', async () => {
    const w = await customized('campaign-scorecard')
    await controls(w).findAll('.ce-item-summary')[1].trigger('click') // arrivals: no window stored
    await flushPromises()
    const win = controls(w).findAll('select').find((s) => s.find('option').text().startsWith('Default —'))!
    expect((win.element as HTMLSelectElement).value).toBe('')
    await win.setValue('todaySoFar')
    await flushPromises()
    expect(lastSpec(w).sections[0].items[1].data).toEqual({ metric: 'campaign.taggedArrivals', window: 'todaySoFar' })
    await win.setValue('')
    await flushPromises()
    expect(lastSpec(w).sections[0].items[1].data).toEqual({ metric: 'campaign.taggedArrivals' })
  })

  it('picking another metric keeps the window and params it still accepts', async () => {
    const w = await customized('bsk-kpis')
    await controls(w).find('.ce-item-summary').trigger('click')
    await flushPromises()
    await controls(w).find('input[placeholder="Search metrics…"]').setValue('bsk.gameViews')
    await flushPromises()
    const rows = controls(w).findAll('.option-row')
    expect(rows).toHaveLength(1)
    await rows[0].trigger('click')
    await flushPromises()
    const data = lastSpec(w).sections[0].items[0].data as { metric: string; window?: string }
    expect(data.metric).not.toBe('bsk.pageviews')
    expect(data.window).toBe('todaySoFar')
    expect(validateCard(lastSpec(w))).toEqual([])
  })

  it('every new control has an accessible name', async () => {
    const w = await customized('campaign-scorecard')
    await expandAll(w)
    for (const el of controls(w).findAll('input, select')) {
      const e = el.element as HTMLElement
      const id = e.getAttribute('id')
      const named = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || e.closest('label') || e.getAttribute('aria-label')
      expect(named, e.outerHTML.slice(0, 120)).toBeTruthy()
    }
  })
})

describe('fields the editor has no control for survive it: fit, a sparkline series, repeat.organic', () => {
  const SPARK = { as: 'sparkline', series: 'daily' } as const
  /** campaign-returns (repeat.organic: true) with its d0 count drawn as a daily sparkline. */
  function sparkReturns(): CardSpec {
    const spec = plain(PRESETS['campaign-returns'])
    const d0 = spec.sections[0].items.find((i) => i.id === 'd0')!
    d0.display = { ...SPARK }
    expect(spec.repeat!.organic).toBe(true)
    expect(validateCard(spec)).toEqual([])
    return spec
  }
  /** The spec the editor holds: its last emit, or the input when nothing was emitted. */
  function heldSpec(w: VueWrapper, input: CardSpec): CardSpec {
    const ev = w.emitted('update:modelValue')
    return ev?.length ? (ev[ev.length - 1][0] as { spec: CardSpec }).spec : input
  }

  it('a no-op pass over every control keeps the sparkline display and repeat.organic', async () => {
    const spec = sparkReturns()
    const w = mountEditor({ spec: plain(spec), from: 'campaign-returns' })
    await flushPromises()
    await noOpPass(w)
    const out = heldSpec(w, spec)
    expect(out).toStrictEqual(spec)
    expect(out.sections[0].items.find((i) => i.id === 'd0')!.display).toStrictEqual(SPARK)
    expect(out.repeat!.organic).toBe(true)
    expect(controls(w).findAll('.errors li').map((e) => e.text())).toEqual([])
  }, 60_000)

  it('picking another metric of the same kind keeps a sparkline display and its series', async () => {
    const spec = plain(PRESETS['bsk-kpis'])
    spec.sections[0].items[0].display = { ...SPARK }
    expect(validateCard(spec)).toEqual([])
    const w = mountEditor({ spec, from: 'bsk-kpis' })
    await flushPromises()
    await controls(w).find('.ce-item-summary').trigger('click')
    await flushPromises()
    await controls(w).find('input[placeholder="Search metrics…"]').setValue('bsk.gameViews')
    await flushPromises()
    const rows = controls(w).findAll('.option-row')
    expect(rows).toHaveLength(1)
    await rows[0].trigger('click')
    await flushPromises()
    const item = lastSpec(w).sections[0].items[0]
    expect((item.data as { metric: string }).metric).toBe('bsk.gameViews')
    expect(item.display).toStrictEqual(SPARK)
    expect(validateCard(lastSpec(w))).toEqual([])
  })

  it('switching the sparkline to Number and back, and a stored decimals of 3, leave the spec exactly as it was', async () => {
    const spec = sparkReturns()
    spec.sections[0].items.push({ id: 'rate', label: 'Rate', data: { ratio: 'campaign.returnD2to7PerD0' }, display: { as: 'percent', decimals: 3 } })
    expect(validateCard(spec)).toEqual([])
    const w = mountEditor({ spec: plain(spec), from: 'campaign-returns' })
    await flushPromises()
    await expandAll(w)
    const spark = () => controls(w).findAll('button.tab').find((b) => b.text().startsWith('Sparkline'))!
    const number = [...spark().element.parentElement!.querySelectorAll('button.tab')].find((b) => b.textContent!.trim() === 'Number') as HTMLButtonElement
    number.click()
    await flushPromises()
    expect(heldSpec(w, spec).sections[0].items.find((i) => i.id === 'd0')!.display).toStrictEqual({ as: 'number' })
    await spark().trigger('click')
    await flushPromises()
    const out = heldSpec(w, spec)
    expect(out).toStrictEqual(spec)
    expect(out.sections[0].items.find((i) => i.id === 'd0')!.display).toStrictEqual(SPARK)
    expect(out.sections[0].items.find((i) => i.id === 'rate')!.display).toStrictEqual({ as: 'percent', decimals: 3 })
    expect(out.repeat!.organic).toBe(true)
    await noOpPass(w)
    expect(heldSpec(w, spec)).toStrictEqual(spec)
  }, 60_000)

  it('through ChartEditor: save and reload keep fit, the sparkline series and repeat.organic', async () => {
    const spec = sparkReturns()
    const widget: Widget = { id: 'w1', i: 'w1', title: 'Card', type: 'table', dimension: '', metric: 'pageviews', limit: 50, card: { spec: plain(spec), from: 'campaign-returns' }, fit: 'content', x: 0, y: 0, w: 4, h: 8 }
    const w = mount(ChartEditor, { props: { widget, isNew: false }, attachTo: document.body })
    mounted.push(w)
    await flushPromises()
    for (const b of w.findAll('.ce-item-summary')) await b.trigger('click')
    await flushPromises()
    await w.find('button.btn-primary').trigger('click')
    const saved = w.emitted('save')!.at(-1)![0] as Widget
    expect(saved.fit).toBe('content')
    expect(saved.card).toStrictEqual({ spec, from: 'campaign-returns' })
    const reloaded = normalizeConfig({ version: 99, activePageId: 'p', pages: [{ id: 'p', name: 'p', filters: {}, widgets: [saved] }] } as never).pages[0].widgets[0]
    expect(reloaded.fit).toBe('content')
    expect(reloaded.card).toStrictEqual({ spec, from: 'campaign-returns' })
  }, 30_000)
})
