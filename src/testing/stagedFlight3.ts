// Test helper: the registry as it is while flight 3 is STAGED, whatever STAGED_FLIGHT_3_DATES holds.
// Several tests pin the pre-flight-3 registry (the retest and the flight-2 arms) or the "staged" UI
// state. Filling an arm's dates is the whole activation in code, and a pin like that must not turn the
// build red on that day. So such a test calls hideLiveFlight3() in beforeEach and restores in afterEach:
// the live flight 3 entries (if any) leave CAMPAIGNS and ADS_READ_PLANS, then come back untouched.
// Tests of the live behaviour itself inject dates instead (liveStagedCampaigns(dates)).
import { ADS_READ_PLANS } from '../lib/adsRules'
import { CAMPAIGNS, STAGED_ARMS, STAGED_FLIGHT_3 } from '../lib/campaigns'

export const FLIGHT_3_CAMPAIGN_IDS: string[] = STAGED_ARMS.map((arm) => STAGED_FLIGHT_3[arm].ids.campaignId)

/** Removes flight 3's campaigns from the real registries; returns the function that puts them back. */
export function hideLiveFlight3(): () => void {
  const savedCampaigns = CAMPAIGNS.slice()
  const savedPlans = Object.entries(ADS_READ_PLANS)
  CAMPAIGNS.splice(0, CAMPAIGNS.length, ...savedCampaigns.filter((c) => !FLIGHT_3_CAMPAIGN_IDS.includes(c.id)))
  for (const id of FLIGHT_3_CAMPAIGN_IDS) delete ADS_READ_PLANS[id]
  return () => {
    CAMPAIGNS.splice(0, CAMPAIGNS.length, ...savedCampaigns)
    for (const id of Object.keys(ADS_READ_PLANS)) delete ADS_READ_PLANS[id]
    Object.assign(ADS_READ_PLANS, Object.fromEntries(savedPlans))
  }
}
