// Facts: the ONLY SQL the metrics registry runs (ADR 0003 section 2). A fact is one fixed,
// code-reviewed aggregate statement — `COUNT(*) ... GROUP BY` (or a stored-spend summary) —
// whose column and table names are literals here; only bound values vary, and those come from
// validated params, never from a client. Every metric is a reducer over one fact's rows, so
// many metrics share one statement and one cache entry (functions/_lib/metricFacts.ts runs and
// caches them; lib/metrics/engine.ts derives the metrics).
//
// Builders only: this module never touches D1. Each builder REUSES the shared clause helpers
// (campaignAttributionClause, applyExclusions, excludeInstallGapUnmeasured, siteWindowClause,
// popupIncludeClause) so a fact counts exactly the rows the query it replaced counted (the
// endpoints named below; /api/overview and /api/campaigns are retired):
//   campaignPathVisitor ← /api/overview scorecard + /api/campaigns query 1 (minus their hour /
//                         country split), plus the row-exact install-fix split `pf`
//   campaignReturns     ← the /return/<uc>/* query both endpoints run, plus the installed app's
//                         rows for a campaign and the web-only organic baseline arm
//   flightPathsSeen     ← functions/_lib/campaignInstrumentation.ts (retired; moved here)
//   bskKpiDays          ← /api/overview's KPI query (same WHERE)
//   bskRangePath        ← /api/overview's timeline query (same WHERE)
//   popupRangePath      ← /api/popups' query (same WHERE, same `pf` split; both leave out the
//                         split-guard rows, which no pop-up metric reads)
//   adsSpend            ← lib/adsStore.ts SPEND_SUMMARY_SQL (gss-stats' own store)
//   adsCoverage, adsLastSync ← lib/adsStore.ts readFreshness's two reads (the same store)
//   bskFirstHit         ← /api/overview's first-hit query (the release panel's lower bound)
//   bskReleaseSides     ← /api/overview's release-panel query, both windows in one statement
//   campaignDaily, bskRangeDaily, popupRangeDaily, adsSpendDaily ← the DAILY TWINS (ADR 0005
//                         slice 2): the same WHERE as campaignPathVisitor / bskRangePath /
//                         popupRangePath / adsSpend, grouped by ET DAY, so a card can draw a
//                         per-day series. Counts per ET day only: no hour, place or device
//                         column. The visitor kind rides along exactly as in the scalar fact (the
//                         new-visitor arrivals tile reads it on every row), so a series sums to its
//                         tile; a day's total is a one-day ET range of the same tile. A twin is
//                         read only for a `series: 'daily'` request.
//
// The campaign fact also splits by COUNTRY BUCKET (US / CA / other — lib/campaigns.ts
// countryBucket, the /api/campaigns country view) and, once lib/adsRules.ts
// UPSELL_SIGNEDOUT_FIX_AT is set, at that instant (`uf`, row-exact like `pf`). A row the
// counts-only rule protects (lib/splitGuard.ts SPLIT_REFUSED_PATH_PATTERNS) gets no bucket: its
// `cb` is '' (guardedCountryBucket), so a country column never counts it.
//
// TIMED FACTS ARE BUCKETED IN SQL, not per minute or hour (review finding #8): a fact's row count
// must not grow with traffic or with the range's length, because the Workers CPU budget is per
// request. A timed fact groups by `s`, the row's SEGMENT: how many of the fact's cut instants
// (lib/metrics/engine.ts factCuts — every go-live, attribution start and alignment instant a
// metric on it can filter on) its minute/hour bucket start has reached. The KPI fact also groups
// by `d`, the WHOLE ET day its minute bucket falls in (0 = today so far, 1..7 = each of the 7
// earlier ET days, midnight to midnight), and by `t`, the same-time flag: 1 when a row that is NOT
// a refused row (lib/splitGuard.ts refusedPathMatch) falls before the same clock time on its
// earlier day, else 0. A refused row's `t` is always 0, so no refused count is ever cut at a
// clock time: a metric that can count refused rows compares whole ET days (yesterday's total and
// the 7-day daily average), and only an opt-out metric (MetricDef.countsRefused: false) sums its
// `t = 1` groups for the same-time "vs yesterday" and "7-day avg" deltas it always had. Every
// band compares the BUCKET START, exactly as the engine used to per row, so every count is
// unchanged (the bounds are rounded to whole buckets — bucketBound — so the SQL compares plain
// `ts`).
//
// ANONYMITY (hard rule, lib/campaigns.ts header): no fact selects `id` or a raw `ts` — only a
// small integer from a CASE over `ts` bands (a segment, a day index or the KPI same-time flag), or
// the boolean `ts >= ?` split — and none joins rows.
//
// SEGMENT CUTS OVER REFUSED ROWS (R-1b ruling, 2026-10-03; each reviewed again for R-1d and
// kept): `s`, `pf` and `uf` can cut a return or completion row at a minute or an hour, and they
// stay as they are. Each cut is a fixed instant — a go-live, an attribution start, a flight
// boundary or a fix — that a COUNT is split at, never a bound a caller picks; no fact groups a
// refused row by hour of day, and no chart shows one that way. The reasoning for each is in the
// lib/splitGuard.ts header (SEGMENT CUTS). The KPI fact's `d` is whole ET days and its `t` is
// always 0 on a refused row (decision 2026-10-03, "KPI deltas on refused-row tiles: whole-day
// context"): the old same-clock-time windows gave a closed day's refused count up to a clock
// time, readable after the fact. The one caller-picked window, bskRangePath's since/until (and
// its daily twin bskRangeDaily's), counts refused rows over whole ET days (R-1d,
// refusedWindowClause); popupRangePath and popupRangeDaily leave refused rows out altogether.
// facts.test.ts checks every statement.

