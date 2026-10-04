<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick, useId } from 'vue'
import type { Widget, GlobalFilters, StatsResponse } from '../types'
import { fetchStats, fetchSeriesStats } from '../api'
import { resolveSelection, sitesLoaded } from '../sitesStore'
import { checkSessionExpired, isAuthError, isNetworkError } from '../session'
import { buildChartConfig, formatKey, metricValue, nestedDoughnutClickValue, seriesRows, hasLineSeries, widgetHasOverlay, widgetOverlayOptions } from '../lib/charts'
import { overlayItems, itemsInRange } from '../lib/timelineOverlay'
import { isDateDim } from '../lib/rings'
import { rangeLabel } from '../lib/range'
import { isSiteDim, semanticKey } from '../lib/drill'
import { isMobileViewport } from '../lib/responsive'
import { isFit, widgetNeedsChartHeight } from '../lib/fit'
import { useFitHeight } from '../composables/useFitHeight'
import { isInFlight, isStale, useReturnRefresh } from '../composables/useReturnRefresh'
import BaseChart from './charts/BaseChart.vue'
import WorldMap from './charts/WorldMap.vue'
import FilterPopover from './FilterPopover.vue'
import MetricCard from './metrics/MetricCard.vue'
import { metricsContextFor } from '../lib/metrics/pageContext'
import { presetById } from '../lib/metrics/presets'
import NoteWidgetBody from './widgets/NoteWidgetBody.vue'
import AdsReadingsWidgetCard from './widgets/AdsReadingsWidgetCard.vue'
import NoteBlock from './NoteBlock.vue'
import { noteRawText } from '../lib/notes'
import { chartNotes } from '../lib/chartNotes'
import { chartValueResolver } from '../lib/valueTokens'

const props = defineProps<{ widget: Widget; filters: GlobalFilters; dark: boolean; drillOpen: boolean; forceControls?: boolean }>()

// A metric card, dataset 'ads-readings' and type 'note' render their own body (own data fetch
// or none) — no /api/stats round trip, no per-chart filter override, no drill. The datasets
// 'overview' and 'campaigns' are card panels since layout version 11 (their bespoke bodies are
// retired); one without a card — a panel the migration does not know — says so.
// The header (title/zoom/menu) stays generic and shared with every other widget type.
const retiredPanelText = noteRawText('label.card.retiredPanel')
const isBespokeBody = computed(
  () => !!props.widget.card || props.widget.dataset === 'overview' || props.widget.dataset === 'campaigns' || props.widget.dataset === 'ads-readings' || props.widget.type === 'note',
)

// A metric card (ADR 0003, Widget.card): MetricCard renders it from the card reference and the
// page context — the filter bar's range and sites, or this widget's own override — which it
// follows as they change (useMetrics re-plans on a context change). Its reload is the card's
// own (a fresh refetch of every value on it), wired to this header's ↻.
const isCard = computed(() => !!props.widget.card)
const metricsContext = computed(() => {
  const f = effectiveFilters.value
  return metricsContextFor({ since: f.since, until: f.until }, resolveSelection(props.widget.siteSel ?? f.siteSel).tags, f)
})
const metricCard = ref<{ reload(): void } | null>(null)
/** A card that shows its own "Updated … ↻" (CardSpec.showUpdated) has its reload there; the
 * header's ↻ would be a second control for the same action, so it is hidden for that card. */
const cardHasOwnReload = computed(() => {
  const c = props.widget.card
  if (!c) return false
  const spec = 'preset' in c ? presetById(c.preset) : c.spec
  return !!spec?.showUpdated
})
function reloadThis() {
  if (isCard.value) metricCard.value?.reload()
  else load()
}

const emit = defineEmits<{
  edit: []
  remove: []
  duplicate: []
  drill: [{ widgetId: string; dimension: string; dataset: 'geo' | 'rum'; value: string; label: string; x: number; y: number }]
  'open-campaigns': []
  // Fit-to-content (Widget.fit): this card's content height in px, whenever it changes.
  // Dashboard.vue turns it into grid rows.
  'fit-height': [number]
  // The chart's latest response / load error, whenever either changes. App.vue keeps the newest per
  // widget so ChartEditor can list runtime caveats without fetching again.
  data: [StatsResponse | null, string | null]
}>()

const baseChartRef = ref<{ suppressForDrill: () => void } | null>(null)

// Note widgets render as a bare compact caption (owner clarification, 2026-09-26: "these bars
// are supposed to be invisible... I wanted it to look just like it did" — v0.5.2's bespoke
// pages rendered a small-sample note as a plain <p class="caption">, no title, no box). See the
// .note-card styling below — it drops the border/background/title row entirely and floats the
// edit-mode menu as a small absolute overlay instead of a header row.
const isNoteWidget = computed(() => props.widget.type === 'note')

