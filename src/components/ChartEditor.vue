<script setup lang="ts">
import { reactive, computed, watch, onMounted, onBeforeUnmount, ref, useId } from 'vue'
import type { Widget, LineSeries, GlobalFilters } from '../types'
import {
  DIMENSIONS,
  GEO_DIMENSIONS,
  POPUP_DIMENSIONS,
  POPUP_OPTIONS,
  POPUP_KIND_OPTIONS,
  POPUP_RATE_DIMENSIONS,
  COMPLETIONS_DIMENSIONS,
  DATASETS,
  CHART_TYPES,
  METRICS,
  OVERVIEW_VIEWS,
  CAMPAIGNS_VIEWS,
  CAMPAIGN_OPTIONS,
  BAR_MODES,
} from '../lib/catalog'
import { ringDims, RING_SOFT_CAP, isDateDim } from '../lib/rings'
import { BEST_SUDOKU_SITES, syncCardWithView } from '../lib/defaults'
import { noteOptions, defaultNoteIdsForScope, type NoteScope } from '../lib/notes'
import CardEditor from './metrics/CardEditor.vue'
import { metricsContextFor } from '../lib/metrics/pageContext'
import { presetById } from '../lib/metrics/presets'
import { selectsCampaigns } from '../lib/metrics/scope'
import { resolveSelection } from '../sitesStore'
import type { MetricsContext } from '../lib/metrics/types'

// `filters` is the page's main filter bar (App.vue's `activePage.filters`) — used ONLY to build
// the metric-card preview's context (the same range/sites a saved card would read); every other
// field here is unaffected by it, same as before this prop existed.
// `filters` is optional defensively (a caller that hasn't wired it yet still gets a working
// editor — the card preview just has no page range for a `window: 'page'` item until it does).
const props = defineProps<{ widget: Widget; isNew: boolean; filters?: GlobalFilters }>()
const emit = defineEmits<{ save: [Widget]; cancel: []; remove: [] }>()

// Series/axis titles are nested objects: copy them, so Cancel leaves the saved widget untouched.
const copyWidget = (w: Widget): Widget => ({
  ...w,
  series: w.series?.map((x) => ({ ...x, filter: x.filter?.map((f) => ({ ...f })) })),
  axisTitles: w.axisTitles ? { ...w.axisTitles } : undefined,
})
const draft = reactive<Widget>(copyWidget(props.widget))
watch(
  () => props.widget,
  (w) => Object.assign(draft, copyWidget(w)),
)

// Belt and suspenders for "the sheet must scroll to the top when it opens" (review fix,
// 2026-09-27): a freshly mounted .panel already starts at scrollTop 0 once .overlay's flex
// centering no longer fights it (see the mobile @media rule below) — this just makes that
// explicit instead of relying on it being an accident of the CSS.
const panelEl = ref<HTMLElement | null>(null)

// ── Dialog a11y (review fix, 2026-09-27): role="dialog"/aria-modal on .panel, named by the
// heading below; focus moves to Title on open, is trapped inside the dialog while it's open
// (Tab/Shift+Tab wrap instead of escaping to the page behind it), Esc cancels the same as the
// Cancel button, and focus returns to whatever had it before the dialog opened (App.vue's own
// "Edit"/"Add chart" control) once it closes — captured here rather than passed in, so this
// works regardless of what opened the editor, with no change needed at any call site. ──────────
const dialogTitleId = useId()
const titleInputEl = ref<HTMLInputElement | null>(null)
let previouslyFocused: HTMLElement | null = null

function focusableEls(): HTMLElement[] {
  if (!panelEl.value) return []
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return [...panelEl.value.querySelectorAll<HTMLElement>(selector)].filter((el) => el.offsetParent !== null || el === document.activeElement)
}
function onDialogKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('cancel')
    return
  }
  if (e.key !== 'Tab') return
  const els = focusableEls()
  if (!els.length) return
  const first = els[0]
  const last = els[els.length - 1]
  // Wrap instead of letting Tab escape the dialog onto the page behind it.
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

onMounted(() => {
  if (panelEl.value) panelEl.value.scrollTop = 0
  previouslyFocused = document.activeElement as HTMLElement | null
  titleInputEl.value?.focus()
})
onBeforeUnmount(() => {
  previouslyFocused?.focus?.()
})

