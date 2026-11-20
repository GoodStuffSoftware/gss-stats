import { beforeAll, describe, expect, it } from 'vitest'
import { reviewFlags, sameDayKey, type ReviewInput } from './review'
import type { MerchantRule } from './types'
import { seedRules } from './__fixtures__/synthetic'

let rules: MerchantRule[]
beforeAll(async () => { rules = await seedRules() })

const base = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  accountId: 'chk-a', merchantKey: 'm', storeNo: null, amountCents: -1000, postedDate: '2026-11-20',
  kind: 'spend', kindSource: 'auto', categoryId: 'dining', categorySource: 'auto', ruleId: null, debtAccountId: null, confidence: 60,
  displayName: null, rule: null, split: { confidenceDelta: 0, reason: null }, aggregator: false, counterpartyLast4: null, counterpartyKnown: false,
  ...over,
})
const none = { sameDayAmounts: new Set<string>() }

describe('reviewFlags', () => {
  it('a clean line is not flagged', () => {
    expect(reviewFlags(base(), none)).toEqual({ needsReview: false, reason: null })
  })
  it('a rule with review set flags with its own reason, else "rule"', () => {
    const r = rules.find((x) => x.review)!
    expect(reviewFlags(base({ rule: r }), none)).toEqual({ needsReview: true, reason: 'ambiguous_store' })
    expect(reviewFlags(base({ rule: { ...r, reviewReason: null } }), none)).toEqual({ needsReview: true, reason: 'rule' })
  })
  it('flags store ambiguity, amount band, hidden merchant, unknown transfer target, duplicate, low confidence', () => {
    expect(reviewFlags(base({ split: { confidenceDelta: -25, reason: 'ambiguous_store' } }), none).reason).toBe('ambiguous_store')
    expect(reviewFlags(base({ split: { confidenceDelta: -30, reason: 'amount_out_of_band' } }), none).reason).toBe('amount_out_of_band')
    expect(reviewFlags(base({ aggregator: true }), none).reason).toBe('hidden_merchant')
    expect(reviewFlags(base({ kind: 'transfer_external', counterpartyLast4: '9999' }), none).reason).toBe('transfer_to_unknown_account')
    expect(reviewFlags(base({ kind: 'transfer_external', counterpartyLast4: '0002', counterpartyKnown: true }), none).reason).toBeNull()
    const seen = { sameDayAmounts: new Set([sameDayKey('chk-a', '2026-11-20', -1000)]) }
    expect(reviewFlags(base(), seen).reason).toBe('possible_duplicate')
    expect(reviewFlags(base({ accountId: 'sav-a' }), seen).reason).toBeNull()
    expect(reviewFlags(base({ confidence: 30 }), none).reason).toBe('low_confidence')
    expect(reviewFlags(base({ confidence: 30, kind: 'refund' }), none).reason).toBeNull()
  })
  it('the first reason in the documented order wins', () => {
    const r = rules.find((x) => x.review)!
    const everything = base({ rule: r, split: { confidenceDelta: -30, reason: 'amount_out_of_band' }, aggregator: true, confidence: 10 })
    expect(reviewFlags(everything, none).reason).toBe('ambiguous_store')
    expect(reviewFlags({ ...everything, rule: null }, none).reason).toBe('amount_out_of_band')
    expect(reviewFlags({ ...everything, rule: null, split: { confidenceDelta: 0, reason: null } }, none).reason).toBe('hidden_merchant')
    expect(reviewFlags({ ...everything, rule: null, split: { confidenceDelta: 0, reason: null }, aggregator: false }, none).reason).toBe('low_confidence')
  })
  it('a hidden merchant matters only where it is spending', () => {
    expect(reviewFlags(base({ aggregator: true, kind: 'income' }), none).reason).toBeNull()
  })
  it('a manually edited row is never put back on the list', () => {
    expect(reviewFlags(base({ aggregator: true, kindSource: 'manual' }), none)).toEqual({ needsReview: false, reason: null })
    expect(reviewFlags(base({ aggregator: true, categorySource: 'manual' }), none)).toEqual({ needsReview: false, reason: null })
  })
})