// Which widgets hold a real canvas that sizes itself via CSS height:100% (BaseChart.vue's
// Chart.js — responsive:true, maintainAspectRatio:false, see lib/charts.ts — or
// WorldMap.vue's own canvas) and so need a DEFINITE pixel height on mobile, not just a
// min-height floor (regression found while verifying fix/clean-look, 2026-09-26): a
// percentage height only resolves against an ancestor whose own height is CSS-definite —
// min-height on an otherwise-auto-height box doesn't count, per spec — so once Dashboard.vue's
// mobile CSS stopped giving every card a fixed height, both canvases lost their sizing
// reference (Chart.js silently falls back to its hard-coded 150px default; WorldMap likewise
// collapsed). Content-driven bespoke views (kpis/scorecard/releasePanel/campaigns/
// ads-readings/note) and the non-canvas widget types (stat/rate/table) never had that
// problem, so only the canvas-bearing cases below get a fixed mobile height (Dashboard.vue's
// .needs-chart-height).
const needsChartHeight = computed(() => widgetNeedsChartHeight(props.widget)) // lib/fit.ts: the canvas types and the content-driven exceptions

// A breakdown bar (legend + rotated axis labels) and a line chart with series or overlays
// (legend, marker labels, the markers list, captions) don't fit Dashboard.vue's fixed phone chart
// height: on a phone these cards size to their content, with a fixed-height plot area instead.
const tallOnPhone = computed(() => props.widget.type === 'breakdownBar' || hasLineSeries(props.widget) || (isDateDim(props.widget.dimension) && widgetHasOverlay(props.widget)))

// Double-tap-to-zoom (owner: "allow a double-tap on the chart to zoom if that's easy") — an
// extra shortcut alongside the always-visible zoom button (see below), not a substitute for
// it. Ignore taps that land on an actual control (menu, its buttons, a link) so they keep
// their own behavior instead of also triggering a zoom.
function onCardBodyDblClick(e: MouseEvent) {
  if (isNoteWidget.value) return // nothing to zoom
  const target = e.target as HTMLElement | null
  if (target?.closest('button, .menu, a, input, select, textarea')) return
  toggleZoom()
}

// ── Reveal: a per-card disclosure toggle (owner clarification, 2026-09-26 — "hide the bar for
// each chart and have a reveal button and zoom button only by default... tapping REVEAL shows
// THAT chart's controls"). Every card shows exactly two small, low-contrast, always-visible
// icons — zoom and reveal — on every device, including touch; everything else (filter/reload/
// options menu, plus the drag-handle/resize-grip affordances in the CSS below) stays hidden
// until: this card's own reveal is on, the page's edit mode is on (`forceControls`), or (desktop
// only) the card is hovered/focused-within. `revealId` gives the revealed-controls group a
// stable id for the reveal button's aria-controls (Vue 3.5's useId — unique per component
// instance, so multiple cards on one page never collide).
const revealed = ref(false)
const revealId = useId()
function toggleRevealed(e?: Event) {
  e?.stopPropagation() // don't let this bubble to the outside-click closer below
  revealed.value = !revealed.value
}
function closeRevealed() {
  revealed.value = false
}
onMounted(() => document.addEventListener('click', closeRevealed))
onBeforeUnmount(() => document.removeEventListener('click', closeRevealed))

// A click on a chart element → hand the parent the raw dimension value so it can offer to
// open a page filtered to it. Only for dimensions that are actually drillable — tapping a
// non-drillable point leaves its tooltip up so the value stays readable, which is the only
// way to read it on touch. 'date' is the one exception: it's not a semantic drill key (see
// drill.ts), but App.openFilteredPage special-cases it into a day range, so it's allowed
// through here too.
// Hide this chart's tooltip for an about-to-open drill menu — but ONLY when the menu could
// actually land on top of it. On mobile the menu is a bottom sheet (App.vue), so it can never
// cover the chart, and suppressing there would take away the tooltip entirely: a tap is the
// only way to read a value on touch, and every tap of a drillable point opens a menu. So on
// mobile the tooltip stays. On desktop the menu opens near the pointer, so suppress — and do
// it SYNCHRONOUSLY, in the tap's own call stack rather than via the async drillOpen prop,
// because a stray hover event can otherwise land in that gap (see BaseChart.suppressForDrill).
function suppressTooltipForDrill() {
  if (isMobileViewport()) return
  baseChartRef.value?.suppressForDrill()
}

