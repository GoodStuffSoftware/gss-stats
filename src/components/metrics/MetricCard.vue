<script setup lang="ts">
// The metric-card family's entry point (ADR 0003 section 1, "Rendering"): resolves a widget's
// `card: CardRef` — `{ preset }` through the preset registry, or an inline `{ spec }` — into a
// CardSpec, expands its top-level `repeat` (one card per campaign/pop-up/window/reading, or a
// single unrepeated instance such as the KPI tiles), and renders each through
// MetricCardInstance. A repeated card gets the scorecard's bordered box; an unrepeated one
// renders its sections directly, since its tiles are the boxes.
//
// It also owns what belongs to the whole card:
// - the ET day. `todayEt` follows a clock (or the `nowMs` seam), not the first render: when the
//   day changes, the body remounts (repeats such as "flighting today" re-expand, every item
//   rebuilds its request), and "today so far" values are re-requested (the day is part of the
//   client cache key, useMetrics' `epoch`);
// - freshness (CardSpec.showUpdated): "Updated Xs ago" from the card's latest successful load
//   plus a reload control, in the header (default) or a footer;
// - errors: while any value on the card failed to load, "Updated" gives way to an error line
//   with Retry, whether or not showUpdated is set;
// - its actions (CardSpec.actions): code-reviewed controls in the status row, e.g. the ads
//   "Refresh data" button, which reloads the card once a sync ran;
// - its captions (CardSpec.captions): registry notes under the whole card.
import { computed, effectScope, onBeforeUnmount, onMounted, onScopeDispose, reactive, ref, shallowRef, watch, type EffectScope } from 'vue'
import { useMetrics, type MetricRequestSpec, type UseMetrics } from '../../composables/useMetrics'
import { isInFlight, isStale, useReturnRefresh } from '../../composables/useReturnRefresh'
import { fetchAdsReadings } from '../../api'
import { MAX_READINGS_LIMIT } from '../../lib/metrics/types'
import { NO_READINGS, readingsLoadOf } from '../../lib/metrics/readingsScope'
import type { AdsReadingsResponse } from '../../lib/adsStore'
import { hasNote, noteRawText } from '../../lib/notes'
import { isNoteIdHideable } from '../../lib/chartNotes'
import { resolveLabelTokens } from '../../lib/metrics/render'
import { presetById } from '../../lib/metrics/presets'
import { INVALID_CARD_PRESET } from '../../lib/metrics/validate'
import { buildRequestSpec, campaignOfScope, narrowToCampaigns, readingsLimitOf, repeatsOverReadings, ROOT_SCOPE, resolveRepeat, sectionCells, todayEtFrom, type ReadingScope, type RepeatContext, type ScopeInstance } from '../../lib/metrics/scope'
import { CAMPAIGNS } from '../../lib/campaigns'
import type { CardRef, CardSpec, MetricsContext } from '../../lib/metrics/types'
import type { RefreshResult } from '../../lib/adsRefresh'
import MetricCardInstance from './MetricCardInstance.vue'
import MetricCardStatus from './MetricCardStatus.vue'
import MetricLabel from './MetricLabel.vue'
import AdsRefreshButton from '../AdsRefreshButton.vue'
import NoteBlock from '../NoteBlock.vue'

const props = defineProps<{
  cardRef: CardRef
  context?: MetricsContext
  readings?: ReadingScope[]
  /** Test/preview seam — defaults to the real clock. */
  nowMs?: number
  /** The widget's own title (ChartCard): names the card for a screen reader when the spec has
   * no title of its own ("Notes: Today at a glance"). */
  fallbackTitle?: string
  /** The widget's campaign selection (Widget.campaignIds): narrows a card-level campaign repeat
   * to those campaigns; none selected = the repeat as it is. */
  campaignIds?: string[]
  /** The widget's hidden caveats (Widget.hiddenCaveats): spec caption ids listed here are not
   * shown (decision D7: preset captions stay with the preset, and each card can hide them). A
   * data-cut note (`hideable: false`) or an unknown id still shows, whatever the list says. */
  hiddenCaptions?: string[]
}>()
const emit = defineEmits<{ 'open-campaigns': [] }>()

const spec = computed<CardSpec | null>(() => ('preset' in props.cardRef ? (presetById(props.cardRef.preset) ?? null) : props.cardRef.spec))

