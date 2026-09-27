/// <reference types="@cloudflare/workers-types" />
//
// Geo dataset — bot-free sub-country geography from the beacon's D1 store
// (request.cf.region/city, written by gss-beacon). Same response shape as
// /api/stats so the dashboard can chart it identically.
//
// POST { dimension, since, until, limit, site? }  (geo is already bot-free; the
// RUM self/referral filters don't apply.)
//
// Nested doughnuts (N-ring breakdowns) send an additional `dims: string[]` — the FULL
// ordered ring list (2+ dims, deduped, 'date' excluded) — which supersedes `dimension`/
// `breakdown` for the grouped query below. Older 2-dim callers can still send just
// { dimension, breakdown } and get the same result via a fallback.

import { popupExcludeClause, pathFamilySqlCase, popupDimSqlCase, popupDimPrefilter } from '../../src/lib/popupEvents'
import { gameDimSqlCase, gameDimPrefilter, campaignFlightSqlCase, campaignFlightPrefilter, arrivalSqlCase, keyEventSqlCase, flightDaySqlCase, applyExclusions } from '../../src/lib/campaigns'
import { excludeOwnClause as sharedExcludeOwnClause, selfReferralClause as sharedSelfReferralClause } from '../../src/lib/ownExclusion'
import { etDateSql, etHourSql } from '../../src/lib/etTime'
import { isDateDim } from '../../src/lib/rings'
import { buildCacheKeyUrl, cachedJson, ttlSecondsFor, type CacheLike } from '../_lib/edgeCache'
import { WHEN_RE, SITE_TAG_RE } from '../../src/lib/range'

interface Env {
  gss_geo: D1Database
}

// ── Merged total+grouped SQL builders ───────────────────────────────────────────────
//
// Each chart panel used to fire TWO scans of `hits` for the same WHERE clause: one
// `SELECT COUNT(*) ... GROUP BY` (or none, for the total) and one bare `SELECT COUNT(*)` for
// the grand total — doubling rows_read for every chart. A single statement gets the same two
// numbers from one scan: the inner query aggregates once, and SUM(c) OVER () sums that
// aggregate — not the raw rows — across ALL groups (there's no PARTITION BY, so the window
// spans the whole inner result set) BEFORE the outer ORDER BY/LIMIT truncates to the top-N.
// That ordering (window function evaluated over the complete row set, then LIMIT applied last)
// is standard SQL and is what makes `total` reflect every group even when LIMIT keeps only a
// handful — verified against a real SQLite engine in geo.mergedSql.test.ts.
//
// Exported so that equivalence test can run the exact production SQL against a fixture DB
// without spinning up a full PagesFunction request.
// `dim` is trusted here (GEO_DIMS already gated it before this is ever called) — never pass a
// request-controlled string straight into this function. 'date', 'screenwBucket' and
// 'pathFamily' are DERIVED — computed from real columns via CASE/date(), not a bare column
// reference — so each gets its own branch; every other dim is a real TEXT/INTEGER column,
// blank-labeled the same way they always were.
export function breakdownColumnExpr(dim: string, emptyLabel: string): string {
  if (dim === 'date') return "date(ts/1000,'unixepoch')"
  // US-Eastern calendar day (DST-aware), matching how the Best Sudoku code buckets ET days.
  if (dim === 'dateEt') return etDateSql()
  // US-Eastern hour of day ('0'..'23'), DST-aware like 'dateEt' (the campaigns hour-of-day chart).
  if (dim === 'hourEt') return etHourSql()
  if (dim === 'pathFamily') return pathFamilySqlCase()
  // Pop-up / completion / campaign-flight dims: CASE expressions over path (and ts/campaign),
  // built only from lib/popupEvents.ts + lib/campaigns.ts constants (never request input); see
  // those modules for each dimension's meaning and why its literals are inlined.
  if (dim === 'popupFamily' || dim === 'popupOutcome') return popupDimSqlCase(dim, emptyLabel)
  if (dim === 'gameMode' || dim === 'gameDifficulty') return gameDimSqlCase(dim, emptyLabel)
  if (dim === 'campaignFlight') return campaignFlightSqlCase(emptyLabel)
  if (dim === 'flightDay') return flightDaySqlCase(emptyLabel)
  if (dim === 'arrival') return arrivalSqlCase(emptyLabel)
  if (dim === 'keyEvent') return keyEventSqlCase(emptyLabel)
  // screenw is INTEGER, default 0 when the client never reported a viewport width (JS
  // blocked/failed before the measurement ran) — 0 is the "blank" sentinel here, not ''.
  if (dim === 'screenw') return `CASE WHEN screenw = 0 THEN '${emptyLabel}' ELSE CAST(screenw AS TEXT) END`
  if (dim === 'screenwBucket') {
    return (
      `CASE WHEN screenw = 0 THEN '${emptyLabel}' ` +
      `WHEN screenw < 480 THEN '<480' WHEN screenw < 768 THEN '480-767' ` +
      `WHEN screenw < 1024 THEN '768-1023' WHEN screenw < 1440 THEN '1024-1439' ELSE '1440+' END`
    )
  }
  return `CASE WHEN ${dim} = '' THEN '${emptyLabel}' ELSE ${dim} END`
}

