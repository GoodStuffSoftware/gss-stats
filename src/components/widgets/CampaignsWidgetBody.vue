<script setup lang="ts">
// dataset 'campaigns' widget body — renders ONE panel of the former bespoke
// CampaignComparePage.vue (widget.view selects which; widget.campaignIds narrows which
// campaigns show, empty/undefined = all), so each panel is now independently
// movable/resizable/removable/re-addable like any other widget. Data fetching + all
// formatting/chart-building logic is unchanged, shared across widgets via
// lib/campaignsData.ts instead of fetched per page-mount.
import { computed } from 'vue'
import type { ChartConfiguration } from 'chart.js'
import type { Widget, CampaignFunnelCounts } from '../../types'
import { useCampaignsData } from '../../lib/campaignsData'
import { FUNNEL_STEP_ORDER, FUNNEL_STEP_LABELS, RETURN_BUCKETS, ARRIVALS_CAVEAT, topShares, type CampaignFlight, type DeviceMixShare } from '../../lib/campaigns'
import { MIN_COHORT, isInsufficientCohort, PLAY_TRACKING_ACTIVATION_DATE_ET, PLAY_TRACKING_MARKER_LABEL, playTrackingStatusNote } from '../../lib/popupEvents'
import { PALETTE } from '../../lib/charts'
import BaseChart from '../charts/BaseChart.vue'

const props = defineProps<{ widget: Widget }>()

const { campaigns, dataByCampaign, loading, error } = useCampaignsData(() => props.widget.campaignIds)

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}
function pct(n: number | null | undefined, denominator?: number): string {
  if (n == null) return denominator != null && isInsufficientCohort(denominator) ? 'too few to report' : '—'
  return `${(n * 100).toFixed(1)}%`
}
function prevStepCount(cnts: CampaignFunnelCounts, step: keyof CampaignFunnelCounts): number {
  const idx = FUNNEL_STEP_ORDER.indexOf(step)
  return idx > 0 ? cnts[FUNNEL_STEP_ORDER[idx - 1]] : 0
}
function money(n: number | null | undefined): string {
  return n == null ? '—' : `$${n.toFixed(2)}`
}
const campaignColor = (i: number) => PALETTE[i % PALETTE.length]
const funnelMax = (cnts: CampaignFunnelCounts) => Math.max(1, ...FUNNEL_STEP_ORDER.map((k) => cnts[k]))

