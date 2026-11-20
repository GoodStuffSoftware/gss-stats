import { describe, expect, it } from 'vitest'
import { hasLongDigitRun, last4, maskDigits } from './mask'

describe('maskDigits', () => {
  it('cuts every run of 5+ digits to a bullet and the last four', () => {
    expect(maskDigits('TRACE 123456789012 ID 98765')).toBe('TRACE •9012 ID •8765')
  })
  it('leaves no run of 5 or more digits, whatever the input', () => {
    const samples = ['1234567890123456', 'A12345B', '00000', '12 34567 890123', 'xxx' + '9'.repeat(40), '2026-11-20 4 9999']
    for (const s of samples) expect(hasLongDigitRun(maskDigits(s))).toBe(false)
  })
  it('masks account and card numbers printed in groups to their last four', () => {
    expect(maskDigits('PAYMENT TO ACCT 1234 5678 9012 3456')).toBe('PAYMENT TO ACCT •3456')
    expect(maskDigits('XFER 1234-5678-90 SAVINGS')).toBe('XFER •7890 SAVINGS')
    expect(maskDigits('CARD 4000 0000 0000 0002 PAID')).toBe('CARD •0002 PAID')
    expect(maskDigits('ACCT 123 456 789')).toBe('ACCT •6789')
    expect(maskDigits('REF 12345 6789 ON 2026-11-20')).toBe('REF •6789 ON 2026-11-20')
  })
  it('keeps amounts, dates, times, phone numbers and short reference numbers as written', () => {
    for (const s of [
      'PAID $1,234.56 ON 11/20/2026', 'ON 2026-11-20 4 9999', 'ON 2026-11-20 AT 10:30', 'ORDER 1234 5678', 'REF 123 456',
      'CALL 555-123-4567', 'CALL (555) 123-4567', 'CALL 1-555-123-4567', 'STORE 0412 0413', '2026-11-20 2026-11-21', '$12 345 67',
    ]) expect(maskDigits(s), s).toBe(s)
  })
  it('leaves no grouped number of 9 or more digits either', () => {
    for (const s of ['1234 5678 9012 3456', '1234-5678-9012-3456', '123 45 6789012', 'x 99 999 999 99 y']) {
      expect(maskDigits(s).replace(/\D/g, '').length, s).toBeLessThanOrEqual(4)
    }
  })
  it('keeps short numbers, dates and store numbers', () => {
    expect(maskDigits('STORE #0412 ON 2026-11-20 X0003')).toBe('STORE #0412 ON 2026-11-20 X0003')
  })
})

describe('last4', () => {
  it('keeps digits only', () => {
    expect(last4('XXXX-0001')).toBe('0001')
    expect(last4('acct 12 34 56')).toBe('3456')
  })
  it('is null under four digits', () => {
    expect(last4('abc 12')).toBeNull()
    expect(last4('')).toBeNull()
  })
})
