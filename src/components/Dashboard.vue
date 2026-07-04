<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { GridLayout, GridItem } from 'grid-layout-plus'
import type { Widget, GlobalFilters } from '../types'
import ChartCard from './ChartCard.vue'

// Two-way bound to the parent's reactive widgets array; grid-layout-plus writes
// item geometry back on move/resize and we persist via @layout-updated.
const widgets = defineModel<Widget[]>('widgets', { required: true })

defineProps<{ filters: GlobalFilters; dark: boolean }>()
const emit = defineEmits<{
  edit: [Widget]
  remove: [string]
  duplicate: [Widget]
  change: []
  drill: [{ dimension: string; dataset: 'geo' | 'rum'; value: string; label: string; x: number; y: number }]
}>()

// On phones we stack cards via CSS (preserving the desktop layout data) and
// disable drag/resize so touch scrolling works.
const isMobile = ref(false)
function check() {
  isMobile.value = window.innerWidth <= 700
}
onMounted(() => {
  check()
  window.addEventListener('resize', check)
})
onBeforeUnmount(() => window.removeEventListener('resize', check))
</script>

<template>
  <GridLayout
    v-model:layout="widgets"
    :col-num="12"
    :row-height="40"
    :margin="[14, 14]"
    :is-draggable="!isMobile"
    :is-resizable="!isMobile"
    :vertical-compact="true"
    :use-css-transforms="true"
    @layout-updated="emit('change')"
  >
    <GridItem
      v-for="item in widgets"
      :key="item.i"
      :i="item.i"
      :x="item.x"
      :y="item.y"
      :w="item.w"
      :h="item.h"
      :min-w="2"
      :min-h="3"
      drag-allow-from=".card-head"
    >
      <ChartCard
        :widget="item"
        :filters="filters"
        :dark="dark"
        @edit="emit('edit', item)"
        @remove="emit('remove', item.id)"
        @duplicate="emit('duplicate', item)"
        @drill="emit('drill', $event)"
      />
    </GridItem>
  </GridLayout>
</template>

<style scoped>
:deep(.vgl-layout) {
  margin: 0 -7px;
}

/* Phone: drop absolute positioning and stack cards vertically. The underlying
   layout data is untouched, so the desktop arrangement is preserved. */
@media (max-width: 700px) {
  :deep(.vgl-layout) {
    height: auto !important;
    margin: 0;
  }
  :deep(.vgl-item) {
    position: static !important;
    transform: none !important;
    width: 100% !important;
    height: auto !important;
    margin: 0 0 12px 0 !important;
  }
  :deep(.vgl-item__resizer) {
    display: none !important;
  }
  :deep(.vgl-item .chart-card) {
    height: 300px;
  }
}
</style>
