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
import { fixtureDeps, parseCli, resolveCampaignId, type Fixture } from './cli'
import { runMorningRead, runPostflightRead, type MorningOptions } from './read'
import { formatMorningReport, formatPostflightReport, withJson } from './report'
import { auditFileFor, buildReadPage, TEMPLATE_PATH } from './read-page'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import {
  ADS_READ_PLANS,
  RETEST_APPROVED_PLACEMENTS,
  approvedPlacementsFor,
  auditPathFor,
  buildReadPlan,
  reportLabelFor,
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
  reportLabel: 'Second test',
  auditSlug: 'second-test',
  morningReadFirstEt: '2026-09-28',
  morningReadLastEt: '2026-10-04',
}

/** Runs the built page's own script in happy-dom; returns the ladder's sub-text and tick labels. */
function renderPage(html: string): { sub: string; ticks: string[] } {
  const win = new Window({ url: 'https://example.test/' })
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  const pageScript = scripts.find((s) => !s[0].startsWith('<script type="application/json"'))![1]
  win.document.write(html.replace(pageScript, ''))
  new Function('document', 'window', 'navigator', pageScript)(win.document, win, win.navigator)
  return {
    sub: win.document.getElementById('ladder-sub')!.textContent,
    ticks: [...win.document.querySelectorAll('#ladder text.tlabel')].map((t) => t.textContent),
  }
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

  it('morning: with one plan registered it resolves to it on EVERY date, before, inside or after the window (as on base)', () => {
    for (const day of ['2026-09-26', '2026-09-27', '2026-09-30', '2026-10-03', '2026-10-04', '2026-10-06', '2026-10-10', '2027-01-15']) {
      expect(defaultReadCampaignId('morning', day), day).toBe(RETEST)
    }
  })
  it('morning: with two plans registered it never infers one from the date, even when only one window covers today', () => {
    // the re-review's example: the retest window 2026-09-27..10-03, a second campaign's 2026-10-05..10-11.
    // An old unpinned retest morning task run on 2026-10-06 must not silently read the second campaign.
    const plans = { [RETEST]: plan(RETEST, '2026-09-27', '2026-10-03'), [SECOND]: plan(SECOND, '2026-10-05', '2026-10-11') }
    const both = new RegExp(`2 campaigns have read plans, so the morning read cannot tell which one is meant; pass --campaign <id> \\(registered read plans: ${RETEST} .*${SECOND} `)
    for (const day of ['2026-09-26', '2026-09-28', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-11', '2026-10-12']) {
      expect(() => defaultReadCampaignId('morning', day, undefined, plans), day).toThrow(both)
    }
    // overlapping windows: also an error naming both
    const overlap = { [RETEST]: plan(RETEST, '2026-09-27', '2026-10-03'), [SECOND]: plan(SECOND, '2026-09-30', '2026-10-06') }
    expect(() => defaultReadCampaignId('morning', '2026-10-01', undefined, overlap)).toThrow(both)
  })
  it('morning: a closed campaign counts as registered: a lone closed plan resolves, closed plus another throws', () => {
    const closedId = '24234347705' // in CLOSED_CAMPAIGN_IDS
    const closed = plan(closedId, '2026-09-27', '2026-10-03')
    expect(defaultReadCampaignId('morning', '2026-09-30', undefined, { [closedId]: closed })).toBe(closedId)
    expect(() => defaultReadCampaignId('morning', '2026-09-30', undefined, { [closedId]: closed, [SECOND]: plan(SECOND, '2026-09-27', '2026-10-03') })).toThrow(new RegExp(`${closedId} .*${SECOND} `))
  })
  it('morning with no plan at all throws', () => {
    expect(() => defaultReadCampaignId('morning', '2026-09-30', undefined, {})).toThrow(/no campaign has a read plan.*none registered/)
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
  it('post-flight with two campaigns registered never infers one from the date: it throws and lists both ids', () => {
    // the review's interleaving scenario: the second flight ends a week after the retest's, so
    // its stage dates sit on both sides of the retest's (retest wrapup 2026-10-09, second 2026-10-17)
    CAMPAIGNS.push({ ...secondFlight, flightStart: '2026-10-04', flightEnd: '2026-10-10' })
    ADS_READ_PLANS[SECOND] = buildReadPlan(SECOND, { ...secondSettings, morningReadFirstEt: '2026-10-05', morningReadLastEt: '2026-10-11' })
    const both = new RegExp(`2 campaigns have read plans.*pass --campaign <id> \\(registered read plans: ${RETEST} .*${SECOND} `)
    // on the retest's own due day, a late rerun after the second's due date, an early forced run
    // of the second's stage while the retest's is already past due: every one of them throws
    for (const day of ['2026-10-09', '2026-10-10', '2026-10-12', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-25', '2026-12-03']) {
      for (const stage of ['wrapup', 'day15', 'day30', 'day60', 'december'] as const) {
        expect(() => defaultReadCampaignId('postflight', day, stage), `${stage} on ${day}`).toThrow(both)
      }
    }
  })
  it('post-flight: two campaigns whose stages are due the same day is also an error naming both', () => {
    CAMPAIGNS.push({ ...secondFlight, flightEnd: campaignById(RETEST)!.flightEnd })
    ADS_READ_PLANS[SECOND] = buildReadPlan(SECOND, secondSettings)
    expect(() => defaultReadCampaignId('postflight', '2026-10-09', 'wrapup')).toThrow(new RegExp(`pass --campaign <id> \\(registered read plans: ${RETEST} .*${SECOND} `))
  })
  it('post-flight counts a CLOSED campaign: a lone closed plan still resolves, a closed plus another throws (no "not closed" filter)', () => {
    const closedId = '24234347705' // in CLOSED_CAMPAIGN_IDS
    const closedPlan: AdsReadPlan = { ...ADS_READ_PLANS[RETEST], campaignId: closedId }
    // the old campaign marked closed, still the only plan: its remaining stages keep resolving to it
    expect(defaultReadCampaignId('postflight', '2026-12-03', 'december', { [closedId]: closedPlan })).toBe(closedId)
    // the old (closed) campaign plus a new one: never hands the unpinned task the new one
    expect(() => defaultReadCampaignId('postflight', '2026-12-03', 'december', { [closedId]: closedPlan, [SECOND]: { ...closedPlan, campaignId: SECOND } })).toThrow(new RegExp(`${closedId} .*${SECOND} `))
  })
  it('post-flight with no plan at all throws', () => {
    expect(() => defaultReadCampaignId('postflight', '2026-10-09', 'wrapup', {})).toThrow(/no campaign has a read plan.*none registered/)
  })
})

describe('resolveCampaignId (the CLI)', () => {
  it('an explicit --campaign naming a registered or configured campaign wins; the clock is not consulted', () => {
    expect(resolveCampaignId({ campaign: RETEST }, 'morning', Date.parse('2030-01-01T12:00:00Z'))).toBe(RETEST)
    expect(resolveCampaignId({ campaign: RETEST }, 'postflight', Date.parse('2030-01-01T12:00:00Z'), 'december')).toBe(RETEST)
    // a closed campaign is a known one: its own refusal ("is closed") comes from readPlanFor, later
    expect(resolveCampaignId({ campaign: '24234347705' }, 'morning', Date.parse('2026-09-30T12:00:00Z'))).toBe('24234347705')
  })
  it('a blank, boolean or unknown --campaign fails loudly, lists the registered ids, and never falls through to the default', () => {
    const now = Date.parse('2026-09-30T12:05:00Z') // a day the default WOULD resolve (to the retest)
    for (const bad of ['', ' ', '12345', 'abc', true] as const) {
      expect(() => resolveCampaignId({ campaign: bad }, 'morning', now), JSON.stringify(bad)).toThrow(new RegExp(`--campaign .* is not a registered campaign id \\(registered read plans: ${RETEST}\\); pass --campaign <id>`))
      expect(() => resolveCampaignId({ campaign: bad }, 'postflight', now, 'wrapup'), JSON.stringify(bad)).toThrow(/not a registered campaign id/)
    }
  })
  it('with no --campaign it uses the read\'s own clock: the fixture time, not today', () => {
    expect(resolveCampaignId({}, 'morning', Date.parse('2026-09-30T12:05:00Z'))).toBe(RETEST)
    expect(resolveCampaignId({}, 'morning', Date.parse('2026-12-01T12:05:00Z'))).toBe(RETEST)
    expect(resolveCampaignId({}, 'postflight', Date.parse('2026-10-09T12:05:00Z'), 'wrapup')).toBe(RETEST)
  })
  it('with only the retest registered, every scheduled routine invocation (no --campaign) still resolves to it', () => {
    expect(Object.keys(ADS_READ_PLANS)).toEqual([RETEST])
    const flightEnd = campaignById(RETEST)!.flightEnd
    // post-flight: each stage on its due day, and on a day well before and well after it
    for (const stage of ['wrapup', 'day15', 'day30', 'day60', 'december'] as const) {
      for (const day of [postflightDueDate(stage, flightEnd), '2026-09-30', '2026-10-10', '2027-01-15']) {
        expect(resolveCampaignId({}, 'postflight', Date.parse(`${day}T17:00:00Z`), stage), `${stage} on ${day}`).toBe(RETEST)
      }
    }
    // morning: 06:00 ET (10:00Z) before, inside and after the window: the date plays no part (as on base)
    for (const day of ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-06', '2026-10-10', '2027-01-15']) {
      expect(resolveCampaignId({}, 'morning', Date.parse(`${day}T10:00:00Z`)), day).toBe(RETEST)
    }
    for (const t of ['2026-10-04T03:59:59Z', '2026-10-04T04:00:00Z']) expect(resolveCampaignId({}, 'morning', Date.parse(t)), t).toBe(RETEST)
  })
  it('with a second campaign registered, an unpinned morning read on 2026-10-06 (the re-review example) exits via the error, not the second campaign', () => {
    CAMPAIGNS.push({ ...secondFlight, flightStart: '2026-10-04', flightEnd: '2026-10-10' })
    ADS_READ_PLANS[SECOND] = buildReadPlan(SECOND, { ...secondSettings, morningReadFirstEt: '2026-10-05', morningReadLastEt: '2026-10-11' })
    expect(() => resolveCampaignId({}, 'morning', Date.parse('2026-10-06T10:00:00Z'))).toThrow(new RegExp(`pass --campaign <id> \\(registered read plans: ${RETEST} .*${SECOND} `))
    // the pinned retest task is unaffected
    expect(resolveCampaignId({ campaign: RETEST }, 'morning', Date.parse('2026-10-06T10:00:00Z'))).toBe(RETEST)
  })
  it('a bare --campaign (no value) fails in parseCli with the same message, listing the registered ids', () => {
    expect(() => parseCli({}, ['--campaign'])).toThrow(new RegExp(`--campaign with no value is not a registered campaign id \\(registered read plans: ${RETEST}\\); pass --campaign <id>`))
    expect(() => parseCli({}, ['--dry-run', '--campaign'])).toThrow(/with no value.*registered read plans/)
    // other parse errors are untouched
    expect(() => parseCli({}, ['--nope'])).toThrow(/Unknown option/)
    expect(parseCli({}, ['--campaign', RETEST]).campaign).toBe(RETEST)
  })
})

describe('concurrent campaigns do not collide in non-keyed outputs', () => {
  it('report labels and audit slugs are unique across the registry', () => {
    register()
    const plans = Object.values(ADS_READ_PLANS)
    expect(plans.length).toBeGreaterThanOrEqual(2)
    expect(new Set(plans.map((p) => p.reportLabel)).size).toBe(plans.length)
    expect(new Set(plans.map((p) => p.auditSlug)).size).toBe(plans.length)
    for (const p of plans) {
      expect(p.reportLabel.trim()).not.toBe('')
      expect(p.auditSlug).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    }
  })
  it('the real registry (no test registrations) is unique too', () => {
    const plans = Object.values(ADS_READ_PLANS)
    expect(new Set(plans.map((p) => p.reportLabel)).size).toBe(plans.length)
    expect(new Set(plans.map((p) => p.auditSlug)).size).toBe(plans.length)
  })
  it('the retest keeps today\'s exact label and audit path', () => {
    expect(reportLabelFor(RETEST)).toBe('BSK retest')
    expect(auditPathFor(RETEST, '2026-09-30')).toBe('docs/marketing/google-ads/retest/data/2026-09-30.json')
    expect(auditFileFor(RETEST, '2026-09-30')).toBe('docs/marketing/google-ads/retest/data/2026-09-30.json')
  })
  it('the second campaign leads its report header and push text with its own label and writes its own audit path', async () => {
    register()
    const a = await runMorningRead(fixtureDeps(retestFixture(), false), optsFor(RETEST))
    const b = await runMorningRead(fixtureDeps(secondFixture(), false), optsFor(SECOND))
    expect(formatMorningReport(a).split('\n')[0]).toMatch(/^BSK retest morning read, /)
    expect(formatMorningReport(b).split('\n')[0]).toMatch(/^Second test morning read, /)
    expect(a.notify.text).toMatch(/^BSK retest /)
    expect(b.notify.text).toMatch(/^Second test /)
    expect(b.notify.text).not.toContain('BSK retest')
    expect(auditPathFor(SECOND, '2026-09-30')).toBe('docs/marketing/google-ads/second-test/data/2026-09-30.json')
    expect(auditPathFor(SECOND, '2026-09-30')).not.toBe(auditPathFor(RETEST, '2026-09-30'))
  })
  it('the post-flight push text and header carry the campaign\'s own label', async () => {
    register()
    const r = await runPostflightRead(fixtureDeps(secondFixture(), true), { campaignId: SECOND, stage: 'wrapup', force: true })
    expect(formatPostflightReport(r).split('\n')[0]).toMatch(/^Second test post-flight wrapup read, /)
    expect(r.notify.text ?? '').toMatch(/^Second test wrapup read/)
    expect(r.notify.text ?? '').not.toContain('BSK retest')
  })
  it('read-page: the audit path defaults per campaign and the ladder is drawn from the campaign\'s own plan', async () => {
    register()
    const build = async (id: string, fx: Fixture) => {
      const result = await runMorningRead(fixtureDeps(fx, true), optsFor(id))
      const html = buildReadPage({
        template: fs.readFileSync(TEMPLATE_PATH, 'utf8'),
        raw: withJson(formatMorningReport(result), result),
        narrative: { headline: 'h', working: ['w'], notWorking: ['n'], soWhat: ['s'] },
        audit: { commit: 'abc1234' },
      })
      const payload = JSON.parse(/<script type="application\/json" id="report-src">([\s\S]*?)<\/script>/.exec(html)![1].replace(/\\u003c/g, '<'))
      return { html, payload }
    }
    const a = await build(RETEST, retestFixture())
    const b = await build(SECOND, secondFixture())
    expect(a.payload.thresholds).toEqual([25, 50, 75, 100])
    expect(a.payload.audit.file).toBe('docs/marketing/google-ads/retest/data/2026-09-30.json')
    expect(b.payload.thresholds).toEqual([30, 45, 80, 150])
    expect(b.payload.audit.file).toBe('docs/marketing/google-ads/second-test/data/2026-09-30.json')
    // rendered: the retest page draws $25..$100 with today's sub-text; the second its own ladder
    const ra = renderPage(a.html)
    const rb = renderPage(b.html)
    expect(ra.sub).toBe('Reads fire once each at $25, $50, $75 and $100. Kill rules only propose; Mike pauses the campaign himself.')
    expect(ra.ticks).toEqual(['$0', '$25', '$50', '$75', '$100'])
    expect(rb.sub).toBe('Reads fire once each at $30, $45, $80 and $150. Kill rules only propose; Mike pauses the campaign himself.')
    expect(rb.ticks).toEqual(['$0', '$30', '$45', '$80', '$150'])
  })
  it('read-page refuses a JSON whose campaign has no read plan, naming the registered ids', async () => {
    const result = await runMorningRead(fixtureDeps(retestFixture(), true), optsFor(RETEST))
    const raw = withJson(formatMorningReport(result), result).split(RETEST).join('12345')
    expect(() =>
      buildReadPage({ template: fs.readFileSync(TEMPLATE_PATH, 'utf8'), raw, narrative: { headline: 'h', working: ['w'], notWorking: ['n'], soWhat: ['s'] }, audit: null }),
    ).toThrow(/no ads read plan for campaign 12345 \(registered read plans: 24279250691\)/)
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
