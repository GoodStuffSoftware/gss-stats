// Split guard — the server-side half of the "counts only" rule for retention beacons.
//
// Product rule (Mike, 2026-10-03): "counts only. Never tie beacon rows to a device, time or
// place." Read as ROWS only (decision A1): a device may remember its own first visit, and
// ET-day totals are fine, but a chart may never split return, completion or tutorial-completion
// rows by hour of day, by place, or by device (decision D1). The own-traffic exclusion
// (lib/campaigns.ts EXCLUSIONS, lib/ownExclusion.ts) is a separate, accepted single-row filter
// and is deliberately NOT touched here.
//
// Applied by functions/api/geo.ts whenever a query groups by, maps by, or drills into a refused
// dimension: those rows are then left out of that query entirely. The rest read the same list:
//   - /api/metrics (R-1b): the campaignPathVisitor fact reports a refused row's country bucket
//     `cb` as '' (lib/metrics/facts.ts), so a country column never counts one; the completion
//     metric takes no country param, and a card cannot put a country repeat over a metric that
//     refuses it (lib/metrics/validate.ts).
//   - /api/popups: its UTC-hour query leaves refused rows out (none is a pop-up event).
//   - the ads routine (scripts/ads-reads/beacon.ts): the site-wide hourly event read and the
//     per-country read leave refused rows out, and the Play line's /return/ read
//     (returnSitesQuery) fetches only each row's ET date, never its ts.
// The UTC `date` dimension is refused alongside `hourEt` (R-1b review): a UTC day minus the ET
// day of the same date is an evening band of hours. `dateEt` and `flightDay` stay allowed.
// Every JS-side check of "is this a refused row" is isSplitRefusedPath, never its own prefix test.
//
// WHAT STAYS ALLOWED, and why (rulings 2026-10-03, ~/.claude/DECISIONS.md):
//   - `arrival` (tagged / untagged / returning) and the metrics' new/returning `visitor` bit on a
//     refused row. Both read the same thing: whether the device had been seen before, which is
//     the device remembering its own first visit (allowed by A1). The Overview arrivals line and
//     the hour-of-day and flight-day charts read `arrival` over event rows, and
//     campaign.taggedArrivals counts visitor='new' rows on ANY path — a first-ever beacon that is
//     a /return/<uc>/d0 row is an arrival — so blanking either would change arrival counts and
//     break their parity with the KPI fact. The free `visitor` geo dimension stays refused: no
//     chart needs it as a split of its own.
//   - Segment and day cuts finer than an ET day in lib/metrics/facts.ts, and the routine's hour
//     buckets on campaign-attributed rows: see SEGMENT CUTS below.
//
// SUB-DAY WINDOWS (R-1d). A since/until window that is not whole ET days would cut refused rows
// at an hour the caller picks: three consecutive one-hour windows would read back per-hour counts.
// So a query over a table that holds refused rows counts them over whole ET days
// (refusedWindowClause, refusedRowWindow) and every other row over the exact window. Every
// refused window is [ET midnight, ET midnight), so any refused count a caller can get is a sum of
// whole ET-day totals, which A1 allows. The snap direction is ONE constant, REFUSED_WINDOW_SNAP:
//   - 'nearest' (Mike's ruling, 2026-10-03, shipped): each bound goes to the closest ET
//     midnight, by absolute distance to the one before and the one after (so 23 h and 25 h DST
//     days need no special case); an exact tie goes to the later midnight. The date picker sends
//     UTC 00:00 to 23:59:59.999Z, so a picked calendar day maps to the same-date ET day.
//   - 'outward': the ET midnight at or before since, and the one at or after until.
//   - 'inward': the first ET midnight at or after since, and the last one at or before until.
// In every mode an empty snapped window (from >= to) counts ZERO refused rows. A window already on
// ET midnights takes the unchanged path: same SQL, same binds, same cache key as before R-1d.
// Applied by functions/api/geo.ts (every branch, unless the split guard already leaves refused
// rows out), functions/api/completions.ts (every row is refused) and the /api/metrics `page`
// window (facts.ts bskRangePath; the engine adds the 'refused-whole-days' note). /api/popups'
// hourly read and the routine's per-hour and per-country reads already leave refused rows out.
// Today's refused totals stay live (ruling 2026-10-03: no hold until the ET day closes). A hold
// would cap refusedRowWindow's `to` at the open day's ET midnight; every caller already takes
// its refused bounds from there.
//
// SEGMENT CUTS that stay finer than an ET day, and why (each reviewed for R-1d and kept):
//   - `s` segments (go-lives, attribution starts, aligned-ratio go-lives): a few fixed registry
//     instants per deploy. A count split at one constant instant cannot be moved by a caller, so
//     it cannot build an hour-of-day series.
//   - The campaign attribution start `ts >= ?` (the noon-ET flight start): one instant per
//     campaign. A campaign's /return/<uc>/ and tagged rows cannot predate its own link, so the
//     cut only drops pre-launch QA rows.
//   - `pf` (install fix) and `uf` (upsell fix): one fixed instant each, a row-exact before/after.
//   - `d` KPI windows (today so far, and the same clock time on the 7 earlier days): the bounds
//     come from the server clock, never the caller. Today so far is the open ET day's running
//     total, which "ET-day totals are fine" allows, and each comparison window shows only what
//     that day's own running total showed live at the same clock time. Residual (worth knowing):
//     polling any running total over a day shows when it grew. Only inward snapping plus holding
//     the open day's refused totals would close that; Mike chose live data (2026-10-03).
//   - Flight boundaries (etFlightRangeMs, flightDaySqlCase) are ET days already.

