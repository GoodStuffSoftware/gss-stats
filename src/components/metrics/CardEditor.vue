<script setup lang="ts">
// The metric-card editor (ADR 0003 slice 6, "Editor UX"): start from a preset or customize one
// into an editable spec, edit card-level fields, sections and items, and preview the result
// live through the real MetricCard. Wired into ChartEditor.vue for a widget with `card` set (a
// "Metric card" chart type) — ChartEditor v-models `draft.card` here and forwards the page's
// filter context; normWidget/normCardRef (lib/defaults.ts) validate whatever gets saved.
//
// Props: `modelValue: CardRef` (required), `context?: MetricsContext` (the page's current
// filters, forwarded to the live preview only — never mutated here). Emits `update:modelValue:
// [CardRef]` and `errors: [string[]]`.
//
// Validity gate: `update:modelValue` only ever fires a CardRef that `validateCard` accepts (a
// `{ preset }` is valid iff the id resolves; a `{ spec }` iff `validateCard(spec)` returns no
// errors) — every other edit shows its errors inline (grouped by section/item,
// lib/metrics/editorModel.ts groupErrors) and simply doesn't emit, so a caller's `v-model` can
// never receive an invalid card. Live preview always renders the current draft, valid or not, so
// the owner sees a mid-edit state before it's saveable.
//
// `errors` (review fix, 2026-09-27) fires immediately and on every validity change, with the
// SAME array `update:modelValue`'s own gate checks — `[]` means the current draft is saveable.
// A host that wraps this in its own form (ChartEditor.vue) listens to disable its own Save
// button and say why while errors are non-empty, since a caller has no other way to learn
// "invalid" from a component whose whole contract is "never emit an invalid value".
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
import { BADGE_TONE_OPTIONS, CARD_ACTION_OPTIONS, cloneSpec, emptySection, groupErrors, moveBy, presetOptions, rowsToTones, specFromPresetId, specsEqual, toneValueProblem, tonesToRows, withField, type BadgeTone, type ToneRow } from '../../lib/metrics/editorModel'
import type { CardAction, CardRef, CardSpec, Label, MetricsContext } from '../../lib/metrics/types'

const props = defineProps<{
  modelValue: CardRef
  /** The page's current filter context (range, sites, …) — forwarded to the live preview so it
   * reads the same window a saved card would (a `window: 'page'` item's preview otherwise has no
   * range to ask for). Never mutated here. */
  context?: MetricsContext
  /** The widget's campaign selection, so the preview shows the campaigns a saved card would. */
  campaignIds?: string[]
}>()
// `errors` fires whenever the current draft's validity changes (immediate, so a caller has the
// answer synchronously from mount) — how a host like ChartEditor.vue knows to disable its own
// Save button and say why, since `update:modelValue` alone never reports an invalid state (it
// simply doesn't fire — see the doc block above). Always the SAME array validateCard would
// produce; `[]` means the current draft is saveable.
const emit = defineEmits<{ 'update:modelValue': [CardRef]; errors: [string[]] }>()

const PRESET_OPTIONS = presetOptions()
/** The preset's plain name — never its raw id (review fix, 2026-09-27) — for "Customized from
 * […]" and anywhere else a chosen preset needs to be named back to the owner. Falls back to the
 * id only for a preset that has gone missing from the registry entirely (an editing widget's
 * saved preset was removed), which is already a degraded state worth surfacing plainly. */
function presetLabel(id: string): string {
  return PRESET_OPTIONS.find((p) => p.value === id)?.label ?? id
}

// Every label below is paired with its control via for/id (useId()) — a label that only sits
// beside a <select>/<input> as a visual sibling gives a screen reader no name for that control.
const startFromId = useId()
const captionsId = useId()
const minWidthId = useId()
const showUpdatedId = useId()

type Mode = 'preset' | 'custom'
const mode = ref<Mode>('spec' in props.modelValue ? 'custom' : 'preset')

