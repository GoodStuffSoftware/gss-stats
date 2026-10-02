// "Reading a new campaign is a registry change": a SECOND, made-up campaign (own id, uc tag,
// thresholds, window, approved placements) is registered at runtime and read through the very
// same code as the retest, from the same recorded fixture with the retest's id/uc swapped.
// The retest's results are compared before / after to show nothing leaks between them. Fixture
// only: no network, no credentials. The ids below are fixtures, not registry entries.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureDeps, resolveCampaignId, type Fixture } from './cli'
import { runMorningRead, runPostflightRead, type MorningOptions } from './read'
import { formatMorningReport, withJson } from './report'
import { buildReadPage, TEMPLATE_PATH } from './read-page'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import {
  ADS_READ_PLANS,
  RETEST_APPROVED_PLACEMENTS,
  approvedPlacementsFor,
  buildReadPlan,
  defaultReadCampaignId,
  postflightDueDate,
  readPlanFor,
  type AdsReadPlan,
} from '../../src/lib/adsRules'
import { CAMPAIGNS, campaignById, isDirectionalDay, type CampaignFlight } from '../../src/lib/campaigns'

const here = path.dirname(fileURLToPath(import.meta.url))
const RETEST = '24279250691'
const RETEST_UC = 'sudoku_funnel_retest'
const SECOND = '99900000001'
const SECOND_UC = 'sudoku_second_test'
const raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
const retestFixture = (): Fixture => JSON.parse(raw)
const secondFixture = (): Fixture => JSON.parse(raw.split(RETEST).join(SECOND).split(RETEST_UC).join(SECOND_UC))
const optsFor = (campaignId: string): MorningOptions => ({ campaignId, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 })

// Same flight dates as the retest (the recorded fixture's spend days) so the one fixture can feed
// both; everything else about the made-up campaign differs.
const secondFlight: CampaignFlight = {
  id: SECOND,
  label: 'Made-up evening test',
  ucValues: [SECOND_UC],
  flightStart: '2026-09-26',
  flightStartTimeEt: '12:00',
  flightEnd: '2026-10-02',
  status: 'active',
  kind: 'web',
  dailyBudgetUsd: 20,
  hardCapUsd: 150,
  servingHoursEt: [18, 23],
  directionalThroughDay: 3,
  notes: 'test fixture only',
}
const secondSettings = {
  thresholds: [30, 45, 80, 150],
  killRulesFrom: 45,
  placementLeakMaxShare: 0.6,
  ctrFloor: 0.002,
  approvedPlacements: ['com.example.puzzle'],
  morningReadFirstEt: '2026-09-28',
  morningReadLastEt: '2026-10-04',
}

function register() {
  CAMPAIGNS.push(secondFlight)
  ADS_READ_PLANS[SECOND] = buildReadPlan(SECOND, secondSettings)
}
function unregister() {
  const i = CAMPAIGNS.findIndex((c) => c.id === SECOND)
  if (i >= 0) CAMPAIGNS.splice(i, 1)
  delete ADS_READ_PLANS[SECOND]
}
beforeEach(unregister)
afterEach(unregister)

