<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Chart, registerables, type ChartConfiguration } from 'chart.js'

Chart.register(...registerables)
// Draw synchronously (no rAF animation): snappier for a dashboard and ensures the
// first paint happens immediately even in headless/offscreen render contexts.
Chart.defaults.animation = false as unknown as typeof Chart.defaults.animation

const props = defineProps<{ config: ChartConfiguration }>()
const emit = defineEmits<{ point: [{ index: number; datasetIndex: number; x: number; y: number }] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const chart = shallowRef<Chart | null>(null)

function render() {
  if (!canvas.value) return
  chart.value?.destroy()
  chart.value = new Chart(canvas.value, props.config)
}

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
// (e.g. a date point) keep their tooltip visible, which is the only way to read a value on
// touch.
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
