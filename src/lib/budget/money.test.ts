import { describe, expect, it } from 'vitest'
import { formatCents, parseMoney } from './money'

describe('formatCents', () => {
  it('formats en-US USD with grouping and a leading minus', () => {
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(-100000000)).toBe('-$1,000,000.00')
  })
  it('refuses a non-integer', () => {
    expect(() => formatCents(1.5)).toThrow()
    expect(() => formatCents(Number.NaN)).toThrow()
  })
})

describe('parseMoney', () => {
  it('parses the common spellings', () => {
    expect(parseMoney('$1,234.56')).toBe(123456)
    expect(parseMoney('1234.5')).toBe(123450)
    expect(parseMoney('-12')).toBe(-1200)
    expect(parseMoney('(12.00)')).toBe(-1200)
    expect(parseMoney('12.00-')).toBe(-1200)
    expect(parseMoney('−12.34')).toBe(-1234)
    expect(parseMoney('.5')).toBe(50)
    expect(parseMoney(' 7 ')).toBe(700)
  })
  it('rejects anything else, and never returns -0', () => {
    for (const bad of ['', '$', 'abc', '1.234', '1,23.00', '1,2345.00', '12.3.4']) expect(parseMoney(bad)).toBeNull()
    expect(Object.is(parseMoney('-0'), -0)).toBe(false)
    expect(parseMoney('-0.00')).toBe(0)
  })
  it('round-trips formatCents', () => {
    for (const c of [0, 1, 99, 100, 123456, -4500, -99999999]) expect(parseMoney(formatCents(c))).toBe(c)
  })
})