import { applyExclusions, CAMPAIGNS, campaignAttributionClause, campaignAttributionStartMs, campaignById, etFlightRangeMs, ORGANIC_ARM_ID, type CampaignFlight } from '../campaigns'
import { excludeInstallGapUnmeasured, INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS, popupIncludeClause, sqlInt } from '../popupEvents'
import { last7DatesBefore, siteWindowClause } from '../overview'
import { addDays as addEtDays, etDateSql, etSameTimeWindow } from '../etTime'
import { BEST_SUDOKU_SITES } from '../bestSudokuSites'
import { refusedWindowClause } from '../splitGuard'
import { COVERAGE_ROWS_SQL, LAST_SYNC_SQL, mapSpendSummary, SPEND_SUMMARY_SQL } from '../adsStore'
import { UPSELL_SIGNEDOUT_FIX_AT, type SpendSummary } from '../adsRules'
import { etMidnightMs } from './instrumentation'
import { excludeOwnClause } from '../ownExclusion'
import { refusedPathExcludeClause, refusedPathMatch } from '../splitGuard'

export type FactId =
  | 'campaignPathVisitor'
  | 'campaignReturns'
  | 'flightPathsSeen'
  | 'bskKpiDays'
  | 'bskRangePath'
  | 'popupRangePath'
  | 'bskFirstHit'
  | 'bskReleaseSides'
  | 'adsSpend'
  | 'adsCoverage'
  | 'adsLastSync'
  | 'campaignDaily'
  | 'bskRangeDaily'
  | 'popupRangeDaily'
  | 'adsSpendDaily'

/** Normalized fact params. Which ones identify an instance is FactDef.keyParams. */
export interface FactParams {
  campaignId?: string
  /** ET calendar date the KPI fact is anchored on (today, ET). */
  todayEt?: string
  since?: string
  until?: string
  sites?: string[]
  /** The release windows' anchor (an ET date) and how many days each side covers. */
  releaseDateEt?: string
  days?: number
  /** "Hide my own visits" (lib/ownExclusion.ts), set only when the page turns it on with a
   * browser and an OS: rows from that browser on that OS are left out. */
  ownBrowser?: string
  ownOS?: string
}

export interface FactStatement {
  db: 'gss_geo' | 'gss_stats_ads'
  sql: string
  binds: unknown[]
}

/** One aggregate row of a beacon fact. `day` is the KPI fact's ET day window, or the release
 * fact's side (0 before, 1 after; 0 for every other fact); `seg` is the row's segment against the
 * fact's cuts (0 for an untimed fact); `pf` is the row-exact split at FactDef.splitAt (null when
 * the fact has none); `cb` the country bucket ('' when the fact has none); `uf` the row-exact
 * side of the upsell fix (null when unset or not split). `sameTime` is the KPI fact's same-time
 * flag `t` (true only for a row that is not a refused row and falls before the same clock time on
 * its earlier day; false on every other fact). `c` is the COUNT(*). */
export interface BeaconRow {
  path: string
  visitor: string
  campaign: string
  day: number
  sameTime: boolean
  seg: number
  pf: boolean | null
  cb: string
  uf: boolean | null
  c: number
}

/** The ads store's freshness reads (lib/adsStore.ts readFreshness): each campaign's stored day
 * rows, and its latest successful sync. gss-stats' own records, never beacon rows. */
export interface CoverageRow {
  campaignId: string
  date: string
  fetchedAt: string | null
}
export interface LastSyncRow {
  campaignId: string
  lastSync: string | null
}

/** One aggregate row of a daily twin: the count of rows on one ET day (`dt`, YYYY-MM-DD) for a
 * path, with the visitor kind ('' for a fact that has no visitor column) and campaign tag ('' when the fact has none). */
export interface DailyBeaconRow {
  dt: string
  path: string
  visitor: string
  campaign: string
  c: number
}
/** One stored spend day (ads_daily_metrics): gss-stats' own records, never beacon rows. */
export interface SpendDayRow {
  campaignId: string
  date: string
  costMicros: number
}

