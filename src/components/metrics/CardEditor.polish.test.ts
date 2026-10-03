// @vitest-environment happy-dom
//
// Card-editor edge cases from the pre-merge review of fix/card-editor: a stored sparkline can be
// switched back to, the decimals range is one range (0-4) end to end, the dateRange day toggle
// removes its field, `repeat.organic` has a control and its conflict with "flighting today" is
// visible, a remembered repeat never brings back an `empty` turned off elsewhere, badge colour
// rows flag a duplicate or empty text, and "Use a preset instead" asks before discarding edits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import CardEditor from './CardEditor.vue'
import cardEditorSource from './CardEditor.vue?raw'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { validateCard } from '../../lib/metrics/validate'
import { PRESETS } from '../../lib/metrics/presets'
import type { CardRef, CardSpec, Display } from '../../lib/metrics/types'

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
function lastSpec(w: VueWrapper): CardSpec {
  const ev = w.emitted('update:modelValue')
  expect(ev).toBeTruthy()
  return (ev![ev!.length - 1][0] as { spec: CardSpec }).spec
}
const controls = (w: VueWrapper) => w.find('.ce-controls')
async function customize(w: VueWrapper) {
  await w.findAll('button').find((b) => b.text() === 'Customize…')!.trigger('click')
  await flushPromises()
}
async function openItems(w: VueWrapper) {
  for (const b of controls(w).findAll('.ce-item-summary')) if (b.attributes('aria-expanded') !== 'true') await b.trigger('click')
  await flushPromises()
}
const checkbox = (w: VueWrapper, text: string) => controls(w).findAll('label').find((l) => l.text().includes(text) && l.find('input[type=checkbox]').exists())!.find('input[type=checkbox]')
const tab = (w: VueWrapper, text: string) => controls(w).findAll('button.tab').find((b) => b.text().startsWith(text))
const repeatSelect = (w: VueWrapper) => controls(w).findAll('select').find((s) => (s.element as HTMLSelectElement).options[0]?.text.startsWith('None — a single'))!
const errorsText = (w: VueWrapper) => controls(w).findAll('.errors li').map((e) => e.text())

describe('a stored sparkline can be switched back to', () => {
  const SPARK = { as: 'sparkline', series: 'daily' } as const
  function sparkSpec(): CardSpec {
    const spec = plain(PRESETS['bsk-kpis'])
    spec.sections[0].items[0].display = { ...SPARK }
    expect(validateCard(spec)).toEqual([])
    return spec
  }

  it('is enabled, and picking it again after Number restores the stored display', async () => {
    const w = mountEditor({ spec: sparkSpec(), from: 'bsk-kpis' })
    await flushPromises()
    await controls(w).find('.ce-item-summary').trigger('click')
    await flushPromises()
    const spark = () => tab(w, 'Sparkline')!
    expect(spark().attributes('disabled')).toBeUndefined()
    expect(spark().attributes('aria-checked')).toBe('true')
    await tab(w, 'Number')!.trigger('click')
    await flushPromises()
    expect(lastSpec(w).sections[0].items[0].display).toStrictEqual({ as: 'number' })
    expect(spark().attributes('disabled')).toBeUndefined()
    await spark().trigger('click')
    await flushPromises()
    expect(lastSpec(w).sections[0].items[0].display).toStrictEqual(SPARK)
    expect(validateCard(lastSpec(w))).toEqual([])
  })

  it('stays disabled ("coming soon") on an item that never had one', async () => {
    const w = mountEditor({ spec: plain(PRESETS['bsk-kpis']), from: 'bsk-kpis' })
    await flushPromises()
    await controls(w).find('.ce-item-summary').trigger('click')
    await flushPromises()
    expect(tab(w, 'Sparkline')!.attributes('disabled')).toBeDefined()
  })

  it('survives the item being collapsed and reopened after switching away', async () => {
    const w = mountEditor({ spec: sparkSpec(), from: 'bsk-kpis' })
    await flushPromises()
    const summary = () => controls(w).find('.ce-item-summary')
    await summary().trigger('click')
    await flushPromises()
    await tab(w, 'Number')!.trigger('click')
    await summary().trigger('click') // collapse
    await summary().trigger('click') // reopen
    await flushPromises()
    expect(tab(w, 'Sparkline')!.attributes('disabled')).toBeUndefined()
    await tab(w, 'Sparkline')!.trigger('click')
    await flushPromises()
    expect(lastSpec(w).sections[0].items[0].display).toStrictEqual(SPARK)
  })
})

