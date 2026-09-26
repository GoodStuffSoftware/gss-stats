/// <reference types="@cloudflare/workers-types" />
//
// POST /api/ads/refresh   body: { campaignIds?: string[] }   (none = every campaign)
//
// The ads widgets' "Refresh data". Behind the same host guard and Google sign-in gate as every
// /api route (functions/_middleware.ts). When a campaign's Ads data is stale, it asks the
// gss-stats-sync Worker to run the shared sync through the Service Binding ADS_SYNC (the Worker
// has no public URL), at most once per 10 minutes, and returns the fresh spendThrough /
// lastSync / stale. The dashboard holds no Google Ads credential and never calls the Ads API.
// Logic: src/lib/adsRefresh.ts.

import { CAMPAIGNS } from '../../../src/lib/campaigns'
import { refreshAds } from '../../../src/lib/adsRefresh'

interface Env {
  gss_stats_ads?: D1Database
  /** Service Binding to the gss-stats-sync Worker (root wrangler.toml [[services]]). */
  ADS_SYNC?: Fetcher
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: { campaignIds?: unknown } = {}
  try {
    body = (await ctx.request.json()) as { campaignIds?: unknown }
  } catch {
    body = {}
  }
  const known = CAMPAIGNS.map((c) => c.id)
  const asked = Array.isArray(body.campaignIds) ? body.campaignIds.filter((x): x is string => typeof x === 'string' && known.includes(x)) : []
  const result = await refreshAds({ db: ctx.env.gss_stats_ads, sync: ctx.env.ADS_SYNC, campaignIds: asked.length ? asked : known, nowMs: Date.now() })
  return json(result)
}

export const onRequestGet: PagesFunction = async () => json({ error: 'POST only' }, 405)
