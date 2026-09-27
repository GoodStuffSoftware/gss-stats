<script setup lang="ts">
// dataset 'overview' widget body — renders ONE panel of the former bespoke OverviewPage.vue
// (widget.view selects which: 'kpis' | 'scorecard' | 'releasePanel'; the former 'timeline'
// panel is the standard line chart now — lib/defaults.ts timelineWidget), so each
// panel is now independently movable/resizable/removable/re-addable like any other widget.
// Data fetching + all formatting/chart-building logic is unchanged from OverviewPage.vue,
// just shared across widgets via lib/overviewData.ts instead of fetched per page-mount.
import { computed, ref, watch } from 'vue'
import type { GlobalFilters, Widget, OverviewResponse } from '../../types'
import { useOverviewData } from '../../lib/overviewData'
import { FUNNEL_STEP_ORDER, VALID_FUNNEL_RATE_STEPS, type FunnelStepKey } from '../../lib/campaigns'
import { noteRawText, funnelStepLabel } from '../../lib/notes'
import { fmtCount as fmt, pct, counts, money, deltaLabel, deltaClass, kpiComparisonGate } from '../../lib/kpiFormat'
import type { CampaignFunnelCounts } from '../../types'

const props = defineProps<{ widget: Widget; filters: GlobalFilters; dark?: boolean }>()
const emit = defineEmits<{ 'open-campaigns': [] }>()

const { data, loading, error, reload } = useOverviewData(
  () => props.filters.since,
  () => props.filters.until,
)

// LOW review fix: the old bespoke "Today at a glance" section had its own refresh button +
// "Updated Xs ago" indicator (independent of ChartCard's generic reload button, which is
// hidden for this dataset — see ChartCard.vue's isBespokeBody). Restored here, scoped to the
// 'kpis' view specifically (the one panel that benefits most from an at-a-glance freshness
// check), wired to the shared composable's reload().
const lastUpdated = ref<Date | null>(null)
watch(
  data,
  (d) => {
    if (d) lastUpdated.value = new Date()
  },
  { immediate: true },
)
function relTime(d: Date | null): string {
  if (!d) return ''
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  return `${Math.round(s / 60)}m ago`
}

// fmt/pct/counts/money/deltaLabel/deltaClass now live in lib/kpiFormat.ts (pure, unit-tested —
// fix/clean-look, 2026-09-26: pulled out so the delta-rounding fix doesn't need a mounted
// component to verify). `noteRawText` stays a direct dependency here for the funnel-step
// "not instrumented" label below.
function prevFunnelCount(cnts: CampaignFunnelCounts, step: keyof CampaignFunnelCounts): number {
  const idx = FUNNEL_STEP_ORDER.indexOf(step)
  return idx > 0 ? cnts[FUNNEL_STEP_ORDER[idx - 1]] : 0
}
// Every step but 'arrivals' — the scorecard chip list. Iterated directly (not via
// row.funnelRates, which only ever holds 'accept'/'install' now) so a plain-count step still
// gets a chip, just with no percent — see VALID_FUNNEL_RATE_STEPS.
const scorecardSteps = FUNNEL_STEP_ORDER.filter((s) => s !== 'arrivals')

// Go-live-boundary gating (coordinator addition, 2026-09-26 — see lib/kpiFormat.ts
// kpiComparisonGate): a tile whose metric only started existing partway through its own
// "vs yesterday"/"vs 7d avg" window reads as nonsense (e.g. Games completed, gated on
// GAME_COMPLETE_LIVE_AT, comparing today's real count against days before the beacon existed).
function gateFor(k: { key: string }) {
  return kpiComparisonGate(k.key, data.value?.todayEt ?? '')
}

</script>

