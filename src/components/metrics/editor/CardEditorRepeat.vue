<script setup lang="ts">
// One RepeatSpec editor, reused at card/section/item level (ADR 0003 section 4, "Repeat").
// Card-level repeat only ever offers campaigns/popups (the owner's "one per campaign, or one
// per pop-up"); a section/item repeat may also use windows/readings/countries, per the type.
//
// Nothing a template set is lost to a click: re-picking the current kind is a no-op, switching
// kind keeps `empty` (editorModel withRepeatOver), and each kind's own filters (ids, status,
// tracked, flighting today) are remembered for the life of the editor, so switching away and
// back — or off and on again — restores them. The "when there is nothing to repeat" message
// (RepeatSpec.empty) is remembered the same way when it is switched off and on.
import { computed, ref, useId } from 'vue'
import { repeatIdOptions, withField, withRepeatOver } from '../../../lib/metrics/editorModel'
import type { Label, RepeatSpec } from '../../../lib/metrics/types'
import CardEditorLabel from './CardEditorLabel.vue'

const props = defineProps<{
  allow: RepeatSpec['over'][]
  label?: string
}>()
const repeat = defineModel<RepeatSpec | undefined>({ required: true })

const overId = useId()
const idsGroupId = useId()
const statusGroupId = useId()

const OVER_LABELS: Record<RepeatSpec['over'], string> = {
  campaigns: 'One per campaign',
  popups: 'One per pop-up',
  windows: 'One per before/after window',
  readings: 'One per stored reading',
  countries: 'One per country (US / CA / Other)',
}
/** What "none checked" means for each kind's id list. */
const IDS_HEADINGS: Partial<Record<RepeatSpec['over'], { title: string; none: string }>> = {
  campaigns: { title: 'Campaigns', none: 'none checked = all' },
  popups: { title: 'Pop-ups', none: 'none checked = all' },
  windows: { title: 'Windows', none: 'none checked = release before and after' },
  countries: { title: 'Countries', none: 'none checked = all three' },
}

/** The last spec seen for each kind, so switching away and back restores its filters. */
const remembered = new Map<RepeatSpec['over'], RepeatSpec>()
const overValue = computed<RepeatSpec['over'] | ''>({
  get: () => repeat.value?.over ?? '',
  set: (v) => {
    const cur = repeat.value
    if ((cur?.over ?? '') === v) return
    if (cur) remembered.set(cur.over, cur)
    const prev = v ? remembered.get(v) : undefined
    repeat.value = prev ? (cur?.empty ? { ...prev, empty: cur.empty } : prev) : withRepeatOver(cur, v)
  },
})

const idOptions = computed(() => repeatIdOptions(overValue.value))
const idsHeading = computed(() => (overValue.value ? IDS_HEADINGS[overValue.value] : undefined))
const idsValue = computed<string[]>({
  get: () => repeat.value?.ids ?? [],
  set: (v) => {
    if (!repeat.value) return
    repeat.value = withField(repeat.value, 'ids', v.length ? v : undefined)
  },
})
function toggleId(id: string, checked: boolean) {
  const set = new Set(idsValue.value)
  if (checked === set.has(id)) return
  if (checked) set.add(id)
  else set.delete(id)
  // Option order, plus any stored id the options do not list (kept, never silently dropped).
  const known = idOptions.value.map((o) => o.value)
  idsValue.value = [...known.filter((v) => set.has(v)), ...idsValue.value.filter((v) => !known.includes(v) && set.has(v))]
}

const STATUS_OPTIONS: NonNullable<RepeatSpec['status']>[number][] = ['closed', 'active', 'upcoming']
const statusValue = computed<NonNullable<RepeatSpec['status']>>({
  get: () => repeat.value?.status ?? [],
  set: (v) => {
    if (!repeat.value) return
    repeat.value = withField(repeat.value, 'status', v.length ? v : undefined)
  },
})
function toggleStatus(s: (typeof STATUS_OPTIONS)[number], checked: boolean) {
  const set = new Set(statusValue.value)
  if (checked === set.has(s)) return
  if (checked) set.add(s)
  else set.delete(s)
  statusValue.value = STATUS_OPTIONS.filter((o) => set.has(o))
}