const isGeo = computed(() => draft.dataset === 'geo')
const isPopup = computed(() => draft.dataset === 'popup')
const isCompletions = computed(() => draft.dataset === 'completions')
const isRate = computed(() => draft.type === 'rate')
const isNote = computed(() => draft.type === 'note')
// The three former-bespoke datasets: no dimension/breakdown/metric/site-override — a
// "View" picker (+ campaign multi-select for campaigns/ads-readings) replaces them.
const isOverviewDataset = computed(() => draft.dataset === 'overview')
const isCampaignsDataset = computed(() => draft.dataset === 'campaigns')
const isAdsReadingsDataset = computed(() => draft.dataset === 'ads-readings')
const isBespokeDataset = computed(() => isOverviewDataset.value || isCampaignsDataset.value || isAdsReadingsDataset.value)
const viewOptions = computed(() => (isOverviewDataset.value ? OVERVIEW_VIEWS : isCampaignsDataset.value ? CAMPAIGNS_VIEWS : []))
const campaignIdsValue = computed<string[]>({
  get: () => draft.campaignIds ?? [],
  set: (v: string[]) => {
    draft.campaignIds = v.length ? v : undefined
  },
})
function toggleCampaign(id: string, checked: boolean) {
  const set = new Set(draft.campaignIds ?? [])
  if (checked) set.add(id)
  else set.delete(id)
  campaignIdsValue.value = CAMPAIGN_OPTIONS.map((o) => o.value).filter((v) => set.has(v))
}

// ── Notes/text registry (lib/notes.ts) — 'note' widgets pick a registry entry OR type
// custom text; every OTHER widget can attach registry notes as captions. ──────────────────
const NOTE_OPTIONS = noteOptions()
const isCustomNote = computed({
  get: () => !draft.noteId,
  set: (custom: boolean) => {
    draft.noteId = custom ? undefined : NOTE_OPTIONS[0]?.value
    if (!custom) draft.note = undefined
  },
})
// The dataset scope an attached-notes picker should default from — mirrors lib/notes.ts's
// NoteScope union; a widget with no recognizable scope (plain RUM) gets no defaults, only
// whatever the user explicitly attaches.
const draftScope = computed<NoteScope | null>(() => {
  const d = draft.dataset
  return d === 'overview' || d === 'campaigns' || d === 'popup' || d === 'geo' || d === 'ads-readings' ? d : null
})
const attachedNotesValue = computed<string[]>({
  get: () => draft.notes ?? (draftScope.value ? defaultNoteIdsForScope(draftScope.value) : []),
  set: (v: string[]) => {
    draft.notes = v
  },
})
function toggleAttachedNote(id: string, checked: boolean) {
  const set = new Set(attachedNotesValue.value)
  if (checked) set.add(id)
  else set.delete(id)
  attachedNotesValue.value = NOTE_OPTIONS.map((o) => o.value).filter((v) => set.has(v))
}
// A rate tile's "dimension" is a POPUP_RATE_SPECS key, not a group-by field — a wholly
// different picker domain from the count-mode dimensions below it.
const dimOptions = computed(() =>
  isRate.value ? POPUP_RATE_DIMENSIONS : isPopup.value ? POPUP_DIMENSIONS : isGeo.value ? GEO_DIMENSIONS : isCompletions.value ? COMPLETIONS_DIMENSIONS : DIMENSIONS,
)
// A count-mode popup chart ('kind'/'reason'/'date'/'outcome') needs to know WHICH pop-up
// it's scoped to; 'reason'/'date' also need which funnel stage they break down/trend.
const popupNeedsPopup = computed(() => isPopup.value && !isRate.value && draft.dimension !== 'installOutcome')
const popupNeedsKind = computed(() => isPopup.value && !isRate.value && (draft.dimension === 'reason' || draft.dimension === 'date'))

// Switching data source: keep the dimension + breakdown valid for the new source. The
// beacon supports a breakdown too (nested doughnut / stacked bar), so we remap rather
// than drop it; only the metric is beacon-agnostic (it's always a count).
function onDatasetChange() {
  if (isBespokeDataset.value) {
    // No dimension/breakdown/metric/rings/site-override domain — a View picker (+ campaign
    // multi-select) replaces them entirely. Chart type is irrelevant too (each view renders
    // its own fixed layout), so pin it to 'table' as an inert placeholder value.
    draft.dimension = ''
    draft.breakdown = undefined
    draft.rings = undefined
    draft.popup = undefined
    draft.popupKind = undefined
    draft.site = undefined
    draft.host = undefined
    draft.metric = 'pageviews'
    if (!draft.view || !viewOptions.value.some((v) => v.value === draft.view)) {
      draft.view = viewOptions.value[0]?.value
    }
    return
  }
  draft.view = undefined
  draft.campaignIds = undefined
  if (!dimOptions.value.some((d) => d.key === draft.dimension)) {
    draft.dimension = dimOptions.value[0].key
  }
  if (draft.breakdown && !dimOptions.value.some((d) => d.key === draft.breakdown)) {
    draft.breakdown = undefined
  }
  // Extra rings (RUM vs geo dimension keys don't line up — e.g. 'deviceType' vs 'device') —
  // drop whichever no longer resolve in the new source's catalog.
  if (draft.rings?.length) {
    draft.rings = draft.rings.filter((r) => dimOptions.value.some((d) => d.key === r))
    if (!draft.rings.length) draft.rings = undefined
  }
  if (isGeo.value || isPopup.value || isCompletions.value) draft.metric = 'pageviews'
  if (isPopup.value && !draft.popup) draft.popup = POPUP_OPTIONS[0]?.value
  if (isPopup.value && !draft.popupKind) draft.popupKind = 'shown'
  if (!isPopup.value) {
    draft.popup = undefined
    draft.popupKind = undefined
  }
}

