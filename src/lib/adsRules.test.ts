import { describe, expect, it } from 'vitest'
import {
  ADS_READ_PLANS,
  appendReading,
  planReadingAppends,
  readingEntryKind,
  assertKnownCampaign,
  buildHealthPairs,
  compareSpendToConfig,
  consumedThresholds,
  crossedThresholds,
  decideAt100,
  evaluateHealthPairs,
  evaluateKillRules,
  isApprovedPlacement,
  lastSpendDate,
  MEASUREMENT_QUIET_NOTE,
  mergeSpend,
  missingDailyReads,
  newlyCrossedThresholds,
  nextThreshold,
  outcomeRates,
  placementOutsideShare,
  playReturnStatus,
  postflightDueDate,
  readingId,
  readPlanFor,
  resolveCampaignSpend,
  RETEST_APPROVED_PLACEMENTS,
  signUpsAtMost,
  signUpsAtMostLabel,
  placementShareOver,
  isPlacementBorderline,
  stripLocalPaths,
  placementId,
  SIGNUP_PROXY_NOTE,
  UPSELL_SIGNEDOUT_EXPECTED_NOTE,
  AUTH_SUCCESS_SPLIT_RECOMMENDATION,
  AUTH_NEW_EXISTING_LIVE_AT,
  servingStateOf,
  canProposePause,
  noPauseNote,
  proposalLabel,
  deriveCohortTiers,
  COHORT_TIER_STAGES,
  spendTotals,
  summarizeReturns,
  summarizeSiteEvents,
  siteSigninShown,
  siteTutorialAsksShown,
  summarizeTaggedRows,
  type KillRuleInput,
  type ReadingRecord,
  type StoredSpend,
  buildFirstSessionFunnel,
  firstSessionBucket,
  tallySiteFirstSession,
  tallyTaggedFirstSession,
} from './adsRules'
import { campaignById } from './campaigns'
import { MIN_COHORT, POPUP_PAGE_NOTE } from './popupEvents'

const RETEST_CAMPAIGN_ID = '24279250691'
const plan = ADS_READ_PLANS[RETEST_CAMPAIGN_ID]
const H = (iso: string) => Date.parse(iso)

function killInput(over: Partial<KillRuleInput> = {}): KillRuleInput {
  return {
    plan,
    cumulativeSpend: 55,
    delivery: { impressions: 20000, clicks: 100 }, // 0.5% CTR
    placements: { campaignCost: 55, approvedCost: 54, itemizedCost: 54.5 },
    beacon: { asks: 3, taggedArrivals: 40 },
    ...over,
  }
}
const rule = (res: ReturnType<typeof evaluateKillRules>, id: string) => res.rules.find((r) => r.id === id)!

describe('read plan and campaign guards', () => {
  it('the retest plan takes budget and cap from lib/campaigns.ts and the spec constants', () => {
    expect(plan.dailyBudget).toBe(13)
    expect(plan.hardCap).toBe(100)
    expect(plan.thresholds).toEqual([25, 50, 75, 100])
    expect(plan.killRulesFrom).toBe(50)
    expect(plan.placementLeakMaxShare).toBe(0.1)
    expect(plan.ctrFloor).toBe(0.0015)
    expect(plan.approvedPlacements).toHaveLength(17)
  })
  it('readPlanFor refuses the closed campaigns, unknown ids and malformed ids', () => {
    expect(() => readPlanFor('24215315197')).toThrow(/closed/)
    expect(() => readPlanFor('24234347705')).toThrow(/closed/)
    expect(() => readPlanFor('999999999')).toThrow(/no ads read plan/)
    expect(() => readPlanFor('1 OR 1=1')).toThrow(/invalid/)
    expect(readPlanFor(RETEST_CAMPAIGN_ID).campaign.ucValues).toEqual(['sudoku_funnel_retest'])
  })
  it('metric reads may cover closed campaigns (backfill) but never unknown ids', () => {
    expect(assertKnownCampaign('24215315197').status).toBe('closed')
    expect(() => assertKnownCampaign('123456789')).toThrow()
  })
})

describe('isApprovedPlacement', () => {
  it('matches the Ads mobile-app placement string on a package boundary', () => {
    expect(isApprovedPlacement(['mobileapp::2-com.easybrain.sudoku.android'], RETEST_APPROVED_PLACEMENTS)).toBe(true)
    expect(isApprovedPlacement(['mobileapp::2-com.easybrain.sudoku.android.beta'], RETEST_APPROVED_PLACEMENTS)).toBe(false)
    expect(isApprovedPlacement(['mobileapp::2-com.icenta.sudoku.ui'], RETEST_APPROVED_PLACEMENTS)).toBe(false) // excluded in spec section 5
    expect(isApprovedPlacement([null, undefined, ''], RETEST_APPROVED_PLACEMENTS)).toBe(false)
  })
  it('"easy.sudoku.puzzle.solver.free" does not match inside the killer variant and vice versa', () => {
    expect(isApprovedPlacement(['mobileapp::2-easy.killer.sudoku.puzzle.solver.free'], ['easy.sudoku.puzzle.solver.free'])).toBe(false)
  })
})

describe('spend: merge, restatement, totals', () => {
  const s = (days: StoredSpend['days'], closedThroughEt: string | null, fetchedAt = '2026-09-28T12:00:00Z'): StoredSpend => ({
    v: 1,
    campaignId: RETEST_CAMPAIGN_ID,
    source: 'google-ads-api',
    apiVersion: 'v25',
    customerId: '8726535246',
    fetchedAt,
    closedThroughEt,
    days,
  })
  it('incoming days overwrite stored ones and a closed day that moved by a cent is reported as restated', () => {
    const before = s({ '2026-09-26': { costMicros: 10_000_000, impressions: 1, clicks: 0 }, '2026-09-27': { costMicros: 12_000_000, impressions: 1, clicks: 0 } }, '2026-09-27')
    const after = s({ '2026-09-27': { costMicros: 11_950_000, impressions: 1, clicks: 0 }, '2026-09-28': { costMicros: 5_000_000, impressions: 1, clicks: 0 } }, '2026-09-28')
    const { merged, restated } = mergeSpend(before, after)
    expect(Object.keys(merged.days)).toEqual(['2026-09-26', '2026-09-27', '2026-09-28'])
    expect(merged.days['2026-09-27'].costMicros).toBe(11_950_000)
    expect(restated).toEqual([{ date: '2026-09-27', beforeMicros: 12_000_000, afterMicros: 11_950_000 }])
  })
  it('sub-cent changes are not restatements', () => {
    const before = s({ '2026-09-26': { costMicros: 10_000_000, impressions: 1, clicks: 0 } }, '2026-09-26')
    const after = s({ '2026-09-26': { costMicros: 10_004_000, impressions: 1, clicks: 0 } }, '2026-09-27')
    expect(mergeSpend(before, after).restated).toEqual([])
  })
  it('spendTotals sums closed days only when given a through-date, in exact micros', () => {
    const st = s({ '2026-09-26': { costMicros: 10_500_000, impressions: 2600, clicks: 21 }, '2026-09-27': { costMicros: 13_200_000, impressions: 5100, clicks: 40 }, '2026-09-28': { costMicros: 4_000_000, impressions: 900, clicks: 5 } }, '2026-09-27')
    expect(spendTotals(st, '2026-09-27')).toMatchObject({ cost: 23.7, impressions: 7700, clicks: 61, days: 2, lastDate: '2026-09-27' })
    expect(spendTotals(st).cost).toBe(27.7)
    expect(spendTotals(null).cost).toBe(0)
    expect(lastSpendDate(st)).toBe('2026-09-28')
  })
  it('mergeSpend refuses mixing campaigns', () => {
    expect(() => mergeSpend({ ...s({}, null), campaignId: '24215315197' }, s({}, null))).toThrow()
  })
})

describe('resolveCampaignSpend (dashboard: stored beats config, fail soft)', () => {
  const summary = { campaignId: 'x', costMicros: 124_470_711, impressions: 1, clicks: 1, days: 8, firstDate: '2026-09-02', lastDate: '2026-09-09', fetchedAt: '2026-09-26T15:51:43Z' }
  it('uses stored Google Ads spend when at least one day is stored', () => {
    expect(resolveCampaignSpend(summary, 999)).toEqual({ spend: 124.47, source: 'google-ads-api', fetchedAt: summary.fetchedAt, lastDate: '2026-09-09' })
  })
  it('falls back to config when nothing is stored, and to nothing when there is no config', () => {
    expect(resolveCampaignSpend(null, 75.17)).toMatchObject({ spend: 75.17, source: 'config' })
    expect(resolveCampaignSpend({ ...summary, days: 0 }, 75.17)).toMatchObject({ spend: 75.17, source: 'config' })
    expect(resolveCampaignSpend(null, null)).toMatchObject({ spend: null, source: 'none' })
  })
})

