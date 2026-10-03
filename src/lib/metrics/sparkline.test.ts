import { describe, expect, it } from 'vitest'
import { sparklineGeometry } from './sparkline'

describe('sparklineGeometry', () => {
  it('no points: nothing to draw', () => {
    expect(sparklineGeometry([])).toBeNull()
  })
  it('consecutive days make one polyline, oldest left, the scale starting at zero', () => {
    const g = sparklineGeometry([
      { day: '2026-10-01', value: 0 },
      { day: '2026-10-02', value: 5 },
      { day: '2026-10-03', value: 10 },
    ])!
    expect(g.lines).toHaveLength(1)
    expect(g.dots).toEqual([])
    expect(g.max).toBe(10)
    const pts = g.lines[0].split(' ').map((p) => p.split(',').map(Number))
    expect(pts[0][0]).toBeLessThan(pts[2][0]) // left to right
    expect(pts[0][1]).toBeGreaterThan(pts[2][1]) // a larger value is higher (smaller y)
    expect(g.firstDay).toBe('2026-10-01')
    expect(g.lastDay).toBe('2026-10-03')
  })
  it('a missing day (a gap, not a zero) breaks the line instead of dipping to zero', () => {
    const g = sparklineGeometry([
      { day: '2026-10-01', value: 4 },
      { day: '2026-10-02', value: 6 },
      { day: '2026-10-04', value: 5 },
      { day: '2026-10-05', value: 7 },
    ])!
    expect(g.lines).toHaveLength(2)
    expect(g.dots).toEqual([])
  })
  it('an isolated measured day, or a one-day series, is a dot', () => {
    const one = sparklineGeometry([{ day: '2026-10-01', value: 3 }])!
    expect(one.lines).toEqual([])
    expect(one.dots).toHaveLength(1)
    const mixed = sparklineGeometry([
      { day: '2026-10-01', value: 1 },
      { day: '2026-10-02', value: 2 },
      { day: '2026-10-05', value: 2 },
    ])!
    expect(mixed.lines).toHaveLength(1)
    expect(mixed.dots).toHaveLength(1)
  })
  it('an all-zero series sits on the baseline, never NaN', () => {
    const g = sparklineGeometry([
      { day: '2026-10-01', value: 0 },
      { day: '2026-10-02', value: 0 },
    ])!
    expect(g.lines[0]).not.toMatch(/NaN/)
    const ys = g.lines[0].split(' ').map((p) => Number(p.split(',')[1]))
    expect(new Set(ys).size).toBe(1)
  })
  it('a DST boundary does not skip or double a day on the axis', () => {
    const g = sparklineGeometry([
      { day: '2026-10-31', value: 1 },
      { day: '2026-11-01', value: 2 },
      { day: '2026-11-02', value: 3 },
    ])!
    expect(g.lines).toHaveLength(1)
  })
  it('ignores a point with a non-finite value or a malformed day', () => {
    const g = sparklineGeometry([
      { day: 'nope', value: 1 },
      { day: '2026-10-01', value: Number.NaN },
      { day: '2026-10-02', value: 2 },
    ])!
    expect(g.lines).toEqual([])
    expect(g.dots).toHaveLength(1)
  })
})
