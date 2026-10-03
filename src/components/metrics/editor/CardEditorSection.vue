<script setup lang="ts">
// One Section editor (ADR 0003 section 4 item 4): a layout select, an optional title, an
// optional repeat, and its items — add/remove/reorder, each opening to the label/data/display/
// gating pickers (CardEditorItem.vue).
import { computed, useId } from 'vue'
import { duplicateItem, emptyItem, moveBy, withField } from '../../../lib/metrics/editorModel'
import type { Label, RepeatSpec, Section } from '../../../lib/metrics/types'
import CardEditorItem from './CardEditorItem.vue'
import CardEditorLabel from './CardEditorLabel.vue'
import CardEditorRepeat from './CardEditorRepeat.vue'

const props = defineProps<{
  cardRepeatOver?: RepeatSpec['over']
  index: number
  count: number
  sectionErrors: string[]
  itemErrors: Record<string, string[]>
  /** A preset's template shown for reading (CardEditor's preset mode): controls disabled. */
  readonly?: boolean
}>()
const emit = defineEmits<{ move: [dir: -1 | 1]; remove: [] }>()
const section = defineModel<Section>({ required: true })

const layoutId = useId()

const LAYOUTS: { value: Section['layout']; label: string }[] = [
  { value: 'rows', label: 'Rows' },
  { value: 'pills', label: 'Pills' },
  { value: 'tiles', label: 'Tiles' },
  { value: 'bars', label: 'Bars' },
  { value: 'columns', label: 'Columns (bars side by side)' },
  { value: 'table', label: 'Table' },
]

// Optional labels (title, column heading, row-label heading): switching one off remembers it,
// so switching it back on restores what the template had instead of starting from blank.
type OptionalLabel = 'title' | 'columnLabel' | 'rowsLabel'
const remembered: Partial<Record<OptionalLabel, Label>> = {}
/** The column headings that were set when the columns were cleared (restored with them). */
const setAside: Partial<Record<'columnLabel' | 'rowsLabel', Label>> = {}
function labelModel(key: OptionalLabel) {
  return computed<Label | undefined>({
    get: () => section.value[key],
    set: (v) => {
      if (v === section.value[key]) return
      section.value = withField(section.value, key, v)
    },
  })
}
function toggleLabel(key: OptionalLabel, on: boolean) {
  if (on === (section.value[key] !== undefined)) return
  if (!on) remembered[key] = section.value[key]
  section.value = withField(section.value, key, on ? (remembered[key] ?? '') : undefined)
}
const titleModel = labelModel('title')
const columnLabelModel = labelModel('columnLabel')
const rowsLabelModel = labelModel('rowsLabel')
const hasTitle = computed(() => section.value.title !== undefined)
function toggleTitle(on: boolean) {
  toggleLabel('title', on)
}
const repeatModel = computed({
  get: () => section.value.repeat,
  set: (v) => {
    if (v === section.value.repeat) return
    section.value = withField(section.value, 'repeat', v)
  },
})
/** A table's column repeat (Section.columns): items become rows, these instances columns. The
 * column and row-label headings only apply with columns (validateCard), so clearing the columns
 * sets them aside and choosing columns again brings them back. */
const columnsModel = computed({
  get: () => section.value.columns,
  set: (v) => {
    if (v === section.value.columns) return
    let next = withField(section.value, 'columns', v)
    if (!v) {
      for (const k of ['columnLabel', 'rowsLabel'] as const) {
        if (next[k] !== undefined) setAside[k] = next[k]
        next = withField(next, k, undefined)
      }
    } else if (!section.value.columns) {
      for (const k of ['columnLabel', 'rowsLabel'] as const) {
        if (next[k] === undefined && setAside[k] !== undefined) next = { ...next, [k]: setAside[k] }
        delete setAside[k]
      }
    }
    section.value = next
  },
})

function addItem() {
  section.value = { ...section.value, items: [...section.value.items, emptyItem()] }
}
function moveItem(i: number, dir: -1 | 1) {
  section.value = { ...section.value, items: moveBy(section.value.items, i, dir) }
}
function duplicateAt(i: number) {
  const items = [...section.value.items]
  items.splice(i + 1, 0, duplicateItem(items[i]))
  section.value = { ...section.value, items }
}
function removeAt(i: number) {
  const items = [...section.value.items]
  items.splice(i, 1)
  section.value = { ...section.value, items }
}
</script>

