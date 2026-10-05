// Catalog metrics as value tokens (notes plan slice 1d, release 2): `{=metric:<id>@<window>}`.
// The grammar is written in the header of lib/valueTokens.ts; this file is its metric half, and it
// is pure (no fetch): the composable that asks the server is composables/useMetricTokens.ts.
//
// What a path may name:
//   <id>      a catalog metric (lib/metrics/metrics.ts) or a proportion ratio (ratios.ts) that
//             needs no choice: no campaign, popup or other required parameter (the optional country
//             split is never sent by a token). A path for a campaign or popup metric, or for a
//             cost, pair or per ratio, is not addressable and shows "—".
//   <window>  one of THAT metric's own windows (metricWindows / ratioWindowsOf): `page` (the page's
//             own date range), `todaySoFar`, `before`, `after`. The window is required: a path with
//             no `@window` is unknown, because the catalog's default window is its own business and
//             a token must keep meaning what it meant when it was written.
// The request a token sends is only { metric | ratio, window }: no params, deltas or series, so a
// token reaches the server through the same POST /api/metrics a card does and can never ask for a
// split a card withholds. Counts-only rows (return, game starts, completions, tutorial, tour
// exits) keep their server-side rule: no hour, place or device split and no visitor id, and a
// sub-day range snaps to whole ET days (lib/splitGuard.ts, the 'refused-whole-days' note).
//
// A token's kind comes from the catalog's own unit and never changes with its path (additive only):
//   a count unit (device, row, pageview, completion, showing, signin, finish) or `day`  → number
//   `rate` (a 0..1 fraction) and a proportion ratio                                    → share
//   `instant` (an epoch-ms time, e.g. "Play data through")                              → date (its ET day)
//   `usd` and `code` are not offered (a dollar figure or a category is no caption count)
// A token shows its value only for a status 'ok' result with a finite number. Pending (loading),
// too-few, no-data, unmeasured, partial (a shorter span than the caption's range) and error all
// show "—". A provisional value (a lagged count still arriving) is shown: it is the figure the
// card headline shows.
import { notePreview } from './metrics/editorModel'
import { METRICS, OPTIONAL_PARAMS, metricWindows } from './metrics/metrics'
import { RATIOS, ratioParamsOf, ratioWindowsOf } from './metrics/ratios'
import type { MetricRequestSpec } from './metrics/scope'
import type { CardSpec, Label, MetricValue, RepeatSpec } from './metrics/types'
import type { Unit } from './metrics/units'
import { etDateFast } from './etTime'
import { VALUE_TOKEN_RE } from './textLite'
import { parseValueToken, type TokenValue, type ValueKind, type ValueTokenOption } from './valueTokens'

export const METRIC_PATH_PREFIX = 'metric:'

export interface MetricTokenRef {
  /** The whole path, as written in the token: `metric:bsk.pageviews@page`. */
  path: string
  /** Whether `id` is a metric or a ratio of the catalog. */
  of: 'metric' | 'ratio'
  id: string
  window: string
  kind: ValueKind
}

const NUMBER_UNITS: ReadonlySet<Unit> = new Set(['device', 'row', 'pageview', 'completion', 'showing', 'signin', 'finish', 'day'])
const PATH_RE = /^metric:([A-Za-z0-9_.-]+)@([A-Za-z0-9]+)$/

function metricKind(unit: Unit): ValueKind | null {
  if (NUMBER_UNITS.has(unit)) return 'number'
  if (unit === 'rate') return 'share'
  if (unit === 'instant') return 'date'
  return null
}

/** A `metric:<id>@<window>` path → what it names, or null when it is malformed, unknown, names a
 * window the metric doesn't have, or isn't addressable without parameters. */
export function parseMetricPath(path: string): MetricTokenRef | null {
  const m = PATH_RE.exec(path)
  if (!m) return null
  const [, id, window] = m
  const def = METRICS.get(id)
  if (def) {
    if (def.params.some((p) => !OPTIONAL_PARAMS.has(p))) return null
    if (!metricWindows(def).includes(window as never)) return null
    const kind = metricKind(def.unit)
    return kind ? { path, of: 'metric', id, window, kind } : null
  }
  const ratio = RATIOS.get(id)
  if (ratio) {
    if (ratio.kind !== 'proportion') return null
    if (ratioParamsOf(ratio).some((p) => !OPTIONAL_PARAMS.has(p))) return null
    if (!ratioWindowsOf(ratio).includes(window as never)) return null
    return { path, of: 'ratio', id, window, kind: 'share' }
  }
  return null
}

