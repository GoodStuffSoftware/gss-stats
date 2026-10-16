<script setup lang="ts">
// The 'features' dataset's body (Widget.dataset 'features', see functions/api/features.ts):
//   view 'health'        the Feature health table: a row per feature with its status, and per step the
//                        counts for the latest complete ET day, the day before and the selected range,
//                        plus the plain ratios of those counts;
//   view 'steps:<id>'    that feature's step chart: a line per step, a point per ET day;
//   view 'coach-tips'    the Coach tips table (src/lib/coachTips.ts): a row per coach tip with shown,
//                        dismissed and closed-while-showing counts and their ratios, for the latest
//                        complete ET day and the selected range, plus the "Show me around" total;
//   view 'ask-order'     the Ask-order A/B (src/lib/askOrder.ts): progress toward the call point and the
//                        pre-registered read per group (all days so far), then a table of the counts per group,
//                        organic vs tagged, for the latest complete ET day and the selected range.
// Web and app are combined. Counts only: nothing here is a per-person rate, and the caption says so.
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import type { ChartConfiguration } from 'chart.js'
import type { GlobalFilters, Widget } from '../types'
import { fetchFeatureHealth, type FeatureHealthResponse } from '../api'
import { HEALTH_CAPTION, HEALTH_STATUS_LABEL, featureIdOfView, formatRatio, ratio, type FeatureHealth } from '../lib/featureHealth'
import { buildStepChartConfig } from '../lib/featureHealthChart'
import { formatKey } from '../lib/charts'
import { COACH_TIPS_CAPTION, COACH_TIPS_EMPTY_NOTE, COACH_TIPS_VIEW } from '../lib/coachTips'
import {
  ASK_ORDER_ASKS, ASK_ORDER_CALL_ASKS, ASK_ORDER_CAPTION, ASK_ORDER_EMPTY_NOTE, ASK_ORDER_GROUPS, ASK_ORDER_OUTCOMES, ASK_ORDER_TAGS, ASK_ORDER_VIEW,
  askOrderFeatureId, assignedStepId, outcomeStepId, readAskOrder, responsesOf, shownStepId, stepCount,
} from '../lib/askOrder'
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

// The Coach tips table: one row per tip (every feature but the last), then the tour-opened total.
const isCoachTips = computed(() => props.widget.view === COACH_TIPS_VIEW)
const coachStep = (f: FeatureHealth, id: string) => f.steps.find((s) => s.id === id)
const coachRatio = (f: FeatureHealth, id: string, which: 'latest' | 'range') => formatRatio(coachStep(f, id)?.ratio?.[which] ?? null)
const coachTourOpened = computed(() => {
  const f = model.value?.features.find((x) => x.id === 'tour-opened')
  const s = f?.steps.find((x) => x.id === 'opened')
  return f && s ? { label: f.label, blurb: f.blurb, latest: s.latest, range: s.range } : null
})
const coachTipRows = computed(() => (model.value?.features ?? []).filter((f) => f.id.startsWith('tip-')))

