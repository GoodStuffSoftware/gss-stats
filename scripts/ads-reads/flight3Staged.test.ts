// Flight 3's two Google Ads campaigns exist (created PAUSED 2026-10-16); their ids are in
// STAGED_FLIGHT_3[arm].ids. An arm is registered ONLY once both its dates are filled in
// STAGED_FLIGHT_3_DATES (campaigns.ts), the whole activation in code. These tests pin (1) the staged
// values and ids against the launch plan and the created ids, (2) that null dates read nothing and
// filled dates register the arm with the right days (dates are INJECTED, so filling the real ones
// never turns this red; the real registry is hidden with hideLiveFlight3), (3) the day 1-2 tracking
// check on a filled-date arm, and (4) that the runbook the daily cloud routine follows carries the
// staged rows with a status it does not act on. Fixture only: no network, no credentials.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ADS_READ_PLANS,
  RETEST_APPROVED_PLACEMENTS,
  allDevicesOf,
  STAGED_FLIGHT_3_PLAN_SETTINGS,
  auditPathFor,
  channelOf,
  readPlanFor,
  reportLabelFor,
  liveStagedReadPlans,
  stagedReadPlan,
} from '../../src/lib/adsRules'
import {
  CAMPAIGNS,
  STAGED_ARMS,
  STAGED_FLIGHT_3,
  STAGED_FLIGHT_3_DATES,
  assertOrganicReserved,
  campaignAttributionClause,
  campaignAttributionStartMs,
  campaignById,
  flightDayIndex,
  liveLandingTags,
  liveStagedCampaigns,
  stagedArmIsLive,
  stagedCampaign,
  type StagedArmDates,
} from '../../src/lib/campaigns'
import { addDays } from '../../src/lib/etTime'
import { hideLiveFlight3 } from '../../src/testing/stagedFlight3'
import { fixtureDeps, resolveCampaignId, type Fixture } from './cli'
import { runMorningRead, type MorningOptions } from './read'
import { APPS_PLAY_RELEASE_CAVEAT, formatMorningReport } from './report'
import { MIN_COHORT } from '../../src/lib/popupEvents'

const here = path.dirname(fileURLToPath(import.meta.url))
const APPS_ID = '99900000011'
const SEARCH_ID = '99900000012'
const START = '2026-10-20'
const END = '2026-10-26'

// The registry as it is while flight 3 is staged, whatever the real STAGED_FLIGHT_3_DATES hold: these tests
// inject dates, and the registrations they make are removed with the real ones restored.
let restoreFlight3: () => void
beforeEach(() => { restoreFlight3 = hideLiveFlight3() })
afterEach(() => {
  for (const id of [APPS_ID, SEARCH_ID]) {
    const i = CAMPAIGNS.findIndex((c) => c.id === id)
    if (i >= 0) CAMPAIGNS.splice(i, 1)
    delete ADS_READ_PLANS[id]
  }
  restoreFlight3()
})

type Dates = Record<'apps' | 'search', StagedArmDates>
const NULL_DATES: Dates = { apps: { flightStart: null, flightEnd: null }, search: { flightStart: null, flightEnd: null } }
const APPS_ONLY: Dates = { ...NULL_DATES, apps: { flightStart: '2026-10-21', flightEnd: '2026-10-27' } }
const SEARCH_ONLY: Dates = { ...NULL_DATES, search: { flightStart: '2026-10-17', flightEnd: '2026-10-23' } }
const BOTH: Dates = { apps: APPS_ONLY.apps, search: SEARCH_ONLY.search }
const F3_APPS_ID = STAGED_FLIGHT_3.apps.ids.campaignId
const F3_SEARCH_ID = STAGED_FLIGHT_3.search.ids.campaignId
/** What filling the dates does in the real modules: the arm's campaign joins CAMPAIGNS and its plan ADS_READ_PLANS. */
function goLive(dates: Dates) {
  CAMPAIGNS.push(...liveStagedCampaigns(dates))
  Object.assign(ADS_READ_PLANS, liveStagedReadPlans(dates))
}

