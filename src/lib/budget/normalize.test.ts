import { describe, expect, it } from 'vitest'
import { normalizeDescription as norm } from './normalize'

describe('normalizeDescription', () => {
  it('upper-cases, collapses spaces and strips card-swipe boilerplate', () => {
    expect(norm('pos purchase   Bramblewood Market  terminal 55021').clean).toBe('BRAMBLEWOOD MARKET')
    expect(norm('DEBIT CARD PURCHASE TIME 14.05 QUILLFEATHER CAFE').clean).toBe('QUILLFEATHER CAFE')
  })
  it('reads the store number as printed, with leading zeros, and the location after it', () => {
    const n = norm('BRAMBLEWOOD MARKET #0412 SPRINGFIELD IL')
    expect(n.storeNo).toBe('0412')
    expect(n.clean).toBe('BRAMBLEWOOD MARKET')
    expect(n.location).toBe('SPRINGFIELD IL')
    expect(norm('CHAIN X # 77').storeNo).toBe('77')
    expect(norm('QUILLFEATHER CAFE').storeNo).toBeNull()
  })
  it('keeps the purchase date of a card swipe', () => {
    const n = norm('DATE 11-28 POS DEBIT BRAMBLEWOOD MARKET')
    expect(n.purchaseMmdd).toBe('11-28')
    expect(n.clean).toBe('BRAMBLEWOOD MARKET')
    expect(norm('PURCHASE AUTHORIZED ON 03/07 QUILLFEATHER CAFE').purchaseMmdd).toBe('03-07')
    expect(norm('QUILLFEATHER CAFE DATE 13-45').purchaseMmdd).toBeNull()
  })
  it('drops ACH trace and id runs, embedded dates and times, phone and domain tails', () => {
    expect(norm('PAYROLL EXAMPLE EMPLOYER ID: 9876543210 TRACE 123456789012').clean).toBe('PAYROLL EXAMPLE EMPLOYER')
    expect(norm('TRANSFER 11/12/2026 AT 14:05 TO SAVINGS').clean).toBe('TRANSFER TO SAVINGS')
    expect(norm('QUILLFEATHER CAFE 555-123-4567').clean).toBe('QUILLFEATHER CAFE')
    expect(norm('ONLINE SHOP WWW.EXAMPLE.COM').clean).toBe('ONLINE SHOP')
    expect(norm('EXAMPLE.COM').clean).toBe('EXAMPLE.COM')
  })
  it('takes the masked counterparty last4 and a confirmation token', () => {
    const n = norm('ONLINE PAYMENT TO CARD X0003 CONF# 77AB91')
    expect(n.counterpartyLast4).toBe('0003')
    expect(n.confirmation).toBe('77AB91')
    expect(n.clean).toBe('ONLINE PAYMENT TO CARD')
    expect(norm('TRANSFER TO ****0002').counterpartyLast4).toBe('0002')
    expect(norm('TRANSFER TO ACCT 12345670004').counterpartyLast4).toBe('0004')
    expect(norm('TRANSFER ENDING IN 0005').counterpartyLast4).toBe('0005')
  })
  it('does not mistake a name that ends in X for a masked account', () => {
    expect(norm('CHAIN X 1234 MAIN ST').counterpartyLast4).toBeNull()
    expect(norm('MAX 1234').counterpartyLast4).toBeNull()
  })
  it('strips a trailing state code, and the city before it when the name is long enough', () => {
    const n = norm('BRAMBLEWOOD MARKET SPRINGFIELD IL')
    expect(n.clean).toBe('BRAMBLEWOOD MARKET')
    expect(n.location).toBe('SPRINGFIELD IL')
    expect(norm('QUILLFEATHER CAFE IL').clean).toBe('QUILLFEATHER CAFE')
    expect(norm('QUILLFEATHER CAFE').location).toBeNull()
  })
  it('is idempotent on its own output', () => {
    for (const raw of ['POS PURCHASE BRAMBLEWOOD MARKET #0412 SPRINGFIELD IL', 'ONLINE PAYMENT TO CARD X0003', 'MONTHLY SERVICE FEE']) {
      const once = norm(raw).clean
      expect(norm(once).clean).toBe(once)
    }
  })
})
