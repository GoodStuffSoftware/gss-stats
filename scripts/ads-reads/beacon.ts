// Beacon (D1 gss-geo `hits`) reads for the ads routine. Every WHERE clause is built from the
// SAME lib functions the dashboard's Pages Functions use — campaignAttributionClause (row
// membership), applyExclusions (household / Reston verification / lifecycle email),
// popupIncludeClause (event paths) — so the routine and the dashboard's campaign cards and
// charts cannot disagree about which rows count. Aggregate GROUP BY queries only: no row is ever fetched on its own, and
// nothing is joined across rows.

import { applyExclusions, campaignAttributionClause, campaignAttributionStartMs, type CampaignFlight } from '../../src/lib/campaigns'
import { excludeInstallGapUnmeasured, INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS, popupIncludeClause, type HourPathCount } from '../../src/lib/popupEvents'
import { ASK_PATHS, UPSELL_SIGNEDOUT_FIX_AT, type FirstSessionRowSite, type ReturnRow, type ReturnSiteStat, type TaggedRow } from '../../src/lib/adsRules'
import { refusedPathExcludeClause, refusedPathMatch } from '../../src/lib/splitGuard'
import { etDateSql, etWallTimeMs } from '../../src/lib/etTime'
import type { D1Select } from './d1'

export const WEB_SITE = 'bestsudoku-web'
export const APP_SITE = 'bestsudoku-app'

export interface Query {
  sql: string
  binds: unknown[]
}

/** Campaign-attributed rows, by (UTC hour, path, visitor, campaign tag) — and, when a segment boundary is
 * set (lib/adsRules.ts UPSELL_SIGNEDOUT_FIX_AT), by `uf` = the row is at or after it, so the
 * pre-fix / post-fix split is exact at the instant (the same device as the install fix's `pf`).
 * COUNTS ONLY (src/lib/splitGuard.ts): the rows the rule protects (returns, completions, game
 * starts, tour skips and exits, tutorial completions) are grouped by their ET DAY (`etd`, the SQL
 * etDateSql expression), never by hour: their `hr` is NULL, so no hour of day, or UTC hour, of one
 * ever leaves D1. Every other row keeps its UTC hour `hr` (the maturity and window cuts of the
 * pop-up reads). Every window the routine cuts these rows at is an ET midnight, so the day group
 * is exact. The one other cut is the health pair's maturity instant: with `maturedBeforeMs` set,
 * `mat` = the row's hour starts at or before it, a single row-exact flag (like `uf`) so a refused
 * row can still be counted against that moving instant without an hour (a running total up to an
 * instant, the same residual as "today so far", splitGuard.ts SEGMENT CUTS).
 * The report's tagged `/coach/shown/place` count (a refused path) comes from these rows too, printed only as
 * cumulative and yesterday's-ET-day totals (lib/adsRules.ts summarizeTaggedRows), never by hour.
 * `campaign` is the row's own utm_campaign (always one of the arm's ucValues: the WHERE is an IN),
 * carried so an arm with several tags can print a per-tag split (lib/tagSplit.ts). A tag is not an
 * hour, a place or a device (src/lib/splitGuard.ts), and the split is only ever printed as
 * cumulative and ET-day row totals; every rule still sums the rows of all the arm's tags. */
export function taggedRowsQuery(campaign: CampaignFlight, upsellFixAtMs: number | null = UPSELL_SIGNEDOUT_FIX_AT, maturedBeforeMs: number | null = null): Query {
  const attr = campaignAttributionClause(campaign)
  const w = [attr.sql]
  const b: unknown[] = [...attr.binds]
  applyExclusions(w, b)
  excludeInstallGapUnmeasured(w, b) // pre-fix install-gap rows are unmeasured, not zero
  const refused = refusedPathMatch().sql
  const cols = [`CASE WHEN ${refused} THEN NULL ELSE CAST(ts / 3600000 AS INTEGER) END AS hr`, `CASE WHEN ${refused} THEN ${etDateSql()} ELSE NULL END AS etd`, 'path', 'visitor', 'campaign']
  const groups = ['hr', 'etd', 'path', 'visitor', 'campaign']
  const selBinds: unknown[] = []
  if (upsellFixAtMs != null) {
    cols.push('(ts >= ?) AS uf')
    groups.push('uf')
    selBinds.push(upsellFixAtMs)
  }
  if (maturedBeforeMs != null) {
    // Only a `new`-visitor refused row carries the flag (the health pair counts new arrivals only); a
    // returning-visitor refused row gets NULL, so it has no sub-day cut at all.
    cols.push(`CASE WHEN ${refused} AND COALESCE(visitor, '') <> 'new' THEN NULL ELSE (CAST(ts / 3600000 AS INTEGER) * 3600000 <= ?) END AS mat`)
    groups.push('mat')
    selBinds.push(maturedBeforeMs)
  }
  return { sql: `SELECT ${cols.join(', ')}, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY ${groups.join(', ')}`, binds: [...selBinds, ...b] }
}

