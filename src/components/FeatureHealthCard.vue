<script setup lang="ts">
// The 'features' dataset's one remaining bespoke body: the Ask-order A/B (view 'ask-order', src/lib/askOrder.ts),
// read from functions/api/features.ts: progress toward the call point and the pre-registered read per group (all
// days so far), then a table of the counts per group, organic vs tagged, for the latest complete ET day and the
// selected range. Web and app are combined. Counts only: nothing here is a per-person rate, and the caption says so.
// The Feature health table, the step charts and the Coach tips table that used to live here are ordinary card and
// chart widgets now (editor tools T1-T3, ADR 0005); a saved widget naming them is mapped at render time
// (lib/defaults.ts stepChartFor, featureHealthCardFor, coachTipsCardFor) and ChartCard mounts this body for Ask-order only.
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import type { GlobalFilters, Widget } from '../types'
import { fetchFeatureHealth, type FeatureHealthResponse } from '../api'
import { formatRatio, ratio } from '../lib/featureHealth'
import { formatKey } from '../lib/charts'
import {
  ASK_ORDER_ASKS, ASK_ORDER_CALL_ASKS, ASK_ORDER_CAPTION, ASK_ORDER_EMPTY_NOTE, ASK_ORDER_GROUPS, ASK_ORDER_OUTCOMES, ASK_ORDER_SWITCH_MULTIPLE, ASK_ORDER_TAGS,
  askOrderFeatureId, assignedStepId, outcomeRowsOf, outcomeStepId, readAskOrder, respondedStepId, responseRowsOf, shownStepId, stepCount, type OutcomeId,
} from '../lib/askOrder'

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

// The Ask-order A/B: the pre-registered read (all days so far) and the range table (a column per
// window, group and tag; a row per measure).
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
  ...ASK_ORDER_ASKS.map((a) => ({
    key: `responded-${a.id}`,
    label: `Responded by ${a.label.toLowerCase()} (once per device)`,
    cls: '',
    value: (c: AskCol) => stepCount(askFeature(c.group), respondedStepId(a.id, c.tag), c.which),
  })),
  {
    key: 'response-rows',
    label: 'Response rows (signed-in + installed; a device doing both counts twice)',
    cls: 'fh-total',
    value: (c: AskCol) => responseRowsOf(askFeature(c.group), c.tag, c.which),
  },
]
const askCell = (c: AskCol, value: (c: AskCol) => number) => fmt(askFeature(c.group) ? value(c) : 0)
// Row ratios: a count of rows over the assigned rows of the same group, tag and window.
const askRatioRows = [
  { key: 'signed-in-per-assigned', label: 'Signed-in rows per assigned row', outcomes: ['signed-in'] as OutcomeId[] },
  { key: 'installed-per-assigned', label: 'Installed rows per assigned row', outcomes: ['installed'] as OutcomeId[] },
  { key: 'response-rows-per-assigned', label: 'Response rows per assigned row (a device that both signs in and installs counts twice)', outcomes: ['signed-in', 'installed'] as OutcomeId[] },
  { key: 'responded-per-assigned', label: 'Responded rows per assigned row (once per device)', outcomes: [] as OutcomeId[], responded: true },
  { key: 'returned-per-assigned', label: 'Returned rows per assigned row (group rows only)', outcomes: ['returned'] as OutcomeId[] },
  { key: 'still-playing-per-assigned', label: 'Still-playing rows per assigned row (group rows only)', outcomes: ['still-playing'] as OutcomeId[] },
]
const askRatio = (c: AskCol, outcomes: OutcomeId[], responded = false) => {
  const f = askFeature(c.group)
  const rows = responded ? ASK_ORDER_ASKS.reduce((a, k) => a + stepCount(f, respondedStepId(k.id, c.tag), c.which), 0) : outcomeRowsOf(f, c.tag, outcomes, c.which)
  return formatRatio(ratio(rows, stepCount(f, assignedStepId(c.tag), c.which)))
}
const pct = (x: number) => `${Math.round(x * 100)}%`

const fmt = (n: number) => n.toLocaleString('en-US')
const dayLabel = (d: string | undefined) => (d ? formatKey('date', d) : '')
const rangeTitle = computed(() => (model.value ? `${model.value.meta.rangeFrom || model.value.meta.since} to ${model.value.meta.until}` : ''))
</script>

