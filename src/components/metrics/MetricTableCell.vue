<script setup lang="ts">
// One cell of a 'table' section (Section.layout === 'table': "items are columns, repeat
// instances are rows" — ADR 0003 section 1). The column header is the item's label
// (MetricSection.vue renders that once); this is just the value + delta + caption, the same
// view model MetricItem.vue uses for a row/pill/tile.
import { useMetricItemViewModel } from '../../composables/useMetricItem'
import type { ScopeInstance } from '../../lib/metrics/scope'
import type { MetricItem, MetricsContext } from '../../lib/metrics/types'
import MetricLabel from './MetricLabel.vue'

const props = defineProps<{ item: MetricItem; scope: ScopeInstance; todayEt: string; context?: MetricsContext }>()
const vm = useMetricItemViewModel(
  () => props.item,
  () => props.scope,
  () => props.context,
  props.todayEt,
)
</script>

<template>
  <span v-if="vm.visible" class="mtc mono" :class="[{ muted: vm.muted }, vm.tone ? `tone-${vm.tone}` : '']">
    {{ vm.primary }}
    <span v-for="(d, i) in vm.deltaLines" :key="i" class="mtc-delta" :class="d.cls">{{ d.text }}</span>
    <!-- captionMode 'compact': listed behind the card's one Notes toggle instead (MetricCardInstance). -->
    <MetricLabel v-if="vm.captionTokens.length && item.captionMode !== 'compact'" class="mtc-caption" :tokens="vm.captionTokens" />
  </span>
  <span v-else class="mtc mono">—</span>
</template>

<style scoped>
.mono {
  font-family: 'JetBrains Mono', monospace;
}
.muted {
  font-style: italic;
  color: rgb(var(--ink-3));
}
.mtc {
  font-size: 11.5px;
  color: rgb(var(--ink-2));
  white-space: nowrap;
}
/* The tone a scope field supplies (scope.ts scopeTone), as the readings log's Rules and Proposal. */
.mtc.tone-trip {
  color: #bc4749;
  font-weight: 600;
}
.mtc.tone-watch {
  color: rgb(var(--amber-hover));
  font-weight: 600;
}
.mtc.tone-clear {
  color: rgb(var(--ink-2));
}
.mtc.tone-muted {
  color: rgb(var(--ink-3));
}
.mtc-delta {
  font-size: 10px;
  color: rgb(var(--ink-3));
  margin-left: 4px;
}
.mtc-delta.up {
  color: #6a994e;
}
.mtc-delta.down {
  color: #bc4749;
}
.mtc-caption {
  display: block;
  font-size: 10px;
  color: rgb(var(--ink-3));
  white-space: normal;
}
</style>
