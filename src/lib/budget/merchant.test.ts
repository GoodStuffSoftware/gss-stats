import { describe, expect, it } from 'vitest'
import { merchantKey as mk, withCounterparty } from './merchant'

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
    expect(mk('CASH APP *SOME PERSON')).toMatchObject({ key: 'cash-app-some', aggregator: true })
    expect(mk('')).toEqual({ key: 'unknown', name: 'Unknown', aggregator: true })
  })
  it('does not let a refund wording hide the merchant', () => {
    expect(mk('REFUND BRAMBLEWOOD MARKET').key).toBe('bramblewood-market')
    expect(mk('RETURN').key).toBe('return')
  })
})

describe('merchantKey: payees, digits in names, "NAME *"', () => {
  it('keeps the payee of a person-to-person line, still hidden, one key per payee', () => {
    expect(mk('VENMO *PAT EXAMPLE')).toEqual({ key: 'venmo-pat', name: 'Venmo Pat', aggregator: true })
    expect(mk('VENMO *LEE SAMPLE').key).toBe('venmo-lee')
    expect(mk('CASH APP*JORDAN TESTLAKEOAKLAND').key).toBe('cash-app-jordan')
    // Later words are cut off and glued to network boilerplate: the payee is the first name word.
    expect(mk('VENMO *PAT EXAMPLEVISA DIRECTNY').key).toBe('venmo-pat')
    expect(mk('VENMO *PAT EXAMPLENEW').key).toBe('venmo-pat')
  })
  it('skips rail wording, so a line with no payee keeps the bare rail key', () => {
    expect(mk('VENMO PAYMENT').key).toBe('venmo')
    expect(mk('VENMO CASHOUT').key).toBe('venmo')
    expect(mk('VENMO PAYMENT JANE').key).toBe('venmo-jane')
  })
  it('a name that starts with a digit run and hyphens keeps its name', () => {
    expect(mk('1-800-EXAMPLE.COM')).toMatchObject({ key: '1800examplecom', aggregator: false })
    expect(mk('1-800-EXAMPLE').key).toBe('1800example')
    expect(mk('7ELEVEN').key).toBe('7eleven')
  })
  it('a digit inside a name does not end it; store numbers, terminal codes and id runs still do', () => {
    expect(mk('PAYPAL *EXAMPLE4US')).toEqual({ key: 'example4us', name: 'Example4us', aggregator: false })
    expect(mk('QUILLFEATHER4U CAFE').key).toBe('quillfeather4u-cafe')
    expect(mk('BRAMBLEWOOD MARKET 1234').key).toBe('bramblewood-market')
    expect(mk('SHEETZ B9FQ').key).toBe('sheetz')
    expect(mk('SHOP•7530FUQUAY').key).toBe('unknown')
    expect(mk('EXAMPLECLOUD4029355550100').key).toBe('unknown')
  })
  it('"NAME *" with nothing after the star is the named merchant, not a hidden one', () => {
    expect(mk('ACME *')).toEqual({ key: 'acme', name: 'Acme', aggregator: false })
    expect(mk('ACME VIDEO *').key).toBe('acme-video')
    expect(mk('SQ *').aggregator).toBe(true)
  })
  it('withCounterparty adds the last four to the key and keeps the name', () => {
    expect(withCounterparty(mk('INTERNET DEBIT TRANSFER'), '0099')).toEqual({ key: 'internet-debit-transfer-0099', name: 'Internet Debit Transfer', aggregator: false })
  })
})