export type FactRows =
  | { kind: 'beacon'; rows: BeaconRow[] }
  | { kind: 'beaconDaily'; rows: DailyBeaconRow[] }
  | { kind: 'spendDaily'; rows: SpendDayRow[] }
  | { kind: 'spend'; rows: SpendSummary[] }
  | { kind: 'coverage'; rows: CoverageRow[] }
  | { kind: 'lastSync'; rows: LastSyncRow[] }
  /** A single aggregate (the first Best Sudoku hit, epoch ms), null when there is none. */
  | { kind: 'scalar'; value: number | null }

/** How long a fact's cache entry lives (functions/_lib/metricFacts.ts turns it into seconds):
 *  - 'range': a page range — long once it ends before today (ET), short while it includes today
 *  - 'campaign': 90 s while the campaign is active or upcoming, 15 min once it is closed
 *  - 'flightWindow': the serving window — 24 h once it has ended, 90 s while it is open
 *  - { seconds } fixed */
export type FactTtl = 'range' | 'campaign' | 'flightWindow' | { seconds: number }

export interface FactDef {
  id: FactId
  db: FactStatement['db']
  /** The normalized params that identify one instance (its cache key and dedupe key). */
  keyParams: (keyof FactParams)[]
  /** The page filters this fact honours. Campaign facts use attribution windows and honour
   * none, as the retired /api/overview and /api/campaigns did. */
  honors: ('range' | 'sites' | 'excludeOwn')[]
  /** Bucket size in ms whose START the segments (and KPI days) compare (60 000 or 3 600 000),
   * or null for an untimed fact. */
  bucketMs: number | null
  /** The instant `pf` splits at (the install fix), or null when the fact has no split. */
  splitAt: number | null
  ttl: FactTtl
  /** True when the statement depends on "now" (the KPI fact's live bounds); every other fact's
   * statement is a pure function of its params, so it can be built once and reused. */
  usesNow?: boolean
  /** ONE aggregate statement. `nowMs` only bounds a live window (never part of the key); `cuts`
   * are the sorted segment instants (lib/metrics/engine.ts factCuts; ignored by untimed facts). */
  build(p: FactParams, nowMs: number, cuts?: readonly number[]): FactStatement
  parse(raw: Record<string, unknown>[]): FactRows
}

// Funnel beacons are web-only (lib/campaigns.ts; functions/api/campaigns.ts BSK_SITE). Return
// beacons fire on both: a campaign's /return/ rows come from the web site and the installed app
// alike, while the organic baseline's are web-only (campaignReturns).
export const BSK_WEB_SITE = 'bestsudoku-web'
export const BSK_APP_SITE = 'bestsudoku-app'
const INSTALL_FIX = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
/** An ISO datetime as epoch ms; one without a zone is read as UTC (never the host's zone). */
function isoMs(v: string): number {
  return Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(v) ? v : v + 'Z')
}
/** [since, until) in epoch ms. A bare YYYY-MM-DD is an ET calendar day, like every other day on
 * the dashboard (KPI days, flights, go-live dates): `since` starts at its ET midnight and a bare
 * `until` is inclusive (up to the ET midnight after it). A datetime is taken as given (UTC when
 * it has no zone). The dashboard's own range control always sends datetimes. */
export function rangeMs(since: string, until: string): [number, number] {
  return [DATE_ONLY_RE.test(since) ? etMidnightMs(since) : isoMs(since), DATE_ONLY_RE.test(until) ? etMidnightMs(addEtDays(until, 1)) : isoMs(until)]
}

function campaignOf(p: FactParams): CampaignFlight {
  const c = p.campaignId ? campaignById(p.campaignId) : undefined
  if (!c) throw new Error(`fact needs a known campaignId, got ${String(p.campaignId)}`)
  return c
}

/** `(ts >= ?) AS pf` split at the install fix, or a constant 0 while the fix is unshipped
 * (the same construction as functions/api/popups.ts). */
function pfColumn(): { sql: string; binds: unknown[] } {
  return INSTALL_FIX === null ? { sql: '0', binds: [] } : { sql: '(ts >= ?)', binds: [INSTALL_FIX] }
}

/** A comparison on a row's bucket START, as a comparison on `ts` itself: with b the start of
 * ts's `bucketMs` bucket, `b >= x` exactly when `ts >= ceil(x / bucketMs) * bucketMs` (and
 * `b < x` exactly when `ts <` the same bound). So the bound is rounded up here, once, and the
 * statement compares plain `ts` (short SQL, and SQLite does no per-row arithmetic). The value
 * selected is still only a small integer, never the timestamp. */
const bucketBound = (x: number, bucketMs: number) => Math.ceil(x / bucketMs) * bucketMs