describe('flight 3 staged config matches the launch plan', () => {
  it('apps: tags sudoku_funnel_f3_apps_hero, _feat and the bare catch-all, $10/day, $70 cap, noon-ET schedule 12:00-24:00', () => {
    const c = STAGED_FLIGHT_3.apps
    expect(c.ucValues).toEqual(['sudoku_funnel_f3_apps_hero', 'sudoku_funnel_f3_apps_feat', 'sudoku_funnel_f3_apps'])
    expect([c.dailyBudgetUsd, c.hardCapUsd, c.flightStartTimeEt, c.servingHoursEt]).toEqual([10, 70, '12:00', [12, 24]])
    expect(c.notes).toContain('google / display / sudoku_funnel_f3_apps_hero and sudoku_funnel_f3_apps_feat')
  })
  it('search: tag sudoku_funnel_f3_search, $10/day, $70 cap, noon-ET schedule 12:00-24:00', () => {
    const c = STAGED_FLIGHT_3.search
    expect(c.ucValues).toEqual(['sudoku_funnel_f3_search'])
    expect([c.dailyBudgetUsd, c.hardCapUsd, c.flightStartTimeEt, c.servingHoursEt]).toEqual([10, 70, '12:00', [12, 24]])
    expect(c.notes).toContain('google / cpc / sudoku_funnel_f3_search')
  })
  it('apps plan settings: display, the 17 approved placements, flight 2 leak limit and CTR floor, the 18/35/53/70 ladder', () => {
    const s = STAGED_FLIGHT_3_PLAN_SETTINGS.apps
    expect(s.channel).toBeUndefined() // display is the default
    expect(s.approvedPlacements).toBe(RETEST_APPROVED_PLACEMENTS)
    expect(s.approvedPlacements).toHaveLength(17)
    expect(s.adGroupPlacementCounts).toEqual({ 'Sudoku.com placement': 1, 'Other Sudoku placements': 16 })
    expect([s.placementLeakMaxShare, s.ctrFloor, s.killRulesFrom, s.reportLabel, s.auditSlug]).toEqual([0.1, 0.0015, 35, 'F3 apps', 'f3-apps'])
    expect(s.thresholds).toEqual([18, 35, 53, 70])
  })
  it('search plan settings: channel search, no placements, CTR floor 1%, the same ladder', () => {
    const s = STAGED_FLIGHT_3_PLAN_SETTINGS.search
    expect(s.channel).toBe('search')
    expect(s.approvedPlacements).toBeUndefined()
    expect(s.adGroupPlacementCounts).toBeUndefined()
    expect(s.placementLeakMaxShare).toBeUndefined()
    expect([s.ctrFloor, s.killRulesFrom, s.reportLabel, s.auditSlug]).toEqual([0.01, 35, 'F3 search', 'f3-search'])
    expect(s.thresholds).toEqual([18, 35, 53, 70])
  })
  it('the ladder tops out at the cap, so the last read IS the $70 cap', () => {
    for (const arm of ['apps', 'search'] as const) {
      expect(STAGED_FLIGHT_3_PLAN_SETTINGS[arm].thresholds.at(-1)).toBe(STAGED_FLIGHT_3[arm].hardCapUsd)
    }
  })
})

describe('flight 3 ids are the ones the build created (created-ids.json, 2026-10-16)', () => {
  it('apps: campaign, budget, ad group with its max CPC, and the HERO and FEATURES ads with their tags', () => {
    expect(STAGED_FLIGHT_3.apps.ids).toEqual({
      campaignId: '24358792494',
      budgetId: '15948080534',
      adGroups: [{ id: '202688183753', name: 'Sudoku app placements - F3', maxCpcUsd: 0.35 }],
      ads: [
        { id: '828331825090', label: 'HERO', tag: 'sudoku_funnel_f3_apps_hero' },
        { id: '828331825093', label: 'FEATURES', tag: 'sudoku_funnel_f3_apps_feat' },
      ],
    })
  })
  it('search: campaign, budget, both ad groups at $0.99 and both RSAs on the one tag', () => {
    expect(STAGED_FLIGHT_3.search.ids).toEqual({
      campaignId: '24358792551',
      budgetId: '15958435831',
      adGroups: [
        { id: '204274116714', name: 'No ads intent - exact and phrase', maxCpcUsd: 0.99 },
        { id: '204274117594', name: 'Ad free intent - exact and phrase', maxCpcUsd: 0.99 },
      ],
      ads: [
        { id: '828285503241', label: 'RSA, no ads intent', tag: 'sudoku_funnel_f3_search' },
        { id: '828285503250', label: 'RSA, ad free intent', tag: 'sudoku_funnel_f3_search' },
      ],
    })
  })
  it('every ad tag is one of its arm ucValues, ids are numeric, and the budget id is in the notes', () => {
    for (const arm of STAGED_ARMS) {
      const c = STAGED_FLIGHT_3[arm]
      expect(c.ids.campaignId).toMatch(/^\d+$/)
      for (const ad of c.ids.ads) expect(c.ucValues, ad.id).toContain(ad.tag)
      expect(c.notes).toContain(`budget resource ${c.ids.budgetId}`)
    }
    expect(F3_APPS_ID).not.toBe(F3_SEARCH_ID)
  })
  it('the real STAGED_FLIGHT_3_DATES hold both dates or neither for each arm (a half-filled arm would throw at load)', () => {
    for (const arm of STAGED_ARMS) expect(() => stagedArmIsLive(arm), arm).not.toThrow()
  })
})

