import { beforeAll, describe, expect, it } from 'vitest'
import { autoCategory, categorize, matchRule, ruleIdFor, type AutoGuess, type RuleInput } from './rules'
import { seedRules } from './__fixtures__/synthetic'
import { SPENDING_KINDS, type MerchantRule } from './types'

let rules: MerchantRule[]
beforeAll(async () => { rules = await seedRules() })

const line = (merchantKey: string, storeNo: string | null, amountCents: number, accountId = 'chk-a'): RuleInput =>
  ({ accountId, merchantKey, storeNo, amountCents })
const auto = (over: Partial<AutoGuess> = {}): AutoGuess => ({ kind: 'spend', kindSource: 'auto', kindConfidence: 60, categoryId: null, ...over })

describe('ruleIdFor', () => {
  it('is r + 16 hex, stable, and different per match', async () => {
    const m = { merchantKey: 'chain-x', storeNo: '1001', accountId: null, amountMinCents: null, amountMaxCents: null }
    const id = await ruleIdFor(m)
    expect(id).toMatch(/^r[0-9a-f]{16}$/)
    expect(await ruleIdFor({ ...m })).toBe(id)
    expect(await ruleIdFor({ ...m, storeNo: '2002' })).not.toBe(id)
    expect(await ruleIdFor({ ...m, accountId: 'chk-a' })).not.toBe(id)
    expect(await ruleIdFor({ ...m, amountMaxCents: 100 })).not.toBe(id)
  })
})

describe('matchRule: chain X store numbers', () => {
  it('sends the fuel store to fuel and the grocery store to groceries', () => {
    expect(matchRule(line('chain-x', '1001', -6200), rules)?.setCategoryId).toBe('fuel')
    expect(matchRule(line('chain-x', '2002', -8400), rules)?.setCategoryId).toBe('groceries')
  })
  it('falls back to the store-less rule for a store number nobody listed', () => {
    const r = matchRule(line('chain-x', '9999', -1850), rules)!
    expect(r.storeNo).toBeNull()
    expect(r.review).toBe(true)
  })
  it('honours the amount band, and falls back outside it', () => {
    expect(matchRule(line('chain-x', '3003', -9000), rules)?.setCategoryId).toBe('fuel')
    expect(matchRule(line('chain-x', '3003', -300), rules)?.storeNo).toBeNull()
    expect(matchRule(line('depot-y', null, -3000), rules)?.setCategoryId).toBe('shopping')
    expect(matchRule(line('depot-y', null, -45000), rules)?.setCategoryId).toBe('other')
  })
  it('matches nothing for an unknown merchant and ignores inactive rules', () => {
    expect(matchRule(line('nobody', null, -100), rules)).toBeNull()
    expect(matchRule(line('paws-and-claws', null, -100), rules.map((r) => ({ ...r, active: false })))).toBeNull()
  })
  it('prefers store over account over band, and breaks ties by id whatever the order', () => {
    const base = rules.find((r) => r.merchantKey === 'paws-and-claws')!
    const withAccount: MerchantRule = { ...base, id: 'r_account_00000000', accountId: 'chk-a', setCategoryId: 'health' }
    const withBand: MerchantRule = { ...base, id: 'r_band_000000000', amountMinCents: 1, amountMaxCents: 99999, setCategoryId: 'gifts' }
    const withStore: MerchantRule = { ...base, id: 'r_store_00000000', storeNo: '7', setCategoryId: 'travel' }
    const t = line('paws-and-claws', '7', -500)
    expect(matchRule(t, [base, withBand, withAccount])?.setCategoryId).toBe('health')
    expect(matchRule(t, [withBand, withAccount, withStore, base])?.setCategoryId).toBe('travel')
    const twinA: MerchantRule = { ...withAccount, id: 'r_aaaaaaaaaaaaaaaa', setCategoryId: 'kids' }
    const twinB: MerchantRule = { ...withAccount, id: 'r_bbbbbbbbbbbbbbbb', setCategoryId: 'cash' }
    expect(matchRule(t, [twinB, twinA])?.id).toBe(twinA.id)
    expect(matchRule(t, [twinA, twinB])?.id).toBe(twinA.id)
  })
  it('does not apply a rule for another account', () => {
    const base = rules.find((r) => r.merchantKey === 'paws-and-claws')!
    expect(matchRule(line('paws-and-claws', null, -500, 'card-a'), [{ ...base, accountId: 'chk-a' }])).toBeNull()
  })
})

