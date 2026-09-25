import { describe, expect, it } from 'vitest'
import {
  CAMPAIGNS,
  campaignById,
  campaignAttributionClause,
  etMidnightUtcMs,
  etFlightRangeMs,
  flightDayIndex,
  isDirectionalDay,
  applyExclusions,
  classifyFunnelPath,
  computeFunnelCounts,
  funnelStepRates,
  FUNNEL_STEP_ORDER,
  FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED,
  ARRIVALS_CAVEAT,
  countryBucket,
  screenWidthBucket,
  costPer,
  parseReturnPath,
  returnVisitRates,
  returnBeaconNotInstrumented,
  sharesReturnTagWith,
  RETURN_BUCKETS,
} from './campaigns'

describe('etMidnightUtcMs / etFlightRangeMs (DST-safe ET date <-> UTC ms)', () => {
  it('EST (winter, UTC-5): ET midnight is 05:00 UTC', () => {
    expect(etMidnightUtcMs('2026-01-15')).toBe(Date.parse('2026-01-15T05:00:00Z'))
  })
  it('EDT (summer, UTC-4): ET midnight is 04:00 UTC', () => {
    expect(etMidnightUtcMs('2026-07-04')).toBe(Date.parse('2026-07-04T04:00:00Z'))
  })
  it('a flight range spans [ET midnight of start, ET midnight of the day AFTER end)', () => {
    const [start, end] = etFlightRangeMs('2026-09-03', '2026-09-09')
    expect(start).toBe(etMidnightUtcMs('2026-09-03'))
    expect(end).toBe(etMidnightUtcMs('2026-09-10'))
    // A hit right at the very start of 09-09 (its ET day) is inside; one at the very start
    // of 09-10 is outside.
    expect(etMidnightUtcMs('2026-09-09')).toBeGreaterThanOrEqual(start)
    expect(etMidnightUtcMs('2026-09-09')).toBeLessThan(end)
    expect(etMidnightUtcMs('2026-09-10')).toBe(end) // exclusive boundary
  })
})

describe('flightDayIndex / isDirectionalDay', () => {
  const retest = campaignById('24279250691')!
  it('day 1 is flightStart, counting up', () => {
    expect(flightDayIndex(retest, '2026-09-26')).toBe(1)
    expect(flightDayIndex(retest, '2026-09-27')).toBe(2)
    expect(flightDayIndex(retest, '2026-10-02')).toBe(7)
  })
  it('null outside the flight window', () => {
    expect(flightDayIndex(retest, '2026-09-25')).toBeNull()
    expect(flightDayIndex(retest, '2026-10-03')).toBeNull()
  })
  it('week 1 (days 1-7) of the retest campaign is directional; nothing else is', () => {
    expect(isDirectionalDay(retest, '2026-09-26')).toBe(true)
    expect(isDirectionalDay(retest, '2026-10-02')).toBe(true)
    expect(isDirectionalDay(retest, '2026-09-25')).toBe(false) // outside the flight entirely
    const flight1 = campaignById('24215315197')!
    expect(isDirectionalDay(flight1, '2026-09-03')).toBe(false) // not the retest campaign
  })
})

describe('campaignAttributionClause (the one function deciding row membership)', () => {
  it('binds every ucValue plus the flight-window ms bounds, in that order', () => {
    const c = campaignById('24279250691')!
    const { sql, binds } = campaignAttributionClause(c)
    expect(sql).toBe('campaign IN (?) AND ts >= ? AND ts < ?')
    expect(binds).toEqual(['sudoku_funnel_retest', etMidnightUtcMs('2026-09-26'), etMidnightUtcMs('2026-10-03')])
  })
  it('flight 1 and flight 2 share every uc value but get DIFFERENT ms windows', () => {
    const f1 = campaignById('24215315197')!
    const f2 = campaignById('24234347705')!
    expect(f1.ucValues).toEqual(expect.arrayContaining(['sudoku_tired_of_ads']))
    expect(f2.ucValues).toEqual(expect.arrayContaining(['sudoku_tired_of_ads']))
    const c1 = campaignAttributionClause(f1)
    const c2 = campaignAttributionClause(f2)
    expect(c1.binds.slice(-2)).not.toEqual(c2.binds.slice(-2)) // disjoint windows
    expect(etMidnightUtcMs(f1.flightEnd) < etMidnightUtcMs(f2.flightStart) || f1.flightEnd < f2.flightStart).toBe(true)
  })
  it('every campaign in the registry is resolvable by id', () => {
    for (const c of CAMPAIGNS) expect(campaignById(c.id)).toBe(c)
  })
})

