<script lang="ts">
// Types of the generic table (kept in a normal script block so other files can import them).
export interface SelectOption {
  value: string
  label: string
  /** Options sharing a group render under one <optgroup>. Ungrouped options come first. */
  group?: string
  disabled?: boolean
}

export interface EditableColumn<R> {
  /** Field name: what `edit` reports, and the key of the `cell-<key>` / `editor-<key>` slots. */
  key: string
  label: string
  /** `select` and `text` cells are editable (when the table is); null cells are plain text. */
  editor: 'select' | 'text' | null
  align?: 'start' | 'end'
  /** Text shown for the cell, and the editor's current value. Default: String(row[key] ?? ''). */
  value?: (row: R) => string
  /** Choices of a `select` editor. */
  options?: SelectOption[] | ((row: R) => SelectOption[])
  /** Card layout: 1 = first line (default), 2 = second line (default for editor columns), 0 = left out. */
  cardLine?: 0 | 1 | 2
  /**
   * How a `text` cell starts editing. `click` (default): a click or tap. `hold`: press and hold (HOLD_MS; moving or scrolling
   * cancels), or Enter / F2 on the focused cell. A plain click then emits `peek` (the parent shows the full text in a tip)
   * and focusing it by keyboard emits `peek` too; a click on an EMPTY cell opens the editor, since there is nothing to peek at.
   */
  editGesture?: 'click' | 'hold'
  /** Table layout: the narrowest this column is drawn (px); also the width a reset column returns to in a resized table. */
  minWidth?: number
}

/** What a row shows besides its cells. All parts are optional; a row with none shows nothing extra. */
export interface RowStatus {
  /** A change is in flight: the row's editors are disabled. */
  pending?: boolean
  /** Inline error under the row. */
  error?: string
  /** Inline note under the row. */
  message?: string
  /** Row is drawn dimmed (still readable). */
  dimmed?: boolean
  /** A button under the row; clicking it emits `action(rowKey, id)`. */
  action?: { id: string; label: string; busy?: boolean }
}

/** The container width (px) from which the table layout is used; narrower gets the card list. */
export const TABLE_MIN_WIDTH = 600
/** Press-and-hold time (ms) and the movement (px) that cancels it, for `editGesture: 'hold'`. */
export const HOLD_MS = 500
export const HOLD_SLOP = 8
/** Narrowest and widest a resized column can be (px). */
export const MIN_COL_WIDTH = 60
export const MAX_COL_WIDTH = 900

/** Saved column widths ({ column key: px }) from this device's localStorage; anything unreadable or out of range is dropped. */
export function loadColumnWidths(storageKey: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= MIN_COL_WIDTH && v <= MAX_COL_WIDTH) out[k] = Math.round(v)
    }
    return out
  } catch {
    return {}
  }
}
export function saveColumnWidths(storageKey: string, widths: Record<string, number>): void {
  try {
    if (Object.keys(widths).length === 0) window.localStorage.removeItem(storageKey)
    else window.localStorage.setItem(storageKey, JSON.stringify(widths))
  } catch {
    // Storage blocked or full: the widths just do not stay.
  }
}
export function clampColumnWidth(w: number): number {
  return Math.round(Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, w)))
}
</script>

<script setup lang="ts" generic="R extends Record<string, any>">
// A generic table whose cells can be edited, with no knowledge of what the rows are (ADR 0005: no one-off
// widgets). The parent owns the data: it passes `rows`, listens for `edit(rowKey, field, value)`, and decides what
// to show (the new value at once, a revert, an error) through `rows` and `rowStatus`.
//
// Card labels: with `cardLabels` each value in a card carries its column's label above it (small, muted), and line 1
// becomes a two-column grid. Without it (the default) a card shows bare values, which suits a few columns whose
// meaning is plain from the value (a date, a name, a size); a table of figures that look alike needs the labels.
//
// Layout: `auto` draws a <table> when the component's own width is at least TABLE_MIN_WIDTH, otherwise a card
// list (line 1: the line-1 columns; line 2: the editors at full width, 44 px tall touch targets). `table` and
// `cards` force one. Width comes from a ResizeObserver on the component's root (window width until it is measured).
//
// Editing (only when `editable`): a `select` column is a native <select> that emits `edit` on change; a `text`
// column is a button that opens an input (click, Enter or Space), where Enter saves, Escape cancels and leaving the
// field saves. A column can take over its editor with the `editor-<key>` slot (scope: row, column, value,
// disabled, label, commit) and its read-only look with `cell-<key>`. Not editable: every cell is plain text.
//
// Opt-in column gesture (`editGesture: 'hold'` on a text column): click or tap emits `peek`, press-and-hold or Enter / F2
// edits. Opt-in resizing (`resizable`, with `storageKey`): the table layout gets a drag handle on each header edge (double-click
// or double-tap resets that column; arrow keys on the focused handle nudge it), widths are kept per device in localStorage
// under `storageKey`, and the table still fills the width (unsized columns share what is left; saved widths scale up to
// fill). Opt-in selection (`selectable`, with `selected` / `update:selected`): a checkbox column (a checkbox on each card) with a select all / none header over
// the rows that can be ticked. All three are off by default, so other tables are unchanged.
//
// Accessibility: `status` is announced through a polite live region; each editor has an aria-label of the column
// and the row; a row with an error shows it with role="alert".
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch, type FunctionalComponent } from 'vue'