function onPoint(p: { index: number; datasetIndex: number; x: number; y: number }) {
  const dim = props.widget.dimension
  if (!dim) return
  const dataset = props.widget.dataset === 'geo' ? 'geo' : 'rum'

  // Breakdown charts (nested doughnut): the two rings are two DIFFERENT dimensions — resolve
  // which one this arc belongs to (and its value) instead of reading widget.dimension. Other
  // breakdown chart types (e.g. stackedBar) aren't wired for this yet, so leave them be.
  if (props.widget.breakdown) {
    if (props.widget.type !== 'nestedDoughnut' || !data.value) return
    const hit = nestedDoughnutClickValue(props.widget, data.value, p.datasetIndex, p.index)
    if (!hit) return
    if (!isSiteDim(hit.dimension) && semanticKey(hit.dimension, dataset) === null) return // not drillable → keep tooltip
    suppressTooltipForDrill()
    emit('drill', { widgetId: props.widget.id, dimension: hit.dimension, dataset, value: hit.value, label: formatKey(hit.dimension, hit.value), x: p.x, y: p.y })
    return
  }

  // Index into the rows the chart actually PLOTTED (a 'date' series is zero-filled, so the
  // raw response rows don't line up with the point indexes) — see seriesRows.
  const value = data.value ? seriesRows(dim, data.value)[p.index]?.key?.[dim] : undefined
  if (value == null || value === '') return
  if (dim !== 'date' && dim !== 'dateEt' && !isSiteDim(dim) && semanticKey(dim, dataset) === null) return // not drillable → keep tooltip
  suppressTooltipForDrill()
  emit('drill', { widgetId: props.widget.id, dimension: dim, dataset, value: String(value), label: formatKey(dim, String(value)), x: p.x, y: p.y })
}

// ── Zoom: grow THIS card element to a centered spot and back, via a FLIP animation ──
// (measure old rect → let it jump to the new layout → invert with a transform → transition
// the transform away). So the real chart element animates, not a separate overlay.
const zoomed = ref(false)
const aspect = ref(1.6)
const cardEl = ref<HTMLElement | null>(null)

// Fit-to-content height (Widget.fit, lib/fit.ts): while on, the card's body is content-sized
// (see `.fit` below) and its content height is reported for Dashboard.vue to turn into grid rows.
// Off while zoomed (the zoomed card is a fixed-aspect panel, not a grid slot).
const fitActive = computed(() => isFit(props.widget) && !zoomed.value)
useFitHeight(cardEl, fitActive, (px) => emit('fit-height', px))

// Animate the card from `fromRect` to wherever it now sits. Works both ways: on zoom-in
// `fromRect` is the small grid slot (it grows to center); on zoom-out it's the big centered
// box (it shrinks back into the grid).
function flip(fromRect: DOMRect) {
  const el = cardEl.value
  if (!el) return
  const to = el.getBoundingClientRect()
  if (to.width === 0 || to.height === 0) return
  const zoomingOut = !zoomed.value
  if (zoomingOut) {
    // Back in the (statically-positioned) grid — needs a stacking context to float above
    // neighbors while it shrinks.
    el.style.position = 'relative'
    el.style.zIndex = '1001'
  }
  el.style.transformOrigin = 'top left'
  el.style.transition = 'none'
  el.style.transform = `translate(${fromRect.left - to.left}px, ${fromRect.top - to.top}px) scale(${fromRect.width / to.width}, ${fromRect.height / to.height})`
  void el.offsetWidth // apply the inverted start state before transitioning
  el.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.8, 0.3, 1)'
  el.style.transform = 'none'
  let cleared = false
  const done = () => {
    if (cleared) return
    cleared = true
    el.style.transition = ''
    el.style.transform = ''
    el.style.transformOrigin = ''
    el.style.position = ''
    el.style.zIndex = ''
    el.removeEventListener('transitionend', done)
  }
  el.addEventListener('transitionend', done)
  setTimeout(done, 360) // fallback if transitionend doesn't fire
}

async function toggleZoom(next: boolean = !zoomed.value) {
  const el = cardEl.value
  if (!el || next === zoomed.value) return
  const from = el.getBoundingClientRect()
  if (next && from.height > 0) aspect.value = from.width / from.height // keep the card's ratio
  zoomed.value = next
  await nextTick()
  flip(from)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && zoomed.value) toggleZoom(false)
  if (e.key === 'Escape' && revealed.value) closeRevealed()
}
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

const data = ref<StatsResponse | null>(null)
const seriesData = ref<StatsResponse[] | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const menuOpen = ref(false)
let reqId = 0
// Everything shown under the chart, in one fixed order (lib/chartNotes.ts): attached captions, the
// response's own notes, and the range notice (the server cut the range down to what the data
// source allows; runtime only, never saved).
const notes = computed(() => chartNotes(props.widget, data.value, error.value))
// `{=…}` value tokens in the caption (lib/valueTokens.ts): filled from this chart's own response
// and the fixed dates, never a fetch. Only the widget's own caption takes them; every other note
// shows "—" for a token.
const captionValues = computed(() => chartValueResolver(props.widget, data.value, error.value))
watch([data, error], () => emit('data', data.value, error.value))

