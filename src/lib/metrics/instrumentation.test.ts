// Instrumentation interval maths as table tests (ADR 0003 section 2): live, partial,
// unmeasured, deltas and lag, plus equivalence with the per-campaign helpers it absorbs.
import { describe, expect, it } from 'vitest'
import {
  anyPathSeen,
  deltasAllowed,
  isProvisional,
  measuredInterval,
  notInstrumentedStepsFromRows,
  seenInFlightRequired,
  servingEndMs,
  type InstrumentationRule,
  type MeasuredInterval,
} from './instrumentation'
import {
  campaignAttributionStartMs,
  campaignById,
  etMidnightUtcMs,
  FUNNEL_STEP_ORDER,
  gameCompleteNotInstrumented,
  returnBeaconNotInstrumented,
  type CampaignFlight,
} from '../campaigns'
import { GAME_COMPLETE_LIVE_AT, INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS, RAW_INSTALL_DEDUPE_LIVE_AT_UTC_MS, TRACKING_ACTIVATION_DATE_ET } from '../popupEvents'
import { kpiComparisonGate } from '../kpiFormat'

const ANDROID = campaignById('24215315197')! // closed, served 09-02..09-09
const PLAY = campaignById('24234347705')! // closed, spend-only
const RETEST = campaignById('24279250691')! // active from 2026-09-26 12:00 ET
const NOW = Date.parse('2026-09-26T21:00:00Z')
const RETEST_ATTR: [number, number] = [campaignAttributionStartMs(RETEST)!, NOW]
const ANDROID_ATTR: [number, number] = [campaignAttributionStartMs(ANDROID)!, NOW]
const GC = GAME_COMPLETE_LIVE_AT
const FIX = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS!
const TRACK = TRACKING_ACTIVATION_DATE_ET!
const TRACK_MS = etMidnightUtcMs(TRACK)

const liveAt = (atMs: number | null, extra: Partial<Extract<InstrumentationRule, { kind: 'liveAt' }>> = {}): InstrumentationRule => ({ kind: 'liveAt', atMs, source: 't', ...extra })
const liveOn = (dateEt: string | null, against?: 'flight'): InstrumentationRule => ({ kind: 'liveOnEtDate', dateEt, source: 't', ...(against ? { against } : {}) })
const before = (atMs: number | null, noteId?: string): InstrumentationRule => ({ kind: 'unmeasuredBefore', atMs, source: 't', ...(noteId ? { noteId } : {}) })
const BEACON: InstrumentationRule = { kind: 'beaconMeasurable' }
const SEEN: InstrumentationRule = { kind: 'seenInFlightWindow' }

