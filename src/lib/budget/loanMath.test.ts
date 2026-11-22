import { describe, expect, it } from 'vitest'
import { monthlyInterestCents, monthlyPaymentCents, monthsToPayoff, payoffMonth, totalOwed } from './loanMath'

describe('monthsToPayoff', () => {
  it('amortises with interest (rounded up)', () => {
    // $10,000 at 12% (1%/mo), $500/mo: n = 22.4 -> 23
    expect(monthsToPayoff(1_000_000, 1200, 50_000)).toEqual({ kind: 'payoff', months: 23 })
  })
  it('APR 0 is balance / payment', () => {
    expect(monthsToPayoff(100_000, 0, 30_000)).toEqual({ kind: 'payoff', months: 4 })
    expect(monthsToPayoff(90_000, 0, 30_000)).toEqual({ kind: 'payoff', months: 3 })
  })
  it('null APR is rate unknown', () => {
    expect(monthsToPayoff(100_000, null, 30_000)).toEqual({ kind: 'rate_unknown', months: 4 })
  })
  it('payment equal to the interest never pays off', () => {
    expect(monthsToPayoff(1_000_000, 1200, 10_000)).toEqual({ kind: 'not_paid_off' })
  })
  it('tiny payment below interest never pays off', () => {
    expect(monthsToPayoff(1_000_000, 1200, 1)).toEqual({ kind: 'not_paid_off' })
  })
  it('payment one cent over interest is huge but finite', () => {
    const r = monthsToPayoff(1_000_000, 1200, 10_001)
    expect(r.kind).toBe('payoff')
    if (r.kind === 'payoff') expect(r.months).toBeGreaterThan(900)
  })
  it('huge balance stays finite', () => {
    const r = monthsToPayoff(100_000_000_000_00, 600, 1_000_000_000_00)
    expect(r.kind).toBe('payoff')
    if (r.kind === 'payoff') expect(Number.isFinite(r.months)).toBe(true)
  })
  it('zero or negative balance is paid off', () => {
    expect(monthsToPayoff(0, 500, 100)).toEqual({ kind: 'paid_off', months: 0 })
    expect(monthsToPayoff(-5, null, null)).toEqual({ kind: 'paid_off', months: 0 })
  })
  it('missing or non-positive payment / null balance', () => {
    expect(monthsToPayoff(1000, 500, null)).toEqual({ kind: 'no_payment' })
    expect(monthsToPayoff(1000, 500, 0)).toEqual({ kind: 'no_payment' })
    expect(monthsToPayoff(1000, 500, -1)).toEqual({ kind: 'no_payment' })
    expect(monthsToPayoff(null, 500, 100)).toEqual({ kind: 'no_payment' })
  })
  it('a payment covering the balance is one month', () => {
    expect(monthsToPayoff(1000, 500, 5000)).toEqual({ kind: 'payoff', months: 1 })
  })
})

describe('payoffMonth', () => {
  it('lands in the month-year', () => {
    expect(payoffMonth('2026-11-22', 0)).toBe('Nov 2026')
    expect(payoffMonth('2026-11-22', 2)).toBe('Jan 2027')
    expect(payoffMonth('2026-01-31', 25)).toBe('Feb 2028')
  })
  it('bad date is null', () => {
    expect(payoffMonth('nope', 3)).toBeNull()
    expect(payoffMonth('2026-13-01', 3)).toBeNull()
  })
})

describe('monthlyInterestCents', () => {
  it('estimates B x r', () => {
    expect(monthlyInterestCents(1_000_000, 1200)).toBe(10_000)
    expect(monthlyInterestCents(1_000_000, 0)).toBe(0)
  })
  it('null inputs and zero balance', () => {
    expect(monthlyInterestCents(null, 1200)).toBeNull()
    expect(monthlyInterestCents(1000, null)).toBeNull()
    expect(monthlyInterestCents(0, 1200)).toBe(0)
  })
})

describe('monthlyPaymentCents', () => {
  it('normalises scheduled payments', () => {
    expect(monthlyPaymentCents({ paymentCents: 120_000, every: 'monthly' })).toEqual({ cents: 120_000, source: 'scheduled' })
    expect(monthlyPaymentCents({ paymentCents: 60_000, every: 'semimonthly' })).toEqual({ cents: 120_000, source: 'scheduled' })
    expect(monthlyPaymentCents({ paymentCents: 60_000, every: 'biweekly' })).toEqual({ cents: 130_000, source: 'scheduled' })
    expect(monthlyPaymentCents({ paymentCents: 50_000, every: null })).toEqual({ cents: 50_000, source: 'scheduled' })
  })
  it('falls back to the average of the last 3 months', () => {
    expect(monthlyPaymentCents(null, [30_000, 60_000, 90_000])).toEqual({ cents: 60_000, source: 'from payments' })
    expect(monthlyPaymentCents({ paymentCents: null, every: 'monthly' }, [10_000, 20_000, 0, 999_999])).toEqual({ cents: 10_000, source: 'from payments' })
  })
  it('null when nothing is known', () => {
    expect(monthlyPaymentCents(null)).toBeNull()
    expect(monthlyPaymentCents({ paymentCents: 0, every: 'monthly' }, [0, 0, 0])).toBeNull()
  })
})

describe('totalOwed', () => {
  it('excludes cosigned and counts missing', () => {
    expect(totalOwed([
      { balanceCents: 100_000, cosigned: false },
      { balanceCents: 50_000, cosigned: true },
      { balanceCents: null, cosigned: false },
      { balanceCents: 25_000, cosigned: false },
    ])).toEqual({ totalCents: 125_000, cosignedCents: 50_000, missingCount: 1 })
  })
  it('empty', () => {
    expect(totalOwed([])).toEqual({ totalCents: 0, cosignedCents: 0, missingCount: 0 })
  })
})
