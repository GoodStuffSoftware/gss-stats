// @vitest-environment happy-dom
// The generic editable table: layout by container width, read-only mode, select and text editors, keyboard,
// row notes and actions, the live region and highlighting. It knows nothing of any one data set; made-up rows only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import EditableTable, { TABLE_MIN_WIDTH, MIN_COL_WIDTH, loadColumnWidths, saveColumnWidths, clampColumnWidth, type EditableColumn, type RowStatus } from './EditableTable.vue'
import tableSrc from './EditableTable.vue?raw'

interface Row { id: string; name: string; size: string; note: string }
const ROWS: Row[] = [
  { id: 'r1', name: 'Alpha', size: 'small', note: 'first' },
  { id: 'r2', name: 'Beta', size: 'large', note: 'second' },
]
const COLUMNS: EditableColumn<Row>[] = [
  { key: 'name', label: 'Name', editor: null },
  { key: 'size', label: 'Size', editor: 'select', options: [
    { value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }, { value: 'huge', label: 'Huge', group: 'Special' },
  ] },
  { key: 'note', label: 'Note', editor: 'text' },
]

let width = 800
let observerCallback: (() => void) | null = null
class FakeObserver {
  constructor(cb: () => void) { observerCallback = cb }
  observe() {}
  disconnect() {}
}
let wrapper: VueWrapper | null = null
beforeEach(() => {
  width = 800
  observerCallback = null
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
  vi.stubGlobal('ResizeObserver', FakeObserver)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
})

async function mountTable(props: Record<string, unknown> = {}, slots: Record<string, unknown> = {}) {
  wrapper = mount(EditableTable as never, {
    props: { columns: COLUMNS, rows: ROWS, rowKey: 'id', editable: true, ...props },
    slots: slots as never,
    attachTo: document.body,
  } as never) as unknown as VueWrapper
  await wrapper.vm.$nextTick() // the width is measured on mount; the layout follows
  return wrapper
}

describe('EditableTable layout', () => {
  it('draws a table from the minimum width and cards below it', async () => {
    expect(TABLE_MIN_WIDTH).toBe(600)
    width = 600
    const w = await mountTable()
    expect(w.find('table').exists()).toBe(true)
    expect(w.find('ul.et-list').exists()).toBe(false)
    width = 599
    observerCallback?.()
    await w.vm.$nextTick()
    expect(w.find('table').exists()).toBe(false)
    expect(w.findAll('li.et-card')).toHaveLength(2)
  })

  it('layout "cards" and "table" force one', async () => {
    width = 1000
    expect((await mountTable({ layout: 'cards' })).find('ul.et-list').exists()).toBe(true)
    wrapper?.unmount()
    width = 300
    expect((await mountTable({ layout: 'table' })).find('table').exists()).toBe(true)
  })

  it('card layout: line 1 is the plain columns, line 2 the editors; touch targets are 44 px', async () => {
    width = 400
    const w = await mountTable()
    const card = w.get('li.et-card')
    expect(card.get('.et-line1').text()).toContain('Alpha')
    expect(card.find('.et-line1 select').exists()).toBe(false)
    expect(card.findAll('.et-line2 .et-field')).toHaveLength(2)
    expect(card.find('.et-line2 select').exists()).toBe(true)
    // happy-dom does not apply scoped CSS, so read the rule from the source
    expect(tableSrc).toMatch(/\.et-cards \.et-select[^}]*min-height: 44px/s)
  })

  it('cardLabels: every value in a card has its column label above it; off by default', async () => {
    width = 400
    const plain = await mountTable({ editable: false })
    expect(plain.findAll('[data-testid="card-label"]')).toHaveLength(0)
    plain.unmount()
    const cols: EditableColumn<Row>[] = [
      { key: 'name', label: 'Name', editor: null },
      { key: 'size', label: 'Size', editor: null },
      { key: 'note', label: 'Note', editor: null, cardLine: 2 },
    ]
    const w = await mountTable({ columns: cols, editable: false, cardLabels: true })
    const card = w.get('li.et-card')
    expect(card.findAll('.et-line1 [data-testid="card-label"]').map((l) => l.text())).toEqual(['Name', 'Size'])
    expect(card.findAll('.et-line2 [data-testid="card-label"]').map((l) => l.text())).toEqual(['Note'])
    expect(card.get('.et-line1').classes()).toContain('et-labelled')
    // the table layout never repeats the labels per row (its header has them)
    wrapper?.unmount()
    width = 800
    expect((await mountTable({ columns: cols, cardLabels: true })).findAll('[data-testid="card-label"]')).toHaveLength(0)
  })

  it('a column can leave the card (cardLine 0) and pick its line', async () => {
    width = 400
    const cols: EditableColumn<Row>[] = [
      { key: 'name', label: 'Name', editor: null },
      { key: 'size', label: 'Size', editor: null, cardLine: 0 },
      { key: 'note', label: 'Note', editor: null, cardLine: 2 },
    ]
    const w = await mountTable({ columns: cols })
    expect(w.get('.et-line1').text()).toContain('Alpha')
    expect(w.get('.et-line1').text()).not.toContain('small')
    expect(w.get('.et-line2').text()).toContain('first')
  })
})