// Review fix, 2026-09-27 (MUST-FIX — a data-loss bug): a `{ spec }` CardRef carries an optional
// `from` (the preset it was customized from — see types.ts's own doc comment). This used to be
// missing entirely, so a saved custom card's "Reset to preset" defaulted to PRESET_OPTIONS[0] —
// an ARBITRARY preset, not necessarily the one the card was ever related to — silently replacing
// the card's rows with a different preset's. `from` is re-validated here regardless of whether
// the caller already normalized it (lib/metrics/validate.ts normCardRef does, on load, but
// CardEditor's own contract shouldn't depend on a specific caller having done that): only a
// `from` that still resolves to a real preset is trusted, exactly like normCardRef's own rule.
const initialFrom = 'spec' in props.modelValue && props.modelValue.from && presetById(props.modelValue.from) ? props.modelValue.from : ''
const presetId = ref<string>('preset' in props.modelValue ? props.modelValue.preset : initialFrom)
/** The preset id `spec` was copied from, when known — powers "Customized from …" and "Reset to
 * preset" (both shown only when this is non-empty; see the template). Empty for a legacy/
 * hand-edited custom card whose `from` never survived normalization — that state is never
 * guessed at, only left honest. */
const customizedFrom = ref<string>(mode.value === 'custom' ? initialFrom : '')

// Read once, at setup: a host that swaps which card is being edited remounts this component
// (App.vue keys ChartEditor on the widget id), so there is no stale-prop watcher to keep in sync.
const spec = reactive<CardSpec>(cloneSpec('spec' in props.modelValue ? props.modelValue.spec : specFromPresetId(presetId.value)))
/** Bumped whenever `spec` is replaced wholesale, so the section/item editors remount instead of
 * carrying their remembered per-field state (a badge or title switched off, a repeat kind's
 * filters) over to a different template. */
const specKey = ref(0)
// The title and badge as they were when last switched off (see toggleTitle / toggleBadge below).
let lastTitle: Label | undefined
let lastBadge: NonNullable<CardSpec['badge']> | null = null
function resetSpecTo(next: CardSpec) {
  for (const k of Object.keys(spec)) delete (spec as Record<string, unknown>)[k]
  Object.assign(spec, next)
  lastBadge = null
  lastTitle = undefined
  toneDrafts.value = {}
  specKey.value += 1
}

function customize() {
  if (mode.value === 'custom') return
  resetSpecTo(specFromPresetId(presetId.value))
  customizedFrom.value = presetId.value
  mode.value = 'custom'
}
/** Replaces every edit with the preset's own rows — a real (and, before this fix, sometimes
 * WRONG) data-loss risk, so it asks first. `window.confirm` rather than a second custom dialog:
 * simplest thing that's actually modal and keyboard-dismissable (Esc = cancel) for free. */
function resetToPreset() {
  if (!customizedFrom.value) return
  const label = presetLabel(customizedFrom.value)
  if (!window.confirm(`Replace your changes with the ${label} preset?`)) return
  resetSpecTo(specFromPresetId(customizedFrom.value))
}
/** Leaves the editable copy for the preset picker. Edits made since Customize are in-session
 * only (Cancel still protects the stored card) but are discarded here, so it asks first —
 * `confirm`, like Reset to preset above and the app's other destructive prompts — whenever the
 * spec differs from the preset it was copied from (or has no known preset to compare with). */
