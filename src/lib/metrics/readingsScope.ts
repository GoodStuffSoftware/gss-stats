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
import type { CampaignAdsInfo, ReadingCountKey, ReadingScope } from './scope'
import { READING_COUNT_FIELDS } from './types'

/** The five allow-listed record fields, as the scope's count keys. */
const COUNT_KEYS = Object.values(READING_COUNT_FIELDS) as ReadingCountKey[]

/** One stored reading as a card scope: its read time and kind, spend, the rule and proposal
 * text the readings table shows, and ONLY the five allow-listed counts. */
export function readingScopeOf(r: ReadingRecord): ReadingScope {
  const counts: Partial<Record<ReadingCountKey, number | null>> = {}
  for (const k of COUNT_KEYS) counts[k] = r.counts?.[k] ?? null
  return {
    campaignId: r.campaignId,
    readAt: r.readAt,
    kind: readingKindLabel(r),
    spend: r.cumulativeSpend ?? null,
    rules: rulesSummary(r.rules).text,
    proposal: proposalLabel(r),
    complete: r.complete,
    counts,
    signUpsExact: r.counts?.signUpsExact === 1,
  }
}

/** What one campaign block of the response says about the campaign itself. */
export function campaignAdsInfoOf(c: AdsReadingsCampaign, storeBound: boolean, loadedAtMs: number): CampaignAdsInfo {
  return { spendThrough: c.spendThrough, lastSync: c.lastSync, stale: c.stale, storeBound, thresholdsFired: c.thresholdsFired, loadedAtMs }
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