describe('applyExclusions (single-row predicates, never a cross-row join)', () => {
  it('builds one NOT(...) fragment per rule, binding the documented values', () => {
    const w: string[] = []
    const b: unknown[] = []
    applyExclusions(w, b)
    expect(w).toHaveLength(3)
    expect(w.join(' AND ')).toContain('medium = ?')
    expect(w.join(' AND ')).toContain('region = ? AND city = ? AND org = ?')
    expect(w.join(' AND ')).toContain("region = ? AND screenw IN (412, 444, 852)")
    expect(b).toEqual([
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
    ])
  })
})

describe('classifyFunnelPath / computeFunnelCounts / funnelStepRates', () => {
  it('maps the documented paths to their funnel step', () => {
    expect(classifyFunnelPath('/game')).toBe('played')
    expect(classifyFunnelPath('/auth/success/google')).toBe('authSuccess')
    expect(classifyFunnelPath('/auth/success/apple')).toBe('authSuccess')
    expect(classifyFunnelPath('/signin-prompt/placement')).toBe('ask')
    expect(classifyFunnelPath('/signin-prompt/streak')).toBe('ask')
    expect(classifyFunnelPath('/promo-first50/shown')).toBe('ask')
    expect(classifyFunnelPath('/signin-prompt/accept')).toBe('accept')
    expect(classifyFunnelPath('/promo-first50/accept')).toBe('accept')
    expect(classifyFunnelPath('/install/prompt/android')).toBe('installPrompt')
    expect(classifyFunnelPath('/install/prompt/ios')).toBe('installPrompt')
    expect(classifyFunnelPath('/install/pwa-installed')).toBe('install')
    expect(classifyFunnelPath('/install/standalone-detected')).toBe('install')
    expect(classifyFunnelPath('/install/play-detected')).toBe('install')
  })
  it('never maps anything to "completed" — no matching path exists anywhere in D1', () => {
    for (const p of ['/game', '/', '/stats', '/settings', '/complete', '/game/complete', '/win']) {
      expect(classifyFunnelPath(p)).not.toBe('completed')
    }
    expect(FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED.has('completed')).toBe(true)
  })
  it('excludes /install/platforms/* (explicit task-brief exclusion) — classifyPopupPath gives it kind "platformList"', () => {
    expect(classifyFunnelPath('/install/platforms/web')).toBeNull()
    expect(classifyFunnelPath('/install/platforms/play')).toBeNull()
  })
  it('an unrecognized path is not part of the funnel', () => {
    expect(classifyFunnelPath('/settings')).toBeNull()
    expect(classifyFunnelPath('/about')).toBeNull()
  })

  it('computeFunnelCounts: arrivals = the passed-in taggedArrivals (visitor=\'new\' only), NOT a sum of the rows', () => {
    const rows = [
      { path: '/game', count: 100 }, // includes returning-visitor hits too — see DEFINITION FIX
      { path: '/', count: 20 },
      { path: '/signin-prompt/placement', count: 10 },
      { path: '/signin-prompt/accept', count: 4 },
      { path: '/settings', count: 3 },
    ]
    const counts = computeFunnelCounts(rows, 353) // 353 = the real tagged-arrivals count for sudoku_tired_of_ads
    expect(counts.arrivals).toBe(353) // NOT 100+20+10+4+3=137 — that would be tagged HITS, a different number
    expect(counts.played).toBe(100)
    expect(counts.ask).toBe(10)
    expect(counts.accept).toBe(4)
    expect(counts.completed).toBe(0) // never instrumented, but the raw count is still 0 here
    expect(counts.authSuccess).toBe(0)
  })

  it('funnelStepRates: a real rate once both steps are instrumented and the denominator is non-zero', () => {
    const counts = computeFunnelCounts(
      [
        { path: '/game', count: 100 },
        { path: '/signin-prompt/placement', count: 10 },
        { path: '/signin-prompt/accept', count: 4 },
      ],
      120, // an arrivals count independent of the path rows above, per the DEFINITION FIX
    )
    const rates = funnelStepRates(counts)
    expect(counts.arrivals).toBe(120)
    expect(rates.played).toBeCloseTo(100 / 120, 10)
  })
  it('funnelStepRates: "completed" and its successor "ask" are always null (not-instrumented propagates forward one step)', () => {
    const counts = computeFunnelCounts([{ path: '/game', count: 100 }], 100)
    const rates = funnelStepRates(counts)
    expect(rates.completed).toBeNull() // completed itself is not instrumented
    expect(rates.ask).toBeNull() // ask/completed would divide by the not-instrumented step
  })
  it('funnelStepRates: null (not NaN) for a zero-denominator step that IS instrumented', () => {
    const counts = computeFunnelCounts([], 0) // nothing at all
    const rates = funnelStepRates(counts)
    expect(rates.played).toBeNull()
  })
})

