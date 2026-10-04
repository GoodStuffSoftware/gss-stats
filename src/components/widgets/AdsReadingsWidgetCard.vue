<script setup lang="ts">
// Ads-read routine readings log — a SELF-CONTAINED widget body. It fetches its own endpoint
// (GET /api/ads/readings, functions/api/ads/readings.ts) and depends on nothing else on the
// page, so the grid layout can drop it in for dataset 'ads-readings' (ChartCard dispatches
// here with :widget). The real implementation, replacing the feat/bsk-tabs placeholder
// stub of the same name/path (merge from origin/main, 2026-09-26).
//
// Props follow the grid widget shape, typed locally (a structural subset of types.ts Widget)
// so this file never has to touch the shared Dataset union:
//   widget.view         — 'log' (the only view today; anything else renders as 'log')
//   widget.campaignIds  — empty/undefined = every campaign
//   widget.limit        — readings per campaign (default 30)
import { computed, onMounted, ref, watch } from 'vue'
import type { AdsReadingsCampaign, AdsReadingsResponse } from '../../lib/adsStore'
import { proposalLabel } from '../../lib/adsRules'
import { rulesSummary } from '../../lib/adsRulesSummary'
import { freshnessLine, STALE_NOTE } from '../../lib/adsFreshness'
import { etDateTimeText as etTime, fmtCount as fmt, readingKindLabel as kindLabel, SIGNUPS_HINT, signUpsText } from '../../lib/adsReadingsFormat'
import { SMALL_SAMPLE_NOTE } from '../../lib/popupEvents'
import { fetchAdsReadings } from '../../api'
import { isInFlight, isStale, useReturnRefresh } from '../../composables/useReturnRefresh'
import AdsRefreshButton from '../AdsRefreshButton.vue'
import type { RefreshResult } from '../../lib/adsRefresh'

export interface AdsReadingsWidgetLike {
  view?: string
  campaignIds?: string[]
  limit?: number
  title?: string
}
const props = defineProps<{ widget: AdsReadingsWidgetLike }>()

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<AdsReadingsResponse | null>(null)

// 'log' is the only view so far; an unknown view falls back to it rather than rendering nothing.
const view = computed<'log'>(() => 'log')
const query = computed(() => {
  const p = new URLSearchParams()
  for (const id of props.widget.campaignIds ?? []) p.append('campaignId', id)
  p.set('limit', String(props.widget.limit && props.widget.limit > 0 ? Math.min(props.widget.limit, 500) : 30))
  return p.toString()
})

let reqId = 0 // a late answer to an older request must never overwrite a newer one's
let loadStartedAt: number | null = null // the latest load's start; null once it settles
let settledAt: number | null = null
// `background`: a refetch on return to the tab keeps the table on screen (no "Loading…" flash) and
// a failure leaves the last good data up.
async function load(background = false) {
  if (!background) {
    loading.value = true
    error.value = null
  }
  const my = ++reqId
  loadStartedAt = Date.now()
  try {
    // Through api.ts so an expired session raises the re-sign-in banner (see withSessionCheck).
    const r = await fetchAdsReadings(query.value)
    if (my !== reqId) return
    data.value = r
    error.value = null
  } catch (e: any) {
    if (my === reqId && (!background || !data.value)) error.value = e?.message ?? 'Failed to load'
  } finally {
    if (my === reqId) {
      loadStartedAt = null
      settledAt = Date.now()
      loading.value = false
    }
  }
}
onMounted(() => load())
watch(query, () => load())
// The user came back to the tab: refetch if the last load is old enough and none is running.
useReturnRefresh(() => {
  if (isInFlight(loadStartedAt) || !isStale(settledAt)) return
  void load(true)
})

// Only campaigns with something to show, unless the widget asked for specific ones.
const campaigns = computed<AdsReadingsCampaign[]>(() => {
  const all = data.value?.campaigns ?? []
  if (props.widget.campaignIds?.length) return all
  return all.filter((c) => c.readings.length || c.spend.source === 'google-ads-api' || c.status === 'active')
})

