import { describe, expect, it } from 'vitest'
import { activationMarkerIndex } from './charts'

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
})
