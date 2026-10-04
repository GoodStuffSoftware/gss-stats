<script setup lang="ts">
import { reactive, computed, watch, onMounted, onBeforeUnmount, ref, useId } from 'vue'
import type { Widget, LineSeries, GlobalFilters, StatsResponse } from '../types'
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
import { BEST_SUDOKU_SITES, CAPTION_MAX_CHARS, HIDDEN_CAVEATS_MAX, HIDDEN_CAVEAT_ID_RE, syncCardWithView } from '../lib/defaults'
import { getNote, isStaticCaptionNote, libraryCaptionOptions, noteRawText, noteTemplate } from '../lib/notes'
import { allChartNotes, canHideCaveatId, convertLegacyNotes, isChartNoteHidden, type ChartNote } from '../lib/chartNotes'
import { toPlainText, VALUE_TOKEN_RE } from '../lib/textLite'
import { chartValueResolver, VALUE_TOKEN_OPTIONS } from '../lib/valueTokens'
import { canFit, setFit } from '../lib/fit'
import { rendersOwnBody } from '../lib/charts'
import CardEditor from './metrics/CardEditor.vue'
import { metricsContextFor } from '../lib/metrics/pageContext'
import { presetById } from '../lib/metrics/presets'
import { ADS_READINGS_LOG_PRESET } from '../lib/metrics/readingsCard'
import { selectsCampaigns } from '../lib/metrics/scope'
import { resolveSelection } from '../sitesStore'
import type { MetricsContext } from '../lib/metrics/types'

// `filters` is the page's main filter bar (App.vue's `activePage.filters`) — used ONLY to build
// the metric-card preview's context (the same range/sites a saved card would read); every other
// field here is unaffected by it, same as before this prop existed.
// `filters` is optional defensively (a caller that hasn't wired it yet still gets a working
// editor — the card preview just has no page range for a `window: 'page'` item until it does).
// `data`/`error` (optional) are the chart's current response, for the "Data caveats" list: a
// runtime caveat (a pop-up note, a split guard, …) is only listed while the response carries it.
// Without them the list still shows the legacy caption ids and every id this chart hides.
const props = defineProps<{ widget: Widget; isNew: boolean; filters?: GlobalFilters; data?: StatsResponse | null; error?: string | null }>()
const emit = defineEmits<{ save: [Widget]; cancel: []; remove: [] }>()

// Series/axis titles and the note-id lists are nested: copy them, so Cancel leaves the saved
// widget untouched. The legacy caption ids are folded into the caption text on open (D5,
// foldLegacyNotes below).
const copyWidget = (w: Widget): Widget => {
  const c: Widget = {
    ...w,
    series: w.series?.map((x) => ({ ...x, filter: x.filter?.map((f) => ({ ...f })) })),
    axisTitles: w.axisTitles ? { ...w.axisTitles } : undefined,
  }
  if (w.notes) c.notes = [...w.notes]
  if (w.hiddenCaveats) c.hiddenCaveats = [...w.hiddenCaveats]
  return c
}
const draft = reactive<Widget>(copyWidget(props.widget))
/** D5 convert-on-edit (lib/chartNotes.ts convertLegacyNotes), applied to the draft: the author
 * sees the folded text in the Caption box; Save keeps it, Cancel leaves the chart as it was.
 * A folded id also leaves `hiddenCaveats` (NIT-5b): nothing lists it any more, so keeping it would
 * only leave a dead "hidden" row. One the card's own spec captions still name stays (they share the
 * list, D7). Returns the converted ids (for the hint under the Caption box). */
