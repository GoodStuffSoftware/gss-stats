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
  /** A folded slice such as "Other": drawn, listed, never reported by `select`. */
  inert?: boolean
}

/** The per-chart animation option BaseChart turns into a real animation (see its opt-in). */
export const ANIMATION_ON = { duration: 450, easing: 'easeOutQuart', animateRotate: true, animateScale: true } as const
</script>

<script setup lang="ts">
// A generic doughnut whose slices can be picked, with a list of the same slices under it (the way in for a
// keyboard, a screen reader and a phone, where a tap on the canvas only shows the tooltip). It knows nothing
// about what the slices are: the parent maps its data to PieSlice[] and decides what `select` means (drill
// down, open a detail). Every new `slices` array draws a fresh chart, which animates in (BaseChart rebuilds
// per config), so each drill level sweeps in; an identical array does not redraw.
//
// Props
//   slices:  PieSlice[]
//   dark:    boolean                       site theme (the slice border)
//   animate: boolean (true)                false = no animation; prefers-reduced-motion also turns it off
//   format:  (value: number) => string     text for a value (default: String)
//   label:   string                        accessible name of the chart and its list
// Emits
//   select(key: string)                    a slice or its list row was picked (never for an `inert` slice)
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { ChartConfiguration } from 'chart.js'
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

function buildConfig(): ChartConfiguration {
  const s = drawn.value
  const formatValue = props.format
  const animation = props.animate && !reduced.value ? { ...ANIMATION_ON } : false
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
      animation,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${formatValue(Number(ctx.raw))} (${share(Number(ctx.raw))}%)`,
          },
        },
      },
    },
  } as ChartConfiguration
}

// Rebuild only when something that shows changed, so a refetch that returns the same numbers does not replay
// the sweep.
const signature = computed(() =>
  JSON.stringify([drawn.value.map((x) => [x.key, x.label, x.value, x.color]), props.dark, props.animate && !reduced.value]),
)
const config = shallowRef<ChartConfiguration>(buildConfig())
watch(signature, () => {
  config.value = buildConfig()
})

function onPoint(p: { index: number }) {
  const s = drawn.value[p.index]
  if (s && !s.inert) emit('select', s.key)
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
          v-bind="s.inert ? {} : { type: 'button' }"
          :data-testid="`pie-row-${s.key}`"
          @click="!s.inert && emit('select', s.key)"
        >
          <span class="dp-dot" :style="{ background: s.color }" aria-hidden="true" />
          <span class="dp-text">
            <span class="dp-label">{{ s.label }}</span>
            <span v-if="s.detail" class="dp-detail">{{ s.detail }}</span>
          </span>
          <span class="dp-value">{{ format(s.value) }}</span>
          <span class="dp-share">{{ share(s.value) }}%</span>
        </component>
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
