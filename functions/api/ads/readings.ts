/// <reference types="@cloudflare/workers-types" />
//
// GET /api/ads/readings?campaignId=<id>[&campaignId=<id>…][&campaignIds=a,b][&limit=N]
//
// The ads-read routine's readings log, stored spend and fired thresholds, from gss-stats' own
// D1 store (binding gss_stats_ads — docs/adr/0001-ads-read-store.md). Feeds the
// `ads-readings-log` metric card (lib/metrics/readingsCard.ts). No campaign id (or none known) = every campaign.
//
// FAIL SOFT: no binding, a missing table or a D1 error returns storeBound/storeReadable
// flags and empty readings, with spend falling back to lib/campaigns.ts CAMPAIGN_SPEND —
// never a 500. Anonymous aggregates only: counts, rule results and proposals.
//
// Freshness per campaign (lib/adsFreshness.ts): spendThrough (last closed day stored),
// lastSync (latest ads_sync_runs row that synced it) and stale; plus syncAlerts, sync runs that
// claimed and never finished (killed mid-run). Read-only: this endpoint never calls the Google
// Ads API.

import { CAMPAIGNS, CAMPAIGN_SPEND } from '../../../src/lib/campaigns'
import { resolveCampaignSpend } from '../../../src/lib/adsRules'
import { freshnessOf } from '../../../src/lib/adsFreshness'
import { parseCampaignIdsParam, readFreshness, readReadings, readSpendSummaries, readSyncAlerts, readThresholdState, type AdsReadingsResponse } from '../../../src/lib/adsStore'

interface Env {
  gss_stats_ads?: D1Database
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url)
  const ids = parseCampaignIdsParam(url.searchParams, CAMPAIGNS.map((c) => c.id))
  const limitRaw = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 50
  const db = ctx.env.gss_stats_ads
  const nowMs = Date.now()
  const [summaries, freshness, syncAlerts] = await Promise.all([readSpendSummaries(db), readFreshness(db, nowMs), readSyncAlerts(db, nowMs)])

  const campaigns = await Promise.all(
    ids.map(async (id) => {
      const c = CAMPAIGNS.find((x) => x.id === id)!
      const [readings, fired] = await Promise.all([readReadings(db, id, limit), readThresholdState(db, id)])
      return {
        campaignId: id,
        label: c.label,
        status: c.status,
        spend: resolveCampaignSpend(summaries?.get(id) ?? null, CAMPAIGN_SPEND[id] ?? null),
        ...(freshness.get(id) ?? freshnessOf(c, null, null, nowMs)),
        thresholdsFired: fired,
        readings: readings ?? [],
      }
    }),
  )
  const body: AdsReadingsResponse = { storeBound: !!db, storeReadable: summaries !== null, campaigns, ...(syncAlerts.length ? { syncAlerts } : {}), generatedAt: new Date().toISOString() }
  return json(body)
}