describe('EditableTable editing', () => {
  it('read-only: no select, button or input', async () => {
    const w = await mountTable({ editable: false })
    expect(w.find('select').exists()).toBe(false)
    expect(w.find('button').exists()).toBe(false)
    expect(w.find('input').exists()).toBe(false)
    expect(w.text()).toContain('Large') // the option's label, not the raw value
    wrapper?.unmount()
    width = 400
    const c = await mountTable({ editable: false })
    expect(c.find('select').exists()).toBe(false)
    expect(c.find('button').exists()).toBe(false)
  })

  it('a select emits edit(rowKey, field, value), with option groups', async () => {
    const w = await mountTable()
    const select = w.get('tbody tr[data-row-key="r1"] select')
    expect(select.findAll('optgroup')).toHaveLength(1)
    expect((select.element as unknown as HTMLSelectElement).value).toBe('small')
    await select.setValue('large')
    expect(w.emitted('edit')).toEqual([['r1', 'size', 'large']])
  })

  it('a select the parent does not update goes back to its value', async () => {
    const w = await mountTable()
    const select = w.get('tbody tr[data-row-key="r1"] select')
    await select.setValue('large')
    await w.vm.$nextTick()
    expect((select.element as unknown as HTMLSelectElement).value).toBe('small')
  })

  it('text editor by keyboard: Enter opens, Enter saves', async () => {
    const w = await mountTable()
    const btn = w.get('tbody tr[data-row-key="r1"] button.et-text-btn')
    expect(btn.attributes('aria-label')).toBe('Edit Note, r1')
    await btn.trigger('click') // a button's Enter/Space press is a click
    const input = w.get('input.et-input')
    expect((input.element as HTMLInputElement).value).toBe('first')
    await input.setValue('changed')
    await input.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('edit')).toEqual([['r1', 'note', 'changed']])
    expect(w.find('input.et-input').exists()).toBe(false)
  })

  it('Escape cancels without emitting and gives focus back to the button', async () => {
    const w = await mountTable()
    await w.get('tbody tr[data-row-key="r2"] button.et-text-btn').trigger('click')
    const input = w.get('input.et-input')
    await input.setValue('nope')
    await input.trigger('keydown', { key: 'Escape' })
    await w.vm.$nextTick()
    expect(w.emitted('edit')).toBeUndefined()
    expect(w.find('input.et-input').exists()).toBe(false)
    expect(document.activeElement).toBe(w.get('tbody tr[data-row-key="r2"] button.et-text-btn').element)
  })

  it('leaving the field saves a change and ignores an unchanged value', async () => {
    const w = await mountTable()
    await w.get('button.et-text-btn').trigger('click')
    await w.get('input.et-input').trigger('blur')
    expect(w.emitted('edit')).toBeUndefined()
    await w.get('button.et-text-btn').trigger('click')
    const input = w.get('input.et-input')
    await input.setValue('other')
    await input.trigger('blur')
    expect(w.emitted('edit')).toEqual([['r1', 'note', 'other']])
  })

  it('an editor slot takes over the editor and commits through its scope', async () => {
    const w = await mountTable({}, {
      'editor-size': `<template #editor-size="{ row, commit, label }"><button class="mine" :aria-label="label" @click="commit('large')">{{ row.id }}</button></template>`,
    })
    const mine = w.get('tbody tr[data-row-key="r1"] button.mine')
    expect(mine.attributes('aria-label')).toBe('Size, r1')
    await mine.trigger('click')
    expect(w.emitted('edit')).toEqual([['r1', 'size', 'large']])
  })
})

