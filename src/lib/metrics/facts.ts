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
//   bskKpiMinutes       ← /api/overview's KPI query
//   bskHourPath         ← /api/overview's timeline query
//   popupHourPath       ← /api/popups' query
//   adsSpend            ← lib/adsStore.ts SPEND_SUMMARY_SQL (gss-stats' own store)
//
// ANONYMITY (hard rule, lib/campaigns.ts header): no fact selects `id` or a raw `ts` (only
// minute/hour buckets and the boolean `ts >= ?` split), and none joins rows. facts.test.ts
// checks every statement.

import { applyExclusions, CAMPAIGNS, campaignAttributionClause, campaignById, etFlightRangeMs, etMidnightUtcMs, type CampaignFlight } from '../campaigns'
import { excludeInstallGapUnmeasured, INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS, popupIncludeClause } from '../popupEvents'
import { addEtDays, siteWindowClause } from '../overview'
import { BEST_SUDOKU_SITES } from '../defaults'
import { mapSpendSummary, SPEND_SUMMARY_SQL } from '../adsStore'
import type { SpendSummary } from '../adsRules'

export type FactId = 'campaignPathVisitor' | 'campaignReturns' | 'flightPathsSeen' | 'bskKpiMinutes' | 'bskHourPath' | 'popupHourPath' | 'adsSpend'

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

/** One aggregate row of a beacon fact. `t` is the bucket's start (epoch ms) for a timed fact,
 * null for an untimed one; `pf` is the row-exact split at FactDef.splitAt (null when the fact
 * has none). `c` is the COUNT(*). */
export interface BeaconRow {
  path: string
  visitor: string
  campaign: string
  t: number | null
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
  /** Bucket size of `t` in ms (60 000 or 3 600 000), or null for an untimed fact. */
  bucketMs: number | null
  /** The instant `pf` splits at (the install fix), or null when the fact has no split. */
  splitAt: number | null
  ttl: FactTtl
  /** ONE aggregate statement. `nowMs` only bounds a live window (never part of the key). */
  build(p: FactParams, nowMs: number): FactStatement
  parse(raw: Record<string, unknown>[]): FactRows
}

// Return and funnel beacons are web-only (lib/campaigns.ts; functions/api/campaigns.ts BSK_SITE).
export const BSK_WEB_SITE = 'bestsudoku-web'
const INSTALL_FIX = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
/** [since, until) in epoch ms, the way /api/popups and /api/overview read their range: a bare
 * YYYY-MM-DD `until` is inclusive (the following midnight UTC). */
export function rangeMs(since: string, until: string): [number, number] {
  return [Date.parse(since), DATE_ONLY_RE.test(until) ? Date.parse(until) + 86_400_000 : Date.parse(until)]
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

const str = (x: unknown): string => (x == null ? '' : String(x))
const num = (x: unknown): number => Number(x) || 0
const beacon = (raw: Record<string, unknown>[], t: (r: Record<string, unknown>) => number | null, pf: (r: Record<string, unknown>) => boolean | null): FactRows => ({
  kind: 'beacon',
  rows: raw.map((r) => ({ path: str(r.path), visitor: str(r.visitor), campaign: str(r.campaign), t: t(r), pf: pf(r), c: num(r.c) })),
})
const pfOf = (r: Record<string, unknown>): boolean | null => (INSTALL_FIX === null ? false : num(r.pf) === 1)

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
    parse: (raw) => beacon(raw, () => null, pfOf),
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
    parse: (raw) => beacon(raw, () => null, () => null),
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
    parse: (raw) => beacon(raw, () => null, () => null),
  },

  bskKpiMinutes: {
    id: 'bskKpiMinutes',
    db: 'gss_geo',
    keyParams: ['todayEt'],
    honors: [],
    bucketMs: 60_000,
    splitAt: null,
    ttl: { seconds: 90 },
    build(p, nowMs) {
      if (!p.todayEt) throw new Error('bskKpiMinutes needs todayEt')
      // Today plus the 7 ET days before it (the vs-yesterday and 7-day-average windows).
      const clause = siteWindowClause(BEST_SUDOKU_SITES, etMidnightUtcMs(addEtDays(p.todayEt, -7)), nowMs)
      return {
        db: 'gss_geo',
        sql: `SELECT CAST(ts / 60000 AS INTEGER) AS min, path, visitor, campaign, COUNT(*) AS c FROM hits WHERE ${clause.sql} GROUP BY min, path, visitor, campaign`,
        binds: clause.binds,
      }
    },
    parse: (raw) => beacon(raw, (r) => num(r.min) * 60_000, () => null),
  },

  bskHourPath: {
    id: 'bskHourPath',
    db: 'gss_geo',
    keyParams: ['since', 'until'],
    honors: ['range'],
    bucketMs: 3_600_000,
    splitAt: null,
    ttl: 'range',
    build(p) {
      const [startMs, endMs] = rangeMs(p.since!, p.until!)
      const clause = siteWindowClause(BEST_SUDOKU_SITES, startMs, endMs)
      return {
        db: 'gss_geo',
        sql: `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, visitor, campaign, COUNT(*) AS c FROM hits WHERE ${clause.sql} GROUP BY hr, path, visitor, campaign`,
        binds: clause.binds,
      }
    },
    parse: (raw) => beacon(raw, (r) => num(r.hr) * 3_600_000, () => null),
  },

  popupHourPath: {
    id: 'popupHourPath',
    db: 'gss_geo',
    keyParams: ['since', 'until', 'sites'],
    honors: ['range', 'sites'],
    bucketMs: 3_600_000,
    splitAt: INSTALL_FIX,
    ttl: 'range',
    build(p) {
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
      return {
        db: 'gss_geo',
        sql: `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, ${pf.sql} AS pf, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY hr, path, pf`,
        binds: [...pf.binds, ...b],
      }
    },
    parse: (raw) => beacon(raw, (r) => num(r.hr) * 3_600_000, pfOf),
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