import { addDays, etDateFast, etWallTimeMs } from './etTime'
import { sqlInt, sqlLit } from './popupEvents'

/** Dimensions that tie a row to an hour, a place or a device. `dateEt` and `flightDay` are ET-day
 * totals and stay allowed; `site` (web vs. app) is a product split, not a device one. */
export const SPLIT_REFUSED_DIMS: ReadonlySet<string> = new Set([
  // time finer than an ET day. `date` is a UTC day, which starts at 19:00 or 20:00 ET: its count
  // minus the `dateEt` count for the same day is the number of rows in that evening band, an
  // hour-of-day split by differencing (R-1b review, ruling 2026-10-03).
  'hourEt', 'date',
  // place
  'country', 'region', 'city', 'postal', 'continent', 'timezone', 'colo', 'org',
  // device
  'device', 'browser', 'os', 'lang', 'screenw', 'screenwBucket', 'visitor',
])

/** SQL LIKE patterns for the rows the rule protects: on-device return-curve beacons, game
 * completions (live and the legacy deferred path), counted game starts, tour exit steps, and
 * tutorial completions (`first-run` / `replay` is something the device remembers about itself,
 * like the return day buckets). Each anchors on a full path segment with its trailing slash, so
 * `/game`, `/game/first-move`, `/tour/start` and other page views never match. No pattern
 * contains `_`, the other LIKE wildcard. SQLite's LIKE ignores ASCII case, so an off-vocabulary
 * `/RETURN/...` row is refused too: that errs toward refusing, never toward splitting.
 * They are compile-time constants, never request input, so refusedPathMatch inlines them as SQL
 * literals (through sqlLit) instead of binding them. */
export const SPLIT_REFUSED_PATH_PATTERNS: readonly string[] = [
  '/return/%',
  '/game/complete/%',
  '/game/complete-deferred/%',
  '/game/tutorial-complete/%',
  // Best Sudoku 1.97.0 count-only beacons (R-1b): a counted game start and the tour step a
  // first run was left at. Only `/tour/exit-at/...` is refused; the other `/tour/...` rows stay
  // splittable.
  '/game/start/%',
  '/tour/exit-at/%',
]

/** The JS reading of SPLIT_REFUSED_PATH_PATTERNS, matching SQLite LIKE exactly (ASCII case
 * folded, prefix match), so a JS-side classifier can never disagree with the SQL guard. */
