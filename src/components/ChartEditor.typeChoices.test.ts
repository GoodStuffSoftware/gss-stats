// @vitest-environment happy-dom
//
// ADR 0005 slice 5: the editor stops offering "Rate" for a new chart (a new rate is a metric card),
// but a saved rate tile still opens with its own type shown, so it can be edited.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import type { Widget } from '../types'

const mounted: VueWrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})
const base = (over: Partial<Widget> = {}): Widget =>
  ({ id: 'w1', i: 'w1', title: 'Panel', type: 'table', dataset: 'popup', dimension: 'kind', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 6, ...over }) as Widget
function typeValues(widget: Widget, isNew: boolean) {
  const w = mount(ChartEditor, { props: { widget, isNew }, global: { stubs: { CardEditor: true } } })
  mounted.push(w)
  const select = w.findAll('select').find((s) => s.findAll('option').some((o) => o.attributes('value') === 'stat'))!
  return select.findAll('option').map((o) => o.attributes('value'))
}

describe('ChartEditor: the Rate type choice', () => {
  it('is not offered for a new chart, nor for an existing chart of another type', () => {
    expect(typeValues(base(), true)).not.toContain('rate')
    expect(typeValues(base({ type: 'stat' }), false)).not.toContain('rate')
    expect(typeValues(base(), true)).toContain('stat') // the rest of the list is intact
    expect(typeValues(base(), true)).toContain('table')
  })

  it('is kept for a saved rate tile, so it still opens as what it is', () => {
    expect(typeValues(base({ type: 'rate', dimension: 'upsell:tap' }), false)).toContain('rate')
  })
})