// Per-chart filter override: use widget.filters if set, else the global filter.
const effectiveFilters = computed<GlobalFilters>(() => props.widget.filters ?? props.filters)
const hasOverride = computed(() => !!props.widget.filters)

// A background refetch (the user came back to the tab) keeps the chart on screen — no "Loading…"
// flash, and a failure leaves the last good data up instead of replacing it with an error.
let loadStartedAt: number | null = null // the latest load's start; null once it settles
let settledAt: number | null = null
async function load(background = false) {
  if (isBespokeBody.value) return // own data fetch (or none) — see MetricCard/AdsReadingsWidgetCard/NoteWidgetBody
  // RUM charts filter to a real-host allow-list built from /api/sites; fetching before
  // it loads would momentarily count dev/preview traffic. Wait for the tree. (Geo has
  // no dev hosts, so it needn't wait.)
  if (props.widget.dataset !== 'geo' && props.widget.dataset !== 'popup' && !sitesLoaded.value) {
    if (!background) loading.value = true
    return
  }
  const my = ++reqId
  if (!background) {
    loading.value = true
    error.value = null
  }
  loadStartedAt = Date.now()
  try {
    // A series line chart fetches one date query per series; the first also stands in as `data`
    // for the generic empty/loaded states. The caption flags come from every series (review of
    // #63, NIT-1): any one series' split guard or whole-days window shows its caption.
    if (hasLineSeries(props.widget)) {
      const all = await fetchSeriesStats(props.widget, effectiveFilters.value)
      if (my === reqId) {
        seriesData.value = all
        const splitGuard = all.some((r) => r.meta?.splitGuard)
        const refusedWholeDays = all.some((r) => r.meta?.refusedWholeDays)
        data.value = {
          ...all[0],
          rows: all.flatMap((r) => r.rows),
          notice: all.find((r) => r.notice)?.notice,
          meta: { ...all[0].meta, ...(splitGuard ? { splitGuard } : {}), ...(refusedWholeDays ? { refusedWholeDays } : {}) },
        }
      }
    } else {
      const r = await fetchStats(props.widget, effectiveFilters.value)
      if (my === reqId) {
        seriesData.value = null
        data.value = r
      }
    }
    if (my === reqId) {
      error.value = null
      settledAt = Date.now()
    }
  } catch (e: any) {
    if (my === reqId) {
      settledAt = Date.now()
      if (!background || !data.value) error.value = e?.message ?? 'Failed to load'
    }
    if (isNetworkError(e) || isAuthError(e)) checkSessionExpired() // probe for an expired session
  } finally {
    if (my === reqId) {
      loadStartedAt = null
      loading.value = false
    }
  }
}

// The user came back to the tab: refetch this chart if its last load is old enough and nothing is
// loading. Same request as any other load (never `fresh`), so the 90 s edge cache absorbs repeats.
// A metric card is not handled here — its values go through useMetrics' own return refetch.
function refetchOnReturn() {
  if (isBespokeBody.value || isInFlight(loadStartedAt) || !isStale(settledAt)) return
  void load(true)
}
useReturnRefresh(refetchOnReturn)