// Switching chart TYPE also switches dimension domain when it crosses into/out of
// 'rate' (a rate tile's dimension list is a different domain — see dimOptions above).
watch(
  () => draft.type,
  (t, prev) => {
    if (t === 'rate' && draft.dataset !== 'popup') {
      draft.dataset = 'popup'
      onDatasetChange()
    }
    const wasRate = prev === 'rate'
    const nowRate = t === 'rate'
    if (wasRate !== nowRate && !dimOptions.value.some((d) => d.key === draft.dimension)) {
      draft.dimension = dimOptions.value[0]?.key ?? ''
    }
  },
)

// ── Nested doughnut: extra rings beyond dimension + breakdown ──────────────────────────────
// Options for a ring pick: the same per-dataset catalog the dimension/breakdown selects use,
// minus 'date' (a ring must be a real group-by column — see lib/rings.ts) and whatever's
// already used elsewhere in the ring stack (dimension/breakdown/other rings), so the same
// field can't appear twice.
function ringOptionsFor(idx: number) {
  const used = new Set(ringDims(draft))
  const current = draft.rings?.[idx]
  if (current) used.delete(current) // keep this ring's own current value selectable
  return dimOptions.value.filter((d) => !isDateDim(d.key) && !used.has(d.key))
}
const canAddRing = computed(() => ringOptionsFor((draft.rings ?? []).length).length > 0)
const totalRingCount = computed(() => ringDims(draft).length)

function addRing() {
  const next = ringOptionsFor((draft.rings ?? []).length)[0]
  if (!next) return
  ;(draft.rings ??= []).push(next.key)
}
function setRing(idx: number, key: string) {
  if (draft.rings) draft.rings[idx] = key
}
function removeRing(idx: number) {
  draft.rings?.splice(idx, 1)
}
function moveRing(idx: number, dir: -1 | 1) {
  const list = draft.rings
  if (!list) return
  const j = idx + dir
  if (j < 0 || j >= list.length) return
  ;[list[idx], list[j]] = [list[j], list[idx]]
}

// ── Line/area charts on a date axis: overlay toggles, and (beacon data) a series list — each
// series its own date query narrowed by one filter, on the left or right axis. ─────────────────
const isDateLine = computed(() => (draft.type === 'line' || draft.type === 'area') && isDateDim(draft.dimension))
// A line over a non-date axis may break down into one line per value (lib/charts.ts); a date
// axis draws its lines from `series` instead, so it offers no breakdown there.
const breakdownAllowed = computed(() => !!typeDef.value?.allowsBreakdown && !isDateLine.value)
const isBreakdownLine = computed(() => (draft.type === 'line' || draft.type === 'area') && !isDateLine.value && !!draft.breakdown)
const canUseSeries = computed(() => isDateLine.value && isGeo.value)
const SERIES_FIELDS = GEO_DIMENSIONS.filter((d) => !isDateDim(d.key))
function addSeries() {
  const list: LineSeries[] = (draft.series ??= [])
  list.push({ label: `Series ${list.length + 1}`, axis: 'left', style: 'solid' })
}
function removeSeries(idx: number) {
  draft.series?.splice(idx, 1)
  if (!draft.series?.length) draft.series = undefined
}
function setSeriesFilter(idx: number, part: 'field' | 'value', v: string) {
  const s = draft.series?.[idx]
  if (!s) return
  const cur = s.filter?.[0] ?? { field: '', value: '' }
  const next = { ...cur, [part]: v }
  s.filter = next.field ? [next] : undefined
}
const axisTitlesValue = (side: 'left' | 'right') => draft.axisTitles?.[side] ?? ''
function setAxisTitle(side: 'left' | 'right', v: string) {
  draft.axisTitles = { ...(draft.axisTitles ?? {}), [side]: v || undefined }
}

// The world map is geo-only.
watch(
  () => draft.type,
  (t) => {
    if (t === 'map' && draft.dataset !== 'geo') {
      draft.dataset = 'geo'
      onDatasetChange()
    }
  },
)

// A note carries no dataset/dimension/metric at all — just a title + body text.
watch(
  () => draft.type,
  (t) => {
    if (t === 'note') {
      draft.dataset = undefined
      draft.dimension = ''
      draft.breakdown = undefined
      draft.rings = undefined
      draft.popup = undefined
      draft.popupKind = undefined
      draft.view = undefined
      draft.campaignIds = undefined
      if (draft.notes != null) draft.notes = undefined // captions attach to a CHART, not a note
    } else {
      if (draft.note != null) draft.note = undefined
      if (draft.noteId != null) draft.noteId = undefined
      if (draft.longText != null) draft.longText = undefined
    }
  },
)

