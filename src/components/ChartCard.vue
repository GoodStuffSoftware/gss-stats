<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import type { Widget, GlobalFilters, StatsResponse } from '../types'
import { fetchStats } from '../api'
import { checkSessionExpired, isNetworkError } from '../session'
import { buildChartConfig, formatKey, metricValue } from '../lib/charts'
import { rangeLabel } from '../lib/range'
import BaseChart from './charts/BaseChart.vue'
import WorldMap from './charts/WorldMap.vue'
import FilterPopover from './FilterPopover.vue'

const props = defineProps<{ widget: Widget; filters: GlobalFilters; dark: boolean }>()
const emit = defineEmits<{
  edit: []
  remove: []
  duplicate: []
  drill: [{ dimension: string; dataset: 'geo' | 'rum'; value: string; label: string; x: number; y: number }]
}>()

// A click on a chart element → hand the parent the raw dimension value so it can
// offer to open a page filtered to it. v1: single-dimension charts only.
function onPoint(p: { index: number; datasetIndex: number; x: number; y: number }) {
  const dim = props.widget.dimension
  if (!dim || props.widget.breakdown) return
  const value = data.value?.rows?.[p.index]?.key?.[dim]
  if (value == null || value === '') return
  emit('drill', {
    dimension: dim,
    dataset: props.widget.dataset === 'geo' ? 'geo' : 'rum',
    value: String(value),
    label: formatKey(dim, String(value)),
    x: p.x,
    y: p.y,
  })
}

const data = ref<StatsResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const menuOpen = ref(false)
let reqId = 0

// Per-chart filter override: use widget.filters if set, else the global filter.
const effectiveFilters = computed<GlobalFilters>(() => props.widget.filters ?? props.filters)
const hasOverride = computed(() => !!props.widget.filters)

async function load() {
  const my = ++reqId
  loading.value = true
  error.value = null
  try {
    const r = await fetchStats(props.widget, effectiveFilters.value)
    if (my === reqId) data.value = r
  } catch (e: any) {
    if (my === reqId) error.value = e?.message ?? 'Failed to load'
    if (isNetworkError(e)) checkSessionExpired() // probe for an expired Access session
  } finally {
    if (my === reqId) loading.value = false
  }
}

// Refetch only when a data-affecting input changes (not on move/resize).
const dataKey = computed(() =>
  JSON.stringify({
    d: props.widget.dimension,
    b: props.widget.breakdown,
    m: props.widget.metric,
    l: props.widget.limit,
    s: props.widget.site,
    h: props.widget.host,
    e: props.widget.excludeSelfReferrals,
    f: effectiveFilters.value,
  }),
)

// ── Per-chart filter popover ──────────────────────────────────────────────────
const filterOpen = ref(false)
const filterBtn = ref<HTMLElement | null>(null)
const popoverStyle = ref<Record<string, string>>({})

function openFilter() {
  const r = filterBtn.value?.getBoundingClientRect()
  if (r) {
    const left = Math.min(r.left, window.innerWidth - 286)
    popoverStyle.value = { top: `${r.bottom + 6}px`, left: `${Math.max(8, left)}px` }
  }
  filterOpen.value = true
}
function onApplyOverride(f: GlobalFilters) {
  props.widget.filters = f
}
function onUseGlobal() {
  props.widget.filters = null
  filterOpen.value = false
}

const overrideSummary = computed(() => {
  const f = props.widget.filters
  if (!f) return ''
  const site =
    f.site === 'all'
      ? 'all sites'
      : f.host
        ? f.host.replace('.goodstuff.software', '')
        : f.site.replace('goodstuff.software', 'gs').replace('.com', '')
  const flags: string[] = []
  if (f.excludeOwnVisits) flags.push('−me')
  return [site, rangeLabel(f.since, f.until), ...flags].join(' · ')
})
watch(dataKey, load)
onMounted(load)

const chartConfig = computed(() => {
  if (!data.value) return null
  void props.dark // recompute colors on theme toggle
  return buildChartConfig(props.widget, data.value)
})

const statValue = computed(() =>
  !data.value ? 0 : props.widget.metric === 'visits' ? data.value.totals.visits : data.value.totals.pageviews,
)
const statOther = computed(() =>
  !data.value ? 0 : props.widget.metric === 'visits' ? data.value.totals.pageviews : data.value.totals.visits,
)
const statOtherLabel = computed(() => (props.widget.metric === 'visits' ? 'pageviews' : 'visits'))

const tableRows = computed(() =>
  !data.value
    ? []
    : data.value.rows.map((r) => ({
        label: formatKey(props.widget.dimension, r.key[props.widget.dimension] ?? ''),
        value: metricValue(r, props.widget.metric),
      })),
)
const tableMax = computed(() => Math.max(1, ...tableRows.value.map((r) => r.value)))

const isEmpty = computed(
  () => !loading.value && !error.value && data.value && data.value.rows.length === 0 && props.widget.type !== 'map',
)

function fmt(n: number) {
  return n.toLocaleString('en-US')
}

function closeMenu() {
  menuOpen.value = false
}
onMounted(() => document.addEventListener('click', closeMenu))
onBeforeUnmount(() => document.removeEventListener('click', closeMenu))
</script>