// Refetch only when a data-affecting input changes (not on move/resize).
const dataKey = computed(() =>
  JSON.stringify({
    d: props.widget.dimension,
    b: props.widget.breakdown,
    m: props.widget.metric,
    l: props.widget.limit,
    s: props.widget.site,
    ss: props.widget.siteSel,
    h: props.widget.host,
    e: props.widget.excludeSelfReferrals,
    pu: props.widget.popup,
    pk: props.widget.popupKind,
    // feat/all-beacon-fields: per-chart geo opt-in — data-affecting (changes which rows the
    // query counts), so it belongs in the refetch key same as excludeSelfReferrals above.
    ieb: props.widget.includeEventBeacons,
    ekt: props.widget.excludeKnownTraffic,
    // A series line chart's series list (labels/axes/styles change only the drawing, but it's
    // simplest and cheap to refetch — each series query is edge-cached).
    ser: props.widget.series,
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
  // An override built from the current filter model carries `siteSel` and no legacy `site`
  // (e.g. the campaign device mix's rolling-year override) — summarize that instead of
  // assuming the legacy single-site field is set.
  const site =
    f.site === 'all' || (!f.site && !f.host && !f.siteSel?.length)
      ? 'all sites'
      : f.host
        ? f.host.replace('.goodstuff.software', '')
        : f.site
          ? f.site.replace('goodstuff.software', 'gs').replace('.com', '')
          : f.siteSel.join(', ')
  const flags: string[] = []
  if (f.excludeOwnVisits) flags.push('−me')
  return [site, rangeLabel(f.since, f.until, f.rangeRel), ...flags].join(' · ')
})
watch(dataKey, () => load())
watch(sitesLoaded, (ready) => ready && load()) // fetch RUM charts once the allow-list is ready
onMounted(() => load())

// Every overlay item (release, go-live, campaign flight) the chart can draw inside the plotted
// range — listed under the chart in a collapsed disclosure, so each marker's and band's date,
// name and note are reachable by keyboard and touch, not only by hovering the canvas.
const overlayList = computed(() => {
  if (!isDateDim(props.widget.dimension) || !widgetHasOverlay(props.widget) || !data.value) return []
  const first = String(data.value.meta.since).slice(0, 10)
  const last = String(data.value.meta.until).slice(0, 10)
  return itemsInRange(overlayItems(widgetOverlayOptions(props.widget)), first, last).map((it) => ({
    key: `${it.kind}|${it.date}|${it.label}`,
    when: it.kind === 'flight' ? `${it.date} to ${it.openEnded ? 'now' : it.endDate}` : it.date,
    kind: it.kind === 'flight' ? 'Campaign flight' : it.kind === 'go-live' ? 'Go-live' : 'Release',
    label: it.label,
    note: it.note,
  }))
})

const chartConfig = computed(() => {
  if (!data.value) return null
  void props.dark // recompute colors on theme toggle
  return buildChartConfig(props.widget, data.value, seriesData.value ?? undefined, effectiveFilters.value)
})

const statValue = computed(() =>
  !data.value ? 0 : props.widget.metric === 'visits' ? data.value.totals.visits : data.value.totals.pageviews,
)
const statOther = computed(() =>
  !data.value ? 0 : props.widget.metric === 'visits' ? data.value.totals.pageviews : data.value.totals.visits,
)
const statOtherLabel = computed(() => (props.widget.metric === 'visits' ? 'pageviews' : 'visits'))

// Pop-up rate tile (widget.type === 'rate'): null (no denominator yet) renders as "—",
// never NaN/Infinity — see lib/popupEvents.ts computeRate. A nonzero-but-too-small
// denominator (MIN_COHORT — see lib/popupEvents.ts gateRate) is a THIRD state, distinct
// from "no data at all": "too few to report", not "—".
const rateValue = computed<number | null>(() => data.value?.rate ?? null)
const rateDisplay = computed(() => {
  if (data.value?.insufficientCohort) return 'too few to report'
  return rateValue.value == null ? '—' : `${(rateValue.value * 100).toFixed(1)}%`
})
// n/d next to every rate — see lib/popupEvents.ts GatedRate.numerator/denominator. Shown
// whenever the API sent a denominator at all (including 0, so "no data yet" still reads
// as "0/0" rather than silently omitting the counts).
const rateCounts = computed(() =>
  data.value?.denominator == null ? null : `${data.value.numerator ?? 0}/${data.value.denominator}`,
)

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
  () =>
    !loading.value &&
    !error.value &&
    data.value &&
    data.value.rows.length === 0 &&
    props.widget.type !== 'map' &&
    props.widget.type !== 'rate', // a rate tile has no rows even when it has a real (or null) rate — never "No data"
)

// Pop-up count widgets (everything except the 'rate' tile and the 'date' trend, which
// plot full history themselves — see functions/api/popups.ts) go "excluded" rather than
// showing a real-looking chart of zero/pre-release counts while tracking hasn't shipped
// yet — see lib/popupEvents.ts TRACKING_ACTIVATION_DATE_ET, hard requirement "before
// activation is unmeasured, not zero."
const popupNotYetActive = computed(
  () =>
    props.widget.dataset === 'popup' &&
    props.widget.type !== 'rate' &&
    props.widget.dimension !== 'date' &&
    !!data.value?.meta?.activationPending,
)

function fmt(n: number) {
  return n.toLocaleString('en-US')
}

// Mark/unmark this chart as one of the page's defaults (kept on "Restore default charts").
function toggleDefault() {
  props.widget.isDefault = !props.widget.isDefault
}

function closeMenu() {
  menuOpen.value = false
}
onMounted(() => document.addEventListener('click', closeMenu))
onBeforeUnmount(() => document.removeEventListener('click', closeMenu))
</script>