describe('EditableTable row status', () => {
  it('shows an error with role=alert, dims, and disables a pending row', async () => {
    const rowStatus: Record<string, RowStatus> = {
      r1: { error: 'Could not save', dimmed: true },
      r2: { pending: true },
    }
    const w = await mountTable({ rowStatus })
    expect(w.get('[role="alert"]').text()).toBe('Could not save')
    expect(w.get('tr[data-row-key="r1"]').classes()).toContain('et-dimmed')
    expect(w.get('tr[data-row-key="r2"] select').attributes('disabled')).toBeDefined()
    expect(w.get('tr[data-row-key="r2"] button.et-text-btn').attributes('disabled')).toBeDefined()
  })

  it('an action button emits action(rowKey, id), in both layouts', async () => {
    const rowStatus: Record<string, RowStatus> = { r1: { message: 'Saved', action: { id: 'more', label: 'Do more' } } }
    const w = await mountTable({ rowStatus })
    expect(w.text()).toContain('Saved')
    await w.get('button.et-action').trigger('click')
    expect(w.emitted('action')).toEqual([['r1', 'more']])
    wrapper?.unmount()
    width = 400
    const c = await mountTable({ rowStatus })
    await c.get('li[data-row-key="r1"] button.et-action').trigger('click')
    expect(c.emitted('action')).toEqual([['r1', 'more']])
  })

  it('a busy action is disabled', async () => {
    const w = await mountTable({ rowStatus: { r1: { action: { id: 'x', label: 'Go', busy: true } } } })
    expect(w.get('button.et-action').attributes('disabled')).toBeDefined()
  })

  it('status text goes to a polite live region', async () => {
    const w = await mountTable({ status: 'Saved Alpha' })
    const live = w.get('[role="status"]')
    expect(live.attributes('aria-live')).toBe('polite')
    expect(live.text()).toBe('Saved Alpha')
  })

  it('empty: shows the empty slot, not while loading', async () => {
    const w = await mountTable({ rows: [] }, { empty: 'Nothing here' })
    expect(w.text()).toContain('Nothing here')
    wrapper?.unmount()
    expect((await mountTable({ rows: [], loading: true }, { empty: 'Nothing here' })).text()).not.toContain('Nothing here')
  })
})

describe('EditableTable highlight', () => {
  it('scrolls to the row and marks it, once per key', async () => {
    const scroll = vi.fn()
    HTMLElement.prototype.scrollIntoView = scroll
    const w = await mountTable({ highlightKey: 'r2' })
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(w.get('tr[data-row-key="r2"]').classes()).toContain('et-highlight')
    expect(w.get('tr[data-row-key="r1"]').classes()).not.toContain('et-highlight')
    await w.setProps({ rows: [...ROWS] })
    await w.vm.$nextTick()
    expect(scroll).toHaveBeenCalledTimes(1)
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView
  })

  it('waits for a row that is not there yet', async () => {
    const scroll = vi.fn()
    HTMLElement.prototype.scrollIntoView = scroll
    const w = await mountTable({ highlightKey: 'r3', rows: [ROWS[0]] })
    await w.vm.$nextTick()
    expect(scroll).not.toHaveBeenCalled()
    await w.setProps({ rows: [...ROWS, { id: 'r3', name: 'Gamma', size: 'small', note: '' }] })
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    expect(scroll).toHaveBeenCalledTimes(1)
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView
  })
})