function foldLegacyNotes(): string[] {
  const { widget: next, converted } = convertLegacyNotes({ ...draft })
  if (!converted.length) return converted
  if (next.caption === undefined) delete draft.caption
  else draft.caption = next.caption
  if (next.notes === undefined) delete draft.notes
  else draft.notes = next.notes
  if (draft.hiddenCaveats) {
    const spec = draft.card ? ('preset' in draft.card ? presetById(draft.card.preset) : draft.card.spec) : undefined
    const stillNamed = new Set(spec?.captions ?? [])
    const folded = new Set(converted.filter((id) => !stillNamed.has(id)))
    setHiddenCaveats(draft.hiddenCaveats.filter((id) => !folded.has(id)))
  }
  return converted
}
const convertedNoteIds = ref<string[]>(foldLegacyNotes())
watch(
  () => props.widget,
  (w) => {
    // Replace, not merge: a key the new widget lacks (a cleared `fit`) must not survive in the draft.
    const next = copyWidget(w)
    for (const k of Object.keys(draft)) if (!(k in next)) delete (draft as unknown as Record<string, unknown>)[k]
    Object.assign(draft, next)
    convertedNoteIds.value = foldLegacyNotes()
  },
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

// ── Text on a chart (notes plan, slice 1c). Every chart: the author's own Caption (plain text,
// textLite markup, `{=…}` value tokens) and a "Data caveats" list of the system's notes, each
// with a Show/Hide toggle that writes `hiddenCaveats`. A note widget: its own text. "Insert from
// library" copies a static registry caption's TEXT into either box; library entries stay
// read-only, and a chart never references them by id again (`notes` is legacy, D5). ──────────
const LIBRARY_OPTIONS = libraryCaptionOptions()
const captionFieldId = useId()
const noteTextFieldId = useId()
const captionValue = computed<string>({
  get: () => draft.caption ?? '',
  set: (v: string) => {
    if (v) draft.caption = v
    else delete draft.caption
  },
})
/** Where the cursor was when a text box last lost focus (picking from the library menu blurs
 * it). null = never focused: an insert then appends, after a blank line. */
type TextTarget = 'caption' | 'note'
const caret: Record<TextTarget, { start: number; end: number } | null> = { caption: null, note: null }
function rememberCaret(t: TextTarget, e: Event) {
  const el = e.target as HTMLTextAreaElement
  const start = el.selectionStart ?? 0
  caret[t] = { start, end: el.selectionEnd ?? start }
}
/** Where each `{=…}` value token in `text` starts and ends. */
function valueTokenSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(VALUE_TOKEN_RE)].map((m) => [m.index, m.index + m[0].length])
}
/** The caret, with each end that falls inside a value token moved to that token's end, so an
 * insert never splits one (review N5). */
function caretOutsideTokens(text: string, at: { start: number; end: number }): { start: number; end: number } {
  const spans = valueTokenSpans(text)
  const snap = (pos: number) => spans.find(([a, b]) => a < pos && pos < b)?.[1] ?? pos
  const start = snap(at.start)
  return { start, end: Math.max(start, snap(at.end)) }
}
/** `text` cut to `max` characters, and further back to before a value token the cut would split
 * (review N6): a caption never keeps half a token. */
function cutOutsideTokens(text: string, max: number): string {
  if (text.length <= max) return text
  const split = valueTokenSpans(text).find(([a, b]) => a < max && b > max)
  return text.slice(0, split ? split[0] : max)
}
/** "Caption is full": a value or library text did not fit whole under CAPTION_MAX_CHARS (review
 * N4). Announced politely; the next edit of the caption (typing, or another insert) clears it. Each
 * refusal re-keys the message node, so a second refusal in a row is announced again (NIT-3). */
