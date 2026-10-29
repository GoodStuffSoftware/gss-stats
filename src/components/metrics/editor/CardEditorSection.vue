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
  { value: 'lines', label: 'Lines (running text)' },
]

// Optional labels (title, column heading, row-label heading): switching one off remembers it,
// so switching it back on restores what the template had instead of starting from blank.
type OptionalLabel = 'title' | 'columnLabel' | 'rowsLabel'
const remembered: Partial<Record<OptionalLabel, Label>> = {}
/** The column headings that were set when the columns were cleared (restored with them). */
const setAside: Partial<Record<'columnLabel' | 'rowsLabel', Label>> & { columnGroups?: Section['columnGroups']; innerGroup?: RepeatSpec } = {}
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
/** The scope a section title reads: each panel's own instance in a panels section (MetricSection
 * panels), otherwise the card's. */
const titleRepeatOver = computed(() => (section.value.panels && section.value.repeat ? section.value.repeat.over : props.cardRepeatOver))
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
/** A table's row groups (Section.rowGroups): each section-repeat instance becomes a group of
 * rows, one per instance of this inner repeat. */
const rowGroupsModel = computed({
  get: () => section.value.rowGroups,
  set: (v) => {
    if (v === section.value.rowGroups) return
    section.value = withField(section.value, 'rowGroups', v)
  },
})
/** A table's column repeat (Section.columns): items become rows, these instances columns. The
 * column groups and the column and row-label headings only apply with columns (validateCard), so clearing the
 * columns sets them aside and choosing columns again brings them back. */
const columnsModel = computed({
  get: () => section.value.columns,
  set: (v) => {
    if (v === section.value.columns) return
    let next = withField(section.value, 'columns', v)
    if (!v) {
      if (next.columnGroups !== undefined) setAside.columnGroups = next.columnGroups
      next = withField(next, 'columnGroups', undefined)
      for (const k of ['columnLabel', 'rowsLabel'] as const) {
        if (next[k] !== undefined) setAside[k] = next[k]
        next = withField(next, k, undefined)
      }
    } else if (!section.value.columns) {
      if (next.columnGroups === undefined && setAside.columnGroups !== undefined) next = { ...next, columnGroups: setAside.columnGroups }
      delete setAside.columnGroups
      for (const k of ['columnLabel', 'rowsLabel'] as const) {
        if (next[k] === undefined && setAside[k] !== undefined) next = { ...next, [k]: setAside[k] }
        delete setAside[k]
      }
    }
    section.value = next
  },
})

/** A column table's column groups (Section.columnGroups): they need the columns, so clearing the
 * columns clears them too. */
function columnGroupModel(level: 0 | 1) {
  return computed<RepeatSpec | undefined>({
    get: () => section.value.columnGroups?.[level],
    set: (v) => {
      if (v === section.value.columnGroups?.[level]) return
      const now = section.value.columnGroups ?? []
      // Clearing the outer level clears the inner one too (an inner level needs one over it); the
      // inner one is set aside and comes back when an outer level is chosen again.
      if (level === 0 && !v && now[1]) setAside.innerGroup = now[1]
      const inner = level === 0 && v && !now[0] && setAside.innerGroup ? [setAside.innerGroup] : now.slice(1)
      if (v) delete setAside.innerGroup
      const next = level === 0 ? (v ? [v, ...inner] : []) : v ? [now[0], v] : now.slice(0, 1)
      section.value = withField(section.value, 'columnGroups', next.length && next[0] ? next : undefined)
    },
  })
}
const columnGroupOuter = columnGroupModel(0)
const columnGroupInner = columnGroupModel(1)
/** A yes/no section option (panels, joined): unchecked removes the field. */
function flagModel(key: 'panels' | 'joined' | 'large' | 'roomy') {
  return computed<boolean>({
    get: () => section.value[key] === true,
    set: (on) => {
      if (on === (section.value[key] === true)) return
      section.value = withField(section.value, key, on ? true : undefined)
    },
  })
}
const panelsModel = flagModel('panels')
const joinedModel = flagModel('joined')
const largeModel = flagModel('large')
const roomyModel = flagModel('roomy')

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
    <CardEditorLabel v-if="hasTitle" v-model="titleModel" :has-data="false" :repeat-over="titleRepeatOver" placeholder="Section title" heading="Section title" />

    <CardEditorRepeat v-if="!section.columns" v-model="repeatModel" :allow="['campaigns', 'popups', 'windows', 'readings', 'countries', 'rules', 'assets', 'features', 'steps', 'tips']" label="Repeat this section" />
    <div v-if="section.repeat && section.layout !== 'table'" class="field check">
      <label><input type="checkbox" v-model="panelsModel" /> Panels <span class="hint">— a bordered box per instance, its title and first item on top</span></label>
    </div>
    <div v-if="section.layout === 'lines'" class="field check">
      <label><input type="checkbox" v-model="joinedModel" /> One sentence <span class="hint">— the items a space apart instead of spaced out</span></label>
    </div>
    <div v-if="section.layout === 'lines'" class="field check">
      <label><input type="checkbox" v-model="largeModel" /> Large text <span class="hint">— a lead line, bigger and in the full ink</span></label>
    </div>
    <div v-if="section.layout === 'table'" class="field check">
      <label><input type="checkbox" v-model="roomyModel" /> Roomy rows <span class="hint">— taller rows, the row labels in bold</span></label>
    </div>
    <CardEditorRepeat v-if="section.layout === 'table' && !section.repeat" v-model="columnsModel" :allow="['windows', 'countries', 'campaigns', 'popups', 'assets', 'features', 'tags']" label="Columns (each item becomes a row)" />
    <CardEditorRepeat v-if="section.layout === 'table' && section.repeat && !section.columns" v-model="rowGroupsModel" :allow="['steps', 'campaigns', 'popups', 'windows', 'countries', 'assets']" label="Rows in each group" />
    <template v-if="section.columns">
      <CardEditorRepeat v-model="columnGroupOuter" :allow="['windows', 'countries', 'campaigns', 'popups', 'features']" label="Group the columns by (every column repeats under each group)" />
      <CardEditorRepeat v-if="section.columnGroups?.length" v-model="columnGroupInner" :allow="['windows', 'countries', 'campaigns', 'popups', 'features']" label="Then group them by (a second heading row)" />
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
        :section-repeat-over="section.rowGroups?.over ?? section.repeat?.over"
        :row-groups="!!section.rowGroups"
        :in-table="section.layout === 'table' && !section.columns"
        :section-layout="section.layout"
        :column-table="section.layout === 'table' && !!section.columns"
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
