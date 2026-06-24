<script setup lang="ts">
import { GridLayout, GridItem } from 'grid-layout-plus'
import type { Widget, GlobalFilters } from '../types'
import ChartCard from './ChartCard.vue'

// Two-way bound to the parent's reactive widgets array; grid-layout-plus writes
// item geometry back on move/resize and we persist via @layout-updated.
const widgets = defineModel<Widget[]>('widgets', { required: true })

defineProps<{ filters: GlobalFilters; dark: boolean }>()
const emit = defineEmits<{ edit: [Widget]; remove: [string]; duplicate: [Widget]; change: [] }>()
</script>

<template>
  <GridLayout
    v-model:layout="widgets"
    :col-num="12"
    :row-height="40"
    :margin="[14, 14]"
    :is-draggable="true"
    :is-resizable="true"
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
      />
    </GridItem>
  </GridLayout>
</template>

<style scoped>
:deep(.vgl-layout) {
  margin: 0 -7px;
}
</style>
