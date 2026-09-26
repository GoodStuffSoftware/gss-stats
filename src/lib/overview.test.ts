import { describe, expect, it } from 'vitest'
import {
  addEtDays,
  etDayElapsedMs,
  sameTimeWindowMs,
  siteWindowClause,
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

describe('etDayElapsedMs / sameTimeWindowMs (DST-safe — HIGH review finding, 2026-09-25)', () => {
  it('elapsed time is 0 right at ET midnight, and grows through the day', () => {
    const midnight = etMidnightUtcMs('2026-09-25')
    expect(etDayElapsedMs(midnight)).toBe(0)
    expect(etDayElapsedMs(midnight + 3_600_000)).toBe(3_600_000)
  })
  it('sameTimeWindowMs reproduces the same wall-clock time on a different ET date, same UTC offset', () => {
    const nowMs = etMidnightUtcMs('2026-09-25') + 5 * 3_600_000 // 5am ET; September has no DST transition
    const [start, end] = sameTimeWindowMs('2026-09-24', nowMs)
    expect(start).toBe(etMidnightUtcMs('2026-09-24'))
    expect(end).toBe(etMidnightUtcMs('2026-09-24') + 5 * 3_600_000)
  })
  // The bug this replaces: computing ONE elapsed millisecond span from today's own midnight
  // and reusing it for every comparison day, which is only correct when today and the
  // comparison day share the same UTC/ET offset — wrong for 6 days after every DST
  // transition, whenever the transition date itself falls inside "yesterday" or the 7-day
  // lookback (functions/api/overview.ts's vsYesterday/vsAvg7 deltas).
  it('fall-back transition (2026-11-01) inside the "yesterday" window: today 3pm EST vs the transition day itself', () => {
    const nowMs = Date.parse('2026-11-02T20:00:00Z') // 3pm EST — Nov 2 is fully EST (post-fallback)
    const [, end] = sameTimeWindowMs('2026-11-01', nowMs)
    expect(end).toBe(Date.parse('2026-11-01T20:00:00Z')) // 3pm EST on the transition day itself
    expect(end).not.toBe(Date.parse('2026-11-01T19:00:00Z')) // the old bug: an hour short (landed at 2pm)
  })
  it('spring-forward transition (2026-03-08) inside the 7-day lookback: today 3pm EDT vs the transition day itself', () => {
    const nowMs = Date.parse('2026-03-09T19:00:00Z') // 3pm EDT — Mar 9 is fully EDT (post-springforward)
    const [, end] = sameTimeWindowMs('2026-03-08', nowMs)
    expect(end).toBe(Date.parse('2026-03-08T19:00:00Z')) // 3pm EDT on the transition day itself
    expect(end).not.toBe(Date.parse('2026-03-08T20:00:00Z')) // the old bug: an hour over (landed at 4pm)
  })
  it('last7DatesBefore can put a DST transition date inside the 7-day lookback — confirms the scenario above is reachable', () => {
    expect(last7DatesBefore('2026-11-07')).toContain('2026-11-01')
    expect(last7DatesBefore('2026-03-14')).toContain('2026-03-08')
  })
})

describe('siteWindowClause (shared WHERE-builder for KPI/timeline/release-panel — HIGH review finding, 2026-09-25)', () => {
  it('includes the site + ts-range predicates, all 3 exclusion rules, and the pre-fix install-gap drop', () => {
    const { sql, binds } = siteWindowClause(['bestsudoku-web', 'bestsudoku'], 1000, 2000)
    expect(sql).toBe(
      'site IN (?, ?) AND ts >= ? AND ts < ? AND NOT (medium = ? OR campaign LIKE ?) AND NOT (region = ? AND city = ? AND org = ? AND device = ? AND os = ? AND browser = ? AND screenw = ?) AND NOT (region = ? AND screenw IN (412, 444, 852)) AND NOT (path IN (?, ?) AND ts < ?)',
    )
    expect(binds).toEqual([
      'bestsudoku-web',
      'bestsudoku',
      1000,
      2000,
      'lifecycle',
      'email_%',
      'Virginia',
      'Reston',
      'Verizon Business',
      'desktop',
      'Windows',
      'Chrome',
      1280,
      'North Carolina',
      '/popup-outcome/install-prompt/installed',
      '/install/pwa-installed',
      Date.parse('2026-09-26T16:26:36Z'),
    ])
  })
  it('functions/api/overview.ts builds its KPI, timeline, and release-panel queries from this one function — a query section can no longer omit exclusions without changing this shared builder', () => {
    // Regression guard for the review finding: 123 of 2,913 production bestsudoku* rows
    // matched exclusion criteria and leaked through 3 of the 4 query sections because each
    // built its own WHERE clause by hand. Every WHERE-clause fragment this function returns
    // must include the exclusion NOTs — asserted exactly above.
    const { sql } = siteWindowClause(['bestsudoku-web'], 0, 1)
    expect(sql).toContain('NOT (medium = ? OR campaign LIKE ?)')
    expect(sql).toContain('NOT (region = ? AND city = ? AND org = ?')
    expect(sql).toContain('NOT (region = ? AND screenw IN (412, 444, 852))')
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
  it('finds the Android-launch flight on its own flight days, nobody outside any confirmed flight', () => {
    expect(campaignsFlightingOn('2026-09-05').map((c) => c.id)).toContain('24215315197')
    expect(campaignsFlightingOn('2026-01-01')).toEqual([])
  })
  it('the retest is now confirmed and serving (2026-09-26..10-02) — it shows as flighting within that window, not outside it', () => {
    // Corrected 2026-09-26 (ads session): flightStart is no longer null/pending — see
    // lib/campaigns.ts CAMPAIGNS. Previously this asserted the opposite (never flighting
    // while pending); see git history for that version.
    expect(campaignsFlightingOn('2026-09-26').map((c) => c.id)).toContain('24279250691')
    expect(campaignsFlightingOn('2026-10-02').map((c) => c.id)).toContain('24279250691')
    expect(campaignsFlightingOn('2026-09-25').map((c) => c.id)).not.toContain('24279250691')
    expect(campaignsFlightingOn('2026-10-03').map((c) => c.id)).not.toContain('24279250691')
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
