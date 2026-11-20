import { describe, expect, it, vi } from 'vitest'
import { PALETTE, activationMarkerIndex, arcLabelsPlugin, contrastRatio, inkOn, playActivationMarkerPlugin } from './charts'
import { PLAY_TRACKING_ACTIVATION_DATE_ET, PLAY_TRACKING_MARKER_LABEL } from './popupEvents'

// Part A: the pop-up trend chart's "tracking starts" boundary — see lib/popupEvents.ts
// TRACKING_ACTIVATION_DATE_ET and the comment on activationMarkerIndex itself.
describe('activationMarkerIndex', () => {
  const rows = [{ key: { date: '2026-09-18' } }, { key: { date: '2026-09-19' } }, { key: { date: '2026-09-20' } }, { key: { date: '2026-09-21' } }]

  it('returns -1 when there is no activation date at all', () => {
    expect(activationMarkerIndex(rows, null)).toBe(-1)
  })

  it('finds the first index on/after the activation date', () => {
    expect(activationMarkerIndex(rows, '2026-09-20')).toBe(2)
    expect(activationMarkerIndex(rows, '2026-09-19')).toBe(1)
  })

  it('activation date matching the very first plotted day → boundary at 0 (nothing pre-activation)', () => {
    expect(activationMarkerIndex(rows, '2026-09-18')).toBe(0)
  })

  it('activation date before every plotted day → boundary at 0', () => {
    expect(activationMarkerIndex(rows, '2026-01-01')).toBe(0)
  })

  it('activation date after every plotted day → boundary at rows.length (everything is still pre-activation)', () => {
    expect(activationMarkerIndex(rows, '2099-01-01')).toBe(rows.length)
  })

  it('empty rows → boundary at 0 (an empty range is trivially not pre-activation)', () => {
    expect(activationMarkerIndex([], '2026-09-20')).toBe(0)
  })

  // activationMarkerIndex is generic on its activationDateEt argument — the SAME function
  // locates the Play/Android boundary (PLAY_TRACKING_ACTIVATION_DATE_ET, a submission day,
  // not a live date — see lib/popupEvents.ts) without needing a second implementation.
  it('also locates the boundary for PLAY_TRACKING_ACTIVATION_DATE_ET, both null and set', () => {
    expect(activationMarkerIndex(rows, null)).toBe(-1)
    expect(activationMarkerIndex(rows, PLAY_TRACKING_ACTIVATION_DATE_ET)).toBe(activationMarkerIndex(rows, '2026-09-26'))
    expect(activationMarkerIndex(rows, PLAY_TRACKING_ACTIVATION_DATE_ET)).toBe(rows.length) // 2026-09-26 is after every plotted day here
  })
})

// Part 3 (v0.3.2): the Play/Android twin of the web "tracking starts" marker — draws
// PLAY_TRACKING_MARKER_LABEL, not "tracking starts" (a submission day is not an arrival —
// see lib/popupEvents.ts PLAY_TRACKING_ACTIVATION_DATE_ET), and uses its own Chart.js
// plugin id so it can coexist with the web marker on the same chart.
describe('playActivationMarkerPlugin', () => {
  function fakeChart(index: number) {
    const calls: { fillText: [string, number, number][] } = { fillText: [] }
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn(() => ({ width: 10 })),
      fillText: vi.fn((text: string, x: number, y: number) => calls.fillText.push([text, x, y])),
      strokeStyle: '',
      lineWidth: 0,
      fillStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
    }
    const scales = { x: { getPixelForValue: (i: number) => i * 10 } }
    const chartArea = { left: 0, right: 100, top: 0, bottom: 50 }
    return { chart: { ctx, chartArea, scales }, calls }
  }

  it('has its own plugin id, distinct from the web marker', () => {
    expect(playActivationMarkerPlugin(1).id).toBe('playActivationMarker')
  })

  it('draws PLAY_TRACKING_MARKER_LABEL (not "tracking starts") when the boundary is in view', () => {
    const { chart, calls } = fakeChart(5)
    playActivationMarkerPlugin(5).afterDraw(chart as any)
    expect(calls.fillText).toHaveLength(1)
    expect(calls.fillText[0][0]).toBe(PLAY_TRACKING_MARKER_LABEL)
  })

  it('draws nothing when the boundary falls outside the visible chart area', () => {
    const { chart, calls } = fakeChart(-1) // getPixelForValue(-1) * 10 = -10, left of chartArea.left
    playActivationMarkerPlugin(-1).afterDraw(chart as any)
    expect(calls.fillText).toHaveLength(0)
  })
})

