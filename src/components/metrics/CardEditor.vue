<script setup lang="ts">
// The metric-card editor (ADR 0003 slice 6, "Editor UX"): start from a preset or customize one
// into an editable spec, edit card-level fields, sections and items, and preview the result
// live through the real MetricCard. Wired into ChartEditor.vue for a widget with `card` set (a
// "Metric card" chart type) — ChartEditor v-models `draft.card` here and forwards the page's
// filter context; normWidget/normCardRef (lib/defaults.ts) validate whatever gets saved.
//
// Props: `modelValue: CardRef` (required), `context?: MetricsContext` (the page's current
// filters, forwarded to the live preview only — never mutated here). Emits `update:modelValue:
// [CardRef]`.
//
// Validity gate: `update:modelValue` only ever fires a CardRef that `validateCard` accepts (a
// `{ preset }` is valid iff the id resolves; a `{ spec }` iff `validateCard(spec)` returns no
// errors) — every other edit shows its errors inline (grouped by section/item,
// lib/metrics/editorModel.ts groupErrors) and simply doesn't emit, so a caller's `v-model` can
// never receive an invalid card. Live preview always renders the current draft, valid or not, so
// the owner sees a mid-edit state before it's saveable.
//
// MOUNT-TIME EMIT: the validity watcher below runs with `{ immediate: true }`, so if the CardRef
// passed in as `modelValue` is ALREADY valid, `update:modelValue` fires once, synchronously,
// during the component's own setup — before any user interaction. This is intentional (it is
// also what normalizes a `{ preset }` that happens to already resolve, or a `{ spec }` straight
// off a v-model with no edits yet, into the exact same shape a real edit would produce), but a
// caller must treat it as a no-op rather than "the user changed something": ChartEditor.vue's own
// `v-model="draft.card"` simply re-assigns the same (deeply-equal) value, which is harmless, but
// a caller that treats every emit as dirtying an otherwise-clean form should compare against the
// CardRef it started with, not just count emits.
import { computed, onBeforeUnmount, ref, watch, reactive, toRaw, useId } from 'vue'
import MetricCard from './MetricCard.vue'
import CardEditorLabel from './editor/CardEditorLabel.vue'
import CardEditorData from './editor/CardEditorData.vue'
import CardEditorRepeat from './editor/CardEditorRepeat.vue'
import CardEditorSection from './editor/CardEditorSection.vue'
import { presetById } from '../../lib/metrics/presets'
import { validateCard } from '../../lib/metrics/validate'
import { noteLabelOptions } from '../../lib/metrics/editorModel'
import { cloneSpec, emptySection, groupErrors, moveBy, presetOptions, specFromPresetId } from '../../lib/metrics/editorModel'
import type { CardRef, CardSpec, MetricsContext } from '../../lib/metrics/types'

const props = defineProps<{
  modelValue: CardRef
  /** The page's current filter context (range, sites, …) — forwarded to the live preview so it
   * reads the same window a saved card would (a `window: 'page'` item's preview otherwise has no
   * range to ask for). Never mutated here. */
  context?: MetricsContext
}>()
const emit = defineEmits<{ 'update:modelValue': [CardRef] }>()

const PRESET_OPTIONS = presetOptions()

// Every label below is paired with its control via for/id (useId()) — a label that only sits
// beside a <select>/<input> as a visual sibling gives a screen reader no name for that control.
const startFromId = useId()
const captionsId = useId()
const minWidthId = useId()
const showUpdatedId = useId()

type Mode = 'preset' | 'custom'
const mode = ref<Mode>('spec' in props.modelValue ? 'custom' : 'preset')
const presetId = ref<string>('preset' in props.modelValue ? props.modelValue.preset : (PRESET_OPTIONS[0]?.value ?? ''))
/** The preset id `spec` was last copied from, when in custom mode — powers "Reset to preset". */
const customizedFrom = ref<string>(mode.value === 'custom' ? presetId.value : '')

const spec = reactive<CardSpec>(cloneSpec('spec' in props.modelValue ? props.modelValue.spec : specFromPresetId(presetId.value)))
function resetSpecTo(next: CardSpec) {
  for (const k of Object.keys(spec)) delete (spec as Record<string, unknown>)[k]
  Object.assign(spec, next)
}

function customize() {
  if (mode.value === 'custom') return
  resetSpecTo(specFromPresetId(presetId.value))
  customizedFrom.value = presetId.value
  mode.value = 'custom'
}
function resetToPreset() {
  if (!customizedFrom.value) return
  resetSpecTo(specFromPresetId(customizedFrom.value))
}
function useDifferentPreset() {
  mode.value = 'preset'
}