// The blank-value label a dimension's rows get bucketed under — one place both the single-dim
// breakdown path and the ring (N-dimension) path read, so they can never disagree about what
// "blank" is called for a given dim. `dim` is trusted (see breakdownColumnExpr above).
export function emptyLabelFor(dim: string): string {
  if (dim === 'referrer') return '(direct)'
  if (dim === 'campaign' || dim === 'source' || dim === 'medium') return '(untagged)'
  if (dim === 'screenw' || dim === 'screenwBucket') return '(unknown)'
  return '(none)'
}

// The WHERE-clause fragment that excludes a ring dimension's blank rows — ring mode has always
// excluded blanks outright (never bucketed them under a label the way single-dim breakdown
// does), so a ring never nests an "(unknown)"/"(none)" branch. `screenw` is INTEGER; its blank
// sentinel is 0, never the empty STRING every TEXT column's blank test (`= ''`) compares
// against — SQLite's type ordering means an INTEGER can never equal a TEXT literal, so
// `screenw <> ''` is a no-op (always true, excludes nothing), letting blank rows leak into the
// ring as a raw "0" key instead of being dropped like every other dimension's blanks.
// A DERIVED dimension has no column to test, so its blank test is the expression itself with an
// empty blank label, compared against '' (screenwBucket: a 0-width row; the pop-up/completion/
// flight dims: a row they don't describe; pathFamily is never blank).
export function ringBlankExclusion(dim: string): string {
  if (DERIVED_ONLY_DIMS.has(dim)) return `(${breakdownColumnExpr(dim, '')}) <> ''`
  return dim === 'screenw' ? 'screenw <> 0' : `${dim} <> ''`
}

// `orderBy` should include a tiebreak (e.g. "c DESC, k ASC") — without one, which rows LIMIT
// keeps among an exact-count tie is unspecified, and the two query PLANS being compared here
// (a bare GROUP BY vs. one wrapped in a subquery) aren't guaranteed to break ties the same way,
// even reading the identical data. The caller (onRequestPost below) always supplies a full order.
export function buildMergedBreakdownSql(col: string, whereSql: string, orderBy: string): string {
  return `SELECT k, c, SUM(c) OVER () AS total FROM (SELECT ${col} AS k, COUNT(*) AS c FROM hits WHERE ${whereSql} GROUP BY k) ORDER BY ${orderBy} LIMIT ?`
}

// `cols` (e.g. `["region AS k0", "device AS k1"]`) aliases the real columns to k0..kN for the
// INNER aggregate only — the outer query selects the derived table's own `k0, k1, ...` (via
// `groupBy`, which is already that same "k0, k1" list), not the original column names, since
// only the inner subquery has `hits` in scope. Tiebreaks on the group columns themselves after
// `c DESC` — without it, which rows LIMIT keeps among an exact-count tie is unspecified, and
// can differ from one query PLAN to another even for the same data (see buildMergedBreakdownSql).
export function buildMergedRingSql(cols: string[], whereSql: string, groupBy: string): string {
  return `SELECT ${groupBy}, c, SUM(c) OVER () AS total FROM (SELECT ${cols.join(', ')}, COUNT(*) AS c FROM hits WHERE ${whereSql} GROUP BY ${groupBy}) ORDER BY c DESC, ${groupBy} LIMIT ?`
}

