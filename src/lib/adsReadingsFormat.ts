// The readings log's text, shared by the ads readings widget and the metric-card engine
// (lib/metrics: scope.ts, render.ts), so both draw a stored reading the same way. Pure functions
// of a stored reading record's own fields: an aggregate's read time, its kind, and the five
// whitelisted counts (lib/metrics/types.ts READING_COUNT_FIELDS). Never a beacon row.
import type { ReadingRecord } from './adsRules'
import { etDayText } from './adsFreshness'
import { addDays } from './etTime'

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

// ── "Data through": the last closed ET day a stored reading's numbers cover ────────────────
// A reading's `etDate` is the day it was TAKEN, not the day its numbers end. A daily (morning)
// read sees only CLOSED days, so it covers through the day BEFORE etDate: the 10-29 reading
// carries 10-28 spend. Every dashboard place that shows a reading's date also shows this one
// (lib/metrics: the readings table's "Data through" column, the F3 read line), derived here once.

/** The fields the "data through" date is derived from (ReadingRecord has them all). */
export interface DataThroughInput {
  kind: string
  /** ET date the reading was taken (ads_readings.et_date). */
  etDate: string
  /** A stored data-through date, when the reading carries one: preferred over the derivation. */
  dataThrough?: string | null
}

const ET_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The last closed ET day (YYYY-MM-DD) a reading's numbers cover, or null when it cannot be told.
 *  - a stored `dataThrough`, when present and a date, wins;
 *  - daily, threshold and health reads: the day before `etDate` (only closed days are read);
 *  - post-flight reads: the same day-before cut, but spend and the flight's totals stop at the
 *    flight's last day (`flightEnd`; the --as-of backfill follows the same rule, its etDate is the
 *    as-of day), so a stage read taken weeks after the flight says the flight's last day. Without
 *    `flightEnd` a post-flight read's cut is unknown: null, never a guess.
 * The day arithmetic is on the calendar date (etTime addDays), so the 11-01 DST change moves nothing.
 */
export function readingDataThrough(r: DataThroughInput, flightEnd?: string | null): string | null {
  if (typeof r.dataThrough === 'string' && ET_DAY_RE.test(r.dataThrough)) return r.dataThrough
  if (typeof r.etDate !== 'string' || !ET_DAY_RE.test(r.etDate)) return null
  const dayBefore = addDays(r.etDate, -1)
  if (r.kind !== 'postflight') return dayBefore
  if (!flightEnd || !ET_DAY_RE.test(flightEnd)) return null
  return flightEnd < dayBefore ? flightEnd : dayBefore
}

/** "Oct 28" for the data-through date; null stays null. */
export const dataThroughText = (d: string | null): string | null => (d ? etDayText(d) : null)