const props = withDefaults(
  defineProps<{
    columns: EditableColumn<R>[]
    rows: R[]
    /** Field that identifies a row, or a function that returns the key. */
    rowKey: string | ((row: R) => string)
    editable?: boolean
    layout?: 'auto' | 'table' | 'cards'
    /** Text for the polite live region. */
    status?: string
    rowStatus?: Record<string, RowStatus>
    /** Row to scroll to and mark (the parent clears it by passing null). */
    highlightKey?: string | null
    /** Short name of a row for screen readers (editor labels). Default: its key. */
    rowLabel?: (row: R) => string
    loading?: boolean
    /** Accessible name of the table. */
    label?: string
    /** Card layout: show each column's label above its value. */
    cardLabels?: boolean
    /** Table layout: drag handles to resize the columns, kept per device under `storageKey`. */
    resizable?: boolean
    /** localStorage key of the saved widths (no personal data in it). Without one, widths last until the page closes. */
    storageKey?: string
    /** Table layout: the table is never narrower than this (px); the page scrolls sideways instead (needs `resizable`). */
    tableMinWidth?: number
    /** Opt-in checkbox column (a checkbox on each card): ticked row keys come from `selected`, changes go out as `update:selected`. */
    selectable?: boolean
    selected?: ReadonlySet<string>
    /** Why a row cannot be ticked (null or empty: it can). Such a row is skipped by select all / none. */
    selectDisabled?: (row: R) => string | null | undefined
    /** Accessible name of a row's checkbox. Default: the row label. */
    selectLabel?: (row: R) => string
  }>(),
  {
    editable: false,
    layout: 'auto',
    status: '',
    rowStatus: () => ({}),
    highlightKey: null,
    loading: false,
    label: '',
    cardLabels: false,
    resizable: false,
    storageKey: '',
    tableMinWidth: 0,
    selectable: false,
    selected: () => new Set<string>(),
  },
)

const emit = defineEmits<{
  edit: [rowKey: string, field: string, value: string]
  action: [rowKey: string, actionId: string]
  /** `hold` columns: a click (or keyboard focus) on a cell that has text; `el` is the cell's button. */
  peek: [rowKey: string, field: string, el: HTMLElement, source: 'click' | 'focus']
  /** A text editor opened. */
  'edit-start': [rowKey: string, field: string]
  /** The component is narrower than TABLE_MIN_WIDTH (the card list is what `auto` would draw). Fires on every change. */
  narrow: [narrow: boolean]
  /** `selectable`: the new set of ticked row keys. */
  'update:selected': [keys: Set<string>]
}>()

const rootEl = ref<HTMLElement | null>(null)
const width = ref(typeof window !== 'undefined' ? window.innerWidth : TABLE_MIN_WIDTH)
const cards = computed(() => props.layout === 'cards' || (props.layout === 'auto' && width.value < TABLE_MIN_WIDTH))

const narrow = computed(() => width.value < TABLE_MIN_WIDTH)
watch(narrow, (n) => emit('narrow', n), { immediate: true })

function measure() {
  const w = rootEl.value?.clientWidth
  if (w) width.value = w
  else if (typeof window !== 'undefined') width.value = window.innerWidth
}
let observer: ResizeObserver | null = null
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && rootEl.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(rootEl.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())

