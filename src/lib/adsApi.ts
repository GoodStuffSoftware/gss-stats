// Minimal, READ-ONLY Google Ads REST client — a port of the calls best-sudoku's
// scripts/marketing/ads-api-report.mjs makes, without the google-ads-api dependency.
//
// RUNTIME-AGNOSTIC: plain `fetch` + `AbortSignal.timeout`, no Node imports, so the same
// client serves the local CLIs (scripts/ads-reads/) and the gss-stats-sync Worker
// (workers/sync/). Credentials are handed in by the caller (Bitwarden locally, Worker
// secrets in Cloudflare) and never leave memory.
//
// READ-ONLY BY CONSTRUCTION: the only endpoint this module can reach is
// `customers/<id>/googleAds:search` (a GAQL SELECT). There is no mutate call anywhere, and
// search() refuses any query that is not a SELECT.
//
// NO MANAGER HEADER: requests carry Authorization + developer-token only. A
// login-customer-id header is never sent, and GOOGLE_ADS_LOGIN_CUSTOMER_ID is never read
// (buildHeaders asserts it).

import { ADS_API_VERSION, ADS_CUSTOMER_ID, APPROVED_PLACEMENTS_BY_CAMPAIGN, assertKnownCampaign, isApprovedPlacement, readPlanFor, round2, microsToDollars, type SpendDay } from './adsRules'
import type { PlacementDayRow } from './adsStore'
import { redact, registerSecret } from './adsRedact'

export interface AdsCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
  developerToken: string
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** Every external call gives up after this long by default (review L8). */
export const DEFAULT_EXTERNAL_TIMEOUT_MS = 60_000
export const timedOutText = (ms: number): string => `timed out after ${Math.round(ms / 1000)}s`

/** fetch with an external timeout (review L8); a timeout rejects with a plain
 * "<host> timed out after 60s" so the failure summary says what happened. */
export function createTimedFetch(timeoutMs: number = DEFAULT_EXTERNAL_TIMEOUT_MS): FetchLike {
  return async (url, init) => {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`${new URL(url).host} ${timedOutText(timeoutMs)}`)
      throw e
    }
  }
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function buildHeaders(accessToken: string, developerToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'content-type': 'application/json',
  }
  if (Object.keys(headers).some((k) => k.toLowerCase() === 'login-customer-id')) throw new Error('login-customer-id must never be sent')
  return headers
}

export function searchUrl(customerId: string = ADS_CUSTOMER_ID, apiVersion: string = ADS_API_VERSION): string {
  if (!/^\d+$/.test(customerId)) throw new Error('invalid customer id')
  if (!/^v\d+$/.test(apiVersion)) throw new Error('invalid api version')
  return `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`
}

function adsErrorMessage(status: number, body: string): string {
  try {
    const j = JSON.parse(body)
    const e = Array.isArray(j) ? j[0]?.error : j?.error
    const inner = e?.details?.flatMap((d: any) => (d?.errors ?? []).map((x: any) => x?.message)).filter(Boolean) ?? []
    return redact(`HTTP ${status}: ${e?.message ?? 'error'}${inner.length ? ` (${inner.join('; ')})` : ''}`)
  } catch {
    return redact(`HTTP ${status}: ${body.slice(0, 200)}`)
  }
}

export interface AdsClient {
  search(query: string): Promise<any[]>
}

export async function createAdsClient(
  creds: AdsCredentials,
  opts: { customerId?: string; apiVersion?: string; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<AdsClient> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? createTimedFetch(opts.timeoutMs)
  const tokenRes = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  })
  const tokenBody = await tokenRes.text()
  if (!tokenRes.ok) {
    let reason = `HTTP ${tokenRes.status}`
    try {
      const j = JSON.parse(tokenBody)
      reason += `: ${j.error ?? ''}${j.error_description ? ` (${j.error_description})` : ''}`
    } catch {
      /* keep the status only */
    }
    throw new Error(`OAuth refresh failed, ${redact(reason)}`)
  }
  let accessToken: string
  try {
    accessToken = JSON.parse(tokenBody).access_token
  } catch {
    throw new Error('OAuth refresh returned a body that is not JSON')
  }
  if (!accessToken) throw new Error('OAuth refresh returned no access_token')
  registerSecret(accessToken)
  const url = searchUrl(opts.customerId, opts.apiVersion)
  const headers = buildHeaders(accessToken, creds.developerToken)

  return {
    async search(query: string): Promise<any[]> {
      if (!/^\s*SELECT\s/i.test(query)) throw new Error('the ads client only runs GAQL SELECT queries')
      const out: any[] = []
      let pageToken: string | undefined
      for (let page = 0; page < 50; page++) {
        const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(pageToken ? { query, pageToken } : { query }) })
        const body = await res.text()
        if (!res.ok) throw new Error(`Google Ads search failed, ${adsErrorMessage(res.status, body)}`)
        const j = JSON.parse(body)
        out.push(...(j.results ?? []))
        pageToken = j.nextPageToken
        if (!pageToken) break
      }
      return out
    },
  }
}

