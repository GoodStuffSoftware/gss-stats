<script setup lang="ts">
// One instance of a card (one campaign's scorecard card, or the single KPI card): its header —
// title, badge, the card's one "Notes" toggle and any status the parent slots in — its sections,
// and, when the toggle is open, every compact caption on the card as "<label>: <caveat>".
//
// Notes are card-level on purpose (owner's clean look): items with captionMode 'compact' show
// no caption of their own; this component collects them. It reads the same shared values the
// items render (content-equal requests share one cache entry, so no extra fetch), requested
// once at setup. MetricCard remounts instances when the ET day changes, which rebuilds this
// list for the new day.
//
// The click-through (`link`) is the title, a real button — never a role="button" wrapper
// around other controls. The rest of the box stays clickable for a pointer only (no role, not
// focusable), matching the old scorecard card.
import { computed, ref, useId, watch } from 'vue'
import { useMetrics } from '../../composables/useMetrics'
import { noteRawText } from '../../lib/notes'
import { badgeViewModel, itemViewModel, resolveLabelTokens } from '../../lib/metrics/render'
import { buildRequestSpec, scopeField, sectionCells, type FlatItem, type RepeatContext, type ScopeInstance } from '../../lib/metrics/scope'
import type { CardSpec, MetricsContext } from '../../lib/metrics/types'
import type { TextToken, ValueResolver } from '../../lib/textLite'
import MetricLabel from './MetricLabel.vue'
import MetricSection from './MetricSection.vue'

const props = defineProps<{
  spec: CardSpec
  scope: ScopeInstance
  ctx: RepeatContext
  context?: MetricsContext
  /** A repeated card: the bordered box of the old scorecard. */
  boxed: boolean
  /** Names the card (Notes toggle) when the spec has no title: the widget's own title. */
  fallbackTitle?: string
  /** What a `{=…}` token in a label fills from: the fixed dates and the card's metric values (MetricCard). */
  values?: ValueResolver
}>()
const emit = defineEmits<{ open: []; hidden: [boolean] }>()

const todayEt = props.ctx.todayEt
const titleTokens = computed(() => (props.spec.title !== undefined ? resolveLabelTokens(props.spec.title, props.scope, undefined, todayEt, props.values) : []))
const badge = computed(() => {
  const b = props.spec.badge
  if (!b || !('field' in b.data)) return null
  return badgeViewModel(b.display, scopeField(props.scope, b.data.field, todayEt))
})
const linked = computed(() => props.spec.link === 'campaigns-page')

// ── Card notes ─────────────────────────────────────────────────────────────────────────────
const { request } = useMetrics(() => props.context, todayEt)
const noteItems: FlatItem[] = props.spec.sections.flatMap((section) => sectionCells(section, props.scope, props.ctx))
const compactItems = noteItems
  .filter((fi) => fi.item.captionMode === 'compact')
  .map((fi) => {
    const spec = buildRequestSpec(fi.item, fi.scope)
    return { ...fi, value: spec ? request(spec) : null }
  })
// One line per caveat, not per item: items that share a caveat (the arrivals floor on "Tagged
// arrivals" and on the game-screen views pair, the install fix on "Installs" and "Install") are
// listed together in front of it, "Tagged arrivals, Game-screen views: Floor — …".
const notes = computed(() => {
  const byCaption = new Map<string, { key: string; labels: TextToken[][]; names: Set<string>; captionTokens: TextToken[] }>()
  compactItems.forEach((fi, i) => {
    const vm = itemViewModel(fi.item, fi.value?.value, fi.scope, { todayEt, values: props.values, pastDay: props.context?.day !== undefined })
    if (!vm.visible || !vm.captionTokens.length) return
    const text = vm.captionTokens.map((t) => t.value).join('')
    const entry = byCaption.get(text)
    // Each label once: a table row repeats its item in every column (Arrivals in US, CA, Other).
    const name = vm.labelTokens.map((t) => t.value).join('')
    if (entry) {
      if (!entry.names.has(name)) {
        entry.names.add(name)
        entry.labels.push(vm.labelTokens)
      }
    } else byCaption.set(text, { key: `${fi.item.id}-${i}`, labels: [vm.labelTokens], names: new Set([name]), captionTokens: vm.captionTokens })
  })
  const SEP: TextToken = { type: 'text', value: ', ' }
  return [...byCaption.values()].map((e) => ({ key: e.key, labelTokens: e.labels.flatMap((l, i) => (i ? [SEP, ...l] : l)), captionTokens: e.captionTokens }))
})
// A repeated instance with nothing to show (every cell gated out, e.g. a campaign with no return
// beacons yet) is hidden by MetricCard; it reports it here. While a value loads it is visible.
const allCells = noteItems.map((fi) => {
  const spec = buildRequestSpec(fi.item, fi.scope)
  return { ...fi, value: spec ? request(spec) : null }
})
const nothingVisible = computed(() => allCells.length > 0 && allCells.every((fi) => !itemViewModel(fi.item, fi.value?.value, fi.scope, { todayEt, values: props.values, pastDay: props.context?.day !== undefined }).visible))
watch(nothingVisible, (h) => emit('hidden', h), { immediate: true })