const captionFull = ref(false)
const captionFullTick = ref(0)
function sayCaptionFull() {
  captionFull.value = true
  captionFullTick.value++
}
function insertFromLibrary(t: TextTarget, e: Event) {
  const sel = e.target as HTMLSelectElement
  const id = sel.value
  sel.value = ''
  const text = id ? noteTemplate(id).trim() : ''
  if (!text) return
  if (t === 'caption') captionFull.value = false
  const cur = (t === 'caption' ? draft.caption : draft.note) ?? ''
  const at = t === 'caption' && caret[t] ? caretOutsideTokens(cur, caret[t]) : caret[t]
  let next: string
  let end: number
  if (at && at.start <= cur.length) {
    next = cur.slice(0, at.start) + text + cur.slice(Math.max(at.start, Math.min(at.end, cur.length)))
    end = at.start + text.length
  } else {
    const head = cur.trimEnd()
    next = head ? `${head}\n\n${text}` : text
    end = next.length
  }
  if (t === 'caption') {
    const whole = next
    next = cutOutsideTokens(whole, CAPTION_MAX_CHARS)
    captionValue.value = next
    if (next.length < whole.length) sayCaptionFull()
  } else {
    draft.note = next
  }
  end = Math.min(end, next.length)
  caret[t] = { start: end, end }
}

// ── "Insert value ▾" (notes plan, slice 1d release 1): puts a `{=…}` value token (grammar:
// lib/valueTokens.ts) into the caption at the cursor, replacing any selection; a box never focused
// gets it appended. Each option shows what it reads right now, from the response already loaded
// (no fetch). A token that would not fit whole under CAPTION_MAX_CHARS is not inserted, and the
// box says the caption is full. A widget that renders its own body (a metric card, overview,
// campaigns, ads-readings, a pop-up rate tile, a note: lib/charts.ts rendersOwnBody, the test ChartCard skips its fetch on)
// loads no response a chart value could read, so it gets the Dates group only (review N2, NIT-1).
const VALUE_GROUPS = ['This chart', 'Dates'] as const
const valueOptions = computed(() => {
  const resolve = chartValueResolver(props.widget, props.data ?? null, props.error ?? null)
  const groups = VALUE_GROUPS.filter((g) => g !== 'This chart' || !rendersOwnBody(draft))
  return groups.map((group) => ({
    group,
    options: VALUE_TOKEN_OPTIONS.filter((o) => o.group === group).map((o) => {
      const now = resolve(o.token)
      return { token: o.token, label: now ? `${o.label} (${now})` : o.label }
    }),
  }))
})
function insertValue(e: Event) {
  const sel = e.target as HTMLSelectElement
  const token = sel.value
  sel.value = ''
  if (!token) return
  captionFull.value = false
  const cur = draft.caption ?? ''
  const at = caret.caption && caretOutsideTokens(cur, caret.caption)
  let next: string
  let end: number
  if (at && at.start <= cur.length) {
    next = cur.slice(0, at.start) + token + cur.slice(Math.max(at.start, Math.min(at.end, cur.length)))
    end = at.start + token.length
  } else {
    next = cur && !/\s$/.test(cur) ? `${cur} ${token}` : cur + token
    end = next.length
  }
  if (next.length > CAPTION_MAX_CHARS) {
    sayCaptionFull()
    return
  }
  captionValue.value = next
  caret.caption = { start: end, end }
}