function checkRange(since: string, until: string): void {
  if (!DATE_RE.test(since) || !DATE_RE.test(until)) throw new Error('dates must be YYYY-MM-DD')
  if (since > until) throw new Error(`empty date range ${since}..${until}`)
}

export interface CampaignStatus {
  id: string
  name: string | null
  status: string | null // ENABLED | PAUSED | REMOVED
  servingStatus: string | null // SERVING | ENDED | …
  primaryStatus: string | null
  dailyBudget: number | null // dollars
}

export async function fetchCampaignStatus(client: AdsClient, campaignId: string): Promise<CampaignStatus> {
  readPlanFor(campaignId) // refuses closed campaigns before any query is built
  const rows = await client.search(
    `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.primary_status, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${campaignId}`,
  )
  const c = rows[0] ?? {}
  return {
    id: campaignId,
    name: c.campaign?.name ?? null,
    status: c.campaign?.status ?? null,
    servingStatus: c.campaign?.servingStatus ?? null,
    primaryStatus: c.campaign?.primaryStatus ?? null,
    dailyBudget: c.campaignBudget?.amountMicros != null ? Number(c.campaignBudget.amountMicros) / 1e6 : null,
  }
}

/** Per ET day (account time zone) cost/impressions/clicks. */
export async function fetchDailySpend(client: AdsClient, campaignId: string, since: string, until: string): Promise<Record<string, SpendDay>> {
  assertKnownCampaign(campaignId) // a READ: closed campaigns allowed for the backfill, never changed
  checkRange(since, until)
  const rows = await client.search(
    `SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE campaign.id = ${campaignId} AND segments.date BETWEEN '${since}' AND '${until}' ORDER BY segments.date`,
  )
  const days: Record<string, SpendDay> = {}
  for (const r of rows) {
    const date = r.segments?.date
    if (typeof date !== 'string' || !DATE_RE.test(date)) continue
    const prev = days[date] ?? { costMicros: 0, impressions: 0, clicks: 0 }
    days[date] = {
      costMicros: prev.costMicros + Number(r.metrics?.costMicros ?? 0),
      impressions: prev.impressions + Number(r.metrics?.impressions ?? 0),
      clicks: prev.clicks + Number(r.metrics?.clicks ?? 0),
    }
  }
  return days
}

/** The campaign's totals over the whole range in ONE row (segments.date filtered, not selected,
 * so Google aggregates). The sync's cross-check: before it stores a day the daily query left
 * out as zero, the daily rows must add up to this. `null` = Google returned no row at all (no
 * delivery in the range — or an empty answer, which the caller must not trust on its own). */
export async function fetchRangeTotal(client: AdsClient, campaignId: string, since: string, until: string): Promise<SpendDay | null> {
  assertKnownCampaign(campaignId)
  checkRange(since, until)
  const rows = await client.search(
    `SELECT metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE campaign.id = ${campaignId} AND segments.date BETWEEN '${since}' AND '${until}'`,
  )
  if (!rows.length) return null
  return rows.reduce<SpendDay>(
    (a, r) => ({
      costMicros: a.costMicros + Number(r.metrics?.costMicros ?? 0),
      impressions: a.impressions + Number(r.metrics?.impressions ?? 0),
      clicks: a.clicks + Number(r.metrics?.clicks ?? 0),
    }),
    { costMicros: 0, impressions: 0, clicks: 0 },
  )
}

