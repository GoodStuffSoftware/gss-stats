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

describe('ChartEditor: product changes, the before/after readout and a ratio series', () => {
  it('the product-changes checkbox sets and clears changeMarkers', async () => {
    const w = open(card())
    await w.get('[data-testid="change-markers"]').setValue(true)
    expect((await saved(w))!.changeMarkers).toBe(true)
    await w.get('[data-testid="change-markers"]').setValue(false)
    expect((await saved(w))!.changeMarkers).toBeUndefined()
  })

  it('the readout select lists the product changes and labelled releases, newest first, and saves the id (None clears it)', async () => {
    const w = open(card())
    const opts = w.findAll('[data-testid="compare-at"] option').map((o) => o.text())
    expect(opts[0]).toBe('None')
    expect(opts).toContain('2026-11-09 · First-50 days end')
    expect(opts).toContain('2026-11-04 · v1.107.0 sign-in copy')
    expect(opts.indexOf('2026-11-11 · v1.108.0 no-ads')).toBeLessThan(opts.indexOf('2026-11-04 · v1.107.0 sign-in copy'))
    await w.get('[data-testid="compare-at"]').setValue('first-50-ended')
    expect((await saved(w))!.compareAt).toBe('first-50-ended')
    await w.get('[data-testid="compare-at"]').setValue('')
    expect((await saved(w))!.compareAt).toBeUndefined()
  })

  it('a saved marker id this build does not know is shown, not silently dropped', () => {
    const w = open({ ...card(), compareAt: 'gone-marker' })
    expect(w.get('[data-testid="compare-at"]').text()).toContain('Unknown marker: gone-marker')
  })

  it('adds a ratio series on the right axis (second series over the first), picks its parts, and saves it', async () => {
    const w = open(card())
    await w.get('[data-testid="add-ratio-series"]').trigger('click')
    let out = await saved(w)
    expect(out!.series).toHaveLength(3)
    expect(out!.series![2]).toMatchObject({ label: 'Rate', axis: 'right', ratio: { num: 1, den: 0 } })
    await w.get('[data-testid="ratio-num"]').setValue('0')
    await w.get('[data-testid="ratio-den"]').setValue('1')
    out = await saved(w)
    expect(out!.series![2].ratio).toEqual({ num: 0, den: 1 })
  })

  it('removing a series removes the ratio built on it and shifts the others', async () => {
    const w = open(card())
    await w.get('[data-testid="add-ratio-series"]').trigger('click')
    // delete the first counted series: the ratio depended on it, so it goes too
    await w.findAll('.series-row')[0].get('button[title="Remove series"]').trigger('click')
    const out = await saved(w)
    expect(out!.series).toHaveLength(1)
    expect(out!.series![0].ratio).toBeUndefined()
  })

  it('removing a series before the parts shifts a surviving ratio down by one', async () => {
    const base = card()
    const three = { ...base, series: [{ label: 'Extra', axis: 'left', style: 'solid' }, ...base.series!, { label: 'Rate', axis: 'right', style: 'dashed', ratio: { num: 2, den: 1 } }] } as Widget
    const w = open(three)
    await w.findAll('.series-row')[0].get('button[title="Remove series"]').trigger('click')
    const out = await saved(w)
    expect(out!.series!.map((s) => s.label)).toEqual([base.series![0].label, base.series![1].label, 'Rate'])
    expect(out!.series![2].ratio).toEqual({ num: 1, den: 0 })
  })

  it('a chart that is not a series date line does not save the readout or product-change options', async () => {
    const w = open({ ...card(), changeMarkers: true, compareAt: 'first-50-ended', type: 'bar', dimension: 'country' })
    const out = await saved(w)
    expect(out!.changeMarkers).toBeUndefined()
    expect(out!.compareAt).toBeUndefined()
  })
})

describe('ChartEditor: a ratio keeps its two parts different', () => {
  it('choosing the bottom line as the top line swaps them instead of making a ratio of a line over itself', async () => {
    const w = open(card())
    await w.get('[data-testid="add-ratio-series"]').trigger('click')
    await w.get('[data-testid="ratio-num"]').setValue('0') // was 1 over 0: the top is now the bottom's line
    const out = await saved(w)
    expect(out!.series![2].ratio).toEqual({ num: 0, den: 1 })
    await w.get('[data-testid="ratio-den"]').setValue('0')
    expect((await saved(w))!.series![2].ratio).toEqual({ num: 1, den: 0 })
  })
})
