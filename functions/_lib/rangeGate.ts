// Range gating for data sources that cap how wide, or how old, one query may be.
//
// WHY: Cloudflare's GraphQL Analytics API refuses a query whose time range is wider than the
// account's `maxDuration` or reaches back past its `notOlderThan`, with an error that used to
// reach the chart as raw JSON ("cannot request a time range wider than 13w2d"). We gate such
// a source BEFORE querying it: the requested range is cut to the most recent window the source
// allows, and a `RangeNotice` travels with the response so the chart can say so.
//
// WHERE THE LIMITS COME FROM: RANGE_LIMITS below is the one place they are declared. They are
// constants, checked against the API's own settings by `npm run limits:check`
// (scripts/check-range-limits.ts), rather than fetched per request. A fetch would add a
// round trip and a failure mode to every chart load for numbers that only change when the
// account's plan does; if they ever do change, `upstreamRejectedNotice` turns the API's refusal
// into the same chart note instead of an error, and the check script names the new values.
//
// Only sources that really have a limit appear here. The D1 datasets (the geo beacon `hits`, the
// ads store) have none: SQLite scans whatever range it is given. Sources are listed in README
// "Range limits".

import { addDays, etDateFast, etWallTimeMs } from '../../src/lib/etTime'
import type { RangeNotice } from '../../src/lib/rangeNotice'

const DAY_MS = 86_400_000

export interface RangeLimit {
  /** The Cloudflare GraphQL dataset the limits were read from (settings.<dataset>). */
  dataset: string
  /** `maxDuration`: the widest span one query may cover, in days. */
  maxDurationDays: number
  /** `notOlderThan`: how far back a query's start may reach, in days. */
  notOlderThanDays: number
}

export const RANGE_LIMITS = {
  // account.settings.rumPageloadEventsAdaptiveGroups, read 2026-10-03:
  // maxDuration 8035200 s (93 d = 13w2d), notOlderThan 15897600 s (184 d = 26w2d).
  'cf-rum': { dataset: 'rumPageloadEventsAdaptiveGroups', maxDurationDays: 93, notOlderThanDays: 184 },
} as const satisfies Record<RangeNotice['source'], RangeLimit>

export type RangeSource = keyof typeof RANGE_LIMITS

/** Slack on the lookback edge: the API measures "older than" against its own clock when the
 * request lands, a moment after ours. */
const LOOKBACK_MARGIN_MS = 60_000

/** The day a moved start is rounded up to, so the first served day is whole:
 *  - `et-day`: an ET midnight, like the rest of the dashboard (breakdown charts, totals);
 *  - `utc-day`: a UTC midnight, for a `date` series, because Cloudflare RUM's `date` dimension
 *    buckets by UTC day and a start at ET midnight (04:00Z) would leave the first bar partial. */
export type DayGrain = 'et-day' | 'utc-day'

/** The first day boundary of `grain` at or after `ms`. A moved start costs under a day. */
function ceilToDay(ms: number, grain: DayGrain): number {
  if (grain === 'utc-day') return Math.ceil(ms / DAY_MS) * DAY_MS
  const day = etDateFast(ms)
  const midnight = etWallTimeMs(day)
  return midnight >= ms ? midnight : etWallTimeMs(addDays(day, 1))
}

export interface GateResult {
  /** The range to query (ms). When `unservable`, there is none and these are the requested one. */
  fromMs: number
  toMs: number
  /** Null when the range was within the limits and is queried as asked. */
  notice: RangeNotice | null
  /** True when no part of the range is inside the source's lookback: do not query. */
  unservable: boolean
}

const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '')

/** Cut `[startMs, endMs)` to what `source` allows at `nowMs`, and ONLY when the source would
 * refuse it: a range it accepts is returned untouched (no notice), measured the way it measures
 * (span = `end - start` in elapsed time, so a range across a DST change is 1 h shorter than its
 * calendar days; lookback = how far `start` is before now). A range it would refuse is cut to the
 * most recent window it allows, with the new start rounded UP to a `grain` day boundary (never
 * down, so rounding can only make the window narrower and newer, never refusable). */
export function gateRange(source: RangeSource, startMs: number, endMs: number, nowMs: number, grain: DayGrain = 'et-day'): GateResult {
  const limit = RANGE_LIMITS[source]
  const base = {
    source,
    kind: 'range-clamped' as const,
    requested: { from: iso(startMs), to: iso(endMs) },
    limitDays: limit.maxDurationDays,
    lookbackDays: limit.notOlderThanDays,
    ...(grain === 'utc-day' ? { dayZone: 'utc' as const } : {}),
  }
  // Not a real range (unparseable or empty/reversed): leave it for the query to handle as before.
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs)) {
    return { fromMs: startMs, toMs: endMs, notice: null, unservable: false }
  }

  let from = startMs
  let lookback = false
  let duration = false

  // The oldest start the source accepts, with a margin for its clock. Only a start older than
  // this is moved; one inside it is left exactly as asked, even within a day of the edge.
  const oldestAccepted = nowMs - limit.notOlderThanDays * DAY_MS + LOOKBACK_MARGIN_MS
  if (from < oldestAccepted) {
    from = ceilToDay(oldestAccepted, grain)
    lookback = true
  }
  if (endMs <= from) {
    return { fromMs: startMs, toMs: endMs, notice: { ...base, reason: 'outside-lookback', served: null }, unservable: true }
  }
  if (endMs - from > limit.maxDurationDays * DAY_MS) {
    from = ceilToDay(endMs - limit.maxDurationDays * DAY_MS, grain)
    duration = true
  }

  if (!lookback && !duration) return { fromMs: startMs, toMs: endMs, notice: null, unservable: false }
  const reason = lookback && duration ? 'both' : lookback ? 'lookback' : 'max-duration'
  return { fromMs: from, toMs: endMs, notice: { ...base, reason, served: { from: iso(from), to: iso(endMs) } }, unservable: false }
}

/** Does a GraphQL error message say the range was too wide or too old? Cloudflare words them
 * `account "<id>" cannot request a time range wider than 13w2d, but your query ...` and
 * `account "<id>" cannot request data older than 26w2d, but your query ...`. */
export function isRangeLimitError(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false
  return errors.some((e) => typeof e?.message === 'string' && isRangeLimitText(e.message))
}

/** The same two messages found anywhere in a text: the body of a non-2xx reply, which may be
 * JSON (`{"errors":[{"message":"..."}]}`) or plain text. */
export function isRangeLimitText(text: string): boolean {
  return /cannot request (a time range wider than|data older than)/i.test(text)
}

/** The notice for a range the source refused although the constants let it through (its
 * limits changed, or a different dataset has different ones): nothing was served. */
export function upstreamRejectedNotice(source: RangeSource, startMs: number, endMs: number): RangeNotice {
  return {
    kind: 'range-clamped',
    source,
    reason: 'upstream-rejected',
    requested: { from: iso(startMs), to: iso(endMs) },
    served: null,
    // The constants were just contradicted, so do not repeat them.
    limitDays: null,
    lookbackDays: null,
  }
}
