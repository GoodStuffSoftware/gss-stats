// @vitest-environment happy-dom
//
// The Features page's step charts are ordinary charts since T1 (lib/defaults.ts featureStepWidget): opening one in the
// chart editor and saving it unchanged gives back the same chart, for every one of the 14 (fw-funnel included) and for a
// saved pre-T1 step chart drawn through stepChartFor. Pattern: ChartEditor.resetDefault.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import { defaultFeaturesWidgets, stepChartFor } from '../lib/defaults'
import { featureStepChoices, featureStepKey, FEATURES, stepsViewFor, unknownFeatureStepValues } from '../lib/featureHealth'
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

// Editor tools T7: a Feature step series value is picked from the known steps, never typed. A stored value that names no
// step shows as unknown and Save stays disabled until it is fixed (it would draw a line of zeros).
describe('ChartEditor: the Feature step picker guards against a value that names no step', () => {
  const games = () => JSON.parse(JSON.stringify(STEP_CHARTS.find((w) => w.id === 'fw-games')!)) as Widget
  const saveButton = (w: VueWrapper) => button(w, /^save$/i)!

  it('lists every step of every feature, in FEATURES order, and nothing else', () => {
    const all = FEATURES.flatMap((f) => f.steps.map((s) => featureStepKey(f.id, s.id)))
    expect(featureStepChoices().map((c) => c.value)).toEqual(all)
    expect(featureStepChoices()[0].label).toBe(`${FEATURES[0].label}: ${FEATURES[0].steps[0].label}`)
  })

  it('finds only featureStep values that name no step, each once', () => {
    const series = [
      { filter: [{ field: 'featureStep', value: 'games.start' }] },
      { filter: [{ field: 'featureStep', value: 'games.strat' }] },
      { filter: [{ field: 'featureStep', value: 'games.strat' }] },
      { filter: [{ field: 'country', value: 'nowhere' }] },
      {},
    ]
    expect(unknownFeatureStepValues(series)).toEqual(['games.strat'])
    expect(unknownFeatureStepValues(undefined)).toEqual([])
  })

  it('shows a picker (no free-text box) for every series of a step chart, set to its step, and Save is enabled', () => {
    const w = open(games())
    const pickers = w.findAll('[data-testid="series-feature-step"]')
    expect(pickers).toHaveLength(games().series!.length)
    expect(pickers.map((p) => (p.element as HTMLSelectElement).value)).toEqual(games().series!.map((s) => s.filter![0].value))
    expect(w.find('input[aria-label="Series filter value"]').exists()).toBe(false)
    expect(w.find('[data-testid="series-unknown-step"]').exists()).toBe(false)
    expect(saveButton(w).attributes('disabled')).toBeUndefined()
  })

  it('a stored value naming no step is shown as unknown, blocks Save, and picking a step saves it', async () => {
    const bad = games()
    bad.series![0].filter = [{ field: 'featureStep', value: 'games.strat' }]
    const w = open(bad)
    expect(w.find('[data-testid="series-unknown-step"]').text()).toContain('games.strat')
    expect(w.find('[data-testid="series-feature-step"]').text()).toContain('Unknown step: games.strat')
    expect(saveButton(w).attributes('disabled')).toBeDefined()
    await saveButton(w).trigger('click')
    expect(w.emitted('save')).toBeUndefined()
    await w.find('[data-testid="series-feature-step"]').setValue('games.start')
    expect(w.find('[data-testid="series-unknown-step"]').exists()).toBe(false)
    const out = await saved(w)
    expect(out!.series![0].filter).toEqual([{ field: 'featureStep', value: 'games.start' }])
  })

  it('removing the series with the unknown value also clears the block; other fields keep their free-text box', async () => {
    const bad = games()
    bad.series!.push({ label: 'Typo', filter: [{ field: 'featureStep', value: 'nope' }], axis: 'left', style: 'solid' })
    bad.series!.push({ label: 'Country', filter: [{ field: 'country', value: 'XX' }], axis: 'left', style: 'solid' })
    const w = open(bad)
    expect(w.findAll('input[aria-label="Series filter value"]')).toHaveLength(1)
    expect(saveButton(w).attributes('disabled')).toBeDefined()
    const rows = w.findAll('.series-row')
    await rows[rows.length - 2].find('button[title="Remove series"]').trigger('click')
    expect(saveButton(w).attributes('disabled')).toBeUndefined()
  })
})