// The Ask-order A/B: the pre-registered read (all days so far) and the range table (a column per
// window, group and tag; a row per measure).
const isAskOrder = computed(() => props.widget.view === ASK_ORDER_VIEW)
const askRead = computed(() => readAskOrder(model.value?.allTime ?? {}))
const askFeature = (g: string) => model.value?.features.find((f) => f.id === askOrderFeatureId(g as (typeof ASK_ORDER_GROUPS)[number]['id']))
const askCols = (['latest', 'range'] as const).flatMap((which) =>
  ASK_ORDER_GROUPS.flatMap((g) => ASK_ORDER_TAGS.map((t) => ({ which, group: g.id, groupLabel: g.label, tag: t.id, tagLabel: t.label }))),
)
type AskCol = (typeof askCols)[number]
const askRowDefs = [
  { key: 'assigned', label: 'Assigned', cls: '', value: (c: AskCol) => stepCount(askFeature(c.group), assignedStepId(c.tag), c.which) },
  ...ASK_ORDER_ASKS.map((a) => ({
    key: `shown-${a.id}`,
    label: `${a.label} shown`,
    cls: '',
    value: (c: AskCol) => stepCount(askFeature(c.group), shownStepId(a.id, c.tag), c.which),
  })),
  ...ASK_ORDER_ASKS.flatMap((a) =>
    ASK_ORDER_OUTCOMES.map((o) => ({
      key: `${a.id}-${o.id}`,
      label: `${a.label}: ${o.label.toLowerCase()}`,
      cls: '',
      value: (c: AskCol) => stepCount(askFeature(c.group), outcomeStepId(a.id, o.id, c.tag), c.which),
    })),
  ),
  { key: 'responses', label: 'Responses (signed in or installed)', cls: 'fh-total', value: (c: AskCol) => responsesOf(askFeature(c.group), c.tag, c.which) },
]
const askCell = (c: AskCol, value: (c: AskCol) => number) => fmt(askFeature(c.group) ? value(c) : 0)
const askResponsesPerAssigned = (c: AskCol) => {
  const f = askFeature(c.group)
  return formatRatio(ratio(responsesOf(f, c.tag, c.which), stepCount(f, assignedStepId(c.tag), c.which)))
}
const pct = (x: number) => `${Math.round(x * 100)}%`

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

    <!-- The Coach tips table -->
    <template v-else-if="isCoachTips && model">
      <p v-if="model.everSeen === false" class="fh-caption" data-testid="coach-tips-empty">{{ COACH_TIPS_EMPTY_NOTE }}</p>
      <div class="fh-scroll">
        <table class="fh-table" data-testid="coach-tips-table">
          <thead>
            <tr>
              <th class="l" rowspan="2">Tip</th>
              <th class="c" colspan="5" :title="model.latestDay">Latest day ({{ dayLabel(model.latestDay) }})</th>
              <th class="c" colspan="5" :title="rangeTitle">Range</th>
            </tr>
            <tr>
              <template v-for="g in ['latest', 'range']" :key="g">
                <th class="r">Shown</th>
                <th class="r">Dismissed</th>
                <th class="r">Closed while showing</th>
                <th class="r" title="Dismissed divided by shown">Dismissed per shown</th>
                <th class="r" title="Closed while showing divided by shown">Closed per shown</th>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in coachTipRows" :key="f.id" :data-tip="f.id">
              <td class="l fh-name" :title="f.blurb">{{ f.label }}</td>
              <template v-for="g in (['latest', 'range'] as const)" :key="g">
                <td class="r mono" :data-col="g + '-shown'">{{ fmt(coachStep(f, 'shown')?.[g] ?? 0) }}</td>
                <td class="r mono" :data-col="g + '-dismissed'">{{ fmt(coachStep(f, 'dismissed')?.[g] ?? 0) }}</td>
                <td class="r mono" :data-col="g + '-closed'">{{ fmt(coachStep(f, 'closed')?.[g] ?? 0) }}</td>
                <td class="r mono" :data-col="g + '-dismissed-ratio'">{{ coachRatio(f, 'dismissed', g) }}</td>
                <td class="r mono" :data-col="g + '-closed-ratio'">{{ coachRatio(f, 'closed', g) }}</td>
              </template>
            </tr>
            <tr v-if="coachTourOpened" class="fh-total" data-tip="tour-opened">
              <td class="l fh-name" :title="coachTourOpened.blurb">{{ coachTourOpened.label }} (taps, no tip)</td>
              <td class="r mono" data-col="latest-opened">{{ fmt(coachTourOpened.latest) }}</td>
              <td class="l" colspan="4"></td>
              <td class="r mono" data-col="range-opened">{{ fmt(coachTourOpened.range) }}</td>
              <td class="l" colspan="4"></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="fh-caption" data-testid="coach-tips-caption">{{ COACH_TIPS_CAPTION }}</p>
    </template>

    <!-- The Ask-order A/B -->
    <template v-else-if="isAskOrder && model">
      <p v-if="model.everSeen === false" class="fh-caption" data-testid="ask-order-empty">{{ ASK_ORDER_EMPTY_NOTE }}</p>
      <div class="fh-scroll">
        <div class="ao-read" data-testid="ask-order-read">
          <div v-for="g in askRead.groups" :key="g.group" class="ao-group" :data-group="g.group">
            <div class="ao-head">
              <span class="fh-name">{{ g.label }}</span>
              <span class="mono" data-col="asks-progress">asks shown {{ fmt(g.asksShown) }} / {{ ASK_ORDER_CALL_ASKS }}</span>
            </div>
            <div class="ao-bar" role="progressbar" :aria-valuenow="g.asksShown" aria-valuemin="0" :aria-valuemax="ASK_ORDER_CALL_ASKS" :aria-label="`${g.label}: asks shown toward ${ASK_ORDER_CALL_ASKS}`">
              <div class="ao-bar-fill" :class="{ done: g.reachedCall }" :style="{ width: pct(g.progress) }"></div>
            </div>
            <div class="ao-nums mono">
              <span data-col="assigned">assigned {{ fmt(g.assigned) }}</span>
              <span data-col="responses">responses {{ fmt(g.responses) }}</span>
              <span data-col="responses-per-assigned" title="Signed-in plus installed outcome rows divided by devices assigned: a ratio of two row counts, not a per-person rate">responses per assigned {{ formatRatio(g.responsesPerAssigned) }}</span>
            </div>
            <div class="ao-nums mono ao-secondary">
              <span v-for="o in ASK_ORDER_OUTCOMES.filter((x) => x.id !== 'still-playing')" :key="o.id" :data-col="'per-assigned-' + o.id">
                {{ o.label.toLowerCase() }} per assigned {{ formatRatio(g.perOutcome[o.id].perAssigned) }}
              </span>
            </div>
          </div>
        </div>
        <p class="ao-verdict" :data-state="askRead.verdict.state" data-testid="ask-order-verdict">
          <span class="mono" data-col="multiple">Larger over smaller: {{ askRead.multiple === null ? '—' : `${askRead.multiple.toFixed(2)}x` }}.</span>
          {{ askRead.verdict.note }}
        </p>
        <table class="fh-table" data-testid="ask-order-table">
          <thead>
            <tr>
              <th class="l" rowspan="3">Measure</th>
              <th class="c" colspan="4" :title="model.latestDay">Latest day ({{ dayLabel(model.latestDay) }})</th>
              <th class="c" colspan="4" :title="rangeTitle">Range</th>
            </tr>
            <tr>
              <template v-for="w in ['latest', 'range']" :key="w">
                <th v-for="g in ASK_ORDER_GROUPS" :key="g.id" class="c" colspan="2">{{ g.label }}</th>
              </template>
            </tr>
            <tr>
              <template v-for="w in ['latest', 'range']" :key="w">
                <template v-for="g in ASK_ORDER_GROUPS" :key="g.id">
                  <th v-for="t in ASK_ORDER_TAGS" :key="t.id" class="r">{{ t.label }}</th>
                </template>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in askRowDefs" :key="r.key" :class="r.cls" :data-row="r.key">
              <td class="l fh-name">{{ r.label }}</td>
              <td v-for="c in askCols" :key="c.which + c.group + c.tag" class="r mono" :data-col="`${c.which}-${c.group}-${c.tag}`">{{ askCell(c, r.value) }}</td>
            </tr>
            <tr data-row="responses-per-assigned">
              <td class="l fh-name" title="Responses divided by assigned: a ratio of two row counts">Responses per assigned</td>
              <td v-for="c in askCols" :key="c.which + c.group + c.tag" class="r mono" :data-col="`${c.which}-${c.group}-${c.tag}`">{{ askResponsesPerAssigned(c) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="fh-caption" data-testid="ask-order-caption">{{ ASK_ORDER_CAPTION }}</p>
    </template>

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
.ao-read {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  padding-bottom: 6px;
}
.ao-group {
  border: 1px solid rgb(var(--line));
  border-radius: 8px;
  padding: 8px 10px;
}
.ao-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
}
.ao-bar {
  height: 8px;
  margin: 6px 0;
  border-radius: 999px;
  background: rgb(var(--line));
  overflow: hidden;
}
.ao-bar-fill {
  height: 100%;
  background: rgb(var(--g6));
}
.ao-bar-fill.done {
  background: rgb(var(--g5));
}
.ao-nums {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
  color: rgb(var(--ink-2));
}
.ao-secondary {
  color: rgb(var(--ink-3));
}
.ao-verdict {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: rgb(var(--ink-2));
}
.ao-verdict[data-state='preliminary'] {
  color: rgb(var(--ink-3));
}
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
.c {
  text-align: center;
}
.fh-total td {
  border-top: 1px solid rgb(var(--line));
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
