/// <reference types="@cloudflare/workers-types" />
//
// Shared "which funnel steps did this campaign flight actually have a chance to see" check —
// previously inlined only in functions/api/campaigns.ts (its query 3 + seenSteps loop).
// Factored out so functions/api/overview.ts's campaign scorecard can use the SAME empirical,
// per-flight derivation for closed campaigns instead of its own simplified
// gameCompleteNotInstrumented-only gate — see that file's own comment on why it used to skip
// this. Never a hand-written per-campaign list: any path that existed site-wide during the
// flight's serving window counts as instrumented for it, so a future campaign gets this for
// free the same way the two closed ones do today.
//
// ANONYMOUS AGGREGATE ONLY — a COUNT(*) GROUP BY, never a row fetch or cross-row join.
//
// CACHED (review finding, 2026-09-26 — measured 2,621 D1 rows_read per closed flight): this
// query re-ran on EVERY call from EITHER caller (functions/api/campaigns.ts, once per request;
// functions/api/overview.ts's scorecard, once per closed campaign, on every dashboard load).
// A campaign's flight window only ever gets MORE closed over time, never re-opens, so the
// result is cached per (campaign id, flight window) via the same per-colo Cache API mechanism
// /api/geo.ts uses (functions/_lib/edgeCache.ts) — one cache entry, shared by both callers,
// instead of two independent re-runs. ttlSecondsFor gives a genuinely closed window (flightEnd
// before today ET) the long 24h TTL and a still-open one the short 90s one, so an active
// campaign's window (which CAN gain a newly-seen step as its flight runs) doesn't get pinned
// stale.

import { classifyFunnelPath, etFlightRangeMs, FUNNEL_STEP_ORDER, type CampaignFlight, type FunnelStepKey } from '../../src/lib/campaigns'
import { buildCacheKeyUrl, ttlSecondsFor, type CacheLike } from './edgeCache'

// The return beacon / funnel-step beacons are web-only (see lib/campaigns.ts module header
// and BSK_SITE in functions/api/campaigns.ts) — same site scope both callers already used.
const BSK_SITE = 'bestsudoku-web'

/** Funnel steps (excluding 'arrivals', which is always instrumented) that this flight's own
 * serving window never saw ANY hit for, anywhere on site — i.e. genuinely not instrumented
 * for this flight, not a real zero. `flightStart === null` (a pending flight) has no window
 * to check yet, so every step is reported not-instrumented until a start date is confirmed —
 * same behavior as functions/api/campaigns.ts's own pre-refactor version. Cached (see above);
 * never caches an error — a thrown D1 failure propagates to the caller before anything is
 * stored. */
export async function notInstrumentedFunnelSteps(db: D1Database, campaign: CampaignFlight): Promise<FunnelStepKey[]> {
  if (!campaign.flightStart) return FUNNEL_STEP_ORDER.filter((k) => k !== 'arrivals')

  const cacheKeyUrl = buildCacheKeyUrl('/internal/campaign-not-instrumented', {
    campaignId: campaign.id,
    flightStart: campaign.flightStart,
    flightEnd: campaign.flightEnd,
  })
  const cache = (caches as unknown as { default: CacheLike }).default
  const key = new Request(cacheKeyUrl)
  const hit = await cache.match(key)
  if (hit) return (await hit.json()) as FunnelStepKey[]

  const [startMs, endMs] = etFlightRangeMs(campaign.flightStart, campaign.flightEnd)
  const r = await db
    .prepare(`SELECT path, COUNT(*) AS c FROM hits WHERE site = ? AND ts >= ? AND ts < ? GROUP BY path`)
    .bind(BSK_SITE, startMs, endMs)
    .all()
  const seen = new Set<FunnelStepKey>()
  for (const x of r.results ?? []) {
    const step = classifyFunnelPath(String((x as any).path ?? ''))
    if (step && (Number((x as any).c) || 0) > 0) seen.add(step)
  }
  const steps = FUNNEL_STEP_ORDER.filter((k) => k !== 'arrivals' && !seen.has(k))

  const ttl = ttlSecondsFor(campaign.flightEnd, new Date())
  await cache.put(key, new Response(JSON.stringify(steps), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` } }))
  return steps
}
