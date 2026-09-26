import { describe, expect, it, vi } from 'vitest'
import { activationMarkerIndex, playActivationMarkerPlugin } from './charts'
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