const notesOpen = ref(false)
const notesLabel = noteRawText('label.card.notes')
const openLabel = noteRawText('label.card.openCampaigns')
// The header's own content; a slotted status (MetricCard's freshness or error line) also shows
// it, checked in the template through $slots, which is reactive — useSlots() read inside a
// computed is not, and an untitled card would never show its error line.
const hasOwnHead = computed(() => titleTokens.value.length > 0 || !!badge.value || notes.value.length > 0)
const notesId = `mc-notes-${useId()}`
const plainTitle = computed(() => titleTokens.value.map((t) => t.value).join('') || props.fallbackTitle || '')
/** "Notes: US+CA web retest" — which card's notes, for a screen reader moving between cards. */
const notesAria = computed(() => (plainTitle.value ? `${notesLabel}: ${plainTitle.value}` : notesLabel))

function onBoxClick() {
  if (linked.value) emit('open')
}
</script>

<template>
  <div class="metric-card-instance" :class="{ 'metric-card': boxed, clickable: boxed && linked }" @click="boxed ? onBoxClick() : undefined">
    <div v-if="hasOwnHead || $slots.status" class="mc-head">
      <span class="mc-head-left">
        <button v-if="linked && titleTokens.length" type="button" class="mc-title mc-title-link" :title="openLabel" @click.stop="emit('open')"><MetricLabel :tokens="titleTokens" /></button>
        <span v-else-if="titleTokens.length" class="mc-title"><MetricLabel :tokens="titleTokens" /></span>
      </span>
      <span class="mc-head-right">
        <span v-if="badge" class="mc-badge" :class="`tone-${badge.tone}`">{{ badge.primary }}</span>
        <button v-if="notes.length" type="button" class="mc-notes-toggle" :aria-label="notesAria" :aria-expanded="notesOpen" :aria-controls="notesId" @click.stop="notesOpen = !notesOpen">{{ notesLabel }}</button>
        <slot name="status" />
      </span>
    </div>
    <ul v-if="notes.length" v-show="notesOpen" :id="notesId" class="mc-notes" @click.stop>
      <li v-for="n in notes" :key="n.key"><MetricLabel :tokens="n.labelTokens" />: <MetricLabel :tokens="n.captionTokens" /></li>
    </ul>
    <MetricSection v-for="(section, si) in spec.sections" :key="si" :section="section" :outer-scope="scope" :ctx="ctx" :context="context" :values="values" />
  </div>
</template>

<style scoped>
.metric-card {
  border: 1px solid rgb(var(--line));
  border-radius: 12px;
  padding: 12px 14px;
  background: rgb(var(--surface));
}
.metric-card.clickable {
  cursor: pointer;
}
.metric-card.clickable:hover {
  border-color: rgb(var(--amber));
}
.mc-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 8px;
}
/* Both sides are flex containers, so neither adds an inline line box at the body font size:
   the header is exactly as tall as the old scorecard header. */
.mc-head-left,
.mc-head-right {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.mc-head-right {
  margin-left: auto;
}
.mc-title {
  font-weight: 600;
  font-size: 12.5px;
}
.mc-title-link {
  border: none;
  background: transparent;
  padding: 0;
  line-height: inherit;
  color: inherit;
  font: inherit;
  font-weight: 600;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.mc-title-link:hover,
.mc-title-link:focus-visible {
  text-decoration: underline;
}
.mc-badge {
  font-size: 10px;
  text-transform: uppercase;
  color: rgb(var(--ink-3));
}
.mc-badge.tone-live {
  color: rgb(var(--amber-hover));
}
.mc-badge.tone-warn {
  color: #bc4749;
}
.mc-notes-toggle {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 10.5px;
  color: rgb(var(--ink-3));
  cursor: pointer;
  text-decoration: underline dotted;
}
.mc-notes-toggle[aria-expanded='true'],
.mc-notes-toggle:hover {
  color: rgb(var(--ink));
}
.mc-notes {
  list-style: none;
  margin: -2px 0 8px;
  padding: 0;
  font-size: 10.5px;
  color: rgb(var(--ink-3));
  cursor: auto;
}
.mc-notes li + li {
  margin-top: 2px;
}
</style>