/** The request a token sends: only the metric or ratio and its window. */
export function metricRequestSpec(ref: MetricTokenRef): MetricRequestSpec {
  return ref.of === 'metric' ? { metric: ref.id, window: ref.window } : { ratio: ref.id, window: ref.window }
}

/** The value a token shows for a server result: null (the placeholder) unless it is a measured,
 * finite, whole-range value. */
export function metricTokenValue(ref: MetricTokenRef, mv: MetricValue | undefined): TokenValue {
  const none: TokenValue = { kind: ref.kind, value: null }
  if (!mv || mv.status !== 'ok') return none
  const v = mv.value
  if (typeof v !== 'number' || !Number.isFinite(v)) return none
  if (ref.kind === 'date') return { kind: 'date', value: etDateFast(v) }
  return { kind: ref.kind, value: v }
}

/** Every distinct, addressable `metric:` path in these texts, in first-seen order. */
export function metricRefsIn(texts: readonly (string | undefined | null)[]): MetricTokenRef[] {
  const seen = new Map<string, MetricTokenRef>()
  for (const text of texts) {
    if (!text) continue
    for (const source of text.match(VALUE_TOKEN_RE) ?? []) {
      const t = parseValueToken(source)
      if (!t || !t.path.startsWith(METRIC_PATH_PREFIX) || seen.has(t.path)) continue
      const ref = parseMetricPath(t.path)
      if (ref) seen.set(t.path, ref)
    }
  }
  return [...seen.values()]
}

/** The windows the picker offers: the two a caption reads naturally. Every catalog window is
 * still valid in a typed token. */
const OFFERED_WINDOWS: readonly { window: string; label: string }[] = [
  { window: 'page', label: 'page range' },
  { window: 'todaySoFar', label: 'today so far' },
]
const FORMAT_OF_KIND: Record<ValueKind, string> = { number: '|number', share: '|pct', date: '|date', text: '' }

export interface MetricTokenOption extends ValueTokenOption {
  group: 'Metrics'
  ref: MetricTokenRef
}

/** The picker's "Metrics" group: one option per offered window of every addressable metric and
 * proportion ratio that has a plain-text name, in catalog order. */
export function metricTokenOptions(): MetricTokenOption[] {
  const out: MetricTokenOption[] = []
  const add = (id: string, labelId: string, windows: readonly string[]) => {
    const name = notePreview(labelId)
    if (!name) return
    for (const o of OFFERED_WINDOWS) {
      if (!windows.includes(o.window)) continue
      const ref = parseMetricPath(`${METRIC_PATH_PREFIX}${id}@${o.window}`)
      if (!ref) continue
      out.push({ group: 'Metrics', label: `${name} (${o.label})`, token: `{=${ref.path}${FORMAT_OF_KIND[ref.kind]}}`, ref })
    }
  }
  for (const def of METRICS.values()) add(def.id, def.label, metricWindows(def))
  for (const r of RATIOS.values()) add(r.id, r.label, ratioWindowsOf(r))
  return out
}

/** Every plain-text Label a card renders, for the metric tokens a card's labels may carry: its
 * title, each section's title and column/row headings, each item's label, caption and hint, and
 * every repeat's "empty" heading and message. A note, bound or "metric's own" label is no text. */
export function cardLabelTexts(spec: CardSpec | null | undefined): string[] {
  const out: string[] = []
  const add = (l: Label | undefined) => {
    if (typeof l === 'string') out.push(l)
  }
  const addRepeat = (r: RepeatSpec | undefined) => {
    add(r?.empty?.label)
    add(r?.empty?.text)
  }
  if (!spec) return out
  add(spec.title)
  addRepeat(spec.repeat)
  for (const s of spec.sections ?? []) {
    add(s.title)
    add(s.columnLabel)
    add(s.rowsLabel)
    addRepeat(s.repeat)
    addRepeat(s.columns)
    for (const it of s.items ?? []) {
      add(it.label)
      add(it.caption)
      add(it.hint)
      addRepeat(it.repeat)
    }
  }
  return out
}
