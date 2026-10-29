<script setup lang="ts">
// One MetricItem editor (ADR 0003 section 4 items 4-5): label / data / display, in the owner's
// order, plus gating and a caption under "More". Collapsed to a one-line plain-language summary
// ("Tagged arrivals · Tagged arrivals (campaign) · Number" — never a raw metric/ratio/field id,
// review fix 2026-09-27) with ↑ ↓ ⧉ ✕ buttons, matching the nested-doughnut ring editor's button
// pattern (ChartEditor.vue) so it works with a keyboard and on touch.
import { computed, ref, useId, watch } from 'vue'
import { MIN_COHORT } from '../../../lib/popupEvents'
import { dataKindOf, dataSummaryLabel, displayAsLabel, firstDisplayFor, isDisplayAllowed, isKnownNote, labelNoteOptions, makeDisplay, notePreview, scopePathLabel, scopePathOptions, withField, withGating } from '../../../lib/metrics/editorModel'
import type { MetricItem, RepeatSpec, WindowName } from '../../../lib/metrics/types'
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
  /** A preset's template shown for reading (CardEditor's preset mode): every control disabled,
   * no reorder/duplicate/remove, but the item still opens so its settings can be read. */
  readonly?: boolean
  /** The section is a row table, no columns (enables the combined-windows column and its trailing label). */
  inTable?: boolean
  /** The section groups its rows (Section.rowGroups): enables "once per group". */
  rowGroups?: boolean
}>()
const emit = defineEmits<{ 'move': [dir: -1 | 1]; duplicate: []; remove: [] }>()
const item = defineModel<MetricItem>({ required: true })

const open = ref(false)
const innermostOver = computed<RepeatSpec['over'] | undefined>(() => item.value.repeat?.over ?? props.sectionRepeatOver ?? props.cardRepeatOver)

const whenUnmeasuredId = useId()
const whenNotStartedId = useId()
const minCohortId = useId()
const whenEmptyId = useId()
const whenEmptyNoteSearchId = useId()
const whenEmptyNoteSelectId = useId()
const captionModeId = useId()
const frameId = useId()

// Auto-correct the display when the data binding changes under it and the new data's kind no
// longer allows it — never leaves an item saveable with an incompatible display (validateCard
// would reject it anyway; this just avoids the interim invalid state showing as a saved error).
// "Allows", not "offers": a stored sparkline keeps its display, series and day list while the
// data stays a kind that can draw one (the form offers it only where it can: see displayOptionsFor).
watch(
  () => item.value.data,
  () => {
    if (!isDisplayAllowed(item.value.data, item.value.display.as)) {
      const next = firstDisplayFor(item.value.data)
      if (next) item.value = { ...item.value, display: makeDisplay(next, item.value.display) }
    }
  },
  { deep: true },
)

// Plain language only — never a raw note/scope-path id (review fix, 2026-09-27).
const summaryLabel = computed(() => {
  const l = item.value.label
  if (typeof l === 'string') return l || '(no label)'
  // Any kind of note, a label entry included (a preset's funnel step names are label notes).
  if ('note' in l) return l.note ? (notePreview(l.note) ?? 'Unknown note') : '(no note chosen)'
  if ('bind' in l) return scopePathLabel(l.bind)
  return "metric's own"
})
const summaryData = computed(() => dataSummaryLabel(item.value.data))
const dataKindLabel = computed(() => dataKindOf(item.value.data) ?? 'unknown')
const hasData = computed(() => !('field' in item.value.data))