describe('thresholds fire once', () => {
  const rec = (thresholds: number[], complete: boolean, kind: ReadingRecord['kind'] = 'threshold'): ReadingRecord => ({
    v: 1,
    id: `${kind}:${thresholds.join('-')}:${complete}`,
    campaignId: RETEST_CAMPAIGN_ID,
    kind,
    readAt: '2026-09-29T12:05:00Z',
    etDate: '2026-09-29',
    spendThroughEt: '2026-09-28',
    cumulativeSpend: 30,
    thresholds,
    complete,
    rules: null,
    proposal: null,
    decision: null,
    counts: {},
    notes: [],
  })
  it('crossed / next', () => {
    expect(crossedThresholds(24.99, plan.thresholds)).toEqual([])
    expect(crossedThresholds(25, plan.thresholds)).toEqual([25])
    expect(crossedThresholds(76, plan.thresholds)).toEqual([25, 50, 75])
    expect(nextThreshold(51, plan.thresholds)).toBe(75)
    expect(nextThreshold(100, plan.thresholds)).toBeNull()
  })
  it('only COMPLETE threshold reads consume; daily lines never do', () => {
    expect(consumedThresholds([rec([25], true), rec([50], false), rec([75], true, 'daily')])).toEqual([25])
  })
  it('a jump across two thresholds fires both in one read; already-consumed ones never re-fire', () => {
    expect(newlyCrossedThresholds(52, plan.thresholds, [])).toEqual([25, 50])
    expect(newlyCrossedThresholds(52, plan.thresholds, [25])).toEqual([50])
    expect(newlyCrossedThresholds(52, plan.thresholds, [25, 50])).toEqual([])
    // A downward restatement never "un-fires" anything.
    expect(newlyCrossedThresholds(49, plan.thresholds, [25, 50])).toEqual([])
  })
})