// The "Data caveats" rows: allChartNotes minus the caption itself, plus any id this chart hides
// that the list cannot see right now (a runtime note with no response loaded), so it can be shown
// again. An id the list could never hide (a `hideable: false` registry note, an always-shown runtime
// note) gets no such row: the chart shows it whenever it applies, whatever the list says (NIT-5a).
// A card's own spec captions are toggled in CardEditor, not here.
interface CaveatRow {
  key: string
  label: string
  hideable: boolean
  hideId?: string
  hidden: boolean
  unknownId?: string
}
const RUNTIME_NOTE_LABELS: Record<string, string> = { 'popup-note': 'Pop-up note (from the data)' }
const short = (t: string) => (t.length > 90 ? t.slice(0, 87) + '…' : t)
function noteLabel(n: ChartNote): string {
  if (n.text) return short(toPlainText(n.text))
  return short(n.noteId ? noteRawText(n.noteId) || n.noteId : n.key)
}
const caveatRows = computed<CaveatRow[]>(() => {
  const hidden = draft.hiddenCaveats ?? []
  const rows: CaveatRow[] = allChartNotes(draft, props.data, props.error)
    .filter((n) => n.key !== 'caption')
    .map((n) => ({
      key: n.key,
      label: n.unknown ? `Unknown note ${n.noteId}` : noteLabel(n),
      hideable: n.hideable,
      hideId: n.hideId,
      hidden: isChartNoteHidden(n, hidden),
      ...(n.unknown ? { unknownId: n.noteId } : {}),
    }))
  const listed = new Set(rows.map((r) => r.hideId))
  // A rate tile loads no response (rendersOwnBody), so the runtime pop-up note never lists itself,
  // yet the card shows its install-fix note by default: always offer the Show/Hide row (F1).
  if (draft.type === 'rate' && !listed.has('popup-note')) {
    rows.push({ key: 'runtime:popup-note', label: RUNTIME_NOTE_LABELS['popup-note'], hideable: true, hideId: 'popup-note', hidden: hidden.includes('popup-note') })
    listed.add('popup-note')
  }
  const specCaptions = new Set(cardSpec.value?.captions ?? [])
  for (const id of hidden) {
    if (listed.has(id) || specCaptions.has(id) || !canHideCaveatId(id)) continue
    const label = getNote(id) ? noteRawText(id) || id : (RUNTIME_NOTE_LABELS[id] ?? id)
    rows.push({ key: `hidden:${id}`, label: short(label), hideable: true, hideId: id, hidden: true })
  }
  return rows
})
/** Writes `hiddenCaveats`; an empty list deletes the key. Also takes CardEditor's
 * `update:hidden-captions` (a card's spec captions share the list, D7). Keeps only ids the stored
 * list can hold (HIDDEN_CAVEAT_ID_RE, NIT-4), deduped, at most HIDDEN_CAVEATS_MAX, so what the
 * editor shows is what reloads. */
function setHiddenCaveats(ids: readonly string[] | undefined) {
  const keep = [...new Set((ids ?? []).filter((id) => HIDDEN_CAVEAT_ID_RE.test(id)))].slice(0, HIDDEN_CAVEATS_MAX)
  if (keep.length) draft.hiddenCaveats = keep
  else delete draft.hiddenCaveats
}
function setCaveatHidden(id: string, hide: boolean) {
  const set = new Set(draft.hiddenCaveats ?? [])
  if (hide) set.add(id)
  else set.delete(id)
  setHiddenCaveats([...set])
}
/** N1: drop a legacy caption id the registry does not know; `notes` goes once empty. */
function removeUnknownNote(id: string) {
  const rest = (draft.notes ?? []).filter((x) => x !== id)
  if (rest.length) draft.notes = rest
  else delete draft.notes
}

// A note widget with a legacy library `noteId` still renders that entry (NoteWidgetBody). A static
// entry can be turned into editable text; a caveat (it follows the data) or an unknown id can be
// replaced with the author's own text.
const noteIdKnown = computed(() => !!draft.noteId && !!getNote(draft.noteId))
const noteIdPreview = computed(() => (draft.noteId ? short(noteRawText(draft.noteId)) : ''))
const noteIdEditable = computed(() => !!draft.noteId && isStaticCaptionNote(draft.noteId))
function noteIdToText() {
  if (!draft.noteId) return
  if (isStaticCaptionNote(draft.noteId)) draft.note = noteTemplate(draft.noteId).trim()
  draft.noteId = undefined
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
    // The readings log is a metric card now (ADR 0005): a new "Ads readings" chart starts as the
    // preset card, so CardEditor and the campaign picker open. Existing widgets are not converted
    // here — ChartCard maps them at render time (lib/metrics/readingsCard.ts).
    if (isAdsReadingsDataset.value && !draft.card) draft.card = { preset: ADS_READINGS_LOG_PRESET }
    return
  }
  // Moving off Ads readings drops the readings preset card that came with it.
  if (draft.card && 'preset' in draft.card && draft.card.preset === ADS_READINGS_LOG_PRESET) draft.card = undefined
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
      // `notes` is kept: a note widget never shows it, and an unknown legacy id must not vanish
      // without the author removing it (N1). save() drops the chart-only caption fields.
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