describe('EditableTable is generic', () => {
  it('has no budget words in it', async () => {
    expect(tableSrc).not.toMatch(/budget|categor|merchant|transaction|amount|cents|account/i)
  })
})

describe('EditableTable hold-to-edit columns', () => {
  const HOLD_COLS: EditableColumn<Row>[] = COLUMNS.map((c) => (c.key === 'note' ? { ...c, editGesture: 'hold' as const } : c))
  const btn = (w: VueWrapper, id: string) => w.get(`tr[data-row-key="${id}"] button.et-text-btn`)
  afterEach(() => vi.useRealTimers())

  it('a plain column still edits on click, and says nothing about peeking', async () => {
    const w = await mountTable()
    await btn(w, 'r1').trigger('click')
    expect(w.find('input.et-input').exists()).toBe(true)
    expect(w.emitted('peek')).toBeUndefined()
  })
  it('a click on a hold column peeks and does not edit', async () => {
    const w = await mountTable({ columns: HOLD_COLS })
    await btn(w, 'r1').trigger('click')
    expect(w.find('input.et-input').exists()).toBe(false)
    const [rowKey, field, el, source] = w.emitted('peek')![0] as [string, string, HTMLElement, string]
    expect([rowKey, field, source]).toEqual(['r1', 'note', 'click'])
    expect(el).toBe(btn(w, 'r1').element)
  })
  it('a click on an empty hold cell edits it (there is nothing to peek at)', async () => {
    const w = await mountTable({ columns: HOLD_COLS, rows: [{ id: 'r1', name: 'Alpha', size: 'small', note: '' }] })
    await btn(w, 'r1').trigger('click')
    expect(w.find('input.et-input').exists()).toBe(true)
    expect(w.emitted('peek')).toBeUndefined()
  })
  it('holding for 500 ms edits, emits edit-start, and the release does not peek', async () => {
    vi.useFakeTimers()
    const w = await mountTable({ columns: HOLD_COLS })
    await btn(w, 'r1').trigger('pointerdown', { button: 0, clientX: 5, clientY: 5, pointerType: 'touch' })
    vi.advanceTimersByTime(499)
    expect(w.find('input.et-input').exists()).toBe(false)
    vi.advanceTimersByTime(1)
    await w.vm.$nextTick()
    expect(w.find('input.et-input').exists()).toBe(true)
    expect(w.emitted('edit-start')![0]).toEqual(['r1', 'note'])
    expect(w.emitted('peek')).toBeUndefined()
  })
  it('moving more than 8 px, or lifting early, cancels the hold', async () => {
    vi.useFakeTimers()
    const w = await mountTable({ columns: HOLD_COLS })
    await btn(w, 'r1').trigger('pointerdown', { button: 0, clientX: 5, clientY: 5, pointerType: 'touch' })
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 5, clientY: 20 }))
    vi.advanceTimersByTime(600)
    expect(w.find('input.et-input').exists()).toBe(false)
    await btn(w, 'r1').trigger('pointerdown', { button: 0, clientX: 5, clientY: 5, pointerType: 'touch' })
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 8, clientY: 8 })) // within the slop
    document.dispatchEvent(new Event('pointerup'))
    vi.advanceTimersByTime(600)
    expect(w.find('input.et-input').exists()).toBe(false)
  })
  it('a scroll cancels the hold', async () => {
    vi.useFakeTimers()
    const w = await mountTable({ columns: HOLD_COLS })
    await btn(w, 'r1').trigger('pointerdown', { button: 0, clientX: 5, clientY: 5, pointerType: 'touch' })
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(600)
    expect(w.find('input.et-input').exists()).toBe(false)
  })
  it('Enter and F2 edit; focus peeks', async () => {
    const w = await mountTable({ columns: HOLD_COLS })
    await btn(w, 'r1').trigger('keydown', { key: 'Enter' })
    expect(w.find('input.et-input').exists()).toBe(true)
    await w.get('input.et-input').trigger('keydown', { key: 'Escape' })
    await btn(w, 'r2').trigger('keydown', { key: 'F2' })
    expect(w.find('input.et-input').exists()).toBe(true)
    await w.get('input.et-input').trigger('keydown', { key: 'Escape' })
    await btn(w, 'r2').trigger('focus')
    expect(w.emitted('peek')!.at(-1)!.filter((x) => typeof x === 'string')).toEqual(['r2', 'note', 'focus'])
  })
})

