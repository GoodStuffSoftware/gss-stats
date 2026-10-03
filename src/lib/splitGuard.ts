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
// dimension: those rows are then left out of that query entirely. The metrics side (R-1b)
// imports SPLIT_REFUSED_PATH_PATTERNS so both halves read one list.

/** Dimensions that tie a row to an hour, a place or a device. `date`, `dateEt` and `flightDay`
 * are day-level and stay allowed; `site` (web vs. app) is a product split, not a device one. */
export const SPLIT_REFUSED_DIMS: ReadonlySet<string> = new Set([
  // time finer than an ET day
  'hourEt',
  // place
  'country', 'region', 'city', 'postal', 'continent', 'timezone', 'colo', 'org',
  // device
  'device', 'browser', 'os', 'lang', 'screenw', 'screenwBucket', 'visitor',
])

/** SQL LIKE patterns (bound as values, never interpolated) for the rows the rule protects:
 * on-device return-curve beacons, game completions (live and the legacy deferred path), and
 * tutorial completions (`first-run` / `replay` is something the device remembers about itself,
 * like the return day buckets). Each anchors on a full path segment with its trailing slash, so
 * `/game`, `/game/first-move`, `/tour/...` and other page views never match. No pattern contains
 * `_`, the other LIKE wildcard. SQLite's LIKE ignores ASCII case, so an off-vocabulary
 * `/RETURN/...` row is refused too: that errs toward refusing, never toward splitting. */
export const SPLIT_REFUSED_PATH_PATTERNS: readonly string[] = [
  '/return/%',
  '/game/complete/%',
  '/game/complete-deferred/%',
  '/game/tutorial-complete/%',
]

/** True when grouping, mapping or drilling by any of `fields` would split refused rows. */
export function splitRefused(opts: { points: boolean; fields: readonly string[] }): boolean {
  return opts.points || opts.fields.some((f) => SPLIT_REFUSED_DIMS.has(f))
}

/** Appends `NOT (path LIKE ? OR path LIKE ? ...)` to `w`, with every pattern pushed to `b` as a
 * bound value. */
export function refusedPathExcludeClause(w: string[], b: unknown[]): void {
  w.push(`NOT (${SPLIT_REFUSED_PATH_PATTERNS.map(() => 'path LIKE ?').join(' OR ')})`)
  b.push(...SPLIT_REFUSED_PATH_PATTERNS)
}
