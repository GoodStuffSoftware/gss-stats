import { describe, expect, it } from 'vitest'
import { addDays, daysBetween, inferYear, isIsoDate, twoDigitYear } from './dates'

describe('inferYear', () => {
  it('puts a December line on a January statement in the year before', () => {
    expect(inferYear(12, 28, '2027-01-05')).toBe('2026-12-28')
    expect(inferYear(1, 3, '2027-01-05')).toBe('2027-01-03')
  })
  it('lets a January line past a late-December anchor into the next year only within a week', () => {
    expect(inferYear(1, 2, '2026-12-30')).toBe('2027-01-02')
    expect(inferYear(1, 15, '2026-12-30', 400)).toBe('2026-01-15') // 16 days ahead is too far: last January
    expect(inferYear(1, 15, '2026-12-30')).toBe('2027-01-15') // ... unless that is over maxBackDays, then the nearest wins
  })
  it('stays in the anchor year in the middle of the year', () => {
    expect(inferYear(6, 15, '2026-07-01')).toBe('2026-06-15')
    expect(inferYear(7, 5, '2026-07-01')).toBe('2026-07-05')
  })
  it('handles a leap day and refuses impossible dates', () => {
    expect(inferYear(2, 29, '2028-03-02')).toBe('2028-02-29')
    expect(() => inferYear(2, 30, '2026-03-01')).toThrow(RangeError)
    expect(() => inferYear(13, 1, '2026-03-01')).toThrow(RangeError)
  })
  it('falls back to the nearest date when nothing is within maxBackDays', () => {
    expect(inferYear(1, 1, '2026-12-20', 100)).toBe('2027-01-01')
  })
})

describe('twoDigitYear', () => {
  it('reads the common layouts', () => {
    expect(twoDigitYear('11/05/26')).toBe('2026-11-05')
    expect(twoDigitYear('11-05-26')).toBe('2026-11-05')
    expect(twoDigitYear('110526')).toBe('2026-11-05')
    expect(twoDigitYear('12/31/99')).toBe('1999-12-31')
  })
  it('rejects bad dates', () => {
    expect(() => twoDigitYear('13/01/26')).toThrow()
    expect(() => twoDigitYear('02/30/26')).toThrow()
    expect(() => twoDigitYear('hello')).toThrow()
  })
})

describe('helpers', () => {
  it('validates, adds and subtracts calendar days', () => {
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2028-02-29')).toBe(true)
    expect(isIsoDate('2026-1-1')).toBe(false)
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(daysBetween('2026-11-01', '2026-11-30')).toBe(29)
    expect(daysBetween('2026-11-30', '2026-11-01')).toBe(-29)
  })
})
