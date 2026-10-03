import { describe, expect, it } from 'vitest'
import {
  BAR_FIXED,
  FULL,
  ORGANIC_BAR_FACTOR,
  ORGANIC_MIN_D0,
  TOO_FEW,
  retentionBar,
  retentionVerdict,
  wilsonBounds,
} from './retention'

// Reference values were computed independently: each bound is the root of
// (phat - p)^2 = z^2 p (1 - p) / n found by bisection (z = 1.6448536), not by
// the closed form the module uses.
describe('wilsonBounds', () => {
  const cases: Array<[number, number, number, number]> = [
    [0, 500, 0, 0.0053819645],
    [500, 500, 0.9946180355, 1],
    [25, 500, 0.0362506492, 0.0685931188],
    [49, 500, 0.0782449485, 0.1220821509],
    [28, 500, 0.0413536796, 0.0754255049],
    [1, 1, 0.2698659552, 1],
  ]
  it.each(cases)('%i/%i', (x, n, lo, hi) => {
    const b = wilsonBounds(x, n)!
    expect(b.lower).toBeCloseTo(lo, 8)
    expect(b.upper).toBeCloseTo(hi, 8)
  })

  it('returns null for n <= 0', () => {
    expect(wilsonBounds(0, 0)).toBeNull()
    expect(wilsonBounds(3, -5)).toBeNull()
  })

  it('stays inside [0, 1] and brackets the point estimate', () => {
    for (const [x, n] of [[0, 1], [1, 1], [0, 500], [500, 500], [7, 13]] as const) {
      const b = wilsonBounds(x, n)!
      expect(b.lower).toBeGreaterThanOrEqual(0)
      expect(b.upper).toBeLessThanOrEqual(1)
      expect(b.lower).toBeLessThanOrEqual(x / n)
      expect(b.upper).toBeGreaterThanOrEqual(x / n)
    }
    expect(wilsonBounds(0, 500)!.lower).toBe(0)
    expect(wilsonBounds(500, 500)!.upper).toBe(1)
  })
})

describe('retentionBar', () => {
  it('exports the settled constants', () => {
    expect([BAR_FIXED, ORGANIC_MIN_D0, ORGANIC_BAR_FACTOR, TOO_FEW, FULL]).toEqual([0.075, 1000, 0.6, 200, 500])
  })
  it('is fixed at organic d0 999 and organic from 1,000', () => {
    expect(retentionBar({ organicD0: 999, organicReturns: 200 })).toEqual({ bar: 0.075, source: 'fixed' })
    const r = retentionBar({ organicD0: 1000, organicReturns: 200 })
    expect(r.source).toBe('organic')
    expect(r.bar).toBeCloseTo(0.12, 12)
  })
  it('can fall below the fixed bar once organic is large enough', () => {
    expect(retentionBar({ organicD0: 2000, organicReturns: 100 }).bar).toBeCloseTo(0.03, 12)
  })
})

describe('retentionVerdict', () => {
  const v = (
    d0: number,
    returns27: number,
    over: Partial<{ matured: boolean; daysToMature: number; bar: number }> = {},
  ) => retentionVerdict({ d0, returns27, matured: true, daysToMature: 0, bar: 0.075, ...over })

  it('d0 boundaries 199 / 200 / 499 / 500', () => {
    expect(v(199, 100).code).toBe('too-few')
    expect(v(200, 20).code).toBe('provisional')
    expect(v(499, 40).code).toBe('provisional')
    expect(v(500, 40).code).toBe('hold')
    // too-few wins even when not matured
    expect(v(199, 100, { matured: false, daysToMature: 3 }).code).toBe('too-few')
  })

  it('too-few for d0 <= 0 (no bounds)', () => {
    expect(v(0, 0)).toMatchObject({ code: 'too-few', rate: null, lower: null, upper: null })
  })

  it('GO / HOLD / NO-GO at n=500 against 7.5%', () => {
    expect(v(500, 60).code).toBe('go')
    expect(v(500, 40).code).toBe('hold')
    expect(v(500, 10).code).toBe('no-go')
  })

  // Wilson 90% at n=500 vs the 7.5% bar: smallest GO count and largest NO-GO
  // count (the spec review's Wald figures are 49 and 28).
  it('exact Wilson thresholds at n=500', () => {
    expect(v(500, 47).code).toBe('hold')
    expect(v(500, 48).code).toBe('go')
    expect(v(500, 27).code).toBe('no-go')
    expect(v(500, 28).code).toBe('hold')
  })

  it('maturing passes daysToMature through', () => {
    expect(v(600, 60, { matured: false, daysToMature: 4 })).toMatchObject({ code: 'maturing', daysToMature: 4 })
    expect(v(600, 60).daysToMature).toBeNull()
  })

  it('no early NO-GO while maturing (returns can still grow)', () => {
    expect(v(300, 3, { matured: false, daysToMature: 2 }).code).toBe('maturing')
    expect(v(600, 3, { matured: false, daysToMature: 2 }).code).toBe('maturing')
  })

  it('provisional (200-499, matured) turns NO-GO early when upper < bar', () => {
    expect(v(300, 3).code).toBe('no-go')
    expect(v(300, 30).code).toBe('provisional')
    // a strong provisional arm never reaches GO below FULL
    expect(v(499, 200).code).toBe('provisional')
  })

  it('uses the supplied bar (organic bar)', () => {
    expect(v(500, 60, { bar: 0.12 }).code).toBe('hold')
    expect(v(500, 60, { bar: 0.05 }).code).toBe('go')
  })
})