// ── Metric card (ADR 0003, phase B): a widget with `card` set replaces every chart-only field
// below with CardEditor. Gated on `!!draft.card`, the SAME condition ChartCard.vue's own
// dispatch uses (`v-if="widget.card"`) — never on `draft.type`, which a card widget's renderer
// ignores entirely — so a widget migrated from the old bespoke Overview panels (still
// `type: 'table'`, `dataset: 'overview'`, `card` set by the v10 migration) opens as a card here
// too, whatever its own stored type says. `draft.type` is deliberately left untouched by any of
// this: ChartCard never reads it for a card widget, so there is no need for a dedicated 'card'
// ChartType value (that would touch the shared ChartType union / CHART_TYPES catalog, outside
// this integration's file list).
const isCardWidget = computed(() => !!draft.card)
/** The card's own spec (preset or inline), for what the form around CardEditor offers. */
const cardSpec = computed(() => (draft.card ? ('preset' in draft.card ? presetById(draft.card.preset) ?? null : draft.card.spec) : null))
/** A card repeated over campaigns takes the widget's campaign selection (MetricCard
 * campaignIds, lib/metrics/scope.ts narrowToCampaigns): the Campaign(s) picker shows for it. */
const cardSelectsCampaigns = computed(() => selectsCampaigns(cardSpec.value?.repeat))
const CARD_DEFAULT_PRESET = 'campaign-scorecard'
/** "Add chart" → "Metric card": the button below sets a default preset the owner can then
 * customize (CardEditor's own preset → Customize… flow). */
function makeCardWidget() {
  draft.card = { preset: CARD_DEFAULT_PRESET }
}
function leaveCardMode() {
  draft.card = undefined
}
/** CardEditor needs a non-optional CardRef; the template only mounts it while isCardWidget is
 * true, which is exactly when draft.card is set — the `!` reflects that guarantee. */
const cardModel = computed<import('../lib/metrics/types').CardRef>({
  get: () => draft.card!,
  set: (v) => {
    draft.card = v
  },
})
/** The same page-context shape ChartCard.vue builds for a saved card (lib/metrics/pageContext.ts
 * metricsContextFor) — the widget's own site override if set, else the page's filter bar — so
 * the live preview reads the same window a saved card would. */
const cardContext = computed<MetricsContext>(() => {
  const f = draft.filters ?? props.filters
  if (!f) return {}
  return metricsContextFor({ since: f.since, until: f.until }, resolveSelection(draft.siteSel ?? f.siteSel).tags, f)
})
// CardEditor's own `errors` event (review fix, 2026-09-27): the only way this form learns a
// metric card is currently invalid, since CardEditor's `update:modelValue` simply never fires
// for one — there is no "invalid value" to read back otherwise. Irrelevant, and never set, for
// any non-card widget: `save()` and the Save button below are unaffected for those, exactly as
// before this existed.
const cardErrors = ref<string[]>([])
const cardSaveDisabled = computed(() => isCardWidget.value && cardErrors.value.length > 0)

const typeDef = computed(() => CHART_TYPES.find((t) => t.value === draft.type))
// "Site override" = Widget.siteSel: this chart's own site pick, replacing the page's (dates and
// every other page filter still apply). Best Sudoku is its beacon tags (web + app).
const SITE_OVERRIDES: { value: string; label: string; sel: string[] }[] = [
  { value: 'all', label: 'All sites', sel: [] },
  { value: 'bestsudoku', label: 'Best Sudoku (web + app)', sel: [...BEST_SUDOKU_SITES] },
  { value: 'goodstuff.software', label: 'goodstuff.software (Star Rupture + Simple Tile)', sel: ['goodstuff.software'] },
  { value: 'goodstuffsoftware.com', label: 'goodstuffsoftware.com', sel: ['goodstuffsoftware.com'] },
]
const siteValue = computed({
  get: () => {
    if (!draft.siteSel) return 'inherit'
    const key = JSON.stringify([...draft.siteSel].sort())
    return SITE_OVERRIDES.find((o) => JSON.stringify([...o.sel].sort()) === key)?.value ?? 'custom'
  },
  set: (v: string) => {
    if (v === 'custom') return
    const o = SITE_OVERRIDES.find((x) => x.value === v)
    draft.siteSel = o ? [...o.sel] : undefined
  },
})

