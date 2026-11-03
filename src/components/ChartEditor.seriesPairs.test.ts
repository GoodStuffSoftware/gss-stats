// @vitest-environment happy-dom
//
// A series line is narrowed by up to two field = value pairs, both must hold: the Traffic page's "New devices per day"
// draws visitor = new AND site = bestsudoku-web as one line. Opening such a card and saving it unchanged keeps both
// pairs; the second pair is added, changed and cleared without touching the first.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import { defaultBestSudokuLaunchWidgets } from '../lib/defaults'
import type { Widget } from '../types'

const mounted: VueWrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})
const card = () => JSON.parse(JSON.stringify(defaultBestSudokuLaunchWidgets().find((w) => w.id === 'bsk-new-daily'))) as Widget
function open(widget: Widget) {
  const w = mount(ChartEditor, { props: { widget, isNew: false }, global: { stubs: { CardEditor: true } } })
  mounted.push(w)
  return w
}
async function saved(w: VueWrapper) {
  await w.findAll('button').find((b) => /^save$/i.test(b.text()))!.trigger('click')
  return (w.emitted('save') as Widget[][] | undefined)?.at(-1)?.[0]
}

describe('ChartEditor: a series with two filter pairs', () => {
  it('shows both pairs of each series', () => {
    const w = open(card())
    const fields = w.findAll('select[aria-label="Series filter field"]').map((s) => (s.element as unknown as HTMLSelectElement).value)
    const second = w.findAll('select[aria-label="Series second filter field"]').map((s) => (s.element as unknown as HTMLSelectElement).value)
    const secondValues = w.findAll('input[aria-label="Series second filter value"]').map((s) => (s.element as unknown as HTMLInputElement).value)
    expect(fields).toEqual(['visitor', 'visitor'])
    expect(second).toEqual(['site', 'site'])
    expect(secondValues).toEqual(['bestsudoku-web', 'bestsudoku-app'])
  })

  it('opening and saving unchanged keeps both pairs', async () => {
    const input = card()
    const out = await saved(open(card()))
    expect(out!.series!.map((s) => s.filter)).toEqual(input.series!.map((s) => s.filter))
  })

  it('changing the second value keeps the first pair; clearing the second field drops only the second pair', async () => {
    const w = open(card())
    await w.findAll('input[aria-label="Series second filter value"]')[0].setValue('bestsudoku')
    let out = await saved(w)
    expect(out!.series![0].filter).toEqual([{ field: 'visitor', value: 'new' }, { field: 'site', value: 'bestsudoku' }])
    await w.findAll('select[aria-label="Series second filter field"]')[0].setValue('')
    out = await saved(w)
    expect(out!.series![0].filter).toEqual([{ field: 'visitor', value: 'new' }])
    expect(out!.series![1].filter).toHaveLength(2)
  })

  it('clearing the first pair clears the series filter', async () => {
    const w = open(card())
    await w.findAll('select[aria-label="Series filter field"]')[0].setValue('')
    const out = await saved(w)
    expect(out!.series![0].filter).toBeUndefined()
  })
})