/** `s`: how many of the sorted `cuts` the row's bucket start has reached (0 when there are none). */
function segmentColumn(bucketMs: number, cuts: readonly number[]): { sql: string; binds: unknown[] } {
  if (!cuts.length) return { sql: '0', binds: [] }
  const whens: string[] = []
  const binds: unknown[] = []
  for (let k = cuts.length - 1; k >= 0; k--) {
    whens.push(`WHEN ts >= ? THEN ${k + 1}`)
    binds.push(bucketBound(cuts[k], bucketMs))
  }
  return { sql: `CASE ${whens.join(' ')} ELSE 0 END`, binds }
}

/** The KPI same-time windows: [0] today so far, [1..7] the same ET clock time on each of the 7
 * days before — the retired /api/overview's windows (lib/overview.ts sameTimeWindowMs), computed
 * without Intl (lib/etTime.ts etSameTimeWindow; facts.test.ts checks they are identical). Days
 * 1..7 bound the `t` flag only (a non-refused row an opt-out metric compares); `d` is whole days. */
export function kpiDayWindows(todayEt: string, nowMs: number): [number, number][] {
  return [[etMidnightMs(todayEt), nowMs], ...last7DatesBefore(todayEt).map((d) => etSameTimeWindow(d, nowMs))]
}

/** The ET midnights the KPI fact's whole-day index `d` starts each day at: [0] today's, [k] the
 * one k ET days before (k = 1..7). ET-day arithmetic, so a 23 h or 25 h DST day stays whole. */
export function kpiDayStarts(todayEt: string): number[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((k) => etMidnightMs(addEtDays(todayEt, -k)))
}

/** `d`: the whole ET day the row's minute bucket start falls in (0 = today, k = k days before;
 * -1 before the 7th). The bounds are integer literals (sqlInt), so the column costs no binds. */
function kpiDayColumn(todayEt: string): string {
  const whens = kpiDayStarts(todayEt).map((m, d) => `WHEN ts >= ${sqlInt(bucketBound(m, 60_000))} THEN ${d}`)
  return `CASE ${whens.join(' ')} ELSE -1 END`
}

/** `t`: 1 when the row is NOT a refused row (lib/splitGuard.ts refusedPathMatch, the same
 * predicate the split guard and R-1d use) and its minute bucket start falls in an earlier day's
 * same-time window [ET midnight, same clock time); 0 otherwise, and ALWAYS 0 on a refused row, so
 * a refused count is never split at a clock time. The bounds are integer literals (sqlInt). */
function kpiSameTimeColumn(todayEt: string, nowMs: number): { sql: string; binds: unknown[] } {
  const refused = refusedPathMatch() // binds are always empty; kept in SELECT order in case that changes
  const whens = kpiDayWindows(todayEt, nowMs)
    .slice(1)
    .map(([a, z]) => `WHEN ts >= ${sqlInt(bucketBound(a, 60_000))} AND ts < ${sqlInt(bucketBound(z, 60_000))} THEN 1`)
  return { sql: `CASE WHEN ${refused.sql} THEN 0 ${whens.join(' ')} ELSE 0 END`, binds: refused.binds }
}

const str = (x: unknown): string => (x == null ? '' : String(x))
const num = (x: unknown): number => Number(x) || 0
const pfOf = (r: Record<string, unknown>): boolean | null => (INSTALL_FIX === null ? false : num(r.pf) === 1)
const noPf = (): null => null
const beacon = (raw: Record<string, unknown>[], pf: (r: Record<string, unknown>) => boolean | null): FactRows => ({
  kind: 'beacon',
  rows: raw.map((r) => ({
    path: str(r.path),
    visitor: str(r.visitor),
    campaign: str(r.campaign),
    day: num(r.d),
    sameTime: num(r.t) === 1,
    seg: num(r.s),
    pf: pf(r),
    cb: str(r.cb),
    uf: r.uf === undefined || r.uf === null ? null : num(r.uf) === 1,
    c: num(r.c),
  })),
})

/** The country bucket (lib/campaigns.ts countryBucket) as a CASE over the `country` column with
 * literal outputs only: US, CA, and everything else (blank included) as 'other'. */
export const COUNTRY_BUCKET_SQL = "CASE country WHEN 'US' THEN 'US' WHEN 'CA' THEN 'CA' ELSE 'other' END"
/** COUNTRY_BUCKET_SQL with the counts-only split guard (lib/splitGuard.ts): a refused row
 * (return, game start, completion, tutorial completion, tour skip, tour exit) reads cb = '' — no bucket,
 * so a country-filtered metric never counts it, while an unfiltered one still does. The path
 * patterns are SQL literals (refusedPathMatch), so the CASE costs no binds; `binds` is kept (and
 * placed in SELECT order before any later column's) in case that ever changes. Literal outputs
 * only. */