describe('a second registered campaign reads independently of the retest', () => {
  it('uses its own thresholds, kill-rule start, cap, placement list and window; the retest read is byte-for-byte unchanged', async () => {
    const before = await runMorningRead(fixtureDeps(retestFixture(), false), optsFor(RETEST))
    register()
    const second = await runMorningRead(fixtureDeps(secondFixture(), false), optsFor(SECOND))
    const after = await runMorningRead(fixtureDeps(retestFixture(), false), optsFor(RETEST))

    // the retest is untouched by the registration (compared as the full JSON of the read)
    expect(JSON.stringify(after)).toEqual(JSON.stringify(before))
    expect(before.thresholds.crossedNow).toEqual([50])
    expect(before.thresholdRead!.kill.proposal).toBe('CONTINUE')

    // the second campaign's own plan drove its read: $50.10 crosses ITS $30 and $45, not the retest's $50
    expect(second.campaign.id).toBe(SECOND)
    expect(second.campaign.label).toBe('Made-up evening test')
    expect(second.spend.cumulative.cost).toBe(50.1)
    expect(second.thresholds.crossedNow).toEqual([30, 45])
    expect(second.thresholds.crossedNow).not.toContain(50)
    // its own placement list: the fixture's 'com.example.puzzle' is approved for it (off-list for the retest)
    expect(approvedPlacementsFor(SECOND)).toEqual(['com.example.puzzle'])
    expect(approvedPlacementsFor(RETEST)).toBe(RETEST_APPROVED_PLACEMENTS)
    expect(JSON.stringify(second)).not.toContain(RETEST)
    expect(JSON.stringify(before)).not.toContain(SECOND)
  })

  it('writes its readings and consumed thresholds under its own id', async () => {
    register()
    const fx = secondFixture()
    const deps = fixtureDeps(fx, false)
    await runMorningRead(deps, optsFor(SECOND))
    expect(deps.store.written.readings.every((r) => r.campaignId === SECOND)).toBe(true)
    expect(await deps.store.getConsumedThresholds(SECOND)).toEqual(expect.arrayContaining([30, 45]))
  })

  it('post-flight resolves each campaign through its own plan', async () => {
    register()
    const r = await runPostflightRead(fixtureDeps(secondFixture(), true), { campaignId: SECOND, stage: 'wrapup', force: true })
    expect(r.campaign.id).toBe(SECOND)
  })

  it('refuses a campaign with no plan, and a plan without a budget and cap in CAMPAIGNS', () => {
    expect(() => readPlanFor(SECOND)).toThrow()
    CAMPAIGNS.push({ ...secondFlight, dailyBudgetUsd: undefined })
    expect(() => buildReadPlan(SECOND, secondSettings)).toThrow(/dailyBudgetUsd and hardCapUsd/)
    expect(() => buildReadPlan('00000000000', secondSettings)).toThrow(/not in lib\/campaigns/)
  })

  it('the report page headline shows the second campaign (label and id from the read, not the template)', async () => {
    register()
    const result = await runMorningRead(fixtureDeps(secondFixture(), true), optsFor(SECOND))
    const rawOut = withJson(formatMorningReport(result), result)
    const html = buildReadPage({
      template: fs.readFileSync(TEMPLATE_PATH, 'utf8'),
      raw: rawOut,
      narrative: { headline: 'h', working: ['w'], notWorking: ['n'], soWhat: ['s'] },
      audit: { commit: 'abc1234' },
    })
    const win = new Window({ url: 'https://example.test/' })
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    const pageScript = scripts.find((s) => !s[0].startsWith('<script type="application/json"'))![1]
    win.document.write(html.replace(pageScript, ''))
    new Function('document', 'window', 'navigator', pageScript)(win.document, win, win.navigator)
    const eyebrow = win.document.getElementById('eyebrow')!.textContent
    expect(eyebrow).toBe(`Best Sudoku · Made-up evening test · Google Ads campaign ${SECOND}`)
  })

  it('the retest report page eyebrow is unchanged from the old hard-coded text', async () => {
    const result = await runMorningRead(fixtureDeps(retestFixture(), true), optsFor(RETEST))
    const html = buildReadPage({
      template: fs.readFileSync(TEMPLATE_PATH, 'utf8'),
      raw: withJson(formatMorningReport(result), result),
      narrative: { headline: 'h', working: ['w'], notWorking: ['n'], soWhat: ['s'] },
      audit: { commit: 'abc1234' },
    })
    const win = new Window({ url: 'https://example.test/' })
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    const pageScript = scripts.find((s) => !s[0].startsWith('<script type="application/json"'))![1]
    win.document.write(html.replace(pageScript, ''))
    new Function('document', 'window', 'navigator', pageScript)(win.document, win, win.navigator)
    expect(win.document.getElementById('eyebrow')!.textContent).toBe(`Best Sudoku · US+CA web retest · Google Ads campaign ${RETEST}`)
  })
})

