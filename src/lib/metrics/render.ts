// itemViewModel (ADR 0003 section 1, "Rendering"): a pure function from (item, its resolved
// value, its scope) to what a MetricItem should show — label tokens, the formatted value,
// delta lines, a caption, and whether the item is visible at all. Kept out of the .vue files
// so every display kind and every status × gating combination is a table test, no mounting
// required.
//
// Status handling (ADR "Instrumentation windows and go-live gating", "MIN_COHORT, n/d..."):
//   ok / partial     format normally; a caption carries the server's noteIds (install-fix,
//                    counted-from, still-arriving) plus the item's own caption.
//   too-few          "too few to report" — percent/counts still show (n/d): the whole point
//                    of MIN_COHORT gating is that the reader can see WHY.
//   no-data          Gating.whenEmpty ('dash' default | 'omit' | a note).
//   unmeasured       Gating.whenUnmeasured ('auto' default: omit for a closed campaign, else
//                    the registry's "not yet tracking" label | 'omit' | 'label').
//   error            an em dash; the item's own caption still renders if set.
import { getNote, NOTES_REGISTRY, noteRawText, noteTokens } from '../notes'
import { etDateFromMs } from '../popupEvents'
import { relativeTime } from '../adsFreshness'
import { etDateTimeText } from '../adsReadingsFormat'
import { tokenizeAndInterpolate, type TextToken } from '../textLite'
import { METRICS, rulesOf, type MetricDef } from './metrics'
import { RATIOS, type RatioDef } from './ratios'
import { campaignOfScope, configRuling, resolveBinding, scopeField, scopeVars, unmeasuredByConfig, type ScopeInstance } from './scope'
import type { Display, Gating, Label, MetricItem, MetricValue, SeriesPoint } from './types'
import { unitLabelId } from './units'

// A note id ever reaches here from data an author saved into a CardSpec (Label's `note`,
// Gating.whenEmpty's `note`) or that the server echoed back (MetricValue.noteIds) — never a
// literal this module wrote itself. NOTES_REGISTRY is an ordinary object literal, so a bracket
// lookup for an id like 'constructor' or '__proto__' resolves through Object.prototype instead
// of coming back undefined (review finding, 2026-09-27) — `getNote`'s own `!n` truthiness check
// doesn't catch that (a Function is truthy). validateCard checks a note id's shape only, never
// whether this build knows it (an older tab keeps ids a newer build wrote), so this checks the
// registry's OWN property: an unknown id, prototype-named or not, renders as nothing instead of
// crashing (`resolveText` calling `.text` on a Function, or a token walk over its `undefined`
// result).
function hasNote(id: string): boolean {
  return Object.hasOwn(NOTES_REGISTRY, id)
}

export interface DeltaLine {
  text: string
  cls: '' | 'up' | 'down' | 'new'
}

export interface ItemViewModel {
  visible: boolean
  labelTokens: TextToken[]
  primary: string
  deltaLines: DeltaLine[]
  captionTokens: TextToken[]
  badgeTone?: 'neutral' | 'live' | 'warn'
  /** The primary is a status word ("not yet tracking", "unavailable"), not a value: render it
   * small. */
  muted?: boolean
  /** A percent's two parts, for a tile: the rate big, its "(n/d)" as a small line under it.
   * Rows and pills show `primary`, which is the two joined. */
  split?: { main: string; sub: string }
  /** The value failed to load (the server's per-request error, or the batch failed). */
  error?: boolean
  /** A 'bar' display's length: the count, or the rate as a fraction. */
  barValue?: number
  /** A 'sparkline' display's per-ET-day points (oldest first), when the server returned any. */
  series?: readonly SeriesPoint[]
}

export interface ItemViewOptions {
  todayEt: string
  /** "Now" for a relative time ('ago'); the real clock when absent. */
  nowMs?: number
}

