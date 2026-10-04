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

/** The calendar day of `ms` as YYYY-MM-DD, in ET or UTC. Also how chart value tokens name a
 * chart's days (lib/valueTokens.ts), so the note and a caption never disagree. */
export const dayOf = (ms: number, utc: boolean) => (utc ? new Date(ms).toISOString().slice(0, 10) : etDateFast(ms))

/** "Jun 10" (calendar day), with ", 2025" when `withYear`. */
function dayLabel(ms: number, utc: boolean, withYear: boolean): string {
  const [y, m, d] = dayOf(ms, utc).split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`
}

/** The note's text, e.g. "Jun 10 – Sep 10 shown (Cloudflare limit: 93 days)." Days are ET calendar days, matching the rest of the dashboard (UTC days for a `date` series, matching its bars); the end is the
 * last day inside the served range (its `to` is exclusive). `nowMs` only decides whether years
 * are shown (they are when the range is not within the current year). */
export function rangeNoticeText(n: RangeNotice, nowMs: number = Date.now()): string {
  if (n.reason === 'upstream-rejected') {
    return "No data shown (Cloudflare couldn't serve this range; try a shorter, more recent one)."
  }
  const kept = n.lookbackDays == null ? 'Cloudflare history limit' : `Cloudflare keeps ${n.lookbackDays} days`
  if (!n.served) return `No data shown (${kept}).`
  const from = Date.parse(n.served.from)
  const lastDay = Date.parse(n.served.to) - 1
  const utc = n.dayZone === 'utc'
  const thisYear = etDateFast(nowMs).slice(0, 4)
  const withYear = dayOf(from, utc).slice(0, 4) !== thisYear || dayOf(lastDay, utc).slice(0, 4) !== thisYear
  const span = `${dayLabel(from, utc, withYear)} – ${dayLabel(lastDay, utc, withYear)} shown`
  const limit = n.limitDays == null ? 'Cloudflare range limit' : `Cloudflare limit: ${n.limitDays} days`
  if (n.reason === 'max-duration') return `${span} (${limit}).`
  if (n.reason === 'lookback') return `${span} (${kept}).`
  const spanPart = n.limitDays == null ? 'range limit' : `${n.limitDays}-day span`
  const keptPart = n.lookbackDays == null ? 'history limit' : `${n.lookbackDays} days kept`
  return `${span} (Cloudflare limits: ${spanPart}, ${keptPart}).`
}