describe('EditableTable resizable columns', () => {
  const KEY = 'test-table-cols'
  beforeEach(() => window.localStorage.clear())
  const handles = (w: VueWrapper) => w.findAll('[data-testid="col-resizer"]')
  async function drag(w: VueWrapper, i: number, dx: number) {
    const h = handles(w)[i]
    await h.trigger('pointerdown', { button: 0, clientX: 100, pointerId: 1 })
    await h.trigger('pointermove', { clientX: 100 + dx, pointerId: 1 })
    await h.trigger('pointerup', { clientX: 100 + dx, pointerId: 1 })
  }
  function stubHeaderWidths(px = 150) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: px, height: 20, top: 0, left: 0, right: px, bottom: 20, x: 0, y: 0, toJSON() {} })
  }
  afterEach(() => vi.restoreAllMocks())

  it('is off by default: no handles, no colgroup, no wrapper scroll', async () => {
    const w = await mountTable()
    expect(handles(w)).toHaveLength(0)
    expect(w.find('colgroup').exists()).toBe(false)
    expect(w.find('.et-resizable').exists()).toBe(false)
  })
  it('shows a handle on each header and no fixed layout until something is sized', async () => {
    const w = await mountTable({ resizable: true, storageKey: KEY })
    expect(handles(w)).toHaveLength(COLUMNS.length)
    expect(w.get('table').classes()).not.toContain('et-fixed')
  })
  it('dragging sets that column, fixes the layout, and saves per device', async () => {
    stubHeaderWidths(150)
    const w = await mountTable({ resizable: true, storageKey: KEY })
    await drag(w, 0, 40)
    expect(w.get('table').classes()).toContain('et-fixed')
    const cols = w.findAll('col').map((c) => c.attributes('style'))
    expect(cols[0]).toContain('190px')
    expect(cols[1]).toContain('150px')
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ name: 190, size: 150, note: 150 })
  })
  it('keeps a minimum width', async () => {
    stubHeaderWidths(150)
    const w = await mountTable({ resizable: true, storageKey: KEY })
    await drag(w, 1, -500)
    expect(JSON.parse(window.localStorage.getItem(KEY)!).size).toBe(MIN_COL_WIDTH)
  })
  it('double-click resets that column only', async () => {
    stubHeaderWidths(150)
    const w = await mountTable({ resizable: true, storageKey: KEY })
    await drag(w, 0, 40)
    await handles(w)[0].trigger('dblclick')
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ size: 150, note: 150 })
  })
  it('resetting the last sized column goes back to automatic layout and clears the key', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ name: 200 }))
    const w = await mountTable({ resizable: true, storageKey: KEY })
    expect(w.get('table').classes()).toContain('et-fixed')
    await handles(w)[0].trigger('dblclick')
    expect(w.get('table').classes()).not.toContain('et-fixed')
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })
  it('reads saved widths at mount (and drops junk)', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ name: 222, size: 5, note: 'wide', other: 100 }))
    const w = await mountTable({ resizable: true, storageKey: KEY })
    expect(w.findAll('col')[0].attributes('style')).toContain('222px')
    // An unsized column gets the default width, never "whatever is left".
    expect(w.findAll('col')[1].attributes('style')).toContain('120px')
  })
  it('a reset column goes back to its minWidth, or the default; the others keep theirs', async () => {
    stubHeaderWidths(150)
    const columns = COLUMNS.map((c) => (c.key === 'name' ? { ...c, minWidth: 140 } : c))
    const w = await mountTable({ resizable: true, storageKey: KEY, columns })
    await drag(w, 0, 200)
    await drag(w, 1, 10)
    await handles(w)[0].trigger('dblclick')
    expect(w.findAll('col')[0].attributes('style')).toContain('140px')
    expect(w.findAll('col')[1].attributes('style')).toContain('160px')
  })
  it('the scroll box and tableMinWidth exist only when resizable', async () => {
    const off = await mountTable({ tableMinWidth: 880 })
    expect(off.find('.et-scroll').exists()).toBe(false)
    expect(off.get('table').element.parentElement?.classList.contains('et')).toBe(true)
    const on = await mountTable({ resizable: true, storageKey: KEY, tableMinWidth: 880 })
    expect(on.get('.et-scroll').attributes('style')).toContain('overflow-x: auto')
    expect(on.get('table').attributes('style')).toContain('min-width: 880px')
  })
  it('emits narrow when the width is under the table minimum', async () => {
    const wide = await mountTable()
    expect(wide.emitted('narrow')?.at(-1) ?? [false]).toEqual([false])
    width = 400
    const phone = await mountTable({ layout: 'table' })
    expect(phone.emitted('narrow')?.at(-1)).toEqual([true])
    expect(phone.find('table').exists()).toBe(true)
  })
  it('arrow keys on a handle nudge the column', async () => {
    stubHeaderWidths(150)
    const w = await mountTable({ resizable: true, storageKey: KEY })
    await handles(w)[2].trigger('keydown', { key: 'ArrowRight' })
    expect(JSON.parse(window.localStorage.getItem(KEY)!).note).toBe(166)
  })
  it('does not break when localStorage throws', async () => {
    stubHeaderWidths(150)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    const w = await mountTable({ resizable: true, storageKey: KEY })
    await drag(w, 0, 30)
    expect(w.findAll('col')[0].attributes('style')).toContain('180px')
  })
  it('card layout has no handles', async () => {
    const w = await mountTable({ resizable: true, storageKey: KEY, layout: 'cards' })
    expect(handles(w)).toHaveLength(0)
  })
  it('loadColumnWidths / saveColumnWidths survive bad storage and bad JSON', () => {
    window.localStorage.setItem(KEY, '{nope')
    expect(loadColumnWidths(KEY)).toEqual({})
    window.localStorage.setItem(KEY, '[1,2]')
    expect(loadColumnWidths(KEY)).toEqual({})
    saveColumnWidths(KEY, { a: 100 })
    expect(loadColumnWidths(KEY)).toEqual({ a: 100 })
    expect(clampColumnWidth(5)).toBe(MIN_COL_WIDTH)
  })
})

