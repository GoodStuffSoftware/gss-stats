import { describe, expect, it } from 'vitest'
import {
  classifyPopupPath,
  isPopupEventPath,
  POPUP_EVENT_PREFIXES,
  etDateFromMs,
  computeRate,
  aggregatePopupRows,
  coarseCount,
  detailedCount,
  dayCounts,
  detailedBreakdown,
  computePopupRate,
  POPUP_RATE_SPECS,
  isPreActivation,
  measuredCoarseCount,
  measuredDetailedCount,
  measuredDetailedBreakdown,
  TRACKING_ACTIVATION_DATE_ET,
  type HourPathCount,
} from './popupEvents'

describe('classifyPopupPath', () => {
  it('signin-prompt: /<reason> is shown, /accept and /dismiss are responses', () => {
    expect(classifyPopupPath('/signin-prompt/placement')).toEqual({ family: 'signin-prompt', kind: 'shown', extra: 'placement' })
    expect(classifyPopupPath('/signin-prompt/streak')).toEqual({ family: 'signin-prompt', kind: 'shown', extra: 'streak' })
    expect(classifyPopupPath('/signin-prompt/accept')).toEqual({ family: 'signin-prompt', kind: 'accept' })
    expect(classifyPopupPath('/signin-prompt/dismiss')).toEqual({ family: 'signin-prompt', kind: 'dismiss' })
  })

  it('signin-eligible: earned/capped/unearned only', () => {
    expect(classifyPopupPath('/signin-eligible/earned')).toEqual({ family: 'signin-eligible', kind: 'earned' })
    expect(classifyPopupPath('/signin-eligible/capped')).toEqual({ family: 'signin-eligible', kind: 'capped' })
    expect(classifyPopupPath('/signin-eligible/unearned')).toEqual({ family: 'signin-eligible', kind: 'unearned' })
    expect(classifyPopupPath('/signin-eligible/other')).toBeNull()
  })

  it('promo-first50: shown/accept/dismiss are literal segments', () => {
    expect(classifyPopupPath('/promo-first50/shown')).toEqual({ family: 'promo-first50', kind: 'shown' })
    expect(classifyPopupPath('/promo-first50/accept')).toEqual({ family: 'promo-first50', kind: 'accept' })
    expect(classifyPopupPath('/promo-first50/dismiss')).toEqual({ family: 'promo-first50', kind: 'dismiss' })
  })

  it('first50-congrats: shown/ack/close map to shown/accept/dismiss', () => {
    expect(classifyPopupPath('/first50-congrats/shown')).toEqual({ family: 'first50-congrats', kind: 'shown' })
    expect(classifyPopupPath('/first50-congrats/ack')).toEqual({ family: 'first50-congrats', kind: 'accept' })
    expect(classifyPopupPath('/first50-congrats/close')).toEqual({ family: 'first50-congrats', kind: 'dismiss' })
  })

  it('upsell: /<kind>/<reason>, reason required', () => {
    expect(classifyPopupPath('/upsell/shown/cadence')).toEqual({ family: 'upsell', kind: 'shown', extra: 'cadence' })
    expect(classifyPopupPath('/upsell/accept/daily-locked')).toEqual({ family: 'upsell', kind: 'accept', extra: 'daily-locked' })
    expect(classifyPopupPath('/upsell/dismiss/settings-upgrade')).toEqual({ family: 'upsell', kind: 'dismiss', extra: 'settings-upgrade' })
    expect(classifyPopupPath('/upsell/shown')).toBeNull() // no reason
  })

  it('install: shown (by platform), accept-like, dismiss-like, real outcomes, platform list', () => {
    expect(classifyPopupPath('/install/prompt/android')).toEqual({ family: 'install', kind: 'shown', extra: 'android' })
    expect(classifyPopupPath('/install/prompt/ios')).toEqual({ family: 'install', kind: 'shown', extra: 'ios' })
    expect(classifyPopupPath('/install/prompt/desktop')).toEqual({ family: 'install', kind: 'shown', extra: 'desktop' })
    expect(classifyPopupPath('/install/play')).toEqual({ family: 'install', kind: 'accept', extra: 'play' })
    expect(classifyPopupPath('/install/pwa-accept')).toEqual({ family: 'install', kind: 'accept', extra: 'pwa' })
    expect(classifyPopupPath('/install/app-store')).toEqual({ family: 'install', kind: 'accept', extra: 'app-store' })
    expect(classifyPopupPath('/install/pwa-decline')).toEqual({ family: 'install', kind: 'dismiss', extra: 'pwa' })
    expect(classifyPopupPath('/install/prompt/dismiss')).toEqual({ family: 'install', kind: 'dismiss', extra: 'dismiss' })
    expect(classifyPopupPath('/install/prompt/dismiss-forever')).toEqual({ family: 'install', kind: 'dismiss', extra: 'dismiss-forever' })
    expect(classifyPopupPath('/install/prompt/have-it')).toEqual({ family: 'install', kind: 'dismiss', extra: 'have-it' })
    expect(classifyPopupPath('/install/pwa-installed')).toEqual({ family: 'install', kind: 'outcome', extra: 'pwa-installed' })
    expect(classifyPopupPath('/install/standalone-detected')).toEqual({ family: 'install', kind: 'outcome', extra: 'standalone-detected' })
    expect(classifyPopupPath('/install/play-detected')).toEqual({ family: 'install', kind: 'outcome', extra: 'play-detected' })
    expect(classifyPopupPath('/install/platforms/web')).toEqual({ family: 'install', kind: 'platformList', extra: 'web' })
    expect(classifyPopupPath('/install/platforms/play')).toEqual({ family: 'install', kind: 'platformList', extra: 'play' })
    expect(classifyPopupPath('/install/platforms/app-store')).toEqual({ family: 'install', kind: 'platformList', extra: 'app-store' })
    expect(classifyPopupPath('/install/unknown-thing')).toBeNull()
  })

  it('popup-outcome: dynamic <popup> name, fixed outcome vocabulary', () => {
    expect(classifyPopupPath('/popup-outcome/signin-prompt/signed-in')).toEqual({ family: 'popup-outcome:signin-prompt', kind: 'signed-in' })
    expect(classifyPopupPath('/popup-outcome/upsell/installed')).toEqual({ family: 'popup-outcome:upsell', kind: 'installed' })
    expect(classifyPopupPath('/popup-outcome/install/returned')).toEqual({ family: 'popup-outcome:install', kind: 'returned' })
    expect(classifyPopupPath('/popup-outcome/install/bogus')).toBeNull()
  })

  it('rejects paths outside every popup family, and ordinary page paths', () => {
    expect(classifyPopupPath('/')).toBeNull()
    expect(classifyPopupPath('/play')).toBeNull()
    expect(classifyPopupPath('')).toBeNull()
    expect(classifyPopupPath('/signin-promptx/shown')).toBeNull() // must not prefix-match a look-alike path
  })
})