<template>
  <div class="fh-body">
    <p v-if="loading && !model" class="state mono">Loading…</p>
    <p v-else-if="error" class="state error mono">{{ error }}</p>
    <!-- The Ask-order A/B -->
    <template v-else-if="model">
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
              <span data-col="assigned">assigned rows {{ fmt(g.assigned) }}</span>
              <span data-col="primary-per-assigned" :title="askRead.primary.label">primary ({{ askRead.primary.id === 'responded' ? 'responded rows' : 'combined response rows' }}) per assigned row {{ formatRatio(g.primaryPerAssigned) }} ({{ fmt(g.primaryRows) }} rows)</span>
            </div>
            <div class="ao-nums mono ao-secondary">
              <span data-col="per-assigned-signed-in" title="Display only. Signed-in rows divided by assigned rows: a row ratio, not a per-person rate">signed-in rows per assigned row {{ formatRatio(g.perOutcome['signed-in'].perAssigned) }} ({{ fmt(g.perOutcome['signed-in'].count) }} rows)</span>
              <span data-col="per-assigned-installed" title="Display only. Installed rows divided by assigned rows: a row ratio, not a per-person rate">installed rows per assigned row {{ formatRatio(g.perOutcome['installed'].perAssigned) }} ({{ fmt(g.perOutcome['installed'].count) }} rows)</span>
            </div>
            <div class="ao-nums mono ao-secondary">
              <span data-col="responded-per-assigned" title="Once-per-device responded rows divided by assigned rows: a row ratio, not a per-person rate">responded rows per assigned row (once per device) {{ formatRatio(g.respondedPerAssigned) }} ({{ fmt(g.respondedRows) }} rows)</span>
              <span data-col="response-rows-per-assigned" title="Signed-in rows plus installed rows divided by assigned rows. A device that both signs in and installs counts twice.">response rows per assigned row (a device that both signs in and installs counts twice) {{ formatRatio(g.responseRowsPerAssigned) }}</span>
              <span v-for="o in ASK_ORDER_OUTCOMES.filter((x) => x.id === 'returned' || x.id === 'still-playing')" :key="o.id" :data-col="'per-assigned-' + o.id" title="From the group-carrying twin rows only, never from the ordinary return rows">
                {{ o.label.toLowerCase() }} rows per assigned row {{ formatRatio(g.perOutcome[o.id].perAssigned) }}
              </span>
            </div>
          </div>
        </div>
        <p class="ao-primary" :data-primary="askRead.primary.id" data-testid="ask-order-primary">{{ askRead.primary.label }}</p>
        <p class="ao-verdict" :data-state="askRead.rule.verdict.state" :data-basis="askRead.rule.basis" data-testid="ask-order-verdict">
          <span class="mono" data-col="rule-multiple">{{ ASK_ORDER_SWITCH_MULTIPLE }}x rule on {{ askRead.rule.basis === 'sign-ins' ? 'sign-ins' : 'the primary' }}, larger over smaller: {{ askRead.rule.multiple === null ? '—' : `${askRead.rule.multiple.toFixed(2)}x` }}.</span>
          {{ askRead.rule.verdict.note }}
        </p>
        <p class="ao-kinds mono" data-testid="ask-order-kinds">
          <span v-for="k in askRead.kinds" :key="k.kind" :data-col="'multiple-' + k.kind">{{ k.label }} (display only), larger over smaller: {{ k.multiple === null ? '—' : `${k.multiple.toFixed(2)}x` }}. </span>
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
            <tr v-for="r in askRatioRows" :key="r.key" :data-row="r.key">
              <td class="l fh-name" title="A count of rows divided by assigned rows: a row ratio, not a per-person rate">{{ r.label }}</td>
              <td v-for="c in askCols" :key="c.which + c.group + c.tag" class="r mono" :data-col="`${c.which}-${c.group}-${c.tag}`">{{ askRatio(c, r.outcomes, 'responded' in r) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="fh-caption" data-testid="ask-order-caption">{{ ASK_ORDER_CAPTION }}</p>
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
.fh-name {
  color: rgb(var(--ink));
  font-weight: 600;
  line-height: 20px;
}
.fh-caption {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: rgb(var(--ink-3));
}
</style>
