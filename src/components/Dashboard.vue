<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { GridLayout, GridItem } from 'grid-layout-plus'
import type { Widget, GlobalFilters } from '../types'
import { isTouchDevice } from '../lib/responsive'
import ChartCard from './ChartCard.vue'

// Two-way bound to the parent's reactive widgets array; grid-layout-plus writes
// item geometry back on move/resize and we persist via @layout-updated.
const widgets = defineModel<Widget[]>('widgets', { required: true })

// `drillOpenId` is the id of the ONE widget whose drill menu is currently open (or null) —
// not a blanket "some menu is open somewhere" flag. Only that widget's ChartCard gets
// `drill-open="true"`, so a suppressed/stuck tooltip is scoped to the chart the menu actually
// belongs to, never every chart on the page.
// `controlsVisible` (App.vue's function-bar `barOpen`): when true, every card's own
// modification chrome (edit/zoom/menu icons, drag handle, resize grip) is shown regardless
// of hover — otherwise each card only reveals its own chrome on :hover (see ChartCard.vue
// and the resize-grip CSS below). Titles/values/notes are never affected by this.
defineProps<{ filters: GlobalFilters; dark: boolean; drillOpenId: string | null; controlsVisible: boolean }>()
const emit = defineEmits<{
  edit: [Widget]
  remove: [string]
  duplicate: [Widget]
  change: []
  drill: [{ widgetId: string; dimension: string; dataset: 'geo' | 'rum'; value: string; label: string; x: number; y: number }]
  'open-campaigns': []
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

// Touch-capable devices ALSO get drag/resize disabled, regardless of width (isMobile alone
// isn't enough — an unfolded foldable phone is well over 700px but is still a touchscreen).
// Root cause: grid-layout-plus applies `touch-action: none` to the WHOLE grid item (title +
// body + canvas — its own injected `.vgl-item--no-touch` rule) on Android whenever the item is
// draggable or resizable, regardless of drag-allow-from — that scopes which element can START
// a drag, not the CSS, which blankets the entire card. The result: a finger-drag starting
// ANYWHERE on a card (canvas, chart body, even the title) can't scroll the page at all — only
// the gaps between cards can. Disabling both here (capability-based, not just width-based)
// keeps that class from ever applying, so the whole card is normal-scrollable again. A
// device's touch capability doesn't change at runtime, so this is computed once.
const touchCapable = isTouchDevice()
const dragEnabled = computed(() => !isMobile.value && !touchCapable)
</script>

<template>
  <div class="stats-grid" :class="{ 'controls-revealed': controlsVisible }">
    <GridLayout
      v-model:layout="widgets"
      :col-num="12"
      :row-height="40"
      :margin="[14, 14]"
      :is-draggable="dragEnabled"
      :is-resizable="dragEnabled"
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
          :drill-open="drillOpenId === item.id"
          :force-controls="controlsVisible"
          @edit="emit('edit', item)"
          @remove="emit('remove', item.id)"
          @duplicate="emit('duplicate', item)"
          @drill="emit('drill', $event)"
          @open-campaigns="emit('open-campaigns')"
        />
      </GridItem>
    </GridLayout>
  </div>
</template>

<style scoped>
:deep(.vgl-layout) {
  margin: 0 -7px;
}

/* Resize grip (bottom-right corner drag handle) — clean look by default (owner
   clarification, 2026-09-26): hidden unless the function bar is open OR that specific
   card is hovered. Hover-only on devices that actually have hover + a precise pointer —
   a touchscreen never matches this media query, so grips stay visible there (no hover to
   reveal them with). */
@media (hover: hover) and (pointer: fine) {
  :deep(.vgl-item__resizer) {
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  :deep(.vgl-item:hover .vgl-item__resizer) {
    opacity: 1;
  }
  .stats-grid.controls-revealed :deep(.vgl-item__resizer) {
    opacity: 1;
  }
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
