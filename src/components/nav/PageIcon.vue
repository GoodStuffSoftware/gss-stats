<script setup lang="ts">
// A page's icon (lib/icons.ts resolveIcon): the one someone picked, a drill page's root icon with a
// small drill mark, the icon of the dataset its charts read, or the generic page icon. Decorative:
// the page's name is always shown next to it.
import { computed } from 'vue'
import type { DashboardPage } from '../../types'
import { DrillMarkIcon, ICONS, resolveIcon } from '../../lib/icons'

const props = withDefaults(defineProps<{ page: DashboardPage; pages: DashboardPage[]; size?: number }>(), { size: 16 })
const resolved = computed(() => resolveIcon(props.page, props.pages))
</script>

<template>
  <span class="page-icon" :class="{ drill: resolved.drill }" :data-icon="resolved.key" aria-hidden="true">
    <component :is="ICONS[resolved.key]" :size="size" :stroke-width="2" />
    <DrillMarkIcon v-if="resolved.drill" class="drill-mark" :size="10" :stroke-width="3" />
  </span>
</template>

<style scoped>
.page-icon {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex: none;
  color: rgb(var(--ink-2));
}
.drill-mark {
  position: absolute;
  right: -6px;
  bottom: -5px;
  color: rgb(var(--amber-hover));
}
</style>