// ── The clock: freshness text and the ET day ────────────────────────────────────────────────
const clock = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  ticker = setInterval(() => (clock.value = Date.now()), 15_000)
})
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})
// A tab that slept past midnight ET has not ticked, so on return the clock still says yesterday:
// the return refetch would re-queue yesterday's entries and the next tick would then re-plan under
// the new day. Moving the clock here first makes the day watcher re-plan before the queued batch
// flushes (releasing the old keys drops them from it), so only the new day's POST goes out.
useReturnRefresh(() => (clock.value = Date.now()))
const nowMs = computed(() => props.nowMs ?? clock.value)
const todayEt = computed(() => todayEtFrom(nowMs.value))

// ── The ads readings load (ADR 0005 slice 3) ────────────────────────────────────────────────
// A card that repeats over stored readings, or declares the ads-refresh action (its freshness
// and fired-threshold fields come from the same endpoint), loads GET /api/ads/readings itself:
// on mount, when its query changes, on the card reload, after an ads refresh and on return to
// the tab. The `readings` prop stays as an override for the rows (tests, previews): when given,
// a card that only needs the rows does not fetch.
const wantsAds = computed(() => !!spec.value?.actions?.includes('ads-refresh') || !!spec.value?.notices)
const wantsReadings = computed(() => !!spec.value && repeatsOverReadings(spec.value))
const loadsReadings = computed(() => wantsAds.value || (wantsReadings.value && props.readings === undefined))
/** The most readings per campaign asked for; a card that needs only the freshness asks for one. */
const readingsQuery = computed(() => {
  const p = new URLSearchParams()
  for (const id of props.campaignIds ?? []) p.append('campaignId', id)
  const limit = spec.value && wantsReadings.value ? Math.min(readingsLimitOf(spec.value), MAX_READINGS_LIMIT) : 1
  p.set('limit', String(limit))
  return p.toString()
})
const readingsData = shallowRef<AdsReadingsResponse | null>(null)
const readingsFailed = ref(false)
let readingsReqId = 0 // a late answer to an older request must never overwrite a newer one
let readingsStartedAt: number | null = null // the latest load start; null once it settles
let readingsSettledAt: number | null = null
// `background`: a refetch on return keeps what is on screen, and a failure leaves the last good data up.
async function loadReadings(background = false) {
  if (!loadsReadings.value) return
  const my = ++readingsReqId
  readingsStartedAt = Date.now()
  try {
    // Through api.ts so an expired session raises the re-sign-in banner (see withSessionCheck).
    const r = await fetchAdsReadings(readingsQuery.value)
    if (my !== readingsReqId) return
    readingsData.value = r
    readingsFailed.value = false
  } catch {
    if (my === readingsReqId && (!background || !readingsData.value)) readingsFailed.value = true
  } finally {
    if (my === readingsReqId) {
      readingsStartedAt = null
      readingsSettledAt = Date.now()
    }
  }
}
onMounted(() => void loadReadings())
watch([readingsQuery, loadsReadings], () => void loadReadings())
// The user came back to the tab: refetch if the last load is old enough and none is running.
useReturnRefresh(() => {
  if (!loadsReadings.value || isInFlight(readingsStartedAt) || !isStale(readingsSettledAt)) return
  void loadReadings(true)
})
const readingsLoad = computed(() => (readingsData.value ? readingsLoadOf(readingsData.value) : NO_READINGS))
const ctx = computed<RepeatContext>(() => ({ todayEt: todayEt.value, readings: props.readings ?? readingsLoad.value.readings, ads: readingsLoad.value.ads }))
const instances = computed<ScopeInstance[]>(() => (spec.value ? narrowToCampaigns(resolveRepeat(spec.value.repeat, ctx.value), spec.value.repeat, props.campaignIds) : []))

/** The first load is still out: a card that waits on the readings shows no empty state yet. */
const readingsPending = computed(() => loadsReadings.value && !readingsData.value && !readingsFailed.value)

// ── Notices (CardSpec.notices) ──────────────────────────────────────────────────────────────
// 'ads-readings': the readings store's warning when it is unbound or unreadable, the
// small-numbers note, then the sync alerts that killed a run in the last week, in the order the
// bespoke readings log showed them. Nothing until the load has answered. Plain text through the
// notes registry (a server message is only ever substituted into a text token).
const noticeLines = computed<{ key: string; text: string; warn: boolean }[]>(() => {
  const d = readingsData.value
  if (spec.value?.notices !== 'ads-readings' || !d) return []
  const out: { key: string; text: string; warn: boolean }[] = []
  if (!d.storeBound) out.push({ key: 'unbound', text: noteRawText('ads-store-unbound'), warn: true })
  else if (!d.storeReadable) out.push({ key: 'unreadable', text: noteRawText('ads-store-unreadable'), warn: true })
  out.push({ key: 'small', text: noteRawText('ads-readings-note'), warn: false })
  for (const a of d.syncAlerts ?? []) out.push({ key: a.source + a.startedAt, text: noteRawText('label.card.syncAlert', { message: a.message }), warn: true })
  return out
})

