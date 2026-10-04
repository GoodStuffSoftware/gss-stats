<script setup lang="ts">
// The one horizontal bar. A metric card's bar display and bars layout (MetricItem) draw it as a
// 'track' (a sunken groove with a fill), a bar table row (BarTable) as 'plain' (the fill alone).
// The caller works out the width; this only draws it. ADR 0005 slice 5.
withDefaults(defineProps<{ pct: number; variant?: 'track' | 'plain' }>(), { variant: 'track' })
</script>

<template>
  <div v-if="variant === 'track'" class="bar-track mi-bar-track"><div class="bar-fill mi-bar-fill" :style="{ width: pct + '%' }" /></div>
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
.bt-fill {
  display: block;
  height: 8px;
  border-radius: 4px;
  background: rgb(var(--amber));
  min-width: 2px;
}
</style>
