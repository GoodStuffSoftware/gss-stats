<script setup lang="ts">
// The metric-card family's entry point (ADR 0003 section 1, "Rendering"): resolves a widget's
// `card: CardRef` — `{ preset }` through the preset registry, or an inline `{ spec }` — into a
// CardSpec, expands its top-level `repeat` (one card per campaign/pop-up/window/reading, or a
// single unrepeated instance for something like the KPI tiles), and renders each instance's
// title, badge and sections. A repeated card gets the scorecard's bordered, clickable box
// (matching OverviewWidgetBody.vue's `.scorecard-card` look); an unrepeated card (KPI tiles)
// renders its sections directly, since the tiles themselves are the boxed elements.
import { computed } from 'vue'
import { badgeViewModel, resolveLabelTokens } from '../../lib/metrics/render'
import { PRESETS } from '../../lib/metrics/presets'
import { ROOT_SCOPE, resolveRepeat, scopeField, todayEtFrom, type ReadingScope, type RepeatContext, type ScopeInstance } from '../../lib/metrics/scope'
import type { CardRef, CardSpec, MetricsContext } from '../../lib/metrics/types'
import MetricLabel from './MetricLabel.vue'
import MetricSection from './MetricSection.vue'

const props = defineProps<{
  cardRef: CardRef
  context?: MetricsContext
  readings?: ReadingScope[]
  /** Test/preview seam — defaults to the real clock. */
  nowMs?: number
}>()
const emit = defineEmits<{ 'open-campaigns': [] }>()

const spec = computed<CardSpec | null>(() => ('preset' in props.cardRef ? (PRESETS[props.cardRef.preset] ?? null) : props.cardRef.spec))
const todayEt = computed(() => todayEtFrom(props.nowMs ?? Date.now()))
const ctx = computed<RepeatContext>(() => ({ todayEt: todayEt.value, readings: props.readings }))
const instances = computed<ScopeInstance[]>(() => (spec.value ? resolveRepeat(spec.value.repeat, ctx.value) : []))

function titleTokens(scope: ScopeInstance) {
  return spec.value?.title !== undefined ? resolveLabelTokens(spec.value.title, scope, undefined, todayEt.value) : []
}
function badgeInfo(scope: ScopeInstance) {
  const b = spec.value?.badge
  if (!b || !('field' in b.data)) return null
  return badgeViewModel(b.display, scopeField(scope, b.data.field, todayEt.value))
}
function onCardClick() {
  if (spec.value?.link === 'campaigns-page') emit('open-campaigns')
}
</script>

<template>
  <p v-if="!spec" class="metric-card-error">Unknown card{{ 'preset' in cardRef ? ` preset "${cardRef.preset}"` : '' }}.</p>

  <!-- Repeated: N bordered, clickable cards in a grid (the scorecard shape). -->
  <div v-else-if="spec.repeat" class="metric-card-grid" :style="{ '--mc-min-width': `${spec.minWidth ?? 230}px` }">
    <div
      v-for="(scope, i) in instances"
      :key="i"
      class="metric-card"
      :class="{ clickable: spec.link === 'campaigns-page' }"
      :role="spec.link === 'campaigns-page' ? 'button' : undefined"
      :tabindex="spec.link === 'campaigns-page' ? 0 : undefined"
      @click="onCardClick"
      @keyup.enter="onCardClick"
    >
      <div v-if="titleTokens(scope).length || badgeInfo(scope)" class="mc-head">
        <span class="mc-title"><MetricLabel :tokens="titleTokens(scope)" /></span>
        <span v-if="badgeInfo(scope)" class="mc-badge" :class="`tone-${badgeInfo(scope)!.tone}`">{{ badgeInfo(scope)!.primary }}</span>
      </div>
      <MetricSection v-for="(section, si) in spec.sections" :key="si" :section="section" :outer-scope="scope" :ctx="ctx" :context="context" />
    </div>
    <p v-if="!instances.length && spec.repeat.empty" class="metric-card-empty">
      <MetricLabel :tokens="resolveLabelTokens(spec.repeat.empty.label, ROOT_SCOPE, undefined, todayEt)" />
      <MetricLabel :tokens="resolveLabelTokens(spec.repeat.empty.text, ROOT_SCOPE, undefined, todayEt)" />
    </p>
  </div>

  <!-- Unrepeated: one card, no box (e.g. the KPI tiles — the tiles themselves are the boxes). -->
  <div v-else class="metric-card-plain">
    <div v-if="titleTokens(ROOT_SCOPE).length || badgeInfo(ROOT_SCOPE)" class="mc-head">
      <span class="mc-title"><MetricLabel :tokens="titleTokens(ROOT_SCOPE)" /></span>
      <span v-if="badgeInfo(ROOT_SCOPE)" class="mc-badge" :class="`tone-${badgeInfo(ROOT_SCOPE)!.tone}`">{{ badgeInfo(ROOT_SCOPE)!.primary }}</span>
    </div>
    <MetricSection v-for="(section, si) in spec.sections" :key="si" :section="section" :outer-scope="ROOT_SCOPE" :ctx="ctx" :context="context" />
  </div>
</template>

<style scoped>
.metric-card-error {
  color: rgb(var(--ink-3));
  font-size: 11.5px;
}
.metric-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--mc-min-width, 230px), 1fr));
  gap: 14px;
}
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
.metric-card-empty {
  font-size: 11.5px;
  color: rgb(var(--ink-3));
}
.mc-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 8px;
}
.mc-title {
  font-weight: 600;
  font-size: 12.5px;
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
</style>
