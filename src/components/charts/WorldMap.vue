<script setup lang="ts">
import { ref, onMounted, watch, onBeforeUnmount } from 'vue'
import type { StatsResponse } from '../../types'

const props = defineProps<{ data: StatsResponse | null }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const wrap = ref<HTMLElement | null>(null)
let ro: ResizeObserver | null = null

// Natural Earth land (110m) GeoJSON, fetched once and shared across map charts.
const LAND_URL = 'https://cdn.jsdelivr.net/gh/martynafford/natural-earth-geojson/110m/physical/ne_110m_land.json'
let landData: any = null
let landRequested = false
function fetchLand() {
  if (landRequested) return
  landRequested = true
  fetch(LAND_URL)
    .then((r) => r.json())
    .then((j) => {
      landData = j
      draw()
    })
    .catch(() => {
      landData = { features: [] }
    })
}

const isDark = () => document.documentElement.classList.contains('dark')

function draw() {
  const cv = canvas.value
  const box = wrap.value
  if (!cv || !box) return
  const dpr = window.devicePixelRatio || 1
  const W = box.clientWidth
  const H = box.clientHeight
  if (W < 2 || H < 2) return
  cv.width = W * dpr
  cv.height = H * dpr
  cv.style.width = W + 'px'
  cv.style.height = H + 'px'
  const ctx = cv.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)

  const mapW = Math.min(W, H * 2)
  const mapH = mapW / 2
  const ox = (W - mapW) / 2
  const oy = (H - mapH) / 2
  const proj = (lon: number, lat: number): [number, number] => [ox + ((lon + 180) / 360) * mapW, oy + ((90 - lat) / 180) * mapH]

  // Ocean panel (always drawn, so the map shows immediately).
  ctx.fillStyle = isDark() ? 'rgba(231,226,215,0.05)' : 'rgba(26,23,21,0.035)'
  ctx.fillRect(ox, oy, mapW, mapH)

  // Continents (once the geojson has loaded).
  if (landData?.features) {
    ctx.fillStyle = isDark() ? 'rgba(231,226,215,0.16)' : 'rgba(26,23,21,0.11)'
    for (const f of landData.features) {
      const g = f.geometry
      if (!g) continue
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
      for (const poly of polys) {
        for (const ring of poly) {
          ctx.beginPath()
          ring.forEach((c: number[], i: number) => {
            const [x, y] = proj(c[0], c[1])
            if (i) ctx.lineTo(x, y)
            else ctx.moveTo(x, y)
          })
          ctx.closePath()
          ctx.fill()
        }
      }
    }
  }

  // Visitor points.
  const rows = props.data?.rows ?? []
  const max = Math.max(1, ...rows.map((r) => r.pageviews))
  for (const r of rows) {
    const lat = parseFloat(r.key.lat)
    const lon = parseFloat(r.key.lon)
    if (!isFinite(lat) || !isFinite(lon)) continue
    const [x, y] = proj(lon, lat)
    const rad = 3 + Math.sqrt(r.pageviews / max) * 9
    ctx.beginPath()
    ctx.arc(x, y, rad, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(224,114,44,0.50)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(224,114,44,0.95)'
    ctx.lineWidth = 1
    ctx.stroke()
  }
}

onMounted(() => {
  draw()
  fetchLand()
  ro = new ResizeObserver(draw)
  if (wrap.value) ro.observe(wrap.value)
})
watch(() => props.data, draw)
onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <div ref="wrap" class="map-wrap"><canvas ref="canvas"></canvas></div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
canvas {
  display: block;
}
</style>
