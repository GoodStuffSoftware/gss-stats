// The classification of one bank row (kind, merchant, category, review flags), shared by the statement load
// (import.ts) and the bank sync Worker so both treat a row the same way. Pure and I/O-free.
import type { Account, Cents, IsoDate, MerchantRule, TxnKind } from './types'
import { normalizeDescription, type NormalizedDesc } from './normalize'
import { merchantKey, withCounterparty } from './merchant'
import { classifyKind } from './kind'
import { autoCategory, categorize, type Categorized, type RuleInput } from './rules'
import { storeSplitReview } from './storeSplit'
import { reviewFlags } from './review'

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

export interface RowToClassify {
  description: string
  amountCents: Cents
  postedDate: IsoDate
  kindHint?: TxnKind | null
}

export interface RowClassification {
  n: NormalizedDesc
  mk: ReturnType<typeof merchantKey>
  cat: Categorized
  confidence: number
  flags: ReturnType<typeof reviewFlags>
}

/**
 * `sameDayAmounts` is the set of sameDayKey()s already seen (the account's open rows, plus earlier rows of the same
 * request); the caller adds this row's key afterwards.
 */
export function classifyRow(
  row: RowToClassify, account: Account, accounts: Account[], rules: readonly MerchantRule[], sameDayAmounts: Set<string>,
): RowClassification {
  const n = normalizeDescription(row.description)
  const guess = classifyKind(n, row.amountCents, account, accounts, row.kindHint)
  const counterpartyKnown = n.counterpartyLast4 !== null && accounts.some((a) => a.id !== account.id && a.last4 === n.counterpartyLast4)
  let mk = merchantKey(n.clean)
  if (guess.kind === 'transfer_external' && n.counterpartyLast4 && !counterpartyKnown) mk = withCounterparty(mk, n.counterpartyLast4)
  // A payment out to one of our own loans or lines carries that account's last four too, so a rule can treat one
  // debt differently from another (they share the same name words). Every other kind keeps its key.
  else if (guess.kind === 'loan_payment' && row.amountCents < 0 && n.counterpartyLast4 && counterpartyKnown) mk = withCounterparty(mk, n.counterpartyLast4)
  const input: RuleInput = { accountId: account.id, merchantKey: mk.key, storeNo: n.storeNo, amountCents: row.amountCents }
  const cat = categorize(input, rules, { kind: guess.kind, kindSource: guess.source, kindConfidence: guess.confidence, categoryId: autoCategory(n.clean) ?? (guess.kind === 'fee' ? 'fees' : null) })
  const split = storeSplitReview(input, cat.rule, rules)
  const confidence = clamp(cat.confidence + split.confidenceDelta)
  const flags = reviewFlags({ ...cat, ...input, confidence, split, aggregator: mk.aggregator, counterpartyLast4: n.counterpartyLast4,
    counterpartyKnown, postedDate: row.postedDate }, { sameDayAmounts })
  return { n, mk, cat, confidence, flags }
}
