// @vitest-environment happy-dom
//
// "Reset to default" in the chart editor, and the completions card's choices. The prod card had been
// saved as a pie with no breakdown (mode only); Reset puts its factory settings back in the form.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import { defaultConfig, factoryWidget } from '../lib/defaults'
import type { DashboardPage, Widget } from '../types'

const mounted: VueWrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})
const prodCard = (): Widget =>
  ({ id: 'ow-completions', i: 'ow-completions', title: 'Completions by mode × difficulty', type: 'pie', dataset: 'completions', dimension: 'mode', metric: 'pageviews', limit: 20, notes: [], x: 0, y: 44, w: 12, h: 10 }) as unknown as Widget
const overview = (): DashboardPage => defaultConfig().pages.find((p) => p.id === 'bsk-overview')!

function open(widget: Widget, defaultWidget?: Widget, isNew = false) {
  const w = mount(ChartEditor, { props: { widget, isNew, defaultWidget }, global: { stubs: { CardEditor: true } } })
  mounted.push(w)
  return w
}
const button = (w: VueWrapper, re: RegExp) => w.findAll('button').find((b) => re.test(b.text()))
async function saved(w: VueWrapper) {
  await button(w, /^(save|add chart)$/i)!.trigger('click')
  return (w.emitted('save') as Widget[][] | undefined)?.at(-1)?.[0]
}
const selectByLabel = (w: VueWrapper, re: RegExp) => w.findAll('.field').find((f) => f.find('label').exists() && re.test(f.find('label').text()))?.find('select')

describe('factoryWidget', () => {
  it('finds the completions card on the Overview page', () => {
    const d = factoryWidget(overview(), 'ow-completions')
    expect(d).toMatchObject({ type: 'stackedBar', dataset: 'completions', dimension: 'mode', breakdown: 'difficulty' })
  })
  it('is a fresh copy each call', () => {
    const a = factoryWidget(overview(), 'ow-completions')!
    a.breakdown = undefined
    expect(factoryWidget(overview(), 'ow-completions')!.breakdown).toBe('difficulty')
  })
  it('has none for a user-made or drill page, nor for a chart its page does not ship', () => {
    expect(factoryWidget({ ...overview(), id: 'a666a816', parentId: 'bsk-overview' }, 'ow-completions')).toBeUndefined()
    expect(factoryWidget(overview(), 'some-custom-chart')).toBeUndefined()
  })
})

describe('ChartEditor: Reset to default', () => {
  it('is offered only for a saved chart that has a default', () => {
    expect(button(open(prodCard()), /reset to default/i)).toBeUndefined()
    expect(button(open(prodCard(), factoryWidget(overview(), 'ow-completions'), true), /reset to default/i)).toBeUndefined()
    expect(button(open(prodCard(), factoryWidget(overview(), 'ow-completions')), /reset to default/i)).toBeTruthy()
  })

  it('fills the factory settings in, keeps the grid box, and Save stores them', async () => {
    const w = open({ ...prodCard(), caption: 'my note', filters: null } as Widget, factoryWidget(overview(), 'ow-completions'))
    await button(w, /reset to default/i)!.trigger('click')
    expect(w.find('[data-testid="reset-default-hint"]').exists()).toBe(true)
    const out = (await saved(w))!
    expect(out).toMatchObject({ id: 'ow-completions', type: 'stackedBar', dataset: 'completions', dimension: 'mode', breakdown: 'difficulty', limit: 20, x: 0, y: 44, w: 12, h: 10 })
    expect(out.caption).toBeUndefined()
  })

  it('Cancel after a reset leaves the chart as it was', async () => {
    const original = prodCard()
    const w = open(original, factoryWidget(overview(), 'ow-completions'))
    await button(w, /reset to default/i)!.trigger('click')
    await button(w, /^cancel$/i)!.trigger('click')
    expect(w.emitted('save')).toBeUndefined()
    expect(w.emitted('cancel')).toBeTruthy()
    expect(original.type).toBe('pie')
    expect(original.breakdown).toBeUndefined()
  })
})

describe('ChartEditor: the completions card offers only what it can draw', () => {
  it('does not offer the world map (it would switch the source to geo)', () => {
    const types = selectByLabel(open(prodCard()), /chart type/i)!.findAll('option').map((o) => o.attributes('value'))
    expect(types).not.toContain('map')
    expect(types).toContain('pie')
  })

  it('Break down by does not offer the Group by dimension', () => {
    const opts = selectByLabel(open(prodCard()), /break down by/i)!.findAll('option').map((o) => o.attributes('value'))
    expect(opts).toEqual([undefined, 'difficulty'])
  })

  it('a pie set to break down by difficulty saves the breakdown', async () => {
    const w = open(prodCard())
    await selectByLabel(w, /break down by/i)!.setValue('difficulty')
    expect((await saved(w))?.breakdown).toBe('difficulty')
  })

  it('grouping by the breakdown dimension clears the breakdown', async () => {
    const w = open({ ...prodCard(), breakdown: 'difficulty' } as Widget)
    await selectByLabel(w, /group by/i)!.setValue('difficulty')
    expect((await saved(w))?.breakdown).toBeUndefined()
  })
})
