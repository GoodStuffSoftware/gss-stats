import { describe, expect, it } from 'vitest'
import { layoutMarkerLabels, markerPaddingExtra, markerRowsUsed, settlePaddingExtra } from './markerLayout'

// A simple, deterministic stand-in for ctx.measureText(text).width — 6px per character,
// close enough to the real '600 10px Inter' font to exercise collision logic without a canvas.
const measure = (s: string) => s.length * 6

describe('layoutMarkerLabels (owner-reported regression, 2026-09-26: overlapping release labels)', () => {
  it('places well-separated markers on the same row, unchanged', () => {
    const out = layoutMarkerLabels(
      [
        { x: 10, label: 'v1.86.40' },
        { x: 300, label: 'v1.87.0' },
      ],
      { measureWidth: measure, areaLeft: 0, areaRight: 500 },
    )
    expect(out).toHaveLength(2)
    expect(out[0].y).toBe(0)
    expect(out[1].y).toBe(0)
    expect(out.map((p) => p.label)).toEqual(['v1.86.40', 'v1.87.0'])
  })

  it('the two same-day flight 3 releases (v1.99.1 and v1.99.2 share an ET day, hence an x) stagger instead of overlapping', () => {
    const out = layoutMarkerLabels(
      [
        { x: 400, label: 'v1.99.1' },
        { x: 400, label: 'v1.99.2' },
      ],
      { measureWidth: measure, areaLeft: 0, areaRight: 500 },
    )
    expect(out).toHaveLength(2)
    expect(out[0].y).not.toBe(out[1].y)
  })

  it('two markers close together stagger into different rows instead of overlapping', () => {
    // 'v1.86.40' is 8 chars = 48px wide; placed at x=10 it occupies roughly [14, 62]. A second
    // marker at x=20 would start well inside that span on the same row.
    const out = layoutMarkerLabels(
      [
        { x: 10, label: 'v1.86.40' },
        { x: 20, label: 'v1.87.0' },
      ],
      { measureWidth: measure, areaLeft: 0, areaRight: 500 },
    )
    expect(out).toHaveLength(2)
    expect(out[0].y).not.toBe(out[1].y) // staggered into separate rows — never the same row
  })

  it('drops a label (keeping the marker line elsewhere) once every row is exhausted, rather than drawing overlapping text', () => {
    // Four markers stacked at nearly the same x, only 3 rows available -> the 4th must be
    // dropped from the result rather than doubling up on an already-occupied row.
    const markers = [
      { x: 10, label: 'v1.0.0' },
      { x: 12, label: 'v1.0.1' },
      { x: 14, label: 'v1.0.2' },
      { x: 16, label: 'v1.0.3' },
    ]
    const out = layoutMarkerLabels(markers, { measureWidth: measure, areaLeft: 0, areaRight: 500, maxRows: 3 })
    expect(out.length).toBeLessThanOrEqual(3)
    // No two placed labels share a row with overlapping x-ranges.
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (out[i].y === out[j].y) {
          const [a, b] = out[i].x < out[j].x ? [out[i], out[j]] : [out[j], out[i]]
          expect(b.x).toBeGreaterThanOrEqual(a.x + measure(a.label))
        }
      }
    }
  })

  it('truncates a label wider than the whole chart area instead of letting it run off', () => {
    const out = layoutMarkerLabels([{ x: 10, label: 'a very long custom release note that will not fit' }], {
      measureWidth: measure,
      areaLeft: 0,
      areaRight: 80, // room for ~13 chars minus padding
    })
    expect(out).toHaveLength(1)
    expect(out[0].label.endsWith('…')).toBe(true)
    expect(out[0].label.length).toBeLessThan('a very long custom release note that will not fit'.length)
  })

  it('sorts by x regardless of input order', () => {
    const out = layoutMarkerLabels(
      [
        { x: 300, label: 'later' },
        { x: 10, label: 'earlier' },
      ],
      { measureWidth: measure, areaLeft: 0, areaRight: 500 },
    )
    expect(out.map((p) => p.label)).toEqual(['earlier', 'later'])
  })

  it('empty input yields no placements', () => {
    expect(layoutMarkerLabels([], { measureWidth: measure, areaLeft: 0, areaRight: 500 })).toEqual([])
  })
})

