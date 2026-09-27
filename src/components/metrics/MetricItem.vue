<script setup lang="ts">
// One MetricItem, rendered in whatever frame its section (or its own `frame` override) picks —
// row (label left, value right, like the scorecard's Flight/Tagged arrivals rows), pill (a
// compact "Label: value" chip, like the funnel pills), or tile (label/number/delta stacked,
// like the KPI tiles). The 'table' layout doesn't use this component — see
// MetricTableCell.vue, which is a column cell, not a labeled row/pill/tile.
import { computed } from 'vue'
import { useMetricItemViewModel } from '../../composables/useMetricItem'
import type { ScopeInstance } from '../../lib/metrics/scope'
import type { MetricItem as MetricItemSpec, MetricsContext } from '../../lib/metrics/types'
import MetricLabel from './MetricLabel.vue'

const props = defineProps<{
  item: MetricItemSpec
  scope: ScopeInstance
  frame: 'row' | 'pill' | 'tile'
  todayEt: string
  context?: MetricsContext
  /** The largest value in this item's section — a 'bar' display scales its width against it. */
  barMax?: number
}>()

const vm = useMetricItemViewModel(
  () => props.item,
  () => props.scope,
  () => props.context,
  props.todayEt,
)

const barPct = computed(() => {
  if (props.item.display.as !== 'bar' || !props.barMax) return 0
  const n = vm.value.barValue ?? 0
  return Number.isFinite(n) && props.barMax > 0 ? Math.max(0, Math.min(100, Math.round((n / props.barMax) * 100))) : 0
})
const plainLabel = computed(() => vm.value.labelTokens.map((t) => t.value).join(''))
/** "Tagged arrivals: 353, vs yesterday +12 (+4%)" — one accessible name for a row or tile. */
const ariaLabel = computed(() => [`${plainLabel.value}: ${vm.value.primary}`, ...vm.value.deltaLines.map((d) => d.text)].join(', '))

// captionMode 'compact': the item shows no caption of its own; MetricCard lists it, with every
// other compact caption, behind the card's one collapsed "Notes" toggle (the clean look).
// 'inline' (the default) keeps the caption as a line under the value.
const showCaption = computed(() => vm.value.captionTokens.length > 0 && props.item.captionMode !== 'compact')
</script>