describe('isPopupEventPath (geo.ts/sites.ts exclusion)', () => {
  it('matches every popup prefix, exactly and as a subpath', () => {
    for (const p of POPUP_EVENT_PREFIXES) {
      expect(isPopupEventPath(p)).toBe(true)
      expect(isPopupEventPath(`${p}/x`)).toBe(true)
    }
  })
  it('does not match an ordinary screen path, or a look-alike prefix', () => {
    expect(isPopupEventPath('/')).toBe(false)
    expect(isPopupEventPath('/play')).toBe(false)
    expect(isPopupEventPath('/installer')).toBe(false) // must not prefix-match "/install" loosely
  })
})

describe('etDateFromMs (US-Eastern day bucketing, DST-safe — hard requirement #3)', () => {
  it('buckets an ordinary EST instant to the correct ET calendar day', () => {
    expect(etDateFromMs(Date.parse('2026-01-15T12:00:00Z'))).toBe('2026-01-15')
  })
  it('rolls a late-UTC instant back to the previous ET day (EST, UTC-5)', () => {
    expect(etDateFromMs(Date.parse('2026-01-01T04:30:00Z'))).toBe('2025-12-31')
  })
  it('crosses the spring-forward transition (2026-03-08) without a fixed offset', () => {
    expect(etDateFromMs(Date.parse('2026-03-08T00:00:00Z'))).toBe('2026-03-07')
    expect(etDateFromMs(Date.parse('2026-03-08T12:00:00Z'))).toBe('2026-03-08')
  })
  it('the ET midnight boundary sits at a different UTC hour in EDT vs EST — proves DST is honored, not a fixed offset', () => {
    // July = EDT (UTC-4): ET midnight is 04:00 UTC.
    expect(etDateFromMs(Date.parse('2026-07-04T03:59:00Z'))).toBe('2026-07-03')
    expect(etDateFromMs(Date.parse('2026-07-04T04:01:00Z'))).toBe('2026-07-04')
    // January = EST (UTC-5): ET midnight is 05:00 UTC. A fixed -4h offset would get this
    // wrong (it would roll the day over an hour early, at 04:00 UTC).
    expect(etDateFromMs(Date.parse('2026-01-04T04:59:00Z'))).toBe('2026-01-03')
    expect(etDateFromMs(Date.parse('2026-01-04T05:01:00Z'))).toBe('2026-01-04')
  })
})

