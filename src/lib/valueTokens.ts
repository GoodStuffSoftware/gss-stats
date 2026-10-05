// Value tokens: `{=…}` in a chart caption, filled in from the chart's own results and from a few
// fixed dates (notes plan slice 1d, release 1). The ONE place the grammar is written down.
//
// GRAMMAR
//   token   = "{=" path [ "|" format ] "}"        spaces around path, "|" and format are ignored
//   path    = 1*( ALPHA / DIGIT / "_" / "." / ":" / "@" / "-" )
//   format  = "number" / "pct" / "date"
// Formats are case-insensitive ({=chart.total|NUMBER} fills); paths are case-sensitive
// ({=Chart.total} is an unknown path and shows "—").
//
// Every path has a kind, and a format is allowed only on its own kind:
//   number  →  "number"   1,234 (en-US grouping)
//   share   →  "pct"      12.3%  (a 0..1 fraction, one decimal)
//   date    →  "date"     Oct 3, 2026 (always with the year)
//   text    →  no format  shown as it is
// No format means the path's own kind's format. A token shows "—" (VALUE_TOKEN_PLACEHOLDER) when
// it is malformed, its path is unknown, its format is unknown or doesn't fit the path's kind, or
// its value is missing (no data yet, an error, a chart the value doesn't apply to).
//
// PATHS (release 1). `chart.*` only restate what the chart itself shows (counts-only rule: no
// splits beyond the chart's own), and nothing here fetches:
//   chart.total     number  the chart's total, in its metric (totals[metric])
//   chart.top       text    the label of the biggest value on the chart's main dimension
//   chart.topValue  number  that value
//   chart.topShare  share   that value / the total
//   chart.from      date    the first day the chart shows (the served range when it was cut)
//   chart.to        date    the last day the chart shows
//                           (both name the chart's own days, as #55's range note does: UTC days
//                           for a `date` series, whose bars are UTC days; ET days otherwise, and
//                           for an exact whole-UTC-day range its UTC days)
//   release.latest         date  the newest dated release's day (ET)
//   release.latestVersion  text  its version, e.g. v1.98.0
//   golive.web      date    the day web tracking went live (ET)
//   play.submitted  date    the day the Play build with tracking was submitted (ET): a
//                           submission, not a go-live
// `golive.<app>` is reserved for a real go-live day; Play gets `golive.play` only once its
// tracking is actually live, and `play.submitted` keeps meaning the submission.
//
// PATHS (release 2). Catalog metrics, filled from ONE batched request per page render:
//   metric:<id>@<window>   kind from the catalog's own unit (number; share for a rate or a
//                          proportion ratio; date for an instant), e.g.
//                          {=metric:bsk.pageviews@page|number}  {=metric:bsk.popupTapRate@todaySoFar|pct}
//   <id>      a catalog metric or proportion ratio that needs no campaign, popup or other parameter
//   <window>  required; one of THAT metric's own windows: page (the page's date range), todaySoFar,
//             before, after (the release windows)
// Anything else (no @window, an unknown id or window, a campaign or popup metric, a dollar figure
// or category, a cost/pair/per ratio) is an unknown path and shows "—", as do loading, an error
// and a value the server withholds or can't fully measure (too few, no data, partial). The request
// a token sends is only its metric and window, so it can never expose a split the catalog
// withholds (counts-only rule; enforced server-side). Release 1 parses these paths and shows "—",
// so nothing saved under it changes meaning. Full detail: lib/metricValueTokens.ts.
// `chart.*` is "—" in a note widget (it belongs to a chart); release.*, golive.*, play.* and
// metric: fill in a chart caption, a note widget and a metric card's labels (MetricCard.vue).
//
// New paths and new formats are additive only; an existing path never changes kind.
import type { StatsResponse, Widget } from '../types'
import { formatKey, hasLineSeries, metricValue } from './charts'
import { etDayOfRange, isoToYmd, ymdRangeToISO } from './range'
import { dayOf } from './rangeNotice'
import { datedReleases, newest } from './releases'
import { TRACKING_ACTIVATION_DATE_ET, PLAY_TRACKING_ACTIVATION_DATE_ET } from './popupEvents'
import type { ValueResolver } from './textLite'

export type { ValueResolver }

export type ValueKind = 'number' | 'share' | 'date' | 'text'
export type ValueFormat = 'number' | 'pct' | 'date'

export interface ParsedValueToken {
  path: string
  format: ValueFormat | null
}

/** A value ready to format: its kind and its raw value (null = missing). */
export interface TokenValue {
  kind: ValueKind
  value: number | string | null
}

export type TokenValues = Record<string, TokenValue>

const FORMATS: readonly ValueFormat[] = ['number', 'pct', 'date']
const FORMAT_KIND: Record<ValueFormat, ValueKind> = { number: 'number', pct: 'share', date: 'date' }
const TOKEN_SOURCE_RE = /^\{=\s*([A-Za-z0-9_.:@-]+)\s*(?:\|\s*([A-Za-z]+)\s*)?\}$/