const tracked = computed<boolean>({
  get: () => !!repeat.value?.tracked,
  set: (v) => {
    if (!repeat.value || v === tracked.value) return
    repeat.value = withField(repeat.value, 'tracked', v || undefined)
  },
})

const flightingToday = computed<boolean>({
  get: () => !!repeat.value?.flightingToday,
  set: (v) => {
    if (!repeat.value || v === flightingToday.value) return
    repeat.value = withField(repeat.value, 'flightingToday', v || undefined)
  },
})

// ── When the repeat yields nothing (RepeatSpec.empty): a heading and a message, once. ─────────
const lastEmpty = ref<NonNullable<RepeatSpec['empty']> | null>(null)
const hasEmpty = computed(() => !!repeat.value?.empty)
function toggleEmpty(on: boolean) {
  if (!repeat.value || on === hasEmpty.value) return
  if (!on) {
    lastEmpty.value = repeat.value.empty ?? null
    repeat.value = withField(repeat.value, 'empty', undefined)
  } else {
    repeat.value = { ...repeat.value, empty: lastEmpty.value ?? { label: '', text: '' } }
  }
}
function setEmptyPart(part: 'label' | 'text', v: Label | undefined) {
  if (!repeat.value?.empty) return
  repeat.value = { ...repeat.value, empty: { ...repeat.value.empty, [part]: v ?? '' } }
}
const emptyLabel = computed<Label | undefined>({
  get: () => repeat.value?.empty?.label,
  set: (v) => setEmptyPart('label', v),
})
const emptyText = computed<Label | undefined>({
  get: () => repeat.value?.empty?.text,
  set: (v) => setEmptyPart('text', v),
})
</script>

<template>
  <div class="field">
    <label :for="overId">{{ props.label ?? 'Repeat' }}</label>
    <select :id="overId" v-model="overValue">
      <option value="">None — a single card/item</option>
      <option v-for="o in allow" :key="o" :value="o">{{ OVER_LABELS[o] }}</option>
    </select>
  </div>

  <div class="field" v-if="idOptions.length && idsHeading">
    <label :id="idsGroupId">{{ idsHeading.title }} <span class="hint">— {{ idsHeading.none }}</span></label>
    <div class="campaign-list" role="group" :aria-labelledby="idsGroupId">
      <label v-for="c in idOptions" :key="c.value" class="campaign-row">
        <input type="checkbox" :checked="idsValue.includes(c.value)" @change="toggleId(c.value, ($event.target as HTMLInputElement).checked)" />
        {{ c.label }}
      </label>
    </div>
  </div>
  <div class="row" v-if="overValue === 'campaigns'">
    <div class="field">
      <label :id="statusGroupId">Status <span class="hint">— none checked = all</span></label>
      <div class="campaign-list" role="group" :aria-labelledby="statusGroupId">
        <label v-for="s in STATUS_OPTIONS" :key="s" class="campaign-row">
          <input type="checkbox" :checked="statusValue.includes(s)" @change="toggleStatus(s, ($event.target as HTMLInputElement).checked)" />
          {{ s }}
        </label>
      </div>
    </div>
    <div class="field check">
      <label><input type="checkbox" v-model="flightingToday" /> Flighting today only</label>
    </div>
    <div class="field check">
      <label><input type="checkbox" v-model="tracked" /> Beacon-tracked only (skip spend-only campaigns)</label>
    </div>
  </div>

  <template v-if="overValue">
    <div class="field check">
      <label><input type="checkbox" :checked="hasEmpty" @change="toggleEmpty(($event.target as HTMLInputElement).checked)" /> When there is nothing to repeat, show a message</label>
    </div>
    <template v-if="hasEmpty">
      <CardEditorLabel v-model="emptyLabel" :has-data="false" :allow-metric-own="false" placeholder="Heading (optional)" heading="Empty heading" />
      <CardEditorLabel v-model="emptyText" :has-data="false" :allow-metric-own="false" placeholder="Message" heading="Empty message" />
    </template>
  </template>
</template>

<style scoped src="./editor.css"></style>
