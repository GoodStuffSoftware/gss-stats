import { describe, expect, it } from 'vitest'
import {
  CAMPAIGNS,
  campaignById,
  campaignAttributionClause,
  campaignAttributionStartMs,
  etMidnightUtcMs,
  etTimeUtcMs,
  etFlightRangeMs,
  flightDayIndex,
  isDirectionalDay,
  applyExclusions,
  classifyFunnelPath,
  isGameCompleteDeferredPath,
  computeFunnelCounts,
  funnelStepRates,
  FUNNEL_STEP_ORDER,
  FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED,
  ARRIVALS_CAVEAT,
  countryBucket,
  costPer,
  parseReturnPath,
  returnVisitRates,
  returnBeaconNotInstrumented,
  sharesReturnTagWith,
  RETURN_BUCKETS,
  CAMPAIGN_SPEND,
  CAMPAIGN_DAILY_SPEND,
  COMPLETED_PROXY_PATH_PREFIX,
  isRawInstallSignal,
  isInstallPromptInstalled,
  isAuthSuccessPath,
  gameCompleteNotInstrumented,
  RAW_INSTALL_SIGNALS_LABEL,
  VALID_FUNNEL_RATE_STEPS,
  parseGameCompletePath,
  type CampaignFlight,
} from './campaigns'
import { funnelStepLabel } from './notes'
import { INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS } from './popupEvents'

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

describe('etTimeUtcMs (DST-safe ET date + clock time <-> UTC ms — general form of etMidnightUtcMs)', () => {
  it('EST (winter, UTC-5): noon ET is 17:00 UTC', () => {
    expect(etTimeUtcMs('2026-01-15', '12:00')).toBe(Date.parse('2026-01-15T17:00:00Z'))
  })
  it('EDT (summer, UTC-4): noon ET is 16:00 UTC', () => {
    expect(etTimeUtcMs('2026-07-04', '12:00')).toBe(Date.parse('2026-07-04T16:00:00Z'))
  })
  it('agrees with etMidnightUtcMs at 00:00', () => {
    expect(etTimeUtcMs('2026-09-26', '00:00')).toBe(etMidnightUtcMs('2026-09-26'))
  })
  it('11:59 vs 12:00 ET boundary — the retest\'s ad-schedule cutoff (EDT, 2026-09-26)', () => {
    const at1159 = etTimeUtcMs('2026-09-26', '11:59')
    const at1200 = etTimeUtcMs('2026-09-26', '12:00')
    expect(at1200 - at1159).toBe(60_000) // exactly one minute apart
    expect(at1159).toBe(Date.parse('2026-09-26T15:59:00Z')) // EDT = UTC-4
    expect(at1200).toBe(Date.parse('2026-09-26T16:00:00Z'))
  })
})

describe('flightDayIndex / isDirectionalDay', () => {
  // Corrected 2026-09-26 (ads session): the retest is now confirmed and serving —
  // flightStart = '2026-09-26', flightEnd = '2026-10-02'. Previously flightStart was left
  // null/pending; see git history for that version of this describe block.
  const retest = campaignById('24279250691')!
  it('the retest\'s flightStart is confirmed (no longer pending)', () => {
    expect(retest.flightStart).toBe('2026-09-26')
    expect(retest.flightEnd).toBe('2026-10-02')
  })
  it('day 1 is flightStart, counting up', () => {
    expect(flightDayIndex(retest, '2026-09-26')).toBe(1)
    expect(flightDayIndex(retest, '2026-09-27')).toBe(2)
    expect(flightDayIndex(retest, '2026-10-02')).toBe(7)
    expect(flightDayIndex(retest, '2026-09-25')).toBeNull()
    expect(flightDayIndex(retest, '2026-10-03')).toBeNull()
  })
  it('week 1 (days 1-7) of the retest campaign is directional; nothing outside its flight is', () => {
    expect(isDirectionalDay(retest, '2026-09-26')).toBe(true)
    expect(isDirectionalDay(retest, '2026-10-02')).toBe(true)
    expect(isDirectionalDay(retest, '2026-09-25')).toBe(false) // outside the flight entirely
    const flight1 = campaignById('24215315197')!
    expect(isDirectionalDay(flight1, '2026-09-03')).toBe(false) // not the retest campaign
  })
  it('a still-pending flight (simulated) has no flight day at all', () => {
    const pending = { ...retest, flightStart: null }
    expect(flightDayIndex(pending, '2026-09-26')).toBeNull()
    expect(isDirectionalDay(pending, '2026-09-26')).toBe(false)
  })
})

