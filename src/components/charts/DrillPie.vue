<script lang="ts">
// Types of the generic drill-down pie (a normal script block so other files can import them).
export interface PieSlice {
  /** Reported by `select`. Unique among the slices. */
  key: string
  label: string
  /** Size of the slice; slices with a value <= 0 are not drawn. */
  value: number
  /** Resolved colour (#rrggbb): a canvas cannot read CSS variables. */
  color: string
  /** Small text under the label in the list. */
  detail?: string
  /** A folded slice (a bucket of small ones): drawn, listed, never reported by `select`. */
  inert?: boolean
  /** The slices a bucket holds. A slice with members is not inert: picking it opens or closes a list of them under
   * its row (a member picked from that list is reported by `select`), instead of being reported itself. */
  members?: PieSlice[]
}

/** How the pie that is about to be drawn relates to the one on screen. `in`: `key` is the slice of the pie on screen
 * that was picked (the new slices grow out of its wedge). `out`: `key` is the slice, in the new pie, that the user
 * came back from (the pie grows around it). A slice inside a folded bucket counts as the bucket's wedge. */
export interface PieTransition {
  key: string
  dir: 'in' | 'out'
}

/** The label alternatives for one slice, longest first: the first that fits the arc is drawn. */
export function sliceLabelParts(amount: string, share: number): string[] {
  return [`${amount} · ${share}%`, amount, `${share}%`]
}

// ── Size of the donut (opt-in: `resizable`, `wide`, `sizeKey`; see the header of the script below) ──────────────
/** The smallest donut a person can drag or step it to, in px (the square that holds the ring and its labels). */
export const DONUT_MIN = 200
/** `wide` takes effect from this width of the room the pie has; below it the pie is laid out as without `wide`. */
export const WIDE_MIN_PX = 640
/** The narrowest a legend column is allowed to get, and the gap between the donut and the legend. */
export const LEGEND_COL_PX = 240
export const WIDE_GAP_PX = 24
/** Step of an arrow key on the resize handle. */
export const DONUT_STEP = 16

/** A size kept within DONUT_MIN and `max` (a `max` that is not a positive number is no upper limit). */
export function clampDonutSize(n: number, max = Infinity): number {
  const hi = Number.isFinite(max) && max > 0 ? Math.max(DONUT_MIN, max) : Infinity
  return Math.round(Math.min(hi, Math.max(DONUT_MIN, n)))
}

/** What the room (`box`, the width the pie has, 0 = not measured) allows: whether the wide layout applies (the donut
 * beside the legend), the largest donut (the whole width; with the wide layout one legend column is left), and the
 * donut's automatic size there (null without the wide layout: the stylesheet decides). */
export function donutLayout(box: number, wide: boolean): { wideOn: boolean; max: number; auto: number | null } {
  if (!(box > 0)) return { wideOn: false, max: Infinity, auto: null }
  const wideOn = wide && box >= WIDE_MIN_PX
  const max = Math.max(DONUT_MIN, wideOn ? box - LEGEND_COL_PX - WIDE_GAP_PX : box)
  const auto = wideOn ? Math.min(max, Math.max(320, Math.min(680, Math.round(box * 0.4)))) : null
  return { wideOn, max, auto }
}

/** A saved size, or null when there is none or it cannot be read. Never throws. */
export function readDonutSize(key: string | undefined): number | null {
  if (!key) return null
  try {
    const n = Number(globalThis.localStorage?.getItem(key))
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null
  } catch {
    return null
  }
}

/** Keep (a number) or forget (null) the size under `key`. Never throws: a failed write lasts this visit only. */
export function writeDonutSize(key: string | undefined, size: number | null): void {
  if (!key) return
  try {
    if (size === null) globalThis.localStorage?.removeItem(key)
    else globalThis.localStorage?.setItem(key, String(Math.round(size)))
  } catch {
    // storage full, blocked or unavailable
  }
}
</script>