type Row = [string, InstrumentationRule[], [number, number], CampaignFlight | undefined, boolean | undefined, Partial<MeasuredInterval>]
const TABLE: Row[] = [
  ['no rules: measured over the whole window', [], RETEST_ATTR, RETEST, undefined, { status: 'measured', from: RETEST_ATTR[0], noteIds: [] }],
  ['spend-only campaign: every beacon metric is unmeasured', [BEACON], ANDROID_ATTR, PLAY, undefined, { status: 'unmeasured', reason: 'spend-only' }],
  ['a web campaign is beacon-measurable', [BEACON], ANDROID_ATTR, ANDROID, undefined, { status: 'measured' }],
  ['live mid-window: partial from the go-live (retest completions)', [liveAt(GC)], RETEST_ATTR, RETEST, undefined, { status: 'partial', from: GC, noteIds: ['counted-from'], goLiveEt: '2026-09-26' }],
  ['live after the window ends: unmeasured', [liveAt(GC)], [RETEST_ATTR[0], GC - 1], RETEST, undefined, { status: 'unmeasured', reason: 'not-live' }],
  ['live before the window: measured', [liveAt(GC)], [GC + 1, NOW], RETEST, undefined, { status: 'measured', from: GC + 1 }],
  ['not live at all (null instant)', [liveAt(null)], RETEST_ATTR, RETEST, undefined, { status: 'unmeasured', reason: 'not-live' }],
  ['not live, with its own reason', [liveAt(null, { reason: 'no-outcome-tracking' })], RETEST_ATTR, undefined, undefined, { status: 'unmeasured', reason: 'no-outcome-tracking' }],
  ['against flight: a flight that ended before the go-live is unmeasured outright', [liveAt(GC, { against: 'flight' })], ANDROID_ATTR, ANDROID, undefined, { status: 'unmeasured', reason: 'not-live' }],
  ['against flight: a flight still serving at the go-live is partial', [liveAt(GC, { against: 'flight' })], RETEST_ATTR, RETEST, undefined, { status: 'partial', from: GC }],
  ['live on an ET date inside the range: partial from its midnight', [liveOn(TRACK)], [Date.parse('2026-09-20T04:00:00Z'), NOW], undefined, undefined, { status: 'partial', from: TRACK_MS, goLiveEt: TRACK }],
  ['live on an ET date before the window: measured (today\'s KPI window)', [liveOn(TRACK)], [TRACK_MS, NOW], undefined, undefined, { status: 'measured', from: TRACK_MS, goLiveEt: TRACK }],
  ['live on an ET date, against a flight that ended before it', [liveOn(TRACK, 'flight')], ANDROID_ATTR, ANDROID, undefined, { status: 'unmeasured', reason: 'not-live' }],
  ['live on an ET date, against a flight that reaches it', [liveOn(TRACK, 'flight')], RETEST_ATTR, RETEST, undefined, { status: 'measured' }],
  ['an unset activation date is not live', [liveOn(null)], RETEST_ATTR, RETEST, undefined, { status: 'unmeasured', reason: 'not-live' }],
  ['install gap: counted from the fix, with the fix note', [before(FIX, 'install-fix-note')], ANDROID_ATTR, ANDROID, undefined, { status: 'partial', from: FIX, noteIds: ['install-fix-note'] }],
  ['install gap, window already after the fix: measured', [before(FIX, 'install-fix-note')], [FIX + 1, NOW], ANDROID, undefined, { status: 'measured', noteIds: [] }],
  ['install fix never shipped: unmeasured', [before(null)], ANDROID_ATTR, ANDROID, undefined, { status: 'unmeasured', reason: 'not-live' }],
  ['closed flight whose window never saw the path', [SEEN], ANDROID_ATTR, ANDROID, false, { status: 'unmeasured', reason: 'not-seen-in-flight' }],
  ['closed flight that saw it', [SEEN], ANDROID_ATTR, ANDROID, true, { status: 'measured' }],
  ['ACTIVE flight not seen yet: still live (its window is open)', [SEEN], RETEST_ATTR, RETEST, false, { status: 'measured' }],
  ['closed flight with no confirmed start', [SEEN], ANDROID_ATTR, { ...ANDROID, flightStart: null }, undefined, { status: 'unmeasured', reason: 'flight-pending' }],
  ['annotation inside the window: a note, never a gate', [{ kind: 'annotateAt', atMs: RAW_INSTALL_DEDUPE_LIVE_AT_UTC_MS, noteId: 'raw-install-dedupe' }], ANDROID_ATTR, ANDROID, undefined, { status: 'measured', noteIds: ['raw-install-dedupe'] }],
  ['annotation outside the window', [{ kind: 'annotateAt', atMs: RAW_INSTALL_DEDUPE_LIVE_AT_UTC_MS, noteId: 'raw-install-dedupe' }], [RAW_INSTALL_DEDUPE_LIVE_AT_UTC_MS + 1, NOW], ANDROID, undefined, { status: 'measured', noteIds: [] }],
  ['several rules: the latest start wins, with its own note', [before(FIX, 'install-fix-note'), liveAt(GC), liveOn(TRACK)], RETEST_ATTR, RETEST, undefined, { status: 'partial', from: GC, noteIds: ['counted-from'] }],
  ['a gate beats a later partial (spend-only first)', [BEACON, before(FIX, 'install-fix-note')], ANDROID_ATTR, PLAY, undefined, { status: 'unmeasured', reason: 'spend-only' }],
]

describe('measuredInterval', () => {
  it.each(TABLE)('%s', (_name, rules, window, campaign, seenInFlight, expected) => {
    expect(measuredInterval({ rules, window, campaign, seenInFlight })).toMatchObject(expected)
  })

  it('only a closed flight needs the flightPathsSeen evidence', () => {
    expect(seenInFlightRequired(ANDROID)).toBe(true)
    expect(seenInFlightRequired(PLAY)).toBe(true)
    expect(seenInFlightRequired(RETEST)).toBe(false)
    expect(seenInFlightRequired(undefined)).toBe(false)
  })
})

