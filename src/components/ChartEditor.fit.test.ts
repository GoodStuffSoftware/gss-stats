// @vitest-environment happy-dom
//
// ChartEditor x fit-to-content height (Widget.fit): the "Fit height to content" checkbox sets and
// clears the option on the saved widget, is offered only where a panel can fit (never a chart or
// map canvas), and a widget switched to a chart type cannot keep a stale value.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import type { Widget } from '../types'

const mounted: VueWrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})
const base = (over: Partial<Widget> = {}): Widget => ({ id: 'w1', i: 'w1', title: 'Panel', type: 'table', dimension: 'path', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 6, ...over }) as Widget
function open(widget: Widget) {
  const w = mount(ChartEditor, { props: { widget, isNew: false } })
  mounted.push(w)
  return w
}
const fitBox = (w: VueWrapper) => w.findAll('.field.check').find((f) => f.text().includes('Fit height to content'))
const saved = (w: VueWrapper) => w.emitted('save')![0][0] as Widget

describe('ChartEditor: Fit height to content', () => {
  it('is offered for a table, off by default, and saving untouched stores no fit key', async () => {
    const w = open(base())
    const box = fitBox(w)!
    expect(box).toBeTruthy()
    expect((box.find('input').element as HTMLInputElement).checked).toBe(false)
    await w.find('button.btn-primary').trigger('click')
    expect('fit' in saved(w)).toBe(false)
  })

  it('ticking it saves fit: "content" and keeps the size and position', async () => {
    const w = open(base())
    await fitBox(w)!.find('input').setValue(true)
    await w.find('button.btn-primary').trigger('click')
    const out = saved(w)
    expect(out.fit).toBe('content')
    expect([out.x, out.y, out.w, out.h]).toEqual([0, 0, 6, 6])
  })

  it('shows the current value, and unticking it saves with no fit key at all', async () => {
    const w = open(base({ fit: 'content' }))
    const input = fitBox(w)!.find('input')
    expect((input.element as HTMLInputElement).checked).toBe(true)
    await input.setValue(false)
    await w.find('button.btn-primary').trigger('click')
    expect('fit' in saved(w)).toBe(false)
  })

  it('is not offered for a chart (a canvas has no content height), and a stale value is cleared on save', async () => {
    const w = open(base({ type: 'line', dimension: 'date', fit: 'content' }))
    expect(fitBox(w)).toBeUndefined()
    await w.find('button.btn-primary').trigger('click')
    expect('fit' in saved(w)).toBe(false)
  })

  it('switching a fit table to a chart type drops the option from the editor and from the save', async () => {
    const w = open(base({ fit: 'content' }))
    const type = w.findAll('select').find((s) => s.findAll('option').some((o) => (o.element as HTMLOptionElement).value === 'line'))!
    await type.setValue('line')
    expect(fitBox(w)).toBeUndefined()
    await w.find('button.btn-primary').trigger('click')
    expect('fit' in saved(w)).toBe(false)
  })

  it('is offered for a note', () => {
    expect(fitBox(open(base({ type: 'note' })))).toBeTruthy()
  })
})