<template>
  <div v-if="vm.visible" class="metric-item" :data-frame="frame">
    <template v-if="frame === 'row'">
      <div class="mi-row" role="group" :aria-label="ariaLabel">
        <span class="mi-label"><MetricLabel :tokens="vm.labelTokens" /></span>
        <span class="mi-value mono" :class="{ muted: vm.muted }">
          {{ vm.primary }}
          <span v-for="(d, i) in vm.deltaLines" :key="i" class="mi-delta" :class="d.cls">{{ d.text }}</span>
        </span>
      </div>
      <div v-if="item.display.as === 'bar'" class="mi-bar-track"><div class="mi-bar-fill" :style="{ width: barPct + '%' }" /></div>
      <p v-if="showCaption" class="mi-caption"><MetricLabel :tokens="vm.captionTokens" /></p>
    </template>

    <template v-else-if="frame === 'pill'">
      <span class="mi-pill" :title="plainLabel"><MetricLabel :tokens="vm.labelTokens" />: <span class="mi-pill-value" :class="{ muted: vm.muted }">{{ vm.primary }}</span></span>
      <span v-if="showCaption" class="mi-pill-caption"><MetricLabel :tokens="vm.captionTokens" /></span>
    </template>

    <template v-else>
      <div class="mi-tile" :class="item.display.as === 'badge' ? `tone-${vm.badgeTone}` : ''" role="group" :aria-label="ariaLabel">
        <div class="mi-tile-label" :title="plainLabel"><MetricLabel :tokens="vm.labelTokens" /></div>
        <!-- A rate: big, with its (n/d) as a small line under it (the old KPI tile's look). -->
        <template v-if="vm.split">
          <div class="mi-tile-num" :class="{ muted: vm.muted }">{{ vm.split.main }}</div>
          <div class="mi-tile-sub mono">{{ vm.split.sub }}</div>
        </template>
        <div v-else class="mi-tile-num" :class="{ muted: vm.muted }">{{ vm.primary }}</div>
        <div v-for="(d, i) in vm.deltaLines" :key="i" class="mi-tile-delta" :class="d.cls">{{ d.text }}</div>
        <div v-if="item.display.as === 'bar'" class="mi-bar-track"><div class="mi-bar-fill" :style="{ width: barPct + '%' }" /></div>
        <p v-if="showCaption" class="mi-tile-caption"><MetricLabel :tokens="vm.captionTokens" /></p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mono {
  font-family: 'JetBrains Mono', monospace;
}
.mi-row {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  margin-bottom: 3px;
  color: rgb(var(--ink-2));
  gap: 8px;
}
.mi-caption {
  font-size: 10.5px;
  color: rgb(var(--ink-3));
  margin: 0 0 4px;
}
.mi-delta {
  font-size: 10.5px;
  color: rgb(var(--ink-3));
  margin-left: 4px;
}
.mi-delta.up {
  color: #6a994e;
}
.mi-delta.down {
  color: #bc4749;
}
/* A pill's wrapper is a flex column, so the pill is blockified and adds no line box: pill rows
   keep the old scorecard's 4px spacing instead of a full line of height each. */
.metric-item[data-frame='pill'] {
  display: flex;
  flex-direction: column;
}
.mi-pill {
  font-size: 9.5px;
  background: rgb(var(--sunken));
  border-radius: 6px;
  padding: 2px 6px;
  color: rgb(var(--ink-3));
  display: inline-block;
}
.mi-tile {
  border: 1px solid rgb(var(--line));
  border-radius: 12px;
  padding: 10px 12px;
  background: rgb(var(--surface));
  min-width: 0;
}
.mi-tile.tone-live {
  border-color: rgb(var(--amber-hover));
}
.mi-tile.tone-warn {
  border-color: #bc4749;
}
.mi-tile-label {
  font-size: 11px;
  color: rgb(var(--ink-3));
  margin-bottom: 4px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.mi-tile-num {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 22px;
  font-weight: 700;
  color: rgb(var(--ink));
}
.mi-tile-delta {
  font-size: 10.5px;
  color: rgb(var(--ink-3));
  margin-top: 2px;
}
.mi-tile-delta.up {
  color: #6a994e;
}
.mi-tile-delta.down {
  color: #bc4749;
}
.mi-tile-caption {
  font-size: 10.5px;
  color: rgb(var(--ink-3));
  margin: 4px 0 0;
}
.mi-bar-track {
  height: 6px;
  border-radius: 3px;
  background: rgb(var(--sunken));
  overflow: hidden;
  margin: 4px 0;
}
.mi-bar-fill {
  height: 100%;
  background: rgb(var(--amber-hover));
  border-radius: 3px;
}
.mi-pill-caption {
  display: block;
  font-size: 9.5px;
  color: rgb(var(--ink-3));
  margin: 2px 0 0;
}
.mi-tile-sub {
  font-size: 10.5px;
  color: rgb(var(--ink-3));
  margin-top: 1px;
}
.mi-tile-num.muted {
  font-size: 12px;
  font-weight: 500;
  color: rgb(var(--ink-3));
  font-family: Inter, sans-serif;
}
/* A status word in a pill ("unavailable", "not yet tracking") must not read as a value. */
.mi-pill-value.muted {
  font-style: italic;
  opacity: 0.75;
}
.mi-value.muted {
  font-style: italic;
  color: rgb(var(--ink-3));
}
.mi-delta.new,
.mi-tile-delta.new {
  color: rgb(var(--amber-hover));
}
</style>
