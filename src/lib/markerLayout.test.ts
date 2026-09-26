import { describe, expect, it } from 'vitest'
import { layoutMarkerLabels } from './markerLayout'

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