describe('equivalence with the per-campaign helpers it absorbs (lib/campaigns.ts)', () => {
  const flights = [ANDROID, PLAY, RETEST, ...['2026-09-25', '2026-09-26', '2026-09-27'].map((flightEnd) => ({ ...RETEST, flightEnd, status: 'closed' as const }))]
  it.each(flights.map((f) => [`${f.label} → ${f.flightEnd}`, f] as const))('%s: returns and completions "not instrumented" agree', (_n, f) => {
    const window: [number, number] = [etMidnightUtcMs('2026-09-01'), NOW]
    const returns = measuredInterval({ rules: [liveOn(TRACK, 'flight')], window, campaign: f })
    expect(returns.status === 'unmeasured').toBe(returnBeaconNotInstrumented(f))
    const completions = measuredInterval({ rules: [liveAt(GC, { against: 'flight' })], window, campaign: f })
    expect(completions.status === 'unmeasured').toBe(gameCompleteNotInstrumented(f))
  })
  it('servingEndMs is the ET midnight after flightEnd', () => {
    expect(servingEndMs(ANDROID)).toBe(etMidnightUtcMs('2026-09-10'))
  })
})

describe('deltas: both comparison windows must be fully measured (the KPI tiles\' rule)', () => {
  const TODAY = '2026-09-26'
  it.each([
    ['no go-live', null, { yesterday: true, avg7: true }],
    ['went live today', '2026-09-26', { yesterday: false, avg7: false }],
    ['went live yesterday (a partial day)', '2026-09-25', { yesterday: false, avg7: false }],
    ['went live 3 days ago', '2026-09-23', { yesterday: true, avg7: false }],
    ['went live on the 7-day window\'s first day', '2026-09-19', { yesterday: true, avg7: false }],
    ['went live 8 days ago', '2026-09-18', { yesterday: true, avg7: true }],
  ] as const)('%s', (_n, goLiveEt, expected) => {
    expect(deltasAllowed(goLiveEt, TODAY)).toEqual(expected)
  })
  it('matches kpiComparisonGate for the tiles it gates', () => {
    for (const todayEt of ['2026-09-26', '2026-09-27', '2026-09-30', '2026-10-05']) {
      const g = kpiComparisonGate('completed', todayEt)
      const m = measuredInterval({ rules: [liveAt(GC)], window: [etMidnightUtcMs(todayEt), etMidnightUtcMs(todayEt) + 3_600_000] })
      expect(deltasAllowed(m.goLiveEt, todayEt)).toEqual({ yesterday: !g.hideVsYesterday, avg7: !g.hideVsAvg7 })
    }
  })
})

describe('lag: provisional until the longest lag has passed since the denominator stopped', () => {
  const STOP = servingEndMs(RETEST) // the retest stops serving at the end of 2026-10-02 ET
  const DAY = 86_400_000
  it.each([
    ['no lag', undefined, STOP + DAY, false],
    ['d2-7 return, day 1 of the flight', [2, 7], NOW, true],
    ['d2-7 return, 6 days after serving ended', [2, 7], STOP + 6 * DAY, true],
    ['d2-7 return, 7 days after serving ended', [2, 7], STOP + 7 * DAY, false],
    ['signed in after ask (0-1 d), the day after', [0, 1], STOP + DAY - 1, true],
    ['signed in after ask (0-1 d), a day and a bit after', [0, 1], STOP + DAY + 1, false],
  ] as const)('%s', (_n, lag, now, expected) => {
    expect(isProvisional(lag as [number, number] | undefined, STOP, now)).toBe(expected)
  })
})

describe('flightPathsSeen classification (moved from functions/_lib/campaignInstrumentation.ts)', () => {
  it('lists every funnel step with no positive count, arrivals excluded', () => {
    const rows = [
      { path: '/game', c: 12 },
      { path: '/signin-prompt/placement', c: 3 },
      { path: '/install/prompt/android', c: 0 }, // zero never counts as seen
      { path: '/unrelated', c: 9 },
    ]
    expect(notInstrumentedStepsFromRows(rows)).toEqual(FUNNEL_STEP_ORDER.filter((k) => !['arrivals', 'played', 'ask'].includes(k)))
  })
  it('anyPathSeen is the same evidence for an arbitrary path test', () => {
    expect(anyPathSeen([{ path: '/game', c: 1 }], (p) => p === '/game')).toBe(true)
    expect(anyPathSeen([{ path: '/game', c: 0 }], (p) => p === '/game')).toBe(false)
  })
})
