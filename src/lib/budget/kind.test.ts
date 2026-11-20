import { describe, expect, it } from 'vitest'
import { classifyKind } from './kind'
import { normalizeDescription } from './normalize'
import { ACCOUNTS } from './__fixtures__/synthetic'
import { SPENDING_KINDS, type TxnKind } from './types'

const byId = (id: string) => ACCOUNTS.find((a) => a.id === id)!
const k = (desc: string, cents: number, account: string, hint?: TxnKind | null) =>
  classifyKind(normalizeDescription(desc), cents, byId(account), ACCOUNTS, hint)

describe('classifyKind: cards', () => {
  it('payment received is a card payment; other credits are refunds; charges are spend', () => {
    expect(k('PAYMENT THANK YOU', 20000, 'card-a').kind).toBe('card_payment')
    expect(k('REFUND BRAMBLEWOOD MARKET', 2300, 'card-a').kind).toBe('refund')
    expect(k('BRAMBLEWOOD MARKET', -4500, 'card-a').kind).toBe('spend')
  })
  it('interest and fees are charges; a reversal of interest stays interest', () => {
    expect(k('INTEREST CHARGE ON PURCHASES', -1900, 'card-a').kind).toBe('interest_charged')
    expect(k('LATE FEE', -3900, 'card-a').kind).toBe('fee')
    expect(k('INTEREST ADJUSTMENT', 500, 'card-a').kind).toBe('interest_charged')
  })
})

describe('classifyKind: deposit accounts', () => {
  it('overdraft moves are not spending, but an overdraft fee is a fee', () => {
    expect(k('OVERDRAFT PROTECTION TRANSFER', 3500, 'chk-a').kind).toBe('overdraft_move')
    expect(k('OVERDRAFT PROTECTION TRANSFER', -3500, 'sav-a').kind).toBe('overdraft_move')
    expect(k('OVERDRAFT FEE', -3500, 'chk-a').kind).toBe('fee')
  })
  it('transfer wording resolves the counterparty to one of our own accounts', () => {
    expect(k('ONLINE PAYMENT TO CARD X0003', -20000, 'chk-a').kind).toBe('card_payment')
    expect(k('TRANSFER TO SAVINGS X0002', -50000, 'chk-a').kind).toBe('transfer')
    expect(k('PAYMENT TO LOAN X0005', -30000, 'chk-a').kind).toBe('loan_payment')
    expect(k('TRANSFER FROM LINE X0004', 90000, 'chk-a').kind).toBe('loan_advance')
    expect(k('TRANSFER TO LINE X0004', -90000, 'chk-a').kind).toBe('loan_payment')
    expect(k('HOME LOAN PMT X0006', -120000, 'chk-a').kind).toBe('debt_payment')
  })
  it('transfer wording to an unknown account is an external transfer; PAYMENT alone is not a transfer', () => {
    expect(k('TRANSFER TO X9999', -10000, 'chk-a').kind).toBe('transfer_external')
    expect(k('E-TRANSFER SENT', -10000, 'chk-a').kind).toBe('transfer_external')
    expect(k('ONLINE PAYMENT SAMPLE UTILITY', -10000, 'chk-a').kind).toBe('spend')
  })
  it('classifies interest, payroll, fees, refunds, other credits and other debits', () => {
    expect(k('INTEREST PAID', 310, 'sav-a').kind).toBe('interest_earned')
    expect(k('DIVIDEND', 310, 'sav-a').kind).toBe('interest_earned')
    expect(k('PAYROLL EXAMPLE EMPLOYER', 250000, 'chk-a').kind).toBe('income')
    expect(k('DIRECT DEP SAMPLE CO', 100000, 'chk-a').kind).toBe('income')
    expect(k('MONTHLY SERVICE FEE', -1500, 'chk-a').kind).toBe('fee')
    expect(k('RETURN BRAMBLEWOOD MARKET', 1200, 'chk-a').kind).toBe('refund')
    expect(k('DATE 11-28 POS DEBIT BRAMBLEWOOD MARKET', 1200, 'chk-a').kind).toBe('refund')
    expect(k('MOBILE DEPOSIT', 1200, 'chk-a').kind).toBe('income')
    expect(k('BRAMBLEWOOD MARKET', -1200, 'chk-a').kind).toBe('spend')
    expect(k('ANYTHING', 0, 'chk-a').kind).toBe('other')
  })
})

describe('classifyKind: loans and hints', () => {
  it('a loan statement shows payments received, advances and interest', () => {
    expect(k('PAYMENT RECEIVED', 30000, 'loan-a').kind).toBe('loan_payment')
    expect(k('ADVANCE', -10000, 'loc-a').kind).toBe('loan_advance')
    expect(k('INTEREST', -1500, 'loan-a').kind).toBe('interest_charged')
  })
  it('a hint wins over the wording', () => {
    const g = k('PAYMENT THANK YOU', 20000, 'card-a', 'refund')
    expect(g).toEqual({ kind: 'refund', confidence: 100, source: 'hint' })
  })
  it('refunds are never put into transfer or income by the wording of a card credit', () => {
    expect(SPENDING_KINDS).toContain(k('RETURN OF GOODS', 900, 'card-a').kind)
  })
})

describe('classifyKind: TRFR wording and swipe credits', () => {
  it('a TRFR line is a transfer like TRANSFER and TFR', () => {
    expect(k('BRANCH TRFR TO DDA X0002', -5000, 'chk-a').kind).toBe('transfer')
    expect(k('BRANCH TRFR TO DDA X9999', -5000, 'chk-a').kind).toBe('transfer_external')
    expect(k('TRFR FROM X0002', 5000, 'chk-a').kind).toBe('transfer')
  })
  it('a point-of-sale credit reads as a refund, also without a purchase date', () => {
    expect(k('POINT OF SALE CREDIT L123 BRAMBLEWOOD MARKET', 1200, 'chk-a').kind).toBe('refund')
    expect(k('POINT OF SALE DEBIT L123 BRAMBLEWOOD MARKET', -1200, 'chk-a').kind).toBe('spend')
  })
})
