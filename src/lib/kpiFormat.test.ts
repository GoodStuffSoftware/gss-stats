import { describe, expect, it } from 'vitest'
import { fmtCount, kpiComparisonGate } from './kpiFormat'
import { addEtDays } from './overview'
import { GAME_COMPLETE_LIVE_AT, INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS, TRACKING_ACTIVATION_DATE_ET, etDateFromMs } from './popupEvents'

describe('fmtCount', () => {
  it('fmtCount', () => {
    expect(fmtCount(1234)).toBe('1,234')
    expect(fmtCount(null)).toBe('—')
    expect(fmtCount(undefined)).toBe('—')
  })
})

describe('kpiComparisonGate (coordinator addition, 2026-09-26 — go-live-boundary gating)', () => {
  // GAME_COMPLETE_LIVE_AT is 2026-09-26T19:43:02Z -> ET date 2026-09-26. Both constants are
  // typed `number | null` upstream (pre-launch they can still be unset) — this suite asserts
  // the gating behavior that applies once they're set, same as popupEvents.test.ts does for
  // the constants themselves.
  if (GAME_COMPLETE_LIVE_AT == null || INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS == null) {
    it.skip('go-live instants are not set in this build — gating tests skipped', () => {})
    return
  }
  const gameCompleteEt = etDateFromMs(GAME_COMPLETE_LIVE_AT)
  const installFixEt = etDateFromMs(INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS)

  it('a metric with no go-live entry (e.g. page views) is never gated', () => {
    const g = kpiComparisonGate('pageviews', gameCompleteEt)
    expect(g).toEqual({ hideVsYesterday: false, hideVsAvg7: false, newToday: false })
  })

  it('"Games completed" on its own go-live day: both comparisons hidden, "new today"', () => {
    const g = kpiComparisonGate('completed', gameCompleteEt)
    expect(g.hideVsYesterday).toBe(true)
    expect(g.hideVsAvg7).toBe(true)
    expect(g.newToday).toBe(true)
  })

  it('"Games completed" a week after go-live: both comparisons are valid again', () => {
    const todayEt = addEtDays(gameCompleteEt, 8) // well past both the 1-day and 7-day windows
    const g = kpiComparisonGate('completed', todayEt)
    expect(g).toEqual({ hideVsYesterday: false, hideVsAvg7: false, newToday: false })
  })

  it('"Installs" the day after the fix: vs-yesterday still crosses the boundary, vs-7d-avg does too', () => {
    const dayAfter = addEtDays(installFixEt, 1)
    const g = kpiComparisonGate('install', dayAfter)
    // yesterday (= installFixEt) is the fix day itself -> still partly pre-fix -> hidden
    expect(g.hideVsYesterday).toBe(true)
    expect(g.hideVsAvg7).toBe(true)
  })

  it('"Installs" 3 days after the fix: vs-yesterday is clean, vs-7d-avg still spans the fix day', () => {
    const todayEt = addEtDays(installFixEt, 3)
    const g = kpiComparisonGate('install', todayEt)
    expect(g.hideVsYesterday).toBe(false) // yesterday = installFixEt + 2, fully post-fix
    expect(g.hideVsAvg7).toBe(true) // the 7-day window's earliest day is installFixEt - 4, still pre-fix
  })

  it('"Installs" 8+ days after the fix: both comparisons are clean', () => {
    const todayEt = addEtDays(installFixEt, 8)
    const g = kpiComparisonGate('install', todayEt)
    expect(g).toEqual({ hideVsYesterday: false, hideVsAvg7: false, newToday: false })
  })

  it('pop-up tiles gate on TRACKING_ACTIVATION_DATE_ET when it is set', () => {
    if (!TRACKING_ACTIVATION_DATE_ET) return // module constant, currently set in this repo
    const g = kpiComparisonGate('popupShown', TRACKING_ACTIVATION_DATE_ET)
    expect(g.newToday).toBe(true)
    const gAccept = kpiComparisonGate('popupAccept', TRACKING_ACTIVATION_DATE_ET)
    expect(gAccept.newToday).toBe(true)
    const gReturns = kpiComparisonGate('returns', TRACKING_ACTIVATION_DATE_ET)
    expect(gReturns.newToday).toBe(true)
  })

  it('a campaign "Tagged arrivals" tile gates on its flight start (attribution starts there; ADR 0003)', () => {
    // US+CA web retest: flightStart 2026-09-26, attribution from 12:00 ET that day.
    const day1 = kpiComparisonGate('arrivals-24279250691', '2026-09-26')
    expect(day1).toEqual({ hideVsYesterday: true, hideVsAvg7: true, newToday: true })
    const day2 = kpiComparisonGate('arrivals-24279250691', '2026-09-27')
    expect(day2.hideVsYesterday).toBe(true) // yesterday = the partial start day
    expect(day2.hideVsAvg7).toBe(true)
    const day9 = kpiComparisonGate('arrivals-24279250691', '2026-10-04')
    expect(day9).toEqual({ hideVsYesterday: false, hideVsAvg7: false, newToday: false })
    // An unknown campaign id is never gated (no flight to gate on).
    expect(kpiComparisonGate('arrivals-000', '2026-09-26')).toEqual({ hideVsYesterday: false, hideVsAvg7: false, newToday: false })
  })

  it('an empty todayEt never gates (defensive default, e.g. data not loaded yet)', () => {
    expect(kpiComparisonGate('completed', '')).toEqual({ hideVsYesterday: false, hideVsAvg7: false, newToday: false })
  })
})
