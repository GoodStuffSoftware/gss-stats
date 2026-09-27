<script setup lang="ts">
// One MetricItem editor (ADR 0003 section 4 items 4-5): label / data / display, in the owner's
// order, plus gating and a caption under "More". Collapsed to a one-line summary
// ("Tagged arrivals · campaign.taggedArrivals · number") with ↑ ↓ ⧉ ✕ buttons, matching the
// nested-doughnut ring editor's button pattern (ChartEditor.vue) so it works with a keyboard and
// on touch.
import { computed, ref, watch } from 'vue'
import { MIN_COHORT } from '../../../lib/popupEvents'
import { dataKindOf, firstDisplayFor, isDisplaySelectable } from '../../../lib/metrics/editorModel'
import type { MetricItem, RepeatSpec } from '../../../lib/metrics/types'
import CardEditorData from './CardEditorData.vue'
import CardEditorDisplay from './CardEditorDisplay.vue'
import CardEditorLabel from './CardEditorLabel.vue'
import CardEditorRepeat from './CardEditorRepeat.vue'

const props = defineProps<{
  cardRepeatOver?: RepeatSpec['over']
  sectionRepeatOver?: RepeatSpec['over']
  index: number
  count: number
  errors: string[]
}>()
const emit = defineEmits<{ 'move': [dir: -1 | 1]; duplicate: []; remove: [] }>()
const item = defineModel<MetricItem>({ required: true })

const open = ref(false)
const innermostOver = computed<RepeatSpec['over'] | undefined>(() => item.value.repeat?.over ?? props.sectionRepeatOver ?? props.cardRepeatOver)

// Auto-correct the display when the data binding changes under it and the current display is no
// longer offered — never leaves an item saveable with an incompatible display (validateCard
// would reject it anyway; this just avoids the interim invalid state showing as a saved error).
watch(
  () => item.value.data,
  () => {
    if (!isDisplaySelectable(item.value.data, item.value.display.as)) {
      const next = firstDisplayFor(item.value.data)
      if (next) item.value = { ...item.value, display: { as: next } }
    }
  },
  { deep: true },
)

const summaryLabel = computed(() => {
  const l = item.value.label
  if (typeof l === 'string') return l || '(no label)'
  if ('note' in l) return `note: ${l.note || '…'}`
  if ('bind' in l) return `{${l.bind}}`
  return "metric's own"
})
const summaryData = computed(() => {
  const d = item.value.data
  if ('field' in d) return d.field
  if ('metric' in d) return d.metric
  return d.ratio
})
const dataKindLabel = computed(() => dataKindOf(item.value.data) ?? 'unknown')
const hasData = computed(() => !('field' in item.value.data))

const minCohort = computed<number | undefined>({
  get: () => item.value.gating?.minCohort,
  set: (v) => {
    item.value = { ...item.value, gating: { ...item.value.gating, minCohort: v || undefined } }
  },
})
const whenUnmeasured = computed<NonNullable<MetricItem['gating']>['whenUnmeasured']>({
  get: () => item.value.gating?.whenUnmeasured ?? 'auto',
  set: (v) => {
    item.value = { ...item.value, gating: { ...item.value.gating, whenUnmeasured: v === 'auto' ? undefined : v } }
  },
})
const whenEmptyKind = computed<'dash' | 'omit' | 'note'>({
  get: () => {
    const e = item.value.gating?.whenEmpty
    return e === 'omit' ? 'omit' : typeof e === 'object' ? 'note' : 'dash'
  },
  set: (v) => {
    const gating = { ...item.value.gating }
    if (v === 'dash') delete gating.whenEmpty
    else if (v === 'omit') gating.whenEmpty = 'omit'
    else gating.whenEmpty = { note: '' }
    item.value = { ...item.value, gating }
  },
})
const whenEmptyNote = computed<string>({
  get: () => {
    const e = item.value.gating?.whenEmpty
    return typeof e === 'object' ? e.note : ''
  },
  set: (v) => {
    item.value = { ...item.value, gating: { ...item.value.gating, whenEmpty: { note: v } } }
  },
})
const captionMode = computed<NonNullable<MetricItem['captionMode']>>({
  get: () => item.value.captionMode ?? 'inline',
  set: (v) => {
    item.value = { ...item.value, captionMode: v === 'inline' ? undefined : v }
  },
})
const frame = computed<'' | NonNullable<MetricItem['frame']>>({
  get: () => item.value.frame ?? '',
  set: (v) => {
    item.value = { ...item.value, frame: v || undefined }
  },
})
const itemRepeatModel = computed({
  get: () => item.value.repeat,
  set: (v) => {
    item.value = { ...item.value, repeat: v }
  },
})
</script>

