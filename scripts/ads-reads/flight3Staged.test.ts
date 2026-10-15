// Flight 3 is STAGED: its tags, budget, cap and read-plan settings are fixed in code, but its two
// Google Ads campaigns do not exist yet, so neither arm is in CAMPAIGNS or ADS_READ_PLANS. These
// tests pin (1) the staged values against the launch plan, (2) that activation is only an id and
// dates (the made-up ids below are fixtures, never registry entries), and (3) that the runbook the
// daily cloud routine follows carries the staged rows with a status it does not act on. Fixture
// only: no network, no credentials.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ADS_READ_PLANS,
  RETEST_APPROVED_PLACEMENTS,
  STAGED_FLIGHT_3_PLAN_SETTINGS,
  auditPathFor,
  channelOf,
  readPlanFor,
  reportLabelFor,
  stagedReadPlan,
} from '../../src/lib/adsRules'
import { CAMPAIGNS, STAGED_FLIGHT_3, assertOrganicReserved, campaignAttributionClause, campaignById, flightDayIndex, stagedCampaign } from '../../src/lib/campaigns'
import { addDays } from '../../src/lib/etTime'

const here = path.dirname(fileURLToPath(import.meta.url))
const APPS_ID = '99900000011'
const SEARCH_ID = '99900000012'
const START = '2026-10-20'
const END = '2026-10-26'

afterEach(() => {
  for (const id of [APPS_ID, SEARCH_ID]) {
    const i = CAMPAIGNS.findIndex((c) => c.id === id)
    if (i >= 0) CAMPAIGNS.splice(i, 1)
    delete ADS_READ_PLANS[id]
  }
})

describe('flight 3 staged config matches the launch plan', () => {
  it('apps: tag sudoku_funnel_f3_apps, $10/day, $70 cap, noon-ET schedule 12:00-23:00', () => {
    const c = STAGED_FLIGHT_3.apps
    expect(c.ucValues).toEqual(['sudoku_funnel_f3_apps'])
    expect([c.dailyBudgetUsd, c.hardCapUsd, c.flightStartTimeEt, c.servingHoursEt]).toEqual([10, 70, '12:00', [12, 23]])
    expect(c.notes).toContain('google / display / sudoku_funnel_f3_apps')
  })
  it('search: tag sudoku_funnel_f3_search, $10/day, $70 cap, noon-ET schedule 12:00-23:00', () => {
    const c = STAGED_FLIGHT_3.search
    expect(c.ucValues).toEqual(['sudoku_funnel_f3_search'])
    expect([c.dailyBudgetUsd, c.hardCapUsd, c.flightStartTimeEt, c.servingHoursEt]).toEqual([10, 70, '12:00', [12, 23]])
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
      expect(c).toMatchObject({ id, flightStart: START, flightEnd: END, flightStartTimeEt: '12:00', status: 'upcoming', kind: 'web', dailyBudgetUsd: 10, hardCapUsd: 70, servingHoursEt: [12, 23] })
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
  it('has the two flight 3 rows staged, with a placeholder id that is not a number', () => {
    const rows = legsRows()
    const f3 = rows.filter((r) => /F3/.test(r[2]))
    expect(f3.map((r) => r[2])).toEqual(['F3 apps (display, Sudoku app placements)', 'F3 search (desktop intent)'])
    for (const r of f3) {
      expect(r[0], r[2]).toBe('staged')
      expect(r[1], r[2]).toMatch(/^<.*>$/) // <F3 apps campaign id>, never digits
      expect(r[1], r[2]).not.toMatch(/\d{5,}/)
    }
  })
  it('every row the routine can read (`live`) names a registered campaign with a read plan; staged rows name none', () => {
    for (const r of legsRows()) {
      if (r[0] === 'live') {
        expect(campaignById(r[1]), r[1]).toBeDefined()
        expect(ADS_READ_PLANS[r[1]], r[1]).toBeDefined()
      }
      if (r[0] === 'staged') {
        expect(campaignById(r[1]), r[1]).toBeUndefined()
        expect(ADS_READ_PLANS[r[1]], r[1]).toBeUndefined()
      }
    }
  })
  it('flight 2\'s rows are past, since the 10-11 read window ended', () => {
    const f2 = legsRows().filter((r) => /F2/.test(r[2]))
    expect(f2).toHaveLength(2)
    for (const r of f2) expect(r[0], r[2]).toBe('past')
  })
  it('Part A selects only `live` rows, and the staged status is documented as never read', () => {
    expect(RUNBOOK).toContain('Part A reads every `live` row whose read window contains')
    expect(RUNBOOK).toMatch(/`staged` rows are never read/)
  })
})