// Fit-to-content height (lib/fit.ts): offered for any widget that does not hold a canvas (a chart
// or the map). The checkbox sets `fit: 'content'` or removes the key; a widget switched to a
// canvas type has it cleared on save.
const fitAvailable = computed(() => canFit(draft))
const fitValue = computed<boolean>({
  get: () => draft.fit === 'content',
  set: (on) => setFit(draft, on),
})

function save() {
  if (cardSaveDisabled.value) return // belt and suspenders: the Save button is disabled for this too
  // Text on the chart (slice 1c). A blank caption, an empty hidden list and an empty legacy
  // `notes` list are deleted, never saved as '' or []. A note widget is its own text: the
  // chart-only caption fields go. `notes` is never written, only folded (D5) or emptied (N1).
  foldLegacyNotes() // a no-op unless the type changed from note to a chart in this session
  if (draft.type === 'note') {
    delete draft.caption
    delete draft.hiddenCaveats
  } else {
    const caption = draft.caption?.trim()
    if (caption) draft.caption = caption.slice(0, CAPTION_MAX_CHARS)
    else delete draft.caption
    setHiddenCaveats(draft.hiddenCaveats)
  }
  if (!draft.notes?.length) delete draft.notes
  if (typeDef.value && !typeDef.value.needsDimension) draft.dimension = ''
  if (!breakdownAllowed.value) draft.breakdown = undefined
  if (!isBreakdownLine.value) draft.cumulative = undefined
  if (draft.breakdown === '') draft.breakdown = undefined
  if (!popupNeedsPopup.value) draft.popup = undefined
  if (!popupNeedsKind.value) draft.popupKind = undefined
  if (draft.type !== 'breakdownBar') draft.barMode = undefined
  setFit(draft, draft.fit === 'content') // clears it for a widget that cannot fit (a canvas)
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
        <CardEditor
          v-model="cardModel"
          :context="cardContext"
          :campaign-ids="cardSelectsCampaigns ? draft.campaignIds : undefined"
          :hidden-captions="draft.hiddenCaveats"
          @update:hidden-captions="setHiddenCaveats($event)"
          @errors="cardErrors = $event"
        />
      </template>

      <!-- Note widget: its own text, written here (notes plan, slice 1c). "Insert from library"
           copies a static registry entry's text in; the entry itself stays read-only. A legacy
           `noteId` still renders that entry (NoteWidgetBody.vue) until it is turned into text. -->
      <template v-if="isNote">
        <div class="field library-note" v-if="draft.noteId">
          <label>Note</label>
          <p v-if="noteIdKnown" class="hint">From the notes library: {{ noteIdPreview }}</p>
          <p v-else class="hint">Unknown library note {{ draft.noteId }}: it shows nothing.</p>
          <p v-if="noteIdKnown && !noteIdEditable" class="hint">It follows the data, so it updates by itself.</p>
          <div>
            <button type="button" class="btn note-to-text" @click="noteIdToText">{{ noteIdEditable ? 'Edit as text' : 'Replace with my own text' }}</button>
          </div>
        </div>
        <div class="field note-text" v-else>
          <label :for="noteTextFieldId">Note text</label>
          <textarea :id="noteTextFieldId" v-model="draft.note" rows="4" placeholder="Caveat / note shown on the tile" @blur="rememberCaret('note', $event)" />
          <select class="insert-library" aria-label="Insert from library" @change="insertFromLibrary('note', $event)">
            <option value="">Insert from library…</option>
            <option v-for="o in LIBRARY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <p class="hint">**bold** and [links](https://…) work; a blank line starts a new paragraph.</p>
        </div>
        <div class="field check">
          <label>
            <input type="checkbox" v-model="draft.longText" />
            Longer text (multi-paragraph, rendered larger)
          </label>
        </div>
      </template>

      <!-- Any OTHER widget: the author's caption, then the data caveats (lib/chartNotes.ts), all
           shown under the chart in that order. -->
      <template v-if="!isNote">
        <div class="field caption-field">
          <label :for="captionFieldId">Caption <span class="hint">— shown under the chart</span></label>
          <textarea :id="captionFieldId" v-model="captionValue" rows="3" :maxlength="CAPTION_MAX_CHARS" @blur="rememberCaret('caption', $event)" @input="captionFull = false" />
          <div class="caption-tools">
            <select class="insert-library" aria-label="Insert from library" @change="insertFromLibrary('caption', $event)">
              <option value="">Insert from library…</option>
              <option v-for="o in LIBRARY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <select class="insert-value" aria-label="Insert value" @change="insertValue">
              <option value="">Insert value ▾</option>
              <optgroup v-for="g in valueOptions" :key="g.group" :label="g.group">
                <option v-for="o in g.options" :key="o.token" :value="o.token">{{ o.label }}</option>
              </optgroup>
            </select>
            <span class="hint caption-count">{{ captionValue.length }} / {{ CAPTION_MAX_CHARS }}</span>
            <span class="hint caption-full" aria-live="polite"><span v-if="captionFull" :key="captionFullTick">Caption is full</span></span>
          </div>
          <p class="hint">**bold** and [links](https://…) work; a blank line starts a new paragraph. Insert value adds a live number or date, such as {=chart.total|number}; it shows "—" when there is no value for it.</p>
          <p v-if="convertedNoteIds.length" class="hint caption-converted">The library captions this chart had are now part of its caption text. Save keeps that; Cancel leaves the chart as it was.</p>
        </div>
        <div class="field data-caveats">
          <label>Data caveats <span class="hint">— notes the data brings with it</span></label>
          <p v-if="!caveatRows.length" class="hint">None for this chart right now.</p>
          <ul v-else class="caveat-list">
            <li v-for="row in caveatRows" :key="row.key" class="caveat-row" :data-key="row.key">
              <template v-if="row.unknownId">
                <span class="caveat-label">{{ row.label }}</span>
                <button type="button" class="btn caveat-remove" @click="removeUnknownNote(row.unknownId)">Remove</button>
              </template>
              <template v-else>
                <label class="caveat-toggle">
                  <input type="checkbox" :checked="!row.hidden" :disabled="!row.hideable" @change="row.hideId && setCaveatHidden(row.hideId, !($event.target as HTMLInputElement).checked)" />
                  Show
                </label>
                <span class="caveat-label">{{ row.label }}</span>
                <span v-if="!row.hideable" class="hint caveat-why">always shown: affects what the data means</span>
              </template>
            </li>
          </ul>
        </div>
      </template>

      <!-- Height: fixed by the dashboard layout (resize from the corner), or fit to the content. -->
      <div class="field check" v-if="fitAvailable">
        <label>
          <input type="checkbox" v-model="fitValue" />
          Fit height to content <span class="hint">— the panel grows or shrinks with what it shows; the resize corner is hidden</span>
        </label>
      </div>

      <template v-if="!isCardWidget">
      <!-- Overview / campaigns / ads-readings datasets: a View picker replaces the
           dimension/breakdown/metric/site-override fields below (not applicable to them). -->
      <div class="row" v-if="isBespokeDataset && viewOptions.length">
        <div class="field">
          <label>View</label>
          <select v-model="draft.view" @change="onDatasetChange">
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
            <select :value="r" @change="setRing(idx, ($event.target as HTMLSelectElement).value)">
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
.caption-tools {
  display: flex;
  align-items: center;
  gap: 10px;
}
.caption-tools select {
  flex: 1;
  width: auto;
}
.caption-count {
  flex: none;
}
.caveat-list {
  list-style: none;
  margin: 0;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid rgb(var(--line));
  border-radius: 8px;
}
.caveat-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 12.5px;
}
.caveat-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  cursor: pointer;
}
.caveat-label {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.caveat-remove {
  flex: none;
  padding: 4px 9px;
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
