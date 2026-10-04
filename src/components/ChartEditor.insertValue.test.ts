// @vitest-environment happy-dom
//
// "Insert value" in the chart editor (notes plan slice 1d, release 2): the picker's Metrics group,
// the note widget's own picker (Dates and Metrics, no "This chart"), the preview from a value the
// page ALREADY holds (nothing is fetched to label an option), and review N3: insertion is an
// explicit choice, never the select's own change event.
import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import { __resetMetricsStateForTests, useMetrics } from '../composables/useMetrics'
import { todayEtFrom } from '../lib/metrics/scope'
import { metricTokenOptions } from '../lib/metricValueTokens'
import type { Widget } from '../types'

const mounted: VueWrapper[] = []
const base = (over: Partial<Widget> = {}): Widget =>
  ({ id: 'w1', i: 'w1', title: 'Panel', type: 'table', dataset: 'popup', dimension: 'kind', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 6, ...over }) as Widget
const noteWidget = (over: Partial<Widget> = {}): Widget => base({ type: 'note', note: 'Hello', ...over })
function open(widget: Widget) {
  const w = mount(ChartEditor, { props: { widget, isNew: false }, global: { stubs: { CardEditor: true } } })
  mounted.push(w)
  return w
}
const captionMenu = (w: VueWrapper) => w.get('.caption-field select.insert-value')
const noteMenu = (w: VueWrapper) => w.get('.note-text select.insert-value')
const pickerOf = (sel: ReturnType<typeof captionMenu>) => sel.element.parentElement as HTMLElement
const insertBtn = (sel: ReturnType<typeof captionMenu>) => pickerOf(sel).querySelector('button.insert-picker-btn') as HTMLButtonElement
const noteBox = (w: VueWrapper) => w.get('.note-text textarea')

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  __resetMetricsStateForTests()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  vi.unstubAllGlobals()
  __resetMetricsStateForTests()
})

describe('Insert value: the Metrics group', () => {
  it('lists catalog metrics as tokens of their own kind, after This chart and Dates', () => {
    const sel = captionMenu(open(base()))
    expect(sel.findAll('optgroup').map((g) => g.attributes('label'))).toEqual(['This chart', 'Dates', 'Metrics'])
    const metrics = sel.findAll('optgroup')[2].findAll('option')
    expect(metrics.length).toBe(metricTokenOptions().length)
    const values = metrics.map((o) => o.attributes('value'))
    expect(values).toContain('{=metric:bsk.pageviews@page|number}')
    expect(values).toContain('{=metric:bsk.popupTapRate@page|pct}')
    expect(values).toContain('{=metric:play.dataThrough@page|date}')
  })

  it('shows what a metric reads now only when the page already holds it, and fetches nothing to label options', async () => {
    const w = open(base())
    const label = () => captionMenu(w).get('option[value="{=metric:bsk.pageviews@page|number}"]').text()
    expect(label()).toBe('Page views (page range)') // nothing loaded: the name alone
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('previews the current value when a card on the page has loaded it', async () => {
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { requests: { key: string }[] }
      const results = Object.fromEntries(body.requests.map((r) => [r.key, { status: 'ok', value: 4321 }]))
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 0, cacheHits: 0, statements: 0 } }) }
    })
    const scope = effectScope()
    scope.run(() => useMetrics({}, () => todayEtFrom(Date.now())).request({ metric: 'bsk.pageviews', window: 'page' }))
    await new Promise((r) => setTimeout(r, 40))
    await flushPromises()
    const calls = fetchMock.mock.calls.length
    const w = open(base())
    await flushPromises()
    expect(captionMenu(w).get('option[value="{=metric:bsk.pageviews@page|number}"]').text()).toMatch(/\(4,321\)$/)
    expect(fetchMock.mock.calls.length).toBe(calls) // opening the editor asked for nothing
    scope.stop()
  })
})

describe('Insert value in a note widget', () => {
  it('offers Dates and Metrics, never This chart, next to Insert from library', () => {
    const w = open(noteWidget())
    expect(noteMenu(w).findAll('optgroup').map((g) => g.attributes('label'))).toEqual(['Dates', 'Metrics'])
    expect(noteMenu(w).findAll('option').some((o) => o.attributes('value')?.startsWith('{=chart.'))).toBe(false)
    expect(w.find('.note-text select.insert-library').exists()).toBe(true)
  })

  it('inserts into the note text and saves it', async () => {
    const w = open(noteWidget({ note: 'Live since' }))
    await noteMenu(w).setValue('{=golive.web|date}')
    await insertBtn(noteMenu(w)).click()
    expect((noteBox(w).element as HTMLTextAreaElement).value).toBe('Live since {=golive.web|date}')
    await w.get('button.btn-primary').trigger('click')
    expect((w.emitted('save')!.at(-1)![0] as Widget).note).toBe('Live since {=golive.web|date}')
  })

  it('inserts a metric token', async () => {
    const w = open(noteWidget({ note: '' }))
    await noteMenu(w).setValue('{=metric:bsk.pageviews@page|number}')
    await insertBtn(noteMenu(w)).click()
    expect((noteBox(w).element as HTMLTextAreaElement).value).toBe('{=metric:bsk.pageviews@page|number}')
  })
})

describe('N3: insertion is an explicit choice', () => {
  it('changing the select (an arrow key on a closed menu) inserts nothing; only Insert does', async () => {
    const w = open(base({ caption: 'Views:' }))
    const sel = captionMenu(w)
    const box = () => (w.get('.caption-field textarea').element as HTMLTextAreaElement).value
    expect(insertBtn(sel).disabled).toBe(true) // nothing picked yet
    for (const v of ['{=chart.total|number}', '{=chart.top}', '{=golive.web|date}']) {
      await sel.setValue(v) // each arrow key fires a change on a closed select
      expect(box()).toBe('Views:')
    }
    expect(insertBtn(sel).disabled).toBe(false)
    expect(insertBtn(sel).getAttribute('aria-label')).toMatch(/^Insert /)
    await insertBtn(sel).click()
    expect(box()).toBe('Views: {=golive.web|date}') // the last pick only, once
    expect((sel.element as unknown as HTMLSelectElement).value).toBe('') // reset: the same entry can be inserted again
    expect(insertBtn(sel).disabled).toBe(true)
  })

  it('the library menu works the same way', async () => {
    const w = open(base())
    const sel = w.get('.caption-field select.insert-library')
    const box = () => (w.get('.caption-field textarea').element as HTMLTextAreaElement).value
    await sel.setValue('small-sample')
    expect(box()).toBe('')
    await (sel.element.parentElement!.querySelector('button.insert-picker-btn') as HTMLButtonElement).click()
    expect(box()).not.toBe('')
  })
})
