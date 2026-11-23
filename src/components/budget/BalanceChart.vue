<script setup lang="ts">
// One debt's balance over time as a line: the chart on the debt's page (DebtDetail "Balance over time") and the
// one a slice of the debt pie opens in place (DebtPanel). With no balance history it says so instead of drawing
// an empty chart.
// Props: history (the rows of GET /api/budget/debts/:id, any order), dark (site theme), label (names the debt, for
// the chart's accessible name).
import { computed } from 'vue'
import { balanceLineConfig } from '../../lib/budget/balanceChart'
import BaseChart from '../charts/BaseChart.vue'

const props = defineProps<{ history: ReadonlyArray<{ asOf: string; balanceCents: number }>; dark: boolean; label: string }>()

const sorted = computed(() => [...props.history].sort((a, b) => a.asOf.localeCompare(b.asOf)))
const config = computed(() => balanceLineConfig(sorted.value, props.dark))
</script>

<template>
  <div v-if="sorted.length" class="dd-chart" role="img" :aria-label="`Balance history of ${label}`" data-testid="debt-chart">
    <BaseChart :config="config" :drill-open="false" />
  </div>
  <p v-else class="dd-chart-none" data-testid="debt-chart-none">No balance history yet.</p>
</template>

<style scoped>
.dd-chart {
  position: relative;
  height: 220px;
}
.dd-chart-none {
  margin: 0;
  font-size: 14px;
  color: rgb(var(--ink-2));
}
</style>