describe('a null date reads nothing', () => {
  it('both arms null: not live, no campaign, no read plan', () => {
    for (const arm of STAGED_ARMS) expect(stagedArmIsLive(arm, NULL_DATES), arm).toBe(false)
    expect(liveStagedCampaigns(NULL_DATES)).toEqual([])
    expect(liveStagedReadPlans(NULL_DATES)).toEqual({})
  })
  it('in the registry: no F3 campaign or plan, readPlanFor throws for its id, and no landing tag is live', () => {
    goLive(NULL_DATES)
    for (const id of [F3_APPS_ID, F3_SEARCH_ID]) {
      expect(campaignById(id), id).toBeUndefined()
      expect(ADS_READ_PLANS[id], id).toBeUndefined()
      expect(() => readPlanFor(id), id).toThrow(/no ads read plan for campaign/)
      expect(() => resolveCampaignId({ campaign: id }, 'morning', Date.parse('2026-10-22T10:00:00Z')), id).toThrow(/registered read plans/)
    }
    expect(liveLandingTags()).toEqual([])
    expect(CAMPAIGNS.some((c) => c.ucValues.some((u) => u.startsWith('sudoku_funnel_f3_')))).toBe(false)
  })
  it('a null-dated arm stays out when the OTHER arm is live', () => {
    goLive(SEARCH_ONLY)
    expect(campaignById(F3_SEARCH_ID)).toBeDefined()
    expect(campaignById(F3_APPS_ID)).toBeUndefined()
    expect(() => readPlanFor(F3_APPS_ID)).toThrow(/no ads read plan for campaign/)
    expect(liveLandingTags()).toEqual([]) // the donut's tags belong to the Apps arm
  })
})

describe('a set date makes only that arm live, with the right D-days', () => {
  it('Apps dates only: the Apps campaign registers from noon ET on D1, its read window is D+1 .. D+7, Search stays staged', () => {
    goLive(APPS_ONLY)
    const c = campaignById(F3_APPS_ID)!
    expect(c).toMatchObject({ id: F3_APPS_ID, flightStart: '2026-10-21', flightEnd: '2026-10-27', flightStartTimeEt: '12:00', status: 'upcoming', kind: 'web' })
    expect(c.ucValues).toEqual(STAGED_FLIGHT_3.apps.ucValues)
    const plan = readPlanFor(F3_APPS_ID).plan
    expect([plan.morningReadFirstEt, plan.morningReadLastEt]).toEqual(['2026-10-22', '2026-10-28'])
    expect(plan.channel).toBe('display')
    expect(reportLabelFor(F3_APPS_ID)).toBe('F3 apps')
    expect(auditPathFor(F3_APPS_ID, '2026-10-22')).toBe('docs/marketing/google-ads/f3-apps/data/2026-10-22.json')
    // day numbering: D1 is the start, D7 the end, nothing outside
    expect(flightDayIndex(c, '2026-10-20')).toBeNull()
    expect(flightDayIndex(c, '2026-10-21')).toBe(1)
    expect(flightDayIndex(c, '2026-10-27')).toBe(7)
    expect(flightDayIndex(c, '2026-10-28')).toBeNull()
    // attribution starts at noon ET on D1: 11:59 EDT is out, 12:00 EDT (16:00Z) is in
    expect(campaignAttributionStartMs(c)).toBe(Date.parse('2026-10-21T16:00:00Z'))
    const clause = campaignAttributionClause(c)
    expect(clause.matches('sudoku_funnel_f3_apps_hero', Date.parse('2026-10-21T15:59:00Z'))).toBe(false)
    expect(clause.matches('sudoku_funnel_f3_apps_hero', Date.parse('2026-10-21T16:00:00Z'))).toBe(true)
    // the donut's tags are live now, and the other arm is not registered
    expect(liveLandingTags()).toEqual(expect.arrayContaining(['sudoku_funnel_f3_apps_hero', 'sudoku_funnel_f3_apps_feat']))
    expect(campaignById(F3_SEARCH_ID)).toBeUndefined()
    expect(ADS_READ_PLANS[F3_SEARCH_ID]).toBeUndefined()
  })
  it('Search dates only: each arm has its own week; the Search plan is channel search with all devices', () => {
    goLive(SEARCH_ONLY)
    const c = campaignById(F3_SEARCH_ID)!
    expect([c.flightStart, c.flightEnd]).toEqual(['2026-10-17', '2026-10-23'])
    const plan = readPlanFor(F3_SEARCH_ID).plan
    expect([plan.morningReadFirstEt, plan.morningReadLastEt]).toEqual(['2026-10-18', '2026-10-24'])
    expect([channelOf(F3_SEARCH_ID), allDevicesOf(F3_SEARCH_ID), reportLabelFor(F3_SEARCH_ID)]).toEqual(['search', true, 'F3 search'])
    expect(flightDayIndex(c, '2026-10-17')).toBe(1)
    expect(flightDayIndex(c, '2026-10-23')).toBe(7)
    expect(campaignById(F3_APPS_ID)).toBeUndefined()
  })
  it('both arms filled: both register, each under the plan built from its own dates', () => {
    goLive(BOTH)
    expect(Object.keys(liveStagedReadPlans(BOTH))).toEqual([F3_APPS_ID, F3_SEARCH_ID])
    expect(readPlanFor(F3_APPS_ID).plan.morningReadFirstEt).toBe('2026-10-22')
    expect(readPlanFor(F3_SEARCH_ID).plan.morningReadFirstEt).toBe('2026-10-18')
  })
  it('a flight end that is not start + 6 is refused when the arm registers', () => {
    expect(() => liveStagedCampaigns({ ...NULL_DATES, apps: { flightStart: '2026-10-21', flightEnd: '2026-10-28' } })).toThrow(/flightStart \+ 6/)
    expect(() => liveStagedCampaigns({ ...NULL_DATES, apps: { flightStart: 'TBD', flightEnd: '2026-10-28' } })).toThrow(/YYYY-MM-DD/)
  })
})