// ── Label resolution (ADR section 1, "Labels") ────────────────────────────────────────────
export function resolveLabelTokens(label: Label, scope: ScopeInstance, metricLabelId: string | undefined, todayEt: string): TextToken[] {
  if (typeof label === 'string') return tokenizeAndInterpolate(label, scopeVars(scope, todayEt))
  if ('note' in label) {
    // An id this build's registry doesn't know (a newer build's, or a retired one) is stored
    // as-is (validateCard checks only its shape) and shows nothing — never the raw id.
    if (!hasNote(label.note)) return []
    const vars: Record<string, string> = {}
    if (label.vars) for (const [k, path] of Object.entries(label.vars)) vars[k] = scopeField(scope, path, todayEt) ?? ''
    return noteTokens(label.note, vars)
  }
  if ('bind' in label) {
    const v = scopeField(scope, label.bind, todayEt)
    return v ? [{ type: 'text', value: v }] : []
  }
  // { metric: true } — the data binding's own registry label; nothing to show without one.
  return metricLabelId ? noteTokens(metricLabelId) : []
}

// ── Plain-value formatting (parallels lib/kpiFormat.ts's fmtCount/money/pct, kept separate:
// this module has no dependency on the Overview-specific Delta/gating types). ──────────────
// Every formatter takes wire data: anything but a finite number (null, NaN, ±Infinity, a
// string that slipped through) renders as a dash — never "NaN", "$Infinity" or "NaN%".
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
function fmtCount(n: number | null | undefined): string {
  return finite(n) ? n.toLocaleString('en-US') : '—'
}
function fmtMoney(n: number | null | undefined): string {
  return finite(n) ? `$${n.toFixed(2)}` : '—'
}
/** Decimals for a percent: an integer 0-4 (validateCard enforces it; a hand-edited saved card
 * is clamped here, so toFixed can never throw a RangeError). */
export function percentDecimals(d: unknown): number {
  return typeof d === 'number' && Number.isFinite(d) ? Math.min(4, Math.max(0, Math.trunc(d))) : 1
}
function fmtPercent(fraction: number | null | undefined, decimals: number): string {
  return finite(fraction) ? `${(fraction * 100).toFixed(percentDecimals(decimals))}%` : '—'
}
/** A percent's " (n/d)": always shown when either side came back, a missing or non-finite
 * side as "?"; empty only when the server sent neither. */
function ndSuffix(value: MetricValue): string {
  if (value.numerator == null && value.denominator == null) return ''
  const side = (n: unknown) => (finite(n) ? String(n) : '?')
  return ` (${side(value.numerator)}/${side(value.denominator)})`
}
function unitWord(def: MetricDef): string {
  return noteRawText(def.unitLabel ?? unitLabelId(def.unit))
}
function deltaText(d: { delta: number; deltaPct?: number | null }): string {
  const rounded = Math.round(d.delta)
  const sign = rounded > 0 ? '+' : ''
  const pctPart = typeof d.deltaPct !== 'number' || !Number.isFinite(d.deltaPct) ? '' : ` (${d.delta > 0 ? '+' : ''}${(d.deltaPct * 100).toFixed(0)}%)`
  return `${sign}${rounded.toLocaleString('en-US')}${pctPart}`
}
/** A daily average for the whole-day line: a whole number from 10 up, one decimal below. */
function fmtDailyAvg(n: number): string {
  const tenth = Math.round(n * 10) / 10
  return tenth >= 10 ? fmtCount(Math.round(n)) : tenth.toFixed(1)
}
/** The whole-day context line of a metric that can count a refused row (MetricValue.wholeDays):
 * one neutral line — no arrow, no percent — with only the parts the item asked for and the
 * server returned. A non-finite part is absent. */
