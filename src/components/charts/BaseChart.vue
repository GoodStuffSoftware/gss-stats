<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { Chart, registerables, type ChartConfiguration } from 'chart.js'

Chart.register(...registerables)
// Draw synchronously (no rAF animation): snappier for a dashboard and ensures the
// first paint happens immediately even in headless/offscreen render contexts.
Chart.defaults.animation = false as unknown as typeof Chart.defaults.animation

const props = defineProps<{ config: ChartConfiguration }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const chart = shallowRef<Chart | null>(null)

function render() {
  if (!canvas.value) return
  chart.value?.destroy()
  chart.value = new Chart(canvas.value, props.config)
}

onMounted(render)
watch(() => props.config, render)
onBeforeUnmount(() => {
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
</style>
