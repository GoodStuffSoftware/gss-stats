<script setup lang="ts">
// A label / bar / value table: the Table chart type's body. Rows arrive already labelled and
// measured (ChartCard reads them through fetchStats); each bar is scaled to the largest value
// (never below 1, so an all-zero table draws no bars instead of dividing by zero).
// ADR 0005 slice 5: one component, no inline markup left in ChartCard.
import { computed } from 'vue'
import BarTrack from './BarTrack.vue'

const props = defineProps<{ rows: { label: string; value: number }[] }>()

const max = computed(() => Math.max(1, ...props.rows.map((r) => r.value)))
const fmt = (n: number) => n.toLocaleString('en-US')
</script>

<template>
  <div class="bar-table-wrap">
    <table class="bar-table">
      <tbody>
        <tr v-for="(r, idx) in rows" :key="idx">
          <td class="bt-label" :title="r.label">{{ r.label }}</td>
          <td class="bt-bar"><BarTrack variant="plain" :pct="(r.value / max) * 100" /></td>
          <td class="bt-val mono">{{ fmt(r.value) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.bar-table-wrap {
  height: 100%;
  overflow-y: auto;
}
.bar-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
td {
  padding: 4px 6px;
  vertical-align: middle;
}
.bt-label {
  max-width: 0;
  width: 42%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgb(var(--ink));
}
.bt-bar {
  width: 40%;
}
.bt-val {
  text-align: right;
  color: rgb(var(--ink-2));
  white-space: nowrap;
}
.mono {
  font-family: 'JetBrains Mono', monospace;
}
</style>