// On-slice labels (the pie's name / amount / share text; the nested doughnut shares the plugin).
describe('arcLabelsPlugin', () => {
  // One arc of `span` radians on a ring 60..100 around (100,100); every character is 5 px wide.
  function draw(span: number, items: { name: string; sub: string | string[] }[], fill: string, look?: Parameters<typeof arcLabelsPlugin>[1]) {
    const texts: string[] = []
    const inks: string[] = []
    const ctx: any = {
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      measureText: (t: string) => ({ width: t.length * 5 }),
      fillText: (t: string) => {
        texts.push(t)
        inks.push(ctx.fillStyle)
      },
    }
    const arc = { startAngle: 0, endAngle: span, x: 100, y: 100, innerRadius: 60, outerRadius: 100 }
    const chart: any = { ctx, data: { datasets: [{ backgroundColor: [fill] }] }, getDatasetMeta: () => ({ data: [arc] }) }
    arcLabelsPlugin({ 0: items }, look).afterDatasetsDraw(chart)
    return { text: texts.join(''), inks }
  }

  it('draws the name and the first alternative that fits; none when the name does not fit', () => {
    const subs = ['$1,200.00 · 25%', '$1,200.00', '25%']
    const roomy = draw(1.2, [{ name: 'Rent', sub: subs }], '#6A994E')
    expect(roomy.text).toContain('Rent')
    expect(roomy.text).toContain('$1,200.00')
    // a narrower arc: the long alternatives do not fit, the short one does
    const narrow = draw(0.5, [{ name: 'Rent', sub: subs }], '#6A994E')
    expect(narrow.text).toContain('Rent')
    expect(narrow.text).toContain('25%')
    expect(narrow.text).not.toContain('$')
    // too narrow for the name: nothing at all (no orphan number)
    expect(draw(0.25, [{ name: 'A long merchant name', sub: ['25%'] }], '#6A994E').text).toBe('')
  })

  it('a sliver (under about 11 degrees) is never labelled', () => {
    expect(draw(0.15, [{ name: 'A', sub: ['1%'] }], '#6A994E').text).toBe('')
  })

  it('a plain string sub still works (the nested doughnut passes one)', () => {
    expect(draw(1.2, [{ name: 'Ab', sub: '5 · 9%' }], '#6A994E').text).toContain('9%')
  })

  it('the default ink is the nested doughnut brightness cut; bestContrast picks by WCAG contrast', () => {
    expect(draw(1.2, [{ name: 'Ab', sub: [] }], '#8A8278').inks[0]).toBe('#ffffff')
    expect(draw(1.2, [{ name: 'Ab', sub: [] }], '#E9C46A', { bestContrast: true }).inks[0]).toBe(inkOn('#E9C46A'))
  })
})

describe('inkOn', () => {
  it('reaches readable contrast on every palette colour, the folded-bucket grey and both extremes', () => {
    for (const fill of [...PALETTE, '#C9C3B8', '#FFFFFF', '#000000', '#808080']) {
      expect(contrastRatio(fill, inkOn(fill))).toBeGreaterThanOrEqual(4.4)
    }
  })

  it('is dark on light fills and white on dark ones', () => {
    expect(inkOn('#E9C46A')).not.toBe('#FFFFFF')
    expect(inkOn('#211C18')).toBe('#FFFFFF')
  })
})
