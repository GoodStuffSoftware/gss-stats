<script setup lang="ts">
// A group's badge (lib/icons.ts groupBadge): a lettered monogram in one of seven palette colours
// hashed from the group's name, or the colour/logo pinned in the config's groupMeta. Decorative:
// the group's name is always shown next to it (or in the control's accessible name).
import { computed, ref, watch } from 'vue'
import type { GroupMeta } from '../../types'
import { groupBadge } from '../../lib/icons'

const props = withDefaults(defineProps<{ name: string; meta?: GroupMeta; size?: 'sm' | 'lg' }>(), { size: 'sm' })
const badge = computed(() => groupBadge(props.name, props.meta))
const logoFailed = ref(false)
watch(
  () => badge.value.logo,
  () => (logoFailed.value = false),
)
</script>

<template>
  <span
    class="group-badge"
    :class="[size, badge.slot !== undefined ? `gb-c${badge.slot}` : '', { logo: badge.logo && !logoFailed }]"
    :style="badge.color ? { background: badge.color, color: badge.onColor } : undefined"
    aria-hidden="true"
  >
    <img v-if="badge.logo && !logoFailed" :src="badge.logo" alt="" referrerpolicy="no-referrer" @error="logoFailed = true" />
    <template v-else>{{ badge.text }}</template>
  </span>
</template>

<style scoped>
.group-badge {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: inline-grid;
  place-items: center;
  flex: none;
  font: 600 9.5px/1 'Space Grotesk', system-ui, sans-serif;
  letter-spacing: 0.02em;
  color: rgb(var(--on-g));
  overflow: hidden;
}
.group-badge.lg {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  font-size: 13px;
}
.group-badge.logo {
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line));
}
.group-badge img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.gb-c0 {
  background: rgb(var(--g0));
}
.gb-c1 {
  background: rgb(var(--g1));
}
.gb-c2 {
  background: rgb(var(--g2));
}
.gb-c3 {
  background: rgb(var(--g3));
}
.gb-c4 {
  background: rgb(var(--g4));
}
.gb-c5 {
  background: rgb(var(--g5));
}
.gb-c6 {
  background: rgb(var(--g6));
}
</style>
