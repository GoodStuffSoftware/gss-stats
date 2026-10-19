// @vitest-environment happy-dom
//
// Card-editor tools built so a card made from scratch can do what a preset does: the sparkline
// "List the days" box (preset campaign-f3-daily) and "Add a caption" (a card-level registry note,
// preset campaign-cost). Both must save, load again, and leave every other field alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import CardEditor from './CardEditor.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { cardCaptionOptions, makeDisplay } from '../../lib/metrics/editorModel'
import { validateCard } from '../../lib/metrics/validate'
import { PRESETS } from '../../lib/metrics/presets'
import type { CardRef, CardSpec } from '../../lib/metrics/types'

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
async function mountEditor(modelValue: CardRef) {
  const w = mount(CardEditor, { props: { modelValue }, attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  return w
}
function lastSpec(w: VueWrapper): CardSpec {
  const ev = w.emitted('update:modelValue')
  expect(ev).toBeTruthy()
  return (ev![ev!.length - 1][0] as { spec: CardSpec }).spec
}
const controls = (w: VueWrapper) => w.find('.ce-controls')
const tab = (w: VueWrapper, text: string) => controls(w).findAll('button.tab').find((b) => b.text().startsWith(text))
const daysBox = (w: VueWrapper) => controls(w).findAll('label').find((l) => l.text().includes('List the days'))?.find('input[type=checkbox]')

/** bsk-kpis with its first item a daily sparkline (a sparkline reads the page range, not today). */
function sparkSpec(days?: true): CardSpec {
  const spec = plain(PRESETS['bsk-kpis'])
  ;(spec.sections[0].items[0].data as { window?: string }).window = 'page'
  spec.sections[0].items[0].display = { as: 'sparkline', series: 'daily', ...(days ? { days } : {}) }
  expect(validateCard(spec)).toEqual([])
  return spec
}
async function openFirstItem(w: VueWrapper) {
  await controls(w).find('.ce-item-summary').trigger('click')
  await flushPromises()
}

describe('sparkline: List the days', () => {
  it('is offered on a sparkline only, saves display.days, and unticking removes the key', async () => {
    const w = await mountEditor({ spec: sparkSpec(), from: 'bsk-kpis' })
    await openFirstItem(w)
    expect(daysBox(w)).toBeTruthy()
    expect((daysBox(w)!.element as HTMLInputElement).checked).toBe(false)

    await daysBox(w)!.setValue(true)
    await flushPromises()
    expect(lastSpec(w).sections[0].items[0].display).toStrictEqual({ as: 'sparkline', series: 'daily', days: true })
    expect(validateCard(lastSpec(w))).toEqual([])

    await daysBox(w)!.setValue(false)
    await flushPromises()
    expect(lastSpec(w).sections[0].items[0].display).toStrictEqual({ as: 'sparkline', series: 'daily' })

    await tab(w, 'Number')!.trigger('click')
    await flushPromises()
    expect(daysBox(w)).toBeUndefined()
  })

  it('loads ticked from a stored spec and the rest of the card is untouched by the tick', async () => {
    const stored = sparkSpec(true)
    const w = await mountEditor({ spec: plain(stored), from: 'bsk-kpis' })
    await openFirstItem(w)
    expect((daysBox(w)!.element as HTMLInputElement).checked).toBe(true)
    await daysBox(w)!.setValue(false)
    await flushPromises()
    await daysBox(w)!.setValue(true)
    await flushPromises()
    expect(lastSpec(w)).toStrictEqual(stored)
  })

  it('a card built from scratch: Number -> Sparkline -> tick gives the same display as the F3 daily preset items', async () => {
    const spec = plain(PRESETS['bsk-kpis'])
    ;(spec.sections[0].items[0].data as { window?: string }).window = 'page'
    const w = await mountEditor({ spec, from: 'bsk-kpis' })
    await openFirstItem(w)
    await tab(w, 'Sparkline')!.trigger('click')
    await flushPromises()
    await daysBox(w)!.setValue(true)
    await flushPromises()
    expect(lastSpec(w).sections[0].items[0].display).toStrictEqual(PRESETS['campaign-f3-daily'].sections[0].items[0].display)
  })

  it('makeDisplay keeps the day list of a sparkline and gives a fresh sparkline none', () => {
    expect(makeDisplay('sparkline', { as: 'sparkline', series: 'daily', days: true })).toStrictEqual({ as: 'sparkline', series: 'daily', days: true })
    expect(makeDisplay('sparkline', { as: 'sparkline', series: 'daily' })).toStrictEqual({ as: 'sparkline', series: 'daily' })
    expect(makeDisplay('sparkline', { as: 'number' })).toStrictEqual({ as: 'sparkline', series: 'daily' })
  })
})

describe('Add a caption', () => {
  const addSelect = (w: VueWrapper) => w.find('.ce-caption-add select')
  const rows = (w: VueWrapper) => w.findAll('.ce-caption-row')

  it('lists registry notes the card does not carry yet, never one it already has or a label entry', () => {
    const spec = plain(PRESETS['release-before-after'])
    expect(spec.captions).toEqual(['release-before-partial'])
    const ids = cardCaptionOptions(spec).map((o) => o.value)
    expect(ids.length).toBeGreaterThan(3)
    expect(ids).not.toContain('release-before-partial')
    expect(ids.some((id) => id.startsWith('label.') || id.startsWith('unit.'))).toBe(false)
    expect(ids).toContain('cost-per-signin-approx')
    expect(cardCaptionOptions({ ...spec, captions: undefined }).map((o) => o.value)).toContain('release-before-partial')
  })

  it('offers a caveat with a card condition only where it holds (country columns note: not on a card with no country split)', () => {
    const noSplit = plain(PRESETS['bsk-kpis'])
    expect(cardCaptionOptions(noSplit).map((o) => o.value)).not.toContain('country-split-excludes-refused')
    const split = plain(PRESETS['campaign-country'])
    expect(cardCaptionOptions({ ...split, captions: [] }).map((o) => o.value)).toContain('country-split-excludes-refused')
  })

  it('a customized card: picking a note adds it to spec.captions (valid, shown as a row), it leaves the picker, and Remove takes it back out', async () => {
    const w = await mountEditor({ spec: plain(PRESETS['release-before-after']), from: 'release-before-after' })
    expect(rows(w)).toHaveLength(1)
    const sel = addSelect(w)
    expect(sel.exists()).toBe(true)
    expect([...(sel.element as HTMLSelectElement).options].some((o) => o.value === 'cost-per-signin-approx')).toBe(true)

    await sel.setValue('cost-per-signin-approx')
    await flushPromises()
    expect(lastSpec(w).captions).toEqual(['release-before-partial', 'cost-per-signin-approx'])
    expect(validateCard(lastSpec(w))).toEqual([])
    expect(rows(w)).toHaveLength(2)
    expect([...(addSelect(w).element as HTMLSelectElement).options].some((o) => o.value === 'cost-per-signin-approx')).toBe(false)
    expect((addSelect(w).element as HTMLSelectElement).value).toBe('')

    // Reload: a fresh editor on the saved spec lists both.
    const w2 = await mountEditor({ spec: plain(lastSpec(w)), from: 'release-before-after' })
    expect(rows(w2)).toHaveLength(2)

    await rows(w).at(1)!.findAll('button').find((b) => b.text() === 'Remove')!.trigger('click')
    await flushPromises()
    expect(lastSpec(w).captions).toEqual(['release-before-partial'])
  })

  it('a card with no captions of its own gains a captions list; removing the last one deletes the key', async () => {
    const w = await mountEditor({ spec: plain(PRESETS['bsk-kpis']), from: 'bsk-kpis' })
    expect('captions' in lastSpec(w)).toBe(false)
    await addSelect(w).setValue('release-before-partial')
    await flushPromises()
    expect(lastSpec(w).captions).toEqual(['release-before-partial'])
    await rows(w)[0].findAll('button').find((b) => b.text() === 'Remove')!.trigger('click')
    await flushPromises()
    expect('captions' in lastSpec(w)).toBe(false)
    expect(validateCard(lastSpec(w))).toEqual([])
  })

  it('a preset card (before Customize) has no picker and no Remove: its captions stay the preset\'s', async () => {
    const w = await mountEditor({ preset: 'release-before-after' })
    expect(addSelect(w).exists()).toBe(false)
    expect(rows(w)[0].findAll('button').some((b) => b.text() === 'Remove')).toBe(false)
  })
})
