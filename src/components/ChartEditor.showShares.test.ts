// @vitest-environment happy-dom
//
// ChartEditor x "show shares" (Widget.showShares): the checkbox is offered for a doughnut and a pie only,
// says what the chart does (its own choice, else its dimension's default), and saves an explicit true or
// false; a chart switched to another type cannot keep a stale value. The hero donut loads checked.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import { f3HeroDonutWidget } from '../lib/defaults'
import type { Widget } from '../types'

const mounted: VueWrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})
const base = (over: Partial<Widget> = {}): Widget => ({ id: 'w1', i: 'w1', title: 'Devices', type: 'doughnut', dataset: 'geo', dimension: 'device', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 8, ...over }) as Widget
function open(widget: Widget) {
  const w = mount(ChartEditor, { props: { widget, isNew: false } })
  mounted.push(w)
  return w
}
const box = (w: VueWrapper) => w.findAll('.field.check').find((f) => f.text().includes("share in the legend"))
const saved = (w: VueWrapper) => w.emitted('save')![0][0] as Widget

describe('ChartEditor: show each slice\'s share', () => {
  it('is offered for a doughnut, unticked by default, and saving untouched stores no key', async () => {
    const w = open(base())
    expect(box(w)).toBeTruthy()
    expect((box(w)!.find('input').element as HTMLInputElement).checked).toBe(false)
    await w.find('button.btn-primary').trigger('click')
    expect('showShares' in saved(w) && saved(w).showShares !== undefined).toBe(false)
  })

  it('is offered for a pie too, and ticking it saves showShares: true', async () => {
    const w = open(base({ type: 'pie' }))
    await box(w)!.find('input').setValue(true)
    await w.find('button.btn-primary').trigger('click')
    expect(saved(w).showShares).toBe(true)
  })

  it('shows the current value, and unticking saves an explicit false', async () => {
    const w = open(base({ showShares: true }))
    const input = box(w)!.find('input')
    expect((input.element as HTMLInputElement).checked).toBe(true)
    await input.setValue(false)
    await w.find('button.btn-primary').trigger('click')
    expect(saved(w).showShares).toBe(false)
  })

  it('the hero donut (which stores no choice) opens ticked, because its dimension shows shares by default', async () => {
    const stored = f3HeroDonutWidget({ x: 0, y: 0, w: 6, h: 10 })
    expect(stored.showShares).toBeUndefined()
    const w = open(stored)
    expect((box(w)!.find('input').element as HTMLInputElement).checked).toBe(true)
    await w.find('button.btn-primary').trigger('click')
    expect(saved(w).showShares).toBeUndefined() // saved untouched: still no key, still the same look
  })

  it('is not offered for a bar, and switching a doughnut to one drops a stored value from the save', async () => {
    expect(box(open(base({ type: 'bar' })))).toBeUndefined()
    const w = open(base({ showShares: true }))
    const type = w.findAll('select').find((s) => s.findAll('option').some((o) => (o.element as HTMLOptionElement).value === 'hbar'))!
    await type.setValue('hbar')
    expect(box(w)).toBeUndefined()
    await w.find('button.btn-primary').trigger('click')
    expect(saved(w).showShares).toBeUndefined()
  })
})