function useDifferentPreset() {
  if (mode.value === 'custom') {
    const from = customizedFrom.value
    const untouched = !!from && specsEqual(toRaw(spec), specFromPresetId(from))
    if (!untouched && !window.confirm(from ? `Discard your changes to the ${presetLabel(from)} card and pick a preset instead?` : 'Discard this custom card and pick a preset instead?')) return
  }
  mode.value = 'preset'
  if (customizedFrom.value) presetId.value = customizedFrom.value
  resetSpecTo(specFromPresetId(presetId.value))
}
// In preset mode the form shows the chosen preset's own settings, read-only (a `{ preset }` card
// is never edited in place — Customize… copies it into a `{ spec, from }` first).
watch(presetId, (id) => {
  if (mode.value === 'preset') resetSpecTo(specFromPresetId(id))
})
const selectedPresetDescription = computed(() => PRESET_OPTIONS.find((p) => p.value === presetId.value)?.description ?? '')

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
watch(errors, (e) => emit('errors', e), { immediate: true })

// A deep fingerprint of everything that decides the emitted/previewed CardRef — JSON.stringify
// over a reactive tree reads every nested property, so this recomputes on any change anywhere in
// `spec`, without a bespoke deep-watch per field.
const fingerprint = computed(() => JSON.stringify({ mode: mode.value, presetId: presetId.value, customizedFrom: customizedFrom.value, spec: mode.value === 'custom' ? spec : null }))

