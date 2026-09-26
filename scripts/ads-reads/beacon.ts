// Beacon (D1 gss-geo `hits`) reads for the ads routine. Every WHERE clause is built from the
// SAME lib functions the dashboard's Pages Functions use — campaignAttributionClause (row
// membership), applyExclusions (household / Reston verification / lifecycle email),
// popupIncludeClause (event paths) — so the routine and /api/campaigns cannot disagree about
// which rows count. Aggregate GROUP BY queries only: no row is ever fetched on its own, and
// nothing is joined across rows.

import { applyExclusions, campaignAttributionClause, type CampaignFlight } from '../../src/lib/campaigns'
import { excludeInstallGapUnmeasured, INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS, popupIncludeClause, type HourPathCount } from '../../src/lib/popupEvents'
import type { ReturnRow, ReturnSiteStat, TaggedRow } from '../../src/lib/adsRules'
import type { D1Select } from './d1'

export const WEB_SITE = 'bestsudoku-web'
export const APP_SITE = 'bestsudoku-app'

export interface Query {
  sql: string
  binds: unknown[]
}

/** Campaign-attributed rows, by (UTC hour, path, visitor). */
export function taggedRowsQuery(campaign: CampaignFlight): Query {
  const attr = campaignAttributionClause(campaign)
  const w = [attr.sql]
  const b: unknown[] = [...attr.binds]
  applyExclusions(w, b)
  excludeInstallGapUnmeasured(w, b) // pre-fix install-gap rows are unmeasured, not zero
  return { sql: `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, visitor, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY hr, path, visitor`, binds: b }
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

export interface BeaconSource {
  tagged(campaign: CampaignFlight): Promise<TaggedRow[]>
  siteEvents(sinceMs: number): Promise<HourPathCount[]>
  returns(campaign: CampaignFlight): Promise<ReturnRow[]>
  returnSites(sinceMs: number): Promise<ReturnSiteStat[]>
}

const n = (x: unknown) => Number(x) || 0

export function createBeaconSource(select: D1Select): BeaconSource {
  return {
    async tagged(campaign) {
      const q = taggedRowsQuery(campaign)
      const rows = await select<any>(q.sql, q.binds)
      return rows.map((x) => ({ hourStartMs: n(x.hr) * 3_600_000, path: String(x.path ?? ''), visitor: String(x.visitor ?? ''), count: n(x.c) }))
    },
    async siteEvents(sinceMs) {
      const q = siteEventsQuery(sinceMs)
      const rows = await select<any>(q.sql, q.binds)
      return rows.map((x) => ({ hourStartMs: n(x.hr) * 3_600_000, path: String(x.path ?? ''), count: n(x.c), postInstallFix: n(x.pf) === 1 }))
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
  }
}