describe('defaultReadCampaignId: derived from the registry, never a constant', () => {
  const plan = (id: string, first: string, last: string): AdsReadPlan => ({ ...ADS_READ_PLANS[RETEST], campaignId: id, morningReadFirstEt: first, morningReadLastEt: last })

  it('morning: the one plan whose window covers today (the retest on 2026-09-30, unchanged invocation)', () => {
    expect(defaultReadCampaignId('morning', '2026-09-30')).toBe(RETEST)
    expect(defaultReadCampaignId('morning', '2026-09-27')).toBe(RETEST)
    expect(defaultReadCampaignId('morning', '2026-10-03')).toBe(RETEST)
  })
  it('morning: outside every window it throws a one-line error listing the ids and the flag', () => {
    expect(() => defaultReadCampaignId('morning', '2026-10-04')).toThrow(/no campaign's morning-read window covers 2026-10-04; pass --campaign <id> \(registered read plans: 24279250691/)
  })
  it('morning: two windows that cover the same day is an error naming both, not a guess', () => {
    const plans = { [RETEST]: plan(RETEST, '2026-09-27', '2026-10-03'), [SECOND]: plan(SECOND, '2026-09-30', '2026-10-06') }
    expect(() => defaultReadCampaignId('morning', '2026-10-01', undefined, plans)).toThrow(new RegExp(`more than one.*${RETEST}, ${SECOND}.*pass --campaign`))
    expect(defaultReadCampaignId('morning', '2026-09-28', undefined, plans)).toBe(RETEST)
    expect(defaultReadCampaignId('morning', '2026-10-05', undefined, plans)).toBe(SECOND)
  })
  it('morning: a closed campaign is never a default', () => {
    expect(() => defaultReadCampaignId('morning', '2026-09-30', undefined, { '24234347705': plan('24234347705', '2026-09-27', '2026-10-03') })).toThrow(/none registered/)
  })
  it('post-flight with one registered plan always resolves to it, on every scheduled stage date (the unchanged scheduled invocations)', () => {
    const flightEnd = campaignById(RETEST)!.flightEnd
    for (const stage of ['wrapup', 'day15', 'day30', 'day60', 'december'] as const) {
      expect(defaultReadCampaignId('postflight', postflightDueDate(stage, flightEnd), stage)).toBe(RETEST)
    }
    expect(defaultReadCampaignId('postflight', '2026-09-30', 'wrapup')).toBe(RETEST)
  })
  it('post-flight needs a stage', () => {
    expect(() => defaultReadCampaignId('postflight', '2026-10-09')).toThrow(/needs a stage/)
  })
  it('post-flight with two campaigns: the stage most recently due wins, so the older campaign keeps its scheduled stages', () => {
    CAMPAIGNS.push({ ...secondFlight, flightStart: '2026-10-20', flightEnd: '2026-10-26' })
    ADS_READ_PLANS[SECOND] = buildReadPlan(SECOND, { ...secondSettings, morningReadFirstEt: '2026-10-21', morningReadLastEt: '2026-10-27' })
    // retest wrapup due 2026-10-09, second wrapup due 2026-11-02
    expect(defaultReadCampaignId('postflight', '2026-10-09', 'wrapup')).toBe(RETEST)
    expect(defaultReadCampaignId('postflight', '2026-10-17', 'day15')).toBe(RETEST)
    expect(defaultReadCampaignId('postflight', '2026-11-02', 'wrapup')).toBe(SECOND)
    // the retest's day15 (10-17) is more recently due than the second's (11-10, not yet due) on 10-31
    expect(defaultReadCampaignId('postflight', '2026-10-31', 'day15')).toBe(RETEST)
  })
  it('post-flight: two campaigns due the same day is an error naming both', () => {
    CAMPAIGNS.push({ ...secondFlight, flightEnd: campaignById(RETEST)!.flightEnd })
    ADS_READ_PLANS[SECOND] = buildReadPlan(SECOND, secondSettings)
    expect(() => defaultReadCampaignId('postflight', '2026-10-09', 'wrapup')).toThrow(/more than one campaign's wrapup read is due 2026-10-09.*pass --campaign/)
  })
})

describe('resolveCampaignId (the CLI)', () => {
  it('an explicit --campaign wins, with no registry lookup', () => {
    expect(resolveCampaignId({ campaign: '12345' }, 'morning', Date.parse('2030-01-01T12:00:00Z'))).toBe('12345')
  })
  it('with no --campaign it uses the read\'s own clock: the fixture time, not today', () => {
    expect(resolveCampaignId({}, 'morning', Date.parse('2026-09-30T12:05:00Z'))).toBe(RETEST)
    expect(() => resolveCampaignId({}, 'morning', Date.parse('2026-12-01T12:05:00Z'))).toThrow(/--campaign <id>/)
    expect(resolveCampaignId({}, 'postflight', Date.parse('2026-10-09T12:05:00Z'), 'wrapup')).toBe(RETEST)
  })
})

describe('registry accessors', () => {
  it('isDirectionalDay follows the campaign\'s own directionalThroughDay (retest: days 1-7; none set: never)', () => {
    const retest = campaignById(RETEST)!
    expect(isDirectionalDay(retest, '2026-09-26')).toBe(true)
    expect(isDirectionalDay(retest, '2026-10-02')).toBe(true)
    expect(isDirectionalDay(retest, '2026-10-03')).toBe(false)
    expect(isDirectionalDay(campaignById('24215315197')!, '2026-09-03')).toBe(false)
    expect(isDirectionalDay({ ...secondFlight }, '2026-09-28')).toBe(true) // day 3
    expect(isDirectionalDay({ ...secondFlight }, '2026-09-29')).toBe(false) // day 4
  })
  it('approvedPlacementsFor: the plan\'s list, else the closed-campaign record, else null', () => {
    expect(approvedPlacementsFor(RETEST)).toBe(RETEST_APPROVED_PLACEMENTS)
    expect(approvedPlacementsFor('24234347705')).toEqual(RETEST_APPROVED_PLACEMENTS)
    expect(approvedPlacementsFor('24215315197')).toHaveLength(RETEST_APPROVED_PLACEMENTS.length + 2)
    expect(approvedPlacementsFor('00000000000')).toBeNull()
  })
})
