import { describe, expect, it } from 'vitest'
import {
  ADS_READ_PLANS,
  appendReading,
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
  releaseHealthGate,
  resolveCampaignSpend,
  RETEST_APPROVED_PLACEMENTS,
  RETEST_CAMPAIGN_ID,
  signUpsAtMost,
  signUpsAtMostLabel,
  SIGNUP_PROXY_NOTE,
  AUTH_SUCCESS_SPLIT_RECOMMENDATION,
  servingStateOf,
  canProposePause,
  noPauseNote,
  proposalLabel,
  deriveCohortTiers,
  COHORT_TIER_STAGES,
  spendTotals,
  summarizeReturns,
  summarizeSiteEvents,
  summarizeTaggedRows,
  type KillRuleInput,
  type ReadingRecord,
  type StoredSpend,
} from './adsRules'
import { campaignById } from './campaigns'
import { MIN_COHORT, POPUP_PAGE_NOTE } from './popupEvents'

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
    apiVersion: 'v22',
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
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/promo-first50/shown', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/signin-prompt/dismiss', visitor: 'returning', count: 2 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/promo-first50/dismiss', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-28T18:00:00Z'), path: '/promo-first50/accept', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-28T19:00:00Z'), path: '/install/pwa-installed', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-28T19:00:00Z'), path: '/install/standalone-detected', visitor: 'returning', count: 1 },
    { hourStartMs: H('2026-09-28T19:00:00Z'), path: '/popup-outcome/install-prompt/installed', visitor: 'returning', count: 1 },
  ]
  it('asks are EXACTLY placement + streak + promo-first50/shown; any other reason is reported separately', () => {
    const s = summarizeTaggedRows(rows)
    expect(s.asks.total).toBe(4)
    expect(s.asks.byPath).toEqual({ '/signin-prompt/placement': 2, '/signin-prompt/streak': 1, '/promo-first50/shown': 1 })
    expect(s.asks.otherShownReasons).toBe(4)
    expect(s.accepts.total).toBe(1)
  })
  it('dismisses are kept per dialog, never summed', () => {
    expect(summarizeTaggedRows(rows).dismisses).toEqual({ signinPrompt: 2, promoFirst50: 1 })
  })
  it('arrivals are visitor=new rows; hits are every row', () => {
    const s = summarizeTaggedRows(rows)
    expect(s.taggedArrivals).toBe(15)
    expect(s.taggedHits).toBe(50)
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
  it('installShownFromMs keeps pre-fix install prompts out of the parent', () => {
    const s = summarizeSiteEvents(rows, now, H('2026-09-29T04:00:00Z'))
    expect(s.shownMatured.install).toBe(0)
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
  it('not yet seen, web continuing', () => {
    const p = playReturnStatus([{ site: 'bestsudoku-web', count: 10, firstMs: H('2026-09-26T16:00:00Z'), lastMs: H('2026-09-29T23:00:00Z') }], now)
    expect(p.appSeen).toBe(false)
    expect(p.webContinuing).toBe(true)
    expect(p.line).toMatch(/not yet seen.*pipeline works/)
  })
  it('first app row reports when it appeared', () => {
    const p = playReturnStatus([{ site: 'bestsudoku-app', count: 2, firstMs: H('2026-09-29T14:20:00Z'), lastMs: H('2026-09-29T15:00:00Z') }], now)
    expect(p.appSeen).toBe(true)
    expect(p.appFirstSeenEt).toBe('2026-09-29 10:00 ET')
  })
})

describe('release health (missing child of a non-zero parent)', () => {
  it('never evaluates between 01:00 and 12:00 ET', () => {
    expect(releaseHealthGate(H('2026-09-27T12:00:00Z')).evaluate).toBe(false) // 08:00 ET
    expect(releaseHealthGate(H('2026-09-27T05:00:00Z')).evaluate).toBe(false) // 01:00 ET
    expect(releaseHealthGate(H('2026-09-27T15:59:00Z')).evaluate).toBe(false) // 11:59 ET
    expect(releaseHealthGate(H('2026-09-27T16:00:00Z')).evaluate).toBe(true) // 12:00 ET
    expect(releaseHealthGate(H('2026-09-28T03:30:00Z')).evaluate).toBe(true) // 23:30 ET
    expect(releaseHealthGate(H('2026-09-28T04:30:00Z')).evaluate).toBe(true) // 00:30 ET
  })
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
  it('install prompt → installed is a KNOWN GAP while the fix date is unset, and alerts normally once it is set', () => {
    const site = summarizeSiteEvents([{ hourStartMs: H('2026-09-27T18:00:00Z'), path: '/install/prompt/android', count: 9 }], H('2026-09-30T00:00:00Z'))
    const open = evaluateHealthPairs(buildHealthPairs({ site, taggedArrivalsMatured: 0, returnD0Web: 0 }))
    expect(open.find((r) => r.id === 'install-prompt→install-outcome')!.status).toBe('known-gap')
    const fixed = evaluateHealthPairs(buildHealthPairs({ site, taggedArrivalsMatured: 0, returnD0Web: 0, installFixedEt: '2026-09-27' }))
    expect(fixed.find((r) => r.id === 'install-prompt→install-outcome')!.status).toBe('alert')
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
  it('a second daily line on the same day is appended, never replacing the first', () => {
    const second = { ...base, id: readingId('daily', '2026-09-27T14:00:00Z', undefined, RETEST_CAMPAIGN_ID), readAt: '2026-09-27T14:00:00Z' }
    const log = appendReading(appendReading(null, base), second)
    expect(log.readings.map((r) => r.readAt)).toEqual(['2026-09-27T12:05:00Z', '2026-09-27T14:00:00Z'])
  })
  it('a retried insert of the same id is a no-op', () => {
    expect(appendReading(appendReading(null, base), base).readings).toHaveLength(1)
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
  it('wrap-up is spend end + 7; follow-ups count from the last serving day; december waits for d31-60', () => {
    expect(postflightDueDate('wrapup', '2026-10-02', '2026-10-02')).toBe('2026-10-09')
    expect(postflightDueDate('wrapup', '2026-09-30', '2026-10-02')).toBe('2026-10-07') // cap hit early
    expect(postflightDueDate('day15', '2026-10-02', '2026-10-02')).toBe('2026-10-17')
    expect(postflightDueDate('day30', '2026-10-02', '2026-10-02')).toBe('2026-11-01')
    expect(postflightDueDate('day60', '2026-10-02', '2026-10-02')).toBe('2026-12-01')
    expect(postflightDueDate('december', '2026-10-02', '2026-10-02')).toBe('2026-12-03')
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