describe('percent decimals: one range, 0 to 4', () => {
  function withDecimals(n: number): CardSpec {
    const spec = plain(PRESETS['campaign-funnel'])
    const item = spec.sections.flatMap((s) => s.items).find((i) => i.display.as === 'percent')!
    ;(item.display as { decimals?: number }).decimals = n
    return spec
  }
  const decimalsSelect = (w: VueWrapper) => controls(w).findAll('select').find((s) => [...(s.element as HTMLSelectElement).options].map((o) => o.text).join() === '0,1,2,3,4')

  it('the select offers 0 to 4 and shows a stored 3', async () => {
    const spec = withDecimals(3)
    expect(validateCard(spec)).toEqual([])
    const w = mountEditor({ spec, from: 'campaign-funnel' })
    await flushPromises()
    await openItems(w)
    const s = decimalsSelect(w)!
    expect(s).toBeTruthy()
    expect((s.element as HTMLSelectElement).value).toBe('3')
    await s.setValue('4')
    await flushPromises()
    expect(validateCard(lastSpec(w))).toEqual([])
    const pct = lastSpec(w).sections.flatMap((x) => x.items).find((i) => i.display.as === 'percent')!.display as Display & { decimals?: number }
    expect(pct.decimals).toBe(4)
  })

  it('every decimals value the presets use is inside the offered range and validates', () => {
    for (const [id, spec] of Object.entries(PRESETS)) {
      expect(validateCard(spec), id).toEqual([])
      for (const it of spec.sections.flatMap((s) => s.items)) {
        const d = it.display
        if (d.as === 'percent' && d.decimals !== undefined) expect([0, 1, 2, 3, 4], id).toContain(d.decimals)
      }
    }
  })
})

describe('the dateRange day-count toggle removes its field when off', () => {
  it('on -> off leaves { as: "dateRange" } with no days key, and back on stores days: true', async () => {
    const w = mountEditor({ preset: 'campaign-scorecard' })
    await flushPromises()
    await customize(w)
    await openItems(w)
    const box = () => checkbox(w, 'Show day count')
    expect((box().element as HTMLInputElement).checked).toBe(true)
    await box().setValue(false)
    await flushPromises()
    const flight = () => lastSpec(w).sections.flatMap((s) => s.items).find((i) => i.id === 'flight')!
    expect(flight().display).toStrictEqual({ as: 'dateRange' })
    expect('days' in flight().display).toBe(false)
    await box().setValue(true)
    await flushPromises()
    expect(flight().display).toStrictEqual({ as: 'dateRange', days: true })
  })
})

