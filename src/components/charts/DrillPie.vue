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

/** The label alternatives for one slice, longest first: the first that fits the arc is drawn. */
export function sliceLabelParts(amount: string, share: number): string[] {
  return [`${amount} · ${share}%`, amount, `${share}%`]
}
</script>

<script setup lang="ts">
// A generic doughnut whose slices can be picked, with a list of the same slices under it (the way in for a
// keyboard, a screen reader and a phone, where a tap on the canvas only shows the tooltip). It knows nothing
// about what the slices are: the parent maps its data to PieSlice[] and decides what `select` means (drill
// down, open a detail). Every new `slices` array draws a fresh chart; an identical array does not redraw.
//
// Motion (lib/pieMotion.ts): a pie that appears for different slices plays in. A slice was picked and the next
// level appears within a few seconds: the new slices grow out of the picked slice's wedge. The slices you
// went back up to: the pie grows around the slice you came from. Nothing to come from: a clockwise sweep.
// prefers-reduced-motion: a short fade instead of any movement. A redraw with the same slices (a theme
// switch, new numbers) plays nothing.
// Labels (arcLabelsPlugin in lib/charts.ts): a slice with room shows its name on the arc, and its amount and
// share (or just one of them) when those fit too; a slice with no room shows none, the list below has it.
//
// Props
//   slices:  PieSlice[]
//   dark:    boolean                       site theme (the slice border)
//   animate: boolean (true)                false = no motion at all
//   format:  (value: number) => string     text for a value (default: String)
//   label:   string                        accessible name of the chart and its list
// Emits
//   select(key: string)                    a slice or its list row was picked (never for an `inert` slice, nor for a
//                                          slice with `members`: that one opens its list; its members are reported)
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { ChartConfiguration } from 'chart.js'
import { arcLabelsPlugin } from '../../lib/charts'
import { pieMotionPlugin, rememberPick, sliceSignature, takeOrigin, type PieMotion } from '../../lib/pieMotion'
import BaseChart from './BaseChart.vue'

const props = withDefaults(
  defineProps<{ slices: PieSlice[]; dark: boolean; animate?: boolean; format?: (value: number) => string; label?: string }>(),
  { animate: true, format: (v: number) => String(v), label: 'Pie chart' },
)
const emit = defineEmits<{ select: [key: string] }>()

// ── Motion preference ────────────────────────────────────────────────────────────────────────────────────
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'
const reduced = ref(false)
let mql: MediaQueryList | null = null
function onMotionChange(e: MediaQueryListEvent) {
  reduced.value = e.matches
}
onMounted(() => {
  mql = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_QUERY) : null
  if (!mql) return
  reduced.value = mql.matches
  mql.addEventListener?.('change', onMotionChange)
})
onBeforeUnmount(() => mql?.removeEventListener?.('change', onMotionChange))
// Read once more at setup so the very first chart already knows (onMounted runs after BaseChart's own).
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') reduced.value = window.matchMedia(REDUCED_QUERY).matches

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
  lineGap: 8,
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

/** How the pie plays in: decided once per set of slices (see the header). */
function chooseMotion(list: PieSlice[]): PieMotion {
  if (!props.animate) return { kind: 'none' }
  const keys = keysOf(list)
  const wedge = wedges(list)
  const origin = takeOrigin(keys, (k) => wedge.get(k) ?? null)
  if (reduced.value) return { kind: 'fade' }
  return origin ?? { kind: 'unfurl', mid: 0 }
}

function buildConfig(motion: PieMotion): ChartConfiguration {
  const s = drawn.value
  const formatValue = props.format
  const items = s.map((x) => ({
    name: x.label,
    sub: sliceLabelParts(formatValue(x.value), share(x.value)),
  }))
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
    plugins: [arcLabelsPlugin({ 0: items }, LABEL_LOOK), pieMotionPlugin({ motion })],
  } as ChartConfiguration
}

// Rebuild only when something that shows changed, so a refetch that returns the same numbers does not redraw.
// The motion plays only when the SET of slices changed (a new level), not for a theme switch or new numbers.
const signature = computed(() =>
  JSON.stringify([drawn.value.map((x) => [x.key, x.label, x.value, x.color]), props.dark, props.animate, reduced.value]),
)
const keysSignature = computed(() => sliceSignature(keysOf(drawn.value)))
let playedFor: string | null = null
function build(): ChartConfiguration {
  const replay = keysSignature.value !== playedFor
  playedFor = keysSignature.value
  return buildConfig(replay ? chooseMotion(drawn.value) : { kind: 'none' })
}
const config = shallowRef<ChartConfiguration>(build())
watch(signature, () => {
  config.value = build()
})

const opened = ref<ReadonlySet<string>>(new Set())
function toggleMembers(key: string) {
  const next = new Set(opened.value)
  if (!next.delete(key)) next.add(key)
  opened.value = next
}
const isOpen = (s: PieSlice) => !!s.members?.length && opened.value.has(s.key)
// Remember which wedge was picked, so the pie that appears next knows where to come from (or go back to).
function remember(s: PieSlice) {
  const w = wedges(drawn.value).get(s.key)
  if (w) rememberPick({ sig: keysSignature.value, key: s.key, from: w.from, to: w.to })
}
function pick(s: PieSlice) {
  if (s.members?.length) toggleMembers(s.key)
  else if (!s.inert) {
    remember(s)
    emit('select', s.key)
  }
}
// A member of a folded bucket is reported by its own key; the motion starts from the bucket's wedge.
function pickMember(bucket: PieSlice, m: PieSlice) {
  remember(bucket)
  emit('select', m.key)
}

function onPoint(p: { index: number }) {
  const s = drawn.value[p.index]
  if (s) pick(s)
}
</script>

<template>
  <div class="drill-pie" data-testid="drill-pie">
    <div class="dp-canvas" role="img" :aria-label="label">
      <BaseChart :config="config" :drill-open="false" @point="onPoint" />
    </div>
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
            <button type="button" class="dp-row dp-member" :data-testid="`pie-member-${m.key}`" @click="pickMember(s, m)">
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
}
.dp-canvas {
  position: relative;
  width: min(100%, 340px);
  aspect-ratio: 1;
  align-self: center;
}
.dp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
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