export function guardedCountryBucket(): { sql: string; binds: string[] } {
  const m = refusedPathMatch()
  return { sql: `CASE WHEN ${m.sql} THEN '' ELSE ${COUNTRY_BUCKET_SQL} END`, binds: m.binds }
}
/** `(ts >= ?) AS uf` at the signed-out upsell fix, only while it is set (lib/adsRules.ts
 * UPSELL_SIGNEDOUT_FIX_AT): until then the statement is unchanged and every row reads uf null. */
function ufColumn(fixAt: number | null = UPSELL_SIGNEDOUT_FIX_AT): { select: string; group: string; binds: unknown[] } {
  return fixAt === null ? { select: '', group: '', binds: [] } : { select: ', (ts >= ?) AS uf', group: ', uf', binds: [fixAt] }
}
/** The release windows (lib/overview.ts releaseComparisonWindows): `days` ET days ending at the
 * release date's ET midnight, and `days` ET days starting at the ET midnight after the release
 * date (the release day itself is in neither). ET-day arithmetic, so DST days stay whole. */
export function releaseSidesMs(releaseDateEt: string, days: number): { before: [number, number]; after: [number, number] } {
  const after0 = addEtDays(releaseDateEt, 1)
  return {
    before: [etMidnightMs(addEtDays(releaseDateEt, -days)), etMidnightMs(releaseDateEt)],
    after: [etMidnightMs(after0), etMidnightMs(addEtDays(after0, days))],
  }
}

// ── Daily twins (ADR 0005 slice 2) ──────────────────────────────────────────────────────
/** The daily twin statement over a WHERE: per ET day, path (and, when `columns` says so, the
 * visitor kind and campaign tag, exactly as the scalar fact keeps them), COUNT(*). */
function dailyStatement(where: string, whereBinds: unknown[], columns: 'full' | 'path'): FactStatement {
  if (columns === 'path') return { db: 'gss_geo', sql: `SELECT ${etDateSql()} AS dt, path, COUNT(*) AS c FROM hits WHERE ${where} GROUP BY dt, path`, binds: whereBinds }
  return { db: 'gss_geo', sql: `SELECT ${etDateSql()} AS dt, path, visitor AS v, campaign, COUNT(*) AS c FROM hits WHERE ${where} GROUP BY dt, path, v, campaign`, binds: whereBinds }
}
const beaconDaily = (raw: Record<string, unknown>[]): FactRows => ({
  kind: 'beaconDaily',
  rows: raw.map((r) => ({ dt: str(r.dt), path: str(r.path), visitor: str(r.v), campaign: str(r.campaign), c: num(r.c) })),
})

/** Every stored spend day, whole micros per (campaign, ET date): the adsSpend twin. */
export const SPEND_DAYS_SQL = 'SELECT campaign_id, date, cost_micros FROM ads_daily_metrics ORDER BY campaign_id, date'

