// A runtime notice a data endpoint attaches to a response when the date range asked for was
// cut down to what the data source can serve (functions/_lib/rangeGate.ts decides; ChartCard
// shows it as a small note inside the card). Never persisted: it is not part of the layout
// config or the widget schema, so it needs no CONFIG_VERSION bump.
//
// No imports beyond etTime (which has none itself): shared by the Function and the browser.
import { etDateFast } from './etTime'

export interface RangeNotice {
  kind: 'range-clamped'
  /** The data source that limited the range (the key into RANGE_LIMITS). */
  source: 'cf-rum'
  /**
   *  - `max-duration`: the span was wider than the source allows per query; the most recent
   *    allowed window ending at the requested end was served.
   *  - `lookback`: the start was older than the source keeps; the start was moved forward.
   *  - `both`: both of the above.
   *  - `outside-lookback`: the whole range is older than the source keeps; nothing was queried.
   *  - `upstream-rejected`: the source itself refused the range (its limits differ from the
   *    constants), so nothing was served.
   */
  reason: 'max-duration' | 'lookback' | 'both' | 'outside-lookback' | 'upstream-rejected'
  /** Whose calendar days the served window is cut on and the note names: ET (absent) or UTC (a
   * `date` series, whose bars are UTC days). */
  dayZone?: 'utc'
  /** The range asked for, as ISO instants (`to` exclusive). */
  requested: { from: string; to: string }
  /** The range actually queried, or null when nothing was. */
  served: { from: string; to: string } | null
  /** The source's longest allowed query span, in days (null when unknown). */
  limitDays: number | null
  /** How far back the source keeps data, in days (null when unknown). */
  lookbackDays: number | null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The calendar day of `ms` as YYYY-MM-DD, in ET or UTC. */
const dayOf = (ms: number, utc: boolean) => (utc ? new Date(ms).toISOString().slice(0, 10) : etDateFast(ms))

/** "Jun 10" (calendar day), with ", 2025" when `withYear`. */
function dayLabel(ms: number, utc: boolean, withYear: boolean): string {
  const [y, m, d] = dayOf(ms, utc).split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`
}

/** The note's text, e.g. "Showing Jun 10 – Sep 10 only. Cloudflare analytics allows up to 93
 * days per query." Days are ET calendar days, matching the rest of the dashboard (UTC days for a `date` series, matching its bars); the end is the
 * last day inside the served range (its `to` is exclusive). `nowMs` only decides whether years
 * are shown (they are when the range is not within the current year). */
export function rangeNoticeText(n: RangeNotice, nowMs: number = Date.now()): string {
  if (n.reason === 'upstream-rejected') {
    return 'Cloudflare analytics could not serve this range (it limits how long and how far back a query can reach). Try a shorter, more recent range.'
  }
  const days = (v: number | null) => (v == null ? 'a limited number of' : String(v))
  if (!n.served) {
    return `No data shown. Cloudflare analytics keeps only the last ${days(n.lookbackDays)} days, and this range is older than that.`
  }
  const from = Date.parse(n.served.from)
  const lastDay = Date.parse(n.served.to) - 1
  const utc = n.dayZone === 'utc'
  const thisYear = etDateFast(nowMs).slice(0, 4)
  const withYear = dayOf(from, utc).slice(0, 4) !== thisYear || dayOf(lastDay, utc).slice(0, 4) !== thisYear
  const span = `Showing ${dayLabel(from, utc, withYear)} – ${dayLabel(lastDay, utc, withYear)} only.`
  const duration = `allows up to ${days(n.limitDays)} days per query`
  const lookback = `keeps only the last ${days(n.lookbackDays)} days`
  const why = n.reason === 'max-duration' ? duration : n.reason === 'lookback' ? lookback : `${duration} and ${lookback}`
  return `${span} Cloudflare analytics ${why}.`
}