<template>
  <div class="chart-card">
    <header class="card-head">
      <div class="title-wrap">
        <span class="title" :title="widget.title">{{ widget.title }}</span>
        <span v-if="overrideSummary" class="ovr" :title="'Filter override: ' + overrideSummary"
          >· {{ overrideSummary }}</span
        >
      </div>
      <div class="head-actions">
        <button
          ref="filterBtn"
          class="btn-ghost icon"
          :class="{ active: hasOverride }"
          title="Filter this chart"
          @click.stop="openFilter"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M1.5 2.5h13l-5 6v4.2l-3 1.5V8.5z" fill="currentColor" />
          </svg>
        </button>
        <button class="btn-ghost icon" title="Reload" @click.stop="load">↻</button>
        <div class="menu-anchor">
          <button class="btn-ghost icon" title="Options" @click.stop="menuOpen = !menuOpen">⋯</button>
          <div v-if="menuOpen" class="menu" @click.stop>
            <button @click="emit('edit'); menuOpen = false">Edit</button>
            <button @click="emit('duplicate'); menuOpen = false">Duplicate</button>
            <button class="danger" @click="emit('remove'); menuOpen = false">Delete</button>
          </div>
        </div>
      </div>
    </header>

    <div class="card-body">
      <div v-if="loading" class="state mono">Loading…</div>
      <div v-else-if="error" class="state error mono">{{ error }}</div>
      <div v-else-if="isEmpty" class="state mono">No data in range</div>

      <!-- Stat tile -->
      <div v-else-if="widget.type === 'stat'" class="stat">
        <div class="stat-num">{{ fmt(statValue) }}</div>
        <div class="stat-label overline">{{ widget.metric }}</div>
        <div class="stat-sub">{{ fmt(statOther) }} {{ statOtherLabel }}</div>
      </div>

      <!-- Table -->
      <div v-else-if="widget.type === 'table'" class="table-wrap">
        <table>
          <tbody>
            <tr v-for="(r, idx) in tableRows" :key="idx">
              <td class="t-label" :title="r.label">{{ r.label }}</td>
              <td class="t-bar">
                <span class="bar" :style="{ width: (r.value / tableMax) * 100 + '%' }"></span>
              </td>
              <td class="t-val mono">{{ fmt(r.value) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- World map (geo points) -->
      <WorldMap v-else-if="widget.type === 'map'" :data="data" />

      <!-- Chart.js chart -->
      <BaseChart v-else-if="chartConfig" :config="chartConfig" @point="onPoint" />
    </div>

    <Teleport to="body">
      <div v-if="filterOpen" class="fp-backdrop" @click="filterOpen = false">
        <div class="fp-anchor" :style="popoverStyle" @click.stop>
          <FilterPopover
            :start="effectiveFilters"
            :active="hasOverride"
            @apply="onApplyOverride"
            @use-global="onUseGlobal"
            @close="filterOpen = false"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.chart-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line));
  border-radius: 14px;
  overflow: hidden;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 10px 9px 14px;
  border-bottom: 1px solid rgb(var(--line));
  cursor: grab;
  user-select: none;
  background: rgb(var(--surface));
}
.card-head:active {
  cursor: grabbing;
}
.title-wrap {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}
.title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  max-width: 100%;
}
.ovr {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  color: rgb(var(--amber-hover));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.btn-ghost.icon.active {
  color: rgb(var(--amber));
  background: rgb(var(--amber-tint));
}
.btn-ghost.icon svg {
  display: block;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.btn-ghost.icon {
  border: none;
  background: transparent;
  color: rgb(var(--ink-3));
  font-size: 16px;
  line-height: 1;
  padding: 4px 7px;
  border-radius: 7px;
}
.btn-ghost.icon:hover {
  background: rgb(var(--sunken));
  color: rgb(var(--ink));
}
.menu-anchor {
  position: relative;
}
.menu {
  position: absolute;
  right: 0;
  top: 100%;
  margin-top: 4px;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 10px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
  padding: 4px;
  z-index: 20;
  min-width: 130px;
  display: flex;
  flex-direction: column;
}
.menu button {
  text-align: left;
  border: none;
  background: transparent;
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 13px;
  color: rgb(var(--ink));
}
.menu button:hover {
  background: rgb(var(--sunken));
}
.menu button.danger {
  color: #bc4749;
}
.card-body {
  flex: 1;
  min-height: 0;
  padding: 12px 14px 14px;
  position: relative;
}
.state {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: rgb(var(--ink-3));
  text-align: center;
  padding: 0 8px;
}
.state.error {
  color: #bc4749;
}
.stat {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.stat-num {
  font-family: 'Space Grotesk', sans-serif;
  font-size: clamp(28px, 7vw, 46px);
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.03em;
  color: rgb(var(--ink));
}
.stat-label {
  margin-top: 6px;
}
.stat-sub {
  margin-top: 4px;
  font-size: 12px;
  color: rgb(var(--ink-2));
}
.table-wrap {
  height: 100%;
  overflow-y: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
td {
  padding: 4px 6px;
  vertical-align: middle;
}
.t-label {
  max-width: 0;
  width: 42%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgb(var(--ink));
}
.t-bar {
  width: 40%;
}
.t-bar .bar {
  display: block;
  height: 8px;
  border-radius: 4px;
  background: rgb(var(--amber));
  min-width: 2px;
}
.t-val {
  text-align: right;
  color: rgb(var(--ink-2));
  white-space: nowrap;
}
.fp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
}
.fp-anchor {
  position: fixed;
}
</style>
