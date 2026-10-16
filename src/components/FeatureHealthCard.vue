<script setup lang="ts">
// The 'features' dataset's body (Widget.dataset 'features', see functions/api/features.ts):
//   view 'health'        the Feature health table: a row per feature with its status, and per step the
//                        counts for the latest complete ET day, the day before and the selected range,
//                        plus the plain ratios of those counts;
//   view 'steps:<id>'    that feature's step chart: a line per step, a point per ET day.
// Web and app are combined. Counts only: nothing here is a per-person rate, and the caption says so.
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import type { ChartConfiguration } from 'chart.js'
import type { GlobalFilters, Widget } from '../types'
import { fetchFeatureHealth, type FeatureHealthResponse } from '../api'
import { HEALTH_CAPTION, HEALTH_STATUS_LABEL, featureIdOfView, formatRatio, type FeatureHealth } from '../lib/featureHealth'
import { buildStepChartConfig } from '../lib/featureHealthChart'
import { formatKey } from '../lib/charts'
import BaseChart from './charts/BaseChart.vue'

const props = defineProps<{ widget: Widget; filters: GlobalFilters; dark: boolean }>()

const model = ref<FeatureHealthResponse | null>(null)
const error = ref<string | null>(null)
const loading = ref(true)
let seq = 0

async function load() {
  const mine = ++seq
  loading.value = true
  error.value = null
  try {
    const res = await fetchFeatureHealth(props.widget, props.filters)
    if (mine !== seq) return
    model.value = res
  } catch (e) {
    if (mine !== seq) return
    error.value = e instanceof Error ? e.message : String(e)
    model.value = null
  } finally {
    if (mine === seq) loading.value = false
  }
}

// Reload when anything the request is built from changes (the range, the sites, the exclusions).
const requestKey = computed(() =>
  JSON.stringify([props.filters.since, props.filters.until, props.widget.siteSel ?? props.filters.siteSel, props.filters.excludeOwnVisits, props.filters.ownBrowser, props.filters.ownOS, props.widget.excludeKnownTraffic === true]),
)
watch(requestKey, load, { immediate: true })
onBeforeUnmount(() => {
  seq++ // a response that lands after unmount is dropped
})

const stepsFeatureId = computed(() => featureIdOfView(props.widget.view))
const stepsFeature = computed<FeatureHealth | null>(() => {
  const id = stepsFeatureId.value
  return id ? (model.value?.features.find((f) => f.id === id) ?? null) : null
})
const chartConfig = computed<ChartConfiguration | null>(() => {
  void props.dark // recompute colours on a theme toggle
  const m = model.value
  const f = stepsFeature.value
  return m && f ? buildStepChartConfig(m, f) : null
})

const fmt = (n: number) => n.toLocaleString('en-US')
const dayLabel = (d: string | undefined) => (d ? formatKey('date', d) : '')
const rangeTitle = computed(() => (model.value ? `${model.value.meta.rangeFrom || model.value.meta.since} to ${model.value.meta.until}` : ''))
const ratioCells = (f: FeatureHealth, i: number) => {
  const r = f.steps[i].ratio
  return r ? { text: `${formatRatio(r.latest)} · ${formatRatio(r.prev)} · ${formatRatio(r.range)}`, label: r.label } : null
}
</script>