/** Placement-level cost PER ET DAY (group_placement_view), each row tagged approved/not
 * against the campaign's approved list (lib/adsRules.ts APPROVED_PLACEMENTS_BY_CAMPAIGN;
 * null when none is on record). Stored in ads_placement_daily and summed by splitPlacements
 * for kill rule 1. A READ: closed campaigns allowed for the backfill. */
export async function fetchPlacementDaily(client: AdsClient, campaignId: string, since: string, until: string): Promise<PlacementDayRow[]> {
  assertKnownCampaign(campaignId)
  checkRange(since, until)
  const approvedList = APPROVED_PLACEMENTS_BY_CAMPAIGN[campaignId] ?? null
  const rows = await client.search(
    `SELECT segments.date, group_placement_view.placement, group_placement_view.display_name, group_placement_view.target_url, group_placement_view.placement_type, metrics.cost_micros, metrics.impressions, metrics.clicks FROM group_placement_view WHERE campaign.id = ${campaignId} AND segments.date BETWEEN '${since}' AND '${until}'`,
  )
  const out: PlacementDayRow[] = []
  for (const r of rows) {
    const v = r.groupPlacementView ?? {}
    const date = r.segments?.date
    const placement = v.placement ?? v.targetUrl ?? v.displayName
    if (typeof date !== 'string' || !DATE_RE.test(date) || !placement) continue
    out.push({
      date,
      placement: String(placement),
      displayName: v.displayName ?? null,
      targetUrl: v.targetUrl ?? null,
      type: v.placementType ?? null,
      // Machine identifiers only (never the free-text display name).
      approved: approvedList ? isApprovedPlacement([v.placement, v.targetUrl], approvedList) : null,
      costMicros: Number(r.metrics?.costMicros ?? 0),
      impressions: Number(r.metrics?.impressions ?? 0),
      clicks: Number(r.metrics?.clicks ?? 0),
    })
  }
  return out
}

export interface PlacementTotal {
  placement: string
  displayName: string | null
  approved: boolean | null
  costMicros: number
}
export interface PlacementSplit {
  itemizedCost: number // dollars, every placement row in range
  approvedCost: number // dollars, rows on the approved list
  byPlacement: PlacementTotal[] // cost-descending
}
/** Sums placement-day rows through `throughEt` (inclusive). The campaign total minus
 * itemizedCost over the SAME range is the un-itemized part. */
export function splitPlacements(rows: readonly PlacementDayRow[], throughEt: string | null): PlacementSplit {
  const agg = new Map<string, PlacementTotal>()
  let itemized = 0
  let approved = 0
  for (const r of rows) {
    if (throughEt != null && r.date > throughEt) continue
    itemized += r.costMicros
    if (r.approved) approved += r.costMicros
    const a = agg.get(r.placement) ?? { placement: r.placement, displayName: r.displayName, approved: r.approved, costMicros: 0 }
    a.costMicros += r.costMicros
    agg.set(r.placement, a)
  }
  return { itemizedCost: itemized / 1e6, approvedCost: approved / 1e6, byPlacement: [...agg.values()].sort((a, b) => b.costMicros - a.costMicros) }
}

// ── Diagnostic depth (informational only — REPORT LINES, never a kill rule or an automatic
// action; contract sections 12-13 are frozen). Ported from best-sudoku's
// scripts/marketing/ads-api-report.mjs (the old campaigns' `hourly`/`geo`/`devices`/
// `targeting` sub-reads), onto this REST client. A failure in any of these is caught by the
// caller (scripts/ads-reads/read.ts wraps each in `attempt()`) and reported as an
// unavailable diagnostic; it never blocks the spend/kill-rule read these sit alongside. ─────

export interface HourlyRow {
  date: string
  hour: number // 0-23, account time zone (America/New_York for this account)
  impressions: number
  clicks: number
  ctr: number
  cost: number // dollars
}
/** Per (day, hour) delivery in ACCOUNT time zone. Diagnostic depth restored for the closed
 * day (R2): pass since === until === the closed ET day being reported on. */