function rowSelectable(row: R): boolean {
  return !props.selectDisabled?.(row)
}
const selectableRows = computed(() => props.rows.filter(rowSelectable))
const selectedCount = computed(() => selectableRows.value.filter((r) => props.selected.has(keyOf(r))).length)
const allSelected = computed(() => selectableRows.value.length > 0 && selectedCount.value === selectableRows.value.length)
const someSelected = computed(() => selectedCount.value > 0 && !allSelected.value)
function toggleRow(row: R, on: boolean) {
  const next = new Set(props.selected)
  if (on) next.add(keyOf(row))
  else next.delete(keyOf(row))
  emit('update:selected', next)
}
function toggleAll(on: boolean) {
  const next = new Set(props.selected)
  for (const r of selectableRows.value) {
    if (on) next.add(keyOf(r))
    else next.delete(keyOf(r))
  }
  emit('update:selected', next)
}
function selLabelOf(row: R): string {
  return props.selectLabel ? props.selectLabel(row) : props.rowLabel ? props.rowLabel(row) : keyOf(row)
}

function keyOf(row: R): string {
  return typeof props.rowKey === 'function' ? props.rowKey(row) : String(row[props.rowKey])
}
function textOf(row: R, col: EditableColumn<R>): string {
  return col.value ? col.value(row) : String(row[col.key] ?? '')
}
function optionsOf(row: R, col: EditableColumn<R>): SelectOption[] {
  const o = col.options
  return typeof o === 'function' ? o(row) : (o ?? [])
}
function groupsOf(opts: SelectOption[]): Array<{ group: string | null; options: SelectOption[] }> {
  const out: Array<{ group: string | null; options: SelectOption[] }> = []
  for (const o of opts) {
    const g = o.group ?? null
    let bucket = out.find((b) => b.group === g)
    if (!bucket) out.push((bucket = { group: g, options: [] }))
    bucket.options.push(o)
  }
  return out.sort((a, b) => (a.group === null ? -1 : b.group === null ? 1 : 0))
}
/** What a read-only cell shows: a select's option label when there is one, else the text. */
function shownOf(row: R, col: EditableColumn<R>): string {
  const t = textOf(row, col)
  if (col.editor !== 'select') return t
  return optionsOf(row, col).find((o) => o.value === t)?.label ?? t
}
function labelOf(row: R, col: EditableColumn<R>): string {
  return `${col.label}, ${props.rowLabel ? props.rowLabel(row) : keyOf(row)}`
}
function statusOf(row: R): RowStatus | undefined {
  return props.rowStatus[keyOf(row)]
}
function isEditable(col: EditableColumn<R>): boolean {
  return props.editable && col.editor !== null
}
function disabledOf(row: R): boolean {
  return !!statusOf(row)?.pending
}
function hasExtra(row: R): boolean {
  const s = statusOf(row)
  return !!(s && (s.error || s.message || s.action))
}
function cardColumns(line: 1 | 2): EditableColumn<R>[] {
  return props.columns.filter((c) => (c.cardLine ?? (c.editor ? 2 : 1)) === line)
}
function scopeOf(row: R, col: EditableColumn<R>) {
  return {
    row,
    column: col,
    value: textOf(row, col),
    disabled: disabledOf(row),
    label: labelOf(row, col),
    cardLayout: cards.value,
    commit: (v: string) => emit('edit', keyOf(row), col.key, v),
  }
}

function onSelect(row: R, col: EditableColumn<R>, ev: Event) {
  const el = ev.target as HTMLSelectElement
  emit('edit', keyOf(row), col.key, el.value)
  // If the parent does not take the value, the field must not keep showing it.
  void nextTick(() => {
    el.value = textOf(row, col)
  })
}