// ── Validity ─────────────────────────────────────────────────────────────────────────────────
// A "Blank card" preset selection ('') has no valid CardRef of its own — it only becomes a real
// card once Customize turns it into an explicit (empty) spec — so it stays an error until then,
// rather than silently emitting `{ preset: '' }` (which resolves to nothing, per presetById).
const presetErrors = computed<string[]>(() => {
  if (!presetId.value) return ['card: choose a preset, or Customize to start from a blank card']
  return presetById(presetId.value) ? [] : [`Unknown preset id "${presetId.value}".`]
})
const errors = computed<string[]>(() => (mode.value === 'preset' ? presetErrors.value : validateCard(spec)))
const grouped = computed(() => groupErrors(errors.value, spec))

// A deep fingerprint of everything that decides the emitted/previewed CardRef — JSON.stringify
// over a reactive tree reads every nested property, so this recomputes on any change anywhere in
// `spec`, without a bespoke deep-watch per field.
const fingerprint = computed(() => JSON.stringify({ mode: mode.value, presetId: presetId.value, spec: mode.value === 'custom' ? spec : null }))

// `spec` is a Vue reactive() proxy — structuredClone (cloneSpec) can't clone a Proxy directly in
// every environment (happy-dom's polyfill throws DataCloneError on one), so every clone of it
// goes through toRaw() first, which unwraps to the plain underlying tree Vue never actually
// mutates in place (nested reactive proxies are a lazy, cached VIEW over it, never written back).
function currentCardRef(): CardRef {
  return mode.value === 'preset' ? { preset: presetId.value } : { spec: cloneSpec(toRaw(spec)) }
}

watch(
  fingerprint,
  () => {
    if (errors.value.length) return
    emit('update:modelValue', currentCardRef())
  },
  { immediate: true },
)

// ── Live preview — debounced 300ms (ADR section 4 item 6), always shows the CURRENT draft
// whether or not it currently validates, so an in-progress edit is visible before it's saveable.
const previewCardRef = ref<CardRef>(currentCardRef())
let previewTimer: ReturnType<typeof setTimeout> | null = null
watch(
  fingerprint,
  () => {
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = setTimeout(() => {
      previewCardRef.value = currentCardRef()
    }, 300)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer)
})

// ── Card-level fields ────────────────────────────────────────────────────────────────────────
const titleModel = computed({
  get: () => spec.title,
  set: (v) => {
    spec.title = v
  },
})
const hasTitle = computed(() => spec.title !== undefined)
function toggleTitle(on: boolean) {
  spec.title = on ? '' : undefined
}
const repeatModel = computed({
  get: () => spec.repeat,
  set: (v) => {
    spec.repeat = v
  },
})
const hasBadge = computed(() => !!spec.badge)
function toggleBadge(on: boolean) {
  spec.badge = on ? { data: { field: 'campaign.statusToday' }, display: { as: 'badge' } } : undefined
}
const badgeDataModel = computed({
  get: () => spec.badge?.data ?? { field: 'campaign.statusToday' },
  set: (v) => {
    if (spec.badge && 'field' in v) spec.badge.data = v
  },
})
const NOTE_OPTIONS = noteLabelOptions()
const captionsValue = computed<string[]>({
  get: () => spec.captions ?? [],
  set: (v) => {
    spec.captions = v.length ? v : undefined
  },
})
function toggleCaption(id: string, checked: boolean) {
  const set = new Set(captionsValue.value)
  if (checked) set.add(id)
  else set.delete(id)
  captionsValue.value = NOTE_OPTIONS.map((o) => o.value).filter((v) => set.has(v))
}
const linkValue = computed<boolean>({
  get: () => spec.link === 'campaigns-page',
  set: (v) => {
    spec.link = v ? 'campaigns-page' : undefined
  },
})
const minWidthValue = computed<number | undefined>({
  get: () => spec.minWidth,
  set: (v) => {
    spec.minWidth = v || undefined
  },
})
const showUpdatedValue = computed<'' | 'header' | 'footer'>({
  get: () => (spec.showUpdated === true ? 'header' : spec.showUpdated || ''),
  set: (v) => {
    spec.showUpdated = v || undefined
  },
})

// ── Sections ─────────────────────────────────────────────────────────────────────────────────
function addSection() {
  spec.sections.push(emptySection())
}
function moveSection(i: number, dir: -1 | 1) {
  spec.sections = moveBy(spec.sections, i, dir)
}
function removeSection(i: number) {
  spec.sections.splice(i, 1)
}
</script>