describe('categorize: precedence manual > rule > auto', () => {
  it('auto alone: the keyword guess, source auto, only for spending kinds', () => {
    const c = categorize(line('nobody', null, -500), rules, auto({ categoryId: 'dining' }))
    expect(c).toMatchObject({ kind: 'spend', kindSource: 'auto', categoryId: 'dining', categorySource: 'auto', ruleId: null })
    const t = categorize(line('nobody', null, -500), rules, auto({ kind: 'transfer', categoryId: 'dining' }))
    expect(t).toMatchObject({ kind: 'transfer', categoryId: null, categorySource: 'none' })
  })
  it('a rule beats the auto guess and the hint', () => {
    const c = categorize(line('paws-and-claws', null, -500), rules, auto({ categoryId: 'dining', kind: 'refund', kindSource: 'hint' }))
    expect(c).toMatchObject({ categoryId: 'pets', categorySource: 'rule', kind: 'refund', kindSource: 'hint' })
    expect(c.ruleId).toMatch(/^r/)
  })
  it('manual beats a rule, field by field', () => {
    const cur = { kind: 'spend' as const, kindSource: 'auto' as const, categoryId: 'gifts', categorySource: 'manual' as const, ruleId: null, debtAccountId: null, confidence: 100 }
    const c = categorize({ ...line('paws-and-claws', null, -500), current: cur }, rules, auto())
    expect(c).toMatchObject({ categoryId: 'gifts', categorySource: 'manual' })
    const kindManual = { ...cur, kind: 'transfer' as const, kindSource: 'manual' as const, categoryId: null, categorySource: 'none' as const }
    const k = categorize({ ...line('homestead-lending-pmt', null, -120000), current: kindManual }, rules, auto())
    expect(k).toMatchObject({ kind: 'transfer', kindSource: 'manual', debtAccountId: null })
  })
  it('a row whose kind and category are both manual comes back unchanged', () => {
    const cur = { kind: 'income' as const, kindSource: 'manual' as const, categoryId: 'gifts', categorySource: 'manual' as const, ruleId: 'rXYZ', debtAccountId: 'mtg', confidence: 77 }
    const c = categorize({ ...line('homestead-lending-pmt', null, -1), current: cur }, rules, auto())
    expect(c).toMatchObject({ kind: 'income', kindSource: 'manual', categoryId: 'gifts', categorySource: 'manual', ruleId: 'rXYZ', debtAccountId: 'mtg', confidence: 77 })
  })
  it('a stored rule-sourced kind survives a re-run when the rule no longer sets one', () => {
    const cur = { kind: 'spend' as const, kindSource: 'rule' as const, categoryId: null, categorySource: 'none' as const, ruleId: null, debtAccountId: null, confidence: 90 }
    const c = categorize({ ...line('nobody', null, -500), current: cur }, rules, auto({ kind: 'transfer' }))
    expect(c).toMatchObject({ kind: 'spend', kindSource: 'rule' })
  })
})

describe('categorize: a rule can set kind and debt account (debt payments that count as spending)', () => {
  it('turns a loan-like payment into housing spending and carries the debt account', () => {
    const c = categorize(line('homestead-lending-pmt', null, -120000), rules, auto({ kind: 'debt_payment', kindConfidence: 85 }))
    expect(c).toMatchObject({ kind: 'spend', kindSource: 'rule', categoryId: 'housing', categorySource: 'rule', debtAccountId: 'mtg', confidence: 90 })
    expect(SPENDING_KINDS).toContain(c.kind)
    expect(c.displayName).toBe('Home loan payment')
  })
  it('the same wording without a rule stays out of spending', () => {
    const c = categorize(line('some-other-lender', null, -120000), rules, auto({ kind: 'debt_payment' }))
    expect(SPENDING_KINDS).not.toContain(c.kind)
    expect(c.debtAccountId).toBeNull()
  })
})

describe('autoCategory', () => {
  it('maps a few generic words and nothing else', () => {
    expect(autoCategory('SAMPLE GROCERY')).toBe('groceries')
    expect(autoCategory('CORNER PHARMACY')).toBe('health')
    expect(autoCategory('LUNA RESTAURANT')).toBe('dining')
    expect(autoCategory('SELF SERVE GAS')).toBe('fuel')
    expect(autoCategory('ATM WITHDRAWAL')).toBe('cash')
    expect(autoCategory('SERVICE FEE')).toBe('fees')
    expect(autoCategory('COFFEE')).toBe('dining')
    expect(autoCategory('BRAMBLEWOOD MARKET')).toBeNull()
  })
})