describe('campaignAttributionClause (the one function deciding row membership)', () => {
  it('a confirmed campaign binds every ucValue plus a lower ts bound only — NO upper bound', () => {
    const c = campaignById('24215315197')! // Android launch, flightStart = 2026-09-02
    const { sql, binds } = campaignAttributionClause(c)
    expect(sql).toBe(`campaign IN (${c.ucValues.map(() => '?').join(', ')}) AND ts >= ?`)
    expect(binds).toEqual([...c.ucValues, etMidnightUtcMs('2026-09-02')])
  })
  it('a pending campaign (flightStart null, simulated) attributes nothing at all', () => {
    const c = { ...campaignById('24279250691')!, flightStart: null }
    const { sql, binds } = campaignAttributionClause(c)
    expect(sql).toBe('campaign IN (?) AND 1 = 0')
    expect(binds).toEqual(['sudoku_funnel_retest'])
  })
  it('the retest (now confirmed, flightStartTimeEt = 12:00) binds the noon-ET cutoff, NOT ET midnight', () => {
    const c = campaignById('24279250691')!
    expect(c.flightStart).toBe('2026-09-26')
    expect(c.flightStartTimeEt).toBe('12:00')
    const { sql, binds } = campaignAttributionClause(c)
    expect(sql).toBe('campaign IN (?) AND ts >= ?')
    expect(binds).toEqual(['sudoku_funnel_retest', etTimeUtcMs('2026-09-26', '12:00')])
    expect(binds[1]).not.toBe(etMidnightUtcMs('2026-09-26')) // the whole point: NOT midnight
  })
  it('matches() is the SAME rule in JS: tag in ucValues AND bucket start at/after the bound (ADR 0003: the KPI arrivals tile uses it)', () => {
    const retest = campaignById('24279250691')!
    const { matches } = campaignAttributionClause(retest)
    const noon = etTimeUtcMs('2026-09-26', '12:00')
    expect(campaignAttributionStartMs(retest)).toBe(noon)
    expect(matches('sudoku_funnel_retest', noon)).toBe(true) // the bound itself is inside
    expect(matches('sudoku_funnel_retest', noon - 60_000)).toBe(false) // 11:59 ET: pre-launch QA
    expect(matches('sudoku_funnel_retest', etMidnightUtcMs('2026-09-26'))).toBe(false) // same day, before noon
    expect(matches('sudoku_funnel_retest', Date.parse('2026-09-23T15:00:00Z'))).toBe(false) // the 09-23 QA rows
    expect(matches('sudoku_tired_of_ads', noon + 3_600_000)).toBe(false) // another campaign's tag
    expect(matches('', noon + 3_600_000)).toBe(false) // untagged
    const android = campaignAttributionClause(campaignById('24215315197')!)
    expect(android.matches('sudoku_tired_of_ads', Date.parse('2026-09-25T12:00:00Z'))).toBe(true) // no upper bound
    expect(android.matches('sudoku_tired_of_ads_test', Date.parse('2026-09-05T12:00:00Z'))).toBe(false) // the QA variant
  })
  it('matches() attributes nothing for a pending flight (flightStart null), like the SQL `1 = 0`', () => {
    const pending = { ...campaignById('24279250691')!, flightStart: null }
    expect(campaignAttributionStartMs(pending)).toBeNull()
    expect(campaignAttributionClause(pending).matches('sudoku_funnel_retest', Date.parse('2026-10-01T18:00:00Z'))).toBe(false)
  })
  it('every attribution bound is a whole minute, so minute buckets are row-exact against matches()', () => {
    for (const c of CAMPAIGNS) {
      const start = campaignAttributionStartMs(c)
      if (start !== null) expect(start % 60_000).toBe(0)
    }
  })
  it('Android launch and Play-direct now use DISJOINT ucValues — no shared tag to split by date', () => {
    const androidLaunch = campaignById('24215315197')!
    const playDirect = campaignById('24234347705')!
    expect(androidLaunch.ucValues).toEqual(expect.arrayContaining(['sudoku_tired_of_ads']))
    expect(androidLaunch.ucValues).not.toContain('sudoku_tired_of_ads_play')
    expect(playDirect.ucValues).toEqual(['sudoku_tired_of_ads_play'])
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
    expect(classifyFunnelPath('/auth/success/email')).toBe('authSuccess')
    // v1.95.5 exact-shape fix: only the two real base providers count — a look-alike
    // provider (never shipped) and the new/existing suffix are NOT authSuccess.
    expect(classifyFunnelPath('/auth/success/apple')).toBeNull()
    expect(classifyFunnelPath('/auth/success/google/new')).toBeNull()
    expect(classifyFunnelPath('/signin-prompt/placement')).toBe('ask')
    expect(classifyFunnelPath('/signin-prompt/streak')).toBe('ask')
    expect(classifyFunnelPath('/promo-first50/shown')).toBe('ask')
    expect(classifyFunnelPath('/signin-prompt/accept')).toBe('accept')
    expect(classifyFunnelPath('/promo-first50/accept')).toBe('accept')
    expect(classifyFunnelPath('/install/prompt/android')).toBe('installPrompt')
    expect(classifyFunnelPath('/install/prompt/ios')).toBe('installPrompt')
    // INSTALL = the deduplicated popup outcome (at most once per showing), 2026-09-26.
    expect(classifyFunnelPath('/popup-outcome/install-prompt/installed')).toBe('install')
  })
  it('raw /install/<outcome> beacons are NOT the install step (one install can fire two of them); they are a secondary "raw signals" figure', () => {
    for (const p of ['/install/pwa-installed', '/install/standalone-detected', '/install/play-detected']) {
      expect(classifyFunnelPath(p)).toBeNull()
      expect(isRawInstallSignal(p)).toBe(true)
    }
    expect(isRawInstallSignal('/install/prompt/android')).toBe(false)
    expect(isRawInstallSignal('/popup-outcome/install-prompt/installed')).toBe(false)
    // the one install predicate the funnel, the overview tile/timeline and the routine share
    expect(isInstallPromptInstalled('/popup-outcome/install-prompt/installed')).toBe(true)
    expect(isInstallPromptInstalled('/install/pwa-installed')).toBe(false)
    expect(isInstallPromptInstalled('/popup-outcome/install-prompt/returned')).toBe(false)
    expect(RAW_INSTALL_SIGNALS_LABEL).toMatch(/can double-count/)
    // other install-prompt outcomes are not an install
    expect(classifyFunnelPath('/popup-outcome/install-prompt/returned')).toBeNull()
    expect(classifyFunnelPath('/popup-outcome/signin-prompt/installed')).toBeNull()
  })
  it('a cross-tab race (pwa-installed + standalone-detected for ONE install) still counts one install', () => {
    const counts = computeFunnelCounts(
      [
        { path: '/install/pwa-installed', count: 1 },
        { path: '/install/standalone-detected', count: 1 },
        { path: '/popup-outcome/install-prompt/installed', count: 1 },
      ],
      0,
    )
    expect(counts.install).toBe(1)
  })
  it('the install fix shipped (v1.95.4, first confirmed post-fix instant 16:26:36Z); the step label is plain, the caveat travels per range', () => {
    expect(INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS).toBe(Date.parse('2026-09-26T16:26:36Z'))
    expect(funnelStepLabel('install')).toBe('Install')
  })
  it('maps /game/complete/... (v1.95.5, live 2026-09-26T19:43:02Z) to "completed"; nothing else is', () => {
    expect(classifyFunnelPath('/game/complete/normal/easy')).toBe('completed')
    expect(classifyFunnelPath('/game/complete/daily/expert')).toBe('completed')
    expect(classifyFunnelPath('/game/complete/normal/unknown')).toBe('completed') // an unrecognized difficulty still counts
    for (const p of ['/game', '/', '/stats', '/settings', '/complete', '/game/complete', '/win']) {
      expect(classifyFunnelPath(p)).not.toBe('completed')
    }
    // FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED is still the pre-go-live/fallback default —
    // see gameCompleteNotInstrumented for the per-flight version that goes live at the instant.
    expect(FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED.has('completed')).toBe(true)
  })
  // best-sudoku card 125: /game/complete-deferred/... is a SIBLING of /game/complete/..., not a
  // sub-path of it — GAME_COMPLETE_PREFIX's startsWith check anchors on the exact '/complete/'
  // segment, so the hyphenated variant can never match and can never be counted as a live
  // "completed" funnel step.
  it('/game/complete-deferred/... is never classified as "completed" (or any other funnel step)', () => {
    expect(classifyFunnelPath('/game/complete-deferred/normal/easy')).toBeNull()
    expect(classifyFunnelPath('/game/complete-deferred/daily/unknown')).toBeNull()
    expect(isGameCompleteDeferredPath('/game/complete-deferred/normal/easy')).toBe(true)
    expect(isGameCompleteDeferredPath('/game/complete/normal/easy')).toBe(false)
  })
  it('gameCompleteNotInstrumented: true for a flight entirely before go-live, false once its window reaches it', () => {
    const base = campaignById('24215315197')! // real flight, closed 2026-09-09 — well before go-live
    const before: CampaignFlight = { ...base, flightEnd: '2026-09-25' }
    const spanning: CampaignFlight = { ...base, flightEnd: '2026-09-26' } // reaches the go-live ET day
    expect(gameCompleteNotInstrumented(before)).toBe(true)
    expect(gameCompleteNotInstrumented(spanning)).toBe(false)
  })
  it('excludes /install/platforms/* (explicit task-brief exclusion) — classifyPopupPath gives it kind "platformList"', () => {
    expect(classifyFunnelPath('/install/platforms/web')).toBeNull()
    expect(classifyFunnelPath('/install/platforms/play')).toBeNull()
  })
  it('an unrecognized path is not part of the funnel', () => {
    expect(classifyFunnelPath('/settings')).toBeNull()
    expect(classifyFunnelPath('/about')).toBeNull()
  })

  it('isAuthSuccessPath: exact base path only — v1.95.5\'s new/existing suffix is NOT a second auth success', () => {
    expect(isAuthSuccessPath('/auth/success/google')).toBe(true)
    expect(isAuthSuccessPath('/auth/success/email')).toBe(true)
    expect(isAuthSuccessPath('/auth/success/google/new')).toBe(false)
    expect(isAuthSuccessPath('/auth/success/email/existing')).toBe(false)
    expect(isAuthSuccessPath('/auth/success/email/unknown')).toBe(false)
    expect(isAuthSuccessPath('/auth/success/apple')).toBe(false) // not a real provider, still not a prefix match
  })
  it('one sign-in fires a base row AND a new/existing suffix row (same event, v1.95.5) — authSuccess counts it once', () => {
    const counts = computeFunnelCounts(
      [
        { path: '/auth/success/email', count: 1 },
        { path: '/auth/success/email/existing', count: 1 },
      ],
      0,
    )
    expect(counts.authSuccess).toBe(1)
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

  // Audit finding (2026-09-26): played/arrivals, completed/played, ask/completed,
  // authSuccess/accept, installPrompt/authSuccess all mix an event-row numerator against an
  // arrivals/other-row denominator with no shared visitor id — not real rates (e.g. "Played a
  // game: 314.7% (1111/353)"). funnelStepRates only ever computes accept/ask and
  // install/(post-fix installPrompt) now — see VALID_FUNNEL_RATE_STEPS.
  it('funnelStepRates: only ever populates accept/ask and install/installPrompt — every other step is absent (plain count only, not even null)', () => {
    const counts = computeFunnelCounts(
      [
        { path: '/game', count: 100 },
        { path: '/signin-prompt/placement', count: 10 },
        { path: '/signin-prompt/accept', count: 4 },
      ],
      120, // an arrivals count independent of the path rows above, per the DEFINITION FIX
    )
    const rates = funnelStepRates(counts)
    expect(Object.keys(rates).sort()).toEqual(['accept', 'install'])
    expect(rates.played).toBeUndefined()
    expect(rates.completed).toBeUndefined()
    expect(rates.ask).toBeUndefined()
    expect(rates.authSuccess).toBeUndefined()
    expect(rates.installPrompt).toBeUndefined()
  })
  it('funnelStepRates: accept/ask is a real rate once both are instrumented and ask is non-zero', () => {
    const counts = computeFunnelCounts(
      [
        { path: '/signin-prompt/placement', count: 10 },
        { path: '/signin-prompt/accept', count: 4 },
      ],
      120,
    )
    const rates = funnelStepRates(counts)
    expect(rates.accept).toBeCloseTo(4 / 10, 10)
  })
  it('funnelStepRates: accept is null when either accept or ask is not instrumented for this flight', () => {
    const counts = computeFunnelCounts([{ path: '/signin-prompt/accept', count: 4 }], 100)
    const rates = funnelStepRates(counts, new Set(['ask']))
    expect(rates.accept).toBeNull()
  })
  it('funnelStepRates: null (not NaN) for a zero-denominator accept/ask that IS instrumented', () => {
    const counts = computeFunnelCounts([], 0) // nothing at all
    const rates = funnelStepRates(counts)
    expect(rates.accept).toBeNull()
  })
  it('funnelStepRates: install uses the POST-FIX installPrompt count as its denominator, not counts.installPrompt', () => {
    const counts = computeFunnelCounts(
      [
        { path: '/install/prompt/android', count: 20 }, // whole-window installPrompt count
        { path: '/popup-outcome/install-prompt/installed', count: 5 },
      ],
      100,
    )
    expect(counts.installPrompt).toBe(20)
    // Only 8 of the 20 prompts were shown post-fix — the real denominator for this rate.
    const rates = funnelStepRates(counts, undefined, 8)
    expect(rates.install).toBeCloseTo(5 / 8, 10)
  })
  it('funnelStepRates: install is null when the post-fix installPrompt count is not provided', () => {
    const counts = computeFunnelCounts([{ path: '/popup-outcome/install-prompt/installed', count: 5 }], 100)
    const rates = funnelStepRates(counts)
    expect(rates.install).toBeNull()
  })
  it('funnelStepRates: install is null when install or installPrompt is not instrumented for this flight', () => {
    const counts = computeFunnelCounts([{ path: '/popup-outcome/install-prompt/installed', count: 5 }], 100)
    const rates = funnelStepRates(counts, new Set(['installPrompt']), 8)
    expect(rates.install).toBeNull()
  })
})

describe('countryBucket', () => {
  it('buckets US and CA on their own, everything else as "other"', () => {
    expect(countryBucket('US')).toBe('US')
    expect(countryBucket('CA')).toBe('CA')
    expect(countryBucket('GB')).toBe('other')
    expect(countryBucket('')).toBe('other')
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

describe('CAMPAIGN_SPEND / CAMPAIGN_DAILY_SPEND (Google Ads API, 2026-09-25)', () => {
  it('Android launch and Play-direct have real totals; the retest has none yet', () => {
    expect(CAMPAIGN_SPEND['24215315197']).toBe(124.47)
    expect(CAMPAIGN_SPEND['24234347705']).toBe(75.17)
    expect(CAMPAIGN_SPEND['24279250691']).toBeNull()
  })
  it('daily lines are provenance for the totals above', () => {
    const androidDaily = Object.values(CAMPAIGN_DAILY_SPEND['24215315197'])
    const playDaily = Object.values(CAMPAIGN_DAILY_SPEND['24234347705'])
    expect(androidDaily.reduce((a, b) => a + b, 0)).toBeCloseTo(124.46, 2) // 1c under Google's own total — see the doc comment
    expect(playDaily.reduce((a, b) => a + b, 0)).toBeCloseTo(75.17, 2)
  })
  it('cost per arrival is now computable for Android launch (real arrivals, real spend)', () => {
    expect(costPer(CAMPAIGN_SPEND['24215315197'], 353)).toBeCloseTo(124.47 / 353, 5)
  })
})

describe('parseGameCompletePath (mode × difficulty breakdown, distinct from classifyFunnelPath\'s prefix-only "completed" match)', () => {
  it('parses the two segments after the prefix', () => {
    expect(parseGameCompletePath('/game/complete/normal/easy')).toEqual({ mode: 'normal', difficulty: 'easy' })
    expect(parseGameCompletePath('/game/complete/daily/unknown')).toEqual({ mode: 'daily', difficulty: 'unknown' })
  })
  it('null for a shape that is not exactly two segments after the prefix, even though classifyFunnelPath still counts it as "completed"', () => {
    expect(parseGameCompletePath('/game/complete/normal')).toBeNull()
    expect(parseGameCompletePath('/game/complete/normal/easy/extra')).toBeNull()
    expect(classifyFunnelPath('/game/complete/normal')).toBe('completed') // prefix match, unaffected
  })
  it('never matches the plain /game page-view path', () => {
    expect(parseGameCompletePath('/game')).toBeNull()
  })
})

describe('VALID_FUNNEL_RATE_STEPS (audit finding, 2026-09-26 — most step/previous-step "rates" mixed units)', () => {
  it('is exactly accept and install — every other step is a plain count only', () => {
    expect([...VALID_FUNNEL_RATE_STEPS].sort()).toEqual(['accept', 'install'])
    for (const step of FUNNEL_STEP_ORDER) {
      if (step === 'accept' || step === 'install') continue
      expect(VALID_FUNNEL_RATE_STEPS.has(step)).toBe(false)
    }
  })
})

describe('"Completed game" — not instrumented until the deferred proxy hook is turned on', () => {
  it('the hook is disabled by default', () => {
    expect(COMPLETED_PROXY_PATH_PREFIX).toBeNull()
  })
  it('/signin-eligible/* is not classified as "completed" while the hook is off', () => {
    expect(classifyFunnelPath('/signin-eligible/whatever')).not.toBe('completed')
  })
})

describe('signin-eligible is never part of the funnel or hour-of-day (FINAL LIST caveat: deferred >=30min, row time != finish time)', () => {
  it('/signin-eligible/* never classifies into any funnel step at all', () => {
    expect(classifyFunnelPath('/signin-eligible/earned')).toBeNull()
    expect(classifyFunnelPath('/signin-eligible/capped')).toBeNull()
    expect(classifyFunnelPath('/signin-eligible/unearned')).toBeNull()
  })
  it('hourOfDayEt (functions/api/campaigns.ts) is built from arrival rows only — this module exposes no helper that would let signin-eligible feed hour-of-day bucketing', () => {
    // classifyFunnelPath is the ONLY entry point functions/api/campaigns.ts uses to decide
    // what counts toward the funnel; since it returns null for every signin-eligible path,
    // there is no code path from a signin-eligible row into hourOfDayEt.
    expect(classifyFunnelPath('/signin-eligible/earned')).toBeNull()
  })
})

describe('Play-direct — spend-only campaign (no beacon rows, corrected 2026-09-25)', () => {
  const playDirect = campaignById('24234347705')!
  it('is flagged spend-only with the documented label', () => {
    expect(playDirect.measurement).toBe('spend-only')
    expect(playDirect.measurabilityNote).toMatch(/not measurable in beacon/i)
  })
  it('keeps its Play-referrer uc in ucValues so rows count automatically once a reader ships', () => {
    expect(playDirect.ucValues).toEqual(['sudoku_tired_of_ads_play'])
  })
})

describe('parseReturnPath / returnVisitRates (on-device return beacon, v1.95.3)', () => {
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
  it('returnBeaconNotInstrumented: true only for flights that ended before TRACKING_ACTIVATION_DATE_ET (now 2026-09-26)', () => {
    // Android launch (flightEnd 2026-09-09) and Play-direct (flightEnd 2026-09-13) both
    // closed before activation — still "not instrumented". US+CA web retest (flightEnd
    // 2026-10-02) ends AFTER activation — it's the one flight the return beacon now covers.
    expect(returnBeaconNotInstrumented(campaignById('24215315197')!)).toBe(true)
    expect(returnBeaconNotInstrumented(campaignById('24234347705')!)).toBe(true)
    expect(returnBeaconNotInstrumented(campaignById('24279250691')!)).toBe(false)
  })
  it('sharesReturnTagWith: no two campaigns share a uc any more (corrected campaign definitions gave each its own tag)', () => {
    for (const c of CAMPAIGNS) expect(sharesReturnTagWith(c)).toBeNull()
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

describe('Android launch attribution (corrected 2026-09-25: all tag-family rows go to flight 1, no date split)', () => {
  // Real ET-bucketed daily counts for `campaign = sudoku_tired_of_ads` (production D1,
  // verified 2026-09-25 via etDateFromMs over CAST(ts/3600000 AS INTEGER) hour buckets — see
  // the CAMPAIGNS header comment). The prior pass split this family into two flights by a
  // volume cliff; the corrected Google Ads data says there is only one campaign for this
  // uc family (Android launch) — Play-direct uses a disjoint uc and has no beacon rows at
  // all (see below) — so every one of these days, including the post-09-10 trickle, belongs
  // to Android launch alone.
  const dailyCounts: [string, number][] = [
    ['2026-09-02', 150],
    ['2026-09-03', 164],
    ['2026-09-04', 165],
    ['2026-09-05', 108],
    ['2026-09-06', 160],
    ['2026-09-07', 151],
    ['2026-09-08', 132],
    ['2026-09-09', 121],
    ['2026-09-10', 7],
    ['2026-09-11', 10],
    ['2026-09-12', 4],
    ['2026-09-14', 7],
    ['2026-09-15', 1],
    ['2026-09-17', 2],
    ['2026-09-18', 2],
    ['2026-09-19', 6],
    ['2026-09-20', 3],
    ['2026-09-22', 1],
  ]
  const TOTAL = 1194 // the tag family's real total row count (production D1, 2026-09-25)
  const androidLaunch = campaignById('24215315197')!

  it('androidLaunch attribution has no upper ts bound — every day in the family, including the post-09-10 trickle, is inside it', () => {
    const { sql } = campaignAttributionClause(androidLaunch)
    expect(sql).not.toContain('ts <') // no upper bound at all
    const sum = dailyCounts.reduce((a, [, n]) => a + n, 0)
    expect(sum).toBe(TOTAL) // the whole family — nothing held outside every window
  })

  it('Play-direct has a disjoint uc, so none of these sudoku_tired_of_ads rows are its concern', () => {
    const playDirect = campaignById('24234347705')!
    expect(playDirect.ucValues).not.toContain('sudoku_tired_of_ads')
    expect(playDirect.measurement).toBe('spend-only')
  })
})

describe('parseReturnPath: uc must match ^[a-z][a-z0-9_]{0,39}$ (review finding, 2026-09-25)', () => {
  it('accepts a well-formed lowercase/underscore uc', () => {
    expect(parseReturnPath('/return/sudoku_funnel_retest/d0')).toEqual({ uc: 'sudoku_funnel_retest', bucket: 'd0' })
    expect(parseReturnPath('/return/a/d1')).toEqual({ uc: 'a', bucket: 'd1' }) // single-char is valid
  })
  it('rejects uppercase, a leading digit, and disallowed characters', () => {
    expect(parseReturnPath('/return/Sudoku/d0')).toBeNull()
    expect(parseReturnPath('/return/9sudoku/d0')).toBeNull()
    expect(parseReturnPath('/return/sudoku-tag/d0')).toBeNull() // hyphen not allowed
    expect(parseReturnPath('/return/sudoku.tag/d0')).toBeNull()
    expect(parseReturnPath('/return/sudoku tag/d0')).toBeNull()
  })
  it('rejects a uc longer than 40 characters', () => {
    const tooLong = 'a' + 'b'.repeat(40) // 41 chars
    expect(parseReturnPath(`/return/${tooLong}/d0`)).toBeNull()
    const maxLen = 'a' + 'b'.repeat(39) // 40 chars — the documented max
    expect(parseReturnPath(`/return/${maxLen}/d0`)?.uc).toBe(maxLen)
  })
})