export function isSplitRefusedPath(path: string): boolean {
  const p = path.replace(/[A-Z]/g, (c) => c.toLowerCase())
  return SPLIT_REFUSED_PATH_PATTERNS.some((pat) => p.startsWith(pat.slice(0, -1)))
}

/** Changes whenever the pattern list does — part of a guarded query's cache key, so a cached
 * answer is never served under a different list. */
export const SPLIT_GUARD_KEY = SPLIT_REFUSED_PATH_PATTERNS.join('|')

/** The caption a chart shows when /api/geo answered with `meta.splitGuard: true`
 * (components/ChartCard.vue), so a smaller total never reads as missing data. */
export const SPLIT_GUARD_CAPTION =
  'Counts only: this split leaves out return, game start, completion, tutorial-completion and ' +
  'tour-exit rows, which are never shown by hour, place or device.'

/** True when grouping, mapping or drilling by any of `fields` would split refused rows. */
export function splitRefused(opts: { points: boolean; fields: readonly string[] }): boolean {
  return opts.points || opts.fields.some((f) => SPLIT_REFUSED_DIMS.has(f))
}

/** `(path LIKE '/return/%' OR ...)`, true for a refused row: for a WHERE clause or a CASE in a
 * SELECT list. The patterns are inlined as SQL literals through sqlLit, the same precedent as
 * lib/popupEvents.ts popupExcludeClause (the 2026-09-27 bind-ceiling fix): they are this module's
 * own constants, never request input, and binding them would spend six of D1's 100 bound
 * parameters on every guarded query. `binds` is always empty; it stays in the return type so the
 * callers need not change if a pattern ever has to travel as a value. */
export function refusedPathMatch(): { sql: string; binds: string[] } {
  const likes = SPLIT_REFUSED_PATH_PATTERNS.map((p) => `path LIKE ${sqlLit(p)}`)
  return { sql: `(${likes.join(' OR ')})`, binds: [] }
}

/** Appends `NOT (path LIKE '/return/%' OR ...)` to `w`. Pushes nothing to `b` (see
 * refusedPathMatch). */
export function refusedPathExcludeClause(w: string[], b: unknown[]): void {
  const m = refusedPathMatch()
  w.push(`NOT ${m.sql}`)
  b.push(...m.binds)
}

// ---- R-1d: whole ET days for refused rows on sub-day windows (header: SUB-DAY WINDOWS) ----

export type RefusedSnap = 'nearest' | 'outward' | 'inward'

/** THE switch. 'nearest' is Mike's ruling (2026-10-03); the other two modes stay buildable. */
export const REFUSED_WINDOW_SNAP: RefusedSnap = 'nearest'

/** Part of a snapped query's cache key (only when the window actually moved), so changing the
 * mode never serves an answer cached under another one. */
export const REFUSED_WINDOW_KEY = `refused-${REFUSED_WINDOW_SNAP}-et-days-v1`

/** The caption a chart shows when its query answered with `meta.refusedWholeDays: true`
 * (components/ChartCard.vue), worded to fit every snap mode. */
export const REFUSED_WHOLE_DAYS_CAPTION = 'Return and completion rows are counted over whole ET days.'

/** One sample path per SPLIT_REFUSED_PATH_PATTERNS entry (a test keeps them in step), for a
 * static "can this path predicate count a refused row" check (the metrics engine's note). */
export const REFUSED_SAMPLE_PATHS: readonly string[] = [
  '/return/x/d0',
  '/game/complete/normal/easy',
  '/game/complete-deferred/normal/easy',
  '/game/tutorial-complete/first-run',
  '/game/start/easy',
  '/tour/exit-at/1',
]

/** The ET midnight at or before `ms`. ET midnight is never on a DST change (those are at 02:00). */
function etMidnightFloor(ms: number): number {
  return etWallTimeMs(etDateFast(ms), '00:00')
}

