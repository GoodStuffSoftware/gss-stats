// Synthetic data for the Budget tests. Everything here is made up: accounts end 0001-0009, merchants
// are invented ("Chain X" stands for any one name with a fuel store and a grocery store), emails are
// example.com. Never paste real statement lines here (public repo; see CLAUDE.md, Environment data).
import type { Account, Category, ImportRequest, ImportRow, ImportSeed, MerchantRule, PlanContext } from '../types'
import { ruleIdFor } from '../rules'

export const PEOPLE = [
  { id: 'pa', label: 'Person A' },
  { id: 'pb', label: 'Person B' },
]

const acct = (id: string, label: string, kind: Account['kind'], last4: string, over: Partial<Account> = {}): Account => ({
  id, label, kind, personId: 'pa', last4, isDebt: false, inSpending: true, creditLimitCents: null, aprBp: null, ...over,
})

export const ACCOUNTS: Account[] = [
  acct('chk-a', 'Checking A', 'checking', '0001'),
  acct('sav-a', 'Savings A', 'savings', '0002'),
  acct('card-a', 'Card A', 'card', '0003', { isDebt: true, creditLimitCents: 500_000, aprBp: 2199 }),
  acct('loc-a', 'Line of credit A', 'line_of_credit', '0004', { isDebt: true, inSpending: false, creditLimitCents: 1_000_000 }),
  acct('loan-a', 'Loan A', 'loan', '0005', { isDebt: true, inSpending: false, aprBp: 599 }),
  acct('mtg', 'Home loan (payments only)', 'external_debt', '0006', { personId: null, isDebt: true, inSpending: false, aprBp: 450 }),
  acct('store-card', 'Store card (payments only)', 'external_debt', '0007', { isDebt: true, inSpending: false }),
]

export const EXTRA_CATEGORIES: Category[] = [{ id: 'pets', label: 'Pets', color: '#a1b2c3', sort: 125 }]

type SeedRule = NonNullable<ImportSeed['rules']>[number]
const rule = (r: Partial<SeedRule> & { merchantKey: string }): SeedRule => ({
  storeNo: null, accountId: null, amountMinCents: null, amountMaxCents: null, setCategoryId: null, setKind: null, debtAccountId: null,
  displayName: null, confidence: 90, review: false, reviewReason: null, ...r,
})

/** "Chain X": one name, a fuel store (1001), a grocery store (2002), a banded store (3003), and unknown others. */
export const SEED_RULES: SeedRule[] = [
  rule({ merchantKey: 'chain-x', storeNo: '1001', setCategoryId: 'fuel', displayName: 'Chain X Fuel' }),
  rule({ merchantKey: 'chain-x', storeNo: '2002', setCategoryId: 'groceries', displayName: 'Chain X Grocery' }),
  rule({ merchantKey: 'chain-x', storeNo: '3003', amountMinCents: 1500, amountMaxCents: 20_000, setCategoryId: 'fuel' }),
  rule({ merchantKey: 'chain-x', setCategoryId: 'groceries', confidence: 50, review: true, reviewReason: 'ambiguous_store' }),
  rule({ merchantKey: 'homestead-lending-pmt', setKind: 'spend', setCategoryId: 'housing', debtAccountId: 'mtg', displayName: 'Home loan payment' }),
  rule({ merchantKey: 'storecard-payment', setKind: 'spend', setCategoryId: 'shopping', debtAccountId: 'store-card' }),
  rule({ merchantKey: 'paws-and-claws', setCategoryId: 'pets' }),
  // A merchant with an amount band and a plain fallback (no review flag on the fallback).
  rule({ merchantKey: 'depot-y', amountMinCents: 1000, amountMaxCents: 5000, setCategoryId: 'shopping' }),
  rule({ merchantKey: 'depot-y', setCategoryId: 'other', confidence: 70 }),
]

export const SEED: ImportSeed = { people: PEOPLE, accounts: ACCOUNTS, categories: EXTRA_CATEGORIES, rules: SEED_RULES }

export const row = (postedDate: string, amountCents: number, description: string, over: Partial<ImportRow> = {}): ImportRow =>
  ({ postedDate, amountCents, description, ...over })