const hourChartConfig = computed<ChartConfiguration | null>(() => {
  const cs = campaigns.value.filter((c) => dataByCampaign[c.id])
  if (!cs.length) return null
  return {
    type: 'bar',
    data: {
      labels: Array.from({ length: 24 }, (_, h) => `${h}:00`),
      datasets: cs.map((c, i) => ({
        label: c.label,
        data: dataByCampaign[c.id].hourOfDayEt,
        backgroundColor: campaignColor(i),
        borderRadius: 3,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
      scales: { x: { stacked: false }, y: { beginAtZero: true } },
    },
  }
})

const maxFlightDay = computed(() =>
  Math.max(
    1,
    ...campaigns.value.filter((c) => c.flightStart != null).map((c) => Math.round((Date.parse(c.flightEnd) - Date.parse(c.flightStart as string)) / 86_400_000) + 1),
  ),
)
const dailyChartConfig = computed<ChartConfiguration | null>(() => {
  const cs = campaigns.value.filter((c) => dataByCampaign[c.id])
  if (!cs.length) return null
  const days = Array.from({ length: maxFlightDay.value }, (_, i) => i + 1)
  return {
    type: 'line',
    data: {
      labels: days.map((d) => `Day ${d}`),
      datasets: cs.map((c, i) => {
        const byDay = new Map(dataByCampaign[c.id].daily.map((r) => [r.day, r.arrivals]))
        return {
          label: c.label,
          data: days.map((d) => byDay.get(d) ?? 0),
          borderColor: campaignColor(i),
          backgroundColor: campaignColor(i),
          tension: 0.25,
          pointRadius: 2,
        }
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
      scales: { y: { beginAtZero: true } },
    },
  }
})
const cumulativeChartConfig = computed<ChartConfiguration | null>(() => {
  const cs = campaigns.value.filter((c) => dataByCampaign[c.id])
  if (!cs.length) return null
  const days = Array.from({ length: maxFlightDay.value }, (_, i) => i + 1)
  return {
    type: 'line',
    data: {
      labels: days.map((d) => `Day ${d}`),
      datasets: cs.map((c, i) => {
        const byDay = new Map(dataByCampaign[c.id].daily.map((r) => [r.day, r.arrivals]))
        let running = 0
        const cum = days.map((d) => {
          running += byDay.get(d) ?? 0
          return running
        })
        return { label: c.label, data: cum, borderColor: campaignColor(i), backgroundColor: 'transparent', borderDash: [5, 3], tension: 0.2, pointRadius: 0 }
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
      scales: { y: { beginAtZero: true } },
    },
  }
})

const RETURN_RATE_KEYS = RETURN_BUCKETS.filter((b) => b !== 'd0') as Exclude<(typeof RETURN_BUCKETS)[number], 'd0'>[]
function returnChartConfig(c: CampaignFlight): ChartConfiguration | null {
  const d = dataByCampaign[c.id]
  if (!d || d.returnVisits.notInstrumented) return null
  return {
    type: 'line',
    data: {
      labels: RETURN_RATE_KEYS,
      datasets: [
        {
          label: c.label,
          data: RETURN_RATE_KEYS.map((k) => (d.returnVisits.rates[k] == null ? null : (d.returnVisits.rates[k] as number) * 100)),
          borderColor: PALETTE[0],
          backgroundColor: 'rgba(224,114,44,0.15)',
          fill: true,
          spanGaps: false,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { callback: (v: any) => `${v}%` } } },
    },
  }
}
function shareBarWidth(row: DeviceMixShare): number {
  return row.total ? (row.value / row.total) * 100 : 0
}
</script>

<template>
  <div class="cw-body">
    <div v-if="loading && !Object.keys(dataByCampaign).length" class="state mono">Loading…</div>
    <div v-else-if="error" class="state error mono">{{ error }}</div>

    <template v-else>
      <!-- funnel -->
      <template v-if="widget.view === 'funnel'">
        <p class="caption">{{ ARRIVALS_CAVEAT }} Rates need at least {{ MIN_COHORT }} in their denominator, or they show "too few to report".</p>
        <div class="funnel-grid">
          <div v-for="(c, i) in campaigns" :key="c.id" class="funnel-col" :style="{ '--accent': campaignColor(i) }">
            <div class="funnel-head">
              <span class="dot"></span>
              <span class="fc-label">{{ c.label }}</span>
              <span class="fc-status">{{ c.status }}</span>
            </div>
            <p v-if="c.measurement === 'spend-only'" class="state mono small">{{ c.measurabilityNote }}</p>
            <div v-if="dataByCampaign[c.id]" class="tagged-hits mono" :title="ARRIVALS_CAVEAT">
              tagged hits: {{ fmt(dataByCampaign[c.id].taggedHits) }} (vs {{ fmt(dataByCampaign[c.id].funnel.counts.arrivals) }} arrivals)
            </div>
            <div v-if="dataByCampaign[c.id]" class="funnel-steps">
              <div v-for="step in FUNNEL_STEP_ORDER" :key="step" class="funnel-step">
                <div class="fs-top">
                  <span class="fs-label">{{ FUNNEL_STEP_LABELS[step] }}</span>
                  <span class="fs-count mono">
                    <template v-if="dataByCampaign[c.id].funnel.notInstrumented.includes(step)">not instrumented</template>
                    <template v-else>{{ fmt(dataByCampaign[c.id].funnel.counts[step]) }}</template>
                  </span>
                </div>
                <div class="fs-bar-wrap">
                  <span
                    v-if="!dataByCampaign[c.id].funnel.notInstrumented.includes(step)"
                    class="fs-bar"
                    :style="{ width: (dataByCampaign[c.id].funnel.counts[step] / funnelMax(dataByCampaign[c.id].funnel.counts)) * 100 + '%' }"
                  ></span>
                </div>
                <div class="fs-rate mono">
                  <template v-if="dataByCampaign[c.id].funnel.notInstrumented.includes(step)">not instrumented</template>
                  <template v-else-if="step !== 'arrivals'">
                    {{ pct(dataByCampaign[c.id].funnel.rates[step], prevStepCount(dataByCampaign[c.id].funnel.counts, step)) }} of previous step
                    ({{ fmt(dataByCampaign[c.id].funnel.counts[step]) }}/{{ fmt(prevStepCount(dataByCampaign[c.id].funnel.counts, step)) }})
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- hourOfDay -->
      <template v-else-if="widget.view === 'hourOfDay'">
        <p class="caption">{{ ARRIVALS_CAVEAT }}</p>
        <div class="chart-box"><BaseChart v-if="hourChartConfig" :config="hourChartConfig" :drill-open="false" @point="() => {}" /></div>
      </template>

      <!-- country -->
      <template v-else-if="widget.view === 'country'">
        <div class="country-grid">
          <div v-for="(c, i) in campaigns" :key="c.id" class="country-col" :style="{ '--accent': campaignColor(i) }">
            <div class="fc-label">{{ c.label }}</div>
            <table v-if="dataByCampaign[c.id]" class="country-table">
              <thead>
                <tr><th>Step</th><th>US</th><th>CA</th><th>Other</th></tr>
              </thead>
              <tbody>
                <tr v-for="step in FUNNEL_STEP_ORDER" :key="step">
                  <td>{{ FUNNEL_STEP_LABELS[step] }}</td>
                  <td class="mono">{{ fmt(dataByCampaign[c.id].funnelByCountry.US[step]) }}</td>
                  <td class="mono">{{ fmt(dataByCampaign[c.id].funnelByCountry.CA[step]) }}</td>
                  <td class="mono">{{ fmt(dataByCampaign[c.id].funnelByCountry.other[step]) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>

      <!-- flightDay -->
      <template v-else-if="widget.view === 'flightDay'">
        <p class="caption">{{ ARRIVALS_CAVEAT }}</p>
        <div class="two-col">
          <div class="chart-box"><BaseChart v-if="dailyChartConfig" :config="dailyChartConfig" :drill-open="false" @point="() => {}" /></div>
          <div class="chart-box"><BaseChart v-if="cumulativeChartConfig" :config="cumulativeChartConfig" :drill-open="false" @point="() => {}" /></div>
        </div>
        <p class="caption">Left: arrivals per flight day. Right: cumulative arrivals per flight day (dashed).</p>
      </template>

      <!-- cost -->
      <template v-else-if="widget.view === 'cost'">
        <p class="caption">{{ ARRIVALS_CAVEAT }}</p>
        <div class="cost-grid">
          <div v-for="c in campaigns" :key="c.id" class="cost-card">
            <div class="fc-label">{{ c.label }}</div>
            <div v-if="dataByCampaign[c.id]" class="cost-rows">
              <div class="cost-row"><span>Spend</span><span class="mono">{{ money(dataByCampaign[c.id].spend) }}</span></div>
              <div class="cost-row"><span>Per arrival</span><span class="mono">{{ money(dataByCampaign[c.id].costPerArrival) }}</span></div>
              <div class="cost-row"><span>Per auth success</span><span class="mono">{{ money(dataByCampaign[c.id].costPerAuthSuccess) }}</span></div>
            </div>
          </div>
        </div>
        <p v-if="campaigns.some((c) => dataByCampaign[c.id]?.spend == null)" class="caption">Spend comes from Google Ads and is entered by hand in <code>CAMPAIGN_SPEND</code> (lib/campaigns.ts).</p>
      </template>

      <!-- deviceMix -->
      <template v-else-if="widget.view === 'deviceMix'">
        <div class="device-grid">
          <div v-for="c in campaigns" :key="c.id" class="device-col">
            <div class="fc-label">{{ c.label }}</div>
            <template v-if="dataByCampaign[c.id]">
              <div v-for="(rows, kind) in { OS: dataByCampaign[c.id].deviceMix.os, Browser: dataByCampaign[c.id].deviceMix.browser, Screen: dataByCampaign[c.id].deviceMix.screen }" :key="kind" class="device-block">
                <div class="device-kind overline">{{ kind }}</div>
                <div v-for="row in topShares(rows)" :key="row.label" class="share-row">
                  <span class="share-label">{{ row.label }}</span>
                  <span class="share-bar-wrap"><span class="share-bar" :style="{ width: shareBarWidth(row) + '%' }"></span></span>
                  <span class="share-pct mono">{{ pct(row.rate, row.total) }} ({{ fmt(row.value) }}/{{ fmt(row.total) }})</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </template>

      <!-- returns -->
      <template v-else-if="widget.view === 'returns'">
        <p class="caption">Android/Play: {{ PLAY_TRACKING_ACTIVATION_DATE_ET ? PLAY_TRACKING_MARKER_LABEL : '' }} {{ playTrackingStatusNote() }}</p>
        <div class="return-grid">
          <div v-for="c in campaigns" :key="c.id" class="return-col">
            <div class="fc-label">{{ c.label }}</div>
            <template v-if="dataByCampaign[c.id]">
              <p v-if="dataByCampaign[c.id].returnVisits.notInstrumented" class="state mono small">not instrumented</p>
              <p v-else-if="dataByCampaign[c.id].returnVisits.sharedWithCampaignId" class="caption">Shares its tag with another flight — not separable by return beacon.</p>
              <p v-else-if="isInsufficientCohort(dataByCampaign[c.id].returnVisits.counts.d0)" class="state mono small">
                too few to report (d0 = {{ fmt(dataByCampaign[c.id].returnVisits.counts.d0) }}, need {{ MIN_COHORT }})
              </p>
              <template v-else>
                <div class="chart-box small"><BaseChart v-if="returnChartConfig(c)" :config="returnChartConfig(c)!" :drill-open="false" @point="() => {}" /></div>
                <p class="caption mono small return-counts">
                  d0={{ fmt(dataByCampaign[c.id].returnVisits.counts.d0) }}
                  <span v-for="k in RETURN_RATE_KEYS" :key="k">
                    · {{ k }}={{ pct(dataByCampaign[c.id].returnVisits.rates[k], dataByCampaign[c.id].returnVisits.counts.d0) }}
                    ({{ fmt(dataByCampaign[c.id].returnVisits.counts[k]) }}/{{ fmt(dataByCampaign[c.id].returnVisits.counts.d0) }})
                  </span>
                </p>
              </template>
            </template>
          </div>
        </div>
        <p class="caption">Rate per bucket = bucket count / d0 (first tagged load).</p>
      </template>

      <p v-else class="state mono">Unknown campaigns panel "{{ widget.view }}"</p>
    </template>
  </div>
</template>

<style scoped>
.cw-body {
  height: 100%;
  overflow: auto;
}
.state {
  padding: 20px 0;
  text-align: center;
  color: rgb(var(--ink-3));
}
.state.small {
  padding: 10px 0;
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
.funnel-grid,
.country-grid,
.cost-grid,
.device-grid,
.return-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 14px;
}
.funnel-col,
.country-col,
.cost-card,
.device-col,
.return-col {
  border: 1px solid rgb(var(--line));
  border-radius: 12px;
  padding: 12px 14px;
  background: rgb(var(--surface));
}
.funnel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.tagged-hits {
  font-size: 10px;
  color: rgb(var(--ink-3));
  margin-bottom: 8px;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}
.fc-label {
  font-weight: 600;
  font-size: 12.5px;
  color: rgb(var(--ink));
}
.fc-status {
  margin-left: auto;
  font-size: 10.5px;
  text-transform: uppercase;
  color: rgb(var(--ink-3));
}
.funnel-step {
  margin-bottom: 9px;
}
.fs-top {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  margin-bottom: 3px;
}
.fs-label {
  color: rgb(var(--ink-2));
}
.fs-count {
  color: rgb(var(--ink));
}
.fs-bar-wrap {
  height: 6px;
  border-radius: 3px;
  background: rgb(var(--sunken));
  overflow: hidden;
}
.fs-bar {
  display: block;
  height: 100%;
  background: var(--accent);
  min-width: 2px;
}
.fs-rate {
  margin-top: 2px;
  font-size: 10px;
  color: rgb(var(--ink-3));
}
.chart-box {
  height: 100%;
  min-height: 200px;
}
.chart-box.small {
  min-height: 150px;
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  height: 100%;
}
@media (max-width: 700px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
.country-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.country-table th,
.country-table td {
  padding: 4px 6px;
  text-align: right;
  border-bottom: 1px solid rgb(var(--line));
}
.country-table th:first-child,
.country-table td:first-child {
  text-align: left;
  color: rgb(var(--ink-2));
}
.cost-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cost-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.device-block {
  margin-bottom: 10px;
}
.device-kind {
  margin-bottom: 4px;
}
.share-row {
  display: grid;
  grid-template-columns: 90px 1fr 44px;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  margin-bottom: 3px;
}
.share-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--ink-2));
}
.share-bar-wrap {
  height: 6px;
  border-radius: 3px;
  background: rgb(var(--sunken));
  overflow: hidden;
}
.share-bar {
  display: block;
  height: 100%;
  background: rgb(var(--amber));
  min-width: 2px;
}
.share-pct {
  text-align: right;
  color: rgb(var(--ink-2));
}
</style>