<template>
  <li class="ce-item" :class="{ open }">
    <div class="ce-item-head">
      <button type="button" class="ce-item-summary" @click="open = !open" :aria-expanded="open">
        <span class="ce-item-summary-text">{{ summaryLabel }} · {{ summaryData }} · {{ item.display.as }}</span>
        <span v-if="errors.length" class="chip" style="color: #bc4749">{{ errors.length }} error{{ errors.length > 1 ? 's' : '' }}</span>
      </button>
      <span class="ce-item-controls">
        <button type="button" class="icon-btn" title="Move up" :disabled="index === 0" @click="emit('move', -1)">↑</button>
        <button type="button" class="icon-btn" title="Move down" :disabled="index === count - 1" @click="emit('move', 1)">↓</button>
        <button type="button" class="icon-btn" title="Duplicate" @click="emit('duplicate')">⧉</button>
        <button type="button" class="icon-btn danger" title="Remove" @click="emit('remove')">✕</button>
      </span>
    </div>

    <ul v-if="errors.length" class="errors">
      <li v-for="(e, i) in errors" :key="i">{{ e }}</li>
    </ul>

    <div v-if="open" class="ce-item-body">
      <CardEditorLabel v-model="item.label" :has-data="hasData" :repeat-over="innermostOver" />
      <CardEditorData v-model="item.data" :repeat-over="innermostOver" />
      <CardEditorDisplay v-model="item.display" :binding="item.data" />

      <details class="more">
        <summary>More: gating, repeat, caption, frame ({{ dataKindLabel }})</summary>

        <div class="row">
          <div class="field">
            <label>When not measured</label>
            <select v-model="whenUnmeasured">
              <option value="auto">Auto — omit for a closed campaign, else show a label</option>
              <option value="omit">Always omit</option>
              <option value="label">Always show a label</option>
            </select>
          </div>
          <div class="field">
            <label>Minimum cohort</label>
            <input type="number" :min="MIN_COHORT" :value="minCohort ?? ''" placeholder="(default)" @change="minCohort = ($event.target as HTMLInputElement).valueAsNumber || undefined" />
          </div>
        </div>

        <div class="field">
          <label>When empty</label>
          <select v-model="whenEmptyKind">
            <option value="dash">Show a dash</option>
            <option value="omit">Omit</option>
            <option value="note">Show a note</option>
          </select>
          <input v-if="whenEmptyKind === 'note'" type="text" v-model="whenEmptyNote" placeholder="Note id, e.g. flight-pending" />
        </div>

        <CardEditorRepeat v-model="itemRepeatModel" :allow="['campaigns', 'popups', 'windows', 'readings']" label="Repeat this item" />

        <CardEditorLabel v-model="item.caption" :has-data="hasData" :repeat-over="innermostOver" :allow-metric-own="false" placeholder="Caption text" />
        <div class="row">
          <div class="field">
            <label>Caption placement</label>
            <select v-model="captionMode">
              <option value="inline">Inline — a line under the value</option>
              <option value="compact">Compact — behind the card's Notes toggle</option>
            </select>
          </div>
          <div class="field">
            <label>Frame override</label>
            <select v-model="frame">
              <option value="">(section default)</option>
              <option value="row">Row</option>
              <option value="pill">Pill</option>
              <option value="tile">Tile</option>
            </select>
          </div>
        </div>
      </details>
    </div>
  </li>
</template>

<style scoped src="./editor.css"></style>
<style scoped>
.ce-item {
  border: 1px solid rgb(var(--line));
  border-radius: 10px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: rgb(var(--surface));
}
.ce-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ce-item-summary {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  padding: 4px 2px;
  text-align: left;
  font-size: 12.5px;
  cursor: pointer;
}
.ce-item-summary-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ce-item-controls {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.ce-item-body {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgb(var(--line));
}
</style>