describe('a half-filled arm throws, never reads as staged', () => {
  it('stagedArmIsLive, liveStagedCampaigns and liveStagedReadPlans all refuse exactly one date', () => {
    const halfStart: Dates = { ...NULL_DATES, apps: { flightStart: '2026-10-21', flightEnd: null } }
    const halfEnd: Dates = { ...NULL_DATES, search: { flightStart: null, flightEnd: '2026-10-23' } }
    expect(() => stagedArmIsLive('apps', halfStart)).toThrow(/set both flightStart and flightEnd/)
    expect(() => stagedArmIsLive('search', halfEnd)).toThrow(/set both flightStart and flightEnd/)
    expect(() => liveStagedCampaigns(halfStart)).toThrow(/set both/)
    expect(() => liveStagedReadPlans(halfEnd)).toThrow(/set both/)
  })
})

describe('flight 2 is still past', () => {
  it('its plans keep the window 2026-10-05 .. 2026-10-11 and its campaigns end 2026-10-10, whatever flight 3 does', () => {
    goLive(BOTH)
    for (const id of ['24316608605', '24311309184']) {
      expect([ADS_READ_PLANS[id].morningReadFirstEt, ADS_READ_PLANS[id].morningReadLastEt], id).toEqual(['2026-10-05', '2026-10-11'])
      expect([campaignById(id)!.flightStart, campaignById(id)!.flightEnd], id).toEqual(['2026-10-04', '2026-10-10'])
    }
  })
})

describe('the day 1-2 tracking check follows a filled-date arm', () => {
  // The report fixture's flight days are 2026-09-26 .. 10-02 (the retest's); the Apps arm is given those dates and the
  // fixture's retest id and uc are swapped for the arm's (the pattern of campaignRegistry.test.ts).
  const RETEST = '24279250691'
  const RETEST_UC = 'sudoku_funnel_retest'
  const raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
  const fixtureForApps = (): Fixture => JSON.parse(raw.split(RETEST).join(F3_APPS_ID).split(RETEST_UC).join('sudoku_funnel_f3_apps'))
  const opts = (campaignId: string): MorningOptions => ({ campaignId, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 })
  const FIXTURE_DATES: Dates = { ...NULL_DATES, apps: { flightStart: '2026-09-26', flightEnd: '2026-10-02' } }

  it('with its dates filled the morning report prints the tracking-check counts line', async () => {
    goLive(FIXTURE_DATES)
    const report = formatMorningReport(await runMorningRead(fixtureDeps(fixtureForApps(), true), opts(F3_APPS_ID)))
    expect(report).toContain('tracking-check counts (tagged ET-day totals')
    expect(report).toMatch(/complete rows \d+ \(\d+\), sign-in ask rows \(placement, committed-repeat, committed-challenge\) \d+ \(\d+\), \/coach\/shown\/place rows \d+ \(\d+\)/)
  })
  it('with null dates the arm has no read plan, so there is no report to print the line in', async () => {
    goLive(NULL_DATES)
    await expect(runMorningRead(fixtureDeps(fixtureForApps(), true), opts(F3_APPS_ID))).rejects.toThrow(/no ads read plan for campaign/)
  })
})