describe('stacking instead of dropping (phone width: 2 base rows, 10 px each)', () => {
  const stack = { measureWidth: measure, areaLeft: 0, areaRight: 300, maxRows: Infinity, rowHeight: 10 }

  it('labels that do not collide keep one row and ask for no extra padding', () => {
    const out = layoutMarkerLabels([{ x: 10, label: 'v1.0' }, { x: 150, label: 'v2.0' }], stack)
    expect(out.map((p) => p.y)).toEqual([0, 0])
    expect(markerRowsUsed(out, 10)).toBe(1)
    expect(markerPaddingExtra(out, 2, 10)).toBe(0)
  })

  it('two colliding labels stack into a second row; the base two rows add no padding', () => {
    const out = layoutMarkerLabels([{ x: 10, label: 'First-50 days end' }, { x: 20, label: 'v1.108.0' }], stack)
    expect(out.map((p) => p.y)).toEqual([0, 10])
    expect(markerPaddingExtra(out, 2, 10)).toBe(0)
  })

  it('three colliding labels open a third row (none dropped) and the padding grows by exactly that row', () => {
    const out = layoutMarkerLabels([{ x: 10, label: 'aaaaaaaa' }, { x: 20, label: 'bbbbbbbb' }, { x: 30, label: 'cccccccc' }], stack)
    expect(out.map((p) => p.label)).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'])
    expect(out.map((p) => p.y)).toEqual([0, 10, 20])
    expect(markerRowsUsed(out, 10)).toBe(3)
    expect(markerPaddingExtra(out, 2, 10)).toBe(10)
    expect(markerPaddingExtra(out, 3, 10)).toBe(0) // the desktop base of three rows already holds them
  })

  it('five labels on one crowded spot all stay: five rows, three rows of extra padding at phone width', () => {
    const crowd = ['a', 'b', 'c', 'd', 'e'].map((c, i) => ({ x: 10 + i, label: c.repeat(8) }))
    const out = layoutMarkerLabels(crowd, stack)
    expect(out).toHaveLength(5)
    expect(markerPaddingExtra(out, 2, 10)).toBe(30)
  })

  it('a label near the right edge is pulled left to stay inside, and still stacks when it collides there', () => {
    const out = layoutMarkerLabels([{ x: 250, label: 'v1.100.0' }, { x: 290, label: 'v1.101.0' }], stack)
    expect(out[0].x + measure('v1.100.0')).toBeLessThanOrEqual(298)
    expect(out[1].x + measure('v1.101.0')).toBeLessThanOrEqual(298)
    expect(out[0].y).toBe(0)
    expect(out[1].y).toBe(10)
  })

  it('a desktop-like width gives the layout the three-row cap gave, when it never needed to drop one', () => {
    const wide = [10, 120, 125, 400, 405, 410].map((x, i) => ({ x, label: `v1.${i}.0` }))
    const capped = layoutMarkerLabels(wide, { measureWidth: measure, areaLeft: 0, areaRight: 800, maxRows: 3, rowHeight: 10 })
    const open = layoutMarkerLabels(wide, { measureWidth: measure, areaLeft: 0, areaRight: 800, maxRows: Infinity, rowHeight: 10 })
    expect(open).toEqual(capped)
    expect(markerPaddingExtra(open, 3, 10)).toBe(0)
  })

  it('no labels: no rows, no padding', () => {
    expect(markerRowsUsed([], 10)).toBe(0)
    expect(markerPaddingExtra([], 2, 10)).toBe(0)
  })
})

describe('settlePaddingExtra (the re-layout converges)', () => {
  it('keeps the padding when the labels need what it already has', () => {
    expect(settlePaddingExtra(10, 10, false)).toBe(10)
    expect(settlePaddingExtra(0, 0, true)).toBe(0)
  })
  it('follows the need, up or down, the first time a chart size is laid out', () => {
    expect(settlePaddingExtra(0, 20, false)).toBe(20)
    expect(settlePaddingExtra(20, 0, false)).toBe(0)
  })
  it('once the size has changed it, it may only grow, so a shifted plot cannot flip it back', () => {
    expect(settlePaddingExtra(20, 10, true)).toBe(20)
    expect(settlePaddingExtra(10, 20, true)).toBe(20)
  })
})
