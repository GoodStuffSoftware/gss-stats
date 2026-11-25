// The fold decision of the Transactions toolbar row and the pop-out placement (plain numbers, no DOM).
import { describe, expect, it } from 'vitest'
import { foldLevel, popPlacement, type FoldSizes } from './toolbarFold'

const SIZES: FoldSizes = { lead: 120, leadFolded: 80, searchMin: 120, filters: 90, gap: 8 }
// Inline needs 120 + 8 + 120 + 8 + 90 = 346; the lead folded needs 80 + 8 + 120 + 8 + 90 = 306.

describe('foldLevel', () => {
  it('keeps everything inline while it all fits, including exactly at the limit', () => {
    expect(foldLevel(1920, SIZES)).toBe(0)
    expect(foldLevel(346, SIZES)).toBe(0)
  })
  it('folds the lead into a dropdown first', () => {
    expect(foldLevel(345, SIZES)).toBe(1)
    expect(foldLevel(306, SIZES)).toBe(1)
  })
  it('then folds the search into an icon, and stays folded however narrow it gets', () => {
    expect(foldLevel(305, SIZES)).toBe(2)
    expect(foldLevel(240, SIZES)).toBe(2)
    expect(foldLevel(0, SIZES)).toBe(2)
  })
  it('with no lead, only the search folds', () => {
    const none = { ...SIZES, lead: 0, leadFolded: 0 } // needs 120 + 8 + 90 = 218
    expect(foldLevel(218, none)).toBe(0)
    expect(foldLevel(217, none)).toBe(2)
  })
  it('a longer Filters label (a count) folds sooner', () => {
    expect(foldLevel(346, { ...SIZES, filters: 110 })).toBe(1)
  })
  it('never goes back to a lower level than the room allows as it grows', () => {
    const levels = [200, 300, 310, 350, 500].map((w) => foldLevel(w, SIZES))
    expect(levels).toEqual([2, 2, 1, 0, 0])
  })
})

describe('popPlacement', () => {
  it('opens below with the room under the row, less the gap and the screen edge', () => {
    expect(popPlacement(40, 80, 800)).toEqual({ side: 'below', maxHeight: 800 - 80 - 4 - 8 })
  })
  it('opens above when the room below is small and there is more above', () => {
    expect(popPlacement(400, 440, 500)).toEqual({ side: 'above', maxHeight: 400 - 4 - 8 })
  })
  it('stays below when there is more room below than above, however short', () => {
    // A ~280px tall screen with the row near the top: 168px below, 88px above.
    expect(popPlacement(100, 136, 280)).toEqual({ side: 'below', maxHeight: 280 - 136 - 4 - 8 })
  })
  it('never offers less than the floor', () => {
    expect(popPlacement(10, 30, 60).maxHeight).toBe(96)
  })
})
