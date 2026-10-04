// Value tokens: `{=…}` in a chart caption, filled in from the chart's own results and from a few
// fixed dates (notes plan slice 1d, release 1). The ONE place the grammar is written down.
//
// GRAMMAR
//   token   = "{=" path [ "|" format ] "}"        spaces around path, "|" and format are ignored
//   path    = 1*( ALPHA / DIGIT / "_" / "." / ":" / "@" / "-" )
//   format  = "number" / "pct" / "date"
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
//                           (both name ET days, as #55's range note does; UTC days only for an
//                           exact whole-UTC-day range or a `dayZone: 'utc'` cut)
//   release.latest         date  the newest dated release's day (ET)
//   release.latestVersion  text  its version, e.g. v1.98.0
//   golive.web      date    the day web tracking went live (ET)
//   play.submitted  date    the day the Play build with tracking was submitted (ET): a
//                           submission, not a go-live
// `golive.<app>` is reserved for a real go-live day; Play gets `golive.play` only once its
// tracking is actually live, and `play.submitted` keeps meaning the submission.
//
// EXTENDING (release 2): catalog metrics arrive as new paths of the same shape, e.g.
// `{=metric:<id>@<window>|number}` — ":" and "@" are already legal path characters, so release 1
// parses them and shows "—" (unknown path), and nothing saved under release 1 changes meaning.
// New paths and new formats are additive only; an existing path never changes kind.
import type { StatsResponse, Widget } from '../types'
import { formatKey, hasLineSeries, metricValue } from './charts'
import { etDayOfRange, isoToYmd, ymdRangeToISO } from './range'
import { etDateFast } from './etTime'
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

/** The days a response covers, named the way #55's range note names them. When the range was cut:
 * the served window (its `to` is exclusive; ET days, or UTC for a `dayZone: 'utc'` notice). Else
 * the asked-for range: an exact ET day (etDayOfRange) is that day, an exact run of whole UTC days
 * (ymdRangeToISO's shape, or bare YYYY-MM-DD bounds) is those UTC days, and anything else (a
 * relative "Last 7d") is the ET day of `since` through the ET day of `until − 1 ms`, so the days
 * don't depend on the time of viewing. */
function shownDays(data: StatsResponse): { from: string; to: string } | null {
  const served = data.notice?.served
  if (data.notice) {
    if (!served) return null
    const from = Date.parse(served.from)
    const last = Date.parse(served.to) - 1
    if (!Number.isFinite(from) || !Number.isFinite(last)) return null
    const day = (ms: number) => (data.notice!.dayZone === 'utc' ? new Date(ms).toISOString().slice(0, 10) : etDateFast(ms))
    return { from: day(from), to: day(last) }
  }
  const since = data.meta?.since
  const until = data.meta?.until
  if (!since || !until) return null
  const s = Date.parse(since)
  // a bare-date `until` is the whole UTC day, as the server reads it (inclusive)
  const u = Date.parse(YMD_RE.test(until) ? ymdRangeToISO(until, until).until : until)
  if (!Number.isFinite(s) || !Number.isFinite(u)) return null
  const etDay = etDayOfRange(since, until)
  if (etDay) return { from: etDay, to: etDay }
  const utc = { from: isoToYmd(new Date(s).toISOString()), to: isoToYmd(new Date(u).toISOString()) }
  const whole = ymdRangeToISO(utc.from, utc.to)
  if (Date.parse(whole.since) === s && Date.parse(whole.until) === u) return utc
  return { from: etDateFast(s), to: etDateFast(u - 1) }
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
  const days = shownDays(data)
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

/** The resolver a chart's caption uses: its own results plus the fixed dates. */
export function chartValueResolver(
  widget: Pick<Widget, 'type' | 'dataset' | 'dimension' | 'series' | 'metric'>,
  data: StatsResponse | null | undefined,
  error?: string | null,
): ValueResolver {
  const values = { ...globalValues(), ...chartValues(widget, data, error) }
  return (source) => resolveValueToken(source, values)
}

export interface ValueTokenOption {
  group: 'This chart' | 'Dates'
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
