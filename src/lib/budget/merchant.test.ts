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
    expect(mk('VENMO *PAT EXAMPLE')).toEqual({ key: 'venmo-pat', name: 'Venmo', aggregator: true })
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
    expect(mk('SHOP•7530SAMPLEVILLE').key).toBe('unknown')
    expect(mk('EXAMPLECLOUD4029355550100').key).toBe('unknown')
    // A name cut off against an area code, a random id and a city that starts with a digit are not names.
    expect(mk('SAMPLETOWN HELPDESK877').key).toBe('sampletown')
    expect(mk('GADGET *RKK8VW').key).toBe('gadget')
    expect(mk('SQ *GADGET SHOP QX9ZB').key).toBe('gadget-shop')
    expect(mk('BRAMBLEWOOD MARKET 1SPRINGFIELD').key).toBe('bramblewood-market')
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

describe('merchantKey: display names (the key never changes with them)', () => {
  it('a web-style name shows the brand, not a run-together address', () => {
    expect(mk('WWW.QUILLFEATHER.COM')).toEqual({ key: 'wwwquillfeathercom', name: 'Quillfeather', aggregator: false })
    expect(mk('QUILLFEATHER.COM').name).toBe('Quillfeather')
    expect(mk('QUILLFEATHER.COM*AB12CD').name).toBe('Quillfeather')
    expect(mk('QUILLFEATHER.COM/BILL').name).toBe('Quillfeather')
    expect(mk('1-800-EXAMPLE.COM')).toMatchObject({ key: '1800examplecom', name: '1800example' })
    expect(mk('BRAMBLEWOOD MARKET WWW.BRAMBLEWOOD.NET').name).toBe('Bramblewood Market')
    // A dot that is not a web ending stays part of the word.
    expect(mk('ST.COLLEGE BOOKS').key).toBe('stcollege-books')
  })
  it('bank boilerplate is not the merchant', () => {
    expect(mk('ACH DEBIT QUILLFEATHER CAFE')).toEqual({ key: 'ach-debit-quillfeather', name: 'Quillfeather', aggregator: false })
    expect(mk('ACH DEPOSIT BRAMBLEWOOD PAYROLL').name).toBe('Bramblewood')
    expect(mk('ACH DEBIT').name).toBe('Ach Debit')
  })
  it('a processor shows as itself when only its own wording follows', () => {
    expect(mk('ACH DEBIT PAYPAL')).toMatchObject({ key: 'ach-debit-paypal', name: 'Paypal' })
    expect(mk('PAYPAL PURCHASE •1234')).toMatchObject({ key: 'paypal-purchase', name: 'Paypal' })
    expect(mk('PAYPAL RETRY PYMT')).toMatchObject({ key: 'paypal-retry-pymt', name: 'Paypal' })
    expect(mk('PAYPAL QUILLFEATHER').name).toBe('Paypal Quillfeather')
  })
  it('a leading processor prefix written without a star is dropped from the name', () => {
    expect(mk('SP QUILLFEATHER SHOP')).toEqual({ key: 'sp-quillfeather-shop', name: 'Quillfeather Shop', aggregator: false })
    expect(mk('SP QUILLFEATHER SPQUILLFEATHERC')).toMatchObject({ key: 'sp-quillfeather-spquillfeatherc', name: 'Quillfeather' })
  })
  it('a name glued to a truncated copy of itself keeps one copy', () => {
    expect(mk('BRAMBLEWOOD CLUBBRAMBLEWOODCL').name).toBe('Bramblewood Club')
    expect(mk('QUILLFEATHER QUILLFEATHERC').name).toBe('Quillfeather')
    expect(mk('SAMPLEFORGE WORKSHOPSAMPLEFORGEW').key).toBe('sampleforge-workshopsampleforgew')
    expect(mk('SAMPLEFORGE WORKSHOPSAMPLEFORGEW').name).toBe('Sampleforge Workshop')
    expect(mk('QUILLFEATHERGLASSWORKSQUILLFEATHERG').name).toBe('Quillfeatherglassworks')
  })
  it('a person-to-person payment shows the rail while the key keeps the payee', () => {
    expect(mk('VENMO *PAT EXAMPLE')).toEqual({ key: 'venmo-pat', name: 'Venmo', aggregator: true })
    expect(mk('CASH APP*JORDAN TESTLAKEOAKLAND')).toMatchObject({ key: 'cash-app-jordan', name: 'Cash App' })
    expect(mk('ZELLE PAYMENT TO LEE SAMPLE')).toMatchObject({ key: 'zelle-lee', name: 'Zelle' })
    expect(mk('VENMO PAYMENT')).toMatchObject({ key: 'venmo', name: 'Venmo' })
  })
  it('an ordinary name is unchanged', () => {
    expect(mk('BRAMBLEWOOD MARKET #12 SPRINGFIELD').name).toBe('Bramblewood Market')
    expect(mk('FOOD STORE')).toMatchObject({ key: 'food-store', name: 'Food Store' })
    expect(mk('SPRINGFIELD SPORTS').name).toBe('Springfield Sports')
  })
})