/** Site-wide pop-up/event rows on the web site since `sinceMs`, by (UTC hour, path). NOT
 * campaign-attributed — outcome beacons fire in later, untagged sessions. The rows the
 * counts-only rule protects (src/lib/splitGuard.ts: returns, game starts and completions,
 * tutorial completions, tour skips and exits) are left out (their patterns are SQL literals, so they cost
 * no binds): this read is by hour, and none of them is a pop-up event summarizeSiteEvents counts. */
export function siteEventsQuery(sinceMs: number, fixedAtMs: number | null = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): Query {
  const inc = popupIncludeClause()
  const w = ['site = ?', 'ts >= ?', inc.sql]
  const b: unknown[] = [WEB_SITE, sinceMs, ...inc.binds]
  applyExclusions(w, b)
  refusedPathExcludeClause(w, b)
  // `pf` splits each hour row-exactly at the install fix (lib/popupEvents.ts
  // INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): summarizeSiteEvents drops pre-fix gap rows and
  // counts post-fix accepts for the install health pair.
  const pf = fixedAtMs === null ? '0' : '(ts >= ?)'
  return {
    sql: `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, ${pf} AS pf, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY hr, path, pf`,
    binds: fixedAtMs === null ? b : [fixedAtMs, ...b],
  }
}

/** Site-wide first-session rows on the web site in [sinceMs, untilMs) (lib/adsRules.ts
 * firstSessionBucket): each first-session path by name, arrivals as /return/<any uc>/d0 rows
 * (one per device's first tagged visit). NOT campaign-attributed; the counterpart the tagged
 * first-session figures are read beside, over the same [sinceMs, untilMs) window. */
export function siteFirstSessionQuery(sinceMs: number, untilMs: number): Query {
  const match = [
    `path = '/game'`,
    `path LIKE '/game/complete/%'`,
    `path IN ('/tour/start', '/tour/complete', '/tour/skip', '/game/first-move')`,
    `path LIKE '/game/abandon/%'`,
    `path LIKE '/welcome-signed-in/%'`,
    `path LIKE '/tour/exit-at/%'`,
    `path LIKE '/game/start/%'`,
    `path LIKE '/game/tutorial-complete/%'`,
    `path IN (${ASK_PATHS.map((p) => `'${p}'`).join(', ')})`,
    `path LIKE '/return/%/d0'`,
  ].join(' OR ')
  const w = ['site = ?', 'ts >= ?', 'ts < ?']
  const b: unknown[] = [WEB_SITE, sinceMs, untilMs]
  applyExclusions(w, b)
  return {
    sql: `SELECT path AS p, COUNT(*) AS c FROM hits WHERE ${[...w, `(${match})`].join(' AND ')} GROUP BY p`,
    binds: b,
  }
}

/** Tagged first-session arrivals: /return/<uc>/d0 rows (one per device's first tagged visit,
 * best-sudoku src/services/campaignReturns.ts) for this campaign's own tags, web and app, in
 * [sinceMs, untilMs). Attributed by the path's uc like returnRowsQuery (the d0 row can land in a
 * later, untagged page load). */
export function returnArrivalsQuery(campaign: CampaignFlight, sinceMs: number, untilMs: number): Query {
  const w = ['site IN (?, ?)', `path IN (${campaign.ucValues.map(() => '?').join(', ')})`, 'ts >= ?', 'ts < ?']
  const b: unknown[] = [WEB_SITE, APP_SITE, ...campaign.ucValues.map((u) => `/return/${u}/d0`), sinceMs, untilMs]
  applyExclusions(w, b)
  return { sql: `SELECT path, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY path`, binds: b }
}

/** /return/<uc>/<bucket> rows for this campaign's tags on web and app — attributed by the
 * path's own uc (lib/campaigns.ts parseReturnPath re-checks it exactly). Lower-bounded by the
 * campaign's attribution start (the same bound as the dashboard's campaignReturns fact, so the
 * routine and the page count the same rows); no upper bound: a d31-60 return fires long after
 * the flight. An unconfirmed flightStart attributes nothing. */
