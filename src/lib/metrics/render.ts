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
import { tokenizeAndInterpolate, type TextToken } from '../textLite'
import { METRICS, type MetricDef } from './metrics'
import { RATIOS, type RatioDef } from './ratios'
import { resolveBinding, scopeField, scopeVars, type ScopeInstance } from './scope'
import type { Display, Gating, Label, MetricItem, MetricValue } from './types'
import { unitLabelId } from './units'

// A note id ever reaches here from data an author saved into a CardSpec (Label's `note`,
// Gating.whenEmpty's `note`) or that the server echoed back (MetricValue.noteIds) — never a
// literal this module wrote itself. NOTES_REGISTRY is an ordinary object literal, so a bracket
// lookup for an id like 'constructor' or '__proto__' resolves through Object.prototype instead
// of coming back undefined (review finding, 2026-09-27) — `getNote`'s own `!n` truthiness check
// doesn't catch that (a Function is truthy). validateCard is meant to reject such an id before
// it's ever saved, but this checks the registry's OWN property regardless, so a save made
// before that guard existed still renders as plain text instead of crashing (`resolveText`
// calling `.text` on a Function, or a token walk over its `undefined` result).
function hasNote(id: string): boolean {
  return Object.hasOwn(NOTES_REGISTRY, id)
}

export interface DeltaLine {
  text: string
  cls: '' | 'up' | 'down'
}

export interface ItemViewModel {
  visible: boolean
  labelTokens: TextToken[]
  primary: string
  deltaLines: DeltaLine[]
  captionTokens: TextToken[]
  badgeTone?: 'neutral' | 'live' | 'warn'
}

export interface ItemViewOptions {
  todayEt: string
}