export async function fetchHourly(client: AdsClient, campaignId: string, since: string, until: string): Promise<HourlyRow[]> {
  assertKnownCampaign(campaignId)
  checkRange(since, until)
  const rows = await client.search(
    `SELECT segments.date, segments.hour, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros FROM campaign WHERE campaign.id = ${campaignId} AND segments.date BETWEEN '${since}' AND '${until}' ORDER BY segments.date, segments.hour`,
  )
  return rows
    .map((r): HourlyRow => ({
      date: r.segments?.date,
      hour: Number(r.segments?.hour ?? 0),
      impressions: Number(r.metrics?.impressions ?? 0),
      clicks: Number(r.metrics?.clicks ?? 0),
      ctr: Number(r.metrics?.ctr ?? 0),
      cost: microsToDollars(r.metrics?.costMicros ?? 0),
    }))
    .filter((r) => typeof r.date === 'string' && DATE_RE.test(r.date) && (r.impressions > 0 || r.cost > 0))
}

export interface GeoRow {
  criterionId: string
  country: string
  countryCode: string
  impressions: number
  clicks: number
  ctr: number
  cost: number // dollars
  /** A live location bid-modifier check: 0.25 means minus 75%; null = no adjustment on record. */
  bidModifier: number | null
  bidAdjustmentPct: number | null
}
/** Per-country delivery, joined to the LIVE location bid modifier (campaign_criterion, not the
 * report row itself — Ads reports these separately). Diagnostic depth restored for the closed
 * day (R2); also the live location bid-modifier check. */
export async function fetchGeo(client: AdsClient, campaignId: string, since: string, until: string): Promise<GeoRow[]> {
  assertKnownCampaign(campaignId)
  checkRange(since, until)
  const rows = await client.search(
    `SELECT campaign.id, geographic_view.country_criterion_id, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros FROM geographic_view WHERE campaign.id = ${campaignId} AND segments.date BETWEEN '${since}' AND '${until}'`,
  )
  const crits = await client.search(
    `SELECT campaign.id, campaign_criterion.location.geo_target_constant, campaign_criterion.bid_modifier, campaign_criterion.negative FROM campaign_criterion WHERE campaign.id = ${campaignId} AND campaign_criterion.type = LOCATION`,
  )
  const modifiers = new Map<string, number | undefined>()
  for (const c of crits) {
    const id = String(c.campaignCriterion?.location?.geoTargetConstant ?? '').split('/').pop()
    if (id) modifiers.set(id, c.campaignCriterion?.bidModifier)
  }

  const ids = [...new Set(rows.map((r) => String(r.geographicView?.countryCriterionId)))].filter((id) => id && id !== 'undefined')
  const names = new Map<string, { name: string; code: string }>()
  if (ids.length) {
    const consts = await client.search(
      `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.id IN (${ids.join(',')})`,
    )
    for (const g of consts) {
      names.set(String(g.geoTargetConstant?.id), { name: g.geoTargetConstant?.name ?? '', code: g.geoTargetConstant?.countryCode ?? '' })
    }
  }

  const agg = new Map<string, { impressions: number; clicks: number; cost: number }>()
  for (const r of rows) {
    const id = String(r.geographicView?.countryCriterionId)
    const a = agg.get(id) ?? { impressions: 0, clicks: 0, cost: 0 }
    a.impressions += Number(r.metrics?.impressions ?? 0)
    a.clicks += Number(r.metrics?.clicks ?? 0)
    a.cost += microsToDollars(r.metrics?.costMicros ?? 0)
    agg.set(id, a)
  }

  return [...agg]
    .map(([id, a]): GeoRow => {
      const mod = modifiers.get(id)
      return {
        criterionId: id,
        country: names.get(id)?.name || id,
        countryCode: names.get(id)?.code || '',
        impressions: a.impressions,
        clicks: a.clicks,
        ctr: a.impressions ? a.clicks / a.impressions : 0,
        cost: round2(a.cost),
        bidModifier: mod === undefined || mod === null ? null : Number(mod),
        bidAdjustmentPct: mod === undefined || mod === null ? null : Math.round((Number(mod) - 1) * 100),
      }
    })
    .sort((a, b) => b.cost - a.cost)
}

export interface DeviceRow {
  device: string // MOBILE | TABLET | DESKTOP | CONNECTED_TV | OTHER (REST API returns the enum name directly)
  impressions: number
  clicks: number
  ctr: number
  cost: number // dollars
}
/** Per-device delivery. Computers (DESKTOP) and Connected TV must read zero for a mobile-app
 * placement campaign (R2); the caller flags otherwise, never this function. */