export const CHECKING_ROWS: ImportRow[] = [
  row('2026-11-02', -4500, 'POS PURCHASE BRAMBLEWOOD MARKET #0412 SPRINGFIELD IL TERMINAL 55021'),
  row('2026-11-03', -6200, 'CHAIN X #1001 SPRINGFIELD IL'),
  row('2026-11-04', -8400, 'CHAIN X #2002 SPRINGFIELD IL'),
  row('2026-11-05', -1850, 'CHAIN X #9999 SPRINGFIELD IL'),
  row('2026-11-06', -300, 'CHAIN X #3003 SPRINGFIELD IL'),
  row('2026-11-07', -9000, 'CHAIN X #3003 SPRINGFIELD IL'),
  row('2026-11-10', 250_000, 'PAYROLL EXAMPLE EMPLOYER ID: 9876543210'),
  row('2026-11-12', -20_000, 'ONLINE PAYMENT TO CARD X0003 CONF# 77AB91'),
  row('2026-11-14', -50_000, 'TRANSFER TO SAVINGS X0002'),
  row('2026-11-15', -120_000, 'HOMESTEAD LENDING PMT ACCT X0006 TRACE 123456789012'),
  row('2026-11-20', -450, 'POS PURCHASE QUILLFEATHER CAFE'),
  row('2026-11-20', -450, 'POS PURCHASE QUILLFEATHER CAFE'),
  row('2026-11-25', 3500, 'OVERDRAFT PROTECTION TRANSFER'),
  row('2026-11-28', -1500, 'MONTHLY SERVICE FEE'),
  row('2026-11-29', 310, 'INTEREST PAID'),
  row('2026-11-30', -2750, 'PAWS AND CLAWS'),
  row('2026-11-18', -3000, 'DEPOT Y #11 SPRINGFIELD IL'),
  row('2026-11-19', -45_000, 'DEPOT Y #11 SPRINGFIELD IL'),
]

export const SAVINGS_ROWS: ImportRow[] = [
  row('2026-11-14', 50_000, 'TRANSFER FROM CHECKING X0001'),
  row('2026-11-25', -3500, 'OVERDRAFT PROTECTION TRANSFER'),
]

export const CARD_ROWS: ImportRow[] = [
  row('2026-11-12', 20_000, 'PAYMENT THANK YOU'),
  row('2026-11-20', -7800, 'SQ *QUILLFEATHER CAFE SPRINGFIELD IL'),
  row('2026-11-22', 2300, 'REFUND BRAMBLEWOOD MARKET #0412'),
  row('2026-11-28', -1900, 'INTEREST CHARGE ON PURCHASES'),
  row('2026-11-29', -9900, 'PAYPAL *4025550100'),
  row('2026-12-01', -1200, 'DATE 11-28 POS DEBIT BRAMBLEWOOD MARKET #0412'),
]

export function syntheticRequest(importId = 'imp-synth-1', withSeed = true): ImportRequest {
  return {
    importId, sourceLabel: 'synthetic', seed: withSeed ? SEED : undefined,
    statements: [
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', openingBalanceCents: 100_000, closingBalanceCents: 90_000, rows: CHECKING_ROWS },
      { accountId: 'sav-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: SAVINGS_ROWS },
      { accountId: 'card-a', periodStart: '2026-11-05', periodEnd: '2026-12-04', closingBalanceCents: 18_000, creditLimitCents: 500_000, aprBp: 2199,
        interestCents: 1900, minDueCents: 2500, dueDate: '2026-12-29', rows: CARD_ROWS },
    ],
  }
}

/** SEED_RULES as stored rows (ids from ruleIdFor, source 'seed', active). */
export async function seedRules(): Promise<MerchantRule[]> {
  return Promise.all(SEED_RULES.map(async (r) => ({ ...r, id: await ruleIdFor(r), source: 'seed' as const, active: true })))
}

/** A context as the server would read it: the household's accounts and rules, nothing loaded yet. */
export function emptyContext(over: Partial<PlanContext> = {}): PlanContext {
  return { accounts: ACCOUNTS, rules: [], pairCandidates: [], existingIds: new Set(), ...over }
}