<template>
  <div class="ow-body">
    <div v-if="loading && !data" class="state mono">Loading…</div>
    <div v-else-if="error" class="state error mono">{{ error }}</div>

    <template v-else-if="data">
      <!-- kpis -->
      <template v-if="widget.view === 'kpis'">
        <div class="kpi-head">
          <span v-if="lastUpdated" class="last-updated mono">Updated {{ relTime(lastUpdated) }}</span>
          <button class="btn-ghost icon" title="Refresh" @click="reload">↻</button>
        </div>
      <div class="kpi-grid">
        <div v-for="k in data.kpis" :key="k.key" class="kpi-tile">
          <div class="kpi-label" :title="k.label">{{ k.label }}</div>
          <div v-if="k.note" class="kpi-note">{{ k.note }}</div>
          <template v-if="k.noCampaignFlighting">
            <div class="kpi-num small">no campaign flighting today</div>
          </template>
          <template v-else-if="k.notYetTracking">
            <div class="kpi-num small">not yet tracking</div>
          </template>
          <template v-else>
            <div class="kpi-num">{{ k.isRate ? pct(k.today, k.denominator) : fmt(k.today) }}</div>
            <div v-if="k.isRate && k.denominator != null" class="kpi-sub mono">{{ counts(k.numerator, k.denominator) }}</div>
            <!-- Go-live gating: a metric with no valid comparison day at all yet (e.g. "Games
                 completed" the day it shipped) says so plainly instead of hiding the row
                 outright or showing a nonsense delta across the go-live boundary. -->
            <div v-if="gateFor(k).newToday" class="kpi-delta new">new today</div>
            <template v-else>
              <div v-if="k.vsYesterday && !gateFor(k).hideVsYesterday" class="kpi-delta" :class="deltaClass(k.vsYesterday)">vs yesterday {{ deltaLabel(k.vsYesterday) }}</div>
              <div v-if="k.vsAvg7 && !gateFor(k).hideVsAvg7" class="kpi-delta" :class="deltaClass(k.vsAvg7)">vs 7d avg {{ deltaLabel(k.vsAvg7) }}</div>
            </template>
          </template>
        </div>
      </div>
      </template>

      <!-- scorecard -->
      <template v-else-if="widget.view === 'scorecard'">
        <div class="scorecard-grid">
          <div v-for="row in data.scorecard" class="scorecard-card" :key="row.id" role="button" tabindex="0" @click="emit('open-campaigns')" @keyup.enter="emit('open-campaigns')">
            <div class="sc-head">
              <span class="sc-label">{{ row.label }}</span>
              <span class="sc-status" :class="row.flightingToday ? 'live' : ''">{{ row.flightingToday ? 'flighting today' : row.status }}</span>
            </div>
            <div class="sc-row">
              <span>Flight</span>
              <span class="mono">
                <template v-if="row.flightStart == null">pending — start date not yet confirmed</template>
                <template v-else>{{ row.flightStart }} → {{ row.flightEnd }} ({{ row.flightDays }}d)</template>
              </span>
            </div>
            <div class="sc-row"><span>Tagged arrivals</span><span class="mono">{{ fmt(row.taggedArrivals) }}</span></div>
            <div class="sc-row"><span>Auth successes</span><span class="mono">{{ fmt(row.authSuccess) }}</span></div>
            <div class="sc-row"><span>Installs</span><span class="mono">{{ fmt(row.install) }}</span></div>
            <div class="sc-row"><span>Return rate (d2-7)</span><span class="mono">{{ pct(row.returnRateD2to7, row.returnD0) }} {{ counts(row.returnD2to7, row.returnD0) }}</span></div>
            <div class="sc-row"><span>Cost / arrival</span><span class="mono">{{ money(row.costPerArrival) }}</span></div>
            <div class="sc-rates">
              <!-- Iterates FUNNEL_STEP_ORDER, not row.funnelRates — funnelStepRates only ever
                   populates 'accept'/'install' now (see lib/campaigns.ts
                   VALID_FUNNEL_RATE_STEPS), but every OTHER step still shows its plain count
                   as a chip, just with no percent (audit finding, 2026-09-26: those "rates"
                   mixed event-row counts against arrival/other-row counts with no shared
                   visitor id — not real percentages). -->
              <template v-for="step in scorecardSteps" :key="step">
                <!-- Closed campaign: a step its flight never saw ANY hit for is OMITTED, not
                     labeled "not instrumented" (owner clarification, 2026-09-26 — "closed
                     campaigns" scope). Active/upcoming: unchanged — row.notInstrumented is
                     always [] for them, so this condition is never true. -->
                <span
                  v-if="row.status !== 'closed' || !row.notInstrumented.includes(step as keyof CampaignFunnelCounts)"
                  class="sc-rate-chip"
                  :title="funnelStepLabel(step as FunnelStepKey)"
                >
                  {{ funnelStepLabel(step as FunnelStepKey) }}:
                  <!-- Bug fix (owner report, 2026-09-26): this used to check the PERMANENT
                       global FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED constant (always contains
                       'completed'), so a campaign whose flight window is well after
                       GAME_COMPLETE_LIVE_AT still showed "not instrumented" instead of its
                       real count. row.notInstrumented is the ACTUAL per-row instrumentation
                       state for every status (functions/api/overview.ts's notInstrumentedSet —
                       the real per-flight check for a closed campaign, gameCompleteNotInstrumented
                       for an active/upcoming one), so it reflects whether 'completed' has gone
                       live for THIS campaign, not just whether the beacon exists at all. -->
                  <template v-if="row.notInstrumented.includes(step as keyof CampaignFunnelCounts)">{{ noteRawText('not-instrumented') }}</template>
                  <template v-else-if="step === 'install'"
                    >{{ pct(row.funnelRates.install, row.installPromptPostFixCount) }} {{ counts(row.funnelCounts.install, row.installPromptPostFixCount) }}</template
                  >
                  <template v-else-if="VALID_FUNNEL_RATE_STEPS.has(step as FunnelStepKey)"
                    >{{ pct(row.funnelRates[step as keyof CampaignFunnelCounts], prevFunnelCount(row.funnelCounts, step as keyof CampaignFunnelCounts)) }}
                    {{ counts(row.funnelCounts[step as keyof CampaignFunnelCounts], prevFunnelCount(row.funnelCounts, step as keyof CampaignFunnelCounts)) }}</template
                  >
                  <template v-else>{{ fmt(row.funnelCounts[step as keyof CampaignFunnelCounts]) }}</template>
                </span>
              </template>
            </div>
          </div>
        </div>
      </template>

      <!-- releasePanel -->
      <template v-else-if="widget.view === 'releasePanel'">
        <template v-if="data.releasePanel">
          <p class="caption">{{ data.releasePanel.release.version }} ({{ data.releasePanel.release.dateEt }}) — {{ data.releasePanel.days }} days before vs after. {{ data.releasePanel.note }}</p>
          <div class="release-grid">
            <div class="release-col">
              <div class="fc-label">Before</div>
              <div class="rel-row"><span>Page views</span><span class="mono">{{ fmt(data.releasePanel.before.pageviews) }}</span></div>
              <div class="rel-row"><span>Tagged arrivals</span><span class="mono">{{ fmt(data.releasePanel.before.taggedArrivals) }}</span></div>
              <div class="rel-row"><span>Auth successes</span><span class="mono">{{ fmt(data.releasePanel.before.authSuccess) }}</span></div>
              <div class="rel-row"><span>Installs</span><span class="mono">{{ fmt(data.releasePanel.before.install) }}</span></div>
            </div>
            <div class="release-col">
              <div class="fc-label">After</div>
              <div class="rel-row"><span>Page views</span><span class="mono">{{ fmt(data.releasePanel.after.pageviews) }}</span></div>
              <div class="rel-row"><span>Tagged arrivals</span><span class="mono">{{ fmt(data.releasePanel.after.taggedArrivals) }}</span></div>
              <div class="rel-row"><span>Auth successes</span><span class="mono">{{ fmt(data.releasePanel.after.authSuccess) }}</span></div>
              <div class="rel-row"><span>Installs</span><span class="mono">{{ fmt(data.releasePanel.after.install) }}</span></div>
            </div>
          </div>
        </template>
        <p v-else class="caption">No dated release yet. This panel fills in once a release has a date.</p>
      </template>

      <p v-else class="state mono">Unknown overview panel "{{ widget.view }}"</p>
    </template>
  </div>
</template>

<style scoped>
.kpi-note {
  font-size: 10.5px;
  line-height: 1.3;
  color: rgb(var(--ink-3));
  margin: 1px 0 3px;
  overflow-wrap: anywhere;
}
.ow-body {
  /* flex column, not a plain block with height:100% (fix/clean-look, 2026-09-26): a
     percentage height on .chart-box below needs its ancestor chain to resolve to a
     DEFINITE pixel size at every step, and on mobile — where the card's own height now
     comes from its content (Dashboard.vue's height:auto) rather than a fixed box — that
     chain broke, leaving Chart.js's canvas stuck at its hard-coded 150px fallback height
     instead of actually filling the card. flex:1 on .chart-box sizes it against the
     flex container's real resolved height instead, which doesn't have that failure mode. */
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.state {
  padding: 20px 0;
  text-align: center;
  color: rgb(var(--ink-3));
}
.state.error {
  color: #bc4749;
}
.caption {
  font-size: 11.5px;
  color: rgb(var(--ink-3));
  margin: 0 0 10px;
}
.caption code {
  font-family: 'JetBrains Mono', monospace;
}
.kpi-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 8px;
}
.last-updated {
  font-size: 11px;
  color: rgb(var(--ink-3));
}
.btn-ghost.icon {
  border: none;
  background: transparent;
  color: rgb(var(--ink-3));
  font-size: 15px;
  padding: 3px 7px;
  border-radius: 7px;
  cursor: pointer;
}
.btn-ghost.icon:hover {
  background: rgb(var(--sunken));
  color: rgb(var(--ink));
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.kpi-tile {
  border: 1px solid rgb(var(--line));
  border-radius: 12px;
  padding: 10px 12px;
  background: rgb(var(--surface));
  min-width: 0;
}
.kpi-label {
  font-size: 11px;
  color: rgb(var(--ink-3));
  margin-bottom: 4px;
  /* Wrap up to 2 lines instead of truncating a whole clause to "…" (owner-reported
     regression, 2026-09-26: "Tagged arrivals — US+CA …" / "Installs (install fix went live …"
     were unreadable) — the full label is still one tap/hover away via the title attribute. */
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.kpi-num {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 22px;
  font-weight: 700;
  color: rgb(var(--ink));
}
.kpi-num.small {
  font-size: 12px;
  font-weight: 500;
  color: rgb(var(--ink-3));
  font-family: Inter, sans-serif;
}
.kpi-delta {
  font-size: 10.5px;
  color: rgb(var(--ink-3));
  margin-top: 2px;
}
.kpi-sub {
  font-size: 10.5px;
  color: rgb(var(--ink-3));
  margin-top: 1px;
}
.kpi-delta.up {
  color: #6a994e;
}
.kpi-delta.down {
  color: #bc4749;
}
.kpi-delta.new {
  color: rgb(var(--amber-hover));
}
.chart-box {
  flex: 1;
  min-height: 220px;
}
.scorecard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 14px;
}
.scorecard-card {
  border: 1px solid rgb(var(--line));
  border-radius: 12px;
  padding: 12px 14px;
  background: rgb(var(--surface));
  cursor: pointer;
}
.scorecard-card:hover {
  border-color: rgb(var(--amber));
}
.sc-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 8px;
}
.sc-label {
  font-weight: 600;
  font-size: 12.5px;
}
.sc-status {
  font-size: 10px;
  text-transform: uppercase;
  color: rgb(var(--ink-3));
}
.sc-status.live {
  color: rgb(var(--amber-hover));
}
.sc-row {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  margin-bottom: 3px;
  color: rgb(var(--ink-2));
}
.sc-rates {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sc-rate-chip {
  font-size: 9.5px;
  background: rgb(var(--sunken));
  border-radius: 6px;
  padding: 2px 6px;
  color: rgb(var(--ink-3));
}
.release-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}
.release-col {
  border: 1px solid rgb(var(--line));
  border-radius: 12px;
  padding: 12px 14px;
  background: rgb(var(--surface));
}
.fc-label {
  font-weight: 600;
  font-size: 12.5px;
  margin-bottom: 6px;
}
.rel-row {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  margin-bottom: 3px;
}
</style>
