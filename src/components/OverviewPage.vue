<script setup lang="ts">
// "Best Sudoku overview" (Part C) — a bespoke page, same shape as CampaignComparePage.vue:
// fetches its own data from /api/overview instead of going through the generic Widget/
// ChartCard pipeline, because none of its sections (KPI deltas, an overlaid timeline, a
// campaign scorecard, a release before/after panel) fit the single-dimension chart model.
import { ref, computed, watch, onMounted } from 'vue'
import type { ChartConfiguration } from 'chart.js'
import type { GlobalFilters, OverviewResponse } from '../types'
import { fetchOverview } from '../api'
import { PALETTE } from '../lib/charts'
import { FUNNEL_STEP_LABELS, FUNNEL_STEP_ORDER } from '../lib/campaigns'
import { isInsufficientCohort } from '../lib/popupEvents'
import type { CampaignFunnelCounts } from '../types'
import BaseChart from './charts/BaseChart.vue'

const props = defineProps<{ filters: GlobalFilters }>()
const emit = defineEmits<{ 'open-campaigns': [] }>()

const data = ref<OverviewResponse | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const lastUpdated = ref<Date | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await fetchOverview(props.filters.since, props.filters.until)
    lastUpdated.value = new Date()
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load'
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => [props.filters.since, props.filters.until], load)

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}
// `denominator`, when passed, distinguishes "too few to report" (MIN_COHORT — some data,
// just not enough) from plain "—" (no data at all) for a null rate — see
// lib/popupEvents.ts isInsufficientCohort. Every rate here is already server-gated
// (computeRate enforces the floor itself); this is purely about which message shows.
function pct(n: number | null | undefined, denominator?: number): string {
  if (n == null) return denominator != null && isInsufficientCohort(denominator) ? 'too few to report' : '—'
  return `${(n * 100).toFixed(1)}%`
}
function prevFunnelCount(counts: CampaignFunnelCounts, step: keyof CampaignFunnelCounts): number {
  const idx = FUNNEL_STEP_ORDER.indexOf(step)
  return idx > 0 ? counts[FUNNEL_STEP_ORDER[idx - 1]] : 0
}
function money(n: number | null | undefined): string {
  return n == null ? '—' : `$${n.toFixed(2)}`
}
function deltaLabel(d: { delta: number; deltaPct: number | null } | null | undefined): string {
  if (!d) return ''
  const sign = d.delta > 0 ? '+' : ''
  const pctPart = d.deltaPct == null ? '' : ` (${sign}${(d.deltaPct * 100).toFixed(0)}%)`
  return `${sign}${d.delta.toLocaleString('en-US')}${pctPart}`
}
function deltaClass(d: { delta: number } | null | undefined): string {
  if (!d || d.delta === 0) return ''
  return d.delta > 0 ? 'up' : 'down'
}
function relTime(d: Date | null): string {
  if (!d) return ''
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  return `${Math.round(s / 60)}m ago`
}

