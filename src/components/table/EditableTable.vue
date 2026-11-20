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
// Accessibility: `status` is announced through a polite live region; each editor has an aria-label of the column
// and the row; a row with an error shows it with role="alert".
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

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
  }>(),
  { editable: false, layout: 'auto', status: '', rowStatus: () => ({}), highlightKey: null, loading: false, label: '', cardLabels: false },
)

const emit = defineEmits<{
  edit: [rowKey: string, field: string, value: string]
  action: [rowKey: string, actionId: string]
}>()

const rootEl = ref<HTMLElement | null>(null)
const width = ref(typeof window !== 'undefined' ? window.innerWidth : TABLE_MIN_WIDTH)
const cards = computed(() => props.layout === 'cards' || (props.layout === 'auto' && width.value < TABLE_MIN_WIDTH))

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
    <table v-if="!cards" class="et-table" :aria-label="label || undefined">
      <thead>
        <tr>
          <th v-for="col in columns" :key="col.key" scope="col" :class="{ 'et-end': col.align === 'end' }">{{ col.label }}</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="keyOf(row)">
          <tr :data-row-key="keyOf(row)" :class="rowClass(row)" :aria-busy="disabledOf(row) || undefined">
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
                  :data-text-trigger="keyOf(row) + '\u0000' + col.key"
                  :disabled="disabledOf(row)"
                  :aria-label="`Edit ${labelOf(row, col)}`"
                  @click="openText(row, col)"
                >
                  <slot :name="'cell-' + col.key" v-bind="scopeOf(row, col)">{{ shownOf(row, col) || '—' }}</slot>
                </button>
              </template>
              <slot v-else :name="'cell-' + col.key" v-bind="scopeOf(row, col)">{{ shownOf(row, col) }}</slot>
            </td>
          </tr>
          <tr v-if="hasExtra(row)" class="et-extra-row" :class="rowClass(row)">
            <td :colspan="columns.length">
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

    <!-- Card layout -->
    <ul v-else class="et-list" :aria-label="label || undefined">
      <li v-for="row in rows" :key="keyOf(row)" class="et-card" :data-row-key="keyOf(row)" :class="rowClass(row)" :aria-busy="disabledOf(row) || undefined">
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
                :data-text-trigger="keyOf(row) + '\u0000' + col.key"
                :disabled="disabledOf(row)"
                :aria-label="`Edit ${labelOf(row, col)}`"
                @click="openText(row, col)"
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
.et-end {
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
