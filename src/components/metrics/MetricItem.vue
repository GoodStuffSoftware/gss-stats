<script setup lang="ts">
// One MetricItem, rendered in whatever frame its section (or its own `frame` override) picks —
// row (label left, value right, like the scorecard's Flight/Tagged arrivals rows), pill (a
// compact "Label: value" chip, like the funnel pills), or tile (label/number/delta stacked,
// like the KPI tiles), or column (a vertical bar with its value over it and its label under it,
// for a 'columns' section read left to right). The 'table' layout doesn't use this component — see
// MetricTableCell.vue, which is a column cell, not a labeled row/pill/tile.
import { computed } from 'vue'
import { useMetricItemViewModel } from '../../composables/useMetricItem'
import { sparklineGeometry } from '../../lib/metrics/sparkline'
import type { ScopeInstance } from '../../lib/metrics/scope'
import type { MetricItem as MetricItemSpec, MetricsContext } from '../../lib/metrics/types'
import type { ValueResolver } from '../../lib/textLite'
import MetricLabel from './MetricLabel.vue'
import StatTile from './StatTile.vue'
import BarTrack from './BarTrack.vue'

const props = defineProps<{
  item: MetricItemSpec
  scope: ScopeInstance
  frame: 'row' | 'pill' | 'tile' | 'column'
  todayEt: string
  context?: MetricsContext
  /** The largest value in this item's section — a 'bar' display scales its width against it. */
  barMax?: number
  /** What a `{=…}` token in the item's label, caption or hint fills from (MetricCard). */
  values?: ValueResolver
}>()

const vm = useMetricItemViewModel(
  () => props.item,
  () => props.scope,
  () => props.context,
  props.todayEt,
  () => props.values,
)

const barPct = computed(() => {
  if (props.item.display.as !== 'bar' || !props.barMax) return 0
  const n = vm.value.barValue ?? 0
  return Number.isFinite(n) && props.barMax > 0 ? Math.max(0, Math.min(100, Math.round((n / props.barMax) * 100))) : 0
})
/** A 'sparkline' display's drawing: the per-ET-day series as polylines, the line broken at a day
 * the metric was not measured. Null when the server sent no series (the number stands alone). */
const spark = computed(() => (vm.value.series ? sparklineGeometry(vm.value.series) : null))
const sparkTitle = computed(() => (spark.value ? `Daily, ${spark.value.firstDay} to ${spark.value.lastDay}` : ''))
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
      <svg v-if="spark" class="mi-spark mi-spark-row" :viewBox="`0 0 ${spark.width} ${spark.height}`" role="img" :aria-label="sparkTitle" preserveAspectRatio="none">
        <title>{{ sparkTitle }}</title>
        <polyline v-for="(pts, i) in spark.lines" :key="`l${i}`" :points="pts" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
        <circle v-for="(d, i) in spark.dots" :key="`d${i}`" :cx="d.x" :cy="d.y" r="1.5" fill="currentColor" />
      </svg>
      <BarTrack v-if="item.display.as === 'bar'" :pct="barPct" />
      <p v-if="showCaption" class="mi-caption"><MetricLabel :tokens="vm.captionTokens" /></p>
    </template>

    <template v-else-if="frame === 'column'">
      <div class="mi-col" role="group" :aria-label="ariaLabel">
        <div class="mi-col-num mono" :class="{ muted: vm.muted }">{{ vm.split ? vm.split.main : vm.primary }}</div>
        <div v-if="vm.split" class="mi-col-sub mono">{{ vm.split.sub }}</div>
        <div class="mi-col-track"><div class="mi-col-fill" :style="{ height: barPct + '%' }" /></div>
        <div class="mi-col-label" :title="plainLabel"><MetricLabel :tokens="vm.labelTokens" /></div>
        <p v-if="showCaption" class="mi-caption"><MetricLabel :tokens="vm.captionTokens" /></p>
      </div>
    </template>

    <template v-else-if="frame === 'pill'">
      <span class="mi-pill" :title="plainLabel"><MetricLabel :tokens="vm.labelTokens" />: <span class="mi-pill-value" :class="{ muted: vm.muted }">{{ vm.primary }}</span></span>
      <span v-if="showCaption" class="mi-pill-caption"><MetricLabel :tokens="vm.captionTokens" /></span>
    </template>

    <template v-else>
      <StatTile
        variant="frame"
        :number="vm.split ? vm.split.main : vm.primary"
        :sub="vm.split ? vm.split.sub : undefined"
        :muted="vm.muted"
        :tone="item.display.as === 'badge' ? vm.badgeTone : undefined"
        :label-title="plainLabel"
        role="group"
        :aria-label="ariaLabel"
      >
        <template #label><MetricLabel :tokens="vm.labelTokens" /></template>
        <div v-for="(d, i) in vm.deltaLines" :key="i" class="mi-tile-delta" :class="d.cls">{{ d.text }}</div>
        <svg v-if="spark" class="mi-spark" :viewBox="`0 0 ${spark.width} ${spark.height}`" role="img" :aria-label="sparkTitle" preserveAspectRatio="none">
          <title>{{ sparkTitle }}</title>
          <polyline v-for="(pts, i) in spark.lines" :key="`l${i}`" :points="pts" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
          <circle v-for="(d, i) in spark.dots" :key="`d${i}`" :cx="d.x" :cy="d.y" r="1.5" fill="currentColor" />
        </svg>
        <BarTrack v-if="item.display.as === 'bar'" :pct="barPct" />
        <p v-if="showCaption" class="mi-tile-caption"><MetricLabel :tokens="vm.captionTokens" /></p>
      </StatTile>
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
.mi-spark {
  display: block;
  width: 100%;
  height: 22px;
  margin: 4px 0 2px;
  color: rgb(var(--amber-hover));
}
.mi-spark-row {
  height: 18px;
}
.mi-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  min-width: 0;
  height: 100%;
}
.mi-col-num {
  font-size: 11.5px;
  color: rgb(var(--ink));
}
.mi-col-num.muted {
  font-style: italic;
  color: rgb(var(--ink-3));
}
.mi-col-sub {
  font-size: 10px;
  color: rgb(var(--ink-3));
}
.mi-col-track {
  flex: 1;
  min-height: 60px;
  width: 60%;
  max-width: 44px;
  display: flex;
  align-items: flex-end;
  background: rgb(var(--sunken));
  border-radius: 4px 4px 0 0;
  margin: 4px 0;
  overflow: hidden;
}
.mi-col-fill {
  width: 100%;
  background: rgb(var(--amber-hover));
  border-radius: 4px 4px 0 0;
}
.mi-col-label {
  font-size: 11px;
  color: rgb(var(--ink-2));
}
.mi-pill-caption {
  display: block;
  font-size: 9.5px;
  color: rgb(var(--ink-3));
  margin: 2px 0 0;
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
