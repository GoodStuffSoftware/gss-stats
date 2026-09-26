// Minimal, READ-ONLY Google Ads REST client for the ads-read routine — a port of the calls
// best-sudoku's scripts/marketing/ads-api-report.mjs makes, without the google-ads-api
// dependency and without the best-sudoku checkout.
//
// READ-ONLY BY CONSTRUCTION: the only endpoint this module can reach is
// `customers/<id>/googleAds:search` (a GAQL SELECT). There is no mutate call anywhere, and
// search() refuses any query that is not a SELECT.
//
// NO MANAGER HEADER: requests carry Authorization + developer-token only. A
// login-customer-id header is never sent, and GOOGLE_ADS_LOGIN_CUSTOMER_ID is never read
// (buildHeaders asserts it).

import { ADS_API_VERSION, ADS_CUSTOMER_ID, APPROVED_PLACEMENTS_BY_CAMPAIGN, assertKnownCampaign, isApprovedPlacement, readPlanFor, type SpendDay } from '../../src/lib/adsRules'
import type { PlacementDayRow } from '../../src/lib/adsStore'
import type { AdsCredentials } from './secrets'
import { redact, registerSecret } from './redact'
import { EXTERNAL_TIMEOUT_MS, TIMED_OUT_TEXT } from './wrangler'

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** fetch with the routine's external timeout (review L8); a timeout rejects with a plain
 * "<host> timed out after 60s" so the failure summary says what happened. */
export const timedFetch: FetchLike = async (url, init) => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) })
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`${new URL(url).host} ${TIMED_OUT_TEXT}`)
    throw e
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
  opts: { customerId?: string; apiVersion?: string; fetchImpl?: FetchLike } = {},
): Promise<AdsClient> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? timedFetch
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