const money = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`)

function spendSource(c: AdsReadingsCampaign): string {
  if (c.spend.source === 'google-ads-api') return 'Google Ads API'
  if (c.spend.source === 'config') return 'hand-entered config'
  return 'no spend on record'
}
// A sync that ran may have stored new days: reload so spend and the freshness line update.
function onRefreshed(r: RefreshResult) {
  if (r.refreshed) void load()
}
// "Spend through <date> · synced <relative time>" — relative to when the data was loaded.
const loadedAt = computed(() => (data.value ? Date.parse(data.value.generatedAt) : Date.now()))
</script>

<template>
  <div class="ads-readings">
    <div v-if="loading" class="state mono">Loading…</div>
    <div v-else-if="error" class="state error mono">{{ error }}</div>
    <template v-else-if="data && view === 'log'">
      <p v-if="!data.storeBound" class="state small mono">Readings store not bound (gss_stats_ads) — showing config spend only.</p>
      <p v-else-if="!data.storeReadable" class="state small mono">Readings store unreadable — showing config spend only.</p>
      <p class="note">{{ SMALL_SAMPLE_NOTE }} Proposals only; the routine never changes a campaign.</p>
      <AdsRefreshButton v-if="data.storeBound && campaigns.length" :campaign-ids="campaigns.map((c) => c.campaignId)" @refreshed="onRefreshed" />
      <p v-for="a in data.syncAlerts ?? []" :key="a.source + a.startedAt" class="sync-alert small mono">Sync alert: {{ a.message }}</p>

      <div v-for="c in campaigns" :key="c.campaignId" class="camp">
        <div class="camp-head">
          <span class="camp-label">{{ c.label }}</span>
          <span class="camp-spend mono">{{ money(c.spend.spend) }} <span class="muted">({{ spendSource(c) }})</span></span>
        </div>
        <div v-if="data.storeBound" class="fresh mono">
          {{ freshnessLine(c, loadedAt) }}<span v-if="c.stale" class="stale"> · {{ STALE_NOTE }}</span>
        </div>
        <div v-if="c.thresholdsFired?.length" class="fired mono">
          fired: <span v-for="t in c.thresholdsFired" :key="t.threshold" class="chip">${{ t.threshold }} · {{ etTime(t.firedAt) }}</span>
        </div>
        <p v-if="!c.readings.length" class="state small mono">No readings yet.</p>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr><th>Read</th><th>Kind</th><th>Spend</th><th>Rules</th><th>Proposal</th><th>Arrivals</th><th>Asks</th><th>Accepts</th><th>Auth</th><th :title="SIGNUPS_HINT">Sign-ups</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in c.readings" :key="r.id" :class="{ incomplete: !r.complete }">
                <td class="mono">{{ etTime(r.readAt) }}</td>
                <td>{{ kindLabel(r) }}<span v-if="!r.complete" class="muted"> (incomplete)</span></td>
                <td class="mono">{{ money(r.cumulativeSpend) }}</td>
                <td :class="['mono', rulesSummary(r.rules).tone]">{{ rulesSummary(r.rules).text }}</td>
                <td :class="['mono', r.proposal === 'PROPOSE PAUSE' ? 'trip' : '']">{{ proposalLabel(r) }}</td>
                <td class="mono num">{{ fmt(r.counts.taggedArrivals) }}</td>
                <td class="mono num">{{ fmt(r.counts.asks) }}</td>
                <td class="mono num">{{ fmt(r.counts.accepts) }}</td>
                <td class="mono num">{{ fmt(r.counts.authSuccess) }}</td>
                <td class="mono num">{{ signUpsText(r.counts.signUpsAtMost, r.counts.signUpsExact === 1) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p v-if="!campaigns.length" class="state small mono">No campaign has readings or stored spend yet.</p>
    </template>
  </div>
</template>

<style scoped>
.ads-readings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow-y: auto;
}
.state {
  padding: 24px 0;
  text-align: center;
  color: rgb(var(--ink-3));
  font-size: 12px;
}
.state.small {
  padding: 6px 0;
  text-align: left;
}
.state.error {
  color: #bc4749;
}
.note {
  font-size: 11.5px;
  color: rgb(var(--ink-3));
}
.camp {
  border: 1px solid rgb(var(--line));
  border-radius: 12px;
  padding: 10px 12px;
  background: rgb(var(--surface));
}
.camp-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 6px;
}
.camp-label {
  font-weight: 600;
  font-size: 12.5px;
  color: rgb(var(--ink));
}
.camp-spend {
  font-size: 12px;
  color: rgb(var(--ink));
}
.muted {
  color: rgb(var(--ink-3));
}
.fresh {
  font-size: 11px;
  color: rgb(var(--ink-3));
  margin-bottom: 6px;
}
.stale {
  color: #bc4749;
}
.sync-alert {
  color: #bc4749;
  margin: 0 0 6px;
}
.fired {
  font-size: 11px;
  color: rgb(var(--ink-2));
  margin-bottom: 6px;
}
.chip {
  display: inline-block;
  margin: 0 4px 2px 0;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgb(var(--sunken));
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
th,
td {
  padding: 4px 6px;
  text-align: left;
  border-bottom: 1px solid rgb(var(--line));
  white-space: nowrap;
}
th {
  color: rgb(var(--ink-3));
  font-weight: 500;
}
td.num,
th:nth-child(n + 6) {
  text-align: right;
}
.trip {
  color: #bc4749;
  font-weight: 600;
}
.clear {
  color: rgb(var(--ink-2));
}
.watch {
  color: rgb(var(--amber-hover));
  font-weight: 600;
}
tr.incomplete td {
  opacity: 0.7;
}
</style>