function wholeDayLine(value: MetricValue, deltas: readonly ('yesterday' | 'avg7')[]): DeltaLine[] {
  const w = value.wholeDays
  if (!w) return []
  const parts: string[] = []
  if (deltas.includes('yesterday') && finite(w.yesterday)) parts.push(`Yesterday ${fmtCount(w.yesterday)}`)
  if (deltas.includes('avg7') && finite(w.avg7)) parts.push(`7-day avg ${fmtDailyAvg(w.avg7)}/day`)
  return parts.length ? [{ text: parts.join(' · '), cls: '' }] : []
}
function deltaLinesFor(value: MetricValue, deltas: readonly ('yesterday' | 'avg7')[] | undefined): DeltaLine[] {
  if (!deltas?.length) return []
  if (value.wholeDays) return wholeDayLine(value, deltas)
  if (!value.deltas) return []
  const out: DeltaLine[] = []
  for (const name of deltas) {
    const d = value.deltas[name]
    // A non-finite delta (today N over a zero day) arrives as null after JSON; so can a
    // malformed one. Either way it is absent: no line, no up/down styling.
    if (!d || typeof d.delta !== 'number' || !Number.isFinite(d.delta)) continue
    out.push({ text: `${name === 'yesterday' ? 'vs yesterday' : 'vs 7d avg'} ${deltaText(d)}`, cls: d.delta === 0 ? '' : d.delta > 0 ? 'up' : 'down' })
  }
  return out
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** An instant's ET day, "Sep 26" (the ads freshness line's own format). */
function fmtEtDay(ms: unknown): string {
  if (!finite(ms)) return '—'
  const d = etDateFromMs(ms)
  return `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`
}
/** The first label note a value carries (a category's own name), or null. */
function statusNoteOf(value: MetricValue): string | null {
  return value.noteIds?.find((id) => hasNote(id) && getNote(id)?.kind === 'label') ?? null
}
function rangeDays(start: string, end: string): number {
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86_400_000) + 1
}

// ── Gating (ADR "Closed campaigns: omit, don't label" / "whenEmpty") ─────────────────────
function applyEmptyGating(whenEmpty: Gating['whenEmpty']): { primary: string; visible: boolean } {
  const mode = whenEmpty ?? 'dash'
  if (mode === 'omit') return { primary: '', visible: false }
  // A note this build doesn't know falls back to the default dash, never the raw id.
  if (typeof mode === 'object') return { primary: hasNote(mode.note) ? noteRawText(mode.note) : '—', visible: true }
  return { primary: '—', visible: true }
}
function applyUnmeasuredGating(gating: Gating | undefined, scope: ScopeInstance, value: MetricValue): { primary: string; visible: boolean } {
  const mode = gating?.whenUnmeasured ?? 'auto'
  const closedCampaign = campaignOfScope(scope)?.status === 'closed' // the card's campaign, however deep the cell
  if (mode === 'omit' || (mode === 'auto' && closedCampaign)) return { primary: '', visible: false }
  // A specific reason (e.g. 'flight-pending') is more useful than the generic label when the
  // server supplied one and it's a real registry label, not just an internal reason code.
  const specific = value.noteIds?.find((id) => id !== 'not-yet-tracking' && hasNote(id) && getNote(id)?.kind === 'label') ?? (value.reason === 'not-started' ? 'not-started' : undefined)
  return { primary: noteRawText(specific ?? 'not-yet-tracking'), visible: true }
}
function formatBadge(raw: string | null, display: Extract<Display, { as: 'badge' }>): { primary: string; tone: 'neutral' | 'live' | 'warn' } {
  if (raw == null) return { primary: '—', tone: 'neutral' }
  return { primary: raw, tone: display.tones?.[raw] ?? 'neutral' }
}