// Every analytic column on `hits`, plus the derived (non-column) dimensions below — this Set
// is the whitelist / security boundary: a dimension or constraint field name is NEVER used in
// a query unless it's a member of this Set (see dim/constraints below). Deliberately excluded:
// `id` (autoincrement row id, not analytic), `ts` (raw timestamp — only the 'date' bucket is
// exposed, never the millisecond value), `lat`/`lon` (only usable as map-mode coordinates, not
// a sensible group-by/filter value), and `in_app` (schema.sql / gss-beacon's migrate-in-app.sql
// define it, but production `gss-geo` has NOT had that migration run yet — confirmed live via
// `PRAGMA table_info(hits)` 2026-09-26, 25 columns, no `in_app`; whitelisting it now would 500
// every query that touched it the moment someone charted it. Add it once the migration runs).
export const GEO_DIMS = new Set([
  'country', 'region', 'city', 'postal', 'continent', 'timezone', 'colo', 'org',
  'referrer', 'refpath', 'path', 'site', 'device', 'browser', 'os', 'lang', 'visitor', 'date', 'dateEt',
  'campaign', 'source', 'medium', // utm campaign tags
  'screenw', 'screenwBucket', // viewport width — raw pixel value, and bucketed (see breakdownColumnExpr)
  'pathFamily', // groups event-beacon paths (popup/install/return/game-complete/…) vs. 'page' — see popupEvents.ts
  'popupFamily', 'popupOutcome', // which pop-up / shown-tap-outcome — see popupEvents.ts popupDimSqlCase
  'gameMode', 'gameDifficulty', // /game/complete/<mode>/<difficulty> — see campaigns.ts gameDimSqlCase
  'campaignFlight', // campaign flight by campaignAttributionClause — see campaigns.ts campaignFlightSqlCase
  'arrival', 'keyEvent', // first-ever beacon tagged/untagged; sign-in/install/completion rows — see campaigns.ts
  'hourEt', // US-Eastern hour of day — see etTime.ts etHourSql
  'flightDay', // day of the row's campaign flight, '1' = its first ET day — see campaigns.ts flightDaySqlCase
])

// Dimensions with no real backing column — computed via CASE/date() in breakdownColumnExpr,
// not a bare column reference. Same rule 'date' has always followed for GROUPING: usable as
// the SOLE group-by dimension of a single-dim breakdown, but never as a ring/nested-doughnut
// column (buildMergedRingSql aliases `${d} AS k${i}` against a real column, which a derived
// expression isn't). screenwBucket/pathFamily ARE still filterable, though — see
// DERIVED_FILTER_EXPR below, which wraps the same CASE expression in a bound-parameter
// equality instead of a bare column reference. 'date' alone stays fully out of filtering too:
// a click on a date bucket becomes a day RANGE client-side (lib/drill.ts), never an equality
// constraint, so nothing ever sends it as one.
export const DERIVED_ONLY_DIMS = new Set(['date', 'dateEt', 'screenwBucket', 'pathFamily', 'popupFamily', 'popupOutcome', 'gameMode', 'gameDifficulty', 'campaignFlight', 'arrival', 'keyEvent', 'hourEt', 'flightDay'])
// Of those, only 'date' stays out of multi-dimension (ring / breakdown-bar) queries: every other
// derived dim groups like a column (its CASE runs per row in the inner SELECT, and
// ringBlankExclusion drops its blank rows). A date axis is a trend, which lib/rings.ts
// queryDims already keeps to single-dim charts.
export const RING_EXCLUDED_DIMS = new Set(['date', 'dateEt'])

// Dimensions that describe EVENT-beacon rows only. A chart grouping by one (or a drill filtering
// on one) cannot also apply the standing event-beacon exclusion (it would remove every row the
// dimension describes), so the exclusion is lifted for that chart and the dimension's own bound
// prefilter applies instead (only rows of that event family). Their blank rows are dropped even
// in single-dim mode, so a page view never shows up as a "(none)" bar.
export const EVENT_DIMS = new Set(['popupFamily', 'popupOutcome', 'gameMode', 'gameDifficulty', 'keyEvent'])
// Dims whose charts/filters lift the standing event-beacon exclusion: the event dims, plus
// 'arrival' — a device's first-ever beacon can itself be an event row (e.g. an install prompt),
// and /api/campaigns counts it as a tagged arrival, so the timeline's arrivals line must too.
export const EXCLUSION_LIFTING_DIMS = new Set([...EVENT_DIMS, 'arrival'])