// Every setter below ignores a pick of the value already shown, and edits go through
// withGating/withField: a no-op interaction leaves the item exactly as it was (no `gating: {}`,
// no explicit default replacing an absent field or the other way round).
const minCohort = computed<number | undefined>({
  get: () => item.value.gating?.minCohort,
  set: (v) => {
    if ((v || undefined) === item.value.gating?.minCohort) return
    item.value = withGating(item.value, { minCohort: v || undefined })
  },
})
const whenUnmeasured = computed<NonNullable<MetricItem['gating']>['whenUnmeasured']>({
  get: () => item.value.gating?.whenUnmeasured ?? 'auto',
  set: (v) => {
    if (v === whenUnmeasured.value) return
    item.value = withGating(item.value, { whenUnmeasured: v === 'auto' ? undefined : v })
  },
})
const whenNotStarted = computed<'default' | 'label' | 'zero'>({
  get: () => item.value.gating?.whenNotStarted ?? 'default',
  set: (v) => {
    if (v === whenNotStarted.value) return
    item.value = withGating(item.value, { whenNotStarted: v === 'default' ? undefined : v })
  },
})
/** gating.whenZero: a measured count of exactly 0 is left out. */
/** gating.onlyWith: the cell is blank where this bound field is empty. */
const onlyWithId = useId()
const onlyWithOptions = computed(() => scopePathOptions(innermostOver.value))
const onlyWith = computed<string>({
  get: () => item.value.gating?.onlyWith ?? '',
  set: (v) => {
    if ((v || undefined) === item.value.gating?.onlyWith) return
    item.value = withGating(item.value, { onlyWith: v || undefined })
  },
})
/** Table-only: one cell per group (Section.rowGroups), spanning the group's rows. */
const perGroup = computed<boolean>({
  get: () => item.value.perGroup === true,
  set: (v) => {
    if (v === perGroup.value) return
    item.value = withField(item.value, 'perGroup', v ? true : undefined)
  },
})
/** Table-only: one cell shows the value in each of these windows, joined by " · ". */
const WINDOW_CHOICES: { value: WindowName; label: string }[] = [
  { value: 'latestDay', label: 'Latest day' },
  { value: 'previousDay', label: 'Day before' },
  { value: 'page', label: 'Range' },
]
function hasWindow(w: WindowName) {
  return item.value.windows?.includes(w) ?? false
}
function toggleWindow(w: WindowName, on: boolean) {
  if (on === hasWindow(w)) return
  const next = WINDOW_CHOICES.map((c) => c.value).filter((c) => (c === w ? on : hasWindow(c)))
  item.value = withField(item.value, 'windows', next.length ? next : undefined)
  if (!next.length && item.value.after !== undefined) item.value = withField(item.value, 'after', undefined)
}
const whenZeroOmit = computed<boolean>({
  get: () => item.value.gating?.whenZero === 'omit',
  set: (v) => {
    if (v === whenZeroOmit.value) return
    item.value = withGating(item.value, { whenZero: v ? 'omit' : undefined })
  },
})
/** The note a "Show a note" pick had, so switching to dash/omit and back restores it. */
let lastWhenEmptyNote = ''
const whenEmptyKind = computed<'dash' | 'omit' | 'note'>({
  get: () => {
    const e = item.value.gating?.whenEmpty
    return e === 'omit' ? 'omit' : typeof e === 'object' ? 'note' : 'dash'
  },
  set: (v) => {
    if (v === whenEmptyKind.value) return
    const e = item.value.gating?.whenEmpty
    if (typeof e === 'object') lastWhenEmptyNote = e.note
    item.value = withGating(item.value, { whenEmpty: v === 'dash' ? undefined : v === 'omit' ? 'omit' : { note: lastWhenEmptyNote } })
  },
})
const whenEmptyNote = computed<string>({
  get: () => {
    const e = item.value.gating?.whenEmpty
    return typeof e === 'object' ? e.note : ''
  },
  set: (v) => {
    if (v === whenEmptyNote.value) return
    item.value = withGating(item.value, { whenEmpty: { note: v } })
  },
})
// "Show a note" picks from the SAME curated, plain-text-previewed registry list CardEditorLabel
// uses (review fix, 2026-09-27) — never free text, which could hold a note id that doesn't exist
// (validateCard would reject it, but the UI shouldn't offer building an invalid card in the
// first place: the owner's whole point for the ratio picker applies here too).
const whenEmptyNoteSearch = ref('')
const whenEmptyNoteChoices = computed(() => {
  const q = whenEmptyNoteSearch.value.trim().toLowerCase()
  const all = labelNoteOptions(whenEmptyNote.value || undefined)
  return q ? all.filter((o) => o.preview.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : all
})
const whenEmptyNoteInvalid = computed(() => !!whenEmptyNote.value && !isKnownNote(whenEmptyNote.value))
const captionMode = computed<NonNullable<MetricItem['captionMode']>>({
  get: () => item.value.captionMode ?? 'inline',
  set: (v) => {
    if (v === captionMode.value) return
    item.value = withField(item.value, 'captionMode', v === 'inline' ? undefined : v)
  },
})
const frame = computed<'' | NonNullable<MetricItem['frame']>>({
  get: () => item.value.frame ?? '',
  set: (v) => {
    if (v === frame.value) return
    item.value = withField(item.value, 'frame', v || undefined)
  },
})
const itemRepeatModel = computed({
  get: () => item.value.repeat,
  set: (v) => {
    if (v === item.value.repeat) return
    item.value = withField(item.value, 'repeat', v)
  },
})
</script>

<template>
  <li class="ce-item" :class="{ open }">
    <div class="ce-item-head">
      <button type="button" class="ce-item-summary" @click="open = !open" :aria-expanded="open">
        <span class="ce-item-summary-text">{{ summaryLabel }} · {{ summaryData }} · {{ displayAsLabel(item.display.as) }}</span>
        <span v-if="errors.length" class="chip" style="color: #bc4749">{{ errors.length }} error{{ errors.length > 1 ? 's' : '' }}</span>
      </button>
      <span v-if="!readonly" class="ce-item-controls">
        <button type="button" class="icon-btn" title="Move up" :disabled="index === 0" @click="emit('move', -1)">↑</button>
        <button type="button" class="icon-btn" title="Move down" :disabled="index === count - 1" @click="emit('move', 1)">↓</button>
        <button type="button" class="icon-btn" title="Duplicate" @click="emit('duplicate')">⧉</button>
        <button type="button" class="icon-btn danger" title="Remove" @click="emit('remove')">✕</button>
      </span>
    </div>

    <ul v-if="errors.length" class="errors">
      <li v-for="(e, i) in errors" :key="i">{{ e }}</li>
    </ul>

    <fieldset v-if="open" class="ce-item-body ce-fieldset" :disabled="readonly">
      <CardEditorLabel v-model="item.label" :has-data="hasData" :repeat-over="innermostOver" />
      <CardEditorData v-model="item.data" :repeat-over="innermostOver" />
      <CardEditorDisplay v-model="item.display" :binding="item.data" />

      <details class="more">
        <summary>More: gating, repeat, caption, frame ({{ dataKindLabel }})</summary>

        <div class="row">
          <div class="field">
            <label :for="whenUnmeasuredId">When not measured</label>
            <select :id="whenUnmeasuredId" v-model="whenUnmeasured">
              <option value="auto">Auto — omit for a closed campaign, else show a label</option>
              <option value="omit">Always omit</option>
              <option value="label">Always show a label</option>
            </select>
          </div>
          <div class="field">
            <label :for="whenNotStartedId">Before the flight starts</label>
            <select :id="whenNotStartedId" v-model="whenNotStarted">
              <option value="default">Default — omit with no start date, else "not started"</option>
              <option value="label">Always "not started"</option>
              <option value="zero">Show 0</option>
            </select>
          </div>
          <div class="field check">
            <label><input type="checkbox" v-model="whenZeroOmit" /> Leave out a measured 0</label>
          </div>
          <div v-if="onlyWithOptions.length" class="field">
            <label :for="onlyWithId">Blank unless</label>
            <select :id="onlyWithId" v-model="onlyWith">
              <option value="">(always shown)</option>
              <option v-for="o in onlyWithOptions" :key="o.value" :value="o.value">{{ o.label }} is set</option>
            </select>
          </div>
          <div class="field">
            <label :for="minCohortId">Minimum cohort</label>
            <input :id="minCohortId" type="number" :min="MIN_COHORT" :value="minCohort ?? ''" placeholder="(default)" @change="minCohort = ($event.target as HTMLInputElement).valueAsNumber || undefined" />
          </div>
        </div>

        <div class="field">
          <label :for="whenEmptyId">When empty</label>
          <select :id="whenEmptyId" v-model="whenEmptyKind">
            <option value="dash">Show a dash</option>
            <option value="omit">Omit</option>
            <option value="note">Show a note</option>
          </select>
        </div>
        <template v-if="whenEmptyKind === 'note'">
          <label class="visually-hidden" :for="whenEmptyNoteSearchId">Search notes</label>
          <input :id="whenEmptyNoteSearchId" class="search-input" type="text" v-model="whenEmptyNoteSearch" placeholder="Search notes…" />
          <label class="visually-hidden" :for="whenEmptyNoteSelectId">Choose a note</label>
          <select :id="whenEmptyNoteSelectId" v-model="whenEmptyNote" :class="{ invalid: whenEmptyNoteInvalid }">
            <option value="" disabled>Choose a note…</option>
            <option v-for="o in whenEmptyNoteChoices" :key="o.value" :value="o.value">{{ o.preview }}</option>
          </select>
          <p v-if="whenEmptyNoteInvalid" class="hint">This version doesn't know the note "{{ whenEmptyNote }}", so it shows a dash. It stays saved unless you pick another.</p>
        </template>

        <fieldset v-if="inTable" class="field">
          <legend>Table cell</legend>
          <label v-if="rowGroups" class="check"><input type="checkbox" v-model="perGroup" /> Once per group</label>
          <span v-if="hasData" class="check">Values in one cell:
            <label v-for="c in WINDOW_CHOICES" :key="c.value"><input type="checkbox" :checked="hasWindow(c.value)" @change="toggleWindow(c.value, ($event.target as HTMLInputElement).checked)" /> {{ c.label }}</label>
          </span>
          <CardEditorLabel v-if="item.windows" v-model="item.after" :has-data="false" :allow-metric-own="false" :repeat-over="innermostOver" placeholder="Text after the values" heading="After the values" />
        </fieldset>

        <CardEditorRepeat v-model="itemRepeatModel" :allow="['campaigns', 'popups', 'windows', 'readings', 'countries', 'assets']" label="Repeat this item" />

        <CardEditorLabel v-model="item.caption" :has-data="hasData" :repeat-over="innermostOver" :allow-metric-own="false" placeholder="Caption text" heading="Caption" />
        <div class="row">
          <div class="field">
            <label :for="captionModeId">Caption placement</label>
            <select :id="captionModeId" v-model="captionMode">
              <option value="inline">Inline — a line under the value</option>
              <option value="compact">Compact — behind the card's Notes toggle</option>
            </select>
          </div>
          <div class="field">
            <label :for="frameId">Frame override</label>
            <select :id="frameId" v-model="frame">
              <option value="">(section default)</option>
              <option value="row">Row</option>
              <option value="pill">Pill</option>
              <option value="tile">Tile</option>
              <option value="column">Column</option>
            </select>
          </div>
        </div>
      </details>
    </fieldset>
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
