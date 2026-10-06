// @vitest-environment happy-dom
//
// Switching a breakdown card's type must not silently drop its breakdown. Regression: "Completions
// by mode x difficulty" saved as a pie lost `breakdown` (the pie type did not allow one), so the
// next fetch returned mode-only rows and the pie drew a single "Normal" slice.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import type { Widget } from '../types'

const mounted: VueWrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})
const base = (over: Partial<Widget> = {}): Widget =>
  ({ id: 'w1', i: 'w1', title: 'Completions by mode x difficulty', type: 'stackedBar', dataset: 'completions', dimension: 'mode', breakdown: 'difficulty', metric: 'pageviews', limit: 20, x: 0, y: 0, w: 12, h: 10, ...over }) as Widget

function open(widget: Widget) {
  const w = mount(ChartEditor, { props: { widget, isNew: false }, global: { stubs: { CardEditor: true } } })
  mounted.push(w)
  return w
}
const typeSelect = (w: VueWrapper) => w.findAll('select').find((s) => s.findAll('option').some((o) => o.attributes('value') === 'stat'))!

describe('ChartEditor: a breakdown survives a type switch', () => {
  it.each(['pie', 'doughnut', 'bar', 'hbar', 'area', 'line', 'table', 'stackedBar'])('%s keeps the breakdown on save', async (type) => {
    const w = open(base())
    await typeSelect(w).setValue(type)
    const save = w.findAll('button').find((b) => /save|apply|done/i.test(b.text()))
    expect(save, 'a save button').toBeTruthy()
    await save!.trigger('click')
    const emitted = w.emitted() as Record<string, unknown[][]>
    const out = Object.values(emitted).flat().map((a) => a[0] as Partial<Widget>).find((x) => x && x.type === type)
    expect(out?.breakdown).toBe('difficulty')
  })

  it('a pie with a breakdown says what each slice is', async () => {
    const w = open(base({ type: 'pie' }))
    const hint = w.find('[data-testid="pair-breakdown-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('Mode')
    expect(hint.text()).toContain('Difficulty')
  })

  it('a stacked bar does not show the pair hint (it stacks, it does not pair)', () => {
    expect(open(base({ type: 'stackedBar' })).find('[data-testid="pair-breakdown-hint"]').exists()).toBe(false)
  })
})

const saved = async (w: VueWrapper) => {
  const save = w.findAll('button').find((b) => /save|apply|done/i.test(b.text()))!
  await save.trigger('click')
  const emitted = w.emitted() as Record<string, unknown[][]>
  return Object.values(emitted).flat().map((a) => a[0] as Partial<Widget>).find((x) => x && 'type' in x)
}
const breakdownSelectOffered = (w: VueWrapper) => w.findAll('label').some((l) => /break down by|one line per/i.test(l.text()))

describe('ChartEditor: a breakdown is never dropped without saying so', () => {
  it.each(['bar', 'hbar', 'pie', 'doughnut', 'line', 'area', 'table'])('a %s on a date axis warns before Save removes the breakdown', async (type) => {
    const w = open(base({ type: type as Widget['type'], dataset: 'geo', dimension: 'dateEt', breakdown: 'device' }))
    const hint = w.find('[data-testid="stranded-breakdown-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('Saving removes')
    expect(breakdownSelectOffered(w)).toBe(false)
    expect((await saved(w))?.breakdown).toBeUndefined()
  })

  it('the pop-up dataset does not offer a breakdown (its API ignores one) and warns about a stored one', () => {
    const w = open(base({ type: 'pie', dataset: 'popup', dimension: 'kind', breakdown: 'reason', popup: 'upsell', popupKind: 'shown' }))
    expect(breakdownSelectOffered(w)).toBe(false)
    expect(w.find('[data-testid="stranded-breakdown-hint"]').text()).toContain('data source')
    expect(w.find('[data-testid="pair-breakdown-hint"]').exists()).toBe(false)
  })

  it('a supported combination shows no warning and keeps the breakdown', async () => {
    const w = open(base({ type: 'bar' }))
    expect(w.find('[data-testid="stranded-breakdown-hint"]').exists()).toBe(false)
    expect(breakdownSelectOffered(w)).toBe(true)
    expect((await saved(w))?.breakdown).toBe('difficulty')
  })
})
