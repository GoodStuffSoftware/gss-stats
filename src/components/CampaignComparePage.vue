<script setup lang="ts">
// "Best Sudoku campaigns" — a dedicated, bespoke page (NOT the generic Widget/grid model
// the rest of the dashboard uses — see App.vue's isCampaignComparePage branch). It fetches
// each campaign's comparison data directly (see src/lib/campaigns.ts + functions/api/
// campaigns.ts) rather than going through fetchStats/ChartCard, because its charts (a
// side-by-side funnel, flight-day-aligned overlays, a retention curve) don't fit the
// single-dimension/metric shape every other chart in this app uses.
import { ref, computed, onMounted } from 'vue'
import type { ChartConfiguration } from 'chart.js'
import { CAMPAIGNS, FUNNEL_STEP_ORDER, FUNNEL_STEP_LABELS, RETURN_BUCKETS, ARRIVALS_CAVEAT, topShares, type CampaignFlight, type DeviceMixShare } from '../lib/campaigns'
import { MIN_COHORT, isInsufficientCohort, SMALL_SAMPLE_NOTE, PLAY_TRACKING_ACTIVATION_DATE_ET, PLAY_TRACKING_MARKER_LABEL, playTrackingStatusNote } from '../lib/popupEvents'
import type { CampaignCompareResponse, CampaignFunnelCounts } from '../types'
import { fetchCampaignCompare } from '../api'
import { PALETTE } from '../lib/charts'
import BaseChart from './charts/BaseChart.vue'
import AdsReadingsWidgetCard from './AdsReadingsWidgetCard.vue'

const loading = ref(true)
const error = ref<string | null>(null)
const dataByCampaign = ref<Record<string, CampaignCompareResponse>>({})

async function load() {
  loading.value = true
  error.value = null
  try {
    const pairs = await Promise.all(CAMPAIGNS.map(async (c) => [c.id, await fetchCampaignCompare(c.id)] as const))
    dataByCampaign.value = Object.fromEntries(pairs)
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load'
  } finally {
    loading.value = false
  }
}
onMounted(load)

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}
// `denominator`, when passed, lets a null rate distinguish "too few to report" (some data,
// under MIN_COHORT) from plain "—" (no data at all) — see lib/popupEvents.ts
// isInsufficientCohort. Every rate here is already server-gated (computeRate enforces the
// floor itself), so this is purely about which MESSAGE a null renders as.
function pct(n: number | null | undefined, denominator?: number): string {
  if (n == null) return denominator != null && isInsufficientCohort(denominator) ? 'too few to report' : '—'
  return `${(n * 100).toFixed(1)}%`
}
function prevStepCount(counts: CampaignFunnelCounts, step: keyof CampaignFunnelCounts): number {
  const idx = FUNNEL_STEP_ORDER.indexOf(step)
  return idx > 0 ? counts[FUNNEL_STEP_ORDER[idx - 1]] : 0
}
function money(n: number | null | undefined): string {
  return n == null ? '—' : `$${n.toFixed(2)}`
}

const campaignColor = (i: number) => PALETTE[i % PALETTE.length]

// ── Chart 1: funnel, side by side ───────────────────────────────────────────────────────
const funnelMax = (counts: CampaignFunnelCounts) => Math.max(1, ...FUNNEL_STEP_ORDER.map((k) => counts[k]))