describe('repeat.organic has a control, and its conflict with flighting today is visible', () => {
  async function returns() {
    const w = mountEditor({ preset: 'campaign-returns' })
    await flushPromises()
    await customize(w)
    return w
  }
  const organic = (w: VueWrapper) => checkbox(w, 'organic')

  it('shows organic checked for a stored organic repeat and switches it off and on', async () => {
    const w = await returns()
    expect((organic(w).element as HTMLInputElement).checked).toBe(true)
    await organic(w).setValue(false)
    await flushPromises()
    expect(lastSpec(w).repeat).toStrictEqual({ over: 'campaigns', tracked: true, empty: PRESETS['campaign-returns'].repeat!.empty })
    await organic(w).setValue(true)
    await flushPromises()
    expect(lastSpec(w).repeat).toStrictEqual(plain(PRESETS['campaign-returns'].repeat))
  })

  it('is not offered on a popups repeat', async () => {
    const w = await returns()
    await repeatSelect(w).setValue('popups')
    await flushPromises()
    expect(controls(w).findAll('label').some((l) => l.text().includes('organic'))).toBe(false)
  })

  it('organic + flighting today: says why it cannot be saved, and unticking either fixes it', async () => {
    const w = await returns()
    const before = (w.emitted('update:modelValue') ?? []).length
    expect(controls(w).find('.organic-conflict').exists()).toBe(false)
    await checkbox(w, 'Flighting today only').setValue(true)
    await flushPromises()
    const alert = controls(w).find('.organic-conflict')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('organic')
    expect(alert.text()).toContain('Flighting today')
    expect(errorsText(w).join(' ')).toContain('organic cannot combine with flightingToday')
    expect((w.emitted('update:modelValue') ?? []).length).toBe(before) // invalid: nothing emitted
    await organic(w).setValue(false)
    await flushPromises()
    expect(controls(w).find('.organic-conflict').exists()).toBe(false)
    expect(errorsText(w)).toEqual([])
    expect(lastSpec(w).repeat).toMatchObject({ over: 'campaigns', flightingToday: true })
    expect(lastSpec(w).repeat!.organic).toBeUndefined()
  })
})

describe('a remembered repeat takes `empty` from the repeat being left', () => {
  it('empty switched off on another kind does not come back when the first kind is picked again', async () => {
    const w = mountEditor({ preset: 'campaign-returns' })
    await flushPromises()
    await customize(w)
    // A popups repeat on this card is not a valid card (its title binds a campaign), so nothing
    // is emitted until campaigns is picked again: only the end state is observable.
    await repeatSelect(w).setValue('popups')
    await flushPromises()
    expect((checkbox(w, 'When there is nothing to repeat').element as HTMLInputElement).checked).toBe(true) // carried over
    await checkbox(w, 'When there is nothing to repeat').setValue(false)
    await flushPromises()
    await repeatSelect(w).setValue('campaigns')
    await flushPromises()
    expect(lastSpec(w).repeat).toStrictEqual({ over: 'campaigns', tracked: true, organic: true })
  })

  it('still restores the kind\'s own filters, and an empty carried over from the other kind', async () => {
    const w = mountEditor({ preset: 'campaign-returns' })
    await flushPromises()
    await customize(w)
    await repeatSelect(w).setValue('popups')
    await flushPromises()
    await repeatSelect(w).setValue('campaigns')
    await flushPromises()
    expect(lastSpec(w).repeat).toStrictEqual(plain(PRESETS['campaign-returns'].repeat))
  })
})

describe('the two siblings keyed by the spec version have distinct keys', () => {
  it('CardEditor.vue no longer reuses :key="specKey" on both', () => {
    const src = cardEditorSource
    expect(src.match(/:key="specKey"/g) ?? []).toHaveLength(0)
    const keys = [...src.matchAll(/:key="`([a-z]+)-\$\{specKey\}`"/g)].map((m) => m[1])
    expect(keys).toEqual(['meta', 'sections'])
  })
})