export const FACTS: Record<FactId, FactDef> = {
  campaignPathVisitor: {
    id: 'campaignPathVisitor',
    db: 'gss_geo',
    keyParams: ['campaignId'],
    honors: [],
    bucketMs: null,
    splitAt: INSTALL_FIX,
    ttl: 'campaign',
    build(p) {
      const attr = campaignAttributionClause(campaignOf(p))
      const w: string[] = [attr.sql]
      const b: unknown[] = [...attr.binds]
      applyExclusions(w, b)
      excludeInstallGapUnmeasured(w, b) // pre-fix install-gap rows are unmeasured, not zero
      const pf = pfColumn()
      const cb = guardedCountryBucket()
      const uf = ufColumn()
      // `visitor` is kept on refused rows on purpose (lib/splitGuard.ts header, "what stays
      // allowed"): campaign.taggedArrivals counts visitor='new' rows on any path, and a refused
      // row's new/returning bit is the device remembering its own first visit. Its country is not.
      return {
        db: 'gss_geo',
        sql: `SELECT path, visitor, ${pf.sql} AS pf, ${cb.sql} AS cb${uf.select}, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY path, visitor, pf, cb${uf.group}`,
        binds: [...pf.binds, ...cb.binds, ...uf.binds, ...b],
      }
    },
    parse: (raw) => beacon(raw, pfOf),
  },

  campaignReturns: {
    id: 'campaignReturns',
    db: 'gss_geo',
    keyParams: ['campaignId'],
    honors: [],
    bucketMs: null,
    splitAt: null,
    ttl: 'campaign',
    build(p) {
      // The organic baseline arm (lib/campaigns.ts ORGANIC_ARM_ID): its own reserved tag, the web
      // site ONLY (Best Sudoku never sends it from the installed app, where a late Play referrer
      // would make an app 'organic' record swallow a campaign's first touch), and no lower bound
      // (it has no flight). Counts only, like every arm: no device, hour or place column.
      if (p.campaignId === ORGANIC_ARM_ID) {
        const w: string[] = ['site = ?', 'path LIKE ?']
        const b: unknown[] = [BSK_WEB_SITE, `/return/${ORGANIC_ARM_ID}/%`]
        applyExclusions(w, b)
        return { db: 'gss_geo', sql: `SELECT path, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY path`, binds: b }
      }
      // A campaign: path-embedded uc, on the web site AND the installed app, NOT date-windowed: a
      // d31-60 return can fire long after the flight ended (lib/campaigns.ts parseReturnPath).
      // Only the LOWER bound is applied, the same one campaignAttributionClause gives the arrivals
      // tile: rows before the campaign's attribution start (pre-launch tests, e.g. before 12:00
      // ET on the retest's first day) are left out, and an unconfirmed flightStart attributes
      // nothing. A row filter on the aggregate; no device is linked to anything.
      const c = campaignOf(p)
      const w: string[] = ['site IN (?, ?)', `(${c.ucValues.map(() => 'path LIKE ?').join(' OR ')})`]
      const b: unknown[] = [BSK_WEB_SITE, BSK_APP_SITE, ...c.ucValues.map((u) => `/return/${u}/%`)]
      const startMs = campaignAttributionStartMs(c)
      if (startMs === null) w.push('1 = 0')
      else {
        w.push('ts >= ?')
        b.push(startMs)
      }
      applyExclusions(w, b)
      return { db: 'gss_geo', sql: `SELECT path, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY path`, binds: b }
    },
    parse: (raw) => beacon(raw, noPf),
  },

  flightPathsSeen: {
    id: 'flightPathsSeen',
    db: 'gss_geo',
    keyParams: ['campaignId'],
    honors: [],
    bucketMs: null,
    splitAt: null,
    ttl: 'flightWindow',
    build(p) {
      return flightPathsSeenStatement(campaignOf(p))
    },
    parse: (raw) => beacon(raw, noPf),
  },

  bskKpiDays: {
    id: 'bskKpiDays',
    db: 'gss_geo',
    keyParams: ['todayEt'],
    honors: [],
    bucketMs: 60_000,
    splitAt: null,
    ttl: { seconds: 90 },
    usesNow: true,
    build(p, nowMs, cuts = []) {
      if (!p.todayEt) throw new Error('bskKpiDays needs todayEt')
      // Today so far plus the 7 whole ET days before it. `d` is the whole ET day; `t` marks the
      // non-refused rows before the same clock time on their day (always 0 on a refused row), so
      // an opt-out metric's same-time deltas are unchanged while a refused count is whole days.
      const clause = siteWindowClause(BEST_SUDOKU_SITES, etMidnightMs(addEtDays(p.todayEt, -7)), nowMs)
      const day = kpiDayColumn(p.todayEt)
      const same = kpiSameTimeColumn(p.todayEt, nowMs)
      const seg = segmentColumn(60_000, cuts)
      return {
        db: 'gss_geo',
        sql: `SELECT ${day} AS d, ${same.sql} AS t, ${seg.sql} AS s, path, visitor, campaign, COUNT(*) AS c FROM hits WHERE ${clause.sql} GROUP BY d, t, s, path, visitor, campaign HAVING d >= 0`,
        binds: [...same.binds, ...seg.binds, ...clause.binds],
      }
    },
    parse: (raw) => beacon(raw, noPf),
  },

  bskRangePath: {
    id: 'bskRangePath',
    db: 'gss_geo',
    keyParams: ['since', 'until'],
    honors: ['range'],
    bucketMs: 3_600_000,
    splitAt: null,
    ttl: 'range',
    build(p, _nowMs, cuts = []) {
      const [startMs, endMs] = rangeMs(p.since!, p.until!)
      // Counts only (R-1d): refused rows over whole ET days, every other row over the exact
      // range. An ET-midnight range (every bare-date range) builds the unchanged statement.
      const win = refusedWindowClause(startMs, endMs)
      const clause = siteWindowClause(BEST_SUDOKU_SITES, win.binds[0], win.binds[1])
      const where = [clause.sql, ...win.terms.slice(2)].join(' AND ')
      const seg = segmentColumn(3_600_000, cuts)
      return {
        db: 'gss_geo',
        sql: `SELECT ${seg.sql} AS s, path, visitor, campaign, COUNT(*) AS c FROM hits WHERE ${where} GROUP BY s, path, visitor, campaign`,
        binds: [...seg.binds, ...clause.binds],
      }
    },
    parse: (raw) => beacon(raw, noPf),
  },

  popupRangePath: {
    id: 'popupRangePath',
    db: 'gss_geo',
    keyParams: ['since', 'until', 'sites', 'ownBrowser', 'ownOS'],
    honors: ['range', 'sites', 'excludeOwn'],
    bucketMs: 3_600_000,
    splitAt: INSTALL_FIX,
    ttl: 'range',
    build(p, _nowMs, cuts = []) {
      const [startMs, endMs] = rangeMs(p.since!, p.until!)
      const w: string[] = ['ts >= ?', 'ts < ?']
      const b: unknown[] = [startMs, endMs]
      if (p.sites?.length) {
        w.push(`site IN (${p.sites.map(() => '?').join(', ')})`)
        b.push(...p.sites)
      }
      // "Hide my own visits", exactly as /api/popups applies it (lib/ownExclusion.ts).
      excludeOwnClause(w, b, !!(p.ownBrowser && p.ownOS), p.ownBrowser, p.ownOS)
      const inc = popupIncludeClause()
      w.push(inc.sql)
      b.push(...inc.binds)
      // The counts-only rule (lib/splitGuard.ts), as /api/popups applies it: this fact buckets by
      // hour, so the refused rows stay out. None is a pop-up event, so no count changes.
      refusedPathExcludeClause(w, b)
      const pf = pfColumn()
      const seg = segmentColumn(3_600_000, cuts)
      return {
        db: 'gss_geo',
        sql: `SELECT ${seg.sql} AS s, path, ${pf.sql} AS pf, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY s, path, pf`,
        binds: [...seg.binds, ...pf.binds, ...b],
      }
    },
    parse: (raw) => beacon(raw, pfOf),
  },

  bskFirstHit: {
    id: 'bskFirstHit',
    db: 'gss_geo',
    keyParams: [],
    honors: [],
    bucketMs: null,
    splitAt: null,
    // The first Best Sudoku hit only moves if old rows are ever removed.
    ttl: { seconds: 6 * 60 * 60 },
    build: () => ({ db: 'gss_geo', sql: `SELECT MIN(ts) AS t FROM hits WHERE site IN (${BEST_SUDOKU_SITES.map(() => '?').join(', ')})`, binds: [...BEST_SUDOKU_SITES] }),
    parse: (raw) => {
      const t = raw[0]?.t
      return { kind: 'scalar', value: t === null || t === undefined || !Number.isFinite(Number(t)) ? null : Number(t) }
    },
  },

  bskReleaseSides: {
    id: 'bskReleaseSides',
    db: 'gss_geo',
    keyParams: ['releaseDateEt', 'days'],
    honors: [],
    bucketMs: 60_000,
    splitAt: null,
    // Both windows end at or before now (the after window is whole days since the release).
    ttl: { seconds: 60 * 60 },
    build(p, _nowMs, cuts = []) {
      if (!p.releaseDateEt || !p.days) throw new Error('bskReleaseSides needs releaseDateEt and days')
      const { before, after } = releaseSidesMs(p.releaseDateEt, p.days)
      // siteWindowClause applies the exclusions, as the release panel's own query did.
      const clause = siteWindowClause(BEST_SUDOKU_SITES, before[0], after[1])
      const seg = segmentColumn(60_000, cuts)
      return {
        db: 'gss_geo',
        sql: `SELECT (ts >= ?) AS d, ${seg.sql} AS s, path, visitor, campaign, COUNT(*) AS c FROM hits WHERE ${clause.sql} AND (ts < ? OR ts >= ?) GROUP BY d, s, path, visitor, campaign`,
        // The release's own ET day (between the sides) is in neither.
        binds: [after[0], ...seg.binds, ...clause.binds, before[1], after[0]],
      }
    },
    parse: (raw) => beacon(raw, noPf),
  },

  campaignDaily: {
    id: 'campaignDaily',
    db: 'gss_geo',
    keyParams: ['campaignId'],
    honors: [],
    bucketMs: null,
    splitAt: null,
    ttl: 'campaign',
    build(p) {
      // campaignPathVisitor's WHERE, row for row, by ET day (no install-fix, upsell-fix or country split).
      const attr = campaignAttributionClause(campaignOf(p))
      const w: string[] = [attr.sql]
      const b: unknown[] = [...attr.binds]
      applyExclusions(w, b)
      excludeInstallGapUnmeasured(w, b)
      return dailyStatement(w.join(' AND '), b, 'full')
    },
    parse: beaconDaily,
  },

  bskRangeDaily: {
    id: 'bskRangeDaily',
    db: 'gss_geo',
    keyParams: ['since', 'until'],
    honors: ['range'],
    bucketMs: null,
    splitAt: null,
    ttl: 'range',
    build(p) {
      // bskRangePath's WHERE, refused-row snap included (R-1d): a sub-day range counts refused
      // rows over whole ET days, every other row over the exact range. An ET-midnight range (every
      // bare-date range) builds the unchanged statement.
      const [startMs, endMs] = rangeMs(p.since!, p.until!)
      const win = refusedWindowClause(startMs, endMs)
      const clause = siteWindowClause(BEST_SUDOKU_SITES, win.binds[0], win.binds[1])
      return dailyStatement([clause.sql, ...win.terms.slice(2)].join(' AND '), clause.binds, 'full')
    },
    parse: beaconDaily,
  },

  popupRangeDaily: {
    id: 'popupRangeDaily',
    db: 'gss_geo',
    keyParams: ['since', 'until', 'sites', 'ownBrowser', 'ownOS'],
    honors: ['range', 'sites', 'excludeOwn'],
    bucketMs: null,
    splitAt: null,
    ttl: 'range',
    build(p) {
      const [startMs, endMs] = rangeMs(p.since!, p.until!)
      const w: string[] = ['ts >= ?', 'ts < ?']
      const b: unknown[] = [startMs, endMs]
      if (p.sites?.length) {
        w.push(`site IN (${p.sites.map(() => '?').join(', ')})`)
        b.push(...p.sites)
      }
      excludeOwnClause(w, b, !!(p.ownBrowser && p.ownOS), p.ownBrowser, p.ownOS)
      const inc = popupIncludeClause()
      w.push(inc.sql)
      b.push(...inc.binds)
      // popupRangePath's counts-only exclusion, so the twin reads the scalar's rows: no refused
      // row at all, whatever the range (none is a pop-up event, so no count changes).
      refusedPathExcludeClause(w, b)
      excludeInstallGapUnmeasured(w, b) // popupRangePath drops these in JS (isUnmeasuredGapRow); here in SQL
      return dailyStatement(w.join(' AND '), b, 'path')
    },
    parse: beaconDaily,
  },

  adsSpend: {
    id: 'adsSpend',
    db: 'gss_stats_ads',
    keyParams: [],
    honors: [],
    bucketMs: null,
    splitAt: null,
    ttl: { seconds: 300 },
    build: () => ({ db: 'gss_stats_ads', sql: SPEND_SUMMARY_SQL, binds: [] }),
    parse: (raw) => ({ kind: 'spend', rows: raw.map(mapSpendSummary) }),
  },

  adsCoverage: {
    id: 'adsCoverage',
    db: 'gss_stats_ads',
    keyParams: [],
    honors: [],
    bucketMs: null,
    splitAt: null,
    ttl: { seconds: 300 },
    build: () => ({ db: 'gss_stats_ads', sql: COVERAGE_ROWS_SQL, binds: [] }),
    parse: (raw) => ({ kind: 'coverage', rows: raw.map((r) => ({ campaignId: str(r.campaign_id), date: str(r.date), fetchedAt: r.fetched_at == null ? null : str(r.fetched_at) })) }),
  },

  adsLastSync: {
    id: 'adsLastSync',
    db: 'gss_stats_ads',
    keyParams: [],
    honors: [],
    bucketMs: null,
    splitAt: null,
    ttl: { seconds: 60 },
    build: () => ({ db: 'gss_stats_ads', sql: LAST_SYNC_SQL, binds: [] }),
    parse: (raw) => ({ kind: 'lastSync', rows: raw.map((r) => ({ campaignId: str(r.campaign_id), lastSync: r.last_sync == null ? null : str(r.last_sync) })) }),
  },

  adsSpendDaily: {
    id: 'adsSpendDaily',
    db: 'gss_stats_ads',
    keyParams: [],
    honors: [],
    bucketMs: null,
    splitAt: null,
    ttl: { seconds: 300 },
    build: () => ({ db: 'gss_stats_ads', sql: SPEND_DAYS_SQL, binds: [] }),
    parse: (raw) => ({ kind: 'spendDaily', rows: raw.map((r) => ({ campaignId: str(r.campaign_id), date: str(r.date), costMicros: num(r.cost_micros) })) }),
  },
}

