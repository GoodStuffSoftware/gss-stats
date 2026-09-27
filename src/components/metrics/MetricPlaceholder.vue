<script setup lang="ts">
// A repeat's `empty` fallback (RepeatSpec.empty: "shown once when the repeat yields nothing"),
// drawn in the same frame as the items around it — so the KPI tiles' "Tagged arrivals: no
// campaign flighting today" is a tile like its neighbours, not a stray line of text. No data
// binding and no request: it is a label and a status word.
import type { TextToken } from '../../lib/textLite'
import MetricLabel from './MetricLabel.vue'

defineProps<{ labelTokens: TextToken[]; textTokens: TextToken[]; frame: 'row' | 'pill' | 'tile' }>()
</script>

<template>
  <div class="metric-placeholder" :data-frame="frame">
    <div v-if="frame === 'tile'" class="mp-tile">
      <div class="mp-tile-label"><MetricLabel :tokens="labelTokens" /></div>
      <div class="mp-tile-text"><MetricLabel :tokens="textTokens" /></div>
    </div>
    <span v-else-if="frame === 'pill'" class="mp-pill"><MetricLabel :tokens="labelTokens" />: <MetricLabel :tokens="textTokens" /></span>
    <div v-else class="mp-row">
      <span><MetricLabel :tokens="labelTokens" /></span>
      <span class="mp-row-text"><MetricLabel :tokens="textTokens" /></span>
    </div>
  </div>
</template>

<style scoped>
.mp-tile {
  border: 1px solid rgb(var(--line));
  border-radius: 12px;
  padding: 10px 12px;
  background: rgb(var(--surface));
  min-width: 0;
}
.mp-tile-label {
  font-size: 11px;
  color: rgb(var(--ink-3));
  margin-bottom: 4px;
}
.mp-tile-text {
  font-size: 12px;
  font-weight: 500;
  color: rgb(var(--ink-3));
}
.mp-pill {
  font-size: 9.5px;
  background: rgb(var(--sunken));
  border-radius: 6px;
  padding: 2px 6px;
  color: rgb(var(--ink-3));
  display: inline-block;
}
.mp-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  margin-bottom: 3px;
  color: rgb(var(--ink-2));
}
.mp-row-text {
  color: rgb(var(--ink-3));
}
</style>