// Text editor: one field open at a time.
const editing = ref<{ key: string; field: string } | null>(null)
const draft = ref('')
const rootRef = rootEl
function openText(row: R, col: EditableColumn<R>) {
  if (disabledOf(row)) return
  editing.value = { key: keyOf(row), field: col.key }
  draft.value = textOf(row, col)
  emit('edit-start', keyOf(row), col.key)
  void nextTick(() => {
    const input = rootRef.value?.querySelector<HTMLInputElement>('input.et-input')
    input?.focus()
    input?.select()
  })
}
function isEditing(row: R, col: EditableColumn<R>): boolean {
  return editing.value?.key === keyOf(row) && editing.value.field === col.key
}
function focusTrigger(key: string, field: string) {
  void nextTick(() => {
    const els = rootRef.value?.querySelectorAll<HTMLElement>('[data-text-trigger]') ?? []
    for (const el of els) if (el.dataset.textTrigger === `${key}\u0000${field}`) el.focus()
  })
}
function commitText(row: R, col: EditableColumn<R>) {
  if (!isEditing(row, col)) return
  const changed = draft.value !== textOf(row, col)
  const key = keyOf(row)
  editing.value = null
  if (changed) emit('edit', key, col.key, draft.value)
}
function cancelText(row: R, col: EditableColumn<R>) {
  const key = keyOf(row)
  editing.value = null
  focusTrigger(key, col.key)
}

// Text-cell gestures (see EditableColumn.editGesture).
const isHold = (col: EditableColumn<R>) => col.editGesture === 'hold'
let holdTimer: ReturnType<typeof setTimeout> | null = null
let holdFrom = { x: 0, y: 0 }
let suppressClick = false
function holdCancel() {
  if (holdTimer !== null) clearTimeout(holdTimer)
  holdTimer = null
  document.removeEventListener('pointermove', onHoldMove)
  document.removeEventListener('pointerup', holdCancel)
  document.removeEventListener('pointercancel', holdCancel)
  window.removeEventListener('scroll', holdCancel, true)
}
function onHoldMove(e: PointerEvent) {
  if (Math.hypot(e.clientX - holdFrom.x, e.clientY - holdFrom.y) > HOLD_SLOP) holdCancel()
}
function holdStart(row: R, col: EditableColumn<R>, e: PointerEvent) {
  suppressClick = false
  if (!isHold(col) || disabledOf(row)) return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  holdCancel()
  holdFrom = { x: e.clientX, y: e.clientY }
  document.addEventListener('pointermove', onHoldMove)
  document.addEventListener('pointerup', holdCancel)
  document.addEventListener('pointercancel', holdCancel)
  window.addEventListener('scroll', holdCancel, true)
  holdTimer = setTimeout(() => {
    holdCancel()
    suppressClick = true // the release that follows must not count as a click
    openText(row, col)
  }, HOLD_MS)
}
function onTextClick(row: R, col: EditableColumn<R>, e: MouseEvent) {
  if (suppressClick) {
    suppressClick = false
    return
  }
  if (!isHold(col) || !textOf(row, col)) {
    openText(row, col)
    return
  }
  emit('peek', keyOf(row), col.key, e.currentTarget as HTMLElement, 'click')
}
function onTextKey(row: R, col: EditableColumn<R>, e: KeyboardEvent) {
  if (!isHold(col) || e.altKey || e.ctrlKey || e.metaKey) return
  if (e.key === 'Enter' || e.key === 'F2') {
    e.preventDefault() // Enter would otherwise click the button, which only peeks
    openText(row, col)
  }
}
function onTextFocus(row: R, col: EditableColumn<R>, e: FocusEvent) {
  if (isHold(col) && textOf(row, col)) emit('peek', keyOf(row), col.key, e.currentTarget as HTMLElement, 'focus')
}
function onTextContext(col: EditableColumn<R>, e: Event) {
  if (isHold(col)) e.preventDefault() // a hold on touch must not open the browser's menu
}
onBeforeUnmount(holdCancel)

// Column resizing (only when `resizable`, table layout).
const widths = ref<Record<string, number>>(props.resizable && props.storageKey ? loadColumnWidths(props.storageKey) : {})
const sized = computed(() => props.resizable && Object.keys(widths.value).length > 0)
const DEFAULT_COL_WIDTH = 120
// The table's scroll box: drawn only when `resizable` (other tables keep the bare <table>). Inline styles, since a
// functional component's elements do not carry this file's scoped-style id.
const ScrollBox: FunctionalComponent<{ on: boolean }> = (p, { slots }) =>
  p.on ? h('div', { class: 'et-scroll et-resizable', style: { overflowX: 'auto' } }, slots.default?.()) : slots.default?.()