/** "Which paths existed AT ALL (any campaign, tagged or not) site-wide during this flight's
 * SERVING window" — the per-flight instrumentation check (lib/metrics/instrumentation.ts
 * seenInFlightWindow). Moved here from the retired functions/_lib/campaignInstrumentation.ts.
 * Requires a confirmed flightStart. */
export function flightPathsSeenStatement(campaign: CampaignFlight): FactStatement {
  if (!campaign.flightStart) throw new Error('flightPathsSeen needs a confirmed flightStart')
  const [startMs, endMs] = etFlightRangeMs(campaign.flightStart, campaign.flightEnd)
  return { db: 'gss_geo', sql: 'SELECT path, COUNT(*) AS c FROM hits WHERE site = ? AND ts >= ? AND ts < ? GROUP BY path', binds: [BSK_WEB_SITE, startMs, endMs] }
}

/** The dedupe/cache identity of one fact instance: its id plus only the params it keys on. */
export function factKey(id: FactId, p: FactParams): { id: FactId; params: Partial<FactParams> } {
  const params: Partial<FactParams> = {}
  for (const k of FACTS[id].keyParams) if (p[k] !== undefined) (params as Record<string, unknown>)[k] = p[k]
  return { id, params }
}

/** Every campaign id a campaign fact can be built for (the validation whitelist). */
export const CAMPAIGN_IDS: ReadonlySet<string> = new Set(CAMPAIGNS.map((c) => c.id))
