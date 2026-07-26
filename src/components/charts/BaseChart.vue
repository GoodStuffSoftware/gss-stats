<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Chart, registerables, type ChartConfiguration } from 'chart.js'

Chart.register(...registerables)
// Draw synchronously (no rAF animation): snappier for a dashboard and ensures the
// first paint happens immediately even in headless/offscreen render contexts.
Chart.defaults.animation = false as unknown as typeof Chart.defaults.animation

const props = defineProps<{ config: ChartConfiguration; drillOpen: boolean }>()
const emit = defineEmits<{ point: [{ index: number; datasetIndex: number; x: number; y: number }] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const chart = shallowRef<Chart | null>(null)

function render() {
  if (!canvas.value) return
  chart.value?.destroy()
  chart.value = new Chart(canvas.value, props.config)
  if (props.drillOpen) setTooltipEnabled(false) // preserve suppression across a re-render (e.g. a data refresh) while the menu is still open
}

// The drill-down menu must never sit under the hover tooltip. clearActive() (below) only
// clears it once — Chart.js re-shows it on the next mousemove/touch — so while the menu is
// open we suppress the tooltip plugin outright, and restore it when the menu closes. Only one
// drill menu is open at a time, so it's fine for every chart to react to this the same way.
function setTooltipEnabled(enabled: boolean) {
  const c = chart.value
  if (!c) return
  const tooltip = (c.options.plugins as { tooltip?: { enabled?: boolean } } | undefined)?.tooltip
  if (!tooltip) return
  tooltip.enabled = enabled
  c.update('none')
}
watch(() => props.drillOpen, (open) => setTooltipEnabled(!open))

// Click on a bar/arc/point → tell the parent which data element was hit (for drill-down).
function onCanvasClick(e: MouseEvent) {
  const c = chart.value
  if (!c) return
  const els = c.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false)
  if (!els.length) return
  e.stopPropagation() // keep this click from reaching the document (which closes the drill menu)
  emit('point', { index: els[0].index, datasetIndex: els[0].datasetIndex, x: e.clientX, y: e.clientY })
}

// Dismiss the hover tooltip + highlight. The parent calls this only when a drill-down menu
// actually opens at the tap spot, so the two don't overlap — while taps that DON'T drill
// (e.g. a non-drillable dimension) keep their tooltip visible, which is the only way to read
// a value on touch. This is just the immediate clear at click-time; the drillOpen watcher
// above keeps the tooltip suppressed for as long as the menu stays open.
function clearActive() {
  const c = chart.value
  if (!c) return
  c.setActiveElements([])
  ;(c.tooltip as { setActiveElements?: (e: unknown[], p: { x: number; y: number }) => void } | undefined)?.setActiveElements(
    [],
    { x: 0, y: 0 },
  )
  c.update('none')
}
defineExpose({ clearActive })

onMounted(() => {
  render()
  canvas.value?.addEventListener('click', onCanvasClick)
})
watch(() => props.config, render)
onBeforeUnmount(() => {
  canvas.value?.removeEventListener('click', onCanvasClick)
  chart.value?.destroy()
  chart.value = null
})
</script>

<template>
  <div class="chart-wrap">
    <canvas ref="canvas"></canvas>
  </div>
</template>

<style scoped>
.chart-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.chart-wrap canvas {
  cursor: pointer; /* data elements are clickable → drill-down */
}
</style>
