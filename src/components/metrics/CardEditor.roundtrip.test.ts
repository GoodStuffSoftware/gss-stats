// @vitest-environment happy-dom
//
// "Customize must not drop template settings": for every preset, Customize → a no-op pass over
// every control the editor renders (re-select each select's current value, switch every checkbox
// off and back on, re-click each active tab and selected metric/ratio, switch every repeat to
// another kind and to none and back) → the emitted spec is still exactly the preset.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import CardEditor from './CardEditor.vue'
import ChartEditor from '../ChartEditor.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { normalizeConfig } from '../../lib/defaults'
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
      const widget: Widget = { id: 'w1', i: 'w1', title: 'Card', type: 'table', dimension: '', metric: 'pageviews', limit: 50, card: { preset: id }, x: 0, y: 0, w: 4, h: 8 }
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
      const reloaded = normalizeConfig({ version: 99, activePageId: 'p', pages: [{ id: 'p', name: 'p', filters: {}, widgets: [saved] }] } as never)
      expect(reloaded.pages[0].widgets[0].card).toStrictEqual({ spec: plain(preset), from: id })
    }, 30_000)
  }
})