ScrollBox.props = ['on']
function persistWidths() {
  if (props.storageKey) saveColumnWidths(props.storageKey, widths.value)
}
/** Fix every column at the width it has now, so one can change alone. */
function freezeWidths() {
  const ths = rootEl.value?.querySelectorAll<HTMLElement>('thead th') ?? []
  const next = { ...widths.value }
  props.columns.forEach((c, i) => {
    if (next[c.key] == null) next[c.key] = clampColumnWidth(ths[i]?.getBoundingClientRect().width || MIN_COL_WIDTH)
  })
  widths.value = next
}
let resizing: { key: string; startX: number; startW: number; id: number } | null = null
function resizeStart(col: EditableColumn<R>, e: PointerEvent) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  freezeWidths()
  resizing = { key: col.key, startX: e.clientX, startW: widths.value[col.key], id: e.pointerId }
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    // No pointer capture (an old browser, a test): moves are still heard on the handle while the pointer is over it.
  }
}
function resizeMove(e: PointerEvent) {
  if (!resizing || e.pointerId !== resizing.id) return
  widths.value = { ...widths.value, [resizing.key]: clampColumnWidth(resizing.startW + e.clientX - resizing.startX) }
}
function resizeEnd(e: PointerEvent) {
  if (!resizing || e.pointerId !== resizing.id) return
  resizing = null
  persistWidths()
}
function resizeReset(col: EditableColumn<R>) {
  const next = { ...widths.value }
  delete next[col.key]
  // Only this column goes back to its automatic share; the others keep their widths.
  widths.value = next
  persistWidths()
}
function resizeKey(col: EditableColumn<R>, e: KeyboardEvent) {
  const step = e.shiftKey ? 48 : 16
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    freezeWidths()
    widths.value = { ...widths.value, [col.key]: clampColumnWidth(widths.value[col.key] + (e.key === 'ArrowRight' ? step : -step)) }
    persistWidths()
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    resizeReset(col)
  }
}
// A column without a saved width (reset, or never dragged) gets its default, so it is never left to share what is
// left over (which can be nothing once the others are wide).
const colStyle = (col: EditableColumn<R>) => ({ width: `${widths.value[col.key] ?? col.minWidth ?? DEFAULT_COL_WIDTH}px` })
const thStyle = (col: EditableColumn<R>) => (col.minWidth ? { minWidth: `${col.minWidth}px` } : undefined)
const tableStyle = computed(() => (props.resizable && props.tableMinWidth ? { minWidth: `${props.tableMinWidth}px` } : undefined))