// Bound WHERE prefilters for dims that only describe a subset of rows (cheap, and keeps the CASE
// evaluation to rows that can carry a value). campaignFlight is not an event dim: a tagged row
// is often a page view, so it keeps the chart's own event-beacon setting.
const DIM_PREFILTERS: Record<string, (w: string[], b: unknown[]) => void> = {
  popupFamily: popupDimPrefilter,
  popupOutcome: popupDimPrefilter,
  gameMode: gameDimPrefilter,
  gameDifficulty: gameDimPrefilter,
  campaignFlight: campaignFlightPrefilter,
  flightDay: campaignFlightPrefilter, // only a tagged row can be in a flight
}
// Dims whose blank rows are dropped in single-dim mode too (see EVENT_DIMS above).
const BLANK_DROPPED_DIMS = new Set([...EVENT_DIMS, 'campaignFlight', 'arrival', 'flightDay'])

// screenwBucket / pathFamily as FILTERS: the exact same whitelisted CASE expression breakdown
// mode groups by, wrapped in `(<expr>) = ?` with the value bound as a parameter — never string-
// interpolated. Both expressions are built from GEO_DIMS-gated dimension names and this file's
// own static prefix list (never request input), so wrapping them in a WHERE clause carries no
// injection risk; it costs one extra CASE evaluation per row already being scanned; the WHERE
// still leads with `ts >= ? AND ts < ?`, so the `idx_hits_ts`/`idx_hits_site_ts` range-scan
// applies exactly as it does for every other filter here, and a CASE with no subquery isn't
// something SQLite can push into an index anyway — see docs/capacity.md's measurement.
const DERIVED_FILTER_EXPR: Record<string, string> = {
  screenwBucket: breakdownColumnExpr('screenwBucket', '(unknown)'),
  pathFamily: breakdownColumnExpr('pathFamily', ''),
  popupFamily: breakdownColumnExpr('popupFamily', ''),
  popupOutcome: breakdownColumnExpr('popupOutcome', ''),
  gameMode: breakdownColumnExpr('gameMode', ''),
  gameDifficulty: breakdownColumnExpr('gameDifficulty', ''),
  campaignFlight: breakdownColumnExpr('campaignFlight', ''),
  arrival: breakdownColumnExpr('arrival', ''),
  keyEvent: breakdownColumnExpr('keyEvent', ''),
  hourEt: breakdownColumnExpr('hourEt', ''),
  flightDay: breakdownColumnExpr('flightDay', ''),
}

