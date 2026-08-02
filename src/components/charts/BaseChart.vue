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

// The drill-down menu must never sit under the hover tooltip. While THIS chart's own menu is
// open we suppress its tooltip plugin outright, and restore it when the menu closes.
// `drillOpen` is scoped to the widget that actually owns the open menu (see ChartCard/
// Dashboard/App), so only that one chart's tooltip is ever touched — a menu stuck open can't
// kill every other chart's hover.
//
// Chart.js's `tooltip.enabled` flag only gates the DRAW step — it does NOT clear `_active`/
// opacity. Toggling it alone leaves the tooltip's internal hover state exactly as it was, so
// re-enabling redraws whatever was last active with NO new mouse event — a "ghost" tooltip
// frozen on a stale (or entirely unrelated, since hit-testing keeps running while suppressed)
// bar. Explicitly clearing active elements on EVERY toggle — both suppressing and restoring —
// closes that gap: hover always starts clean and only reflects a genuinely new mousemove.
function setTooltipEnabled(enabled: boolean) {
  const c = chart.value
  if (!c) return
  const tooltip = (c.options.plugins as { tooltip?: { enabled?: boolean } } | undefined)?.tooltip
  if (!tooltip) return
  c.setActiveElements([])
  ;(c.tooltip as { setActiveElements?: (e: unknown[], p: { x: number; y: number }) => void } | undefined)?.setActiveElements(
    [],
    { x: 0, y: 0 },
  )
  tooltip.enabled = enabled
  c.update('none')
}
// The RESTORE side (menu closes → re-enable) stays reactive: there's no tap event racing to
// re-show a tooltip at that instant, so a same-tick-or-so watcher firing is plenty timely.
watch(() => props.drillOpen, (open) => {
  if (!open) setTooltipEnabled(true)
})

// ── Touch: tap shows the tooltip only; a LONG-PRESS opens the drill menu ────────────────────
// (Mike: "tap will be the tooltip, hold will be the drill down.") Mouse is untouched — click
// still drills immediately, see onCanvasClick below.
//
// Discrimination: every physical touch also synthesizes a compat click afterward (touchstart →
// touchend → mouseover/mousemove/mousedown/mouseup → click), and Chart.js's own `events` list
// (mousemove/mouseout/click/touchstart/touchmove — no pointer events) never touches Pointer
// Events at all, so listening for pointerdown/move/up/cancel is a clean, independent channel:
// `e.pointerType` tells touch from mouse directly, and — because these never fire for
// pointerType 'mouse' — none of this code runs (or changes behavior) for a real mouse at all.
// The one thing touch and mouse DO share is that single trailing compat click, which is why
// onCanvasClick still needs the suppressNextClick guard below.
const LONG_PRESS_MS = 500 // within the requested 450-550ms; matches common OS long-press timing
const MOVE_SLOP_PX = 10 // more movement than this before the timer fires = a scroll, not a hold

let activePointerId: number | null = null
let pressStartX = 0
let pressStartY = 0
let pressEl: { index: number; datasetIndex: number } | null = null
let longPressTimer: number | undefined
let suppressNextClick = false

function clearPress() {
  if (longPressTimer != null) clearTimeout(longPressTimer)
  longPressTimer = undefined
  activePointerId = null
  pressEl = null
}

