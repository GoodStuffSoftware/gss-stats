// Merchant rules and the precedence engine: manual > rule > auto, per field (kind, category).
// A rule can set a category, a kind and a payment-only debt account (how a mortgage-like payment counts
// as housing spending while a card payment stays out of spending). Pure; no chain is named here.
import type { Cents, MerchantRule, RuleMatch, Source, TxnKind } from './types'
import { SPENDING_KINDS } from './types'
import { sha256Hex } from './dedupe'

/** 'r' + 16 hex of sha256(merchant_key|store_no|account_id|min|max): 17 chars, so upserts need no lookup. */
export async function ruleIdFor(m: RuleMatch): Promise<string> {
  const basis = [m.merchantKey, m.storeNo ?? '', m.accountId ?? '', m.amountMinCents ?? '', m.amountMaxCents ?? ''].join('|')
  return 'r' + (await sha256Hex(basis)).slice(0, 16)
}

/** What the matcher needs to know about a line. `current` is the stored state when re-running over a row. */
export interface RuleInput {
  accountId: string
  merchantKey: string
  storeNo: string | null
  amountCents: Cents
  current?: {
    kind: TxnKind
    kindSource: 'manual' | 'rule' | 'auto' | 'hint'
    categoryId: string | null
    categorySource: Source
    ruleId: string | null
    debtAccountId: string | null
    confidence: number
  } | null
}

/** The auto layer: kind from classifyKind, category from the keyword map (or null). */
export interface AutoGuess {
  kind: TxnKind
  kindSource: 'hint' | 'auto'
  kindConfidence: number
  categoryId: string | null
}

export interface Categorized {
  kind: TxnKind
  kindSource: 'manual' | 'rule' | 'auto' | 'hint'
  categoryId: string | null
  categorySource: Source
  ruleId: string | null
  debtAccountId: string | null
  confidence: number
  displayName: string | null
  /** The rule that matched (also when a manual edit kept the row's fields). */
  rule: MerchantRule | null
}

const hasBand = (r: MerchantRule) => r.amountMinCents !== null || r.amountMaxCents !== null

export function inBand(r: Pick<RuleMatch, 'amountMinCents' | 'amountMaxCents'>, amountCents: Cents): boolean {
  const a = Math.abs(amountCents)
  return (r.amountMinCents === null || a >= r.amountMinCents) && (r.amountMaxCents === null || a <= r.amountMaxCents)
}

/** Specificity: store +4, account +2, band +1. */
export function specificity(r: MerchantRule): number {
  return (r.storeNo !== null ? 4 : 0) + (r.accountId !== null ? 2 : 0) + (hasBand(r) ? 1 : 0)
}

/** Active rules of this merchant whose account and store fit the line (the band may not). */
export function rulesForLine(t: Pick<RuleInput, 'accountId' | 'merchantKey' | 'storeNo'>, rules: readonly MerchantRule[]): MerchantRule[] {
  return rules.filter((r) => r.active && r.merchantKey === t.merchantKey
    && (r.accountId === null || r.accountId === t.accountId)
    && (r.storeNo === null || r.storeNo === t.storeNo))
}

/** The most specific matching rule; a tie goes to the smaller id so the answer never depends on order. */
export function matchRule(t: RuleInput, rules: readonly MerchantRule[]): MerchantRule | null {
  let best: MerchantRule | null = null
  for (const r of rulesForLine(t, rules)) {
    if (!inBand(r, t.amountCents)) continue
    if (!best) { best = r; continue }
    const d = specificity(r) - specificity(best)
    if (d > 0 || (d === 0 && r.id < best.id)) best = r
  }
  return best
}

/** A small generic keyword map for the auto layer; category ids are in the seeded generic set. */
export function autoCategory(clean: string): string | null {
  const t = clean.toUpperCase()
  if (/\b(?:GROCERY|GROCERIES|SUPERMARKET|SUPERMARCHE)\b/.test(t)) return 'groceries'
  if (/\b(?:PHARMACY|DRUGS?|DENTAL|DENTIST|CLINIC)\b/.test(t)) return 'health'
  if (/\b(?:RESTAURANT|CAFE|COFFEE|PIZZA|PIZZERIA|BAKERY|GRILL|DINER)\b/.test(t)) return 'dining'
  if (/\b(?:FUEL|GAS|GASOLINE|PETROL)\b/.test(t)) return 'fuel'
  if (/\b(?:ATM|CASH WITHDRAWAL)\b/.test(t)) return 'cash'
  if (/\bFEES?\b/.test(t)) return 'fees'
  return null
}

const spendingKind = (k: TxnKind) => SPENDING_KINDS.includes(k)

/**
 * Precedence per field. Kind: a manual kind is kept; else the matched rule's set_kind (source 'rule');
 * else a stored rule-sourced kind is kept; else the auto kind (source 'hint' or 'auto'). Category: manual
 * is kept; else the rule's category; else (spending kinds only) the keyword guess; else none.
 * The rule's debt account rides along. A row whose kind and category are both manual comes back unchanged.
 */
export function categorize(t: RuleInput, rules: readonly MerchantRule[], auto: AutoGuess): Categorized {
  const cur = t.current ?? null
  const rule = matchRule(t, rules)
  if (cur && cur.kindSource === 'manual' && cur.categorySource === 'manual') {
    return { kind: cur.kind, kindSource: 'manual', categoryId: cur.categoryId, categorySource: 'manual', ruleId: cur.ruleId,
      debtAccountId: cur.debtAccountId, confidence: cur.confidence, displayName: rule?.displayName ?? null, rule }
  }

  let kind: TxnKind, kindSource: Categorized['kindSource']
  if (cur && cur.kindSource === 'manual') { kind = cur.kind; kindSource = 'manual' }
  else if (rule?.setKind) { kind = rule.setKind; kindSource = 'rule' }
  else if (cur && cur.kindSource === 'rule') { kind = cur.kind; kindSource = 'rule' }
  else { kind = auto.kind; kindSource = auto.kindSource }

  let categoryId: string | null, categorySource: Source
  if (cur && cur.categorySource === 'manual') { categoryId = cur.categoryId; categorySource = 'manual' }
  else if (rule?.setCategoryId) { categoryId = rule.setCategoryId; categorySource = 'rule' }
  else if (spendingKind(kind) && auto.categoryId) { categoryId = auto.categoryId; categorySource = 'auto' }
  else { categoryId = null; categorySource = 'none' }

  const ruleApplied = rule && (rule.setKind || rule.setCategoryId) ? rule : null
  const debtAccountId = cur?.kindSource === 'manual' ? cur.debtAccountId : (rule?.debtAccountId ?? null)
  let confidence: number
  if (ruleApplied && (kindSource === 'rule' || categorySource === 'rule')) confidence = ruleApplied.confidence
  else if (spendingKind(kind)) confidence = categoryId ? 55 : 30
  else confidence = kindSource === 'hint' ? 100 : auto.kindConfidence
  return { kind, kindSource, categoryId, categorySource, ruleId: rule?.id ?? cur?.ruleId ?? null,
    debtAccountId, confidence, displayName: rule?.displayName ?? null, rule }
}
