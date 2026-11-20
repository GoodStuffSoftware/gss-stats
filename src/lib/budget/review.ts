// Which lines a person should look at. The first reason that applies wins; the order is the contract.
import type { ReviewReason } from './types'
import { SPENDING_KINDS } from './types'
import type { Categorized, RuleInput } from './rules'
import type { StoreSplit } from './storeSplit'

export interface ReviewInput extends Categorized, RuleInput {
  split: StoreSplit
  /** merchantKey() found no merchant (processor prefix only, person-to-person, empty name). */
  aggregator: boolean
  counterpartyLast4: string | null
  /** The counterparty last4, when present, belongs to one of the household's accounts. */
  counterpartyKnown: boolean
  postedDate: string
}

export interface ReviewContext {
  /** `sameDayKey()` of rows seen elsewhere (another statement or an earlier import) under another id. */
  sameDayAmounts: ReadonlySet<string>
}

export function sameDayKey(accountId: string, postedDate: string, amountCents: number): string {
  return `${accountId}|${postedDate}|${amountCents}`
}

export function reviewFlags(t: ReviewInput, ctx: ReviewContext): { needsReview: boolean; reason: ReviewReason | null } {
  const reason = ((): ReviewReason | null => {
    if (t.rule?.review) return t.rule.reviewReason ?? 'rule'
    if (t.split.reason === 'ambiguous_store') return 'ambiguous_store'
    if (t.split.reason === 'amount_out_of_band') return 'amount_out_of_band'
    if (t.aggregator && SPENDING_KINDS.includes(t.kind)) return 'hidden_merchant'
    if ((t.kind === 'transfer_external' || t.kind === 'transfer') && t.counterpartyLast4 && !t.counterpartyKnown) return 'transfer_to_unknown_account'
    if (ctx.sameDayAmounts.has(sameDayKey(t.accountId, t.postedDate, t.amountCents))) return 'possible_duplicate'
    if (t.confidence < 40 && t.kind === 'spend') return 'low_confidence'
    return null
  })()
  // A manual edit has been looked at: it never goes back on the list.
  if (t.kindSource === 'manual' || t.categorySource === 'manual') return { needsReview: false, reason: null }
  return { needsReview: reason !== null, reason }
}
