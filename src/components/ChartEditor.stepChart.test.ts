// @vitest-environment happy-dom
//
// The Features page's step charts are ordinary charts since T1 (lib/defaults.ts featureStepWidget): opening one in the
// chart editor and saving it unchanged gives back the same chart, for every one of the 14 (fw-funnel included) and for a
// saved pre-T1 step chart drawn through stepChartFor. Pattern: ChartEditor.resetDefault.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import { defaultFeaturesWidgets, stepChartFor } from '../lib/defaults'
import { stepsViewFor } from '../lib/featureHealth'
import type { Widget } from '../types'

const mounted: VueWrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})
function open(widget: Widget) {
  const w = mount(ChartEditor, { props: { widget, isNew: false }, global: { stubs: { CardEditor: true } } })
  mounted.push(w)
  return w
}
const button = (w: VueWrapper, re: RegExp) => w.findAll('button').find((b) => re.test(b.text()))
async function saved(w: VueWrapper) {
  await button(w, /^(save|add chart)$/i)!.trigger('click')
  return (w.emitted('save') as Widget[][] | undefined)?.at(-1)?.[0]
}
// The emitted widget, without the keys the editor writes as undefined.
const defined = (w: Widget) => JSON.parse(JSON.stringify(w))

const STEP_CHARTS = defaultFeaturesWidgets().filter((w) => w.dataset === 'geo' && w.id.startsWith('fw-'))

describe('ChartEditor: a step chart round-trips unchanged', () => {
  it('there are 14 step-chart presets, fw-funnel included', () => {
    expect(STEP_CHARTS).toHaveLength(14)
    expect(STEP_CHARTS.map((w) => w.id)).toContain('fw-funnel')
  })

  for (const preset of STEP_CHARTS) {
    it(`${preset.id}: open, Save, the same chart`, async () => {
      const input = defined(preset)
      const out = await saved(open(JSON.parse(JSON.stringify(preset))))
      expect(out).toBeTruthy()
      expect(defined(out!)).toEqual(input)
    })
  }

  it('a saved pre-T1 step chart, opened through stepChartFor, saves as the ordinary chart', async () => {
    const legacy = { id: 'fw-games', i: 'fw-games', title: 'Games', type: 'line', dataset: 'features', view: stepsViewFor('games'), dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: 0, y: 32, w: 6, h: 8 } as unknown as Widget
    const shown = stepChartFor(legacy)
    const out = await saved(open(JSON.parse(JSON.stringify(shown))))
    expect(defined(out!)).toEqual(defined(shown))
    expect(out!.dataset).toBe('geo')
    expect(out!.view).toBeUndefined()
  })
})