<template>
  <div class="ce-root">
    <div class="ce-columns">
      <div class="ce-controls">
        <h2>Card</h2>

        <div class="field" v-if="mode === 'preset'">
          <label :for="startFromId">Start from</label>
          <select :id="startFromId" v-model="presetId">
            <option value="">Blank card</option>
            <option v-for="p in PRESET_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
          <button type="button" class="btn" @click="customize">Customize…</button>
        </div>
        <div class="field" v-else>
          <p class="hint">Customized{{ customizedFrom ? ` from "${customizedFrom}"` : '' }}.</p>
          <div class="row">
            <button v-if="customizedFrom" type="button" class="btn" @click="resetToPreset">Reset to preset</button>
            <button type="button" class="btn" @click="useDifferentPreset">Use a preset instead</button>
          </div>
        </div>

        <ul v-if="grouped.cardErrors.length" class="errors">
          <li v-for="(e, i) in grouped.cardErrors" :key="i">{{ e }}</li>
        </ul>

        <template v-if="mode === 'custom'">
          <div class="field check">
            <label><input type="checkbox" :checked="hasTitle" @change="toggleTitle(($event.target as HTMLInputElement).checked)" /> Card title</label>
          </div>
          <CardEditorLabel v-if="hasTitle" v-model="titleModel" :has-data="false" :repeat-over="spec.repeat?.over" placeholder="Card title" heading="Card title" />

          <CardEditorRepeat v-model="repeatModel" :allow="['campaigns', 'popups']" />

          <div class="field check">
            <label><input type="checkbox" :checked="hasBadge" @change="toggleBadge(($event.target as HTMLInputElement).checked)" /> Badge</label>
          </div>
          <CardEditorData v-if="hasBadge" v-model="badgeDataModel" :repeat-over="spec.repeat?.over" field-only />

          <div class="field">
            <label :id="captionsId">Captions <span class="hint">— note ids shown under the whole card</span></label>
            <div class="campaign-list" role="group" :aria-labelledby="captionsId">
              <label v-for="o in NOTE_OPTIONS" :key="o.value" class="campaign-row">
                <input type="checkbox" :checked="captionsValue.includes(o.value)" @change="toggleCaption(o.value, ($event.target as HTMLInputElement).checked)" />
                {{ o.preview }}
              </label>
            </div>
          </div>

          <div class="row">
            <div class="field check">
              <label><input type="checkbox" v-model="linkValue" /> Click through to the Campaigns page</label>
            </div>
            <div class="field">
              <label :for="minWidthId">Minimum width (px)</label>
              <input :id="minWidthId" type="number" min="120" :value="minWidthValue ?? ''" placeholder="230" @change="minWidthValue = ($event.target as HTMLInputElement).valueAsNumber" />
            </div>
          </div>
          <div class="field">
            <label :for="showUpdatedId">"Updated Xs ago"</label>
            <select :id="showUpdatedId" v-model="showUpdatedValue">
              <option value="">Off</option>
              <option value="header">Header</option>
              <option value="footer">Footer</option>
            </select>
          </div>

          <h3>Sections</h3>
          <CardEditorSection
            v-for="(section, si) in spec.sections"
            :key="si"
            :model-value="section"
            @update:model-value="(v) => (spec.sections[si] = v)"
            :card-repeat-over="spec.repeat?.over"
            :index="si"
            :count="spec.sections.length"
            :section-errors="grouped.sectionErrors[si] ?? []"
            :item-errors="grouped.itemErrors[si] ?? {}"
            @move="(dir) => moveSection(si, dir)"
            @remove="removeSection(si)"
          />
          <button type="button" class="btn" @click="addSection">+ Add section</button>
        </template>
      </div>

      <div class="ce-preview">
        <h3>Preview</h3>
        <MetricCard :card-ref="previewCardRef" :context="context" />
      </div>
    </div>
  </div>
</template>

<style scoped src="./editor/editor.css"></style>
<style scoped>
.ce-root {
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 16px;
  padding: 20px 22px;
  max-width: 900px;
  max-height: 90vh;
  overflow-y: auto;
}
.ce-columns {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}
.ce-controls {
  flex: 1 1 480px;
  min-width: 0;
}
.ce-preview {
  flex: 1 1 260px;
  min-width: 230px;
  position: sticky;
  top: 0;
}
.ce-preview h3 {
  margin-bottom: 10px;
}
h2 {
  font-size: 18px;
  margin-bottom: 14px;
}
h3 {
  font-size: 14px;
  margin: 16px 0 8px;
}

/* "works at 375px as a full-screen sheet" (ADR 0003 section 4): edge-to-edge, stacked, scrolls
   as one column — matches the app's own mobile breakpoint (lib/responsive.ts MOBILE_MAX_WIDTH). */
@media (max-width: 700px) {
  .ce-root {
    max-width: none;
    max-height: none;
    min-height: 100%;
    border-radius: 0;
    border: none;
    padding: 16px 14px 24px;
  }
  .ce-columns {
    flex-direction: column;
  }
  .ce-preview {
    position: static;
    width: 100%;
  }
}
</style>