// ── Metric/ratio value formatting by display kind ─────────────────────────────────────────
function formatMetricOrRatioValue(display: Display, value: MetricValue, def: MetricDef | RatioDef, nowMs: number): { primary: string; deltaLines: DeltaLine[]; split?: { main: string; sub: string } } {
  switch (display.as) {
    case 'number':
      if (value.status === 'too-few') return { primary: noteRawText('too-few-to-report'), deltaLines: [] }
      return { primary: fmtCount(value.value), deltaLines: deltaLinesFor(value, display.deltas) }
    case 'currency':
      if (value.status === 'too-few') return { primary: noteRawText('too-few-to-report'), deltaLines: [] }
      return { primary: fmtMoney(value.value), deltaLines: [] }
    case 'percent': {
      const nd = ndSuffix(value)
      const main = value.status === 'too-few' ? noteRawText('too-few-to-report') : fmtPercent(value.value, display.decimals ?? 1)
      return { primary: `${main}${nd}`, deltaLines: [], ...(nd ? { split: { main, sub: nd.trim() } } : {}) }
    }
    case 'counts': {
      // Always n/d, whatever the status — a pair is never gated, and a proportion shown as
      // counts is the "here are the raw numbers" escape hatch MIN_COHORT gating exists for.
      const r = def as RatioDef
      const numDef = METRICS.get(r.num)
      const denDef = METRICS.get(r.den)
      const numWord = numDef ? unitWord(numDef) : ''
      const denWord = denDef ? unitWord(denDef) : ''
      return { primary: `${fmtCount(value.numerator)} ${numWord} · ${fmtCount(value.denominator)} ${denWord}`.trim(), deltaLines: [] }
    }
    case 'bar':
      // A rate as a bar keeps its (n/d): the reader always sees what the bar is made of.
      if (!('unit' in def) && def.kind === 'proportion') {
        const main = value.status === 'too-few' ? noteRawText('too-few-to-report') : fmtPercent(value.value, 1)
        const nd = ndSuffix(value)
        return { primary: `${main}${nd}`, deltaLines: [], ...(nd ? { split: { main, sub: nd.trim() } } : {}) }
      }
      return { primary: fmtCount(value.value ?? value.numerator), deltaLines: [] }
    case 'date':
      return { primary: fmtEtDay(value.value), deltaLines: [] }
    case 'ago':
      return { primary: finite(value.value) ? relativeTime(new Date(value.value).toISOString(), nowMs) : '—', deltaLines: [] }
    case 'status': {
      const id = statusNoteOf(value)
      return { primary: id ? noteRawText(id) : '—', deltaLines: [] }
    }
    case 'sparkline':
      // The headline stays the metric's value (the sparkline is drawn beside it, from
      // value.series); a money metric reads as money.
      return { primary: 'unit' in def && def.unit === 'usd' ? fmtMoney(value.value) : fmtCount(value.value), deltaLines: [] }
    default:
      return { primary: fmtCount(value.value), deltaLines: [] }
  }
}

/** "new today" (the KPI tiles' go-live state): a today-so-far count asked for deltas, and the
 * server returned none, because every comparison window predates the metric's go-live (or
 * the campaign's attribution start). The server omits a gated delta rather than zeroing it,
 * so an absent `deltas` and `wholeDays` on a measured today-so-far value can only mean that. */
function isNewToday(item: MetricItem, value: MetricValue, def: MetricDef | RatioDef): boolean {
  if (item.display.as !== 'number' || !item.display.deltas?.length || value.deltas || value.wholeDays) return false
  if (value.status !== 'ok' && value.status !== 'partial') return false
  if (!('unit' in def)) return false // a ratio never carries deltas
  const window = 'metric' in item.data ? (item.data.window ?? Object.keys(def.windows)[0]) : undefined
  return window === 'todaySoFar'
}

/** The latest ET day that gates a metric's comparisons, as the engine derives it: its
 * instrumentation rules' go-live days and, for a campaign metric, the flight's start. */
function goLiveEtFor(def: MetricDef, scope: ScopeInstance): string | null {
  const campaign = campaignOfScope(scope)
  let best: string | null = null
  const take = (d: string | null | undefined) => {
    if (d && (best === null || d > best)) best = d
  }
  for (const r of rulesOf(def, { params: campaign ? { campaignId: campaign.id } : {}, campaign, window: 'todaySoFar' })) {
    if ((r.kind === 'liveAt' || r.kind === 'unmeasuredBefore') && r.atMs != null) take(etDateFromMs(r.atMs))
    else if (r.kind === 'liveOnEtDate') take(r.dateEt)
  }
  if (campaign && def.params.includes('campaignId')) take(campaign.flightStart)
  return best
}

function itemCaptionOnly(item: MetricItem, scope: ScopeInstance, todayEt: string): TextToken[] {
  return item.caption ? resolveLabelTokens(item.caption, scope, undefined, todayEt) : []
}
const CAPTION_SEPARATOR: TextToken = { type: 'text', value: ' · ' }
function valueCaptionTokens(item: MetricItem, value: MetricValue, scope: ScopeInstance, todayEt: string): TextToken[] {
  const groups: TextToken[][] = []
  // A 'status' display already shows its note as the value: never again as a caption.
  const shown = item.display.as === 'status' ? statusNoteOf(value) : null
  for (const id of value.noteIds ?? []) {
    if (!hasNote(id) || id === shown) continue
    const vars = id === 'counted-from' && value.measuredFrom != null ? { from: etDateFromMs(value.measuredFrom) } : undefined
    groups.push(noteTokens(id, vars))
  }
  groups.push(itemCaptionOnly(item, scope, todayEt))
  // One caption line, its notes separated — never run together ("…not recordedstill arriving").
  return groups.filter((g) => g.length).flatMap((g, i) => (i ? [CAPTION_SEPARATOR, ...g] : g))
}