// ── Timeline chart: pageviews + tagged arrivals (left axis), auth success + install (right
// axis) — shaded campaign-flight bands, release + activation markers. ─────────────────────
function ymdToUtcMs(ymd: string): number {
  return Date.parse(ymd + 'T00:00:00Z')
}
function timelineOverlayPlugin(resp: OverviewResponse) {
  return {
    id: 'overviewOverlay',
    beforeDatasetsDraw(chart: any) {
      const { ctx, chartArea, scales } = chart
      if (!chartArea || !scales?.x) return
      ctx.save()
      // Campaign flight bands
      for (let i = 0; i < resp.timeline.campaignFlights.length; i++) {
        const f = resp.timeline.campaignFlights[i]
        const x0 = scales.x.getPixelForValue(f.flightStart)
        const x1 = scales.x.getPixelForValue(f.flightEnd)
        if (x0 == null || x1 == null || Number.isNaN(x0) || Number.isNaN(x1)) continue
        const left = Math.max(chartArea.left, Math.min(x0, x1))
        const right = Math.min(chartArea.right, Math.max(x0, x1))
        if (right <= left) continue
        ctx.fillStyle = PALETTE[i % PALETTE.length] + '22'
        ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top)
      }
      ctx.restore()
      // Release + activation markers (vertical dashed lines)
      const markers: { date: string; label: string }[] = [
        ...resp.timeline.releaseMarkers.map((r) => ({ date: r.dateEt, label: r.version })),
        ...(resp.timeline.trackingActivationDate ? [{ date: resp.timeline.trackingActivationDate, label: 'tracking starts' }] : []),
      ]
      for (const m of markers) {
        const x = scales.x.getPixelForValue(m.date)
        if (x == null || Number.isNaN(x) || x < chartArea.left || x > chartArea.right) continue
        ctx.save()
        ctx.strokeStyle = 'rgba(26,23,21,0.45)'
        ctx.setLineDash([4, 3])
        ctx.beginPath()
        ctx.moveTo(x, chartArea.top)
        ctx.lineTo(x, chartArea.bottom)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.font = '600 10px Inter, system-ui, sans-serif'
        ctx.fillStyle = 'rgba(26,23,21,0.7)'
        ctx.textAlign = 'left'
        ctx.fillText(m.label, Math.min(x + 4, chartArea.right - 60), chartArea.top + 3)
        ctx.restore()
      }
    },
  }
}
const timelineConfig = computed<ChartConfiguration | null>(() => {
  const resp = data.value
  if (!resp || !resp.timeline.daily.length) return null
  const labels = resp.timeline.daily.map((d) => d.date)
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Page views', data: resp.timeline.daily.map((d) => d.pageviews), borderColor: PALETTE[0], backgroundColor: PALETTE[0], yAxisID: 'y', tension: 0.2, pointRadius: 0 },
        { label: 'Tagged arrivals', data: resp.timeline.daily.map((d) => d.taggedArrivals), borderColor: PALETTE[1], backgroundColor: PALETTE[1], yAxisID: 'y', tension: 0.2, pointRadius: 0 },
        { label: 'Auth successes', data: resp.timeline.daily.map((d) => d.authSuccess), borderColor: PALETTE[3], backgroundColor: PALETTE[3], yAxisID: 'y2', tension: 0.2, pointRadius: 0, borderDash: [3, 2] },
        { label: 'Installs', data: resp.timeline.daily.map((d) => d.install), borderColor: PALETTE[4], backgroundColor: PALETTE[4], yAxisID: 'y2', tension: 0.2, pointRadius: 0, borderDash: [3, 2] },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
      scales: {
        x: { type: 'category' },
        y: { beginAtZero: true, position: 'left', title: { display: true, text: 'page views / arrivals' } },
        y2: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'auth / installs' } },
      },
    },
    plugins: [timelineOverlayPlugin(resp)],
  } as ChartConfiguration
})
</script>

