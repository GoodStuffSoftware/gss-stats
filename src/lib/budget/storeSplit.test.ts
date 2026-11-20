import { beforeAll, describe, expect, it } from 'vitest'
import { matchRule, type RuleInput } from './rules'
import { isTightBand, storeSplitReview } from './storeSplit'
import { seedRules } from './__fixtures__/synthetic'
import type { MerchantRule } from './types'

let rules: MerchantRule[]
beforeAll(async () => { rules = await seedRules() })

const line = (merchantKey: string, storeNo: string | null, amountCents: number): RuleInput => ({ accountId: 'chk-a', merchantKey, storeNo, amountCents })
const split = (t: RuleInput, rs: MerchantRule[] = rules) => storeSplitReview(t, matchRule(t, rs), rs)

describe('storeSplitReview', () => {
  it('a store with its own rule is not ambiguous', () => {
    expect(split(line('chain-x', '1001', -6200))).toEqual({ confidenceDelta: 0, reason: null })
  })
  it('an unlisted store of a merchant that has store rules is ambiguous', () => {
    expect(split(line('chain-x', '9999', -1850)).reason).toBe('ambiguous_store')
    expect(split(line('chain-x', null, -1850)).reason).toBe('ambiguous_store')
    expect(split(line('chain-x', '9999', -1850)).confidenceDelta).toBeLessThan(0)
  })
  it('a merchant with no store rules is never ambiguous', () => {
    expect(split(line('paws-and-claws', '5', -500))).toEqual({ confidenceDelta: 0, reason: null })
    expect(split(line('nobody', '5', -500))).toEqual({ confidenceDelta: 0, reason: null })
  })
  it('an amount outside the band of the rule that otherwise fits is flagged and loses 30', () => {
    expect(split(line('depot-y', null, -45000))).toEqual({ confidenceDelta: -30, reason: 'amount_out_of_band' })
    expect(split(line('chain-x', '3003', -300)).reason).toBe('amount_out_of_band')
  })
  it('inside the band, no flag; inside a tight band, +5', () => {
    expect(split(line('depot-y', null, -3000)).reason).toBeNull()
    const tight: MerchantRule = { ...rules.find((r) => r.merchantKey === 'paws-and-claws')!, amountMinCents: 4000, amountMaxCents: 4500 }
    expect(split(line('paws-and-claws', null, -4200), [tight])).toEqual({ confidenceDelta: 5, reason: null })
  })
  it('an inactive rule does not count', () => {
    const off = rules.map((r) => (r.merchantKey === 'depot-y' && r.amountMinCents !== null ? { ...r, active: false } : r))
    expect(split(line('depot-y', null, -45000), off).reason).toBeNull()
  })
})

describe('isTightBand', () => {
  it('needs both ends and a narrow span', () => {
    expect(isTightBand({ amountMinCents: 4000, amountMaxCents: 4500 })).toBe(true)
    expect(isTightBand({ amountMinCents: 1000, amountMaxCents: 5000 })).toBe(false)
    expect(isTightBand({ amountMinCents: null, amountMaxCents: 5000 })).toBe(false)
  })
})