describe('evaluateKillRules (spec section 12)', () => {
  it('under $50, rules 1-3 are not armed and nothing proposes a pause', () => {
    const res = evaluateKillRules(killInput({ cumulativeSpend: 26, delivery: { impressions: 20000, clicks: 1 }, beacon: { asks: 0, taggedArrivals: 0 } }))
    expect(res.rules.filter((r) => r.id !== 'hard-cap').every((r) => r.status === 'not-armed')).toBe(true)
    expect(res.proposal).toBe('CONTINUE')
  })
  it('at $50 with healthy numbers every rule clears', () => {
    const res = evaluateKillRules(killInput())
    expect(res.tripped).toEqual([])
    expect(res.proposal).toBe('CONTINUE')
    expect(rule(res, 'hard-cap').status).toBe('not-armed')
  })
  it('rule 1: MORE than 10% outside the approved placements trips; exactly 10% does not', () => {
    const trip = evaluateKillRules(killInput({ placements: { campaignCost: 60, approvedCost: 50, itemizedCost: 60 } }))
    expect(rule(trip, 'placement-leak').status).toBe('trip')
    expect(trip.proposal).toBe('PROPOSE PAUSE')
    const edge = evaluateKillRules(killInput({ placements: { campaignCost: 60, approvedCost: 54, itemizedCost: 60 } }))
    expect(rule(edge, 'placement-leak').status).toBe('clear')
  })
  it('rule 1 counts un-itemized spend as outside, and says so', () => {
    const res = evaluateKillRules(killInput({ placements: { campaignCost: 60, approvedCost: 50, itemizedCost: 50 } }))
    expect(rule(res, 'placement-leak').status).toBe('trip')
    expect(rule(res, 'placement-leak').detail).toMatch(/un-itemized/)
  })
  it('L1: rule 1 decides in integer micros, so float residue at exactly 10% never trips', () => {
    // (1.10 - 0.99) / 1.10 is 0.10000000000000007 in floating point; in micros it is exactly 10%.
    expect((1.1 - 0.99) / 1.1 > 0.1).toBe(true)
    const res = evaluateKillRules(killInput({ placements: { campaignCost: 1.1, approvedCost: 0.99, itemizedCost: 1.1 } }))
    expect(res.rules.find((r) => r.id === 'placement-leak')!.status).toBe('clear')
    expect(placementShareOver(110_000, 1_100_000, 0.1)).toBe(false)
    expect(placementShareOver(110_001, 1_100_000, 0.1)).toBe(true)
  })
  it('L2: a share in the 9-11% band is flagged "borderline, check the placement view", tripped or not', () => {
    const clear = evaluateKillRules(killInput({ placements: { campaignCost: 100, approvedCost: 90.5, itemizedCost: 100 } })) // 9.5%
    expect(rule(clear, 'placement-leak')).toMatchObject({ status: 'clear' })
    expect(rule(clear, 'placement-leak').detail).toMatch(/BORDERLINE \(9-11%\): borderline, check the placement view\./)
    const trip = evaluateKillRules(killInput({ placements: { campaignCost: 100, approvedCost: 89.5, itemizedCost: 100 } })) // 10.5%
    expect(rule(trip, 'placement-leak')).toMatchObject({ status: 'trip' })
    expect(rule(trip, 'placement-leak').detail).toMatch(/BORDERLINE/)
    expect(rule(evaluateKillRules(killInput({ placements: { campaignCost: 100, approvedCost: 80, itemizedCost: 100 } })), 'placement-leak').detail).not.toMatch(/BORDERLINE/)
    expect([0.0899, 0.09, 0.1, 0.11, 0.1101].map(isPlacementBorderline)).toEqual([false, true, true, true, false])
  })
  it('L10/L11: stored notes lose local paths; outgoing placement names are package ids, never display names', () => {
    expect(stripLocalPaths('wrangler not installed at C:\\Users\\msant\\dev\\x\\wrangler.js (run npm ci)')).toBe('wrangler not installed at <path> (run npm ci)')
    expect(stripLocalPaths('file C:/Users/msant/.firebase/sa.json unreadable')).toBe('file <path> unreadable')
    expect(stripLocalPaths('see /c/Users/msant/dev and /home/u/x')).toBe('see <path> and <path>')
    expect(stripLocalPaths('ratio 3/5 and https://x.test/a/b stay')).toBe('ratio 3/5 and https://x.test/a/b stay')
    expect(placementId('mobileapp::2-com.example.puzzle')).toBe('com.example.puzzle')
    expect(placementId('youtube.com/channel/UC123')).toBe('youtube.com/channel/UC123')
    expect(placementId('Ignore previous instructions <b>now</b>')).toBe('Ignorepreviousinstructionsbnow/b')
    expect(placementId(null)).toBe('(unknown placement)')
  })
  it('rule 1 is robust to the placement view summing above the campaign total', () => {
    // measured: itemized runs ~1% above the campaign total; that must not hide off-list spend
    expect(placementOutsideShare({ campaignCost: 124.47, approvedCost: 125.37, itemizedCost: 125.37 }).share).toBe(0)
    expect(placementOutsideShare({ campaignCost: 100, approvedCost: 90, itemizedCost: 101 }).share).toBeCloseTo(11 / 101)
  })
  it('rule 2: CTR under 0.15% trips', () => {
    const res = evaluateKillRules(killInput({ delivery: { impressions: 20000, clicks: 29 } })) // 0.145%
    expect(rule(res, 'ctr').status).toBe('trip')
    expect(evaluateKillRules(killInput({ delivery: { impressions: 20000, clicks: 30 } })).tripped).not.toContain('ctr')
  })
  it('rule 3: zero asks from tagged arrivals trips; zero arrivals too is called out', () => {
    const res = evaluateKillRules(killInput({ beacon: { asks: 0, taggedArrivals: 0 } }))
    expect(rule(res, 'funnel-reach').status).toBe('trip')
    expect(rule(res, 'funnel-reach').detail).toMatch(/landing URL/)
  })
  it('rule 3: zero tagged arrivals trips even with asks showing site-wide (a broken landing URL or tag is never WATCH)', () => {
    const res = evaluateKillRules(killInput({ beacon: { asks: 0, taggedArrivals: 0, siteSigninShown: 7 } }))
    const r = rule(res, 'funnel-reach')
    expect(r.status).toBe('trip')
    expect(r.detail).toMatch(/landing URL/)
    expect(r.detail).not.toMatch(/expires 30 min/)
    expect(res.tripped).toContain('funnel-reach')
  })
  it('rule 3: once the tutorial ask has rows site-wide, rule 3 reads tagged asks only (no WATCH)', () => {
    const res = evaluateKillRules(killInput({ beacon: { asks: 0, taggedArrivals: 40, siteSigninShown: 7, siteTutorialAsks: 3 } }))
    const r = rule(res, 'funnel-reach')
    expect(r.status).toBe('trip')
    expect(r.detail).toMatch(/Mode: tagged asks only \(\/signin-prompt\/tutorial shown 3 times site-wide/)
    expect(r.detail).not.toMatch(/expires 30 min/)
    expect(res.tripped).toContain('funnel-reach')
    const ok = rule(evaluateKillRules(killInput({ beacon: { asks: 2, taggedArrivals: 40, siteSigninShown: 7, siteTutorialAsks: 3 } })), 'funnel-reach')
    expect(ok.status).toBe('clear')
    expect(ok.detail).toMatch(/Mode: tagged asks only/)
  })
  it('rule 3: tagged asks > 0 clears and reports the site-wide shown count', () => {
    const r = rule(evaluateKillRules(killInput({ beacon: { asks: 3, taggedArrivals: 40, siteSigninShown: 12 } })), 'funnel-reach')
    expect(r.status).toBe('clear')
    expect(r.detail).toMatch(/Site-wide asks shown: 12\./)
  })
  it('rule 3: while the tutorial ask has no rows site-wide, zero tagged asks with asks shown site-wide is watch, not trip', () => {
    for (const siteTutorialAsks of [0, undefined]) {
      const res = evaluateKillRules(killInput({ beacon: { asks: 0, taggedArrivals: 40, siteSigninShown: 7, siteTutorialAsks } }))
      const r = rule(res, 'funnel-reach')
      expect(r.status).toBe('watch')
      expect(r.detail).toMatch(/Site-wide asks shown: 7\./)
      expect(r.detail).toMatch(/expires 30 min/)
      expect(r.detail).toMatch(/Mode: site-wide fallback \(\/signin-prompt\/tutorial (has no rows|not read) site-wide/)
      expect(res.tripped).not.toContain('funnel-reach')
    }
  })
  it('rule 3: zero tagged asks and zero site-wide prompts still trips', () => {
    const r = rule(evaluateKillRules(killInput({ beacon: { asks: 0, taggedArrivals: 40, siteSigninShown: 0 } })), 'funnel-reach')
    expect(r.status).toBe('trip')
    expect(r.detail).toMatch(/Site-wide asks shown: 0\./)
    expect(r.detail).not.toMatch(/expires 30 min/)
  })
  // The 2026-09-30 Day-4 read Mike retracted as a measurement gap: 0 tagged asks from 161 tagged
  // arrivals; site-wide since the 2026-09-26 flight start /signin-prompt/streak 5,
  // /signin-prompt/dismiss 3, /signin-prompt/placement 0, /promo-first50/shown 0, no tutorial ask.
  const day4 = (streak: number) => {
    const from = H('2026-09-26T00:00:00Z')
    const to = H('2026-09-30T10:00:00Z')
    const rows = [
      { hourStartMs: H('2026-09-27T15:00:00Z'), path: '/signin-prompt/streak', count: streak },
      { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/signin-prompt/dismiss', count: 3 },
      { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/signin-prompt/placement', count: 0 },
      { hourStartMs: H('2026-09-29T12:00:00Z'), path: '/promo-first50/shown', count: 0 },
    ]
    const site = siteSigninShown(rows, from, to)
    const tutorial = siteTutorialAsksShown(rows, from, to)
    return { site, tutorial, res: evaluateKillRules(killInput({ beacon: { asks: 0, taggedArrivals: 161, siteSigninShown: site, siteTutorialAsks: tutorial } })) }
  }
  it('rule 3, 2026-09-30 numbers: 0 asks / 161 arrivals with streak 5 + dismiss 3 site-wide reads WATCH, no pause proposal', () => {
    const { site, tutorial, res } = day4(5)
    expect(site).toBe(5) // shown asks only: a dismiss is not a shown prompt
    expect(tutorial).toBe(0)
    const r = rule(res, 'funnel-reach')
    expect(r.status).toBe('watch')
    expect(r.detail).toMatch(/^0 asks from 161 tagged arrivals\. Site-wide asks shown: 5\./)
    expect(r.detail).toMatch(/Mode: site-wide fallback \(\/signin-prompt\/tutorial has no rows site-wide/)
    expect(res.tripped).toEqual([])
    expect(res.proposal).toBe('CONTINUE')
  })
  it('rule 3, 2026-09-30 zero-site-wide twin: 0 asks / 161 arrivals with no prompt shown site-wide trips and proposes a pause', () => {
    const { site, res } = day4(0)
    expect(site).toBe(0)
    const r = rule(res, 'funnel-reach')
    expect(r.status).toBe('trip')
    expect(r.detail).toMatch(/Site-wide asks shown: 0\./)
    expect(res.tripped).toEqual(['funnel-reach'])
    expect(res.proposal).toBe('PROPOSE PAUSE')
  })
  it('rule 3: an unavailable site-wide count never reads WATCH (it trips and says the count is unavailable)', () => {
    for (const siteSigninShown of [null, undefined]) {
      const res = evaluateKillRules(killInput({ beacon: { asks: 0, taggedArrivals: 161, siteSigninShown, siteTutorialAsks: null } }))
      const r = rule(res, 'funnel-reach')
      expect(r.status).toBe('trip')
      expect(r.detail).toMatch(/Site-wide asks shown: unavailable\./)
      expect(res.tripped).toContain('funnel-reach')
    }
  })
  it('siteSigninShown counts the ASK_PATHS shown set (promo included) inside the window; siteTutorialAsksShown only the tutorial ask', () => {
    const t0 = H('2026-09-20T10:30:00Z')
    const rows = [
      { hourStartMs: H('2026-09-20T10:00:00Z'), path: '/signin-prompt/streak', count: 2 },
      { hourStartMs: H('2026-09-20T12:00:00Z'), path: '/signin-prompt/placement', count: 3 },
      { hourStartMs: H('2026-09-20T12:00:00Z'), path: '/signin-prompt/dismiss', count: 5 },
      { hourStartMs: H('2026-09-20T12:00:00Z'), path: '/signin-prompt/accept', count: 1 },
      { hourStartMs: H('2026-09-20T12:00:00Z'), path: '/promo-first50/shown', count: 4 },
      { hourStartMs: H('2026-09-20T09:00:00Z'), path: '/signin-prompt/streak', count: 9 },
      { hourStartMs: H('2026-09-20T14:00:00Z'), path: '/signin-prompt/streak', count: 9 },
      { hourStartMs: H('2026-09-20T13:00:00Z'), path: '/signin-prompt/tutorial', count: 2 },
    ]
    expect(siteSigninShown(rows, t0, H('2026-09-20T14:00:00Z'))).toBe(11) // streak 2 + placement 3 + promo 4 + tutorial 2
    expect(siteTutorialAsksShown(rows, t0, H('2026-09-20T14:00:00Z'))).toBe(2)
    expect(siteTutorialAsksShown(rows, t0, H('2026-09-20T13:00:00Z'))).toBe(0)
  })
  it('rule 4: $100 proposes a pause regardless of results', () => {
    const res = evaluateKillRules(killInput({ cumulativeSpend: 100 }))
    expect(res.tripped).toEqual(['hard-cap'])
    expect(res.proposal).toBe('PROPOSE PAUSE')
  })
  it('rules are only evaluated on data that came back: a missing read is no-data, never a trip', () => {
    const res = evaluateKillRules(killInput({ delivery: null, placements: null, beacon: null }))
    for (const id of ['placement-leak', 'ctr', 'funnel-reach']) expect(rule(res, id).status).toBe('no-data')
    expect(res.proposal).toBe('CONTINUE')
    // an impressions count under MIN_COHORT is not enough to call a CTR
    expect(rule(evaluateKillRules(killInput({ delivery: { impressions: MIN_COHORT - 1, clicks: 0 } })), 'ctr').status).toBe('no-data')
  })
})

describe('decision table at $100 (spec section 13)', () => {
  it('2+ (at most) / 1 (at most) / 0 declined / 0 rarely shown / 0 accepted-not-completed', () => {
    expect(decideAt100({ signUpsAtMost: 2, asks: 10, accepts: 3 }).row).toBe('two-plus')
    expect(decideAt100({ signUpsAtMost: 1, asks: 10, accepts: 3 }).row).toBe('one')
    expect(decideAt100({ signUpsAtMost: 0, asks: 12, accepts: 0 }).row).toBe('zero-declined')
    expect(decideAt100({ signUpsAtMost: 0, asks: MIN_COHORT - 1, accepts: 0 }).row).toBe('zero-rarely-shown')
    expect(decideAt100({ signUpsAtMost: 0, asks: 12, accepts: 2 }).row).toBe('zero-accepted-not-completed')
  })
  it('the 2+ row says "at most", calls it an upper bound, leaves the call to Mike, and claims neither "verified" nor "1% or better"', () => {
    const d = decideAt100({ signUpsAtMost: 3, asks: 20, accepts: 9 })
    expect(d.reading).toMatch(/^At most 3 campaign sign-ups: an upper bound/)
    expect(d.reading).toMatch(/Mike decides\.$/)
    expect(`${d.reading} ${d.next}`).not.toMatch(/verified|1% or better/i)
    expect(decideAt100({ signUpsAtMost: 1, asks: 20, accepts: 9 }).reading).toMatch(/^At most 1 campaign sign-up \(an upper bound/)
  })
  it('no row authorizes scaling on the $100 read alone', () => {
    for (const i of [{ signUpsAtMost: 5, asks: 20, accepts: 9 }, { signUpsAtMost: 1, asks: 5, accepts: 1 }]) expect(decideAt100(i).next).not.toMatch(/\bscale up\b/i)
    expect(decideAt100({ signUpsAtMost: 3, asks: 20, accepts: 9 }).next).toMatch(/hold on scaling/i)
    expect(decideAt100({ signUpsAtMost: 3, asks: 20, accepts: 9 }).next).toMatch(/Do not scale display on this read/)
  })
  it('sign-ups are an UPPER bound: min(tagged auth successes, sitewide window accounts), labelled "at most" with both inputs', () => {
    expect(signUpsAtMost(3, 1)).toBe(1)
    expect(signUpsAtMost(1, 4)).toBe(1)
    expect(signUpsAtMost(2, null)).toBe(2)
    expect(signUpsAtMostLabel(1, 3, 1)).toBe('at most 1 campaign sign-up (tagged auth successes 3; new prod accounts sitewide in the window 1)')
    expect(signUpsAtMostLabel(2, 2, null)).toBe('at most 2 campaign sign-ups (tagged auth successes 2; new prod accounts sitewide in the window not read)')
    expect(SIGNUP_PROXY_NOTE).toMatch(/UPPER bound/)
    expect(SIGNUP_PROXY_NOTE).not.toMatch(/verified/i)
  })
  it('SIGNUP_PROXY_NOTE names both segments: bounded before the new/existing go-live, exact from it on (v1.95.5, 2026-09-26 19:43:02Z)', () => {
    expect(SIGNUP_PROXY_NOTE).toMatch(/2026-09-26 15:43 ET/)
    expect(SIGNUP_PROXY_NOTE).toMatch(/EXACTLY/)
    expect(SIGNUP_PROXY_NOTE).toMatch(/at most X \+ exactly Y/)
  })
  it('UPSELL_SIGNEDOUT_EXPECTED_NOTE says the near-zero is expected by design, never a bug (corrected 2026-09-26)', () => {
    expect(UPSELL_SIGNEDOUT_EXPECTED_NOTE).toMatch(/EXPECTED BY DESIGN/)
    expect(UPSELL_SIGNEDOUT_EXPECTED_NOTE).not.toMatch(/KNOWN BUG|bug/i)
    expect(UPSELL_SIGNEDOUT_EXPECTED_NOTE).toMatch(/never shown the paywall/)
  })
  it('the post-flight recommendation names the beacon split and the freeze', () => {
    expect(AUTH_SUCCESS_SPLIT_RECOMMENDATION).toContain('add /auth/success/<provider>/new|existing via additionalUserInfo.isNewUser (frozen until 10-02)')
  })
})

describe('serving state: never propose pausing an ended or non-serving campaign', () => {
  it('maps status + serving status', () => {
    expect(servingStateOf({ status: 'ENABLED', servingStatus: 'SERVING' })).toBe('serving')
    expect(servingStateOf({ status: 'ENABLED', servingStatus: 'ENDED' })).toBe('ended')
    expect(servingStateOf({ status: 'PAUSED', servingStatus: 'SERVING' })).toBe('paused')
    expect(servingStateOf({ status: 'ENABLED', servingStatus: 'PENDING' })).toBe('not-serving')
    expect(servingStateOf({ status: 'ENABLED', servingStatus: null })).toBe('unknown')
    expect(servingStateOf(null)).toBe('unknown')
    expect(['serving', 'unknown'].every((s) => canProposePause(s as any))).toBe(true)
    expect(['ended', 'paused', 'not-serving'].some((s) => canProposePause(s as any))).toBe(false)
  })
  it('a tripped rule on an ENDED campaign proposes nothing; the rule result still shows the trip', () => {
    const res = evaluateKillRules(killInput({ cumulativeSpend: 100, campaignState: { status: 'ENABLED', servingStatus: 'ENDED' } }))
    expect(res.tripped).toEqual(['hard-cap'])
    expect(res.proposal).toBeNull()
    expect(res.servingState).toBe('ended')
  })
  it('a serving campaign (or an unreadable state) still gets the pause proposal', () => {
    expect(evaluateKillRules(killInput({ cumulativeSpend: 100, campaignState: { status: 'ENABLED', servingStatus: 'SERVING' } })).proposal).toBe('PROPOSE PAUSE')
    expect(evaluateKillRules(killInput({ cumulativeSpend: 100, campaignState: null })).proposal).toBe('PROPOSE PAUSE')
  })
  it('the panel shows "ended" where no pause was proposed', () => {
    const note = noPauseNote('ended', { status: 'ENABLED', servingStatus: 'ENDED' })
    expect(note).toBe('no pause proposed: campaign ended (ENABLED/ENDED)')
    expect(proposalLabel({ proposal: null, notes: [note] })).toBe('campaign ended (ENABLED/ENDED)')
    expect(proposalLabel({ proposal: 'PROPOSE PAUSE', notes: [] })).toBe('PROPOSE PAUSE')
    expect(proposalLabel({ proposal: null, notes: [] })).toBe('—')
  })
})

describe('day-15/30/60 cohort by tier and promo (sitewide, not campaign-attributed)', () => {
  it('derives tiers the way useAccess does: paid > explicitly expired > trial > expired', () => {
    // 12 accounts: 2 paid (one also past its trial), 1 explicitly expired while its trial is
    // still open, 4 whose trial ended (one of them paid, one of them also access-past) → expired
    // = accessPast 1 + trialPast 4 − trialPastAndPaid 1 − trialPastAndAccessPast 0 = 4.
    const t = deriveCohortTiers({ total: 12, paid: 2, accessPast: 1, trialPast: 4, trialPastAndPaid: 1, trialPastAndAccessPast: 0, promoSet: 5 })
    expect(t).toMatchObject({ label: 'sitewide, not campaign-attributed', total: 12, paid: 2, expired: 4, trialActive: 6, promoSet: 5, promoUnset: 7, consistent: true })
    expect(t.rates.paid).toEqual({ value: 2 / 12, insufficientCohort: false, numerator: 2, denominator: 12 })
  })
  it('MIN_COHORT gates every rate: 3 accounts report counts, not percentages', () => {
    const t = deriveCohortTiers({ total: 3, paid: 1, accessPast: 0, trialPast: 1, trialPastAndPaid: 0, trialPastAndAccessPast: 0, promoSet: 1 })
    for (const r of Object.values(t.rates)) expect(r).toMatchObject({ value: null, insufficientCohort: true })
    expect(t).toMatchObject({ paid: 1, expired: 1, trialActive: 1 })
  })
  it('flags counts that do not add up instead of printing negatives', () => {
    const t = deriveCohortTiers({ total: 2, paid: 2, accessPast: 1, trialPast: 1, trialPastAndPaid: 0, trialPastAndAccessPast: 0, promoSet: 0 })
    expect(t.consistent).toBe(false)
    expect(t.trialActive).toBe(0)
  })
  it('only the day-15/30/60 stages read it', () => {
    expect(COHORT_TIER_STAGES).toEqual(['day15', 'day30', 'day60'])
  })
})

describe('summarizeTaggedRows (campaign-attributed new indicators)', () => {
  const rows = [
    { hourStartMs: H('2026-09-27T17:00:00Z'), path: '/', visitor: 'new', count: 10 },
    { hourStartMs: H('2026-09-28T17:00:00Z'), path: '/', visitor: 'new', count: 5 },
    { hourStartMs: H('2026-09-28T17:00:00Z'), path: '/game', visitor: 'returning', count: 20 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/signin-prompt/placement', visitor: 'returning', count: 2 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/signin-prompt/streak', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/signin-prompt/other-reason', visitor: 'returning', count: 4 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/signin-prompt/tutorial', visitor: 'returning', count: 3 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/promo-first50/shown', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/signin-prompt/dismiss', visitor: 'returning', count: 2 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/promo-first50/dismiss', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/promo-first50/accept', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-28T19:00:00Z'), path: '/install/pwa-installed', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-28T19:00:00Z'), path: '/install/standalone-detected', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-28T19:00:00Z'), path: '/popup-outcome/install-prompt/installed', visitor: 'returning', count: 1 },
  ]
  it('asks are EXACTLY placement + streak + tutorial + promo-first50/shown; any other reason is reported separately', () => {
    const s = summarizeTaggedRows(rows)
    expect(s.asks.total).toBe(7)
    expect(s.asks.byPath).toEqual({ '/signin-prompt/placement': 2, '/signin-prompt/streak': 1, '/signin-prompt/tutorial': 3, '/promo-first50/shown': 1 })
    expect(s.asks.otherShownReasons).toBe(4)
    expect(s.accepts.total).toBe(1)
  })
  it('dismisses are kept per dialog, never summed', () => {
    expect(summarizeTaggedRows(rows).dismisses).toEqual({ signinPrompt: 2, promoFirst50: 1 })
  })
  it('arrivals are visitor=new rows; hits are every row', () => {
    const s = summarizeTaggedRows(rows)
    expect(s.taggedArrivals).toBe(15)
    expect(s.taggedHits).toBe(53)
    expect(s.funnel.arrivals).toBe(15)
  })
  it('one install racing two raw beacons counts ONCE (the popup outcome); raw signals are secondary', () => {
    const s = summarizeTaggedRows(rows)
    expect(s.install.installed).toBe(1)
    expect(s.funnel.install).toBe(1)
    expect(s.install.rawSignals).toBe(2)
  })
  it('an ET-day window keeps only that day\'s hour buckets', () => {
    const s = summarizeTaggedRows(rows, { fromMs: H('2026-09-28T04:00:00Z'), toMs: H('2026-09-29T04:00:00Z') })
    expect(s.taggedArrivals).toBe(5)
  })
  it('AUTH_NEW_EXISTING_LIVE_AT is the v1.95.5 go-live instant', () => {
    expect(AUTH_NEW_EXISTING_LIVE_AT).toBe(Date.parse('2026-09-26T19:43:02Z'))
  })
  it('one sign-in fires a base row AND a v1.95.5 new/existing suffix row (same event) — authSuccess counts it once, not twice', () => {
    const authRows = [
      { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/auth/success/email', visitor: 'returning', count: 2 },
      { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/auth/success/email/existing', visitor: 'returning', count: 2 },
      { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/auth/success/google', visitor: 'returning', count: 1 },
      { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/auth/success/google/new', visitor: 'returning', count: 1 },
    ]
    const s = summarizeTaggedRows(authRows)
    expect(s.authSuccess).toBe(3) // 2 email + 1 google — NOT 6 (the suffixed rows must not add again)
  })
})

describe('site-wide events and MIN_COHORT on every rate', () => {
  const now = H('2026-09-30T03:30:00Z') // 23:30 ET on 09-29
  const rows = [
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/signin-prompt/placement', count: 4 },
    { hourStartMs: H('2026-09-30T02:00:00Z'), path: '/signin-prompt/placement', count: 3 }, // too fresh to be matured
    { hourStartMs: H('2026-09-29T18:00:00Z'), path: '/popup-outcome/signin-prompt/signed-in', count: 1 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/install/prompt/android', count: 6 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/install/pwa-installed', count: 2 },
  ]
  it('matured parents exclude shown events younger than the outcome window', () => {
    const s = summarizeSiteEvents(rows, now - 24 * 3_600_000)
    expect(s.shown['signin-prompt']).toBe(7)
    expect(s.shownMatured['signin-prompt']).toBe(4)
    expect(s.rawInstallSignals).toBe(2)
  })
  it('install gap rows before the fix are unmeasured; the boundary instant itself is measured', () => {
    const FIX = H('2026-09-26T16:26:36Z')
    const s = summarizeSiteEvents(
      [
        // same hour, row-exact split from the query: 3 before the fix, 2 at/after it
        { hourStartMs: H('2026-09-26T16:00:00Z'), path: '/popup-outcome/install-prompt/installed', count: 3, postInstallFix: false },
        { hourStartMs: H('2026-09-26T16:00:00Z'), path: '/popup-outcome/install-prompt/installed', count: 2, postInstallFix: true },
        { hourStartMs: H('2026-09-26T16:00:00Z'), path: '/install/pwa-installed', count: 4, postInstallFix: false },
        { hourStartMs: H('2026-09-26T16:00:00Z'), path: '/install/pwa-accept', count: 5, postInstallFix: false },
        { hourStartMs: H('2026-09-26T16:00:00Z'), path: '/install/pwa-accept', count: 6, postInstallFix: true },
        { hourStartMs: H('2026-09-26T15:00:00Z'), path: '/install/standalone-detected', count: 1 }, // not a gap path: always measured
      ],
      now,
      FIX,
    )
    expect(s.outcomes.install.installed).toBe(2)
    expect(s.rawInstallSignals).toBe(1) // pre-fix pwa-installed dropped, standalone kept
    expect(s.installAcceptPostFix).toBe(6)
    expect(s.installAcceptPostFixMatured).toBe(6)
  })
  it('without a row-exact flag the hour bucket decides, conservatively (the fix hour counts as pre-fix)', () => {
    const FIX = H('2026-09-26T16:26:36Z')
    const s = summarizeSiteEvents(
      [
        { hourStartMs: H('2026-09-26T16:00:00Z'), path: '/install/pwa-accept', count: 7 },
        { hourStartMs: H('2026-09-26T17:00:00Z'), path: '/install/pwa-accept', count: 1 },
      ],
      now,
      FIX,
    )
    expect(s.installAcceptPostFix).toBe(1)
  })
  it('outcome rates are gated: a 1/4 outcome reports "too few", never 25%', () => {
    const s = summarizeSiteEvents(rows.slice(0, 1).concat(rows[2]), now)
    const r = outcomeRates(s.outcomes, s.shown, 'signin-prompt')['signed-in']
    expect(r).toEqual({ value: null, insufficientCohort: true, numerator: 1, denominator: 4 })
  })
})

describe('returns (/return/<uc>/<bucket>, attributed by the path)', () => {
  it('splits web and app, drops other tags, gates rates by d0', () => {
    const s = summarizeReturns(
      [
        { site: 'bestsudoku-web', path: '/return/sudoku_funnel_retest/d0', count: 4 },
        { site: 'bestsudoku-web', path: '/return/sudoku_funnel_retest/d1', count: 1 },
        { site: 'bestsudoku-web', path: '/return/sudoku_tired_of_ads/d0', count: 50 },
        { site: 'bestsudoku-app', path: '/return/sudoku_funnel_retest/d31-60', count: 1 },
      ],
      ['sudoku_funnel_retest'],
    )
    expect(s.web.d0).toBe(4)
    expect(s.web.d1).toBe(1)
    expect(s.webRates.d1).toBeNull() // d0 = 4 < MIN_COHORT
    expect(s.app['d31-60']).toBe(1)
  })
})

describe('Play "not yet seen" (no expected date encoded)', () => {
  const now = H('2026-09-30T12:00:00Z')
  // Counts only (src/lib/splitGuard.ts): a /return/ row's ET date may show, never its hour.
  const noTime = (line: string) => expect(line).not.toMatch(/\d{1,2}:\d{2}/)
  it('not yet seen, web continuing', () => {
    const p = playReturnStatus([{ site: 'bestsudoku-web', count: 10, firstEtDate: '2026-09-26', lastEtDate: '2026-09-29' }], now)
    expect(p.appSeen).toBe(false)
    expect(p.webContinuing).toBe(true)
    expect(p.webLastSeenEt).toBe('2026-09-29 ET')
    expect(p.line).toMatch(/not yet seen.*last seen on 2026-09-29 ET.*pipeline works/)
    noTime(p.line)
  })
  it('web continuing is day-level: the ET day 48 h ago still counts, the day before does not', () => {
    // now = 2026-09-30 08:00 ET, so 48 h ago falls on 2026-09-28 (ET).
    const at = (d: string) => playReturnStatus([{ site: 'bestsudoku-web', count: 3, firstEtDate: '2026-09-20', lastEtDate: d }], now)
    expect(at('2026-09-28').webContinuing).toBe(true)
    expect(at('2026-09-27').webContinuing).toBe(false)
    expect(at('2026-09-27').line).toBe('Play: not yet seen. Web /return/ rows last seen on 2026-09-27 ET.')
    expect(playReturnStatus([], now).line).toBe('Play: not yet seen. Web /return/ rows not seen either.')
  })
  it('first app row reports the ET day it appeared on, never the hour', () => {
    const p = playReturnStatus([{ site: 'bestsudoku-app', count: 2, firstEtDate: '2026-09-29', lastEtDate: '2026-09-29' }], now)
    expect(p.appSeen).toBe(true)
    expect(p.appFirstSeenEt).toBe('2026-09-29 ET')
    expect(p.line).toBe('Play: bestsudoku-app /return/ rows first seen on 2026-09-29 ET (2 app rows since go-live).')
    noTime(p.line)
  })
})

describe('release health (missing child of a non-zero parent)', () => {
  // The [1, 12) ET "quiet window" gate (releaseHealthGate/HEALTH_QUIET_WINDOW_ET) was RETIRED
  // 2026-09-27 when the 23:15 ET backstop entry was folded into a single daily morning read:
  // it existed only to defer evaluation from an 08:00 run to a separate 23:15 run, and with
  // one run left it would have silently suppressed release health forever at whatever hour
  // that run is scheduled (08:00, then moved same-day to 06:00). Maturity is enforced
  // independently below via parentAgeHours against event timestamps, not the clock — see
  // scripts/ads-reads/read.test.ts for the end-to-end "evaluates regardless of hour" case.
  it('parent zero never alerts; a child clears; small parents only watch; big parents with no child alert', () => {
    const res = evaluateHealthPairs([
      { id: 'a', parentLabel: 'p', parent: 0, childLabel: 'c', children: 0 },
      { id: 'b', parentLabel: 'p', parent: 9, childLabel: 'c', children: 1 },
      { id: 'c', parentLabel: 'p', parent: 3, childLabel: 'c', children: 0 },
      { id: 'd', parentLabel: 'p', parent: 9, childLabel: 'c', children: 0 },
      { id: 'e', parentLabel: 'p', parent: 9, childLabel: 'c', children: 0, knownGap: 'gap' },
    ])
    expect(res.map((r) => r.status)).toEqual(['parent-zero', 'ok', 'watch', 'alert', 'known-gap'])
  })
  it('since the fix, install ACCEPTS >= MIN_COHORT with no installed outcome is a real ALERT (a continued zero is raised)', () => {
    const accepts = (count: number, postInstallFix = true) =>
      summarizeSiteEvents([{ hourStartMs: H('2026-09-27T18:00:00Z'), path: '/install/pwa-accept', count, postInstallFix }], H('2026-09-30T00:00:00Z'))
    const pair = (site: ReturnType<typeof summarizeSiteEvents>, installFixedAtMs?: number | null) =>
      evaluateHealthPairs(buildHealthPairs({ site, taggedArrivalsMatured: 0, returnD0Web: 0, ...(installFixedAtMs !== undefined ? { installFixedAtMs } : {}) })).find((r) => r.id === 'install-accept→installed')!
    expect(pair(accepts(MIN_COHORT))).toMatchObject({ status: 'alert', parent: MIN_COHORT, children: 0 })
    expect(pair(accepts(MIN_COHORT - 1)).status).toBe('watch')
    expect(pair(accepts(9, false)).status).toBe('parent-zero') // pre-fix accepts never count
    expect(pair(accepts(9)).parentLabel).toMatch(/\/install\/pwa-accept/)
    // install PROMPT shown is no longer the parent
    const shownOnly = summarizeSiteEvents([{ hourStartMs: H('2026-09-27T18:00:00Z'), path: '/install/prompt/android', count: 9 }], H('2026-09-30T00:00:00Z'))
    expect(pair(shownOnly).status).toBe('parent-zero')
    // an installed outcome after the fix clears it
    const cleared = summarizeSiteEvents(
      [
        { hourStartMs: H('2026-09-27T18:00:00Z'), path: '/install/pwa-accept', count: 9, postInstallFix: true },
        { hourStartMs: H('2026-09-27T19:00:00Z'), path: '/popup-outcome/install-prompt/installed', count: 1, postInstallFix: true },
      ],
      H('2026-09-30T00:00:00Z'),
    )
    expect(pair(cleared).status).toBe('ok')
    // only while the fix is unset (null) is it a known gap
    expect(pair(accepts(9), null).status).toBe('known-gap')
  })
  it('an accept younger than the outcome window is not yet a parent', () => {
    const site = summarizeSiteEvents([{ hourStartMs: H('2026-09-29T23:00:00Z'), path: '/install/pwa-accept', count: 9, postInstallFix: true }], H('2026-09-29T20:00:00Z'))
    expect(evaluateHealthPairs(buildHealthPairs({ site, taggedArrivalsMatured: 0, returnD0Web: 0 })).find((r) => r.id === 'install-accept→installed')!.status).toBe('parent-zero')
  })
  it('tagged arrivals with no /return/ d0 at all alert (the landing load fires d0)', () => {
    const site = summarizeSiteEvents([], 0)
    const res = evaluateHealthPairs(buildHealthPairs({ site, taggedArrivalsMatured: 12, returnD0Web: 0 }))
    expect(res.find((r) => r.id === 'tagged-arrival→return-d0')!.status).toBe('alert')
  })
})

describe('readings log is append-only', () => {
  const base: ReadingRecord = {
    v: 1,
    id: readingId('daily', '2026-09-27T12:05:00Z', undefined, RETEST_CAMPAIGN_ID),
    campaignId: RETEST_CAMPAIGN_ID,
    kind: 'daily',
    readAt: '2026-09-27T12:05:00Z',
    etDate: '2026-09-27',
    spendThroughEt: '2026-09-26',
    cumulativeSpend: 10,
    thresholds: [],
    complete: true,
    rules: null,
    proposal: null,
    decision: null,
    counts: {},
    notes: [],
  }
  it('a same-day rerun of the same entry is a no-op (owner, 2026-09-26: no duplicate rows); the first row is never replaced', () => {
    const second = { ...base, id: readingId('daily', '2026-09-27T14:00:00Z', undefined, RETEST_CAMPAIGN_ID), readAt: '2026-09-27T14:00:00Z' }
    const log = appendReading(appendReading(null, base), second)
    expect(log.readings.map((r) => r.readAt)).toEqual(['2026-09-27T12:05:00Z'])
  })
  it('a same-day line that carries new information (a pause proposal) is appended next to the first', () => {
    const second = { ...base, id: readingId('daily', '2026-09-27T14:00:00Z', undefined, RETEST_CAMPAIGN_ID), readAt: '2026-09-27T14:00:00Z', proposal: 'PROPOSE PAUSE' }
    const log = appendReading(appendReading(null, base), second)
    expect(log.readings.map((r) => r.entryKind)).toEqual(['morning', 'morning+pause'])
  })
  it('the next day gets its own line', () => {
    const next = { ...base, id: readingId('daily', '2026-09-28T12:05:00Z', undefined, RETEST_CAMPAIGN_ID), readAt: '2026-09-28T12:05:00Z', etDate: '2026-09-28' }
    expect(appendReading(appendReading(null, base), next).readings).toHaveLength(2)
  })
  it('a retried insert of the same id is a no-op', () => {
    expect(appendReading(appendReading(null, base), base).readings).toHaveLength(1)
  })
  it('entry kinds: the entry plus the facts that make a rerun worth a row', () => {
    expect(readingEntryKind(base)).toBe('morning')
    expect(readingEntryKind({ ...base, complete: false })).toBe('morning+incomplete')
    expect(readingEntryKind({ ...base, proposal: 'PROPOSE PAUSE' })).toBe('morning+pause')
    expect(readingEntryKind({ ...base, kind: 'threshold', thresholds: [75, 50] })).toBe('threshold-50-75')
    expect(readingEntryKind({ ...base, kind: 'postflight', stage: 'day15' })).toBe('postflight-day15')
    expect(readingEntryKind({ ...base, kind: 'health', notes: ['ALERT install-accept→installed: x 6, y 0', 'ALERT signin-prompt→outcomes: a 9, b 0'] })).toBe(
      'backstop+alert-install-accept-installed+alert-signin-prompt-outcomes',
    )
    expect(readingEntryKind({ ...base, kind: 'health' })).toBe('backstop')
  })
  it('planReadingAppends: a same-day repeat is skipped, an incomplete rerun after a complete read is skipped, new information is appended', () => {
    const stored = [{ ...base, entryKind: 'morning' }]
    const at = (h: string) => ({ id: `daily:${h}`, readAt: `2026-09-27T${h}:00:00Z` })
    const plan = planReadingAppends(
      [
        { ...base, ...at('14') }, // same entry -> skip
        { ...base, ...at('15'), complete: false }, // less information than the stored complete read -> skip
        { ...base, ...at('16'), proposal: 'PROPOSE PAUSE' }, // new: a pause proposal
        { ...base, ...at('16'), id: 'threshold:x', kind: 'threshold', thresholds: [50] }, // new entry
      ],
      stored,
    )
    expect(plan.append.map((r) => r.entryKind)).toEqual(['morning+pause', 'threshold-50'])
    expect(plan.skip.map((s) => s.reason)).toEqual(['already recorded today (morning)', 'a complete morning read is already recorded today'])
    // an incomplete first read, then a complete retry: the retry is new
    expect(planReadingAppends([{ ...base, ...at('14') }], [{ ...base, complete: false }]).append).toHaveLength(1)
    // another day never collides
    expect(planReadingAppends([{ ...base, etDate: '2026-09-28' }], stored).append).toHaveLength(1)
  })
  it('reading keys are unique per kind, campaign, stage and instant', () => {
    expect(readingId('postflight', '2026-10-09T12:00:00Z', 'wrapup', RETEST_CAMPAIGN_ID)).toBe(`postflight:${RETEST_CAMPAIGN_ID}:wrapup:2026-10-09T12:00:00Z`)
  })
})

describe('missingDailyReads (a scheduled read that never ran)', () => {
  const daily = (etDate: string): ReadingRecord => ({
    v: 1, id: `daily:${etDate}`, campaignId: RETEST_CAMPAIGN_ID, kind: 'daily', readAt: `${etDate}T12:05:00Z`, etDate,
    spendThroughEt: null, cumulativeSpend: null, thresholds: [], complete: true, rules: null, proposal: null, decision: null, counts: {}, notes: [],
  })
  const W = [plan.morningReadFirstEt, plan.morningReadLastEt] as const
  it('the window is the routine schedule', () => {
    expect(W).toEqual(['2026-09-27', '2026-10-03'])
  })
  it('the first scheduled run has nothing to miss', () => {
    expect(missingDailyReads([], '2026-09-27', ...W)).toEqual([])
  })
  it('lists the dates since the last daily line, up to yesterday', () => {
    expect(missingDailyReads([daily('2026-09-27')], '2026-09-30', ...W)).toEqual(['2026-09-28', '2026-09-29'])
    expect(missingDailyReads([], '2026-09-29', ...W)).toEqual(['2026-09-27', '2026-09-28'])
  })
  it('older gaps are not repeated once a later read landed; non-daily records do not count', () => {
    expect(missingDailyReads([daily('2026-09-27'), daily('2026-09-29')], '2026-09-30', ...W)).toEqual([])
    expect(missingDailyReads([daily('2026-09-28'), { ...daily('2026-09-29'), kind: 'threshold' }], '2026-09-30', ...W)).toEqual(['2026-09-29'])
  })
  it('stops at the end of the window', () => {
    expect(missingDailyReads([daily('2026-10-02')], '2026-10-06', ...W)).toEqual(['2026-10-03'])
  })
})

describe('post-flight schedule', () => {
  it('every stage is keyed to the FLIGHT END (10-02), so continued spend can never push it away', () => {
    expect(postflightDueDate('wrapup', '2026-10-02')).toBe('2026-10-09')
    expect(postflightDueDate('day15', '2026-10-02')).toBe('2026-10-17')
    expect(postflightDueDate('day30', '2026-10-02')).toBe('2026-11-01')
    expect(postflightDueDate('day60', '2026-10-02')).toBe('2026-12-01')
    expect(postflightDueDate('december', '2026-10-02')).toBe('2026-12-03')
  })
})

describe('backfill check against the hand-entered config', () => {
  it('matches the known totals and flags a differing day and spend outside the flight', () => {
    const c = campaignById('24234347705')!
    const api = {
      '2026-09-09': { costMicros: 21_560_000, impressions: 1, clicks: 1 },
      '2026-09-10': { costMicros: 13_520_000, impressions: 1, clicks: 1 },
      '2026-09-14': { costMicros: 1_000_000, impressions: 1, clicks: 1 },
    }
    const cmp = compareSpendToConfig(c, api, { '2026-09-09': 21.56, '2026-09-10': 13.5 }, 36.06)
    expect(cmp.apiTotal).toBe(36.08)
    expect(cmp.totalDiff).toBe(0.02)
    expect(cmp.dayDiffs.map((d) => d.date)).toEqual(['2026-09-10', '2026-09-14'])
    expect(cmp.outsideFlight).toEqual([{ date: '2026-09-14', api: 1 }])
  })
})

describe('caveat wording shared with the dashboard', () => {
  it('the routine says exactly what the pop-ups page says about late outcomes', () => {
    expect(MEASUREMENT_QUIET_NOTE).toBe(POPUP_PAGE_NOTE)
  })
})

describe('first-session funnel (informational only)', () => {
  const tagged = [
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/', visitor: 'new', count: 20 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/game', visitor: 'returning', count: 40 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/tour/start', visitor: 'returning', count: 10 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/tour/complete', visitor: 'returning', count: 4 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/tour/skip', visitor: 'returning', count: 5 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/game/complete/normal/easy', visitor: 'returning', count: 2 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/game/abandon/0', visitor: 'returning', count: 6 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/game/abandon/26-50', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/game/abandon/bogus', visitor: 'returning', count: 9 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/signin-prompt/tutorial', visitor: 'returning', count: 2 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/signin-prompt/placement', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/signin-prompt/dismiss', visitor: 'returning', count: 3 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/welcome-signed-in/shown', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/welcome-signed-in/daily', visitor: 'returning', count: 1 },
    // a tagged d0 row is never counted from the tagged rows (arrivals come from the path-attributed read)
    { hourStartMs: H('2026-09-30T12:00:00Z'), path: '/return/sudoku_funnel_retest/d0', visitor: 'new', count: 99 },
  ]
  // path-attributed d0 rows: one per device's first tagged visit; another campaign's uc is not ours
  const arrivals = { rows: [{ path: '/return/sudoku_funnel_retest/d0', count: 18 }, { path: '/return/other_flight/d0', count: 7 }, { path: '/return/sudoku_funnel_retest/d1', count: 4 }], ucValues: ['sudoku_funnel_retest'] }
  const site = [
    { path: '/return/sudoku_funnel_retest/d0', count: 25 },
    { path: '/return/other_flight/d0', count: 280 },
    { path: '/return/other_flight/d1', count: 50 },
    { path: '/game', count: 900 },
    { path: '/tour/start', count: 120 },
    { path: '/tour/complete', count: 50 },
    { path: '/tour/skip', count: 60 },
    { path: '/game/complete/daily/hard', count: 30 },
    { path: '/game/abandon/0', count: 70 },
    { path: '/signin-prompt/tutorial', count: 8 },
    { path: '/welcome-signed-in/shown', count: 3 },
  ]

  it('buckets exactly the new beacon paths, never an unknown abandon bucket or welcome action', () => {
    expect(firstSessionBucket('/game')).toEqual({ kind: 'step', step: 'gameView' })
    expect(firstSessionBucket('/game/first-move')).toEqual({ kind: 'step', step: 'firstMove' })
    expect(firstSessionBucket('/game/complete/normal/easy')).toEqual({ kind: 'step', step: 'gameComplete' })
    expect(firstSessionBucket('/game/abandon/76-99')).toEqual({ kind: 'abandon', bucket: '76-99' })
    expect(firstSessionBucket('/game/abandon/100')).toBeNull()
    expect(firstSessionBucket('/welcome-signed-in/leaderboard')).toEqual({ kind: 'welcome', event: 'leaderboard' })
    expect(firstSessionBucket('/welcome-signed-in/other')).toBeNull()
    expect(firstSessionBucket('/signin-prompt/tutorial')).toEqual({ kind: 'ask', tutorial: true })
    expect(firstSessionBucket('/signin-prompt/dismiss')).toBeNull()
    expect(firstSessionBucket('/tour/start/')).toBeNull()
    expect(firstSessionBucket('/return/sudoku_funnel_retest/d0')).toEqual({ kind: 'arrival', uc: 'sudoku_funnel_retest' })
    expect(firstSessionBucket('/return/sudoku_funnel_retest/d1')).toBeNull()
  })

  it('tallies arrivals as /return/<uc>/d0 devices: tagged by the campaign uc, site-wide any uc', () => {
    const t = tallyTaggedFirstSession(tagged, arrivals)
    expect(t.steps).toEqual({ arrivals: 18, gameView: 40, tourStart: 10, tourComplete: 4, tourSkip: 5, firstMove: 0, gameComplete: 2 })
    expect(t.abandon).toEqual({ '0': 6, '1-25': 0, '26-50': 1, '51-75': 0, '76-99': 0 })
    expect(t.asks).toBe(3)
    expect(t.asksTutorial).toBe(2)
    expect(t.welcome).toEqual({ shown: 1, daily: 1, leaderboard: 0, dismiss: 0 })
    expect(tallySiteFirstSession(site).steps.arrivals).toBe(305)
  })

  it('tracking is per beacon family: once a sibling has rows, a step with none is a real 0, not "not yet tracked"', () => {
    const f = buildFirstSessionFunnel(tallyTaggedFirstSession(tagged, arrivals), tallySiteFirstSession(site))
    expect(f.steps.arrivals).toMatchObject({ tagged: 18, site: 305, tracked: true })
    expect(f.siteRead).toBe(true)
    // first move ships with the tour and abandon beacons, which have rows: a real zero.
    expect(f.steps.firstMove).toEqual({ tagged: 0, site: 0, tracked: true, vsParent: null })
    expect(f.steps.gameComplete.vsParent).toMatchObject({ parent: 'firstMove', numerator: 2, denominator: 0, value: null })
    expect(f.steps.tourComplete.vsParent).toMatchObject({ parent: 'tourStart', numerator: 4, denominator: 10, value: 0.4 })
    // nothing divides by game views (page-view rows against once-per-event beacons mixes units).
    expect(f.steps.tourStart.vsParent).toBeNull()
    expect(f.steps.gameView.vsParent).toBeNull()
    expect(f.steps.arrivals.vsParent).toBeNull()
    expect(f.abandon['1-25']).toEqual({ tagged: 0, site: 0, tracked: true })
    expect(f.abandon['76-99'].tracked).toBe(true)
    expect(f.abandon['0']).toEqual({ tagged: 6, site: 70, tracked: true })
    // a tagged row proves the path is live even when the site-wide (web) read has none
    expect(f.abandon['26-50']).toEqual({ tagged: 1, site: 0, tracked: true })
    // welcome is its own family: shown has rows, so dismiss / leaderboard are real zeros.
    expect(f.welcome.dismiss).toEqual({ tagged: 0, site: 0, tracked: true })
    expect(f.welcome.leaderboard.tracked).toBe(true)
    expect(f.asksTutorial).toEqual({ tagged: 2, site: 8, tracked: true })
  })

  it('a family with no rows anywhere is not yet tracked, never a 0% step; its ratios are skipped and children fall back', () => {
    const f = buildFirstSessionFunnel(
      tallyTaggedFirstSession([{ hourStartMs: 0, path: '/game', visitor: 'new', count: 10 }, { hourStartMs: 0, path: '/game/complete/daily/easy', visitor: 'returning', count: 2 }], { rows: [], ucValues: ['x'] }),
      tallySiteFirstSession([{ path: '/game', count: 50 }]),
    )
    for (const k of ['tourStart', 'tourComplete', 'tourSkip', 'firstMove'] as const) expect(f.steps[k]).toEqual({ tagged: 0, site: 0, tracked: false, vsParent: null })
    for (const b of ['0', '1-25', '26-50', '51-75', '76-99'] as const) expect(f.abandon[b].tracked).toBe(false)
    for (const e of ['shown', 'daily', 'leaderboard', 'dismiss'] as const) expect(f.welcome[e].tracked).toBe(false)
    expect(f.asksTutorial.tracked).toBe(false)
    // game complete's parent (first move) is untracked and has no parent of its own.
    expect(f.steps.gameComplete).toMatchObject({ tagged: 2, tracked: true, vsParent: null })
  })

  it('families are independent: the tour release being live does not mark welcome or the tutorial ask tracked', () => {
    const f = buildFirstSessionFunnel(tallyTaggedFirstSession([], { rows: [], ucValues: ['x'] }), tallySiteFirstSession([{ path: '/game/abandon/0', count: 3 }]))
    expect(f.steps.tourStart).toMatchObject({ tagged: 0, site: 0, tracked: true })
    expect(f.steps.firstMove.tracked).toBe(true)
    expect(f.welcome.shown.tracked).toBe(false)
    expect(f.asksTutorial.tracked).toBe(false)
    const w = buildFirstSessionFunnel(tallyTaggedFirstSession([], { rows: [], ucValues: ['x'] }), tallySiteFirstSession([{ path: '/welcome-signed-in/daily', count: 1 }]))
    expect(w.welcome.shown).toEqual({ tagged: 0, site: 0, tracked: true })
    expect(w.steps.tourStart.tracked).toBe(false)
  })

  it('without the site-wide read tracking is unknown unless a tagged row in the family proves it, and ratios still use the tagged counts', () => {
    const f = buildFirstSessionFunnel(tallyTaggedFirstSession(tagged, arrivals), null)
    expect(f.siteRead).toBe(false)
    expect(f.steps.firstMove).toMatchObject({ tagged: 0, site: null, tracked: true }) // tour start's tagged rows prove the release
    expect(f.steps.tourStart).toMatchObject({ tagged: 10, site: null, tracked: true })
    expect(f.steps.gameComplete.vsParent).toMatchObject({ parent: 'firstMove', numerator: 2, denominator: 0, value: null })
    const none = buildFirstSessionFunnel(tallyTaggedFirstSession([], null), null)
    expect(none.steps.firstMove.tracked).toBeNull()
    // a failed arrivals read is unknown, never 0
    expect(none.steps.arrivals).toMatchObject({ tagged: null, site: null, tracked: null })
    expect(none.welcome.shown.tracked).toBeNull()
  })
})

// v1.97.0 count-only beacons (live on prod web 2026-10-03; first row 17:03:40Z): a tour exit by
// stage, a counted game start by difficulty, the tutorial win (first run vs replay). Counter
// totals only, matched by path: no row is joined to a device, a time or a place.
describe('first-session funnel: v1.97.0 first-run counters', () => {
  const at = H('2026-10-03T18:00:00Z')
  const tagged = [
    { hourStartMs: at, path: '/tour/exit-at/preamble', visitor: 'v', count: 2 },
    { hourStartMs: at, path: '/tour/exit-at/hub', visitor: 'v', count: 3 },
    { hourStartMs: at, path: '/tour/exit-at/section', visitor: 'v', count: 1 },
    { hourStartMs: at, path: '/tour/exit-at/elsewhere', visitor: 'v', count: 50 }, // unknown stage: never guessed at
    { hourStartMs: at, path: '/game/start/easy', visitor: 'v', count: 6 },
    { hourStartMs: at, path: '/game/start/hard', visitor: 'v', count: 2 },
    { hourStartMs: at, path: '/game/start/unknown', visitor: 'v', count: 1 },
    { hourStartMs: at, path: '/game/start/impossible', visitor: 'v', count: 40 }, // unknown difficulty
    { hourStartMs: at, path: '/game/tutorial-complete/first-run', visitor: 'v', count: 1 },
    { hourStartMs: at, path: '/game/tutorial-complete/replay', visitor: 'v', count: 4 },
    { hourStartMs: at, path: '/game/tutorial-complete/other', visitor: 'v', count: 30 }, // unknown variant
    { hourStartMs: at, path: '/game/complete/normal/easy', visitor: 'v', count: 5 },
  ]
  const site = [
    { path: '/tour/exit-at/preamble', count: 20 },
    { path: '/tour/exit-at/hub', count: 30 },
    { path: '/tour/exit-at/section', count: 10 },
    { path: '/game/start/easy', count: 90 },
    { path: '/game/start/medium', count: 40 },
    { path: '/game/start/hard', count: 20 },
    { path: '/game/start/expert', count: 7 },
    { path: '/game/start/unknown', count: 3 },
    { path: '/game/tutorial-complete/first-run', count: 2 },
    { path: '/game/tutorial-complete/replay', count: 11 },
    { path: '/game/complete/normal/easy', count: 55 },
  ]
  const noArrivals = { rows: [], ucValues: ['x'] }

  it('buckets each new path by its stage / difficulty / variant, and nothing it does not know', () => {
    for (const stage of ['preamble', 'hub', 'section'] as const) expect(firstSessionBucket(`/tour/exit-at/${stage}`)).toEqual({ kind: 'tourExit', stage })
    for (const difficulty of ['easy', 'medium', 'hard', 'expert', 'unknown'] as const) expect(firstSessionBucket(`/game/start/${difficulty}`)).toEqual({ kind: 'gameStart', difficulty })
    for (const variant of ['first-run', 'replay'] as const) expect(firstSessionBucket(`/game/tutorial-complete/${variant}`)).toEqual({ kind: 'tutorialComplete', variant })
    for (const p of ['/tour/exit-at/', '/tour/exit-at/hub/', '/tour/exit-at/Hub', '/tour/exit-at', '/game/start', '/game/start/', '/game/start/easy/extra', '/game/tutorial-complete', '/game/tutorial-complete/first_run', '/game/tutorial-complete/replay/x']) {
      expect(firstSessionBucket(p), p).toBeNull()
    }
    // the existing buckets are untouched
    expect(firstSessionBucket('/game')).toEqual({ kind: 'step', step: 'gameView' })
    expect(firstSessionBucket('/tour/skip')).toEqual({ kind: 'step', step: 'tourSkip' })
    expect(firstSessionBucket('/game/complete/normal/easy')).toEqual({ kind: 'step', step: 'gameComplete' })
  })

  it('tallies each bucket as a counter total (tagged and site-wide), ignoring unknown suffixes', () => {
    const t = tallyTaggedFirstSession(tagged, noArrivals)
    expect(t.tourExit).toEqual({ preamble: 2, hub: 3, section: 1 })
    expect(t.gameStart).toEqual({ easy: 6, medium: 0, hard: 2, expert: 0, unknown: 1 })
    expect(t.tutorialComplete).toEqual({ 'first-run': 1, replay: 4 })
    expect(t.steps.gameComplete).toBe(5)
    const s = tallySiteFirstSession(site)
    expect(s.tourExit).toEqual({ preamble: 20, hub: 30, section: 10 })
    expect(s.gameStart).toEqual({ easy: 90, medium: 40, hard: 20, expert: 7, unknown: 3 })
    expect(s.tutorialComplete).toEqual({ 'first-run': 2, replay: 11 })
    expect(s.steps.gameComplete).toBe(55)
  })

  it('the funnel carries every new bucket as a tagged / site-wide figure, tracked once any of them has a row', () => {
    const f = buildFirstSessionFunnel(tallyTaggedFirstSession(tagged, noArrivals), tallySiteFirstSession(site))
    expect(f.tourExit.hub).toEqual({ tagged: 3, site: 30, tracked: true })
    expect(f.gameStart.easy).toEqual({ tagged: 6, site: 90, tracked: true })
    expect(f.gameStart.expert).toEqual({ tagged: 0, site: 7, tracked: true })
    expect(f.tutorialComplete['first-run']).toEqual({ tagged: 1, site: 2, tracked: true })
    expect(f.tutorialComplete.replay).toEqual({ tagged: 4, site: 11, tracked: true })
    // Plain counters, no ratio: a start cannot be matched to the exit that led to it.
    expect(Object.keys(f.gameStart.easy).sort()).toEqual(['site', 'tagged', 'tracked'])
  })

  it('one release, one family: a sibling with no rows reads a real 0 once any first-run counter has a row', () => {
    const f = buildFirstSessionFunnel(tallyTaggedFirstSession([], noArrivals), tallySiteFirstSession([{ path: '/game/start/medium', count: 1 }]))
    expect(f.gameStart.medium).toEqual({ tagged: 0, site: 1, tracked: true })
    expect(f.tourExit.preamble).toEqual({ tagged: 0, site: 0, tracked: true })
    expect(f.tutorialComplete['first-run']).toEqual({ tagged: 0, site: 0, tracked: true })
    // a tagged row alone proves the release as well, when the site-wide read has none
    const g = buildFirstSessionFunnel(tallyTaggedFirstSession([{ hourStartMs: at, path: '/tour/exit-at/hub', visitor: 'v', count: 1 }], noArrivals), tallySiteFirstSession([]))
    expect(g.tutorialComplete.replay).toEqual({ tagged: 0, site: 0, tracked: true })
  })

  it('a pre-1.97.0 read (no new counters) is not yet tracked, never a zero, and cannot error', () => {
    const preRelease = [{ path: '/game', count: 50 }, { path: '/tour/start', count: 9 }, { path: '/game/abandon/0', count: 3 }, { path: '/game/complete/daily/easy', count: 4 }]
    const f = buildFirstSessionFunnel(tallyTaggedFirstSession([{ hourStartMs: at, path: '/game', visitor: 'v', count: 4 }], noArrivals), tallySiteFirstSession(preRelease))
    for (const s of ['preamble', 'hub', 'section'] as const) expect(f.tourExit[s]).toEqual({ tagged: 0, site: 0, tracked: false })
    for (const d of ['easy', 'medium', 'hard', 'expert', 'unknown'] as const) expect(f.gameStart[d]).toEqual({ tagged: 0, site: 0, tracked: false })
    for (const v of ['first-run', 'replay'] as const) expect(f.tutorialComplete[v]).toEqual({ tagged: 0, site: 0, tracked: false })
    // the tour / abandon release being live does not make the v1.97.0 counters tracked
    expect(f.steps.tourStart.tracked).toBe(true)
    // with no site-wide read at all, tracking is unknown, not 0
    const none = buildFirstSessionFunnel(tallyTaggedFirstSession([], null), null)
    expect(none.tourExit.hub).toEqual({ tagged: 0, site: null, tracked: null })
    expect(none.gameStart.easy.tracked).toBeNull()
    expect(none.tutorialComplete.replay.tracked).toBeNull()
  })
})