describe('countryBucket / screenWidthBucket', () => {
  it('buckets US and CA on their own, everything else as "other"', () => {
    expect(countryBucket('US')).toBe('US')
    expect(countryBucket('CA')).toBe('CA')
    expect(countryBucket('GB')).toBe('other')
    expect(countryBucket('')).toBe('other')
  })
  it('buckets screen width into small/medium/large', () => {
    expect(screenWidthBucket(360)).toBe('small (<480)')
    expect(screenWidthBucket(0)).toBe('small (<480)')
    expect(screenWidthBucket(800)).toBe('medium (480-1024)')
    expect(screenWidthBucket(1920)).toBe('large (>1024)')
    expect(screenWidthBucket(1024)).toBe('medium (480-1024)') // boundary is inclusive on the medium side
    expect(screenWidthBucket(1025)).toBe('large (>1024)')
  })
})

describe('costPer (spend table — "—"/null until filled in)', () => {
  it('null when spend is unset, regardless of count', () => {
    expect(costPer(null, 100)).toBeNull()
    expect(costPer(null, 0)).toBeNull()
  })
  it('null (never NaN/Infinity) for a real spend but zero count', () => {
    expect(costPer(50, 0)).toBeNull()
  })
  it('a real cost per unit once both are set', () => {
    expect(costPer(100, 50)).toBe(2)
  })
})

describe('parseReturnPath / returnVisitRates (on-device return beacon, v1.90.0)', () => {
  it('parses every documented bucket', () => {
    for (const bucket of RETURN_BUCKETS) {
      expect(parseReturnPath(`/return/sudoku_funnel_retest/${bucket}`)).toEqual({ uc: 'sudoku_funnel_retest', bucket })
    }
  })
  it('rejects an unknown bucket or a malformed path', () => {
    expect(parseReturnPath('/return/sudoku_funnel_retest/d99')).toBeNull()
    expect(parseReturnPath('/return/sudoku_funnel_retest')).toBeNull()
    expect(parseReturnPath('/return/')).toBeNull()
    expect(parseReturnPath('/returning/x/d0')).toBeNull()
    expect(parseReturnPath('/game')).toBeNull()
  })
  it('rate per bucket = bucket / d0, null for a zero d0', () => {
    const counts = { d0: 50, d1: 20, 'd2-7': 15, 'd8-14': 8, 'd15-30': 4, 'd31-60': 1 } as const
    const rates = returnVisitRates(counts as any)
    expect(rates.d1).toBeCloseTo(20 / 50, 10)
    expect(rates['d31-60']).toBeCloseTo(1 / 50, 10)
    const zero = returnVisitRates({ d0: 0, d1: 0, 'd2-7': 0, 'd8-14': 0, 'd15-30': 0, 'd31-60': 0 } as any)
    expect(zero.d1).toBeNull()
    expect(zero['d15-30']).toBeNull()
  })
  it('returnBeaconNotInstrumented: true for any flight that ended before TRACKING_ACTIVATION_DATE_ET (currently null → always true)', () => {
    for (const c of CAMPAIGNS) expect(returnBeaconNotInstrumented(c)).toBe(true)
  })
  it('sharesReturnTagWith: flights 1 & 2 point at each other; the retest campaign has no match', () => {
    const f1 = campaignById('24215315197')!
    const f2 = campaignById('24234347705')!
    const retest = campaignById('24279250691')!
    expect(sharesReturnTagWith(f1)?.id).toBe(f2.id)
    expect(sharesReturnTagWith(f2)?.id).toBe(f1.id)
    expect(sharesReturnTagWith(retest)).toBeNull()
  })
})

describe('ARRIVALS_CAVEAT', () => {
  it('names the specific floor (pre-existing users clicking an ad count as returning)', () => {
    expect(ARRIVALS_CAVEAT).toMatch(/returning/i)
    expect(ARRIVALS_CAVEAT).toMatch(/floor/i)
  })
})

describe('FUNNEL_STEP_ORDER', () => {
  it('starts with arrivals and has one entry per FunnelStepKey', () => {
    expect(FUNNEL_STEP_ORDER[0]).toBe('arrivals')
    expect(new Set(FUNNEL_STEP_ORDER).size).toBe(FUNNEL_STEP_ORDER.length)
  })
})