function fieldViewModel(item: MetricItem, raw: string | null, labelTokens: TextToken[], scope: ScopeInstance, todayEt: string): ItemViewModel {
  const captionTokens = itemCaptionOnly(item, scope, todayEt)
  const display = item.display
  if (display.as === 'dateRange') {
    if (raw == null) {
      const { primary, visible } = applyEmptyGating(item.gating?.whenEmpty)
      return { visible, labelTokens, primary, deltaLines: [], captionTokens }
    }
    const [start, end] = raw.split('|')
    const primary = display.days ? `${start} → ${end} (${rangeDays(start, end)}d)` : `${start} → ${end}`
    return { visible: true, labelTokens, primary, deltaLines: [], captionTokens }
  }
  if (display.as === 'badge') {
    const { primary, tone } = formatBadge(raw, display)
    return { visible: true, labelTokens, primary, deltaLines: [], captionTokens, badgeTone: tone }
  }
  if (raw == null) {
    const { primary, visible } = applyEmptyGating(item.gating?.whenEmpty)
    return { visible, labelTokens, primary, deltaLines: [], captionTokens }
  }
  if (display.as === 'currency') {
    const n = Number(raw)
    return { visible: true, labelTokens, primary: Number.isFinite(n) ? fmtMoney(n) : raw, deltaLines: [], captionTokens }
  }
  if (display.as === 'number') {
    const n = Number(raw)
    return { visible: true, labelTokens, primary: Number.isFinite(n) ? fmtCount(n) : raw, deltaLines: [], captionTokens }
  }
  if (display.as === 'datetime-et') return { visible: true, labelTokens, primary: etDateTimeText(raw), deltaLines: [], captionTokens }
  // 'datetime' | 'text': plain text, already textLite-safe by construction (scopeField never
  // returns markup — it reads config/registry data, never a beacon string).
  return { visible: true, labelTokens, primary: raw, deltaLines: [], captionTokens }
}

/** A flight that has not begun, as the server reports a window that has not opened yet. */
const NOT_STARTED: MetricValue = { status: 'unmeasured', reason: 'not-started', noteIds: ['not-started'] }
function metricViewModel(item: MetricItem, value: MetricValue, def: MetricDef | RatioDef, labelTokens: TextToken[], scope: ScopeInstance, todayEt: string, nowMs: number): ItemViewModel {
  // whenNotStarted 'zero': a count that cannot have happened yet reads a measured 0.
  if (value.status === 'unmeasured' && value.reason === 'not-started' && item.gating?.whenNotStarted === 'zero') value = { status: 'ok', value: 0 }
  if (value.status === 'error') {
    // A status word, never a dash: a dash reads as "no value", an error means "not loaded".
    return { visible: true, labelTokens, primary: noteRawText('metric-unavailable'), deltaLines: [], captionTokens: itemCaptionOnly(item, scope, todayEt), muted: true, error: true }
  }
  if (value.status === 'no-data') {
    const { primary, visible } = applyEmptyGating(item.gating?.whenEmpty)
    // A percent always shows its (n/d), a 0 denominator included ("— (0/0)"): the reader
    // sees WHY there is no rate (ADR 0003, "n/d is always returned").
    const nd = item.display.as === 'percent' && (item.gating?.whenEmpty ?? 'dash') === 'dash' ? ndSuffix(value) : ''
    // The notes a value carries travel with an empty one too ("stale" with no spend day stored).
    return { visible, labelTokens, primary: primary + nd, deltaLines: [], captionTokens: valueCaptionTokens(item, value, scope, todayEt), ...(nd ? { split: { main: primary, sub: nd.trim() } } : {}) }
  }
  if (value.status === 'unmeasured') {
    const { primary, visible } = applyUnmeasuredGating(item.gating, scope, value)
    return { visible, labelTokens, primary, deltaLines: [], captionTokens: itemCaptionOnly(item, scope, todayEt), muted: true }
  }
  // 'ok' | 'partial' | 'too-few'
  if (item.gating?.whenZero === 'omit' && value.value === 0 && value.status !== 'too-few') return { visible: false, labelTokens, primary: '0', deltaLines: [], captionTokens: [] }
  const { primary, deltaLines, split } = formatMetricOrRatioValue(item.display, value, def, nowMs)
  if (isNewToday(item, value, def)) {
    // Comparisons are hidden while yesterday or the 7-day window reaches back to the go-live day
    // (or a campaign's first, partial day). On that day itself it is "new today"; on the days
    // after, the metric is not new any more: there is simply no full day to compare with yet.
    const goLive = goLiveEtFor(def as MetricDef, scope)
    deltaLines.push(goLive && goLive < todayEt ? { text: noteRawText('no-comparison-yet'), cls: '' } : { text: noteRawText('new-today'), cls: 'new' })
  }
  const bar = item.display.as === 'bar' ? { barValue: finite(value.value) ? value.value : finite(value.numerator) ? value.numerator : 0 } : {}
  const mutedTooFew = value.status === 'too-few' && item.display.as !== 'percent' && item.display.as !== 'bar'
  const series = item.display.as === 'sparkline' && value.series?.length ? { series: value.series } : {}
  return { visible: true, labelTokens, primary, deltaLines, captionTokens: valueCaptionTokens(item, value, scope, todayEt), ...(split ? { split } : {}), ...bar, ...series, ...(mutedTooFew ? { muted: true } : {}) }
}