describe('staged arms are NOT registered, and cannot collide with what is', () => {
  it('neither tag, label nor audit slug is in the live registry', () => {
    const tags = new Set(CAMPAIGNS.flatMap((c) => c.ucValues))
    const labels = new Set(Object.values(ADS_READ_PLANS).flatMap((p) => [p.reportLabel, p.auditSlug]))
    for (const arm of ['apps', 'search'] as const) {
      for (const uc of STAGED_FLIGHT_3[arm].ucValues) expect(tags.has(uc), uc).toBe(false)
      expect(labels.has(STAGED_FLIGHT_3_PLAN_SETTINGS[arm].reportLabel)).toBe(false)
      expect(labels.has(STAGED_FLIGHT_3_PLAN_SETTINGS[arm].auditSlug)).toBe(false)
    }
  })
  it('a registered campaign never exists without its read plan (so activation cannot be half done)', () => {
    for (const c of CAMPAIGNS.filter((x) => x.ucValues.some((u) => u.startsWith('sudoku_funnel_f3_')))) {
      expect(ADS_READ_PLANS[c.id], c.id).toBeDefined()
    }
  })
  it('the staged tags are not the reserved organic label', () => {
    expect(() => assertOrganicReserved([stagedCampaign('apps', { id: APPS_ID, flightStart: START, flightEnd: END })])).not.toThrow()
  })
})