export function returnRowsQuery(campaign: CampaignFlight): Query {
  const w = ['site IN (?, ?)', `(${campaign.ucValues.map(() => 'path LIKE ?').join(' OR ')})`]
  const b: unknown[] = [WEB_SITE, APP_SITE, ...campaign.ucValues.map((u) => `/return/${u}/%`)]
  const startMs = campaignAttributionStartMs(campaign)
  if (startMs === null) w.push('1 = 0')
  else {
    w.push('ts >= ?')
    b.push(startMs)
  }
  applyExclusions(w, b)
  return { sql: `SELECT site, path, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY site, path`, binds: b }
}

/** Every /return/ row per site since `sinceMs` — any campaign's AND the web-only organic arm's
 * (untagged fresh installs, lib/campaigns.ts ORGANIC_ARM_ID), since the pattern is `/return/%` —
 * with the ET DATE of the first and last row (aggregates) for the Play "not yet seen" line.
 * Counts only (src/lib/splitGuard.ts): the SQL reads each row's ET day (lib/etTime.ts
 * etDateSql, the geo `dateEt` expression), never its ts, so no hour or minute of a /return/ row
 * ever leaves D1. 'YYYY-MM-DD' text sorts by date, so MIN/MAX give the first and last day. */
export function returnSitesQuery(sinceMs: number): Query {
  const w = ['site IN (?, ?)', 'path LIKE ?', 'ts >= ?']
  const b: unknown[] = [WEB_SITE, APP_SITE, '/return/%', sinceMs]
  applyExclusions(w, b)
  const d = etDateSql()
  return { sql: `SELECT site, COUNT(*) AS c, MIN(${d}) AS d0, MAX(${d}) AS d1 FROM hits WHERE ${w.join(' AND ')} GROUP BY site`, binds: b }
}

/** A returnSitesQuery d0/d1 cell as an ET 'YYYY-MM-DD' day, or null. Defense in depth for the
 * counts-only rule: anything else (a raw ts, a time-bearing string) is dropped, never shown. */