<template>
  <div class="ce-section">
    <div class="ce-section-head">
      <fieldset class="row ce-fieldset" style="flex: 1" :disabled="readonly">
        <div class="field">
          <label :for="layoutId">Layout</label>
          <select :id="layoutId" v-model="section.layout">
            <option v-for="l in LAYOUTS" :key="l.value" :value="l.value">{{ l.label }}</option>
          </select>
        </div>
      </fieldset>
      <span v-if="!readonly" class="ce-item-controls">
        <button type="button" class="icon-btn" title="Move section up" :disabled="index === 0" @click="emit('move', -1)">↑</button>
        <button type="button" class="icon-btn" title="Move section down" :disabled="index === count - 1" @click="emit('move', 1)">↓</button>
        <button type="button" class="icon-btn danger" title="Remove section" @click="emit('remove')">✕ Section</button>
      </span>
    </div>

    <ul v-if="sectionErrors.length" class="errors">
      <li v-for="(e, i) in sectionErrors" :key="i">{{ e }}</li>
    </ul>

    <fieldset class="ce-fieldset" :disabled="readonly">
    <div class="field check">
      <label><input type="checkbox" :checked="hasTitle"@change="toggleTitle(($event.target as HTMLInputElement).checked)" /> Section title</label>
    </div>
    <CardEditorLabel v-if="hasTitle" v-model="titleModel" :has-data="false" :repeat-over="cardRepeatOver" placeholder="Section title" heading="Section title" />

    <CardEditorRepeat v-if="!section.columns" v-model="repeatModel" :allow="['campaigns', 'popups', 'windows', 'readings', 'countries']" label="Repeat this section" />
    <CardEditorRepeat v-if="section.layout === 'table' && !section.repeat" v-model="columnsModel" :allow="['windows', 'countries', 'campaigns', 'popups']" label="Columns (each item becomes a row)" />
    <template v-if="section.columns">
      <div class="field check">
        <label><input type="checkbox" :checked="section.columnLabel !== undefined" @change="toggleLabel('columnLabel', ($event.target as HTMLInputElement).checked)" /> Column heading <span class="hint">— default: each column's own name</span></label>
      </div>
      <CardEditorLabel v-if="section.columnLabel !== undefined" v-model="columnLabelModel" :has-data="false" :allow-metric-own="false" :repeat-over="section.columns.over" placeholder="Column heading" heading="Column heading" />
      <div class="field check">
        <label><input type="checkbox" :checked="section.rowsLabel !== undefined" @change="toggleLabel('rowsLabel', ($event.target as HTMLInputElement).checked)" /> Heading over the row labels <span class="hint">— e.g. "Step"</span></label>
      </div>
      <CardEditorLabel v-if="section.rowsLabel !== undefined" v-model="rowsLabelModel" :has-data="false" :allow-metric-own="false" :repeat-over="cardRepeatOver" placeholder="Row-label heading" heading="Row-label heading" />
    </template>
    </fieldset>

    <ul class="ce-items">
      <CardEditorItem
        v-for="(item, i) in section.items"
        :key="item.id"
        :model-value="item"
        @update:model-value="(v) => (section.items[i] = v)"
        :card-repeat-over="cardRepeatOver"
        :section-repeat-over="section.repeat?.over"
        :index="i"
        :count="section.items.length"
        :errors="itemErrors[item.id] ?? []"
        :readonly="readonly"
        @move="(dir) => moveItem(i, dir)"
        @duplicate="duplicateAt(i)"
        @remove="removeAt(i)"
      />
    </ul>
    <button v-if="!readonly" type="button" class="btn" @click="addItem">+ Add item</button>
  </div>
</template>

<style scoped src="./editor.css"></style>
<style scoped>
.ce-section {
  border: 1px solid rgb(var(--line-2));
  border-radius: 12px;
  padding: 10px 12px 12px;
  margin-bottom: 12px;
  background: rgb(var(--sunken));
}
.ce-section-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.ce-items {
  list-style: none;
  margin: 8px 0;
  padding: 0;
}
</style>
