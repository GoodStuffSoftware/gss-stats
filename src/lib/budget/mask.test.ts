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
  it('keeps short numbers, dates and store numbers', () => {
    expect(maskDigits('STORE #0412 ON 2026-11-20 X0003')).toBe('STORE #0412 ON 2026-11-20 X0003')
  })
})

describe('last4', () => {
  it('keeps digits only', () => {
    expect(last4('XXXX-1234')).toBe('1234')
    expect(last4('acct 12 34 56')).toBe('3456')
  })
  it('is null under four digits', () => {
    expect(last4('abc 12')).toBeNull()
    expect(last4('')).toBeNull()
  })
})