function onPointerDown(e: PointerEvent) {
  if (e.pointerType !== 'touch') return
  const c = chart.value
  if (!c) return
  // One finger at a time — but only while a press is genuinely in flight (timer still pending).
  // If activePointerId is set with no pending timer, it's STALE: the long-press already fired,
  // or a pointerup/cancel never reached us (setPointerCapture is best-effort and can throw, and
  // an uncaptured finger lifting off-canvas delivers pointerup elsewhere). Without this reset a
  // single missed lift would leave the id set forever and silently kill long-press on this
  // chart until it re-mounts, so treat a stale id as free and start the new press.
  if (activePointerId != null && longPressTimer != null) return
  if (activePointerId != null) clearPress()
  // PointerEvent is mouse-event-shaped (clientX/Y, offsetX/Y) and is NOT a TouchEvent (no
  // `.touches`), so Chart.js's own getRelativePosition() reads it exactly like a MouseEvent —
  // confirmed by reading its actual implementation (helpers.dataset.js: getCanvasPosition only
  // branches on `e.touches`, which a PointerEvent never has, then falls through to
  // offsetX/offsetY or clientX/clientY minus the canvas rect — same as a mouse click). No
  // manual coordinate math needed.
  const els = c.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false)
  if (!els.length) return // not over a data element — let the touch pass through untouched
  activePointerId = e.pointerId
  pressStartX = e.clientX
  pressStartY = e.clientY
  pressEl = { index: els[0].index, datasetIndex: els[0].datasetIndex }
  // Keep tracking this finger even if it wanders off the canvas (e.g. into a scroll) — without
  // capture, a lift-off outside the canvas would never reach our pointerup and the timer could
  // fire long after the gesture visibly ended. Capture only affects which element RECEIVES the
  // pointer's events; it does not itself block the browser's native scroll/pan handling. Guard
  // it: the browser throws NotFoundError if it doesn't consider this pointer "active" (verified
  // directly — a synthetic/edge-case pointerId can hit this), and that must not abort the rest
  // of this function, or the long-press timer below would silently never start.
  try {
    canvas.value?.setPointerCapture(e.pointerId)
  } catch {
    /* best-effort — the timer below still works via normal (uncaptured) event delivery */
  }
  longPressTimer = window.setTimeout(fireLongPress, LONG_PRESS_MS)
}

function onPointerMove(e: PointerEvent) {
  if (e.pointerType !== 'touch' || e.pointerId !== activePointerId || longPressTimer == null) return
  const dx = e.clientX - pressStartX
  const dy = e.clientY - pressStartY
  // Moved beyond the slop → this is a scroll/drag, not a hold. Cancel and do NOT preventDefault
  // anything — the page must keep scrolling normally (see Dashboard.vue for the other half of
  // that fix: grid-layout-plus's own touch-action:none is what used to block it).
  if (Math.hypot(dx, dy) > MOVE_SLOP_PX) clearPress()
}

function onPointerUp(e: PointerEvent) {
  if (e.pointerType !== 'touch' || e.pointerId !== activePointerId) return
  // Whether this resolved as a short tap or an already-fired long-press, the browser still
  // synthesizes exactly one compat click right after touchend — swallow that one. (Safety net:
  // auto-clear after a short window in case that click never actually arrives, so the flag can
  // never leak into suppressing some LATER, unrelated click.)
  suppressNextClick = true
  setTimeout(() => {
    suppressNextClick = false
  }, 500)
  clearPress() // if the timer hadn't fired yet, this was a short tap — nothing more to do; the
  // tooltip is already showing, via Chart.js's own touchstart-as-hover. That IS the tap result.
}

function onPointerCancel(e: PointerEvent) {
  if (e.pointerType !== 'touch' || e.pointerId !== activePointerId) return
  clearPress() // the browser took the gesture over (e.g. committed to a native scroll) — no
  // compat click follows a cancelled touch, so no need to suppress one.
}

function fireLongPress() {
  const c = chart.value
  const el = pressEl
  longPressTimer = undefined // mark fired, so a later pointerup treats this as "already handled"
  if (!c || !el) return
  navigator.vibrate?.(10) // best-effort haptic confirmation; silently no-ops where unsupported
  emit('point', { index: el.index, datasetIndex: el.datasetIndex, x: pressStartX, y: pressStartY })
}