// ── Chart 2: arrivals by ET hour of day, one dataset per campaign ──────────────────────
const hourChartConfig = computed<ChartConfiguration | null>(() => {
  const cs = CAMPAIGNS.filter((c) => dataByCampaign.value[c.id])
  if (!cs.length) return null
  return {
    type: 'bar',
    data: {
      labels: Array.from({ length: 24 }, (_, h) => `${h}:00`),
      datasets: cs.map((c, i) => ({
        label: c.label,
        data: dataByCampaign.value[c.id].hourOfDayEt,
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

// ── Chart 4: daily arrivals + cumulative, aligned by flight day 1..N ───────────────────
const maxFlightDay = computed(() =>
  Math.max(
    1,
    ...CAMPAIGNS.filter((c) => c.flightStart != null).map((c) => Math.round((Date.parse(c.flightEnd) - Date.parse(c.flightStart as string)) / 86_400_000) + 1),
  ),
)
const dailyChartConfig = computed<ChartConfiguration | null>(() => {
  const cs = CAMPAIGNS.filter((c) => dataByCampaign.value[c.id])
  if (!cs.length) return null
  const days = Array.from({ length: maxFlightDay.value }, (_, i) => i + 1)
  return {
    type: 'line',
    data: {
      labels: days.map((d) => `Day ${d}`),
      datasets: cs.map((c, i) => {
        const byDay = new Map(dataByCampaign.value[c.id].daily.map((r) => [r.day, r.arrivals]))
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
  const cs = CAMPAIGNS.filter((c) => dataByCampaign.value[c.id])
  if (!cs.length) return null
  const days = Array.from({ length: maxFlightDay.value }, (_, i) => i + 1)
  return {
    type: 'line',
    data: {
      labels: days.map((d) => `Day ${d}`),
      datasets: cs.map((c, i) => {
        const byDay = new Map(dataByCampaign.value[c.id].daily.map((r) => [r.day, r.arrivals]))
        let running = 0
        const cum = days.map((d) => {
          running += byDay.get(d) ?? 0
          return running
        })
        return {
          label: c.label,
          data: cum,
          borderColor: campaignColor(i),
          backgroundColor: 'transparent',
          borderDash: [5, 3],
          tension: 0.2,
          pointRadius: 0,
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

// ── Chart 7: return-visit retention curve per campaign ──────────────────────────────────
const RETURN_RATE_KEYS = RETURN_BUCKETS.filter((b) => b !== 'd0') as Exclude<(typeof RETURN_BUCKETS)[number], 'd0'>[]
function returnChartConfig(c: CampaignFlight): ChartConfiguration | null {
  const d = dataByCampaign.value[c.id]
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

// Device mix top-N shares: MIN_COHORT-gated (see lib/campaigns.ts topShares/DeviceMixShare
// — moved there, 2026-09-26 review fix, so the gating logic is unit-testable; this used to
// compute value/total directly here and bypass MIN_COHORT entirely).
function shareBarWidth(row: DeviceMixShare): number {
  return row.total ? (row.value / row.total) * 100 : 0
}
</script>

<template>
  <div class="campaign-page">
    <p class="lede">
      Attribution is by <code>campaign</code> tag only (see
      <a href="https://github.com/GoodStuffSoftware/gss-stats/blob/main/src/lib/campaigns.ts" target="_blank" rel="noopener">lib/campaigns.ts</a>) —
      no device/location/timestamp correlation across rows. Funnel steps are counted <em>within tagged sessions</em>.
      Verification and household traffic are excluded server-side.
    </p>
    <p class="lede small-sample-note">{{ SMALL_SAMPLE_NOTE }}</p>

    <div v-if="loading" class="state mono">Loading…</div>
    <div v-else-if="error" class="state error mono">{{ error }}</div>

    <template v-else>
      <!-- Chart 1: funnel, side by side -->
      <section class="block">
        <h2>Funnel per campaign</h2>
        <p class="caption">Arrivals: {{ ARRIVALS_CAVEAT }} Rates need at least {{ MIN_COHORT }} in their denominator, or they show "too few to report".</p>
        <div class="funnel-grid">
          <div v-for="(c, i) in CAMPAIGNS" :key="c.id" class="funnel-col" :style="{ '--accent': campaignColor(i) }">
            <div class="funnel-head">
              <span class="dot"></span>
              <span class="fc-label">{{ c.label }}</span>
              <span class="fc-status">{{ c.status }}</span>
            </div>
            <p v-if="c.measurement === 'spend-only'" class="state mono small">{{ c.measurabilityNote }}</p>
            <div v-if="dataByCampaign[c.id]" class="tagged-hits mono" :title="ARRIVALS_CAVEAT">
              tagged hits: {{ fmt(dataByCampaign[c.id].taggedHits) }} (vs {{ fmt(dataByCampaign[c.id].funnel.counts.arrivals) }} arrivals)
            </div>
            <div v-if="dataByCampaign[c.id]?.rawInstallSignals" class="tagged-hits mono">
              {{ dataByCampaign[c.id].rawInstallSignals!.label }}: {{ fmt(dataByCampaign[c.id].rawInstallSignals!.count) }}
            </div>
            <div v-if="dataByCampaign[c.id]" class="funnel-steps">
              <div v-for="step in FUNNEL_STEP_ORDER" :key="step" class="funnel-step">
                <div class="fs-top">
                  <span class="fs-label">{{ FUNNEL_STEP_LABELS[step] }}<template v-if="step === 'install' && dataByCampaign[c.id].funnel.installNote"> ({{ dataByCampaign[c.id].funnel.installNote }})</template></span>
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
      </section>

      <!-- Chart 2: arrivals by ET hour of day -->
      <section class="block">
        <h2>Arrivals by ET hour of day</h2>
        <p class="caption">{{ ARRIVALS_CAVEAT }}</p>
        <div class="chart-box"><BaseChart v-if="hourChartConfig" :config="hourChartConfig" :drill-open="false" @point="() => {}" /></div>
      </section>

      <!-- Chart 3: arrivals + funnel by country -->
      <section class="block">
        <h2>Arrivals &amp; funnel by country (US / CA / other)</h2>
        <div class="country-grid">
          <div v-for="(c, i) in CAMPAIGNS" :key="c.id" class="country-col" :style="{ '--accent': campaignColor(i) }">
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
      </section>

      <!-- Chart 4: daily arrivals + cumulative, aligned by flight day -->
      <section class="block">
        <h2>Daily arrivals by flight day (1..N, overlaid)</h2>
        <p class="caption">{{ ARRIVALS_CAVEAT }}</p>
        <div class="two-col">
          <div class="chart-box"><BaseChart v-if="dailyChartConfig" :config="dailyChartConfig" :drill-open="false" @point="() => {}" /></div>
          <div class="chart-box"><BaseChart v-if="cumulativeChartConfig" :config="cumulativeChartConfig" :drill-open="false" @point="() => {}" /></div>
        </div>
        <p class="caption">Left: arrivals per flight day. Right: cumulative arrivals per flight day (dashed).</p>
      </section>

      <!-- Chart 5: cost per tagged arrival and per auth success -->
      <section class="block">
        <h2>Cost per tagged arrival / auth success</h2>
        <p class="caption">{{ ARRIVALS_CAVEAT }}</p>
        <div class="cost-grid">
          <div v-for="c in CAMPAIGNS" :key="c.id" class="cost-card">
            <div class="fc-label">{{ c.label }}</div>
            <div v-if="dataByCampaign[c.id]" class="cost-rows">
              <div class="cost-row"><span>Spend</span><span class="mono">{{ money(dataByCampaign[c.id].spend) }}</span></div>
              <div v-if="dataByCampaign[c.id].spendSource" class="cost-row">
                <span>Source</span>
                <span class="mono">{{ dataByCampaign[c.id].spendSource!.source === 'google-ads-api' ? `Ads API, through ${dataByCampaign[c.id].spendSource!.lastDate}` : dataByCampaign[c.id].spendSource!.source === 'config' ? 'hand-entered' : '—' }}</span>
              </div>
              <div class="cost-row"><span>Per arrival</span><span class="mono">{{ money(dataByCampaign[c.id].costPerArrival) }}</span></div>
              <div class="cost-row"><span>Per auth success</span><span class="mono">{{ money(dataByCampaign[c.id].costPerAuthSuccess) }}</span></div>
            </div>
          </div>
        </div>
        <p class="caption">Spend comes from the Google Ads API as stored by the ads-read routine; campaigns with nothing stored fall back to the hand-entered <code>CAMPAIGN_SPEND</code> (lib/campaigns.ts).</p>
      </section>

      <!-- Ads-read routine readings log — a self-contained widget (fetches /api/ads/readings) -->
      <section class="block">
        <h2>Readings log (ads routine)</h2>
        <AdsReadingsWidgetCard :widget="{ view: 'log' }" />
      </section>

      <!-- Chart 6: device mix -->
      <section class="block">
        <h2>Device mix</h2>
        <div class="device-grid">
          <div v-for="c in CAMPAIGNS" :key="c.id" class="device-col">
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
      </section>

      <!-- Return visits (aggregate-only, on-device beacon — see lib/campaigns.ts) -->
      <section class="block">
        <h2>Return visits (on-device, web only)</h2>
        <p class="caption">
          Android/Play: {{ PLAY_TRACKING_ACTIVATION_DATE_ET ? PLAY_TRACKING_MARKER_LABEL : '' }} {{ playTrackingStatusNote() }}
        </p>
        <div class="return-grid">
          <div v-for="c in CAMPAIGNS" :key="c.id" class="return-col">
            <div class="fc-label">{{ c.label }}</div>
            <template v-if="dataByCampaign[c.id]">
              <p v-if="dataByCampaign[c.id].returnVisits.notInstrumented" class="state mono small">not instrumented</p>
              <p v-else-if="dataByCampaign[c.id].returnVisits.sharedWithCampaignId" class="caption">
                Shares its tag with another flight — not separable by return beacon.
              </p>
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
        <p class="caption">Rate per bucket = bucket count / d0 (first tagged load). "not yet observable" until enough time has passed.</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.campaign-page {
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.lede {
  font-size: 12.5px;
  color: rgb(var(--ink-2));
  max-width: 900px;
}
.lede code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11.5px;
}
.state {
  padding: 40px 0;
  text-align: center;
  color: rgb(var(--ink-3));
}
.state.small {
  padding: 10px 0;
}
.state.error {
  color: #bc4749;
}
.block h2 {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
}
.caption {
  font-size: 11.5px;
  color: rgb(var(--ink-3));
  margin-top: 6px;
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
  height: 280px;
}
.chart-box.small {
  height: 180px;
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
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