// ── Label resolution (ADR section 1, "Labels") ────────────────────────────────────────────
export function resolveLabelTokens(label: Label, scope: ScopeInstance, metricLabelId: string | undefined, todayEt: string): TextToken[] {
  if (typeof label === 'string') return tokenizeAndInterpolate(label, scopeVars(scope, todayEt))
  if ('note' in label) {
    if (!hasNote(label.note)) return [{ type: 'text', value: label.note }]
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
function fmtCount(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}
function fmtMoney(n: number | null | undefined): string {
  return n == null ? '—' : `$${n.toFixed(2)}`
}
function fmtPercent(fraction: number | null | undefined, decimals: number): string {
  return fraction == null ? '—' : `${(fraction * 100).toFixed(decimals)}%`
}
function unitWord(def: MetricDef): string {
  return noteRawText(def.unitLabel ?? unitLabelId(def.unit))
}
function deltaText(d: { delta: number; deltaPct: number | null }): string {
  const rounded = Math.round(d.delta)
  const sign = rounded > 0 ? '+' : ''
  const pctPart = d.deltaPct == null ? '' : ` (${d.delta > 0 ? '+' : ''}${(d.deltaPct * 100).toFixed(0)}%)`
  return `${sign}${rounded.toLocaleString('en-US')}${pctPart}`
}
function deltaLinesFor(value: MetricValue, deltas: readonly ('yesterday' | 'avg7')[] | undefined): DeltaLine[] {
  if (!deltas?.length || !value.deltas) return []
  const out: DeltaLine[] = []
  for (const name of deltas) {
    const d = value.deltas[name]
    if (!d) continue
    out.push({ text: `${name === 'yesterday' ? 'vs yesterday' : 'vs 7d avg'} ${deltaText(d)}`, cls: d.delta === 0 ? '' : d.delta > 0 ? 'up' : 'down' })
  }
  return out
}
function rangeDays(start: string, end: string): number {
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86_400_000) + 1
}

// ── Gating (ADR "Closed campaigns: omit, don't label" / "whenEmpty") ─────────────────────
function applyEmptyGating(whenEmpty: Gating['whenEmpty']): { primary: string; visible: boolean } {
  const mode = whenEmpty ?? 'dash'
  if (mode === 'omit') return { primary: '', visible: false }
  if (typeof mode === 'object') return { primary: hasNote(mode.note) ? noteRawText(mode.note) : mode.note, visible: true }
  return { primary: '—', visible: true }
}
function applyUnmeasuredGating(gating: Gating | undefined, scope: ScopeInstance, value: MetricValue): { primary: string; visible: boolean } {
  const mode = gating?.whenUnmeasured ?? 'auto'
  const closedCampaign = scope.kind === 'campaign' && scope.campaign.status === 'closed'
  if (mode === 'omit' || (mode === 'auto' && closedCampaign)) return { primary: '', visible: false }
  // A specific reason (e.g. 'flight-pending') is more useful than the generic label when the
  // server supplied one and it's a real registry label, not just an internal reason code.
  const specific = value.noteIds?.find((id) => id !== 'not-yet-tracking' && hasNote(id) && getNote(id)?.kind === 'label')
  return { primary: noteRawText(specific ?? 'not-yet-tracking'), visible: true }
}
function formatBadge(raw: string | null, display: Extract<Display, { as: 'badge' }>): { primary: string; tone: 'neutral' | 'live' | 'warn' } {
  if (raw == null) return { primary: '—', tone: 'neutral' }
  return { primary: raw, tone: display.tones?.[raw] ?? 'neutral' }
}

// ── Metric/ratio value formatting by display kind ─────────────────────────────────────────
function formatMetricOrRatioValue(display: Display, value: MetricValue, def: MetricDef | RatioDef): { primary: string; deltaLines: DeltaLine[] } {
  switch (display.as) {
    case 'number':
      if (value.status === 'too-few') return { primary: noteRawText('too-few-to-report'), deltaLines: [] }
      return { primary: fmtCount(value.value), deltaLines: deltaLinesFor(value, display.deltas) }
    case 'currency':
      if (value.status === 'too-few') return { primary: noteRawText('too-few-to-report'), deltaLines: [] }
      return { primary: fmtMoney(value.value), deltaLines: [] }
    case 'percent': {
      const nd = value.numerator != null && value.denominator != null ? ` (${value.numerator}/${value.denominator})` : ''
      if (value.status === 'too-few') return { primary: `${noteRawText('too-few-to-report')}${nd}`, deltaLines: [] }
      return { primary: `${fmtPercent(value.value, display.decimals ?? 1)}${nd}`, deltaLines: [] }
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
      return { primary: fmtCount(value.value ?? value.numerator), deltaLines: [] }
    case 'sparkline':
      // GAP (flagged to main): MetricValue carries only the latest value, no per-day series —
      // there is nothing here for `{ as: 'sparkline'; series: 'daily' }` to draw. Falls back
      // to the current value instead of rendering blank.
      return { primary: fmtCount(value.value), deltaLines: [] }
    default:
      return { primary: fmtCount(value.value), deltaLines: [] }
  }
}

function itemCaptionOnly(item: MetricItem, scope: ScopeInstance, todayEt: string): TextToken[] {
  return item.caption ? resolveLabelTokens(item.caption, scope, undefined, todayEt) : []
}
function valueCaptionTokens(item: MetricItem, value: MetricValue, scope: ScopeInstance, todayEt: string): TextToken[] {
  const tokens: TextToken[] = []
  for (const id of value.noteIds ?? []) {
    if (!hasNote(id)) continue
    const vars = id === 'counted-from' && value.measuredFrom != null ? { from: etDateFromMs(value.measuredFrom) } : undefined
    tokens.push(...noteTokens(id, vars))
  }
  tokens.push(...itemCaptionOnly(item, scope, todayEt))
  return tokens
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
  // 'datetime' | 'text': plain text, already textLite-safe by construction (scopeField never
  // returns markup — it reads config/registry data, never a beacon string).
  return { visible: true, labelTokens, primary: raw, deltaLines: [], captionTokens }
}

function metricViewModel(item: MetricItem, value: MetricValue, def: MetricDef | RatioDef, labelTokens: TextToken[], scope: ScopeInstance, todayEt: string): ItemViewModel {
  if (value.status === 'error') {
    return { visible: true, labelTokens, primary: '—', deltaLines: [], captionTokens: itemCaptionOnly(item, scope, todayEt) }
  }
  if (value.status === 'no-data') {
    const { primary, visible } = applyEmptyGating(item.gating?.whenEmpty)
    return { visible, labelTokens, primary, deltaLines: [], captionTokens: itemCaptionOnly(item, scope, todayEt) }
  }
  if (value.status === 'unmeasured') {
    const { primary, visible } = applyUnmeasuredGating(item.gating, scope, value)
    return { visible, labelTokens, primary, deltaLines: [], captionTokens: itemCaptionOnly(item, scope, todayEt) }
  }
  // 'ok' | 'partial' | 'too-few'
  const { primary, deltaLines } = formatMetricOrRatioValue(item.display, value, def)
  return { visible: true, labelTokens, primary, deltaLines, captionTokens: valueCaptionTokens(item, value, scope, todayEt) }
}

/** An item's label alone, resolved against its scope — used by a 'table' section's header row,
 * which needs every column's label but has no single MetricValue to pair it with. */
export function itemLabelTokens(item: MetricItem, scope: ScopeInstance, todayEt: string): TextToken[] {
  const resolved = resolveBinding(item.data, scope)
  const metricLabelId = resolved && resolved.kind !== 'field' ? (resolved.def as MetricDef | RatioDef).label : undefined
  return resolveLabelTokens(item.label, scope, metricLabelId, todayEt)
}

/** The whole rendering decision for one MetricItem: what its label says, what its value says,
 * whether it should even be on the page. `value` is `undefined` while the batch request for a
 * metric/ratio binding is still in flight; a `field` binding never needs one. */
export function itemViewModel(item: MetricItem, value: MetricValue | undefined, scope: ScopeInstance, opts: ItemViewOptions): ItemViewModel {
  const resolved = resolveBinding(item.data, scope)
  const metricLabelId = resolved && resolved.kind !== 'field' ? (resolved.def as MetricDef | RatioDef).label : undefined
  const labelTokens = resolveLabelTokens(item.label, scope, metricLabelId, opts.todayEt)

  if (!resolved) {
    // Unknown metric/ratio id — treat like the server's own 'unknown-id' error.
    return { visible: true, labelTokens, primary: '—', deltaLines: [], captionTokens: itemCaptionOnly(item, scope, opts.todayEt) }
  }
  if (resolved.kind === 'field') {
    return fieldViewModel(item, resolved.fieldValue ?? null, labelTokens, scope, opts.todayEt)
  }
  if (!value) {
    return { visible: true, labelTokens, primary: '…', deltaLines: [], captionTokens: [] }
  }
  return metricViewModel(item, value, resolved.def as MetricDef | RatioDef, labelTokens, scope, opts.todayEt)
}

/** The badge's own view (always a `field` binding — validateCard rejects anything else). */
export function badgeViewModel(display: Extract<Display, { as: 'badge' }>, raw: string | null): { primary: string; tone: 'neutral' | 'live' | 'warn' } {
  return formatBadge(raw, display)
}
