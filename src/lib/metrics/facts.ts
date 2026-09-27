// Facts: the ONLY SQL the metrics registry runs (ADR 0003 section 2). A fact is one fixed,
// code-reviewed aggregate statement — `COUNT(*) ... GROUP BY` (or a stored-spend summary) —
// whose column and table names are literals here; only bound values vary, and those come from
// validated params, never from a client. Every metric is a reducer over one fact's rows, so
// many metrics share one statement and one cache entry (functions/_lib/metricFacts.ts runs and
// caches them; lib/metrics/engine.ts derives the metrics).
//
// Builders only: this module never touches D1. Each builder REUSES the clause helpers the
// existing endpoints use (campaignAttributionClause, applyExclusions, excludeInstallGapUnmeasured,
// siteWindowClause, popupIncludeClause) so a fact counts exactly the rows its endpoint counts:
//   campaignPathVisitor ← /api/overview scorecard + /api/campaigns query 1 (minus their hour /
//                         country split), plus the row-exact install-fix split `pf`
//   campaignReturns     ← the /return/<uc>/* query both endpoints run
//   flightPathsSeen     ← functions/_lib/campaignInstrumentation.ts (now built from here)
//   bskKpiDays          ← /api/overview's KPI query (same WHERE)
//   bskRangePath        ← /api/overview's timeline query (same WHERE)
//   popupRangePath      ← /api/popups' query (same WHERE, same `pf` split)
//   adsSpend            ← lib/adsStore.ts SPEND_SUMMARY_SQL (gss-stats' own store)
//
// TIMED FACTS ARE BUCKETED IN SQL, not per minute or hour (review finding #8): a fact's row count
// must not grow with traffic or with the range's length, because the Workers CPU budget is per
// request. A timed fact groups by `s`, the row's SEGMENT: how many of the fact's cut instants
// (lib/metrics/engine.ts factCuts — every go-live, attribution start and alignment instant a
// metric on it can filter on) its minute/hour bucket start has reached. The KPI fact also groups
// by `d`, the ET day window (0 = today so far, 1..7 = the same time of day on each earlier day)
// its minute bucket falls in. Both compare the BUCKET START, exactly as the engine used to per
// row, so every count is unchanged (the bounds are rounded to whole buckets — bucketBound — so
// the SQL compares plain `ts`).
//
// ANONYMITY (hard rule, lib/campaigns.ts header): no fact selects `id` or a raw `ts` — only a
// small integer from a CASE over `ts` bands (a segment or a day index), or the boolean `ts >= ?`
// split — and none joins rows.
// facts.test.ts checks every statement.

import { applyExclusions, CAMPAIGNS, campaignAttributionClause, campaignById, etFlightRangeMs, type CampaignFlight } from '../campaigns'
import { excludeInstallGapUnmeasured, INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS, popupIncludeClause } from '../popupEvents'
import { last7DatesBefore, siteWindowClause } from '../overview'
import { addDays as addEtDays, etSameTimeWindow } from '../etTime'
import { BEST_SUDOKU_SITES } from '../bestSudokuSites'
import { mapSpendSummary, SPEND_SUMMARY_SQL } from '../adsStore'
import type { SpendSummary } from '../adsRules'
import { etMidnightMs } from './instrumentation'

export type FactId = 'campaignPathVisitor' | 'campaignReturns' | 'flightPathsSeen' | 'bskKpiDays' | 'bskRangePath' | 'popupRangePath' | 'adsSpend'

/** Normalized fact params. Which ones identify an instance is FactDef.keyParams. */
export interface FactParams {
  campaignId?: string
  /** ET calendar date the KPI fact is anchored on (today, ET). */
  todayEt?: string
  since?: string
  until?: string
  sites?: string[]
}

export interface FactStatement {
  db: 'gss_geo' | 'gss_stats_ads'
  sql: string
  binds: unknown[]
}

/** One aggregate row of a beacon fact. `day` is the KPI fact's ET day window (0 for every other
 * fact); `seg` is the row's segment against the fact's cuts (0 for an untimed fact); `pf` is the
 * row-exact split at FactDef.splitAt (null when the fact has none). `c` is the COUNT(*). */
export interface BeaconRow {
  path: string
  visitor: string
  campaign: string
  day: number
  seg: number
  pf: boolean | null
  c: number
}

export type FactRows = { kind: 'beacon'; rows: BeaconRow[] } | { kind: 'spend'; rows: SpendSummary[] }

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
   * none, as /api/overview and /api/campaigns do today. */
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

