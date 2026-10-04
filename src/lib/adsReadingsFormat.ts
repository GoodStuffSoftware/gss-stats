// The readings log's text, shared by the ads readings widget and the metric-card engine
// (lib/metrics: scope.ts, render.ts), so both draw a stored reading the same way. Pure functions
// of a stored reading record's own fields: an aggregate's read time, its kind, and the five
// whitelisted counts (lib/metrics/types.ts READING_COUNT_FIELDS). Never a beacon row.
import type { ReadingRecord } from './adsRules'

/** "Sep 26, 3:00 PM" in ET: the time a reading was READ (a stored aggregate's own timestamp). */
export const ET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** "Sep 26, 3:00 PM ET"; the raw text back for something that is not a date. */
export function etDateTimeText(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? iso : `${ET_FMT.format(new Date(ms))} ET`
}

/** A whole number with thousands separators; an em dash for no value. */
export const fmtCount = (n: number | null | undefined): string => (n == null ? '—' : n.toLocaleString('en-US'))

/** The Kind column: "threshold $50, $100", "post-flight wrapup", "daily". */
export function readingKindLabel(r: Pick<ReadingRecord, 'kind' | 'stage' | 'thresholds'>): string {
  if (r.kind === 'threshold') return `threshold ${r.thresholds.map((t) => `$${t}`).join(', ')}`
  if (r.kind === 'postflight') return `post-flight ${r.stage ?? ''}`.trim()
  return r.kind
}

/** The Sign-ups column: "N (exact)" when the bound is exact, "at most N" otherwise, an em dash
 * when unread. */
export function signUpsText(atMost: number | null | undefined, exact: boolean): string {
  if (atMost == null) return '—'
  return exact ? `${fmtCount(atMost)} (exact)` : `at most ${fmtCount(atMost)}`
}

/** The Sign-ups column's hint (its header's tooltip). */
export const SIGNUPS_HINT = 'An UPPER bound: min(tagged auth successes, new accounts sitewide in the window). Auth successes include returning sign-ins.'
