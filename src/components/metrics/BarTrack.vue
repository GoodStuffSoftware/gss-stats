<script setup lang="ts">
// The one horizontal bar. A metric card's bar display and bars layout (MetricItem) draw it as a
// 'track' (a sunken groove with a fill), a bar table row (BarTable) as 'plain' (the fill alone),
// a 'progress' display in a line (MetricItem's 'line' frame) as 'progress' (a taller rounded track).
// The caller works out the width; this only draws it. ADR 0005 slice 5.
// `done`: a 'progress' display that has reached its target (the fill turns green).
withDefaults(defineProps<{ pct: number; variant?: 'track' | 'plain' | 'progress'; done?: boolean }>(), { variant: 'track', done: false })
</script>

<template>
  <div v-if="variant === 'track'" class="bar-track mi-bar-track"><div class="bar-fill mi-bar-fill" :class="{ done }" :style="{ width: pct + '%' }" /></div>
  <div v-else-if="variant === 'progress'" class="progress-track"><div class="progress-fill" :class="{ done }" :style="{ width: pct + '%' }" /></div>
  <span v-else class="bt-fill" :style="{ width: pct + '%' }"></span>
</template>

<style scoped>
.bar-track {
  height: 6px;
  border-radius: 3px;
  background: rgb(var(--sunken));
  overflow: hidden;
  margin: 4px 0;
}
.bar-fill {
  height: 100%;
  background: rgb(var(--amber-hover));
  border-radius: 3px;
}
.bar-fill.done {
  background: rgb(var(--g5));
}
.progress-track {
  height: 8px;
  margin: 6px 0;
  border-radius: 999px;
  background: rgb(var(--line));
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: rgb(var(--g6));
}
.progress-fill.done {
  background: rgb(var(--g5));
}
.bt-fill {
  display: block;
  height: 8px;
  border-radius: 4px;
  background: rgb(var(--amber));
  min-width: 2px;
}
</style>