function save() {
  if (cardSaveDisabled.value) return // belt and suspenders: the Save button is disabled for this too
  // Freeze whatever the "Captions" checkboxes currently show (scope defaults, or the
  // user's own edit) into draft.notes, so what the editor DISPLAYED is exactly what gets
  // saved — ChartCard.vue only ever reads widget.notes directly, never recomputes scope
  // defaults at render time (see its own comment).
  if (draft.type !== 'note') draft.notes = attachedNotesValue.value
  if (typeDef.value && !typeDef.value.needsDimension) draft.dimension = ''
  if (!breakdownAllowed.value) draft.breakdown = undefined
  if (!isBreakdownLine.value) draft.cumulative = undefined
  if (draft.breakdown === '') draft.breakdown = undefined
  if (!popupNeedsPopup.value) draft.popup = undefined
  if (!popupNeedsKind.value) draft.popupKind = undefined
  if (draft.type !== 'breakdownBar') draft.barMode = undefined
  // Overlays need a date axis; series need a beacon date axis. A series with no label gets one.
  if (!isDateLine.value) {
    draft.markers = undefined
    draft.goLiveMarkers = undefined
    draft.flightBands = undefined
  }
  if (!canUseSeries.value || !draft.series?.length) {
    draft.series = undefined
    draft.axisTitles = undefined
  } else {
    draft.series = draft.series.map((s, i) => ({ ...s, label: s.label.trim() || `Series ${i + 1}` }))
  }
  // Extra rings only make sense for a nested doughnut with a breakdown set; sanitize (drop
  // blanks/duplicates/'date') and clear them entirely otherwise.
  if (draft.type === 'nestedDoughnut' && draft.breakdown) {
    const rings = (draft.rings ?? []).filter(
      (r, i, arr) => r && !isDateDim(r) && r !== draft.dimension && r !== draft.breakdown && arr.indexOf(r) === i,
    )
    draft.rings = rings.length ? rings : undefined
  } else {
    draft.rings = undefined
  }
  // A panel a metric card renders gets (or loses) its card with its view (lib/defaults.ts).
  emit('save', syncCardWithView({ ...draft, i: draft.id }))
}
</script>

