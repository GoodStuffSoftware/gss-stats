import { describe, expect, it } from 'vitest'
import { merchantKey as mk } from './merchant'

describe('merchantKey', () => {
  it('keeps the first one to three words, kebab-cased, with a title-cased name', () => {
    expect(mk('BRAMBLEWOOD MARKET')).toEqual({ key: 'bramblewood-market', name: 'Bramblewood Market', aggregator: false })
    expect(mk('QUILLFEATHER').key).toBe('quillfeather')
    expect(mk('ONE TWO THREE FOUR FIVE').key).toBe('one-two-three')
  })
  it('stops at a store number or address', () => {
    expect(mk('BRAMBLEWOOD MARKET 1234 MAIN ST').key).toBe('bramblewood-market')
    expect(mk('CHAIN X #77 SPRINGFIELD').key).toBe('chain-x')
  })
  it('strips a processor prefix and keeps the merchant after it', () => {
    expect(mk('SQ *QUILLFEATHER CAFE')).toEqual({ key: 'quillfeather-cafe', name: 'Quillfeather Cafe', aggregator: false })
    expect(mk('TST* BRAMBLEWOOD MARKET').key).toBe('bramblewood-market')
    expect(mk('SOMETHING *QUILLFEATHER CAFE').key).toBe('quillfeather-cafe')
  })
  it('drops a marketplace *token suffix', () => {
    expect(mk('SHOPX*AB12CD').key).toBe('shopx')
    expect(mk('SHOPX*AB12CD UNITS').key).toBe('shopx-units')
  })
  it('says the merchant is hidden when only a prefix or a person-to-person rail shows', () => {
    expect(mk('PAYPAL *')).toEqual({ key: 'paypal', name: 'Paypal', aggregator: true })
    expect(mk('VENMO PAYMENT JANE').aggregator).toBe(true)
    expect(mk('CASH APP *SOME PERSON')).toMatchObject({ key: 'cash-app', aggregator: true })
    expect(mk('')).toEqual({ key: 'unknown', name: 'Unknown', aggregator: true })
  })
  it('does not let a refund wording hide the merchant', () => {
    expect(mk('REFUND BRAMBLEWOOD MARKET').key).toBe('bramblewood-market')
    expect(mk('RETURN').key).toBe('return')
  })
})
