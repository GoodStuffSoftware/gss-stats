import { describe, expect, it } from 'vitest'
import {
  addEtDays,
  etDayElapsedMs,
  sameTimeWindowMs,
  last7DatesBefore,
  computeDelta,
  buildKpiTile,
  notYetTrackingTile,
  campaignsFlightingOn,
  returnBeaconLiveToday,
  releaseComparisonWindows,
} from './overview'
import { etMidnightUtcMs } from './campaigns'
import { TRACKING_ACTIVATION_DATE_ET } from './popupEvents'

describe('addEtDays', () => {
  it('shifts forward and backward across a month boundary', () => {
    expect(addEtDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addEtDays('2026-10-01', -1)).toBe('2026-09-30')
  })
  it('zero is a no-op', () => {
    expect(addEtDays('2026-09-25', 0)).toBe('2026-09-25')
  })
})

describe('etDayElapsedMs / sameTimeWindowMs', () => {
  it('elapsed time is 0 right at ET midnight, and grows through the day', () => {
    const midnight = etMidnightUtcMs('2026-09-25')
    expect(etDayElapsedMs(midnight)).toBe(0)
    expect(etDayElapsedMs(midnight + 3_600_000)).toBe(3_600_000)
  })
  it('sameTimeWindowMs reproduces the same elapsed span on a different ET date', () => {
    const elapsed = 5 * 3_600_000 // 5 hours into the day
    const [start, end] = sameTimeWindowMs('2026-09-24', elapsed)
    expect(start).toBe(etMidnightUtcMs('2026-09-24'))
    expect(end - start).toBe(elapsed)
  })
})

describe('last7DatesBefore', () => {
  it('returns the 7 ET dates strictly before, most recent first', () => {
    const dates = last7DatesBefore('2026-09-25')
    expect(dates).toEqual(['2026-09-24', '2026-09-23', '2026-09-22', '2026-09-21', '2026-09-20', '2026-09-19', '2026-09-18'])
    expect(dates).not.toContain('2026-09-25')
  })
})

describe('computeDelta', () => {
  it('a real delta and percent change for a non-zero comparison', () => {
    expect(computeDelta(120, 100)).toEqual({ delta: 20, deltaPct: 0.2 })
    expect(computeDelta(80, 100)).toEqual({ delta: -20, deltaPct: -0.2 })
  })
  it('deltaPct is null (never Infinity) for a zero comparison, but delta is still real', () => {
    expect(computeDelta(5, 0)).toEqual({ delta: 5, deltaPct: null })
    expect(computeDelta(0, 0)).toEqual({ delta: 0, deltaPct: null })
  })
})

describe('buildKpiTile / notYetTrackingTile', () => {
  it('a tracked metric carries real numbers and both deltas', () => {
    const tile = buildKpiTile('pv', 'Page views', 42, 30, 35)
    expect(tile.notYetTracking).toBe(false)
    expect(tile.today).toBe(42)
    expect(tile.vsYesterday).toEqual({ delta: 12, deltaPct: 0.4 })
    expect(tile.vsAvg7?.delta).toBeCloseTo(7, 10)
  })
  it('an uninstrumented metric has no numbers at all — never a fake 0', () => {
    const tile = notYetTrackingTile('completed', 'Games completed')
    expect(tile.notYetTracking).toBe(true)
    expect(tile.today).toBeNull()
    expect(tile.vsYesterday).toBeNull()
    expect(tile.vsAvg7).toBeNull()
  })
})

describe('campaignsFlightingOn', () => {
  it('finds campaign 3 flighting on its own flight days, nobody outside any flight', () => {
    expect(campaignsFlightingOn('2026-09-26').map((c) => c.id)).toContain('24279250691')
    expect(campaignsFlightingOn('2026-09-05').map((c) => c.id)).toContain('24215315197')
    expect(campaignsFlightingOn('2026-01-01')).toEqual([])
  })
})

describe('returnBeaconLiveToday', () => {
  it('matches TRACKING_ACTIVATION_DATE_ET being set (currently null -> false)', () => {
    expect(returnBeaconLiveToday()).toBe(TRACKING_ACTIVATION_DATE_ET !== null)
  })
})

describe('releaseComparisonWindows', () => {
  it('equal-length before/after windows capped by available history', () => {
    // 10 days of history before the release, 3 days of "now" after it -> capped to 3.
    const nowMs = etMidnightUtcMs('2026-09-13') // 3 days after the release
    const win = releaseComparisonWindows('2026-09-10', '2026-08-31', nowMs) // 10 days before available
    expect(win).not.toBeNull()
    expect(win!.days).toBe(3)
    expect(win!.after[1] - win!.after[0]).toBe(win!.before[1] - win!.before[0])
    expect(win!.before[1]).toBe(etMidnightUtcMs('2026-09-10')) // before window ends exactly at release
    expect(win!.after[0]).toBe(etMidnightUtcMs('2026-09-10')) // after window starts exactly at release
  })
  it('null when there is no history on one side yet (e.g. release IS the first hit)', () => {
    const nowMs = etMidnightUtcMs('2026-09-15')
    expect(releaseComparisonWindows('2026-07-13', '2026-07-13', nowMs)).toBeNull()
  })
  it('null when the release is today (no "after" history yet)', () => {
    const nowMs = etMidnightUtcMs('2026-09-25')
    expect(releaseComparisonWindows('2026-09-25', '2026-07-13', nowMs)).toBeNull()
  })
})