describe('computeRate (hard requirement #4: never NaN/Infinity)', () => {
  it('divides normally', () => {
    expect(computeRate(3, 12)).toBe(0.25)
  })
  it('returns null (not NaN/Infinity) for a zero denominator', () => {
    expect(computeRate(0, 0)).toBeNull()
    expect(computeRate(5, 0)).toBeNull()
  })
  it('a zero numerator with a real denominator is a real 0, not null', () => {
    expect(computeRate(0, 10)).toBe(0)
  })
})

describe('aggregatePopupRows', () => {
  const rows: HourPathCount[] = [
    // Jan 15 2026, two different UTC hours that are still the same ET day (EST, UTC-5).
    { hourStartMs: Date.parse('2026-01-15T14:00:00Z'), path: '/signin-prompt/placement', count: 3 },
    { hourStartMs: Date.parse('2026-01-15T20:00:00Z'), path: '/signin-prompt/streak', count: 2 },
    { hourStartMs: Date.parse('2026-01-15T15:00:00Z'), path: '/signin-prompt/accept', count: 4 },
    { hourStartMs: Date.parse('2026-01-15T15:00:00Z'), path: '/signin-prompt/dismiss', count: 1 },
    // The next ET calendar day entirely (same UTC hour-of-day, one day later).
    { hourStartMs: Date.parse('2026-01-16T14:00:00Z'), path: '/signin-prompt/placement', count: 5 },
    { hourStartMs: Date.parse('2026-01-15T13:00:00Z'), path: '/upsell/shown/cadence', count: 7 },
    { hourStartMs: Date.parse('2026-01-15T13:00:00Z'), path: '/upsell/shown/limit', count: 2 },
    { hourStartMs: Date.parse('2026-01-15T13:00:00Z'), path: '/upsell/accept/cadence', count: 1 },
    { hourStartMs: Date.parse('2026-01-15T13:00:00Z'), path: '/signin-eligible/earned', count: 9 },
    { hourStartMs: Date.parse('2026-01-15T13:00:00Z'), path: '/signin-eligible/capped', count: 1 },
    { hourStartMs: Date.parse('2026-01-15T13:00:00Z'), path: '/not-a-popup-path', count: 100 }, // must be ignored
  ]
  const agg = aggregatePopupRows(rows)
  // Everything in `rows` is on/before 2026-01-16 — treat it all as MEASURED for the
  // coarse/detailed/rate assertions below by activating tracking on the fixture's first
  // day. Activation gating itself gets its own describe block further down.
  const measuredAgg = aggregatePopupRows(rows, '2026-01-15')

  it('sums shown across reasons into the coarse family+kind total', () => {
    expect(coarseCount(agg, 'signin-prompt', 'shown')).toBe(3 + 2 + 5) // includes the next-day row
    expect(coarseCount(agg, 'signin-prompt', 'accept')).toBe(4)
    expect(coarseCount(agg, 'signin-prompt', 'dismiss')).toBe(1)
  })

  it('keeps a per-reason detailed breakdown', () => {
    expect(detailedCount(agg, 'signin-prompt', 'shown', 'placement')).toBe(3 + 5)
    expect(detailedCount(agg, 'signin-prompt', 'shown', 'streak')).toBe(2)
    expect(new Map(detailedBreakdown(agg, 'upsell', 'shown'))).toEqual(new Map([['cadence', 7], ['limit', 2]]))
  })

  it('buckets shown by ET day, split across the day boundary', () => {
    const byDay = new Map(dayCounts(agg, 'signin-prompt', 'shown'))
    expect(byDay.get('2026-01-15')).toBe(5) // 3 + 2, both same ET day
    expect(byDay.get('2026-01-16')).toBe(5)
  })

  it('ignores rows whose path is not a popup event', () => {
    expect(coarseCount(agg, 'not-a-popup-path', 'shown')).toBe(0)
    expect(coarseCount(agg, 'signin-eligible', 'earned')).toBe(9)
    expect(coarseCount(agg, 'signin-eligible', 'capped')).toBe(1)
    expect(coarseCount(agg, 'signin-eligible', 'unearned')).toBe(0)
  })

  it('computePopupRate: tap rate, eligibility rate, and null before any outcome data (once measured)', () => {
    const tap = POPUP_RATE_SPECS.find((s) => s.key === 'signin-prompt:tap')!
    expect(computePopupRate(measuredAgg, tap)).toBeCloseTo(4 / 10, 10) // 4 accepts / 10 shown

    const elig = POPUP_RATE_SPECS.find((s) => s.key === 'signin-eligible:rate')!
    expect(computePopupRate(measuredAgg, elig)).toBeCloseTo(9 / 10, 10) // earned / (earned+capped+unearned)

    // No /popup-outcome rows in this fixture, but 'shown' (the denominator) is non-zero,
    // so this is a real 0 — "we showed it and got zero sign-ins" — not "no data yet".
    const outcome = POPUP_RATE_SPECS.find((s) => s.key === 'signin-prompt:outcome:signed-in')!
    expect(computePopupRate(measuredAgg, outcome)).toBe(0)

    // A popup with NO shown events at all (zero denominator) is the "no data yet" case.
    const noShown = POPUP_RATE_SPECS.find((s) => s.key === 'install:tap')!
    expect(computePopupRate(measuredAgg, noShown)).toBeNull()
  })

  it('an empty aggregate renders every rate as null, never 0/NaN', () => {
    const empty = aggregatePopupRows([])
    for (const spec of POPUP_RATE_SPECS) expect(computePopupRate(empty, spec)).toBeNull()
  })
})