export async function fetchDevices(client: AdsClient, campaignId: string, since: string, until: string): Promise<DeviceRow[]> {
  assertKnownCampaign(campaignId)
  checkRange(since, until)
  const rows = await client.search(
    `SELECT segments.device, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros FROM campaign WHERE campaign.id = ${campaignId} AND segments.date BETWEEN '${since}' AND '${until}'`,
  )
  const agg = new Map<string, { impressions: number; clicks: number; cost: number }>()
  for (const r of rows) {
    const d = String(r.segments?.device ?? 'UNSPECIFIED')
    const a = agg.get(d) ?? { impressions: 0, clicks: 0, cost: 0 }
    a.impressions += Number(r.metrics?.impressions ?? 0)
    a.clicks += Number(r.metrics?.clicks ?? 0)
    a.cost += microsToDollars(r.metrics?.costMicros ?? 0)
    agg.set(d, a)
  }
  return [...agg].map(([device, a]): DeviceRow => ({
    device,
    impressions: a.impressions,
    clicks: a.clicks,
    ctr: a.impressions ? a.clicks / a.impressions : 0,
    cost: round2(a.cost),
  }))
}

export interface TargetingRow {
  adGroup: string
  status: string | null
  /** PLACEMENT + MOBILE_APPLICATION criteria (these ad groups target apps, which come back as
   * MOBILE_APPLICATION, not PLACEMENT — counting only PLACEMENT silently reads zero). */
  placements: number
  /** Optimized targeting shows up as the audience dimension's bid_only flag going false
   * (Google's "observation" setting is bid_only === true). null = no audience restriction row
   * on record (nothing to read either way). */
  audienceBidOnly: boolean | null
}
/** Ad-group targeting verification (R2): optimized targeting off, live placement counts. Reads
 * the setting without opening the Ads UI targeting editor (the old routine's LEARNED (20): the
 * editor itself risked Google flipping Optimized targeting back on on Save). */
export async function fetchTargeting(client: AdsClient, campaignId: string): Promise<TargetingRow[]> {
  assertKnownCampaign(campaignId)
  const rows = await client.search(
    `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.targeting_setting.target_restrictions FROM ad_group WHERE campaign.id = ${campaignId}`,
  )
  const counts = await client.search(
    `SELECT campaign.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.type FROM ad_group_criterion WHERE campaign.id = ${campaignId} AND ad_group_criterion.negative = false AND ad_group_criterion.type IN (PLACEMENT, MOBILE_APPLICATION)`,
  )
  const placementCount = new Map<string, number>()
  for (const c of counts) {
    const n = c.adGroup?.name
    if (n) placementCount.set(n, (placementCount.get(n) ?? 0) + 1)
  }
  return rows.map((r): TargetingRow => {
    const restrictions: any[] = r.adGroup?.targetingSetting?.targetRestrictions ?? []
    const audience = restrictions.find((t) => String(t.targetingDimension ?? '').includes('AUDIENCE'))
    return {
      adGroup: r.adGroup?.name ?? '',
      status: r.adGroup?.status ?? null,
      placements: placementCount.get(r.adGroup?.name) ?? 0,
      audienceBidOnly: audience ? Boolean(audience.bidOnly) : null,
    }
  })
}

export interface RecommendationRow {
  type: string | null
  resourceName: string | null
}
/** Lists the Google Ads Recommendations queued for this campaign (R3), read-only. Applies and
 * dismisses NOTHING — there is no mutate call in this module by construction. The standing
 * verdicts (never re-derived, never applied) are documented alongside where this is reported:
 * scripts/ads-reads/report.ts RECOMMENDATION_STANDING_VERDICTS. The recommendation resource is
 * queried unfiltered and matched client-side against this campaign's resource name, since its
 * filterable fields are not documented as including campaign.id. */
export async function fetchRecommendations(client: AdsClient, customerId: string, campaignId: string): Promise<RecommendationRow[]> {
  assertKnownCampaign(campaignId)
  const rows = await client.search(`SELECT recommendation.resource_name, recommendation.type, recommendation.campaign FROM recommendation`)
  const campaignResource = `customers/${customerId}/campaigns/${campaignId}`
  return rows
    .filter((r) => r.recommendation?.campaign === campaignResource)
    .map((r): RecommendationRow => ({ type: r.recommendation?.type ?? null, resourceName: r.recommendation?.resourceName ?? null }))
}
