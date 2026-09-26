/// <reference types="@cloudflare/workers-types" />
//
// GET /api/ads/readings?campaignId=<id>[&campaignId=<id>…][&campaignIds=a,b][&limit=N]
//
// The ads-read routine's readings log, stored spend and fired thresholds, from gss-stats' own
// D1 store (binding gss_stats_ads — docs/adr/0001-ads-read-store.md). Feeds the
// self-contained AdsReadingsWidgetCard.vue. No campaign id (or none known) = every campaign.
//
// FAIL SOFT: no binding, a missing table or a D1 error returns storeBound/storeReadable
// flags and empty readings, with spend falling back to lib/campaigns.ts CAMPAIGN_SPEND —
// never a 500. Anonymous aggregates only: counts, rule results and proposals.

import { CAMPAIGNS, CAMPAIGN_SPEND } from '../../../src/lib/campaigns'
import { resolveCampaignSpend } from '../../../src/lib/adsRules'
import { parseCampaignIdsParam, readReadings, readSpendSummaries, readThresholdState, type AdsReadingsResponse } from '../../../src/lib/adsStore'

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
  const summaries = await readSpendSummaries(db)

  const campaigns = await Promise.all(
    ids.map(async (id) => {
      const c = CAMPAIGNS.find((x) => x.id === id)!
      const [readings, fired] = await Promise.all([readReadings(db, id, limit), readThresholdState(db, id)])
      return {
        campaignId: id,
        label: c.label,
        status: c.status,
        spend: resolveCampaignSpend(summaries?.get(id) ?? null, CAMPAIGN_SPEND[id] ?? null),
        thresholdsFired: fired,
        readings: readings ?? [],
      }
    }),
  )
  const body: AdsReadingsResponse = { storeBound: !!db, storeReadable: summaries !== null, campaigns, generatedAt: new Date().toISOString() }
  return json(body)
}