<template>
  <div class="overview-page">
    <div v-if="loading && !data" class="state mono">Loading…</div>
    <div v-else-if="error" class="state error mono">{{ error }}</div>

    <template v-else-if="data">
      <!-- 1. Today at a glance -->
      <section class="block">
        <div class="block-head">
          <h2>Today at a glance <span class="overline">({{ data.todayEt }} ET, so far)</span></h2>
          <div class="head-actions">
            <span v-if="lastUpdated" class="last-updated mono">Updated {{ relTime(lastUpdated) }}</span>
            <button class="btn-ghost icon" title="Refresh" @click="load">↻</button>
          </div>
        </div>
        <div class="kpi-grid">
          <div v-for="k in data.kpis" :key="k.key" class="kpi-tile">
            <div class="kpi-label">{{ k.label }}</div>
            <template v-if="k.noCampaignFlighting">
              <div class="kpi-num small">no campaign flighting today</div>
            </template>
            <template v-else-if="k.notYetTracking">
              <div class="kpi-num small">not yet tracking</div>
            </template>
            <template v-else>
              <div class="kpi-num">{{ k.isRate ? pct(k.today, k.denominator) : fmt(k.today) }}</div>
              <div v-if="k.vsYesterday" class="kpi-delta" :class="deltaClass(k.vsYesterday)">vs yesterday {{ deltaLabel(k.vsYesterday) }}</div>
              <div v-if="k.vsAvg7" class="kpi-delta" :class="deltaClass(k.vsAvg7)">vs 7d avg {{ deltaLabel(k.vsAvg7) }}</div>
            </template>
          </div>
        </div>
      </section>

      <!-- 2. Overall timeline -->
      <section class="block">
        <h2>Overall timeline</h2>
        <p class="caption">Shaded bands = campaign flights. Dashed lines = release / tracking-activation markers. Use the date range above to zoom.</p>
        <div class="chart-box"><BaseChart v-if="timelineConfig" :config="timelineConfig" :drill-open="false" @point="() => {}" /></div>
        <p v-if="!timelineConfig" class="caption">No data in range yet.</p>
      </section>

      <!-- 3. Campaign scorecard -->
      <section class="block">
        <div class="block-head">
          <h2>Campaign scorecard</h2>
          <button class="btn-ghost link" @click="emit('open-campaigns')">Open campaigns page →</button>
        </div>
        <div class="scorecard-grid">
          <div v-for="row in data.scorecard" class="scorecard-card" :key="row.id" role="button" tabindex="0" @click="emit('open-campaigns')" @keyup.enter="emit('open-campaigns')">
            <div class="sc-head">
              <span class="sc-label">{{ row.label }}</span>
              <span class="sc-status" :class="row.flightingToday ? 'live' : ''">{{ row.flightingToday ? 'flighting today' : row.status }}</span>
            </div>
            <div class="sc-row"><span>Flight</span><span class="mono">{{ row.flightStart }} → {{ row.flightEnd }} ({{ row.flightDays }}d)</span></div>
            <div class="sc-row"><span>Tagged arrivals</span><span class="mono">{{ fmt(row.taggedArrivals) }}</span></div>
            <div class="sc-row"><span>Auth successes</span><span class="mono">{{ fmt(row.authSuccess) }}</span></div>
            <div class="sc-row"><span>Installs</span><span class="mono">{{ fmt(row.install) }}</span></div>
            <div class="sc-row"><span>Return rate (d2-7)</span><span class="mono">{{ pct(row.returnRateD2to7, row.returnD0) }}</span></div>
            <div class="sc-row"><span>Cost / arrival</span><span class="mono">{{ money(row.costPerArrival) }}</span></div>
            <div class="sc-rates">
              <span v-for="(rate, step) in row.funnelRates" :key="step" class="sc-rate-chip" :title="FUNNEL_STEP_LABELS[step as keyof typeof FUNNEL_STEP_LABELS]">
                {{ FUNNEL_STEP_LABELS[step as keyof typeof FUNNEL_STEP_LABELS] }}: {{ pct(rate, prevFunnelCount(row.funnelCounts, step as keyof CampaignFunnelCounts)) }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- 4. Release panel -->
      <section class="block">
        <h2>Release panel</h2>
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
        <p v-else class="caption">No dated release yet — set a release date in <code>src/lib/releases.ts</code> (or ship v1.90.0 and set <code>TRACKING_ACTIVATION_DATE_ET</code>) to populate this panel.</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.overview-page {
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.state {
  padding: 40px 0;
  text-align: center;
  color: rgb(var(--ink-3));
}
.state.error {
  color: #bc4749;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.block h2 {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 15px;
  font-weight: 600;
}
.block-head h2 {
  margin-bottom: 0;
}
.caption {
  font-size: 11.5px;
  color: rgb(var(--ink-3));
  margin: 4px 0 10px;
}
.caption code {
  font-family: 'JetBrains Mono', monospace;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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
.btn-ghost.link {
  border: none;
  background: transparent;
  color: rgb(var(--amber-hover));
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

/* KPI tiles — wrap, never scroll horizontally (phone-readable) */
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.kpi-delta.up {
  color: #6a994e;
}
.kpi-delta.down {
  color: #bc4749;
}

.chart-box {
  height: 300px;
}

/* Scorecard — a card grid, never a wide table (no horizontal scroll on phone) */
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