<template>
  <Teleport to="body" :disabled="!zoomed">
    <div ref="cardEl" class="chart-card" :class="{ zoomed, revealed, 'controls-revealed': forceControls, 'note-card': isNoteWidget, 'needs-chart-height': needsChartHeight, 'tall-on-phone': tallOnPhone, fit: fitActive }" :style="zoomed ? { '--ar': aspect } : undefined">
    <header class="card-head" :class="{ 'note-head': isNoteWidget }">
      <div class="title-wrap" v-if="!isNoteWidget">
        <span v-if="widget.isDefault" class="pin" title="A default chart on this page — kept when you restore defaults">★</span>
        <span class="title" :title="widget.title">{{ widget.title }}</span>
        <span v-if="overrideSummary" class="ovr" :title="'Filter override: ' + overrideSummary"
          >· {{ overrideSummary }}</span
        >
      </div>
      <div class="head-actions">
        <!-- Revealed controls (owner clarification, 2026-09-26): filter/reload/options-menu
             stay hidden until this card's own reveal is toggled on, the page's edit mode is on
             (forceControls), or — desktop only — the card is hovered/focused-within. -->
        <div :id="revealId" class="revealed-controls hide-until-revealed">
          <button
            v-if="!isBespokeBody"
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
          <button v-if="!isBespokeBody || (isCard && !cardHasOwnReload)" class="btn-ghost icon" title="Reload" @click.stop="reloadThis">↻</button>
          <div class="menu-anchor">
            <button class="btn-ghost icon" title="Options" @click.stop="menuOpen = !menuOpen">⋯</button>
            <div v-if="menuOpen" class="menu" @click.stop>
              <button @click="emit('edit'); menuOpen = false">Edit</button>
              <button @click="emit('duplicate'); menuOpen = false">Duplicate</button>
              <button @click="toggleDefault(); menuOpen = false">
                {{ widget.isDefault ? 'Remove from default' : 'Set as default' }}
              </button>
              <button class="danger" @click="emit('remove'); menuOpen = false">Delete</button>
            </div>
          </div>
        </div>
        <!-- Zoom + reveal — exactly two small, borderless, low-contrast icons, ALWAYS visible
             on every device including touch (owner: "hide the bar for each chart and have a
             reveal button and zoom button only by default"). Zoom is one tap/click; a note
             tile has nothing to zoom, so it's omitted there (owner: "Note widgets show only
             the reveal icon"). Double-tapping the chart body also zooms — see
             onCardBodyDblClick — as an extra shortcut, not a substitute. -->
        <button
          v-if="widget.type !== 'note'"
          class="zoom-btn"
          :title="zoomed ? 'Zoom out' : 'Zoom in'"
          :aria-label="zoomed ? 'Zoom out' : 'Zoom in'"
          @click.stop="toggleZoom()"
        >
          <svg v-if="!zoomed" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <!-- Reveal — toggles the .revealed-controls group above for THIS card only. Tapping it
             again, Escape, or a click outside the card closes it (toggleRevealed/closeRevealed/
             onKey in the script). -->
        <button
          class="reveal-btn"
          :class="{ 'is-open': revealed }"
          title="Show chart controls"
          aria-label="Show chart controls"
          :aria-expanded="revealed"
          :aria-controls="revealId"
          @click.stop="toggleRevealed"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M2 4h4M10 4h4M2 8h1M7 8h7M2 12h6M12 12h2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            <circle cx="7" cy="4" r="1.6" fill="currentColor" />
            <circle cx="4" cy="8" r="1.6" fill="currentColor" />
            <circle cx="9" cy="12" r="1.6" fill="currentColor" />
          </svg>
        </button>
      </div>
    </header>

    <div class="card-body" @dblclick="onCardBodyDblClick">
      <!-- Bespoke bodies: overview / campaigns / ads-readings datasets, and the note type —
           own data fetch (or none), skip the generic loading/error/empty states above. -->
      <MetricCard v-if="widget.card" ref="metricCard" :card-ref="widget.card" :context="metricsContext" :campaign-ids="widget.campaignIds" :hidden-captions="widget.hiddenCaveats" :fallback-title="widget.title" @open-campaigns="emit('open-campaigns')" />
      <p v-else-if="widget.dataset === 'overview' || widget.dataset === 'campaigns'" class="state mono">{{ retiredPanelText }}</p>
      <AdsReadingsWidgetCard v-else-if="widget.dataset === 'ads-readings'" :widget="widget" />
      <NoteWidgetBody v-else-if="widget.type === 'note'" :widget="widget" />

      <div v-else-if="loading" class="state mono">Loading…</div>
      <div v-else-if="error" class="state error mono">{{ error }}</div>
      <div v-else-if="popupNotYetActive" class="state mono">Tracking not yet active</div>
      <div v-else-if="isEmpty" class="state mono">No data in range</div>

      <!-- Stat tile -->
      <div v-else-if="widget.type === 'stat'" class="stat">
        <div class="stat-num">{{ fmt(statValue) }}</div>
        <div class="stat-label overline">{{ widget.metric }}</div>
        <div class="stat-sub">{{ fmt(statOther) }} {{ statOtherLabel }}</div>
      </div>

      <!-- Pop-up rate tile: "—" for a zero denominator, never 0%/NaN -->
      <div v-else-if="widget.type === 'rate'" class="stat">
        <div class="stat-num">{{ rateDisplay }}</div>
        <div class="stat-label overline">rate</div>
        <div v-if="rateCounts" class="stat-sub mono">{{ rateCounts }}</div>
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
      <BaseChart v-else-if="chartConfig" ref="baseChartRef" :config="chartConfig" :drill-open="drillOpen" @point="onPoint" />
    </div>

    <!-- Notes under the chart (lib/chartNotes.ts, one fixed order): the widget's own plain-text
         caption (Widget.caption), legacy registry caption ids (`widget.notes`, read-only; they
         convert to caption text on the chart's next edit), the scope's automatic caveats
         (lib/notes.ts autoCaveatIds), then the runtime caveats, minus any
         this widget hides (Widget.hiddenCaveats). All through the SAME NoteBlock every inline
         caveat/note-type-widget uses. Pop-up dataset only: `data.note` (informational review fix, 2026-09-26) — a data
         caveat that travels with the API RESPONSE itself (functions/api/popups.ts, e.g. the
         known install-outcome gap), computed per-request rather than being static config
         like the registry captions above, so it has to be rendered from `data` here rather
         than looked up by id — previously fetched but never rendered anywhere. -->
    <details v-if="overlayList.length" class="overlay-list">
      <summary>Markers and bands ({{ overlayList.length }})</summary>
      <ul>
        <li v-for="o in overlayList" :key="o.key">
          <span class="ol-when mono">{{ o.when }}</span>
          <span class="ol-kind">{{ o.kind }}</span>
          <strong>{{ o.label }}</strong>
          <span class="ol-note">{{ o.note }}</span>
        </li>
      </ul>
    </details>
    <div v-if="notes.length" class="card-captions">
      <NoteBlock
        v-for="n in notes"
        :key="n.key"
        :note-id="n.noteId"
        :text="n.text"
        :severity="n.severity"
        :values="n.key === 'caption' ? captionValues : undefined"
        :class="{ 'range-notice': n.key === 'range-notice' }"
        :data-testid="n.key === 'range-notice' ? 'range-notice' : undefined"
      />
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
  </Teleport>

  <Teleport to="body">
    <Transition name="fade">
      <div v-if="zoomed" class="zoom-backdrop" @click="toggleZoom(false)"></div>
    </Transition>
  </Teleport>
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
  /* No divider/strip (owner clarification, 2026-09-26 — "these bars are supposed to be
     invisible"): a plain heading directly above the content, like the old bespoke pages'
     <h2>, not a bordered bar. */
  padding: 10px 10px 4px 14px;
  user-select: none;
  background: transparent;
}
.card-head:active {
  cursor: grabbing;
}
/* Drag affordance: only look draggable once modification chrome is revealed (clean look
   by default, owner clarification 2026-09-26). The card remains functionally draggable
   throughout — this is cosmetic only, matching the resize grip's own hover-reveal. */
@media (hover: hover) and (pointer: fine) {
  .card-head {
    cursor: default;
  }
  .chart-card:hover .card-head,
  .chart-card.controls-revealed .card-head,
  .chart-card.revealed .card-head {
    cursor: grab;
  }
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
.pin {
  color: rgb(var(--amber));
  font-size: 12px;
  line-height: 1;
  flex-shrink: 0;
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
.revealed-controls {
  display: flex;
  align-items: center;
  gap: 2px;
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
/* Revealed controls (filter/reload/options-menu) — hidden by default on every device (owner
   clarification, 2026-09-26: "hide the bar for each chart"), shown once: this card's own
   reveal is toggled on (.revealed — see the reveal button below), the page's edit mode is on
   (.controls-revealed, Dashboard's forceControls), or — desktop only, hover+fine-pointer — the
   card is hovered/focused-within. Hidden is the BASE rule for every device including touch, so
   a touchscreen (which never matches the hover media query) doesn't leak them permanently
   visible. */
.hide-until-revealed {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.chart-card.controls-revealed .hide-until-revealed,
.chart-card.revealed .hide-until-revealed {
  opacity: 1;
  pointer-events: auto;
}
@media (hover: hover) and (pointer: fine) {
  .chart-card:hover .hide-until-revealed,
  .chart-card:focus-within .hide-until-revealed {
    opacity: 1;
    pointer-events: auto;
  }
}
/* Zoom + reveal — exactly two small, borderless, low-contrast icons, ALWAYS visible on every
   device including touch (owner clarification, 2026-09-26: "have a reveal button and zoom
   button only by default" — reversing the earlier "hidden on touch until edit mode" behavior
   for these two specifically; that hiding still applies to everything else, see
   .hide-until-revealed above). Low contrast at rest, full contrast on hover/focus (desktop) or
   while open/on (edit mode, or — for reveal — its own toggled-on state). */
.zoom-btn,
.reveal-btn {
  border: none;
  background: transparent;
  color: rgb(var(--ink-3));
  font-size: 16px;
  line-height: 1;
  padding: 4px 7px;
  border-radius: 7px;
  opacity: 0.55;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}
.zoom-btn:hover,
.zoom-btn:focus-visible,
.reveal-btn:hover,
.reveal-btn:focus-visible {
  opacity: 1;
  background: rgb(var(--sunken));
  color: rgb(var(--ink));
}
.chart-card.controls-revealed .zoom-btn,
.chart-card.controls-revealed .reveal-btn,
.reveal-btn.is-open {
  opacity: 1;
}
.reveal-btn.is-open {
  color: rgb(var(--amber-hover));
}
.zoom-btn svg,
.reveal-btn svg {
  display: block;
}
/* 36-44px touch target on any touch-capable device — gated on (pointer: coarse), not a
   viewport-width breakpoint (a tablet can be wider than 700px and still have a coarse/touch
   pointer, and a narrow window on a mouse-driven desktop shouldn't get a touch-sized target it
   doesn't need). The icon itself stays the same visual size; only the hit area grows
   (padding) — owner: "staying visually small". */
@media (pointer: coarse) {
  .zoom-btn,
  .reveal-btn {
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
}
/* Note widgets: a bare compact caption, matching v0.5.2's bespoke <p class="caption"> — no
   border, no background, no title row. The edit-mode menu floats as a small absolute overlay
   instead of reserving a header row, so it never adds visual weight when hidden. */
.chart-card.note-card {
  position: relative; /* anchors .note-head's absolute overlay */
  border: none;
  background: transparent;
  border-radius: 0;
}
.card-head.note-head {
  position: absolute;
  top: 0;
  right: 0;
  padding: 2px;
  z-index: 2;
  width: auto;
}
.note-card .card-body {
  padding: 4px 6px;
  min-height: 0;
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
/* Fit to content (Widget.fit): the body takes its content's height instead of the rest of the
   fixed grid slot, so nothing inside it is clipped or scrolls; Dashboard.vue then sizes the slot
   to this content. The card stays `height: 100%` of its slot (the slot is at most one row taller
   than the content), and the content height is measured from the children, not the card. */
.chart-card.fit .card-body {
  flex: none;
  overflow: visible;
}
/* Mobile only (matches Dashboard.vue's stacking breakpoint — lib/responsive.ts
   MOBILE_MAX_WIDTH): the card's own height there is `auto` so it can grow to fit content
   instead of scrolling internally, but a Chart.js canvas/map still needs a percentage-height
   ancestor with a DEFINITE size (chart-wrap is height:100%). This min-height is that floor —
   content that needs more (KPI grids, tables, notes) simply grows past it. Desktop keeps
   relying on the grid's own explicit per-widget pixel height (unchanged, so small stat tiles
   stay small — saved layouts keep their proportions). */
@media (max-width: 700px) {
  .card-body {
    min-height: 220px;
  }
  .note-card .card-body {
    min-height: 0;
  }
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
@media (max-width: 700px) {
  .chart-card.chart-card.needs-chart-height.tall-on-phone {
    height: auto;
  }
  .chart-card.tall-on-phone .card-body {
    flex: none;
    height: 360px;
  }
}
.overlay-list {
  padding: 0 14px 6px;
  font-size: 12px;
  color: rgb(var(--ink-2));
  min-width: 0;
}
.overlay-list summary {
  cursor: pointer;
  color: rgb(var(--ink-3));
  font-size: 11.5px;
  padding: 4px 0;
}
.overlay-list ul {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 150px;
  overflow-y: auto;
}
.overlay-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  padding: 4px 0;
  border-top: 1px solid rgb(var(--line));
  overflow-wrap: anywhere;
}
.ol-when {
  color: rgb(var(--ink-3));
  font-size: 11px;
}
.ol-kind {
  color: rgb(var(--ink-3));
  font-size: 11px;
}
.ol-note {
  flex-basis: 100%;
  color: rgb(var(--ink-2));
}
/* Attached captions: inside the card's own padding, and a long word or path wraps instead of
   running past the rounded border (it used to sit flush left and be clipped at phone width). */
.card-captions {
  padding: 0 14px 10px;
  min-width: 0;
  overflow-wrap: anywhere;
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

/* ── Zoom: the card element itself becomes a centered, enlarged panel (JS FLIP-animates
   it from/to its grid slot). Same aspect ratio (--ar = w/h), scaled to most of the screen;
   width is chosen so height (= width / ar) never exceeds ~86vh. ── */
.chart-card.zoomed {
  position: fixed;
  inset: 0;
  margin: auto; /* centers a fixed element that has an explicit width + height */
  width: min(92vw, calc(86vh * var(--ar, 1.6)));
  aspect-ratio: var(--ar, 1.6);
  max-height: 86vh;
  z-index: 1001;
  border: 2px solid rgb(var(--line-2));
  border-radius: 16px;
  box-shadow: 0 30px 80px rgb(0 0 0 / 0.4);
}
.zoom-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgb(0 0 0 / 0.55);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