// Return and funnel beacons are web-only (lib/campaigns.ts; functions/api/campaigns.ts BSK_SITE).
export const BSK_WEB_SITE = 'bestsudoku-web'
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

/** The KPI day windows: [0] today so far, [1..7] the same ET clock time on each of the 7 days
 * before — /api/overview's own windows (lib/overview.ts sameTimeWindowMs), computed without Intl
 * (lib/etTime.ts etSameTimeWindow; facts.test.ts checks they are identical). */
export function kpiDayWindows(todayEt: string, nowMs: number): [number, number][] {
  return [[etMidnightMs(todayEt), nowMs], ...last7DatesBefore(todayEt).map((d) => etSameTimeWindow(d, nowMs))]
}

/** `d`: which KPI day window the row's minute bucket start falls in (-1 for none). */
function dayColumn(windows: readonly (readonly [number, number])[]): { sql: string; binds: unknown[] } {
  const binds: unknown[] = []
  const whens = windows.map(([a, z], d) => {
    binds.push(bucketBound(a, 60_000), bucketBound(z, 60_000))
    return `WHEN ts >= ? AND ts < ? THEN ${d}`
  })
  return { sql: `CASE ${whens.join(' ')} ELSE -1 END`, binds }
}

const str = (x: unknown): string => (x == null ? '' : String(x))
const num = (x: unknown): number => Number(x) || 0
const pfOf = (r: Record<string, unknown>): boolean | null => (INSTALL_FIX === null ? false : num(r.pf) === 1)
const noPf = (): null => null
const beacon = (raw: Record<string, unknown>[], pf: (r: Record<string, unknown>) => boolean | null): FactRows => ({
  kind: 'beacon',
  rows: raw.map((r) => ({ path: str(r.path), visitor: str(r.visitor), campaign: str(r.campaign), day: num(r.d), seg: num(r.s), pf: pf(r), c: num(r.c) })),
})

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
      return {
        db: 'gss_geo',
        sql: `SELECT path, visitor, ${pf.sql} AS pf, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY path, visitor, pf`,
        binds: [...pf.binds, ...b],
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
      // Path-embedded uc, site-wide, NOT date-windowed: a d31-60 return can fire long after the
      // flight ended (lib/campaigns.ts parseReturnPath).
      const c = campaignOf(p)
      const w: string[] = ['site = ?', `(${c.ucValues.map(() => 'path LIKE ?').join(' OR ')})`]
      const b: unknown[] = [BSK_WEB_SITE, ...c.ucValues.map((u) => `/return/${u}/%`)]
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
      // Today plus the 7 ET days before it (the vs-yesterday and 7-day-average windows).
      const clause = siteWindowClause(BEST_SUDOKU_SITES, etMidnightMs(addEtDays(p.todayEt, -7)), nowMs)
      const day = dayColumn(kpiDayWindows(p.todayEt, nowMs))
      const seg = segmentColumn(60_000, cuts)
      return {
        db: 'gss_geo',
        sql: `SELECT ${day.sql} AS d, ${seg.sql} AS s, path, visitor, campaign, COUNT(*) AS c FROM hits WHERE ${clause.sql} GROUP BY d, s, path, visitor, campaign HAVING d >= 0`,
        binds: [...day.binds, ...seg.binds, ...clause.binds],
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
      const clause = siteWindowClause(BEST_SUDOKU_SITES, startMs, endMs)
      const seg = segmentColumn(3_600_000, cuts)
      return {
        db: 'gss_geo',
        sql: `SELECT ${seg.sql} AS s, path, visitor, campaign, COUNT(*) AS c FROM hits WHERE ${clause.sql} GROUP BY s, path, visitor, campaign`,
        binds: [...seg.binds, ...clause.binds],
      }
    },
    parse: (raw) => beacon(raw, noPf),
  },

  popupRangePath: {
    id: 'popupRangePath',
    db: 'gss_geo',
    keyParams: ['since', 'until', 'sites'],
    honors: ['range', 'sites'],
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
      const inc = popupIncludeClause()
      w.push(inc.sql)
      b.push(...inc.binds)
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
}

/** "Which paths existed AT ALL (any campaign, tagged or not) site-wide during this flight's
 * SERVING window" — the per-flight instrumentation check (lib/metrics/instrumentation.ts
 * seenInFlightWindow). Moved here from functions/_lib/campaignInstrumentation.ts, which now
 * runs this builder. Requires a confirmed flightStart. */
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