describe('activation is an id and dates only', () => {
  it('stagedCampaign builds a 7-day upcoming web flight with the arm\'s tag, budget, cap and noon-ET start', () => {
    for (const [arm, id] of [['apps', APPS_ID], ['search', SEARCH_ID]] as const) {
      const c = stagedCampaign(arm, { id, flightStart: START, flightEnd: END })
      expect(c).toMatchObject({ id, flightStart: START, flightEnd: END, flightStartTimeEt: '12:00', status: 'upcoming', kind: 'web', dailyBudgetUsd: 10, hardCapUsd: 70, servingHoursEt: [12, 24] })
      expect(c.ucValues).toEqual(STAGED_FLIGHT_3[arm].ucValues)
      expect(c.ucValues).not.toBe(STAGED_FLIGHT_3[arm].ucValues) // a copy: registering cannot mutate the staged config
    }
  })
  it('refuses a placeholder or wrong id, a malformed date and a window that is not seven days', () => {
    const ok = { id: APPS_ID, flightStart: START, flightEnd: END }
    expect(() => stagedCampaign('apps', { ...ok, id: 'TBD' })).toThrow(/numeric Google Ads id/)
    expect(() => stagedCampaign('apps', { ...ok, id: '' })).toThrow(/numeric Google Ads id/)
    expect(() => stagedCampaign('apps', { ...ok, flightStart: 'TBD' })).toThrow(/YYYY-MM-DD/)
    expect(() => stagedCampaign('apps', { ...ok, flightEnd: '2026-10-27' })).toThrow(/flightStart \+ 6/)
    expect(() => stagedCampaign('apps', { ...ok, flightEnd: '2026-10-25' })).toThrow(/flightStart \+ 6/)
  })
  it('a registered staged pair reads through the same code as flight 2: plan, label, audit folder, window day 2 .. end + 1', () => {
    CAMPAIGNS.push(stagedCampaign('apps', { id: APPS_ID, flightStart: START, flightEnd: END }), stagedCampaign('search', { id: SEARCH_ID, flightStart: '2026-10-21', flightEnd: '2026-10-27' }))
    ADS_READ_PLANS[APPS_ID] = stagedReadPlan('apps', APPS_ID)
    ADS_READ_PLANS[SEARCH_ID] = stagedReadPlan('search', SEARCH_ID)

    const apps = readPlanFor(APPS_ID).plan
    const search = readPlanFor(SEARCH_ID).plan
    expect([apps.channel, search.channel]).toEqual(['display', 'search'])
    expect([channelOf(APPS_ID), channelOf(SEARCH_ID)]).toEqual(['display', 'search'])
    expect([apps.dailyBudget, apps.hardCap, search.dailyBudget, search.hardCap]).toEqual([10, 70, 10, 70])
    expect([reportLabelFor(APPS_ID), reportLabelFor(SEARCH_ID)]).toEqual(['F3 apps', 'F3 search'])
    expect(auditPathFor(SEARCH_ID, '2026-10-22')).toBe('docs/marketing/google-ads/f3-search/data/2026-10-22.json')
    // each arm has its own week: the Search arm starts a day after the Apps arm here
    expect([apps.morningReadFirstEt, apps.morningReadLastEt]).toEqual([addDays(START, 1), addDays(END, 1)])
    expect([search.morningReadFirstEt, search.morningReadLastEt]).toEqual(['2026-10-22', '2026-10-28'])
    expect(apps.approvedPlacements).toHaveLength(17)
    expect(search.approvedPlacements).toEqual([])
    // attribution: by the arm's own tag, from noon ET on its start day, no upper bound
    expect(campaignAttributionClause(campaignById(APPS_ID)!).matches('sudoku_funnel_f3_apps', Date.parse('2026-10-20T17:00:00Z'))).toBe(true) // 13:00 EDT
    expect(campaignAttributionClause(campaignById(APPS_ID)!).matches('sudoku_funnel_f3_apps', Date.parse('2026-10-20T15:59:00Z'))).toBe(false) // 11:59 EDT
    expect(campaignAttributionClause(campaignById(APPS_ID)!).matches('sudoku_funnel_f3_search', Date.parse('2026-10-21T17:00:00Z'))).toBe(false)
    expect(flightDayIndex(campaignById(SEARCH_ID)!, '2026-10-21')).toBe(1)
  })
  it('the revised Search arm runs on all devices (no desktop-only flag); Apps and flight 2 Search are unchanged', () => {
    CAMPAIGNS.push(stagedCampaign('apps', { id: APPS_ID, flightStart: START, flightEnd: END }), stagedCampaign('search', { id: SEARCH_ID, flightStart: START, flightEnd: END }))
    ADS_READ_PLANS[APPS_ID] = stagedReadPlan('apps', APPS_ID)
    ADS_READ_PLANS[SEARCH_ID] = stagedReadPlan('search', SEARCH_ID)
    expect(STAGED_FLIGHT_3_PLAN_SETTINGS.search.allDevices).toBe(true)
    expect(allDevicesOf(SEARCH_ID)).toBe(true)
    expect(allDevicesOf(APPS_ID)).toBe(false)
    expect(allDevicesOf('24311309184')).toBe(false) // flight 2 Search keeps its desktop-only flag
    expect(allDevicesOf('0')).toBe(false)
  })
  it('records the revised bids and keyword family in the staged notes', () => {
    expect(STAGED_FLIGHT_3.search.notes).toMatch(/\$0\.99 max/)
    expect(STAGED_FLIGHT_3.search.notes).toMatch(/ALL devices/)
    expect(STAGED_FLIGHT_3.search.notes).toMatch(/15-25 clicks a week/)
    expect(STAGED_FLIGHT_3.search.notes).not.toMatch(/\$0\.60|mobile and tablet -100%/)
    expect(STAGED_FLIGHT_3.apps.notes).toMatch(/\$0\.35 max/)
    expect(STAGED_FLIGHT_3.apps.notes).toMatch(/Passes from \$1\.99/)
  })
  it('stagedReadPlan refuses a campaign that is not registered yet', () => {
    expect(() => stagedReadPlan('apps', APPS_ID)).toThrow(/must be in CAMPAIGNS/)
  })
})

// ── The runbook the daily cloud routine follows ────────────────────────────────────────
const RUNBOOK = fs.readFileSync(path.join(here, '..', '..', 'docs', 'routines', 'ads-cloud-daily.md'), 'utf8').replace(/\r\n/g, '\n')
function legsRows(): string[][] {
  const start = RUNBOOK.indexOf('| Status | Campaign id |')
  const lines = RUNBOOK.slice(start).split('\n')
  const rows: string[][] = []
  for (const l of lines.slice(2)) {
    if (!l.startsWith('|')) break
    rows.push(l.split('|').slice(1, -1).map((c) => c.trim()))
  }
  return rows
}