<template>
  <div class="overlay" @click.self="emit('cancel')">
    <div class="panel" :class="{ 'is-card': isCardWidget }" ref="panelEl" role="dialog" aria-modal="true" :aria-labelledby="dialogTitleId" @keydown="onDialogKeydown">
      <h2 :id="dialogTitleId">{{ isNew ? 'Add chart' : 'Edit chart' }}</h2>

      <div class="field">
        <label>Title</label>
        <input ref="titleInputEl" type="text" v-model="draft.title" placeholder="Chart title" />
      </div>

      <template v-if="!isCardWidget">
        <div class="field" v-if="!isNote">
          <label>Data source</label>
          <select v-model="draft.dataset" @change="onDatasetChange">
            <option v-for="d in DATASETS" :key="d.value" :value="d.value === 'rum' ? undefined : d.value">{{ d.label }}</option>
          </select>
        </div>

        <div class="row">
          <div class="field">
            <label>Chart type</label>
            <select v-model="draft.type">
              <option v-for="t in CHART_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
          </div>
          <div class="field" v-if="!isGeo && !isPopup && !isBespokeDataset && !isNote">
            <label>Metric</label>
            <select v-model="draft.metric">
              <option v-for="m in METRICS" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
          </div>
        </div>

        <!-- "Add chart" → "Metric card" (ADR 0003, phase B): reusable, configurable stat/table
             cards, distinct from the fixed chart types above — see CardEditor.vue. -->
        <div class="field" v-if="!isNote">
          <button type="button" class="btn" @click="makeCardWidget">Make this a metric card instead</button>
        </div>
      </template>

      <!-- A metric card (ADR 0003, phase B) replaces every chart-only field below it: label/
           data/display per item, sections, live preview — see CardEditor.vue. -->
      <template v-if="isCardWidget">
        <p class="hint">This chart is a metric card.</p>
        <button type="button" class="btn" @click="leaveCardMode">Switch to a regular chart</button>
        <div class="field" v-if="cardSelectsCampaigns">
          <label>Campaign(s) <span class="hint">— none checked = every campaign the card shows</span></label>
          <div class="campaign-list">
            <label v-for="c in CAMPAIGN_OPTIONS" :key="c.value" class="campaign-row">
              <input type="checkbox" :checked="campaignIdsValue.includes(c.value)" @change="toggleCampaign(c.value, ($event.target as HTMLInputElement).checked)" />
              {{ c.label }}
            </label>
          </div>
        </div>
        <CardEditor v-model="cardModel" :context="cardContext" :campaign-ids="cardSelectsCampaigns ? draft.campaignIds : undefined" @errors="cardErrors = $event" />
      </template>

      <!-- Note: pick a registry entry, or write custom text (owner requirement, 2026-09-26:
           every note/caveat/explanatory block goes through the shared registry — see
           lib/notes.ts — with a custom-text escape hatch for anything not worth registering). -->
      <template v-if="isNote">
        <div class="field">
          <label>Source</label>
          <select v-model="isCustomNote">
            <option :value="false">From the notes library</option>
            <option :value="true">Custom text</option>
          </select>
        </div>
        <div class="field" v-if="!isCustomNote">
          <label>Note</label>
          <select v-model="draft.noteId">
            <option v-for="o in NOTE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <div class="field" v-else>
          <label>Note text</label>
          <textarea v-model="draft.note" rows="4" placeholder="Caveat / note shown on the tile — **bold** and [links](https://…) supported" />
        </div>
        <div class="field check">
          <label>
            <input type="checkbox" v-model="draft.longText" />
            Longer text (multi-paragraph, rendered larger)
          </label>
        </div>
      </template>

      <!-- Any OTHER widget: attach registry notes as a caption under the chart. Defaults to
           the dataset's own scope defaults until the user picks their own set. -->
      <div class="field" v-if="!isNote">
        <label>Captions <span class="hint">— shown under the chart; defaults per data source</span></label>
        <div class="campaign-list">
          <label v-for="o in NOTE_OPTIONS" :key="o.value" class="campaign-row">
            <input type="checkbox" :checked="attachedNotesValue.includes(o.value)" @change="toggleAttachedNote(o.value, ($event.target as HTMLInputElement).checked)" />
            {{ o.label }}
          </label>
        </div>
      </div>

      <template v-if="!isCardWidget">
      <!-- Overview / campaigns / ads-readings datasets: a View picker replaces the
           dimension/breakdown/metric/site-override fields below (not applicable to them). -->
      <div class="row" v-if="isBespokeDataset">
        <div class="field">
          <label>View</label>
          <select v-model="draft.view" @change="onDatasetChange">
            <option v-if="isAdsReadingsDataset" value="log">Readings log</option>
            <option v-for="v in viewOptions" :key="v.value" :value="v.value">{{ v.label }}</option>
          </select>
        </div>
      </div>
      <div class="field" v-if="isCampaignsDataset || isAdsReadingsDataset">
        <label>Campaign(s) <span class="hint">— none checked = all</span></label>
        <div class="campaign-list">
          <label v-for="c in CAMPAIGN_OPTIONS" :key="c.value" class="campaign-row">
            <input type="checkbox" :checked="campaignIdsValue.includes(c.value)" @change="toggleCampaign(c.value, ($event.target as HTMLInputElement).checked)" />
            {{ c.label }}
          </label>
        </div>
      </div>

      <div class="row" v-if="typeDef?.needsDimension && !isBespokeDataset && !isNote">
        <div class="field">
          <label>{{ isRate ? 'Rate' : draft.type === 'breakdownBar' ? 'Axis (group by)' : 'Group by' }}</label>
          <select v-model="draft.dimension">
            <option v-for="d in dimOptions" :key="d.key" :value="d.key">{{ d.label }}</option>
          </select>
        </div>
        <div class="field" v-if="breakdownAllowed">
          <label>{{ draft.type === 'breakdownBar' ? 'Series (break down by)' : draft.type === 'line' || draft.type === 'area' ? 'One line per' : 'Break down by' }}</label>
          <select v-model="draft.breakdown">
            <option :value="undefined">— none —</option>
            <option v-for="d in dimOptions" :key="d.key" :value="d.key">{{ d.label }}</option>
          </select>
        </div>
      </div>

      <!-- Line with a breakdown: also each line's running total, dashed on a right-hand axis -->
      <div class="field check" v-if="isBreakdownLine">
        <label><input type="checkbox" :checked="!!draft.cumulative" @change="draft.cumulative = ($event.target as HTMLInputElement).checked || undefined" /> Add cumulative lines (dashed, right axis)</label>
      </div>

      <!-- Breakdown bar: series side by side, or stacked into one bar per axis value -->
      <div class="row" v-if="draft.type === 'breakdownBar'">
        <div class="field">
          <label>Bars</label>
          <select :value="draft.barMode ?? 'grouped'" @change="draft.barMode = ($event.target as HTMLSelectElement).value as 'grouped' | 'stacked'">
            <option v-for="m in BAR_MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select>
        </div>
      </div>

      <!-- Pop-up dataset (count mode): which funnel, and (for reason/date) which stage -->
      <div class="row" v-if="popupNeedsPopup || popupNeedsKind">
        <div class="field" v-if="popupNeedsPopup">
          <label>Pop-up</label>
          <select v-model="draft.popup">
            <option v-for="p in POPUP_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </div>
        <div class="field" v-if="popupNeedsKind">
          <label>Funnel stage</label>
          <select v-model="draft.popupKind">
            <option v-for="k in POPUP_KIND_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</option>
          </select>
        </div>
      </div>

      <!-- Nested doughnut: further outward rings beyond dimension + breakdown (e.g. site →
           device → OS → browser). Each ring subdivides the one before it. -->
      <div class="field" v-if="draft.type === 'nestedDoughnut' && draft.breakdown">
        <label>Extra rings (outward from break-down)</label>
        <div class="rings-list">
          <div v-for="(r, idx) in draft.rings ?? []" :key="idx" class="ring-row">
            <select :value="r" @change="setRing(idx, $event.target.value)">
              <option v-for="d in ringOptionsFor(idx)" :key="d.key" :value="d.key">{{ d.label }}</option>
            </select>
            <button type="button" class="btn ring-btn" title="Move toward center" :disabled="idx === 0" @click="moveRing(idx, -1)">↑</button>
            <button
              type="button"
              class="btn ring-btn"
              title="Move outward"
              :disabled="idx === (draft.rings?.length ?? 0) - 1"
              @click="moveRing(idx, 1)"
            >
              ↓
            </button>
            <button type="button" class="btn ring-btn danger" title="Remove ring" @click="removeRing(idx)">✕</button>
          </div>
          <button type="button" class="btn" :disabled="!canAddRing" @click="addRing">+ Add ring</button>
          <p class="hint" v-if="totalRingCount >= RING_SOFT_CAP">
            {{ totalRingCount }} rings — charts get visually dense much past this.
          </p>
        </div>
      </div>

      <div class="row" v-if="!isBespokeDataset && !isNote">
        <div class="field">
          <label>Limit (top N)</label>
          <input type="number" v-model.number="draft.limit" min="1" max="500" />
        </div>
        <div class="field">
          <label>Site override</label>
          <select v-model="siteValue">
            <option value="inherit">Inherit the page's sites</option>
            <option v-for="o in SITE_OVERRIDES" :key="o.value" :value="o.value">{{ o.label }}</option>
            <option v-if="siteValue === 'custom'" value="custom">Custom ({{ draft.siteSel?.join(', ') }})</option>
          </select>
        </div>
      </div>

      <div class="field check" v-if="draft.dimension === 'refererHost'">
        <label>
          <input type="checkbox" v-model="draft.excludeSelfReferrals" />
          Exclude self-referrals &amp; direct
        </label>
      </div>

      <!-- Geo beacon only: every chart excludes pop-up/install/return/game-complete/auth-status
           event-beacon rows by default (they're events, not screen views) — this opts a single
           chart back in, e.g. to chart the 'pathFamily' dimension or see event paths in a 'path'
           breakdown. Default OFF keeps every existing chart's numbers unchanged. -->
      <div class="field check" v-if="isGeo && !isNote">
        <label>
          <input type="checkbox" v-model="draft.includeEventBeacons" />
          Include event beacons (pop-up / install / return / game-complete / auth-status)
        </label>
        <label>
          <input type="checkbox" :checked="!!draft.excludeKnownTraffic" @change="draft.excludeKnownTraffic = ($event.target as HTMLInputElement).checked || undefined" />
          Hide known test and household traffic
        </label>
      </div>

      <div class="field check" v-if="isDateLine">
        <label>
          <input type="checkbox" :checked="draft.markers === 'releases'" @change="draft.markers = ($event.target as HTMLInputElement).checked ? 'releases' : undefined" />
          Show Best Sudoku release markers
        </label>
        <label>
          <input type="checkbox" :checked="!!draft.goLiveMarkers" @change="draft.goLiveMarkers = ($event.target as HTMLInputElement).checked || undefined" />
          Show go-live markers (tracking starts, new beacons, install fix)
        </label>
        <label>
          <input type="checkbox" :checked="!!draft.flightBands" @change="draft.flightBands = ($event.target as HTMLInputElement).checked || undefined" />
          Show campaign flights as shaded bands
        </label>
      </div>

      <!-- Beacon line chart on dates: draw several series, each narrowed by one filter. -->
      <div class="field" v-if="canUseSeries">
        <label>Series <span class="hint">— none = one line of everything the chart counts</span></label>
        <div class="series-list">
          <div v-for="(s, idx) in draft.series ?? []" :key="idx" class="series-row">
            <input type="text" v-model="s.label" placeholder="Label" aria-label="Series label" />
            <select :value="s.filter?.[0]?.field ?? ''" aria-label="Series filter field" @change="setSeriesFilter(idx, 'field', ($event.target as HTMLSelectElement).value)">
              <option value="">(all page views)</option>
              <option v-for="d in SERIES_FIELDS" :key="d.key" :value="d.key">{{ d.label }}</option>
            </select>
            <input
              v-if="s.filter?.[0]?.field"
              type="text"
              :value="s.filter?.[0]?.value ?? ''"
              placeholder="value"
              aria-label="Series filter value"
              @input="setSeriesFilter(idx, 'value', ($event.target as HTMLInputElement).value)"
            />
            <select v-model="s.axis" aria-label="Axis">
              <option value="left">Left axis</option>
              <option value="right">Right axis</option>
            </select>
            <select v-model="s.style" aria-label="Line style">
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
            </select>
            <button type="button" class="btn ring-btn danger" title="Remove series" @click="removeSeries(idx)">✕</button>
          </div>
          <button type="button" class="btn" @click="addSeries">+ Add series</button>
        </div>
      </div>
      <div class="row" v-if="canUseSeries && draft.series?.length">
        <div class="field">
          <label>Left axis title</label>
          <input type="text" :value="axisTitlesValue('left')" @input="setAxisTitle('left', ($event.target as HTMLInputElement).value)" />
        </div>
        <div class="field">
          <label>Right axis title</label>
          <input type="text" :value="axisTitlesValue('right')" @input="setAxisTitle('right', ($event.target as HTMLInputElement).value)" />
        </div>
      </div>
      </template>

      <p v-if="cardSaveDisabled" class="hint save-reason" role="alert">Fix the highlighted fields to save.</p>
      <div class="actions">
        <button v-if="!isNew" class="btn danger" @click="emit('remove')">Delete</button>
        <span class="spacer"></span>
        <button class="btn" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-primary" :disabled="cardSaveDisabled" :title="cardSaveDisabled ? 'Fix the highlighted fields to save.' : ''" @click="save">{{ isNew ? 'Add chart' : 'Save' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.series-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.series-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 6px;
  align-items: center;
  padding: 8px;
  border: 1px solid rgb(var(--line));
  border-radius: 10px;
}
/* label on its own row (with the remove button), then field + value, then axis + style */
.series-row > input:first-child {
  grid-column: 1 / 3;
}
.series-row > button {
  grid-column: 3;
  grid-row: 1;
}
.series-row input,
.series-row select {
  min-width: 0;
  width: 100%;
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 20px;
  /* A tall panel (a metric card with several sections) can exceed the viewport even on
     desktop; without this, flex's vertical centering pushes its TOP out of reach with no way
     to scroll back up to it (review fix, 2026-09-27 — the mobile version of this is the
     dedicated sheet rule below, which removes centering outright). */
  overflow-y: auto;
}
.panel {
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 16px;
  padding: 22px 24px 20px;
  width: 100%;
  max-width: 460px;
  box-shadow: 0 20px 60px rgb(0 0 0 / 0.25);
  /* Never itself the scroll container at desktop (.overlay is, above) — margin:auto on a flex
     item keeps it centered when it's short AND fully reachable by scroll when it's tall. */
  margin: auto;
}
/* A metric card (ADR 0003, phase B): CardEditor wants real width for its two-column live
   preview (its own .ce-root goes up to 900px) — the plain chart panel's 460px would otherwise
   squeeze it into one cramped column. */