export function etDay(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

/** Campaign-attributed arrivals by country, aggregate counts only (R5). The SAME attribution
 * and exclusion clauses as taggedRowsQuery (household etc.), so it can never disagree with the
 * funnel reads it sits alongside — no separate rule, no individual-level join. The rows the
 * counts-only rule protects (src/lib/splitGuard.ts) are left out: none is split by place, the
 * same as the dashboard's country columns. */
export function taggedCountryQuery(campaign: CampaignFlight): Query {
  const attr = campaignAttributionClause(campaign)
  const w = [attr.sql]
  const b: unknown[] = [...attr.binds]
  applyExclusions(w, b)
  refusedPathExcludeClause(w, b)
  return { sql: `SELECT country, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY country ORDER BY c DESC`, binds: b }
}

export interface CountryCount {
  country: string
  count: number
}
/** The v1.99.1 web release instant (UTC wall time). One constant: the SQL below turns it into epoch ms
 * with strftime, never a hand-computed epoch. Not in the releases registry, so it lives here. */
export const PREFLIGHT_RELEASE_UTC = '2026-10-16 21:07:00'
export const PREFLIGHT_RELEASE_LABEL = 'v1.99.1 web, 2026-10-16 21:07Z'

export interface PreflightCounts {
  coach: number
  committed: number
  eligible: number
}
/** The flight 3 pre-flight gate rule, stated once (stats-requirements §6: real organic /coach/* rows plus
 * a /signin-prompt/committed-* or /signin-eligible/* row). §6 does not say how many; the choice is
 * MET when coach > 0 AND (committed + eligible) > 0. */
export function preflightGateMet(c: PreflightCounts): boolean {
  return c.coach > 0 && c.committed + c.eligible > 0
}
export function preflightGateLine(c: PreflightCounts): string {
  return `Pre-flight gate (organic since ${PREFLIGHT_RELEASE_LABEL}): /coach/* ${c.coach} · /signin-prompt/committed-* ${c.committed} · /signin-eligible/* ${c.eligible} → ${preflightGateMet(c) ? 'MET' : 'NOT YET'}`
}

/** Organic (no uc / campaign tag) web rows on the new paths since the release, with the standing
 * own-traffic and known-traffic exclusions. Counts only: one cumulative row, no hour, place or device. */
export function preflightGateQuery(): Query {
  const w = ['site = ?', `ts >= strftime('%s','${PREFLIGHT_RELEASE_UTC}')*1000`, `(campaign IS NULL OR campaign = '')`, `(path LIKE '/coach/%' OR path LIKE '/signin-prompt/committed-%' OR path LIKE '/signin-eligible/%')`]
  const b: unknown[] = [WEB_SITE]
  applyExclusions(w, b)
  return {
    sql: `SELECT COALESCE(SUM(path LIKE '/coach/%'), 0) AS coach, COALESCE(SUM(path LIKE '/signin-prompt/committed-%'), 0) AS committed, COALESCE(SUM(path LIKE '/signin-eligible/%'), 0) AS eligible FROM hits WHERE ${w.join(' AND ')}`,
    binds: b,
  }
}

export interface BeaconSource {
  /** Optional: the pre-flight gate counts (preflightGateQuery). Absent = line not printed. */
  preflightGate?(): Promise<PreflightCounts>
  /** `upsellFixAtMs`: undefined = the configured instant; null = no segment flag. */
  tagged(campaign: CampaignFlight, upsellFixAtMs?: number | null, maturedBeforeMs?: number | null): Promise<TaggedRow[]>
  siteEvents(sinceMs: number): Promise<HourPathCount[]>
  returns(campaign: CampaignFlight): Promise<ReturnRow[]>
  returnSites(sinceMs: number): Promise<ReturnSiteStat[]>
  /** Optional: site-wide first-session rows (siteFirstSessionQuery). Absent = not read. */
  siteFirstSession?(sinceMs: number, untilMs: number): Promise<FirstSessionRowSite[]>
  /** Optional: tagged first-session arrivals (returnArrivalsQuery). Absent = not read. */
  returnArrivals?(campaign: CampaignFlight, sinceMs: number, untilMs: number): Promise<{ path: string; count: number }[]>
  /** Optional (R5): aggregate counts per country for campaign-attributed arrivals. */
  countryCounts?(campaign: CampaignFlight): Promise<CountryCount[]>
}

const n = (x: unknown) => Number(x) || 0

export function createBeaconSource(select: D1Select): BeaconSource {
  return {
    async preflightGate() {
      const q = preflightGateQuery()
      const r = (await select<any>(q.sql, q.binds))[0] ?? {}
      return { coach: n(r.coach), committed: n(r.committed), eligible: n(r.eligible) }
    },
    async tagged(campaign, upsellFixAtMs, maturedBeforeMs) {
      const q = taggedRowsQuery(campaign, upsellFixAtMs === undefined ? UPSELL_SIGNEDOUT_FIX_AT : upsellFixAtMs, maturedBeforeMs ?? null)
      const rows = await select<any>(q.sql, q.binds)
      return rows.map((x) => {
        // A refused-path row carries its ET day (hr is NULL): placed at that day's ET midnight, so every
        // ET-day window reads it exactly and no hour of it is ever known.
        const day = etDay(x.etd)
        return {
          hourStartMs: day ? etWallTimeMs(day) : n(x.hr) * 3_600_000,
          path: String(x.path ?? ''),
          visitor: String(x.visitor ?? ''),
          campaign: String(x.campaign ?? ''),
          count: n(x.c),
          ...(x.uf === undefined ? {} : { postUpsellFix: n(x.uf) === 1 }),
          ...(x.mat == null ? {} : { matured: n(x.mat) === 1 }),
        }
      })
    },
    async siteEvents(sinceMs) {
      const q = siteEventsQuery(sinceMs)
      const rows = await select<any>(q.sql, q.binds)
      return rows.map((x) => ({ hourStartMs: n(x.hr) * 3_600_000, path: String(x.path ?? ''), count: n(x.c), postInstallFix: n(x.pf) === 1 }))
    },
    async siteFirstSession(sinceMs, untilMs) {
      const q = siteFirstSessionQuery(sinceMs, untilMs)
      const rows = await select<any>(q.sql, q.binds)
      return rows.map((x) => ({ path: String(x.p ?? ''), count: n(x.c) }))
    },
    async returnArrivals(campaign, sinceMs, untilMs) {
      const q = returnArrivalsQuery(campaign, sinceMs, untilMs)
      const rows = await select<any>(q.sql, q.binds)
      return rows.map((x) => ({ path: String(x.path ?? ''), count: n(x.c) }))
    },
    async returns(campaign) {
      const q = returnRowsQuery(campaign)
      const rows = await select<any>(q.sql, q.binds)
      return rows.map((x) => ({ site: String(x.site ?? ''), path: String(x.path ?? ''), count: n(x.c) }))
    },
    async returnSites(sinceMs) {
      const q = returnSitesQuery(sinceMs)
      const rows = await select<any>(q.sql, q.binds)
      return rows.map((x) => ({ site: String(x.site ?? ''), count: n(x.c), firstEtDate: etDay(x.d0), lastEtDate: etDay(x.d1) }))
    },
    async countryCounts(campaign) {
      const q = taggedCountryQuery(campaign)
      const rows = await select<any>(q.sql, q.binds)
      return rows.map((x) => ({ country: String(x.country ?? ''), count: n(x.c) }))
    },
  }
}