/** An item's label alone, resolved against its scope — used by a 'table' section's header row,
 * which needs every column's label but has no single MetricValue to pair it with. */
export function itemLabelTokens(item: MetricItem, scope: ScopeInstance, todayEt: string): TextToken[] {
  const resolved = resolveBinding(item.data, scope, todayEt)
  const metricLabelId = resolved && resolved.kind !== 'field' ? (resolved.def as MetricDef | RatioDef).label : undefined
  return resolveLabelTokens(item.label, scope, metricLabelId, todayEt)
}

/** The whole rendering decision for one MetricItem: what its label says, what its value says,
 * whether it should even be on the page. `value` is `undefined` while the batch request for a
 * metric/ratio binding is still in flight; a `field` binding never needs one. */
export function itemViewModel(item: MetricItem, value: MetricValue | undefined, scope: ScopeInstance, opts: ItemViewOptions): ItemViewModel {
  const resolved = resolveBinding(item.data, scope, opts.todayEt)
  const metricLabelId = resolved && resolved.kind !== 'field' ? (resolved.def as MetricDef | RatioDef).label : undefined
  const labelTokens = resolveLabelTokens(item.label, scope, metricLabelId, opts.todayEt)

  if (!resolved) {
    // Unknown metric/ratio id — treat like the server's own 'unknown-id' error.
    return { visible: true, labelTokens, primary: '—', deltaLines: [], captionTokens: itemCaptionOnly(item, scope, opts.todayEt) }
  }
  if (resolved.kind === 'field') {
    return fieldViewModel(item, resolved.fieldValue ?? null, labelTokens, scope, opts.todayEt)
  }
  // Ruled out by the campaign's own config (spend-only, or no flight start yet): omitted
  // whatever the status, and never requested (scope.ts unmeasuredByConfig), unless the item's
  // whenNotStarted gating keeps a not-yet-started flight's item: then it reads as the server
  // would answer a window that has not opened yet.
  if (unmeasuredByConfig(item.data, scope, item.gating, opts.todayEt)) return { visible: false, labelTokens, primary: '', deltaLines: [], captionTokens: [] }
  if (configRuling(item.data, scope, opts.todayEt) === 'flight-pending') value = NOT_STARTED
  if (!value) {
    return { visible: true, labelTokens, primary: '…', deltaLines: [], captionTokens: [] }
  }
  return metricViewModel(item, value, resolved.def as MetricDef | RatioDef, labelTokens, scope, opts.todayEt, opts.nowMs ?? Date.now())
}

/** The badge's own view (always a `field` binding — validateCard rejects anything else). */
export function badgeViewModel(display: Extract<Display, { as: 'badge' }>, raw: string | null): { primary: string; tone: 'neutral' | 'live' | 'warn' } {
  return formatBadge(raw, display)
}