export const MAX_SITES = 50
export const MAX_CONSTRAINTS = 16
// D1's own statement limits: 100 bound parameters per query, and a SQL text cap (100 KB). A
// statement over either is refused here with a clear 400 BEFORE it reaches D1, so the chart
// says what to change instead of surfacing a database error. 90,000 bytes leaves headroom.
export const MAX_BOUND_PARAMS = 100
export const MAX_SQL_BYTES = 90_000
/** A clear 400 when a statement would exceed D1's limits, else null. */
export function statementTooLarge(sql: string, bindCount: number): Response | null {
  if (bindCount > MAX_BOUND_PARAMS) {
    return json({ error: `this chart's filters are too many to query at once (${bindCount} values; at most ${MAX_BOUND_PARAMS}): select fewer sites or filters` }, 400)
  }
  const bytes = new TextEncoder().encode(sql).length
  if (bytes > MAX_SQL_BYTES) {
    return json({ error: `this chart's filters make the query too large (${bytes} bytes; at most ${MAX_SQL_BYTES}): use fewer pop-up filters` }, 400)
  }
  return null
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

function safeDate(v: unknown, fallback: string): string {
  return typeof v === 'string' && WHEN_RE.test(v) ? v : fallback
}
const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: any
  try {
    body = await ctx.request.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  if (!ctx.env.gss_geo) return json({ error: 'geo DB not bound' }, 500)

  const dim: string = GEO_DIMS.has(body.dimension) ? body.dimension : 'region'
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 500)
  const today = new Date().toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
  const since = safeDate(body.since, weekAgo)
  const until = safeDate(body.until, today)
  const sinceMs = Date.parse(since)
  const untilMs = isDateOnly(until) ? Date.parse(until) + 86_400_000 : Date.parse(until) // legacy day = inclusive
  // Beacon-site filter — a list of site tags (e.g. ["starrupture","simpletile",
  // "goodstuff"]) mapped from the Site/Subdomain selectors, or a single legacy
  // `site`. Empty / "all" = no filter.
  const rawSites: unknown[] = Array.isArray(body.sites) ? body.sites : body.site != null ? [body.site] : []
  // Hard caps on request size (defense in depth: every site and constraint becomes a bound
  // parameter, and D1 allows 100 per query). A clear 400, never a D1 error.
  if (rawSites.length > MAX_SITES) return json({ error: `too many sites (at most ${MAX_SITES})` }, 400)
  if (Array.isArray(body.constraints) && body.constraints.length > MAX_CONSTRAINTS) {
    return json({ error: `too many filters (at most ${MAX_CONSTRAINTS})` }, 400)
  }
  const sites = rawSites.filter(
    (s): s is string => typeof s === 'string' && s !== 'all' && SITE_TAG_RE.test(s),
  )
  const siteClause = (w: string[], b: any[]) => {
    if (sites.length) {
      w.push(`site IN (${sites.map(() => '?').join(', ')})`)
      b.push(...sites)
    }
  }
  // Drill-down constraints — exact field = value on a whitelisted column, OR (for screenwBucket/
  // pathFamily) the same whitelisted derived CASE expression compared to a bound parameter (see
  // DERIVED_FILTER_EXPR above). 'date' is the one dimension excluded here: a click on a date
  // bucket becomes a day RANGE client-side (lib/drill.ts), never an equality constraint, so it
  // never arrives as one — excluding it is defense in depth, not something a real client sends.
  const constraints: { field: string; value: string }[] = Array.isArray(body.constraints)
    ? (body.constraints as any[])
        .filter((c) => c && GEO_DIMS.has(c.field) && !isDateDim(c.field) && typeof c.value === 'string')
        .map((c) => ({ field: String(c.field), value: String(c.value) }))
    : []
  const drillClause = (w: string[], b: any[]) => {
    for (const c of constraints) {
      const derivedExpr = DERIVED_FILTER_EXPR[c.field]
      if (derivedExpr) {
        // The CASE expression already produces the exact label string for every row, including
        // its own blank/default bucket ('(unknown)' / 'page') — a plain bound equality matches
        // correctly with no separate blank-value branch needed.
        w.push(`(${derivedExpr}) = ?`)
        b.push(c.value)
      } else if (c.field === 'screenw' && (c.value === '(unknown)' || c.value === '(direct)' || c.value === '(none)')) {
        // screenw is INTEGER; its blank sentinel is 0, never the empty STRING '' a TEXT
        // column's blank label maps to below — SQLite's type ordering means an INTEGER can
        // never equal a TEXT literal, so `screenw = ''` would silently match zero rows.
        w.push(`screenw = 0`)
      } else if (c.value === '(direct)' || c.value === '(none)') {
        // "(direct)" / "(none)" are the labels we show for blank TEXT-column values → match empty.
        w.push(`${c.field} = ''`)
      } else {
        w.push(`${c.field} = ?`)
        b.push(c.value)
      }
    }
  }

  // "Hide my own visits" + "exclude self-referrals" — same semantics as functions/api/stats.ts
  // (RUM), applied here too so RUM and beacon charts agree on the same toggles instead of only
  // RUM honoring them (lowers beacon numbers when active — that's intended: the owner's own
  // visits/self-referrals stop being counted, same as RUM already does). Shared with
  // functions/api/campaigns.ts via ../../src/lib/ownExclusion.ts.
  const excludeOwn = body.excludeOwnVisits === true
  const excludeOwnClause = (w: string[], b: any[]) => sharedExcludeOwnClause(w, b, excludeOwn, body.ownBrowser, body.ownOS)

  // On by default (mirrors stats.ts's `!== false`), but only actually filters a query that
  // groups by 'referrer' — mirroring stats.ts's `dims.includes('refererHost')` scoping, so a
  // region/city/etc. chart (or the map, which has no group-by dim at all) is never silently
  // zeroed by a referrer-only exclusion. Also drops blank/direct rows when active, exactly
  // matching RUM's existing "clean external referrer list" behavior — this fix is about
  // making the two datasets AGREE, not diverging into new behavior.
  const excludeSelf = body.excludeSelfReferrals !== false
  const selfReferralClause = (activeDims: string[], w: string[], b: any[]) => sharedSelfReferralClause(activeDims, w, b, excludeSelf)

  // "Include event beacons" — per-chart opt-in (default OFF, so every existing chart keeps
  // excluding pop-up/install/return/game-complete/auth-status rows exactly as before) to lift
  // popupExcludeClause and chart event paths too (e.g. the new 'pathFamily' dimension, or a
  // 'path' breakdown that should show /popup-outcome/... rows). See src/lib/popupEvents.ts.
  const includeEventBeacons = body.includeEventBeacons === true

  // "Hide known test and household traffic" — per-chart opt-in (default off): applies
  // lib/campaigns.ts EXCLUSIONS (lifecycle email, deckhand verification, the owner's household),
  // the same row filters the campaigns and overview endpoints apply, so a beacon chart can match
  // their numbers (the Overview timeline sets it).
  const excludeKnownTraffic = body.excludeKnownTraffic === true
  const knownTrafficClause = (w: string[], b: any[]) => {
    if (excludeKnownTraffic) applyExclusions(w, b)
  }

  const isPoints = dim === 'points' || body.dimension === 'points'
  // N-dimension breakdown (nested doughnut / stacked bar / table on geo data). `body.dims` is
  // the full ordered ring list a nested doughnut sends (see api.ts); a legacy 2-dim caller
  // that only sends { dimension, breakdown } gets the same result via the fallback below.
  // Hard-capped independent of the client's own soft cap — defense in depth against a
  // malformed/oversized request, not a UX limit (that lives in ChartEditor.vue).
  const RING_DIMS_HARD_CAP = 8
  const legacyBreakdown =
    typeof body.breakdown === 'string' && GEO_DIMS.has(body.breakdown) && body.breakdown !== dim && !RING_EXCLUDED_DIMS.has(body.breakdown)
      ? body.breakdown
      : null
  const ringDims: string[] = (
    Array.isArray(body.dims)
      ? [...new Set((body.dims as unknown[]).filter((d): d is string => typeof d === 'string' && GEO_DIMS.has(d) && !RING_EXCLUDED_DIMS.has(d)))]
      : legacyBreakdown
        ? [dim, legacyBreakdown]
        : []
  ).slice(0, RING_DIMS_HARD_CAP)
  const isRing = !isPoints && ringDims.length >= 2 && !RING_EXCLUDED_DIMS.has(dim)
  // The dims this query groups by (none in points mode). They decide the event-beacon exclusion
  // lift and which prefilters apply (see EVENT_DIMS / DIM_PREFILTERS above). A drill on an event
  // dim lifts the exclusion too, for the same reason.
  const activeDims: string[] = isPoints ? [] : isRing ? ringDims : [dim]
  const eventDimActive = [...activeDims, ...constraints.map((c) => c.field)].some((d) => EXCLUSION_LIFTING_DIMS.has(d))
  const eventRowsClause = (w: string[], b: any[]) => {
    if (!includeEventBeacons && !eventDimActive) popupExcludeClause(w, b) // events, not screen views: excluded unless opted in
    const seen = new Set<(w: string[], b: unknown[]) => void>()
    for (const d of activeDims) {
      const pre = DIM_PREFILTERS[d]
      if (pre && !seen.has(pre)) {
        seen.add(pre)
        pre(w, b)
      }
    }
  }

  // Everything that changes the SQL (and therefore the response) goes into the cache key —
  // mode, dims/dim, the date window, site selection, drill constraints, and both exclusion
  // toggles. `sites`/`constraints` are sorted for the key only (their order never changes the
  // query result, so two requests differing only in array order should share a cache entry);
  // `ringDims` keeps client order since it changes the response's ring nesting.
  const cacheKeyUrl = buildCacheKeyUrl('/api/geo', {
    mode: isPoints ? 'points' : isRing ? 'ring' : 'breakdown',
    dim,
    ringDims,
    since,
    until,
    limit,
    sites: [...sites].sort(),
    constraints: [...constraints].sort((a, b) => (a.field + a.value).localeCompare(b.field + b.value)),
    excludeOwn,
    ownBrowser: excludeOwn ? String(body.ownBrowser ?? '') : '',
    ownOS: excludeOwn ? String(body.ownOS ?? '') : '',
    excludeSelf,
    includeEventBeacons,
    excludeKnownTraffic,
  })
  const ttl = ttlSecondsFor(until, new Date())
  const cache = (caches as unknown as { default: CacheLike }).default

  return cachedJson(cache, cacheKeyUrl, ttl, ctx.waitUntil.bind(ctx), () => computeGeoResponse())

  async function computeGeoResponse(): Promise<Response> {
  // Map mode: return one point per distinct lat/lon with a count (for globe/map charts).
  if (isPoints) {
    const w: string[] = ['ts >= ?', 'ts < ?', "lat <> ''"]
    const b: any[] = [sinceMs, untilMs]
    eventRowsClause(w, b) // events, not screen views — excluded unless opted in
    knownTrafficClause(w, b)
    siteClause(w, b)
    drillClause(w, b)
    excludeOwnClause(w, b)
    selfReferralClause([], w, b) // points mode has no group-by dim, so this is always inert
    const sql = `SELECT lat, lon, city, region, country, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY lat, lon ORDER BY c DESC LIMIT ?`
    b.push(Math.min(limit, 2000))
    const tooLarge = statementTooLarge(sql, b.length)
    if (tooLarge) return tooLarge
    let r: any
    try {
      r = await ctx.env.gss_geo.prepare(sql).bind(...b).all()
    } catch (e) {
      console.error('geo: d1 query failed', e)
      return json({ error: 'd1 query failed' }, 500)
    }
    const rows = (r.results ?? []).map((x: any) => ({
      key: {
        lat: String(x.lat ?? ''),
        lon: String(x.lon ?? ''),
        city: String(x.city ?? ''),
        region: String(x.region ?? ''),
        country: String(x.country ?? ''),
      },
      pageviews: Number(x.c) || 0,
      visits: Number(x.c) || 0,
    }))
    const totals = rows.reduce(
      (a: any, x: any) => ({ pageviews: a.pageviews + x.pageviews, visits: a.visits + x.visits }),
      { pageviews: 0, visits: 0 },
    )
    return json({ rows, totals, meta: { site: sites.length ? sites.join(',') : 'all', since, until, dimensions: ['points'], metric: 'pageviews', dataset: 'geo' } })
  }

  if (isRing) {
    // Route every ring column through breakdownColumnExpr (same as single-dim mode) rather
    // than a bare column reference — a real column's own formatting (e.g. screenw's
    // CAST(... AS TEXT)) is applied uniformly, and if a blank row were ever to reach here
    // (it shouldn't: ringBlankExclusion below drops them first) it would still render as its
    // proper label instead of a raw column value.
    const cols = ringDims.map((d, i) => `${breakdownColumnExpr(d, emptyLabelFor(d))} AS k${i}`)
    // Ring mode has always EXCLUDED a dimension's blank rows outright (never bucketed them
    // under a label the way single-dim breakdown does) — ringBlankExclusion is the
    // type-correct version of that per-dim test (screenw is INTEGER; every other ring
    // dimension is TEXT).
    const w: string[] = ['ts >= ?', 'ts < ?', ...ringDims.map(ringBlankExclusion)]
    const b: any[] = [sinceMs, untilMs]
    eventRowsClause(w, b) // events excluded unless opted in, or the dims describe events
    knownTrafficClause(w, b)
    siteClause(w, b)
    drillClause(w, b)
    excludeOwnClause(w, b)
    selfReferralClause(ringDims, w, b) // inert unless 'referrer' is one of the ring dims
    const whereSql = w.join(' AND ')
    const groupBy = ringDims.map((_, i) => `k${i}`).join(', ')
    // Each extra ring dimension multiplies the possible distinct combinations, so a 2-ring
    // request keeps its original fetch/cap exactly (identical behavior); N>2 over-fetches
    // more generously so deep rings aren't truncated before the nested grouping sees them.
    const fetchLimit =
      ringDims.length <= 2 ? Math.min(limit * 4, 1000) : Math.min(limit * 4 * (ringDims.length - 1), 4000)
    // One statement: the inner GROUP BY scans `hits` once; SUM(c) OVER () sums every group's
    // count (not just the fetched top-N) into `total`, replacing the old second COUNT(*) scan.
    const sql = buildMergedRingSql(cols, whereSql, groupBy)
    const tooLarge = statementTooLarge(sql, b.length + 1)
    if (tooLarge) return tooLarge
    let r: any
    try {
      r = await ctx.env.gss_geo.prepare(sql).bind(...b, fetchLimit).all()
    } catch (e) {
      console.error('geo: d1 query failed', e)
      return json({ error: 'd1 query failed' }, 500)
    }
    const rows = (r.results ?? []).map((x: any) => {
      const key: Record<string, string> = {}
      ringDims.forEach((d, i) => {
        key[d] = String(x[`k${i}`] ?? '')
      })
      return { key, pageviews: Number(x.c) || 0, visits: Number(x.c) || 0 }
    })
    const total = Number(r.results?.[0]?.total) || 0
    const totals = { pageviews: total, visits: total }
    return json({ rows, totals, meta: { site: sites.length ? sites.join(',') : 'all', since, until, dimensions: ringDims, metric: 'pageviews', dataset: 'geo' } })
  }

  // Bucket blank values under a label ("(direct)" for referrers, "(none)" otherwise)
  // instead of dropping the row. Every visit is then counted in every chart — a visit
  // that appears on the map also appears (as "(direct)"/"(none)") in the referrer,
  // subreddit, etc. charts. Dropping blanks made attribute charts look empty while the
  // location charts stayed full for the very same visits.
  const col = breakdownColumnExpr(dim, emptyLabelFor(dim))
  const where = ['ts >= ?', 'ts < ?']
  const binds: any[] = [sinceMs, untilMs]
  if (BLANK_DROPPED_DIMS.has(dim)) where.push(ringBlankExclusion(dim)) // see EVENT_DIMS
  eventRowsClause(where, binds) // events excluded unless opted in, or the dim describes events
  knownTrafficClause(where, binds)
  siteClause(where, binds)
  drillClause(where, binds)
  excludeOwnClause(where, binds)
  selfReferralClause([dim], where, binds) // inert unless this IS the referrer chart

  const whereSql = where.join(' AND ')
  // Tiebreak on k (see buildMergedBreakdownSql) so which rows LIMIT keeps is deterministic.
  // A date axis keeps the most RECENT `limit` days (newest first under LIMIT, then put back in
  // date order below) — ascending would silently keep the oldest ones on a long range.
  const orderBy = isDateDim(dim) ? 'k DESC' : 'c DESC, k ASC'
  // One statement in place of the old total-COUNT(*) + grouped-COUNT(*) pair — see the
  // buildMergedBreakdownSql doc comment for why SUM(c) OVER () gives the same grand total.
  const sql = buildMergedBreakdownSql(col, whereSql, orderBy)
  const tooLarge = statementTooLarge(sql, binds.length + 1)
  if (tooLarge) return tooLarge

  let res: any
  try {
    res = await ctx.env.gss_geo.prepare(sql).bind(...binds, limit).all()
  } catch (e) {
    console.error('geo: d1 query failed', e)
    return json({ error: 'd1 query failed' }, 500)
  }

  const rows = (res.results ?? []).map((r: any) => ({
    key: { [dim]: String(r.k ?? '') },
    pageviews: Number(r.c) || 0,
    visits: Number(r.c) || 0,
  }))
  if (isDateDim(dim)) rows.reverse()
  const total = Number(res.results?.[0]?.total) || 0
  const totals = { pageviews: total, visits: total }

  return json({ rows, totals, meta: { site: sites.length ? sites.join(',') : 'all', since, until, dimensions: [dim], metric: 'pageviews', dataset: 'geo' } })
  }
}

export const onRequestGet: PagesFunction<Env> = async () =>
  json({ ok: true, hint: 'POST a geo query: { dimension, since, until, limit }' })