/** The ET midnight at or after `ms`. */
function etMidnightCeil(ms: number): number {
  const floor = etMidnightFloor(ms)
  return floor === ms ? ms : etWallTimeMs(addDays(etDateFast(ms), 1), '00:00')
}

/** The closest ET midnight to `ms` by absolute distance (so 23 h and 25 h days need no special
 * case); an exact tie goes to the later one. */
function etMidnightNearest(ms: number): number {
  const floor = etMidnightFloor(ms)
  if (floor === ms) return ms
  const ceil = etMidnightCeil(ms)
  return ms - floor < ceil - ms ? floor : ceil
}

/** True when `ms` is an ET midnight. */
export function isEtMidnight(ms: number): boolean {
  return Number.isFinite(ms) && etMidnightFloor(ms) === ms
}

/** Whether [since, until) is already whole ET days (both bounds ET midnights). */
export function isWholeEtDays(sinceMs: number, untilMs: number): boolean {
  return isEtMidnight(sinceMs) && isEtMidnight(untilMs)
}

/** [from, to) that refused rows are counted over for a request window [since, until). Both bounds
 * are ET midnights; from >= to means the window counts no refused rows. A window that is
 * non-finite, reversed or already whole ET days comes back unchanged. */
export function refusedRowWindow(
  sinceMs: number,
  untilMs: number,
  snap: RefusedSnap = REFUSED_WINDOW_SNAP,
): [number, number] {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs >= untilMs) return [sinceMs, untilMs]
  if (isWholeEtDays(sinceMs, untilMs)) return [sinceMs, untilMs]
  if (snap === 'outward') return [etMidnightFloor(sinceMs), etMidnightCeil(untilMs)]
  if (snap === 'inward') return [etMidnightCeil(sinceMs), etMidnightFloor(untilMs)]
  return [etMidnightNearest(sinceMs), etMidnightNearest(untilMs)]
}

/** True when refusedRowWindow moves [since, until) (the caption, note and cache-key marker case). */
export function refusedWindowMoved(
  sinceMs: number,
  untilMs: number,
  snap: RefusedSnap = REFUSED_WINDOW_SNAP,
): boolean {
  const [from, to] = refusedRowWindow(sinceMs, untilMs, snap)
  return from !== sinceMs || to !== untilMs
}

/** WHERE terms and binds for [since, until) over a table that holds refused rows. Refused rows
 * count over refusedRowWindow, every other row over the exact window. Never more binds than the
 * plain pair:
 *   - unmoved: exactly ['ts >= ?', 'ts < ?'] / [since, until] (byte-identical to before R-1d);
 *   - empty refused window: the plain pair plus `NOT <refused>`;
 *   - otherwise the pair spans both windows and one CASE term picks each row's own window, with
 *     both windows' bounds inlined as integers (sqlInt; `ts` is an INTEGER column).
 * `moved` drives the cache-key marker, `meta.refusedWholeDays` and the metrics note. */
export function refusedWindowClause(
  sinceMs: number,
  untilMs: number,
  snap: RefusedSnap = REFUSED_WINDOW_SNAP,
): { terms: string[]; binds: number[]; moved: boolean } {
  const [from, to] = refusedRowWindow(sinceMs, untilMs, snap)
  if (from === sinceMs && to === untilMs) {
    return { terms: ['ts >= ?', 'ts < ?'], binds: [sinceMs, untilMs], moved: false }
  }
  const m = refusedPathMatch()
  if (from >= to) return { terms: ['ts >= ?', 'ts < ?', `NOT ${m.sql}`], binds: [sinceMs, untilMs], moved: true }
  const pick =
    `(CASE WHEN ${m.sql} THEN (ts >= ${sqlInt(from)} AND ts < ${sqlInt(to)}) ` +
    `ELSE (ts >= ${sqlInt(sinceMs)} AND ts < ${sqlInt(untilMs)}) END)`
  return {
    terms: ['ts >= ?', 'ts < ?', pick],
    binds: [Math.min(sinceMs, from), Math.max(untilMs, to)],
    moved: true,
  }
}