// ── Card-level requests (freshness, errors, reload) ─────────────────────────────────────────
// The card holds its own reference on every request its items make (content-equal requests
// share one entry, so this costs no fetch). The list depends on the day (a "flighting today"
// repeat), so it lives in its own effect scope, rebuilt when the day changes and stopped with
// the component — nothing reactive is ever created loose in a callback.
function cardRequestSpecs(): MetricRequestSpec[] {
  const s = spec.value
  if (!s) return []
  const out: MetricRequestSpec[] = []
  for (const scope of instances.value) {
    for (const section of s.sections) {
      for (const { item, scope: sc } of sectionCells(section, scope, ctx.value)) {
        const r = buildRequestSpec(item, sc)
        if (r) out.push(r)
      }
    }
  }
  return out
}
const cardMetrics = shallowRef<UseMetrics | null>(null)
let dayScope: EffectScope | null = null
function buildCardRequests() {
  dayScope?.stop()
  dayScope = effectScope(true)
  cardMetrics.value = dayScope.run(() => {
    const m = useMetrics(() => props.context, () => todayEt.value)
    for (const r of cardRequestSpecs()) m.request(r)
    return m
  })!
}
buildCardRequests()
watch(todayEt, buildCardRequests)
onScopeDispose(() => dayScope?.stop())

/** Refetches every value on this card, bypassing the server cache (ChartCard's reload control
 * calls this through the component ref too). */
function reload() {
  cardMetrics.value?.reloadAll()
  void loadReadings()
}
defineExpose({ reload })

const hasError = computed(() => !!cardMetrics.value?.hasError.value || (loadsReadings.value && readingsFailed.value))
const updatedPlacement = computed<'header' | 'footer' | null>(() => {
  const v = spec.value?.showUpdated
  return v === true ? 'header' : v === 'header' || v === 'footer' ? v : null
})
const updatedText = computed(() => {
  const at = cardMetrics.value?.lastUpdated.value
  if (at == null) return ''
  // Freshness is wall-clock time (the nowMs seam only pins the ET day).
  const s = Math.max(0, Math.round((Math.max(clock.value, at) - at) / 1000))
  if (s < 5) return noteRawText('label.card.updatedJustNow')
  if (s < 60) return noteRawText('label.card.updatedSecondsAgo', { n: s })
  return noteRawText('label.card.updatedMinutesAgo', { n: Math.round(s / 60) })
})
const failedText = noteRawText('label.card.loadFailed')
const loadingText = noteRawText('label.card.loading')
const invalidText = noteRawText('label.card.invalid')
/** Where the status line goes: where showUpdated puts freshness, and in the header when the
 * card shows no freshness but has an error. Header: an unrepeated card's own header row
 * (top-right, above the tiles, where the old KPI panel had it), a repeated card above its grid.
 * Footer: under the card — an error in a footer card shows there too, so Retry is never lost. */
const statusPlacement = computed<'header' | 'footer' | null>(() => updatedPlacement.value ?? (hasError.value ? 'header' : null))
const statusInInstanceHeader = computed(() => !spec.value?.repeat && statusPlacement.value === 'header')
const statusAboveGrid = computed(() => !!spec.value?.repeat && statusPlacement.value === 'header')

// ── Actions ─────────────────────────────────────────────────────────────────────────────────
const adsRefresh = computed(() => !!spec.value?.actions?.includes('ads-refresh'))
/** The campaigns the card shows (its instances'), else every configured campaign. */
const actionCampaignIds = computed(() => {
  const ids = instances.value.map((s) => campaignOfScope(s)?.id).filter((id): id is string => !!id)
  return ids.length ? [...new Set(ids)] : CAMPAIGNS.map((c) => c.id)
})
function onAdsRefreshed(r: RefreshResult) {
  if (r.refreshed) reload()
}
// Only the ids this build knows: an unknown one (a newer build's) stays stored but shows nothing,
// so a card whose captions are all unknown gets no empty captions block. A known id the widget
// hides (its hiddenCaveats, passed as hiddenCaptions) is dropped too, unless it may not be hidden.
const captionIds = computed(() =>
  (spec.value?.captions ?? []).filter((id) => hasNote(id) && !(props.hiddenCaptions?.includes(id) && isNoteIdHideable(id))),
)