<script setup lang="ts">
// A generic doughnut whose slices can be picked, with a list of the same slices under it (the way in for a
// keyboard, a screen reader and a phone, where a tap on the canvas only shows the tooltip). It knows nothing
// about what the slices are: the parent maps its data to PieSlice[] and decides what `select` means (drill
// down, open a detail). Every new `slices` array draws a fresh chart; an identical array does not redraw.
//
// Motion (lib/pieMotion.ts): a pie that appears for different slices plays in, with or without
// prefers-reduced-motion (a short one-shot, and the only sign a level opened; see ADR 0007). `transition` says
// where it comes from: a picked slice (`in`: the new slices grow out of that wedge), the slice you came back
// from (`out`: the pie grows around it), or nothing (a clockwise sweep from the top). A redraw with the same
// slices (a theme switch, new numbers) plays nothing. The parent keeps this one component instance across
// levels, so the pie on screen stays until the new slices arrive.
// Labels (arcLabelsPlugin in lib/charts.ts): a slice with room shows its name on the arc, and its amount and
// share (or just one of them) when those fit too; a slice with no room gets its name and share outside the ring
// on a leader line (cut with an ellipsis to the room there is; dropped, smallest first, when there is none), once
// the motion has settled. The chart's layout padding is the room for them, wider as the chart is.
// Picking: by default a click on a slice picks it. With `deliberate`, picking follows the input (lib/pieGesture.ts):
// a mouse picks with one click (the hover tooltip stays; a double-click still opens one level only, because clicks
// are ignored while the new level arrives and moves, and for a moment after), and a touch or pen shows only the
// tooltip on a tap and picks with a double-tap or a press held for half a second. A hint under the pie says which
// (a fine pointer with hover: click; anything else: press and hold), and the mouse cursor is a pointer over a slice
// that can be picked. The list rows pick with one click either way.
//
// Props
//   slices:  PieSlice[]
//   dark:    boolean                       site theme (the slice border)
//   animate: boolean (true)                false = no motion at all
//   transition: PieTransition              where the next set of slices comes from (see above)
//   deliberate: boolean (false)            picking a slice on the chart follows the input: click (mouse), or
//                                          double-tap / hold (touch, pen)
//   format:  (value: number) => string     text for a value (default: String)
//   label:   string                        accessible name of the chart and its list
//   resizable: boolean (false)             a handle in the donut's corner: drag it, or press the arrow keys (16 px a
//                                          step), to make the donut bigger or smaller; double-click or Delete resets
//   wide:    boolean (false)               when the pie has 640 px or more of width, the donut sits beside the legend,
//                                          the donut bigger and the legend in as many columns as fit (a name, its value
//                                          and its share stay together in a row)
//   sizeKey: string                        where the chosen size is kept on this device (localStorage); the caller names
//                                          it, so one size can belong to one chart in one layout. No key: not kept.
// With all three off the pie is laid out and sized exactly as before.
// Emits
//   select(key: string)                    a slice or its list row was picked (never for an `inert` slice, nor for a
//                                          slice with `members`: that one opens its list; its members are reported)
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Chart, type ChartConfiguration } from 'chart.js'
import { arcLabelsPlugin } from '../../lib/charts'
import { createPieGesture, type PieGesture } from '../../lib/pieGesture'
import { MOTION_MS, pieMotionPlugin, type PieMotion } from '../../lib/pieMotion'
import BaseChart from './BaseChart.vue'

const props = withDefaults(
  defineProps<{
    slices: PieSlice[]
    dark: boolean
    animate?: boolean
    transition?: PieTransition
    deliberate?: boolean
    format?: (value: number) => string
    label?: string
    resizable?: boolean
    wide?: boolean
    sizeKey?: string
  }>(),
  { animate: true, deliberate: false, format: (v: number) => String(v), label: 'Pie chart', resizable: false, wide: false, sizeKey: undefined },
)
const emit = defineEmits<{ select: [key: string] }>()

// ── Slices and chart config ──────────────────────────────────────────────────────────────────────────────
const drawn = computed(() => props.slices.filter((s) => s.value > 0))
const total = computed(() => drawn.value.reduce((n, s) => n + s.value, 0))
const share = (v: number) => (total.value > 0 ? Math.round((v / total.value) * 100) : 0)