// Scroll to and mark the highlighted row, once per key, as soon as that row is in `rows`.
let scrolledFor: string | null = null
function scrollToHighlight() {
  const key = props.highlightKey
  if (!key) {
    scrolledFor = null
    return
  }
  if (scrolledFor === key) return
  const el = Array.from(rootRef.value?.querySelectorAll<HTMLElement>('[data-row-key]') ?? []).find((n) => n.dataset.rowKey === key)
  if (!el) return
  scrolledFor = key
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
watch([() => props.highlightKey, () => props.rows, cards], () => void nextTick(scrollToHighlight), { flush: 'post' })
onMounted(() => void nextTick(scrollToHighlight))

function rowClass(row: R) {
  const s = statusOf(row)
  return { 'et-dimmed': !!s?.dimmed, 'et-pending': !!s?.pending, 'et-highlight': props.highlightKey === keyOf(row) }
}
</script>

<template>
  <div ref="rootEl" class="et" :class="cards ? 'et-cards' : 'et-wide'" :aria-busy="loading || undefined">
    <div class="et-sr" role="status" aria-live="polite">{{ status }}</div>

    <!-- Table layout -->
    <ScrollBox v-if="!cards" :on="resizable">
    <table class="et-table" :class="{ 'et-fixed': sized }" :style="tableStyle" :aria-label="label || undefined">
      <colgroup v-if="sized">
        <col v-if="selectable" style="width: 44px" />
        <col v-for="col in columns" :key="col.key" :style="colStyle(col)" />
      </colgroup>
      <thead>
        <tr>
          <th v-if="selectable" scope="col" class="et-selcell">
            <input
              type="checkbox"
              class="et-check"
              data-testid="select-all"
              aria-label="Select all"
              :checked="allSelected"
              :indeterminate="someSelected"
              :disabled="!selectableRows.length"
              @change="toggleAll(($event.target as HTMLInputElement).checked)"
            />
          </th>
          <th v-for="col in columns" :key="col.key" scope="col" :class="{ 'et-end': col.align === 'end' }" :style="thStyle(col)">
            {{ col.label }}
            <span
              v-if="resizable"
              class="et-resizer"
              role="separator"
              aria-orientation="vertical"
              tabindex="0"
              :aria-label="`Resize ${col.label} column`"
              data-testid="col-resizer"
              title="Drag to resize; double-click to reset"
              @pointerdown="resizeStart(col, $event)"
              @pointermove="resizeMove"
              @pointerup="resizeEnd"
              @pointercancel="resizeEnd"
              @dblclick.stop="resizeReset(col)"
              @keydown="resizeKey(col, $event)"
            />
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="keyOf(row)">
          <tr :data-row-key="keyOf(row)" :class="rowClass(row)" :aria-busy="disabledOf(row) || undefined">
            <td v-if="selectable" class="et-selcell">
              <input
                type="checkbox"
                class="et-check"
                data-testid="select-row"
                :aria-label="selLabelOf(row)"
                :title="selectDisabled?.(row) || undefined"
                :checked="selected.has(keyOf(row))"
                :disabled="!rowSelectable(row) || disabledOf(row)"
                @change="toggleRow(row, ($event.target as HTMLInputElement).checked)"
              />
            </td>
            <td v-for="col in columns" :key="col.key" :class="{ 'et-end': col.align === 'end' }">
              <slot v-if="isEditable(col) && $slots['editor-' + col.key]" :name="'editor-' + col.key" v-bind="scopeOf(row, col)" />
              <select
                v-else-if="isEditable(col) && col.editor === 'select'"
                class="et-select"
                :value="textOf(row, col)"
                :disabled="disabledOf(row)"
                :aria-label="labelOf(row, col)"
                @change="onSelect(row, col, $event)"
              >
                <template v-for="g in groupsOf(optionsOf(row, col))" :key="g.group ?? ''">
                  <optgroup v-if="g.group" :label="g.group">
                    <option v-for="o in g.options" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option>
                  </optgroup>
                  <template v-else>
                    <option v-for="o in g.options" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option>
                  </template>
                </template>
              </select>
              <template v-else-if="isEditable(col) && col.editor === 'text'">
                <input
                  v-if="isEditing(row, col)"
                  v-model="draft"
                  class="et-input"
                  type="text"
                  :aria-label="labelOf(row, col)"
                  @keydown.enter.prevent="commitText(row, col)"
                  @keydown.esc.prevent="cancelText(row, col)"
                  @blur="commitText(row, col)"
                />
                <button
                  v-else
                  type="button"
                  class="et-text-btn"
                  :class="{ 'et-hold': isHold(col) }"
                  :data-text-trigger="keyOf(row) + '\u0000' + col.key"
                  :disabled="disabledOf(row)"
                  :aria-label="`Edit ${labelOf(row, col)}`"
                  @click="onTextClick(row, col, $event)"
                  @pointerdown="holdStart(row, col, $event)"
                  @keydown="onTextKey(row, col, $event)"
                  @focus="onTextFocus(row, col, $event)"
                  @contextmenu="onTextContext(col, $event)"
                >
                  <slot :name="'cell-' + col.key" v-bind="scopeOf(row, col)">{{ shownOf(row, col) || '—' }}</slot>
                </button>
              </template>
              <slot v-else :name="'cell-' + col.key" v-bind="scopeOf(row, col)">{{ shownOf(row, col) }}</slot>
            </td>
          </tr>
          <tr v-if="hasExtra(row)" class="et-extra-row" :class="rowClass(row)">
            <td :colspan="columns.length + (selectable ? 1 : 0)">
              <span v-if="statusOf(row)?.error" class="et-error" role="alert">{{ statusOf(row)?.error }}</span>
              <span v-else-if="statusOf(row)?.message" class="et-note">{{ statusOf(row)?.message }}</span>
              <button
                v-if="statusOf(row)?.action"
                type="button"
                class="et-action"
                :disabled="statusOf(row)?.action?.busy"
                @click="emit('action', keyOf(row), statusOf(row)!.action!.id)"
              >
                {{ statusOf(row)?.action?.label }}
              </button>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    </ScrollBox>

    <!-- Card layout -->
    <ul v-else class="et-list" :aria-label="label || undefined">
      <li v-for="row in rows" :key="keyOf(row)" class="et-card" :data-row-key="keyOf(row)" :class="[rowClass(row), { 'et-has-sel': selectable }]" :aria-busy="disabledOf(row) || undefined">
        <input
          v-if="selectable"
          type="checkbox"
          class="et-check et-card-check"
          data-testid="select-row"
          :aria-label="selLabelOf(row)"
          :title="selectDisabled?.(row) || undefined"
          :checked="selected.has(keyOf(row))"
          :disabled="!rowSelectable(row) || disabledOf(row)"
          @change="toggleRow(row, ($event.target as HTMLInputElement).checked)"
        />
        <div class="et-line et-line1" :class="{ 'et-labelled': cardLabels }">
          <span v-for="col in cardColumns(1)" :key="col.key" class="et-part" :class="{ 'et-end': col.align === 'end' }">
            <span v-if="cardLabels" class="et-lab" data-testid="card-label">{{ col.label }}</span>
            <slot v-if="isEditable(col) && $slots['editor-' + col.key]" :name="'editor-' + col.key" v-bind="scopeOf(row, col)" />
            <slot v-else :name="'cell-' + col.key" v-bind="scopeOf(row, col)">{{ shownOf(row, col) }}</slot>
          </span>
        </div>
        <div v-if="cardColumns(2).length" class="et-line et-line2">
          <div v-for="col in cardColumns(2)" :key="col.key" class="et-field">
            <span v-if="cardLabels" class="et-lab" data-testid="card-label">{{ col.label }}</span>
            <slot v-if="isEditable(col) && $slots['editor-' + col.key]" :name="'editor-' + col.key" v-bind="scopeOf(row, col)" />
            <select
              v-else-if="isEditable(col) && col.editor === 'select'"
              class="et-select"
              :value="textOf(row, col)"
              :disabled="disabledOf(row)"
              :aria-label="labelOf(row, col)"
              @change="onSelect(row, col, $event)"
            >
              <template v-for="g in groupsOf(optionsOf(row, col))" :key="g.group ?? ''">
                <optgroup v-if="g.group" :label="g.group">
                  <option v-for="o in g.options" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option>
                </optgroup>
                <template v-else>
                  <option v-for="o in g.options" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option>
                </template>
              </template>
            </select>
            <template v-else-if="isEditable(col) && col.editor === 'text'">
              <input
                v-if="isEditing(row, col)"
                v-model="draft"
                class="et-input"
                type="text"
                :aria-label="labelOf(row, col)"
                @keydown.enter.prevent="commitText(row, col)"
                @keydown.esc.prevent="cancelText(row, col)"
                @blur="commitText(row, col)"
              />
              <button
                v-else
                type="button"
                class="et-text-btn"
                :class="{ 'et-hold': isHold(col) }"
                :data-text-trigger="keyOf(row) + '\u0000' + col.key"
                :disabled="disabledOf(row)"
                :aria-label="`Edit ${labelOf(row, col)}`"
                @click="onTextClick(row, col, $event)"
                @pointerdown="holdStart(row, col, $event)"
                @keydown="onTextKey(row, col, $event)"
                @focus="onTextFocus(row, col, $event)"
                @contextmenu="onTextContext(col, $event)"
              >
                <slot :name="'cell-' + col.key" v-bind="scopeOf(row, col)">{{ shownOf(row, col) || '—' }}</slot>
              </button>
            </template>
            <slot v-else :name="'cell-' + col.key" v-bind="scopeOf(row, col)">{{ shownOf(row, col) }}</slot>
          </div>
        </div>
        <div v-if="hasExtra(row)" class="et-extra">
          <span v-if="statusOf(row)?.error" class="et-error" role="alert">{{ statusOf(row)?.error }}</span>
          <span v-else-if="statusOf(row)?.message" class="et-note">{{ statusOf(row)?.message }}</span>
          <button
            v-if="statusOf(row)?.action"
            type="button"
            class="et-action"
            :disabled="statusOf(row)?.action?.busy"
            @click="emit('action', keyOf(row), statusOf(row)!.action!.id)"
          >
            {{ statusOf(row)?.action?.label }}
          </button>
        </div>
      </li>
    </ul>

    <div v-if="!rows.length && !loading" class="et-empty"><slot name="empty">Nothing to show.</slot></div>
    <slot name="footer" />
  </div>
</template>

<style scoped>
.et {
  width: 100%;
  min-width: 0;
}
.et-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.et-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  color: rgb(var(--ink));
}
.et-table th {
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: rgb(var(--ink-3));
  padding: 6px 8px;
  border-bottom: 1px solid rgb(var(--line-2));
}
.et-table td {
  padding: 6px 8px;
  border-bottom: 1px solid rgb(var(--line));
  vertical-align: middle;
}
.et-fixed {
  table-layout: fixed;
}
.et-fixed td {
  overflow-wrap: anywhere;
}
.et-resizable .et-table th {
  position: relative;
}
/* The drag handle on a header's right edge: a thin line shows on hover or focus; 10 px wide to grab. */
.et-resizer {
  position: absolute;
  top: 0;
  right: -5px;
  bottom: 0;
  z-index: 1;
  width: 10px;
  cursor: col-resize;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
/* A finger needs a wider target than a mouse. */
@media (pointer: coarse) {
  .et-resizer {
    right: -12px;
    width: 24px;
  }
  .et-resizer::after {
    left: 11px;
  }
}
.et-resizer::after {
  content: '';
  position: absolute;
  top: 25%;
  bottom: 25%;
  left: 4px;
  width: 2px;
  border-radius: 1px;
  background: rgb(var(--line-2));
}
.et-resizer:hover::after,
.et-resizer:focus-visible::after {
  background: rgb(var(--amber));
}
.et-resizer:focus-visible {
  outline: none;
}
.et-end,
.et-table th.et-end {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.et-extra-row td {
  padding-top: 0;
  font-size: 12px;
}
.et-dimmed {
  opacity: 0.55;
}
.et-pending {
  opacity: 0.75;
}
.et-highlight {
  background: rgb(var(--amber-tint));
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
}
.et-select,
.et-input {
  font: inherit;
  color: rgb(var(--ink));
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 6px;
  padding: 4px 6px;
  max-width: 100%;
}
.et-text-btn {
  font: inherit;
  color: inherit;
  background: none;
  border: 1px dashed transparent;
  border-radius: 6px;
  padding: 2px 4px;
  cursor: text;
  text-align: left;
}
/* A hold-to-edit cell: a hold must not select its text or pop the browser's callout. */
.et-hold {
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  touch-action: pan-y;
}
.et-text-btn:hover,
.et-text-btn:focus-visible {
  border-color: rgb(var(--line-2));
}
.et-action {
  font: inherit;
  font-size: 12px;
  margin-left: 8px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid rgb(var(--amber));
  background: rgb(var(--amber-tint));
  color: rgb(var(--ink));
  cursor: pointer;
}
.et-action:disabled {
  opacity: 0.6;
  cursor: default;
}
.et-error {
  color: rgb(var(--g4));
}
.et-note {
  color: rgb(var(--ink-2));
}
.et-empty {
  padding: 16px 8px;
  color: rgb(var(--ink-3));
  font-size: 13px;
}

/* Card layout: 44 px touch targets. */
.et-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.et-card {
  border: 1px solid rgb(var(--line));
  border-radius: 10px;
  background: rgb(var(--surface));
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.et-selcell {
  width: 44px;
  text-align: center;
}
.et-check {
  width: 18px;
  height: 18px;
  margin: 0;
  accent-color: rgb(var(--amber));
  cursor: pointer;
}
.et-check:disabled {
  cursor: not-allowed;
}
.et-card.et-has-sel {
  position: relative;
  padding-left: 44px;
}
.et-card-check {
  position: absolute;
  left: 13px;
  top: 12px;
}
.et-line1 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.et-line1 .et-part:nth-child(2) {
  flex: 1;
  min-width: 0;
}
.et-field {
  width: 100%;
}
/* Labelled cards: a two-column grid of "LABEL / value" pairs. */
.et-line1.et-labelled {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 12px;
  align-items: start;
}
.et-labelled .et-part,
.et-labelled .et-part:nth-child(2) {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: none;
  min-width: 0;
  text-align: left;
}
.et-lab {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: rgb(var(--ink-3));
}
.et-field > .et-lab {
  display: block;
  margin-bottom: 2px;
}
.et-cards .et-select,
.et-cards .et-input,
.et-cards .et-text-btn,
.et-cards .et-action {
  min-height: 44px;
  width: 100%;
  box-sizing: border-box;
  font-size: 15px;
}
.et-cards .et-action {
  width: auto;
  margin-left: 0;
  min-width: 44px;
}
.et-extra {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  font-size: 12px;
}
</style>
