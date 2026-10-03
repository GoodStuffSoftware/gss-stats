// Test helper for the parity suites that compare the metrics registry against a golden recorded
// from the retired bespoke panels (/api/campaigns, /api/overview). Those goldens were captured
// when three campaigns were configured and can never be re-recorded (the endpoints are gone), so
// a campaign registered later has nothing to be compared with. Scoping CAMPAIGNS to the recorded
// three for the duration of such a suite keeps it a like-for-like comparison; campaigns added
// since are covered by their own tests (scripts/ads-reads/campaignRegistry.test.ts and the
// every-campaign loops in the facts, geo and metrics suites), not by a fabricated golden.
import { CAMPAIGNS } from '../../../src/lib/campaigns'

/** The campaigns the goldens hold: Android launch, Play-direct (spend-only), and the US+CA web retest. */
export const GOLDEN_CAMPAIGN_IDS = ['24215315197', '24234347705', '24279250691']

/** Remove every other campaign from the live CAMPAIGNS array; returns the function that puts them back. */
export function scopeCampaignsToGolden(): () => void {
  const saved = CAMPAIGNS.slice()
  for (let i = CAMPAIGNS.length - 1; i >= 0; i--) if (!GOLDEN_CAMPAIGN_IDS.includes(CAMPAIGNS[i].id)) CAMPAIGNS.splice(i, 1)
  return () => {
    CAMPAIGNS.splice(0, CAMPAIGNS.length, ...saved)
  }
}