// Click on a bar/arc/point → tell the parent which data element was hit (for drill-down). On
// MOUSE this is the whole interaction (click = drill immediately), exactly as before. On TOUCH
// the compat click that follows every tap/long-press is swallowed by suppressNextClick (set in
// onPointerUp above) — the touch path decides for itself via the pointer handlers, so this
// never double-fires (long-press) or wrongly opens the menu (plain tap) for it.
function onCanvasClick(e: MouseEvent) {
  if (suppressNextClick) {
    suppressNextClick = false
    // Stop this one here too, same reason as below: a long-press fires its drill BEFORE this
    // trailing compat click arrives, so without this the click would bubble to document's
    // "click outside closes the menu" listener and immediately close the menu the long-press
    // just opened. (Verified directly: without this line the menu opened and then instantly
    // vanished.) Harmless when nothing opened (a plain tap) — document's handler just no-ops.
    e.stopPropagation()
    return
  }
  const c = chart.value
  if (!c) return
  const els = c.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false)
  if (!els.length) return
  e.stopPropagation() // keep this click from reaching the document (which closes the drill menu)
  emit('point', { index: els[0].index, datasetIndex: els[0].datasetIndex, x: e.clientX, y: e.clientY })
}

// Suppress THIS chart's tooltip for an about-to-open drill menu. The parent calls this
// SYNCHRONOUSLY, in the same call stack as the click/tap that's about to emit the drill —
// deliberately NOT via the (async) `drillOpen` prop/watcher above, and deliberately doing the
// full disable here rather than only clearing active elements.
//
// Why: on touch, Chart.js treats touchstart (and the synthetic mousemove browsers dispatch as
// part of touch→click compatibility) as hover-equivalent — so a stray touchmove/mousemove can
// land in the gap between "we decided to drill" and "Vue's watcher got around to disabling the
// tooltip." Verified by reproducing it directly: after clearing active elements alone (leaving
// `tooltip.enabled` untouched until the watcher runs), a hover landing in that gap redrew the
// tooltip — it stayed enabled the whole time, so nothing stopped it. Setting `enabled: false`
// HERE, before returning control to the browser's event loop, closes the window entirely: by
// the time any further event can fire, the plugin can no longer draw, no matter how it's
// triggered. The watcher's OWN (now redundant) open-side effect was removed above so there's
// exactly one code path that suppresses — no risk of the two disagreeing.
function suppressForDrill() {
  setTooltipEnabled(false)
}
defineExpose({ suppressForDrill })

// Long-press needs its own context menu suppressed too — Android/some browsers can pop the
// native "hold" context menu on a canvas otherwise, right on top of our own bottom sheet.
function onContextMenu(e: Event) {
  e.preventDefault()
}

onMounted(() => {
  render()
  const el = canvas.value
  el?.addEventListener('click', onCanvasClick)
  el?.addEventListener('pointerdown', onPointerDown)
  el?.addEventListener('pointermove', onPointerMove)
  el?.addEventListener('pointerup', onPointerUp)
  el?.addEventListener('pointercancel', onPointerCancel)
  el?.addEventListener('contextmenu', onContextMenu)
})
watch(() => props.config, render)
onBeforeUnmount(() => {
  clearPress()
  const el = canvas.value
  el?.removeEventListener('click', onCanvasClick)
  el?.removeEventListener('pointerdown', onPointerDown)
  el?.removeEventListener('pointermove', onPointerMove)
  el?.removeEventListener('pointerup', onPointerUp)
  el?.removeEventListener('pointercancel', onPointerCancel)
  el?.removeEventListener('contextmenu', onContextMenu)
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
  /* Kill the mobile "blue square" tap-highlight + selection/callout chrome a long-press would
     otherwise trigger. Applied here, at the canvas, since that's the actual element our click/
     pointer listeners are on — not .chart-wrap or the outer .chart-card. */
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none; /* no iOS "save image" callout on hold */
  -webkit-user-select: none;
  user-select: none;
  /* Allow native vertical scroll (the dashboard scrolls vertically); everything else
     (horizontal pan, pinch-zoom) is ours to interpret via the pointer handlers above, not the
     browser's. Vertical scroll competing with our long-press is exactly what the slop/cancel
     logic in the pointer handlers resolves — this just makes sure a vertical drag is free to
     become a real scroll instead of the browser refusing to hand it off at all. */
  touch-action: pan-y;
}
</style>