describe('runbook LEGS table', () => {
  const ISO = /^\d{4}-\d{2}-\d{2}$/
  it('has the two flight 3 rows by-date, each with the arm real numeric campaign id (no placeholder)', () => {
    const f3 = legsRows().filter((r) => /F3/.test(r[2]))
    expect(f3.map((r) => r[2])).toEqual(['F3 apps (display, Sudoku app placements)', 'F3 search (desktop intent)'])
    for (const r of f3) {
      expect(r[0], r[2]).toBe('by-date')
      expect(r[1], r[2]).toMatch(/^\d{10,}$/)
      expect(r[5], r[2]).toBe('start+1..end+1')
    }
    expect(f3[0][1]).toBe(STAGED_FLIGHT_3.apps.ids.campaignId)
    expect(f3[1][1]).toBe(STAGED_FLIGHT_3.search.ids.campaignId)
  })
  it('a by-date row holds two ISO dates or two dashes, never one of each', () => {
    for (const r of legsRows().filter((x) => x[0] === 'by-date')) {
      const filled = [r[3], r[4]].map((v) => ISO.test(v))
      expect(filled[0], r[2]).toBe(filled[1])
      if (!filled[0]) expect([r[3], r[4]], r[2]).toEqual(['-', '-'])
    }
  })
  it('every row the routine can read (`live`, or by-date with both dates) names a registered campaign with a read plan', () => {
    restoreFlight3() // the REAL registry: the rows are checked against what the deployed code registers
    for (const r of legsRows()) {
      const readable = r[0] === 'live' || (r[0] === 'by-date' && ISO.test(r[3]) && ISO.test(r[4]))
      if (readable) {
        expect(campaignById(r[1]), r[1]).toBeDefined()
        expect(ADS_READ_PLANS[r[1]], r[1]).toBeDefined()
      }
    }
  })
  it('a by-date row with dashes is not registered, and no row carries a placeholder or the old staged status', () => {
    restoreFlight3()
    for (const r of legsRows().filter((x) => x[0] === 'by-date' && x[3] === '-')) {
      expect(campaignById(r[1]), r[1]).toBeUndefined()
      expect(ADS_READ_PLANS[r[1]], r[1]).toBeUndefined()
    }
    for (const r of legsRows()) {
      expect(r[0], r[2]).not.toBe('staged')
      expect(r.join('|'), r[2]).not.toMatch(/<[^>]*>/)
    }
  })
  it('flight 2\'s rows are past, since the 10-11 read window ended', () => {
    const f2 = legsRows().filter((r) => /F2/.test(r[2]))
    expect(f2).toHaveLength(2)
    for (const r of f2) expect(r[0], r[2]).toBe('past')
  })
  it('Part A selects live rows and by-date rows with both dates; a by-date row with dashes is documented as never read', () => {
    expect(RUNBOOK).toContain('Part A reads every `live` row whose read window contains')
    expect(RUNBOOK).toMatch(/and every `by-date` row\nwhose Flight start and Flight end both hold a YYYY-MM-DD date/)
    expect(RUNBOOK).toMatch(/A staged `by-date` row \(dates\n`-`\) is never read, by any part, in any mode/)
    expect(RUNBOOK).not.toMatch(/`staged` rows are never read/)
  })
  it('step 0.2 and Part B derive the flight 3 reports from the dates: wrapup on end + 7, day15 on end + 15', () => {
    expect(RUNBOOK).toMatch(/`wrapup` when DATE is Flight end \+ 7 and `day15` when DATE is Flight end \+ 15/)
    expect(RUNBOOK).not.toMatch(/\| F3 (apps|search) \| (wrapup|day15) \|/) // no hand-written Part B rows
  })
  it('the activation steps are the dates plus the manual steps; the old hand edits are gone', () => {
    const i = RUNBOOK.indexOf('### To activate flight 3')
    const section = RUNBOOK.slice(i, RUNBOOK.indexOf('## Step 0:'))
    expect(section).toMatch(/STAGED_FLIGHT_3_DATES/)
    expect(section).toMatch(/07:05 ET/)
    expect(section).toMatch(/D \+ 21 and D \+ 35 purchase reads/)
    expect(section).not.toMatch(/stagedCampaign\(|stagedReadPlan\(|flip the status/)
  })
  it('does not say the Apps arm starts on v1.99.0, and rule 3 is not described as always NOT COMPUTABLE', () => {
    expect(RUNBOOK).not.toMatch(/v1\.99\.0/)
    expect(RUNBOOK).toMatch(/Apps started ahead of the Play release/)
    expect(RUNBOOK).not.toMatch(/Play production day of whichever build/)
    expect(RUNBOOK).not.toMatch(/always reads NOT COMPUTABLE/)
    expect(RUNBOOK).toMatch(/does NOT always read NOT COMPUTABLE/)
  })
  it('the day 1-2 tracking check is documented as applying from the moment an arm\'s dates are filled', () => {
    expect(RUNBOOK).toMatch(/From the moment the dates are filled/)
    expect(RUNBOOK).toMatch(/Day 1-2 tracking check/)
  })
})

describe('runbook LEGS rows track STAGED_FLIGHT_3_DATES', () => {
  // The by-date format: `| by-date | <campaign id> | F3 apps (...) | <start or -> | <end or -> | start+1..end+1 | none |`,
  // where `-` is a null date (staged) and a YYYY-MM-DD cell is the same date as STAGED_FLIGHT_3_DATES.
  it('each F3 row carries the arm real campaign id and exactly the dates in STAGED_FLIGHT_3_DATES (`-` is null)', () => {
    const f3 = legsRows().filter((r) => /F3/.test(r[2]))
    expect(f3).toHaveLength(2)
    for (const [arm, label] of [['apps', 'F3 apps'], ['search', 'F3 search']] as const) {
      const row = f3.find((r) => r[2].startsWith(label))!
      expect(row[0], label).toBe('by-date')
      expect(row[1], label).toBe(STAGED_FLIGHT_3[arm].ids.campaignId)
      const cell = (v: string) => (v === '-' ? null : v)
      expect([cell(row[3]), cell(row[4])], label).toEqual([STAGED_FLIGHT_3_DATES[arm].flightStart, STAGED_FLIGHT_3_DATES[arm].flightEnd])
    }
  })
  it('both arms are live with a seven-day week; the read window is start + 1 .. end + 1 (dates read from the code, so a slip never turns this red)', () => {
    restoreFlight3() // the REAL registry, with the committed dates
    for (const arm of ['apps', 'search'] as const) {
      const { flightStart, flightEnd } = STAGED_FLIGHT_3_DATES[arm]
      expect(flightEnd, arm).toBe(addDays(flightStart!, 6))
      expect(stagedArmIsLive(arm), arm).toBe(true)
      const c = campaignById(STAGED_FLIGHT_3[arm].ids.campaignId)!
      expect(c.flightStart, arm).toBe(flightStart)
      expect(c.flightEnd, arm).toBe(flightEnd)
      const plan = ADS_READ_PLANS[c.id]
      expect(plan.morningReadFirstEt, arm).toBe(addDays(flightStart!, 1))
      expect(plan.morningReadLastEt, arm).toBe(addDays(flightEnd!, 1))
    }
  })
  it('the Apps read caveat is one constant in the report code and the runbook states its note', () => {
    expect(APPS_PLAY_RELEASE_CAVEAT).toBe("Read caveat: Play installs credited from v1.99.2+, public 10-17 06:34Z, before flight 3's first serve.")
    expect(RUNBOOK).toContain("Play installs credited from v1.99.2+,\npublic 10-17 06:34Z, before flight 3's first serve.")
  })
})

describe('staged blocks are declared before the registries that activation edits', () => {
  // CAMPAIGNS and ADS_READ_PLANS spread liveStagedCampaigns() / liveStagedReadPlans() inside their literals;
  // a const they read, declared after the literal, throws at module load (TDZ).
  const src = (f: string) => fs.readFileSync(path.join(here, '..', '..', 'src', 'lib', f), 'utf8')
  it('campaigns.ts declares STAGED_FLIGHT_3 above CAMPAIGNS', () => {
    const s = src('campaigns.ts')
    expect(s.indexOf('export const STAGED_FLIGHT_3')).toBeGreaterThan(-1)
    expect(s.indexOf('export const STAGED_FLIGHT_3')).toBeLessThan(s.indexOf('export const CAMPAIGNS'))
  })
  it('campaigns.ts declares STAGED_FLIGHT_3_DATES above CAMPAIGNS (which spreads liveStagedCampaigns())', () => {
    const s = src('campaigns.ts')
    expect(s.indexOf('export const STAGED_FLIGHT_3_DATES')).toBeGreaterThan(-1)
    expect(s.indexOf('export const STAGED_FLIGHT_3_DATES')).toBeLessThan(s.indexOf('export const CAMPAIGNS'))
  })
  it('adsRules.ts declares STAGED_FLIGHT_3_PLAN_SETTINGS above ADS_READ_PLANS', () => {
    const s = src('adsRules.ts')
    expect(s.indexOf('export const STAGED_FLIGHT_3_PLAN_SETTINGS')).toBeGreaterThan(-1)
    expect(s.indexOf('export const STAGED_FLIGHT_3_PLAN_SETTINGS')).toBeLessThan(s.indexOf('export const ADS_READ_PLANS'))
  })
})