describe('activation gating (Part A hard requirement: "before activation is unmeasured, not zero")', () => {
  it('isPreActivation: null activation date means EVERYTHING is pre-activation', () => {
    expect(isPreActivation('2026-01-15', null)).toBe(true)
    expect(isPreActivation('2099-12-31', null)).toBe(true) // even a date far in the future
  })
  it('isPreActivation: compares ET calendar dates lexically against a real activation date', () => {
    expect(isPreActivation('2026-01-14', '2026-01-15')).toBe(true)
    expect(isPreActivation('2026-01-15', '2026-01-15')).toBe(false) // activation day itself counts as measured
    expect(isPreActivation('2026-01-16', '2026-01-15')).toBe(false)
  })

  // The known landmine this whole feature exists to defuse: one player's uncapped-
  // placement-bug reproduction on 2026-09-19 produced 22 /signin-prompt/dismiss, 21
  // /signin-prompt/placement (shown), 1 /signin-prompt/streak (shown), and 0 accepts —
  // a real, non-null tap rate of 0/22 = 0% if it were ever allowed to compute.
  const bugRows: HourPathCount[] = [
    { hourStartMs: Date.parse('2026-09-19T14:00:00Z'), path: '/signin-prompt/placement', count: 21 },
    { hourStartMs: Date.parse('2026-09-19T14:00:00Z'), path: '/signin-prompt/streak', count: 1 },
    { hourStartMs: Date.parse('2026-09-19T15:00:00Z'), path: '/signin-prompt/dismiss', count: 22 },
  ]
  const tap = POPUP_RATE_SPECS.find((s) => s.key === 'signin-prompt:tap')!

  it('a real pre-activation denominator never produces a real 0%/NaN rate — "—" (null) instead', () => {
    const agg = aggregatePopupRows(bugRows, null) // activation not shipped yet
    expect(measuredCoarseCount(agg, 'signin-prompt', 'shown')).toBe(0) // gated out, not 22
    expect(computePopupRate(agg, tap)).toBeNull() // NOT 0
  })
  it('the same rows, once activation is set to a date AFTER them, still gate out', () => {
    const agg = aggregatePopupRows(bugRows, '2026-09-20')
    expect(computePopupRate(agg, tap)).toBeNull()
  })
  it('the same rows, once activation is set to their own ET day (or earlier), are measured', () => {
    const agg = aggregatePopupRows(bugRows, '2026-09-19')
    expect(computePopupRate(agg, tap)).toBe(0) // now a REAL 0% — measured, and genuinely zero accepts
  })
  it('using the module default (TRACKING_ACTIVATION_DATE_ET) with no override is still null today', () => {
    expect(TRACKING_ACTIVATION_DATE_ET).toBeNull()
    const agg = aggregatePopupRows(bugRows)
    expect(computePopupRate(agg, tap)).toBeNull()
  })

  it('measuredDetailedCount / measuredDetailedBreakdown mirror the same gating for per-reason counts', () => {
    const rows: HourPathCount[] = [
      { hourStartMs: Date.parse('2026-01-10T13:00:00Z'), path: '/upsell/shown/cadence', count: 5 }, // pre
      { hourStartMs: Date.parse('2026-01-20T13:00:00Z'), path: '/upsell/shown/cadence', count: 3 }, // post
      { hourStartMs: Date.parse('2026-01-20T13:00:00Z'), path: '/upsell/shown/limit', count: 2 }, // post
    ]
    const agg = aggregatePopupRows(rows, '2026-01-15')
    expect(measuredDetailedCount(agg, 'upsell', 'shown', 'cadence')).toBe(3) // not 8
    expect(new Map(measuredDetailedBreakdown(agg, 'upsell', 'shown'))).toEqual(
      new Map([['cadence', 3], ['limit', 2]]),
    )
    // The unfiltered twin still sees everything — 'measured' is additive, not a replacement.
    expect(detailedCount(agg, 'upsell', 'shown', 'cadence')).toBe(8)
  })

  it('day-boundary split: only the ET day on/after activation is measured, the earlier one is not', () => {
    const rows: HourPathCount[] = [
      { hourStartMs: Date.parse('2026-01-15T20:00:00Z'), path: '/signin-prompt/accept', count: 4 }, // pre
      { hourStartMs: Date.parse('2026-01-16T20:00:00Z'), path: '/signin-prompt/accept', count: 6 }, // post
    ]
    const agg = aggregatePopupRows(rows, '2026-01-16')
    expect(coarseCount(agg, 'signin-prompt', 'accept')).toBe(10) // full history unaffected
    expect(measuredCoarseCount(agg, 'signin-prompt', 'accept')).toBe(6) // only the measured day
  })
})
