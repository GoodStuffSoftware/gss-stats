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

import { classifyFunnelPath, etFlightRangeMs, FUNNEL_STEP_ORDER, type CampaignFlight, type FunnelStepKey } from '../../src/lib/campaigns'

// The return beacon / funnel-step beacons are web-only (see lib/campaigns.ts module header
// and BSK_SITE in functions/api/campaigns.ts) — same site scope both callers already used.
const BSK_SITE = 'bestsudoku-web'

/** Funnel steps (excluding 'arrivals', which is always instrumented) that this flight's own
 * serving window never saw ANY hit for, anywhere on site — i.e. genuinely not instrumented
 * for this flight, not a real zero. `flightStart === null` (a pending flight) has no window
 * to check yet, so every step is reported not-instrumented until a start date is confirmed —
 * same behavior as functions/api/campaigns.ts's own pre-refactor version. */
export async function notInstrumentedFunnelSteps(db: D1Database, campaign: CampaignFlight): Promise<FunnelStepKey[]> {
  if (!campaign.flightStart) return FUNNEL_STEP_ORDER.filter((k) => k !== 'arrivals')
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
  return FUNNEL_STEP_ORDER.filter((k) => k !== 'arrivals' && !seen.has(k))
}
