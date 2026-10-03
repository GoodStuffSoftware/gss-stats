// Beacon (D1 gss-geo `hits`) reads for the ads routine. Every WHERE clause is built from the
// SAME lib functions the dashboard's Pages Functions use — campaignAttributionClause (row
// membership), applyExclusions (household / Reston verification / lifecycle email),
// popupIncludeClause (event paths) — so the routine and the dashboard's campaign cards and
// charts cannot disagree about which rows count. Aggregate GROUP BY queries only: no row is ever fetched on its own, and
// nothing is joined across rows.

import { applyExclusions, campaignAttributionClause, type CampaignFlight } from '../../src/lib/campaigns'
import { excludeInstallGapUnmeasured, INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS, popupIncludeClause, type HourPathCount } from '../../src/lib/popupEvents'
import { ASK_PATHS, UPSELL_SIGNEDOUT_FIX_AT, type FirstSessionRowSite, type ReturnRow, type ReturnSiteStat, type TaggedRow } from '../../src/lib/adsRules'
import type { D1Select } from './d1'

export const WEB_SITE = 'bestsudoku-web'
export const APP_SITE = 'bestsudoku-app'

export interface Query {
  sql: string
  binds: unknown[]
}

/** Campaign-attributed rows, by (UTC hour, path, visitor) — and, when a segment boundary is
 * set (lib/adsRules.ts UPSELL_SIGNEDOUT_FIX_AT), by `uf` = the row is at or after it, so the
 * pre-fix / post-fix split is exact at the instant (the same device as the install fix's `pf`). */
export function taggedRowsQuery(campaign: CampaignFlight, upsellFixAtMs: number | null = UPSELL_SIGNEDOUT_FIX_AT): Query {
  const attr = campaignAttributionClause(campaign)
  const w = [attr.sql]
  const b: unknown[] = [...attr.binds]
  applyExclusions(w, b)
  excludeInstallGapUnmeasured(w, b) // pre-fix install-gap rows are unmeasured, not zero
  if (upsellFixAtMs == null) return { sql: `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, visitor, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY hr, path, visitor`, binds: b }
  return {
    sql: `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, visitor, (ts >= ?) AS uf, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY hr, path, visitor, uf`,
    binds: [upsellFixAtMs, ...b],
  }
}

/** Site-wide pop-up/event rows on the web site since `sinceMs`, by (UTC hour, path). NOT
 * campaign-attributed — outcome beacons fire in later, untagged sessions. */
export function siteEventsQuery(sinceMs: number, fixedAtMs: number | null = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): Query {
  const inc = popupIncludeClause()
  const w = ['site = ?', 'ts >= ?', inc.sql]
  const b: unknown[] = [WEB_SITE, sinceMs, ...inc.binds]
  applyExclusions(w, b)
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
 * path's own uc (lib/campaigns.ts parseReturnPath re-checks it exactly). Not date-windowed:
 * a d31-60 return fires long after the flight. */
export function returnRowsQuery(campaign: CampaignFlight): Query {
  const w = ['site IN (?, ?)', `(${campaign.ucValues.map(() => 'path LIKE ?').join(' OR ')})`]
  const b: unknown[] = [WEB_SITE, APP_SITE, ...campaign.ucValues.map((u) => `/return/${u}/%`)]
  applyExclusions(w, b)
  return { sql: `SELECT site, path, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY site, path`, binds: b }
}

/** Any-campaign /return/ rows per site since `sinceMs` — first/last seen (aggregates) for the
 * Play "not yet seen" line. */
export function returnSitesQuery(sinceMs: number): Query {
  const w = ['site IN (?, ?)', 'path LIKE ?', 'ts >= ?']
  const b: unknown[] = [WEB_SITE, APP_SITE, '/return/%', sinceMs]
  applyExclusions(w, b)
  return { sql: `SELECT site, COUNT(*) AS c, MIN(ts) AS t0, MAX(ts) AS t1 FROM hits WHERE ${w.join(' AND ')} GROUP BY site`, binds: b }
}

/** Campaign-attributed arrivals by country, aggregate counts only (R5). The SAME attribution
 * and exclusion clauses as taggedRowsQuery (household etc.), so it can never disagree with the
 * funnel reads it sits alongside — no separate rule, no individual-level join. */
export function taggedCountryQuery(campaign: CampaignFlight): Query {
  const attr = campaignAttributionClause(campaign)
  const w = [attr.sql]
  const b: unknown[] = [...attr.binds]
  applyExclusions(w, b)
  return { sql: `SELECT country, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY country ORDER BY c DESC`, binds: b }
}

export interface CountryCount {
  country: string
  count: number
}
export interface BeaconSource {
  /** `upsellFixAtMs`: undefined = the configured instant; null = no segment flag. */
  tagged(campaign: CampaignFlight, upsellFixAtMs?: number | null): Promise<TaggedRow[]>
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
    async tagged(campaign, upsellFixAtMs) {
      const q = taggedRowsQuery(campaign, upsellFixAtMs === undefined ? UPSELL_SIGNEDOUT_FIX_AT : upsellFixAtMs)
      const rows = await select<any>(q.sql, q.binds)
      return rows.map((x) => ({
        hourStartMs: n(x.hr) * 3_600_000,
        path: String(x.path ?? ''),
        visitor: String(x.visitor ?? ''),
        count: n(x.c),
        ...(x.uf === undefined ? {} : { postUpsellFix: n(x.uf) === 1 }),
      }))
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
      return rows.map((x) => ({ site: String(x.site ?? ''), count: n(x.c), firstMs: x.t0 == null ? null : n(x.t0), lastMs: x.t1 == null ? null : n(x.t1) }))
    },
    async countryCounts(campaign) {
      const q = taggedCountryQuery(campaign)
      const rows = await select<any>(q.sql, q.binds)
      return rows.map((x) => ({ country: String(x.country ?? ''), count: n(x.c) }))
    },
  }
}
