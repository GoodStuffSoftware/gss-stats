// Maps the /api/ads/readings response (lib/adsStore.ts AdsReadingsResponse) into what the
// card engine's scope carries (scope.ts ReadingScope, CampaignAdsInfo). Pure.
//
// PRIVACY ("counts only. Never tie beacon rows to a device, time or place", read as rows only):
// a stored ReadingRecord's `counts` also holds /return, game-start, game-complete, tutorial and
// tour totals. They are never copied here. The record's counts are read through the allow-list
// READING_COUNT_FIELDS (types.ts) and nothing else, so a card cannot reach one, whatever its
// spec says. What a reading keeps is an aggregate with its own read time.
import { proposalLabel, type ReadingRecord } from '../adsRules'
import { rulesSummary } from '../adsRulesSummary'
import { readingKindLabel } from '../adsReadingsFormat'
import type { AdsReadingsCampaign, AdsReadingsResponse } from '../adsStore'
import type { CampaignAdsInfo, CampaignF3Read, ReadingCountKey, ReadingScope } from './scope'
import { READING_COUNT_FIELDS } from './types'

/** The five allow-listed record fields, as the scope's count keys. */
const COUNT_KEYS = Object.values(READING_COUNT_FIELDS) as ReadingCountKey[]

/** One stored reading as a card scope: its read time and kind, spend, the rule and proposal
 * text the readings table shows, and ONLY the five allow-listed counts. */
export function readingScopeOf(r: ReadingRecord): ReadingScope {
  const counts: Partial<Record<ReadingCountKey, number | null>> = {}
  for (const k of COUNT_KEYS) counts[k] = r.counts?.[k] ?? null
  const rules = rulesSummary(r.rules)
  return {
    campaignId: r.campaignId,
    readAt: r.readAt,
    // A read that depended on a read that returned nothing says so in the Kind text (it is also
    // dimmed, MetricSection.vue), as the bespoke readings log did.
    kind: r.complete ? readingKindLabel(r) : `${readingKindLabel(r)} (incomplete)`,
    spend: r.cumulativeSpend ?? null,
    rules: rules.text,
    proposal: proposalLabel(r),
    // Colours only, as the bespoke log drew them: the rules summary's tone, and a pause proposal red.
    tones: { rules: rules.tone, ...(r.proposal === 'PROPOSE PAUSE' ? { proposal: 'trip' as const } : {}) },
    complete: r.complete,
    counts,
    signUpsExact: r.counts?.signUpsExact === 1,
  }
}

/** What one campaign block of the response says about the campaign itself. */
export function campaignAdsInfoOf(c: AdsReadingsCampaign, storeBound: boolean, loadedAtMs: number): CampaignAdsInfo {
  // What the readings log shows: a campaign with a stored reading, Ads-API spend or an active flight.
  const hasActivity = !!c.readings?.length || c.spend?.source === 'google-ads-api' || c.status === 'active'
  const f3 = campaignF3ReadOf(c.readings)
  return { spendThrough: c.spendThrough, lastSync: c.lastSync, stale: c.stale, storeBound, thresholdsFired: c.thresholdsFired, loadedAtMs, hasActivity, ...(f3 ? { f3 } : {}) }
}

/** The newest daily reading's F3 rules block (ads_readings.f3), or undefined when no loaded
 * reading carries one. `readings` is newest first, as the endpoint returns them. Only the
 * printed rule text and the proposal are copied: no count of the record. */
export function campaignF3ReadOf(readings: readonly ReadingRecord[] | null | undefined): CampaignF3Read | undefined {
  const r = (readings ?? []).find((x) => x.kind === 'daily' && x.f3 && Array.isArray(x.f3.readouts))
  if (!r?.f3) return undefined
  return {
    etDate: r.etDate,
    flightDay: r.f3.flightDay,
    proposal: r.f3.proposal ?? null,
    rules: r.f3.readouts.map((x) => ({ n: x.n, name: x.name, number: x.number, threshold: x.threshold ?? null, verdict: x.verdict })),
  }
}

export interface ReadingsLoad {
  /** Every campaign's readings, newest first within a campaign, each tagged with its campaign. */
  readings: ReadingScope[]
  ads: Record<string, CampaignAdsInfo>
}
export const NO_READINGS: ReadingsLoad = { readings: [], ads: {} }

/** The whole response as card scope. `loadedAtMs` is when it was loaded (the clock the freshness
 * line counts "synced 2h ago" from); the response's own `generatedAt` when not given. */
export function readingsLoadOf(res: AdsReadingsResponse | null | undefined, loadedAtMs?: number): ReadingsLoad {
  if (!res) return NO_READINGS
  const at = loadedAtMs ?? (Date.parse(res.generatedAt) || Date.now())
  const out: ReadingsLoad = { readings: [], ads: {} }
  for (const c of res.campaigns ?? []) {
    out.ads[c.campaignId] = campaignAdsInfoOf(c, res.storeBound, at)
    for (const r of c.readings ?? []) out.readings.push(readingScopeOf({ ...r, campaignId: c.campaignId }))
  }
  return out
}
