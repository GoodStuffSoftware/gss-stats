// One name, several kinds of store (a chain with a fuel pump and a grocery floor): the store number tells
// them apart, and where it cannot the line is flagged instead of guessed. Pure; no chain is named here.
import type { MerchantRule, ReviewReason } from './types'
import { inBand, rulesForLine, specificity, type RuleInput } from './rules'

/** Confidence change for a line whose amount sits outside the band of a rule that fits it otherwise. */
export const OUT_OF_BAND_DELTA = -30
/** Confidence change for a line inside a tight amount band. */
export const TIGHT_BAND_DELTA = 5
/** Confidence change when the merchant has store-specific rules and none fits this line. */
export const AMBIGUOUS_STORE_DELTA = -25

export interface StoreSplit {
  /** Added to the confidence of the match (a delta, not an absolute value). */
  confidenceDelta: number
  reason: ReviewReason | null
}

/** A band is tight when both ends are set and it is no wider than a quarter of its top (min 5.00). */
export function isTightBand(r: Pick<MerchantRule, 'amountMinCents' | 'amountMaxCents'>): boolean {
  if (r.amountMinCents === null || r.amountMaxCents === null) return false
  return r.amountMaxCents - r.amountMinCents <= Math.max(500, r.amountMaxCents / 4)
}

/**
 * `matched` is matchRule's answer. Order of checks:
 * 1. a rule of this merchant fits the line's account and store but not its amount, and is more specific
 *    than the match (or there is no match): amount_out_of_band, -30;
 * 2. the merchant has store-specific rules and the match is not one of them (or there is no match):
 *    ambiguous_store, -25;
 * 3. the match has a tight amount band the amount is inside: +5, no flag.
 */
export function storeSplitReview(t: RuleInput, matched: MerchantRule | null, rules: readonly MerchantRule[]): StoreSplit {
  const fits = rulesForLine(t, rules)
  const matchedSpec = matched ? specificity(matched) : -1
  if (fits.some((r) => !inBand(r, t.amountCents) && specificity(r) > matchedSpec)) {
    return { confidenceDelta: OUT_OF_BAND_DELTA, reason: 'amount_out_of_band' }
  }
  const merchantRules = rules.filter((r) => r.active && r.merchantKey === t.merchantKey)
  const hasStoreRules = merchantRules.some((r) => r.storeNo !== null)
  if (hasStoreRules && (!matched || matched.storeNo === null)) {
    return { confidenceDelta: AMBIGUOUS_STORE_DELTA, reason: 'ambiguous_store' }
  }
  if (matched && isTightBand(matched)) return { confidenceDelta: TIGHT_BAND_DELTA, reason: null }
  return { confidenceDelta: 0, reason: null }
}