// Repeated instances with nothing to show (MetricCardInstance's `hidden`), by index; reset when
// the instances are re-expanded (a new day, a new spec).
const hiddenInstances = reactive(new Set<number>())
watch(instances, () => hiddenInstances.clear())
function onHidden(i: number, h: boolean) {
  if (h) hiddenInstances.add(i)
  else hiddenInstances.delete(i)
}
const allHidden = computed(() => instances.value.length > 0 && instances.value.every((_, i) => hiddenInstances.has(i)))
</script>

<template>
  <!-- A saved card that failed validation on load (normCardRef) is a placeholder, never a crash. -->
  <p v-if="'preset' in cardRef && cardRef.preset === INVALID_CARD_PRESET" class="metric-card-error">{{ invalidText }}</p>
  <p v-else-if="!spec" class="metric-card-error">Unknown card{{ 'preset' in cardRef ? ` preset "${cardRef.preset}"` : '' }}.</p>
  <div v-else class="metric-card-root">
    <!-- Present from mount and empty until an error, so screen readers announce the change. -->
    <span class="mc-live" role="status" aria-live="polite">{{ hasError ? failedText : '' }}</span>
    <div v-if="noticeLines.length" class="mc-notices">
      <p v-for="n in noticeLines" :key="n.key" class="mc-notice" :class="{ warn: n.warn }">{{ n.text }}</p>
    </div>
    <div v-if="adsRefresh" class="mc-actions">
      <AdsRefreshButton :campaign-ids="actionCampaignIds" @refreshed="onAdsRefreshed" />
    </div>
    <div v-if="statusAboveGrid" class="mc-status-row">
      <MetricCardStatus :has-error="hasError" :updated-text="updatedText" @reload="reload" />
    </div>

    <!-- Keyed on the ET day: a new day remounts the body, so every repeat and request rebuilds. -->
    <!-- The first readings load is out: "Loading…" in place of the grid (kept mounted, so its metric requests start now). -->
    <p v-if="readingsPending && spec.repeat" class="metric-card-empty">{{ loadingText }}</p>
    <div v-if="spec.repeat" v-show="!readingsPending" :key="todayEt" class="metric-card-grid" :style="{ '--mc-min-width': `${spec.minWidth ?? 230}px` }">
      <MetricCardInstance v-for="(scope, i) in instances" v-show="!hiddenInstances.has(i)" :key="i" :spec="spec" :scope="scope" :ctx="ctx" :context="context" :boxed="true" @open="emit('open-campaigns')" @hidden="(h: boolean) => onHidden(i, h)" />
      <p v-if="((!instances.length && !readingsPending) || allHidden) && spec.repeat.empty" class="metric-card-empty">
        <MetricLabel :tokens="resolveLabelTokens(spec.repeat.empty.label, ROOT_SCOPE, undefined, todayEt)" />
        <MetricLabel :tokens="resolveLabelTokens(spec.repeat.empty.text, ROOT_SCOPE, undefined, todayEt)" />
      </p>
    </div>
    <MetricCardInstance v-else :key="todayEt" class="metric-card-plain" :spec="spec" :scope="ROOT_SCOPE" :ctx="ctx" :context="context" :boxed="false" :fallback-title="fallbackTitle" @open="emit('open-campaigns')">
      <template v-if="statusInInstanceHeader" #status>
        <MetricCardStatus :has-error="hasError" :updated-text="updatedText" @reload="reload" />
      </template>
    </MetricCardInstance>

    <div v-if="statusPlacement === 'footer'" class="mc-status-row mc-footer">
      <MetricCardStatus :has-error="hasError" :updated-text="updatedText" @reload="reload" />
    </div>
    <div v-if="captionIds.length" class="mc-captions">
      <NoteBlock v-for="id in captionIds" :key="id" :note-id="id" />
    </div>
  </div>
</template>

<style scoped>
.metric-card-error {
  color: rgb(var(--ink-3));
  font-size: 11.5px;
}
.metric-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--mc-min-width, 230px), 1fr));
  gap: 14px;
}
.metric-card-empty {
  font-size: 11.5px;
  color: rgb(var(--ink-3));
}
.mc-status-row {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.mc-footer {
  margin: 8px 0 0;
}
.mc-actions {
  margin-bottom: 8px;
}
.mc-notices {
  margin-bottom: 8px;
}
.mc-notice {
  margin: 0 0 4px;
  font-size: 11.5px;
  color: rgb(var(--ink-3));
}
.mc-notice.warn {
  color: #bc4749;
}
.mc-captions {
  margin-top: 8px;
}
/* The live region: in the accessibility tree, not on screen. */
.mc-live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