describe('badge colour rows flag a duplicate or empty text instead of dropping or storing it', () => {
  async function scorecard() {
    const w = mountEditor({ preset: 'campaign-scorecard' })
    await flushPromises()
    await customize(w)
    await controls(w).findAll('button').find((b) => b.text() === '+ Add a colour')!.trigger('click')
    await flushPromises()
    return w
  }
  const textInputs = (w: VueWrapper) => controls(w).findAll('input[type=text]').filter((i) => i.attributes('id')?.includes('-v'))
  const problems = (w: VueWrapper) => controls(w).findAll('.tone-problem').map((p) => p.text())

  it('a duplicate text is flagged, not stored, and both rows stay', async () => {
    const w = await scorecard()
    expect(lastSpec(w).badge!.display.tones).toStrictEqual({ 'flighting today': 'live', 'new value': 'live' })
    await textInputs(w)[1].setValue('flighting today')
    await textInputs(w)[1].trigger('change')
    await flushPromises()
    expect(problems(w)).toHaveLength(1)
    expect(problems(w)[0]).toContain('already has a colour')
    expect(textInputs(w)).toHaveLength(2)
    expect((textInputs(w)[1].element as HTMLInputElement).value).toBe('flighting today')
    expect(textInputs(w)[1].attributes('aria-invalid')).toBe('true')
    expect(lastSpec(w).badge!.display.tones).toStrictEqual({ 'flighting today': 'live', 'new value': 'live' })
    // A valid text clears it and is stored.
    await textInputs(w)[1].setValue('closed')
    await textInputs(w)[1].trigger('change')
    await flushPromises()
    expect(problems(w)).toEqual([])
    expect(lastSpec(w).badge!.display.tones).toStrictEqual({ 'flighting today': 'live', closed: 'live' })
  })

  it('an empty text is flagged and no "" key is stored', async () => {
    const w = await scorecard()
    await textInputs(w)[1].setValue('  ')
    await textInputs(w)[1].trigger('change')
    await flushPromises()
    expect(problems(w)).toEqual(['Badge text cannot be empty.'])
    expect(Object.keys(lastSpec(w).badge!.display.tones ?? {})).not.toContain('')
    expect(lastSpec(w).badge!.display.tones).toStrictEqual({ 'flighting today': 'live', 'new value': 'live' })
  })

  it('removing the flagged row clears the message', async () => {
    const w = await scorecard()
    await textInputs(w)[1].setValue('')
    await textInputs(w)[1].trigger('change')
    await flushPromises()
    expect(problems(w)).toHaveLength(1)
    await controls(w).findAll('button').filter((b) => b.attributes('title')?.startsWith('Remove the colour'))[1].trigger('click')
    await flushPromises()
    expect(problems(w)).toEqual([])
    expect(lastSpec(w).badge!.display.tones).toStrictEqual({ 'flighting today': 'live' })
  })
})

describe('"Use a preset instead" asks before discarding edits', () => {
  const useBtn = (w: VueWrapper) => w.findAll('button').find((b) => b.text() === 'Use a preset instead')!
  async function custom(edit: boolean) {
    const w = mountEditor({ preset: 'bsk-kpis' })
    await flushPromises()
    await customize(w)
    if (edit) {
      await w.findAll('.field.check input[type=checkbox]')[0].setValue(true) // card title on
      await flushPromises()
    }
    return w
  }

  it('does not ask when nothing differs from the preset', async () => {
    const confirmSpy = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmSpy)
    const w = await custom(false)
    await useBtn(w).trigger('click')
    await flushPromises()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(w.find('.ce-controls select').exists()).toBe(true)
    expect(w.findAll('button').some((b) => b.text() === 'Customize…')).toBe(true)
  })

  it('asks (naming the preset) when edited, and declining keeps the edits', async () => {
    const confirmSpy = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmSpy)
    const w = await custom(true)
    await useBtn(w).trigger('click')
    await flushPromises()
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Today at a glance (KPI tiles)'))
    expect(w.findAll('button').some((b) => b.text() === 'Customize…')).toBe(false)
    expect(lastSpec(w).title).toBe('')
  })

  it('accepting returns to the preset and discards the edits', async () => {
    const confirmSpy = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirmSpy)
    const w = await custom(true)
    await useBtn(w).trigger('click')
    await flushPromises()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(w.findAll('button').some((b) => b.text() === 'Customize…')).toBe(true)
    const ev = w.emitted('update:modelValue')!
    expect(ev[ev.length - 1][0]).toStrictEqual({ preset: 'bsk-kpis' })
  })

  it('asks for a custom card with no known preset', async () => {
    const confirmSpy = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmSpy)
    const w = mountEditor({ spec: plain(PRESETS['bsk-kpis']) })
    await flushPromises()
    await useBtn(w).trigger('click')
    expect(confirmSpy).toHaveBeenCalledTimes(1)
  })
})