/** One `{=…}` source → its path and format, or null when it doesn't follow the grammar. */
export function parseValueToken(source: string): ParsedValueToken | null {
  const m = TOKEN_SOURCE_RE.exec(source)
  if (!m) return null
  if (m[2] === undefined) return { path: m[1], format: null }
  const format = m[2].toLowerCase() as ValueFormat
  return FORMATS.includes(format) ? { path: m[1], format } : null
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/** "2026-10-03" → "Oct 3, 2026", or null for anything that isn't a real calendar date. */
export function formatDateYmd(ymd: string): string | null {
  if (!YMD_RE.test(ymd)) return null
  const t = Date.parse(`${ymd}T00:00:00Z`)
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== ymd) return null
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** Format a value of a kind; null when the value is missing or not of that kind. */
export function formatValue(v: TokenValue): string | null {
  if (v.value == null) return null
  switch (v.kind) {
    case 'number':
      return typeof v.value === 'number' && Number.isFinite(v.value) ? v.value.toLocaleString('en-US') : null
    case 'share':
      return typeof v.value === 'number' && Number.isFinite(v.value) ? `${(v.value * 100).toFixed(1)}%` : null
    case 'date':
      return typeof v.value === 'string' ? formatDateYmd(v.value) : null
    case 'text':
      return typeof v.value === 'string' && v.value !== '' ? v.value : null
  }
}

/** Resolve one `{=…}` source against a value table: its text, or null (placeholder). */
export function resolveValueToken(source: string, values: TokenValues): string | null {
  const t = parseValueToken(source)
  if (!t) return null
  const v = Object.prototype.hasOwnProperty.call(values, t.path) ? values[t.path] : undefined
  if (!v) return null
  if (t.format !== null && FORMAT_KIND[t.format] !== v.kind) return null
  return formatValue(v)
}

/** The fixed dates, as a resolver, built once: they only change with a new build. What a card's
 * own labels use (lib/metrics/render.ts), so the card editor's Insert value fills in. */
let globalResolver: ValueResolver | null = null
export function globalValueResolver(): ValueResolver {
  return (globalResolver ??= resolverOf(globalValues()))
}

/** The fixed dates: the newest release, the web go-live day and the Play submission day. */
export function globalValues(): TokenValues {
  const latest = newest(datedReleases())
  return {
    'release.latest': { kind: 'date', value: latest?.dateEt ?? null },
    'release.latestVersion': { kind: 'text', value: latest?.version ?? null },
    'golive.web': { kind: 'date', value: TRACKING_ACTIVATION_DATE_ET },
    'play.submitted': { kind: 'date', value: PLAY_TRACKING_ACTIVATION_DATE_ET },
  }
}

const missingChart = (): TokenValues => ({
  'chart.total': { kind: 'number', value: null },
  'chart.top': { kind: 'text', value: null },
  'chart.topValue': { kind: 'number', value: null },
  'chart.topShare': { kind: 'share', value: null },
  'chart.from': { kind: 'date', value: null },
  'chart.to': { kind: 'date', value: null },
})

/** Whether a chart plots UTC days. A `date` series does: Cloudflare RUM's and geo's `date` buckets
 * are UTC days, and so is the chart's `date` axis (lib/charts.ts dayBucketsInRange). The server
 * cuts a range on the same signal and says so with `dayZone: 'utc'` (functions/api/stats.ts), so a
 * cut and an uncut range on one chart name their days the same way. `dateEt`, and a chart with no
 * day dimension, plot ET days. */
function plotsUtcDays(widget: Pick<Widget, 'dimension'>, data: StatsResponse): boolean {
  return data.notice?.dayZone === 'utc' || widget.dimension === 'date' || !!data.meta?.dimensions?.includes('date')
}

/** The days a response covers, named the way #55's range note names them: in the chart's own day
 * zone (plotsUtcDays). When the range was cut: the served window (its `to` is exclusive). Else the
 * asked-for range: the day of `since` through the day of `until − 1 ms` (a bare YYYY-MM-DD `until`
 * being the whole UTC day, as the server reads it), so the days are the chart's bars and don't
 * depend on the time of viewing. On an ET-day chart, an exact ET day (etDayOfRange) is that day,
 * and an exact run of whole UTC days (ymdRangeToISO's shape, or bare bounds) is those UTC days, as
 * the filter bar names them. */
function shownDays(widget: Pick<Widget, 'dimension'>, data: StatsResponse): { from: string; to: string } | null {
  const utc = plotsUtcDays(widget, data)
  const day = (ms: number) => dayOf(ms, utc)
  const served = data.notice?.served
  if (data.notice) {
    if (!served) return null
    const from = Date.parse(served.from)
    const last = Date.parse(served.to) - 1
    if (!Number.isFinite(from) || !Number.isFinite(last)) return null
    return { from: day(from), to: day(last) }
  }
  const since = data.meta?.since
  const until = data.meta?.until
  if (!since || !until) return null
  const s = Date.parse(since)
  // a bare-date `until` is the whole UTC day, as the server reads it (inclusive)
  const u = Date.parse(YMD_RE.test(until) ? ymdRangeToISO(until, until).until : until)
  if (!Number.isFinite(s) || !Number.isFinite(u)) return null
  if (!utc) {
    const etDay = etDayOfRange(since, until)
    if (etDay) return { from: etDay, to: etDay }
    const whole = { from: isoToYmd(new Date(s).toISOString()), to: isoToYmd(new Date(u).toISOString()) }
    const iso = ymdRangeToISO(whole.from, whole.to)
    if (Date.parse(iso.since) === s && Date.parse(iso.until) === u) return whole
  }
  return { from: day(s), to: day(u - 1) }
}

/** The `chart.*` values for one chart, from the response it is showing (no fetch). Missing when
 * there is no response or the chart is showing an error; total/top/share are missing for a rate
 * tile and for a multi-series line chart (no single total), top/share for an empty chart or one
 * without a dimension, share for a zero total. */
export function chartValues(
  widget: Pick<Widget, 'type' | 'dataset' | 'dimension' | 'series' | 'metric'>,
  data: StatsResponse | null | undefined,
  error?: string | null,
): TokenValues {
  const out = missingChart()
  if (!data || error) return out
  const days = shownDays(widget, data)
  if (days) {
    out['chart.from'].value = days.from
    out['chart.to'].value = days.to
  }
  if (widget.type === 'rate' || hasLineSeries(widget)) return out
  const metric = widget.metric === 'visits' ? 'visits' : 'pageviews'
  const total = data.totals?.[metric]
  if (typeof total !== 'number' || !Number.isFinite(total)) return out
  out['chart.total'].value = total
  const dim = widget.dimension
  if (!dim || !data.rows?.length) return out
  const sums = new Map<string, number>()
  for (const r of data.rows) {
    const k = r.key?.[dim] ?? ''
    sums.set(k, (sums.get(k) ?? 0) + metricValue(r, metric))
  }
  let topKey: string | null = null
  let topVal = -Infinity
  for (const [k, v] of sums) {
    if (v > topVal) {
      topKey = k
      topVal = v
    }
  }
  if (topKey === null) return out
  out['chart.top'].value = formatKey(dim, topKey)
  out['chart.topValue'].value = topVal
  if (total > 0) out['chart.topShare'].value = topVal / total
  return out
}

/** A resolver over a value table (what TextBlock/NoteBlock take as `values`). */
export function resolverOf(values: TokenValues): ValueResolver {
  return (source) => resolveValueToken(source, values)
}

/** The resolver a chart's caption uses: its own results, the fixed dates, and `extra` (the
 * `metric:` values, composables/useMetricTokens.ts). */
export function chartValueResolver(
  widget: Pick<Widget, 'type' | 'dataset' | 'dimension' | 'series' | 'metric'>,
  data: StatsResponse | null | undefined,
  error?: string | null,
  extra?: TokenValues,
): ValueResolver {
  return resolverOf({ ...globalValues(), ...chartValues(widget, data, error), ...extra })
}

/** The resolver a note widget's text uses: the fixed dates and `extra`. `chart.*` is absent, so
 * it shows "—": a note belongs to no chart. */
export function noteValueResolver(extra?: TokenValues): ValueResolver {
  return resolverOf({ ...globalValues(), ...extra })
}

export interface ValueTokenOption {
  group: 'This chart' | 'Dates' | 'Metrics'
  label: string
  token: string
}

/** What the editor's "Insert value" menu offers, in order. */
export const VALUE_TOKEN_OPTIONS: readonly ValueTokenOption[] = [
  { group: 'This chart', label: 'Total', token: '{=chart.total|number}' },
  { group: 'This chart', label: 'Top item', token: '{=chart.top}' },
  { group: 'This chart', label: 'Top item’s count', token: '{=chart.topValue|number}' },
  { group: 'This chart', label: 'Top item’s share', token: '{=chart.topShare|pct}' },
  { group: 'This chart', label: 'First day shown', token: '{=chart.from|date}' },
  { group: 'This chart', label: 'Last day shown', token: '{=chart.to|date}' },
  { group: 'Dates', label: 'Latest release date', token: '{=release.latest|date}' },
  { group: 'Dates', label: 'Latest release version', token: '{=release.latestVersion}' },
  { group: 'Dates', label: 'Web tracking go-live', token: '{=golive.web|date}' },
  { group: 'Dates', label: 'Play submission date', token: '{=play.submitted|date}' },
]