// `spec` is a Vue reactive() proxy — structuredClone (cloneSpec) can't clone a Proxy directly in
// every environment (happy-dom's polyfill throws DataCloneError on one), so every clone of it
// goes through toRaw() first, which unwraps to the plain underlying tree Vue never actually
// mutates in place (nested reactive proxies are a lazy, cached VIEW over it, never written back).
function currentCardRef(): CardRef {
  if (mode.value === 'preset') return { preset: presetId.value }
  const specCopy = cloneSpec(toRaw(spec))
  // `from` rides along only when known — never a guess (the bug this whole change fixes).
  return customizedFrom.value ? { spec: specCopy, from: customizedFrom.value } : { spec: specCopy }
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
// Switching the title or badge off remembers it, so switching it back on restores the
// template's own (a bound campaign name; the badge's field AND its colours) instead of a blank.
const hasTitle = computed(() => spec.title !== undefined)
function toggleTitle(on: boolean) {
  if (on === hasTitle.value) return
  if (!on) lastTitle = spec.title
  if (on) spec.title = lastTitle ?? ''
  else delete spec.title
}
const repeatModel = computed({
  get: () => spec.repeat,
  set: (v) => {
    if (v === spec.repeat) return
    if (v) spec.repeat = v
    else delete spec.repeat
  },
})
const hasBadge = computed(() => !!spec.badge)
function toggleBadge(on: boolean) {
  if (on === hasBadge.value) return
  toneDrafts.value = {}
  if (on) spec.badge = lastBadge ?? { data: { field: 'campaign.statusToday' }, display: { as: 'badge' } }
  else {
    lastBadge = JSON.parse(JSON.stringify(spec.badge)) as NonNullable<CardSpec['badge']>
    delete spec.badge
  }
}
const badgeDataModel = computed({
  get: () => spec.badge?.data ?? { field: 'campaign.statusToday' },
  set: (v) => {
    if (spec.badge && 'field' in v) spec.badge.data = v
  },
})
// Badge colours (display.tones): which badge text reads as live (green) or a warning.
const toneRows = computed<ToneRow[]>(() => tonesToRows(spec.badge?.display.tones))
function setToneRows(rows: ToneRow[]) {
  if (!spec.badge) return
  spec.badge.display = withField(spec.badge.display, 'tones', rowsToTones(rows))
}
// A badge text that cannot be stored (empty, or another row's) is not written: the row keeps what
// was typed and says why, until it is changed to something valid or the row is removed.
const toneDrafts = ref<Record<number, { value: string; problem: string }>>({})
function setToneRow(i: number, patch: Partial<ToneRow>) {
  if (patch.value !== undefined) {
    const problem = toneValueProblem(toneRows.value, i, patch.value)
    if (problem) {
      toneDrafts.value = { ...toneDrafts.value, [i]: { value: patch.value, problem } }
      return
    }
    const rest = { ...toneDrafts.value }
    delete rest[i]
    toneDrafts.value = rest
  }
  const rows = toneRows.value.map((r, j) => (j === i ? { ...r, ...patch } : r))
  if (JSON.stringify(rows) !== JSON.stringify(toneRows.value)) setToneRows(rows)
}
function addToneRow() {
  toneDrafts.value = {}
  // A fresh row needs a value no other row has (the map is keyed by it).
  let value = 'new value'
  for (let n = 2; toneRows.value.some((r) => r.value === value); n++) value = `new value ${n}`
  setToneRows([...toneRows.value, { value, tone: 'live' }])
}
function removeToneRow(i: number) {
  toneDrafts.value = {}
  setToneRows(toneRows.value.filter((_, j) => j !== i))
}
// Card actions (CardSpec.actions): controls in the card's status row.
function hasAction(a: CardAction): boolean {
  return !!spec.actions?.includes(a)
}
function toggleAction(a: CardAction, on: boolean) {
  if (on === hasAction(a)) return
  const set = new Set(spec.actions ?? [])
  if (on) set.add(a)
  else set.delete(a)
  const next = CARD_ACTION_OPTIONS.map((o) => o.value).filter((v) => set.has(v))
  if (next.length) spec.actions = next
  else delete spec.actions
}
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
    if (v === linkValue.value) return
    if (v) spec.link = 'campaigns-page'
    else delete spec.link
  },
})
const minWidthValue = computed<number | undefined>({
  get: () => spec.minWidth,
  set: (v) => {
    if ((v || undefined) === spec.minWidth) return
    if (v) spec.minWidth = v
    else delete spec.minWidth
  },
})
const showUpdatedValue = computed<'' | 'header' | 'footer'>({
  get: () => (spec.showUpdated === true ? 'header' : spec.showUpdated || ''),
  set: (v) => {
    if (v === showUpdatedValue.value) return
    if (v) spec.showUpdated = v
    else delete spec.showUpdated
  },
})
const TONE_OPTIONS = BADGE_TONE_OPTIONS
const tonesGroupId = useId()
const actionsGroupId = useId()
function toneOf(e: Event): BadgeTone {
  return (e.target as HTMLSelectElement).value as BadgeTone
}

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
          <p v-if="selectedPresetDescription" class="hint">{{ selectedPresetDescription }}</p>
          <button type="button" class="btn" @click="customize">Customize…</button>
        </div>
        <div class="field" v-else>
          <p class="hint">Customized{{ customizedFrom ? ` from "${presetLabel(customizedFrom)}"` : '' }}.</p>
          <div class="row">
            <button v-if="customizedFrom" type="button" class="btn" @click="resetToPreset">Reset to preset</button>
            <button type="button" class="btn" @click="useDifferentPreset">Use a preset instead</button>
          </div>
        </div>

        <ul v-if="grouped.cardErrors.length" class="errors">
          <li v-for="(e, i) in grouped.cardErrors" :key="i">{{ e }}</li>
        </ul>

        <p v-if="mode === 'preset' && presetId" class="hint ce-readonly-hint">The preset's settings, for reading. Customize… to edit a copy of them.</p>
        <fieldset v-if="mode === 'custom' || presetId" :key="`meta-${specKey}`" class="ce-fieldset" :disabled="mode === 'preset'">
          <div class="field check">
            <label><input type="checkbox" :checked="hasTitle" @change="toggleTitle(($event.target as HTMLInputElement).checked)" /> Card title</label>
          </div>
          <CardEditorLabel v-if="hasTitle" v-model="titleModel" :has-data="false" :repeat-over="spec.repeat?.over" placeholder="Card title" heading="Card title" />

          <CardEditorRepeat v-model="repeatModel" :allow="['campaigns', 'popups']" />

          <div class="field check">
            <label><input type="checkbox" :checked="hasBadge" @change="toggleBadge(($event.target as HTMLInputElement).checked)" /> Badge</label>
          </div>
          <template v-if="hasBadge && spec.badge">
            <CardEditorData v-model="badgeDataModel" :repeat-over="spec.repeat?.over" field-only />
            <div class="field" role="group" :aria-labelledby="tonesGroupId">
              <label :id="tonesGroupId">Badge colours <span class="hint">— by the badge's text; anything else is neutral</span></label>
              <div v-for="(r, i) in toneRows" :key="i" class="row">
                <div class="field">
                  <label :for="`${tonesGroupId}-v${i}`">Badge text</label>
                  <input :id="`${tonesGroupId}-v${i}`" type="text" :value="toneDrafts[i]?.value ?? r.value" maxlength="60" :aria-invalid="!!toneDrafts[i]" :aria-describedby="toneDrafts[i] ? `${tonesGroupId}-e${i}` : undefined" @change="setToneRow(i, { value: ($event.target as HTMLInputElement).value })" />
                  <p v-if="toneDrafts[i]" :id="`${tonesGroupId}-e${i}`" class="hint tone-problem" role="alert">{{ toneDrafts[i].problem }}</p>
                </div>
                <div class="field">
                  <label :for="`${tonesGroupId}-t${i}`">Colour</label>
                  <select :id="`${tonesGroupId}-t${i}`" :value="r.tone" @change="setToneRow(i, { tone: toneOf($event) })">
                    <option v-for="o in TONE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                </div>
                <button type="button" class="icon-btn danger" :title="'Remove the colour for ' + r.value" @click="removeToneRow(i)">✕</button>
              </div>
              <button type="button" class="btn" @click="addToneRow">+ Add a colour</button>
            </div>
          </template>

          <div class="field">
            <label :id="captionsId">Captions <span class="hint">— notes shown under the whole card</span></label>
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
          <div class="field" role="group" :aria-labelledby="actionsGroupId">
            <label :id="actionsGroupId">Card controls</label>
            <label v-for="o in CARD_ACTION_OPTIONS" :key="o.value" class="campaign-row">
              <input type="checkbox" :checked="hasAction(o.value)" @change="toggleAction(o.value, ($event.target as HTMLInputElement).checked)" />
              {{ o.label }}
            </label>
          </div>
          <div class="field">
            <label :for="showUpdatedId">"Updated Xs ago"</label>
            <select :id="showUpdatedId" v-model="showUpdatedValue">
              <option value="">Off</option>
              <option value="header">Header</option>
              <option value="footer">Footer</option>
            </select>
          </div>
        </fieldset>

        <!-- Outside the card-level fieldset: in preset mode each section disables its own
             controls but its items still open (a disabled fieldset would disable their toggles). -->
        <div v-if="mode === 'custom' || presetId" :key="`sections-${specKey}`">
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
            :readonly="mode === 'preset'"
            @move="(dir) => moveSection(si, dir)"
            @remove="removeSection(si)"
          />
          <button v-if="mode === 'custom'" type="button" class="btn" @click="addSection">+ Add section</button>
        </div>
      </div>

      <div class="ce-preview">
        <h3>Preview</h3>
        <MetricCard :card-ref="previewCardRef" :context="context" :campaign-ids="campaignIds" />
      </div>
    </div>
  </div>
</template>

<style scoped src="./editor/editor.css"></style>
<style scoped>
.tone-problem {
  color: #bc4749;
  margin: 4px 0 0;
}
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
    align-items: stretch;
  }
  /* flex-basis is a HEIGHT once the axis flips to column (review fix, 2026-09-27): the desktop
     values above (480px / 260px, meant as column WIDTHS) were reserving that much vertical
     space for each stacked block regardless of its actual content — a large empty gap between a
     short "Start from" state and the Preview heading below it. `flex: none` sizes each block to
     its own content instead. */
  .ce-controls,
  .ce-preview {
    flex: none;
  }
  .ce-preview {
    position: static;
    width: 100%;
  }
}
</style>
