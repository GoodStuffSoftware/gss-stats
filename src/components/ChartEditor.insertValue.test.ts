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
import { CAPTION_MAX_CHARS } from '../lib/defaults'
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

// Review SHOULD-2: the Insert button disables itself once its pick resets, so focus has to go
// back to the text box (caret right after what was inserted). Otherwise it is left on a disabled
// button (or the page body), and the dialog's Escape and Tab trap, which live on the panel, stop
// working until the author finds the box again.
describe('focus returns to the text box after Insert', () => {
  function openAttached(widget: Widget) {
    const w = mount(ChartEditor, { props: { widget, isNew: false }, attachTo: document.body, global: { stubs: { CardEditor: true } } })
    mounted.push(w)
    return w
  }
  /** Put the caret in a text box, then leave it for the Insert button, as a keyboard or mouse user does. */
  function caretIn(box: HTMLTextAreaElement, start: number, end: number = start) {
    box.focus()
    box.setSelectionRange(start, end)
    box.dispatchEvent(new Event('blur'))
  }
  async function pickAndInsert(menu: ReturnType<typeof captionMenu>, value: string) {
    await menu.setValue(value)
    const btn = insertBtn(menu)
    btn.focus()
    expect(document.activeElement).toBe(btn)
    await btn.click()
    await flushPromises()
  }
  const escape = () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

  it('caption: focus is on the caption with the caret right after the token, and Escape still cancels', async () => {
    const w = openAttached(base({ caption: 'Views: and more' }))
    const box = w.get('.caption-field textarea').element as HTMLTextAreaElement
    caretIn(box, 6)
    await pickAndInsert(captionMenu(w), '{=golive.web|date}')
    expect(box.value).toBe('Views:{=golive.web|date} and more')
    expect(document.activeElement).toBe(box)
    const after = 6 + '{=golive.web|date}'.length
    expect([box.selectionStart, box.selectionEnd]).toEqual([after, after])
    escape()
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('caption: a box never focused gets the token appended, and the caret goes to the end', async () => {
    const w = openAttached(base({ caption: 'Views:' }))
    const box = w.get('.caption-field textarea').element as HTMLTextAreaElement
    await pickAndInsert(captionMenu(w), '{=golive.web|date}')
    expect(document.activeElement).toBe(box)
    expect([box.selectionStart, box.selectionEnd]).toEqual([box.value.length, box.value.length])
  })

  it('caption: when the caption is full the insert is refused, focus still returns, and the caret is where it was', async () => {
    const full = 'x'.repeat(CAPTION_MAX_CHARS)
    const w = openAttached(base({ caption: full }))
    const box = w.get('.caption-field textarea').element as HTMLTextAreaElement
    caretIn(box, 40, 45)
    await pickAndInsert(captionMenu(w), '{=golive.web|date}')
    expect(w.find('.caption-full').text()).toBe('Caption is full')
    expect(box.value).toBe(full)
    expect(document.activeElement).toBe(box)
    expect([box.selectionStart, box.selectionEnd]).toEqual([40, 45])
    escape()
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('caption: Insert from library returns focus too, after the inserted text', async () => {
    const w = openAttached(base({ caption: 'A B' }))
    const box = w.get('.caption-field textarea').element as HTMLTextAreaElement
    caretIn(box, 1)
    const sel = w.get('.caption-field select.insert-library')
    await sel.setValue('small-sample')
    const btn = sel.element.parentElement!.querySelector('button.insert-picker-btn') as HTMLButtonElement
    btn.focus()
    await btn.click()
    await flushPromises()
    expect(document.activeElement).toBe(box)
    expect(box.value.startsWith('A')).toBe(true)
    expect(box.value.endsWith(' B')).toBe(true)
    const end = box.value.length - ' B'.length
    expect([box.selectionStart, box.selectionEnd]).toEqual([end, end])
  })

  it('note widget: focus returns to the note text, caret after the token', async () => {
    const w = openAttached(noteWidget({ note: 'Live since' }))
    const box = noteBox(w).element as HTMLTextAreaElement
    caretIn(box, 4)
    await pickAndInsert(noteMenu(w), '{=golive.web|date}')
    expect(box.value).toBe('Live{=golive.web|date} since')
    expect(document.activeElement).toBe(box)
    const after = 4 + '{=golive.web|date}'.length
    expect([box.selectionStart, box.selectionEnd]).toEqual([after, after])
  })
})