describe('EditableTable selectable', () => {
  it('off by default: no checkboxes', async () => {
    const w = await mountTable()
    expect(w.find('[data-testid="select-all"]').exists()).toBe(false)
    expect(w.find('[data-testid="select-row"]').exists()).toBe(false)
  })
  it('on: a box per row; select all and none skip disabled rows', async () => {
    const w = await mountTable({ selectable: true, selected: new Set(['r1']), selectDisabled: (r: Row) => (r.id === 'r2' ? 'locked' : null) })
    expect(w.findAll('[data-testid="select-row"]')).toHaveLength(2)
    expect(w.findAll('[data-testid="select-row"]')[1].attributes('disabled')).toBeDefined()
    await w.find('[data-testid="select-all"]').setValue(false)
    expect((w.emitted('update:selected')?.at(-1)?.[0] as Set<string>).size).toBe(0)
    await w.setProps({ selected: new Set<string>() })
    await w.find('[data-testid="select-all"]').setValue(true)
    expect([...(w.emitted('update:selected')?.at(-1)?.[0] as Set<string>)]).toEqual(['r1'])
  })
  it('a row box toggles that row', async () => {
    const w = await mountTable({ selectable: true, selected: new Set<string>() })
    await w.findAll('[data-testid="select-row"]')[1].setValue(true)
    expect([...(w.emitted('update:selected')?.at(-1)?.[0] as Set<string>)]).toEqual(['r2'])
  })
})
