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

  it('stays offered after a saved rate tile is switched to another type, and switching back works', async () => {
    const w = mount(ChartEditor, { props: { widget: base({ type: 'rate', dimension: 'upsell:tap' }), isNew: false }, global: { stubs: { CardEditor: true } } })
    mounted.push(w)
    const select = () => w.findAll('select').find((s) => s.findAll('option').some((o) => o.attributes('value') === 'stat'))!
    await select().setValue('stat')
    expect(select().findAll('option').map((o) => o.attributes('value'))).toContain('rate')
    await select().setValue('rate')
    expect((select().element as HTMLSelectElement).value).toBe('rate')
  })
})

describe('ChartEditor: the pop-up rate signpost', () => {
  const COPY = 'For a pop-up rate, make this a metric card, then pick the "Pop-up rates" preset.'
  const signpost = (widget: Widget, isNew: boolean) => {
    const w = mount(ChartEditor, { props: { widget, isNew }, global: { stubs: { CardEditor: true } } })
    mounted.push(w)
    return w
  }

  it('a new chart is told where a pop-up rate went, next to the metric-card button', () => {
    const w = signpost(base(), true)
    const hint = w.find('[data-testid="rate-signpost"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toBe(COPY)
    expect(w.findAll('button').some((b) => b.text() === 'Make this a metric card instead')).toBe(true)
  })

  it('the preset it names exists, so the hint points at a real path', async () => {
    const { presetOptions } = await import('../lib/metrics/editorModel')
    expect(presetOptions().find((o) => o.value === 'popup-rates')?.label).toMatch(/^Pop-up rates/)
  })

  it('a saved rate tile (which still offers Rate) does not get it', () => {
    expect(signpost(base({ type: 'rate', dimension: 'upsell:tap' }), false).find('[data-testid="rate-signpost"]').exists()).toBe(false)
  })

  it('is gone once the chart is a metric card', async () => {
    const w = signpost(base(), true)
    await w.findAll('button').find((b) => b.text() === 'Make this a metric card instead')!.trigger('click')
    expect(w.find('[data-testid="rate-signpost"]').exists()).toBe(false)
  })
})