.panel.is-card {
  max-width: 960px;
}
h2 {
  font-size: 18px;
  margin-bottom: 16px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
  flex: 1;
}
.field input,
.field select,
.field textarea {
  width: 100%;
}
.field textarea {
  font-family: inherit;
  resize: vertical;
}
/* A checkbox keeps its own size, directly left of its label text (the full-width rule above
   stretched it and pushed the text far to the right); the whole label stays the click target. */
.field input[type='checkbox'] {
  width: auto;
  flex: none;
  margin: 0;
}
.field.check label,
.campaign-row {
  justify-content: flex-start;
  text-align: left;
}
.campaign-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
  border: 1px solid rgb(var(--line));
  border-radius: 8px;
  padding: 6px 8px;
}
.campaign-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  cursor: pointer;
}
.row {
  display: flex;
  gap: 12px;
}
.field.check label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.rings-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ring-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ring-row select {
  flex: 1;
  width: auto;
}
.ring-btn {
  flex-shrink: 0;
  padding: 6px 9px;
  line-height: 1;
}
.ring-btn.danger {
  color: #bc4749;
  border-color: rgb(188 71 73 / 0.4);
}
.hint {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.save-reason {
  color: #bc4749;
  margin-top: 8px;
  margin-bottom: 0;
}
.btn-primary:disabled {
  background: rgb(var(--line-2));
  border-color: rgb(var(--line-2));
  color: rgb(var(--ink-3));
  cursor: not-allowed;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
}
.spacer {
  flex: 1;
}
.btn.danger {
  color: #bc4749;
  border-color: rgb(188 71 73 / 0.4);
}
.btn.danger:hover {
  border-color: #bc4749;
  background: rgb(188 71 73 / 0.06);
}

/* Full-screen sheet at phone width (review fix, 2026-09-27 — matches the app's own mobile
   breakpoint, lib/responsive.ts MOBILE_MAX_WIDTH, and CardEditor.vue's own). Before this rule,
   .overlay's flex centering (align-items: center) plus an unbounded .panel meant a tall panel —
   any metric card with a couple of sections easily exceeds a phone's viewport height — had its
   TOP pushed above y=0 with nothing to scroll: the "editor fields must be at the top" state was
   unreachable, and whatever landed mid-panel at natural center (often the live preview, well
   below the actual top of the content) was the first thing visible. Removing the centering and
   making .panel itself the one full-height, top-anchored scroll container fixes both: the DOM's
   own order (Title → fields → CardEditor's own controls-then-preview columns, now stacked) is
   what's on screen, and a freshly mounted element starts at scrollTop 0 — no extra JS needed to
   "scroll to the top on open". */
@media (max-width: 700px) {
  .overlay {
    align-items: stretch;
    justify-content: stretch;
    padding: 0;
  }
  .panel,
  .panel.is-card {
    max-width: none;
    width: 100%;
    height: 100%;
    max-height: none;
    border-radius: 0;
    border: none;
    box-shadow: none;
    margin: 0;
    overflow-y: auto;
  }
}
</style>