const BORDER_LIGHT = '#FFFFFF'
const BORDER_DARK = '#211C18'
// On-slice text: sized for a ring about 70 px thick; the ink is the better-contrast of near-black and white.
const LABEL_LOOK = {
  nameFont: '600 12px Inter, system-ui, sans-serif',
  subFont: '700 11px "Space Grotesk", system-ui, sans-serif',
  bestContrast: true,
  fit: true,
}
// Outside labels: the name in a lighter weight than the on-slice one; ink and leader line by theme (a canvas cannot
// read CSS variables).
const OUTSIDE_LOOK = {
  font: '500 11px Inter, system-ui, sans-serif',
  light: { ink: '#1A1715', line: 'rgba(26, 23, 21, 0.45)' },
  dark: { ink: '#F4F1EA', line: 'rgba(244, 241, 234, 0.5)' },
}
// Room around the ring for the outside labels: a share of the chart's width, within limits (a phone keeps a ring of
// a sensible size; a wide chart has the room), and a little above and below.
const PAD_V = 18
function layoutPadding(ctx: { chart: { width: number } }) {
  const h = Math.min(92, Math.max(52, Math.round(ctx.chart.width * 0.17)))
  return { left: h, right: h, top: PAD_V, bottom: PAD_V }
}

// The slices' wedges as shares of the circle, in drawn order.
function wedges(list: PieSlice[]): Map<string, { from: number; to: number }> {
  const sum = list.reduce((n, s) => n + s.value, 0)
  const out = new Map<string, { from: number; to: number }>()
  let run = 0
  for (const s of list) {
    const from = sum > 0 ? run / sum : 0
    run += s.value
    out.set(s.key, { from, to: sum > 0 ? run / sum : 0 })
  }
  return out
}
const keysOf = (list: PieSlice[]) => list.map((x) => x.key)

/** A slice's wedge in a list; a member of a folded bucket takes the bucket's wedge. */
function wedgeOf(list: PieSlice[], key: string): { from: number; to: number } | null {
  const all = wedges(list)
  const hit = all.get(key)
  if (hit) return hit
  const bucket = list.find((x) => x.members?.some((m) => m.key === key))
  return bucket ? (all.get(bucket.key) ?? null) : null
}

/** How the pie plays in: decided once per set of slices (see the header). `before` is the pie that was on screen. */
function chooseMotion(before: PieSlice[], list: PieSlice[]): PieMotion {
  if (!props.animate) return { kind: 'none' }
  const t = props.transition
  if (t && t !== handled) {
    if (t.dir === 'in') {
      const w = wedgeOf(before, t.key)
      if (w) return { kind: 'expand', from: w.from, to: w.to }
    } else {
      const w = wedgeOf(list, t.key)
      if (w) return { kind: 'unfurl', mid: (w.from + w.to) / 2 }
    }
  }
  return { kind: 'unfurl', mid: 0 }
}

