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
//   - Segment and day cuts finer than an ET day in lib/metrics/facts.ts (`s`, `d`, `pf`, `uf`)
//     and the routine's hour buckets on campaign-attributed rows: each is a fixed instant
//     (a go-live, a flight boundary, a fix, an ET midnight or the same time on an earlier day)
//     that a count is cut at, never an hour-of-day split shown to anyone. Clamping sub-day
//     windows over refused rows to whole ET days is R-1d.

import { sqlLit } from './popupEvents'

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