<template>
  <div class="fh-body">
    <p v-if="loading && !model" class="state mono">Loading…</p>
    <p v-else-if="error" class="state error mono">{{ error }}</p>

    <!-- A feature's step chart -->
    <template v-else-if="stepsFeatureId">
      <p v-if="!stepsFeature" class="state mono">No such feature: {{ stepsFeatureId }}</p>
      <div v-else class="fh-chart" :data-feature="stepsFeature.id">
        <div class="fh-chart-head">
          <span class="fh-chip" :class="`st-${stepsFeature.status}`" :title="stepsFeature.statusNote">{{ HEALTH_STATUS_LABEL[stepsFeature.status] }}</span>
          <span class="fh-blurb">{{ stepsFeature.blurb }}</span>
        </div>
        <div class="fh-chart-canvas"><BaseChart v-if="chartConfig" :config="chartConfig" :drill-open="false" /></div>
      </div>
    </template>

    <!-- The Feature health table -->
    <template v-else-if="model">
      <div class="fh-scroll">
        <table class="fh-table" data-testid="feature-health-table">
          <thead>
            <tr>
              <th class="l">Feature</th>
              <th class="l">Status</th>
              <th class="l">Step</th>
              <th class="r" :title="model.latestDay">{{ dayLabel(model.latestDay) }}</th>
              <th class="r" :title="model.prevDay">{{ dayLabel(model.prevDay) }}</th>
              <th class="r" :title="rangeTitle">Range</th>
              <th class="l" title="Plain ratios of counts: latest day · day before · range">Ratio of counts</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in model.features" :key="f.id" :data-feature="f.id">
              <td class="l fh-name" :title="f.blurb">{{ f.label }}</td>
              <td class="l">
                <span class="fh-chip" :class="`st-${f.status}`" :title="f.statusNote">{{ HEALTH_STATUS_LABEL[f.status] }}</span>
              </td>
              <td class="l"><div v-for="s in f.steps" :key="s.id" class="ln">{{ s.label }}</div></td>
              <td class="r mono"><div v-for="s in f.steps" :key="s.id" class="ln">{{ fmt(s.latest) }}</div></td>
              <td class="r mono"><div v-for="s in f.steps" :key="s.id" class="ln">{{ fmt(s.prev) }}</div></td>
              <td class="r mono"><div v-for="s in f.steps" :key="s.id" class="ln">{{ fmt(s.range) }}</div></td>
              <td class="l mono">
                <div v-for="(s, i) in f.steps" :key="s.id" class="ln">
                  <template v-if="ratioCells(f, i)">{{ ratioCells(f, i)!.text }} <span class="fh-ratio-label">{{ ratioCells(f, i)!.label }}</span></template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="fh-caption" data-testid="feature-health-caption">{{ HEALTH_CAPTION }}</p>
    </template>
  </div>
</template>

<style scoped>
.fh-body {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.state {
  margin: auto;
  color: rgb(var(--ink-3));
  font-size: 12.5px;
}
.state.error {
  color: rgb(var(--g4));
}
.fh-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.fh-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.fh-table th {
  position: sticky;
  top: 0;
  background: rgb(var(--surface));
  color: rgb(var(--ink-3));
  font-weight: 500;
  padding: 4px 8px;
  border-bottom: 1px solid rgb(var(--line));
  white-space: nowrap;
}
.fh-table td {
  padding: 4px 8px;
  vertical-align: top;
  border-bottom: 1px solid rgb(var(--line));
  color: rgb(var(--ink-2));
  white-space: nowrap;
}
.l {
  text-align: left;
}
.r {
  text-align: right;
}
.mono {
  font-family: 'JetBrains Mono', monospace;
}
.ln {
  line-height: 20px;
  height: 20px;
}
.fh-name {
  color: rgb(var(--ink));
  font-weight: 600;
  line-height: 20px;
}
.fh-chip {
  display: inline-block;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11.5px;
  line-height: 18px;
  border: 1px solid transparent;
  white-space: nowrap;
}
.fh-chip.st-ok {
  color: rgb(var(--g5));
  border-color: rgb(var(--g5) / 0.5);
}
.fh-chip.st-new {
  color: rgb(var(--g6));
  border-color: rgb(var(--g6) / 0.5);
}
.fh-chip.st-silent {
  color: rgb(var(--g4));
  border-color: rgb(var(--g4) / 0.6);
  font-weight: 600;
}
.fh-ratio-label {
  color: rgb(var(--ink-3));
  font-family: inherit;
}
.fh-caption {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: rgb(var(--ink-3));
}
.fh-chart {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.fh-chart-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: rgb(var(--ink-3));
  padding-bottom: 4px;
}
.fh-chart-canvas {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