function buildConfig(motion: PieMotion): ChartConfiguration {
  const s = drawn.value
  const formatValue = props.format
  const items = s.map((x) => ({
    name: x.label,
    sub: sliceLabelParts(formatValue(x.value), share(x.value)),
    tail: `${share(x.value)}%`,
  }))
  const motionPlugin = pieMotionPlugin({ motion })
  const look = {
    ...LABEL_LOOK,
    outside: { ...(props.dark ? OUTSIDE_LOOK.dark : OUTSIDE_LOOK.light), font: OUTSIDE_LOOK.font, ready: () => motionPlugin.settled() },
  }
  return {
    type: 'doughnut',
    data: {
      labels: s.map((x) => x.label),
      datasets: [
        {
          data: s.map((x) => x.value),
          backgroundColor: s.map((x) => x.color),
          borderColor: props.dark ? BORDER_DARK : BORDER_LIGHT,
          borderWidth: 2,
          hoverOffset: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '58%',
      layout: { padding: layoutPadding },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${formatValue(Number(ctx.raw))} (${share(Number(ctx.raw))}%)`,
          },
        },
      },
    },
    // Order matters: the labels are drawn on the moved arcs, then the motion puts the arcs back.
    plugins: [arcLabelsPlugin({ 0: items }, look), motionPlugin],
  } as ChartConfiguration
}

// Rebuild only when something that shows changed, so a refetch that returns the same numbers does not redraw.
// The motion plays only when the SET of slices changed (a new level), not for a theme switch or new numbers.
const signature = computed(() =>
  JSON.stringify([drawn.value.map((x) => [x.key, x.label, x.value, x.color]), props.dark, props.animate]),
)
const keysSignature = computed(() => keysOf(drawn.value).join('\u0001'))
// A mouse click picks a slice (see the gesture), so a habitual double-click must not pick twice: after a pick,
// mouse clicks are ignored until the new slices have arrived (at most WAIT_MAX_MS: a pick that opens nothing new
// must not lock the pie), while the motion plays, and for SETTLE_MS after it. Plain variables: only the gesture
// reads them.
const WAIT_MAX_MS = 1500
const SETTLE_MS = 250
let waiting = false
let lockedUntil = 0
let waitTimer: ReturnType<typeof setTimeout> | undefined
function startWaiting() {
  waiting = true
  clearTimeout(waitTimer)
  waitTimer = setTimeout(() => {
    waiting = false
  }, WAIT_MAX_MS)
}
function arrived(motion: PieMotion) {
  waiting = false
  clearTimeout(waitTimer)
  lockedUntil = Date.now() + (motion.kind === 'none' ? 0 : MOTION_MS[motion.kind]) + SETTLE_MS
}
const blocked = () => waiting || Date.now() < lockedUntil
let playedFor: string | null = null
let onScreen: PieSlice[] = [] // the slices of the pie now drawn
let handled: PieTransition | undefined // the transition already used (or found not to apply)
const opened = ref<ReadonlySet<string>>(new Set())
function build(): ChartConfiguration {
  const replay = keysSignature.value !== playedFor
  const before = onScreen
  playedFor = keysSignature.value
  onScreen = drawn.value
  const motion: PieMotion = replay ? chooseMotion(before, drawn.value) : { kind: 'none' }
  handled = props.transition
  if (replay) opened.value = new Set() // a new level starts with every folded bucket closed
  if (replay && waiting) arrived(motion)
  return buildConfig(motion)
}
const config = shallowRef<ChartConfiguration>(build())
watch(signature, () => {
  config.value = build()
})

function toggleMembers(key: string) {
  const next = new Set(opened.value)
  if (!next.delete(key)) next.add(key)
  opened.value = next
}
const isOpen = (s: PieSlice) => !!s.members?.length && opened.value.has(s.key)
function pick(s: PieSlice) {
  if (s.members?.length) toggleMembers(s.key)
  else if (!s.inert) emit('select', s.key)
}

function onPoint(p: { index: number }) {
  if (props.deliberate) return // the chart's own click and long-press are not enough: see the gesture below
  const s = drawn.value[p.index]
  if (s) pick(s)
}

// Which hint fits the input: a fine pointer that can hover (a mouse, a trackpad) clicks; anything else holds.
const FINE_POINTER = '(hover: hover) and (pointer: fine)'
const fineQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(FINE_POINTER) : null
const finePointer = ref(!!fineQuery?.matches)
const onFineChange = () => {
  finePointer.value = !!fineQuery?.matches
}

// The deliberate gesture (props.deliberate): listens on the canvas's wrapper, ahead of the chart's own handlers.
const canvasBox = ref<HTMLElement | null>(null)
let gesture: PieGesture | null = null
let detach: (() => void) | null = null
function sliceAt(e: { clientX: number; clientY: number }): number | null {
  const canvas = canvasBox.value?.querySelector('canvas')
  const chart = canvas ? Chart.getChart(canvas) : undefined
  const hit = chart?.getElementsAtEventForMode(e as unknown as Event, 'nearest', { intersect: true }, false)[0]
  return hit ? hit.index : null
}
onMounted(() => {
  const box = canvasBox.value
  if (!box) return
  const g = createPieGesture({
    hit: sliceAt,
    blocked,
    open: (i) => {
      const s = drawn.value[i]
      if (!s) return
      if (!s.members?.length && !s.inert) startWaiting() // a new level is on its way: see blocked
      pick(s)
    },
  })
  gesture = g
  // a pointer cursor over a slice that a click can pick (a mouse only: a finger has no cursor)
  const setCursor = (e: { pointerType?: string; clientX: number; clientY: number }) => {
    if (e.pointerType && e.pointerType !== 'mouse') return
    const i = sliceAt(e)
    const s = i === null ? undefined : drawn.value[i]
    box.style.cursor = s && !s.inert ? 'pointer' : ''
  }
  const on = (type: string, fn: (e: never) => void) => {
    const handler = (e: Event) => {
      if ((e.target as Element | null)?.closest?.('.dp-resize')) return // the resize handle is not a slice
      if (props.deliberate) fn(e as never)
    }
    box.addEventListener(type, handler, true)
    return () => box.removeEventListener(type, handler, true)
  }
  const offs = [
    on('pointerdown', (e) => g.pointerdown(e)),
    on('pointermove', (e) => {
      g.pointermove(e)
      setCursor(e)
    }),
    on('pointerup', (e) => g.pointerup(e)),
    on('pointercancel', (e) => g.pointercancel(e)),
    on('pointerleave', (e) => {
      g.pointerleave(e)
      box.style.cursor = ''
    }),
    on('click', (e) => g.click(e)),
    on('dblclick', (e) => g.dblclick(e)),
  ]
  detach = () => offs.forEach((off) => off())
})
onMounted(() => {
  fineQuery?.addEventListener?.('change', onFineChange)
  onFineChange()
})
watch(
  () => props.deliberate,
  (on) => {
    if (!on && canvasBox.value) canvasBox.value.style.cursor = ''
  },
)

// ── Size of the donut ────────────────────────────────────────────────────────────────────────────────────
const rootEl = ref<HTMLElement | null>(null)
const room = ref(0) // the width the pie has, in px (0 = not measured)
const saved = ref<number | null>(readDonutSize(props.sizeKey)) // null = the automatic size
const layout = computed(() => donutLayout(room.value, props.wide))
/** The size the donut has now: the saved one within the room there is, else the automatic one (null = stylesheet). */
const size = computed<number | null>(() => (saved.value === null ? layout.value.auto : clampDonutSize(saved.value, layout.value.max)))
const sizeMax = computed(() => (Number.isFinite(layout.value.max) ? layout.value.max : undefined))
watch(
  () => props.sizeKey,
  (key) => {
    saved.value = readDonutSize(key)
  },
)
const canvasStyle = computed(() => (size.value === null ? undefined : { width: `${size.value}px`, height: `${size.value}px`, maxWidth: 'none', maxHeight: 'none' }))
const rootStyle = computed(() => (layout.value.wideOn && size.value !== null ? { '--dp-size': `${size.value}px` } : undefined))

// The pie's own box can be display: contents (side by side), which has no width: use the nearest ancestor that has one.
function roomElement(): HTMLElement | null {
  let el: HTMLElement | null = rootEl.value
  while (el && !(el.clientWidth > 0)) el = el.parentElement
  return el
}
function measure() {
  room.value = roomElement()?.clientWidth ?? 0
}
let resizeObserver: ResizeObserver | undefined
onMounted(() => {
  measure()
  window.addEventListener('resize', measure)
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(measure)
    const el = roomElement()
    if (el) resizeObserver.observe(el)
  }
})

// The handle. A drag grows the donut by the larger of the two movements; centred (not wide) the corner moves half as
// far as the size changes, so the movement counts twice.
let drag: { id: number; x: number; y: number; start: number } | null = null
const renderedSize = () => Math.round(canvasBox.value?.getBoundingClientRect().width || size.value || DONUT_MIN)
function setSaved(n: number | null) {
  saved.value = n === null ? null : clampDonutSize(n, layout.value.max)
}
function dragStart(e: PointerEvent) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    // no capture: the drag still follows the pointer while it is over the handle
  }
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: renderedSize() }
}
function dragMove(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return
  const dx = e.clientX - drag.x
  const dy = e.clientY - drag.y
  const d = Math.abs(dx) >= Math.abs(dy) ? dx : dy
  setSaved(drag.start + d * (layout.value.wideOn ? 1 : 2))
}
function dragEnd(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return
  const done = drag
  drag = null
  try {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  } catch {
    // already released
  }
  if (saved.value !== null && saved.value !== done.start) writeDonutSize(props.sizeKey, saved.value)
}
function resetSize() {
  saved.value = null
  writeDonutSize(props.sizeKey, null)
}
function onHandleKey(e: KeyboardEvent) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? DONUT_STEP : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -DONUT_STEP : 0
  if (step) {
    e.preventDefault()
    setSaved((size.value ?? renderedSize()) + step)
    writeDonutSize(props.sizeKey, saved.value)
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    resetSize()
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  resizeObserver?.disconnect()
  detach?.()
  gesture?.destroy()
  clearTimeout(waitTimer)
  fineQuery?.removeEventListener?.('change', onFineChange)
})
</script>

<template>
  <div ref="rootEl" class="drill-pie" :class="{ 'dp-wide': layout.wideOn }" :style="rootStyle" data-testid="drill-pie">
    <div ref="canvasBox" class="dp-canvas" :style="canvasStyle" v-bind="resizable ? {} : { role: 'img', 'aria-label': label }">
      <BaseChart v-if="resizable" :config="config" :drill-open="false" role="img" :aria-label="label" @point="onPoint" />
      <BaseChart v-else :config="config" :drill-open="false" @point="onPoint" />
      <span
        v-if="resizable"
        class="dp-resize"
        role="slider"
        tabindex="0"
        aria-label="Resize chart"
        :aria-valuemin="DONUT_MIN"
        :aria-valuemax="sizeMax"
        :aria-valuenow="size ?? undefined"
        data-testid="pie-resize"
        title="Drag to resize; double-click to reset"
        @pointerdown="dragStart"
        @pointermove="dragMove"
        @pointerup="dragEnd"
        @pointercancel="dragEnd"
        @dblclick.stop="resetSize"
        @keydown="onHandleKey"
      />
    </div>
    <p v-if="deliberate" class="dp-hint" data-testid="pie-hint">{{ finePointer ? 'Click a slice to open it' : 'Press and hold a slice to open it' }}</p>
    <ul class="dp-list" :aria-label="`${label}: slices`">
      <li v-for="s in drawn" :key="s.key" class="dp-item">
        <component
          :is="s.inert ? 'div' : 'button'"
          class="dp-row"
          :class="{ 'dp-static': s.inert }"
          v-bind="s.inert ? {} : s.members?.length ? { type: 'button', 'aria-expanded': isOpen(s) } : { type: 'button' }"
          :data-testid="`pie-row-${s.key}`"
          @click="pick(s)"
        >
          <span class="dp-dot" :style="{ background: s.color }" aria-hidden="true" />
          <span class="dp-text">
            <span class="dp-label">{{ s.label }}</span>
            <span v-if="s.detail" class="dp-detail">{{ s.detail }}</span>
          </span>
          <span class="dp-value">{{ format(s.value) }}</span>
          <span class="dp-share">{{ share(s.value) }}%</span>
          <span v-if="s.members?.length" class="dp-caret" aria-hidden="true">{{ isOpen(s) ? '▴' : '▾' }}</span>
        </component>
        <ul v-if="isOpen(s)" class="dp-members" :aria-label="`${s.label}: what it holds`" :data-testid="`pie-members-${s.key}`">
          <li v-for="m in s.members" :key="m.key">
            <button type="button" class="dp-row dp-member" :data-testid="`pie-member-${m.key}`" @click="emit('select', m.key)">
              <span class="dp-dot" :style="{ background: m.color }" aria-hidden="true" />
              <span class="dp-text">
                <span class="dp-label">{{ m.label }}</span>
                <span v-if="m.detail" class="dp-detail">{{ m.detail }}</span>
              </span>
              <span class="dp-value">{{ format(m.value) }}</span>
              <span class="dp-share">{{ share(m.value) }}%</span>
            </button>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.drill-pie {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  /* The legend asks how wide the pie's own box is (below). Where the section puts the pie beside another panel it
   * sets this box to display: contents, which has no size, so the query does not apply there and the legend stays
   * one column. */
  container-type: inline-size;
}
/* Wider than tall on a wide screen, so the outside labels have room at the sides without shrinking the ring. */
.dp-canvas {
  position: relative;
  width: 100%;
  max-width: 520px;
  max-height: 372px;
  aspect-ratio: 1;
  align-self: center;
  /* a hold or a double-tap on the pie must not select text, pop a callout or zoom the page */
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  touch-action: pan-y;
}
/* Opt-in: the donut beside the legend, the legend in as many columns as fit. */
.drill-pie.dp-wide {
  display: grid;
  grid-template-columns: var(--dp-size, 320px) minmax(0, 1fr);
  column-gap: 24px;
  align-items: start;
}
.dp-wide .dp-canvas {
  grid-column: 1;
  grid-row: 1;
  align-self: start;
  justify-self: start;
}
.dp-wide .dp-hint {
  grid-column: 1;
  grid-row: 2;
  max-width: var(--dp-size, 320px);
}
.drill-pie.dp-wide .dp-list {
  grid-column: 2;
  grid-row: 1 / span 2;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  column-gap: 24px;
  align-items: start;
}
.dp-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  cursor: nwse-resize;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  opacity: 0.6;
}
.dp-resize::after {
  content: '';
  position: absolute;
  inset: 2px;
  background: linear-gradient(135deg, transparent 0 45%, rgb(var(--ink-3)) 45% 55%, transparent 55% 70%, rgb(var(--ink-3)) 70% 80%, transparent 80%);
}
.dp-resize:hover,
.dp-resize:focus-visible {
  opacity: 1;
}
.dp-resize:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 1px;
}
@media (pointer: coarse) {
  .dp-resize {
    width: 24px;
    height: 24px;
  }
}
.dp-hint {
  margin: 0;
  text-align: center;
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.dp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
/* Stacked under the pie with room (a tablet or a narrow desktop window): two columns, each with its name, amount and
 * share close together. A phone stays one column. */
@container (min-width: 560px) {
  .dp-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: 24px;
    align-items: start;
  }
}
.dp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgb(var(--ink));
  font: inherit;
  font-size: 14px;
  text-align: left;
}
button.dp-row {
  cursor: pointer;
}
button.dp-row:hover {
  background: rgb(var(--sunken));
}
button.dp-row:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
}
.dp-static {
  color: rgb(var(--ink-2));
}
.dp-dot {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  /* a pale slice colour (the folded bucket's grey, a light shade) still shows against the page */
  box-shadow: inset 0 0 0 1px rgb(var(--ink-3) / 0.55);
}
.dp-caret {
  flex: none;
  width: 1em;
  text-align: center;
  color: rgb(var(--ink-3));
}
.dp-members {
  list-style: none;
  margin: 0 0 4px 22px;
  padding: 0 0 0 8px;
  border-left: 2px solid rgb(var(--line-2));
  display: flex;
  flex-direction: column;
}
.dp-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.dp-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dp-detail {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.dp-value {
  flex: none;
  font-variant-numeric: tabular-nums;
}
.dp-share {
  flex: none;
  width: 3.2em;
  text-align: right;
  font-size: 12px;
  color: rgb(var(--ink-3));
  font-variant-numeric: tabular-nums;
}
</style>
