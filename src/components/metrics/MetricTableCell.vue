<script setup lang="ts">
// One cell of a 'table' section (Section.layout === 'table': "items are columns, repeat
// instances are rows" — ADR 0003 section 1). The column header is the item's label
// (MetricSection.vue renders that once); this is just the value + delta + caption, the same
// view model MetricItem.vue uses for a row/pill/tile.
//
// An item with `windows` shows one value per window joined by " · " (each part its own cell
// component, so each registers its own request), then its `after` text, dim. An item whose
// `gating.onlyWith` field is empty here is a blank cell, not a dash.
import { computed } from 'vue'
import { useMetricItemViewModel } from '../../composables/useMetricItem'
import { lacksRequiredField, windowParts, type ScopeInstance } from '../../lib/metrics/scope'
import { resolveLabelTokens } from '../../lib/metrics/render'
import type { MetricItem, MetricsContext } from '../../lib/metrics/types'
import type { ValueResolver } from '../../lib/textLite'
import MetricLabel from './MetricLabel.vue'

const props = defineProps<{ item: MetricItem; scope: ScopeInstance; todayEt: string; context?: MetricsContext; values?: ValueResolver }>()
const parts = computed(() => (props.item.windows?.length ? windowParts(props.item) : null))
const blank = computed(() => lacksRequiredField(props.item, props.scope, props.todayEt))
const afterTokens = computed(() => (props.item.after !== undefined ? resolveLabelTokens(props.item.after, props.scope, undefined, props.todayEt, props.values) : []))
// A combined cell's own view model is its first part's (the same request, deduped): only its
// visibility and label are read from it.
const vm = useMetricItemViewModel(
  () => parts.value?.[0] ?? props.item,
  () => props.scope,
  () => props.context,
  props.todayEt,
  () => props.values,
)
</script>

<template>
  <span v-if="blank" class="mtc" />
  <span v-else-if="parts" class="mtc mono"
    ><template v-for="(part, i) in parts" :key="part.id"
      ><template v-if="i"> · </template><MetricTableCell :item="part" :scope="scope" :today-et="todayEt" :context="context" :values="values" /></template
    ><template v-if="afterTokens.length">{{ ' ' }}<MetricLabel class="mtc-after" :tokens="afterTokens" /></template
  ></span>
  <span v-else-if="vm.visible && vm.pill" class="mtc mtc-pill" :class="`pill-${vm.pill}`">{{ vm.primary }}</span>
  <span v-else-if="vm.visible" class="mtc mono" :class="[{ muted: vm.muted }, vm.tone ? `tone-${vm.tone}` : '']">
    {{ vm.primary }}<template v-if="afterTokens.length">{{ ' ' }}<MetricLabel class="mtc-after" :tokens="afterTokens" /></template>
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
/* A status pill (Display status `pill`): its colour the status note's own (render.ts STATUS_PILL_TONES). */
.mtc-pill {
  display: inline-block;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11.5px;
  line-height: 18px;
  border: 1px solid rgb(var(--line));
}
.mtc-pill.pill-good {
  color: rgb(var(--g5));
  border-color: rgb(var(--g5) / 0.5);
}
.mtc-pill.pill-info {
  color: rgb(var(--g6));
  border-color: rgb(var(--g6) / 0.5);
}
.mtc-pill.pill-alert {
  color: rgb(var(--g4));
  border-color: rgb(var(--g4) / 0.6);
  font-weight: 600;
}
.mtc-after {
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
