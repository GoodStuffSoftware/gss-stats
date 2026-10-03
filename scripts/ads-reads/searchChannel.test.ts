// Flight 2 runs two arms at once: a Display arm on app placements and a desktop Search arm on
// keywords. A search campaign has no placements, so every placement-based rule or line must
// read "n/a (search campaign)" (never a pass, a trip or a crash), the sync must not pull
// placements for it, and its campaign-level spend/impressions/clicks must read exactly as a
// display campaign's do. With two plans registered the CLI must refuse to guess the campaign.
// Fixture only: the two arm ids below are made up and registered at runtime, never in the
// registry files. No network, no credentials.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureDeps, resolveCampaignId, type Fixture } from './cli'
import { runMorningRead, runPostflightRead, type DiagnosticsSection, type MorningOptions } from './read'
import { diagnosticsLines, formatMorningReport, formatPostflightReport } from './report'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import {
  ADS_READ_PLANS,
  POSTFLIGHT_STAGES,
  RETEST_APPROVED_PLACEMENTS,
  SEARCH_NA,
  approvedPlacementsFor,
  buildReadPlan,
  channelOf,
  decideAt100,
  evaluateKillRules,
  type AdsReadPlan,
  type KillRuleInput,
} from '../../src/lib/adsRules'
import { fetchDailySpend, fetchRangeTotal, type AdsClient } from '../../src/lib/adsApi'
import { createSqlAdsStore, type PlacementDayRow } from '../../src/lib/adsStore'
import { syncAdsData, type AdsMetricsSource } from '../../src/lib/adsSync'
import { CAMPAIGNS, type CampaignFlight } from '../../src/lib/campaigns'
import { openMigratedSqlite, sqliteAdsDb } from './sqliteDb'

const here = path.dirname(fileURLToPath(import.meta.url))
const RETEST = '24279250691'
const RETEST_UC = 'sudoku_funnel_retest'
const APPS = '99900000021' // arm A: Display, app placements
const SEARCH = '99900000022' // arm B: Search, desktop keywords
const APPS_UC = 'sudoku_funnel_f2_apps'
const SEARCH_UC = 'sudoku_funnel_f2_search'
const raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
const fixtureFor = (id: string, uc: string, opts: { noPlacements?: boolean } = {}): Fixture => {
  const fx = JSON.parse(raw.split(RETEST).join(id).split(RETEST_UC).join(uc))
  if (opts.noPlacements) fx.ads.placements = []
  return fx
}
const optsFor = (campaignId: string): MorningOptions => ({ campaignId, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 })

// Same flight days as the recorded fixture, so one fixture feeds both arms.
const flight = (id: string, label: string, uc: string): CampaignFlight => ({
  id,
  label,
  ucValues: [uc],
  flightStart: '2026-09-26',
  flightStartTimeEt: '12:00',
  flightEnd: '2026-10-02',
  status: 'active',
  kind: 'web',
  dailyBudgetUsd: 7.15,
  hardCapUsd: 100, // above the fixture's $50.10, so only the rules under test can trip
  directionalThroughDay: 3,
  notes: 'test fixture only',
})
const common = { thresholds: [25, 50], killRulesFrom: 25, placementLeakMaxShare: 0.1, ctrFloor: 0.0015, morningReadFirstEt: '2026-09-27', morningReadLastEt: '2026-10-03' }
const appsSettings = { ...common, approvedPlacements: RETEST_APPROVED_PLACEMENTS, reportLabel: 'F2 apps', auditSlug: 'f2-apps' }
const searchSettings = { ...common, channel: 'search' as const, reportLabel: 'F2 search', auditSlug: 'f2-search' }

function register() {
  CAMPAIGNS.push(flight(APPS, 'Flight 2 apps (test)', APPS_UC), flight(SEARCH, 'Flight 2 search (test)', SEARCH_UC))
  ADS_READ_PLANS[APPS] = buildReadPlan(APPS, appsSettings)
  ADS_READ_PLANS[SEARCH] = buildReadPlan(SEARCH, searchSettings)
}
function unregister() {
  for (const id of [APPS, SEARCH]) {
    for (let i = CAMPAIGNS.findIndex((c) => c.id === id); i >= 0; i = CAMPAIGNS.findIndex((c) => c.id === id)) CAMPAIGNS.splice(i, 1)
    delete ADS_READ_PLANS[id]
  }
}
beforeEach(unregister)
afterEach(unregister)

/** Fixture deps with the Ads placement pull counted. */
function countedDeps(fx: Fixture, dryRun: boolean) {
  const deps = fixtureDeps(fx, dryRun)
  const calls: string[] = []
  const ads = deps.ads!
  const orig = ads.placements.bind(ads)
  ads.placements = (id, since, until) => {
    calls.push(id)
    return orig(id, since, until)
  }
  return { deps, calls }
}
const leak = (rules: readonly { id: string; status: string; detail: string }[]) => rules.find((r) => r.id === 'placement-leak')!

describe('the channel on a read plan', () => {
  it('defaults to display (the retest and every closed campaign), and channelOf follows the plan', () => {
    expect(ADS_READ_PLANS[RETEST].channel).toBe('display')
    expect(channelOf(RETEST)).toBe('display')
    expect(channelOf('24234347705')).toBe('display') // closed, no plan
    register()
    expect(channelOf(APPS)).toBe('display')
    expect(channelOf(SEARCH)).toBe('search')
    expect(ADS_READ_PLANS[SEARCH].approvedPlacements).toEqual([])
  })
  it('refuses a search plan that carries placements, and a display plan without them', () => {
    CAMPAIGNS.push(flight(SEARCH, 'x', SEARCH_UC), flight(APPS, 'y', APPS_UC))
    expect(() => buildReadPlan(SEARCH, { ...searchSettings, approvedPlacements: ['com.example.puzzle'] })).toThrow(/search campaign.*must not set approvedPlacements/)
    expect(() => buildReadPlan(SEARCH, { ...searchSettings, adGroupPlacementCounts: { a: 1 } })).toThrow(/search campaign/)
    expect(() => buildReadPlan(APPS, { ...appsSettings, approvedPlacements: [] })).toThrow(/display campaign.*needs approvedPlacements/)
  })
})

describe('kill rule 1 (placement leak) on a search campaign', () => {
  const searchPlan = (): AdsReadPlan => ({ ...ADS_READ_PLANS[RETEST], channel: 'search', approvedPlacements: [], adGroupPlacementCounts: undefined })
  const input = (over: Partial<KillRuleInput> = {}): KillRuleInput => ({
    plan: searchPlan(),
    cumulativeSpend: 60,
    campaignState: { status: 'ENABLED', servingStatus: 'SERVING' },
    delivery: { impressions: 20000, clicks: 100 },
    placements: null,
    beacon: { asks: 5, taggedArrivals: 50 },
    ...over,
  })
  it('reads n/a, armed or not, with or without placement data, and never trips or proposes a pause', () => {
    for (const over of [{}, { cumulativeSpend: 10 }, { placements: { campaignCost: 60, approvedCost: 0, itemizedCost: 0 } }]) {
      const res = evaluateKillRules(input(over))
      expect(leak(res.rules)).toMatchObject({ status: 'n/a', value: null, detail: SEARCH_NA })
      expect(res.tripped).not.toContain('placement-leak')
    }
    expect(evaluateKillRules(input()).proposal).toBe('CONTINUE')
  })
  it('leaves the other rules alone: CTR still trips on a search campaign', () => {
    const res = evaluateKillRules(input({ delivery: { impressions: 20000, clicks: 1 } }))
    expect(res.rules.find((r) => r.id === 'ctr')!.status).toBe('trip')
    expect(res.tripped).toEqual(['ctr'])
  })
})

describe('the morning and post-flight reads of a search arm (fixture, no placement rows)', () => {
  it('the $50 read prints n/a for placements, is complete, and never pulls placements; the same data as display would trip', async () => {
    register()
    const s = countedDeps(fixtureFor(SEARCH, SEARCH_UC, { noPlacements: true }), false)
    const search = await runMorningRead(s.deps, optsFor(SEARCH))
    expect(s.calls).toEqual([])
    const t = search.thresholdRead!
    expect(t).toBeTruthy()
    expect(leak(t.kill.rules)).toMatchObject({ status: 'n/a', detail: SEARCH_NA })
    expect(t.kill.tripped).toEqual([])
    expect(t.placements).toBeNull()
    expect(t.complete).toBe(true)
    expect(t.failedSources).not.toContain('Google Ads placements')
    const text = formatMorningReport(search)
    expect(text).toContain(`[n/a] placement leak: ${SEARCH_NA}`)
    expect(text).toContain(`Placements: ${SEARCH_NA}`)
    expect(text).not.toMatch(/outside the \d+ approved placements/)

    // Contrast: the display arm on the same (placement-less) data reads 100% un-itemized and trips.
    const a = countedDeps(fixtureFor(APPS, APPS_UC, { noPlacements: true }), false)
    const apps = await runMorningRead(a.deps, optsFor(APPS))
    expect(a.calls.length).toBeGreaterThan(0)
    expect(leak(apps.thresholdRead!.kill.rules).status).toBe('trip')

    // Campaign-level spend, impressions and clicks read identically for both channels.
    expect(search.spend.cumulative).toEqual(apps.spend.cumulative)
    expect(search.spend.cumulative.cost).toBe(50.1)
    expect(search.thresholds.crossedNow).toEqual(apps.thresholds.crossedNow)
    // ...and each arm's reading stays under its own id.
    expect(JSON.stringify(search)).not.toContain(APPS)
    expect(JSON.stringify(apps)).not.toContain(SEARCH)
  })

  it('every post-flight stage of a search arm runs and reads placement n/a', async () => {
    register()
    for (const stage of POSTFLIGHT_STAGES) {
      const s = countedDeps(fixtureFor(SEARCH, SEARCH_UC), true)
      const r = await runPostflightRead(s.deps, { campaignId: SEARCH, stage, force: true })
      expect(r.campaign.id, stage).toBe(SEARCH)
      expect(s.calls, stage).toEqual([])
      expect(r.read, stage).toBeTruthy()
      expect(leak(r.read!.kill.rules).status, stage).toBe('n/a')
      expect(formatPostflightReport(r), stage).toContain(`Placements: ${SEARCH_NA}`)
    }
  })
})

describe('diagnostics lines for a search campaign', () => {
  const d: DiagnosticsSection = {
    spendThroughEt: '2026-10-05',
    hourly: null,
    geo: null,
    devices: [
      { device: 'DESKTOP', impressions: 900, clicks: 30, ctr: 0.033, cost: 6.5 },
      { device: 'MOBILE', impressions: 0, clicks: 0, ctr: 0, cost: 0 },
    ],
    targeting: [{ adGroup: 'Sudoku keywords', status: 'ENABLED', placements: 0, audienceBidOnly: null, expectedPlacements: null }],
    recommendations: null,
    countryCounts: null,
    accountCrossCheck: null,
    errors: [],
  }
  it('does not flag desktop delivery as a mobile-app anomaly, and prints the placement targeting check as n/a', () => {
    const search = diagnosticsLines(d, 'search').join('\n')
    expect(search).not.toMatch(/ANOMALY/)
    expect(search).toContain('device: DESKTOP 900 impr')
    expect(search).toContain(`targeting (placement count, optimized targeting): ${SEARCH_NA}`)
    // The display reading of the same rows is unchanged: desktop is an anomaly there.
    const display = diagnosticsLines(d).join('\n')
    expect(display).toMatch(/DESKTOP .*ANOMALY: computers\/TV should read zero/)
    expect(display).toContain('targeting: Sudoku keywords [ENABLED] 0 placement(s)')
  })
})

describe('campaign-level Ads reads are channel-agnostic (GAQL shape)', () => {
  it('daily spend and the range total query FROM campaign (never a placement view) and parse the same rows', async () => {
    register()
    const queries: string[] = []
    const client: AdsClient = {
      async search(q) {
        queries.push(q)
        return q.startsWith('SELECT segments.date')
          ? [{ segments: { date: '2026-10-05' }, metrics: { costMicros: '6500000', impressions: '900', clicks: '30' } }]
          : [{ metrics: { costMicros: '6500000', impressions: '900', clicks: '30' } }]
      },
    }
    for (const id of [APPS, SEARCH]) {
      expect(await fetchDailySpend(client, id, '2026-10-05', '2026-10-05')).toEqual({ '2026-10-05': { costMicros: 6_500_000, impressions: 900, clicks: 30 } })
      expect(await fetchRangeTotal(client, id, '2026-10-05', '2026-10-05')).toEqual({ costMicros: 6_500_000, impressions: 900, clicks: 30 })
    }
    expect(queries).toHaveLength(4)
    for (const q of queries) {
      expect(q).toMatch(/ FROM campaign WHERE campaign\.id = \d+ /)
      expect(q).not.toMatch(/placement_view/)
    }
  })
})

describe('the shared sync with a search arm', () => {
  const day = (usd: number) => ({ costMicros: Math.round(usd * 1e6), impressions: 1000, clicks: 10 })
  const pl = (date: string): PlacementDayRow => ({ date, placement: 'mobileapp::2-com.easybrain.sudoku.android', displayName: 'x', type: 'MOBILE_APPLICATION', targetUrl: null, approved: true, costMicros: 1_000_000, impressions: 100, clicks: 1 })
  it('pulls placements for the display arm only; the search arm stores spend and reports no placement failure', async () => {
    register()
    const daily: Record<string, Record<string, ReturnType<typeof day>>> = {
      [APPS]: { '2026-09-26': day(4), '2026-09-27': day(7) },
      [SEARCH]: { '2026-09-26': day(3), '2026-09-27': day(6) },
    }
    const calls: { kind: string; id: string }[] = []
    const src: AdsMetricsSource = {
      async rangeTotal(id) {
        calls.push({ kind: 'total', id })
        return null
      },
      async daily(id, since, until) {
        calls.push({ kind: 'daily', id })
        return Object.fromEntries(Object.entries(daily[id] ?? {}).filter(([d]) => d >= since && d <= until))
      },
      async placements(id) {
        calls.push({ kind: 'placements', id })
        return id === APPS ? [pl('2026-09-26'), pl('2026-09-27')] : []
      },
    }
    const sqlite = openMigratedSqlite()
    const store = createSqlAdsStore(sqliteAdsDb(sqlite), { dryRun: false, kind: 'sqlite' })
    const now = Date.parse('2026-09-28T13:00:00Z')
    const r = await syncAdsData({ ads: src, store }, { campaignIds: [APPS, SEARCH], now, dryRun: false, source: 'ads-sync' })
    expect(r.status).toBe('ok')
    expect(calls.filter((c) => c.kind === 'placements').map((c) => c.id)).toEqual([APPS])
    const bySearch = r.campaigns.find((c) => c.campaignId === SEARCH)!
    expect(bySearch.dailyOk).toBe(true)
    expect(bySearch.placementsOk).toBeNull()
    expect(r.campaigns.find((c) => c.campaignId === APPS)!.placementsOk).toBe(true)
    const stored = sqlite.prepare('SELECT campaign_id, date, cost_micros FROM ads_daily_metrics ORDER BY campaign_id, date').all()
    expect(stored).toEqual([
      { campaign_id: APPS, date: '2026-09-26', cost_micros: 4_000_000 },
      { campaign_id: APPS, date: '2026-09-27', cost_micros: 7_000_000 },
      { campaign_id: SEARCH, date: '2026-09-26', cost_micros: 3_000_000 },
      { campaign_id: SEARCH, date: '2026-09-27', cost_micros: 6_000_000 },
    ])
    // A rerun right after is a no-op for the search arm: it never becomes "due" for placements.
    calls.length = 0
    await syncAdsData({ ads: src, store }, { campaignIds: [APPS, SEARCH], now: now + 60_000, dryRun: false, source: 'ads-sync' })
    expect(calls.filter((c) => c.id === SEARCH)).toEqual([])
  })
})

describe('the CLI with two arms registered (display + search)', () => {
  it('refuses to pick a campaign when --campaign is omitted, naming every registered id, for the morning read and every post-flight stage', () => {
    register()
    const now = Date.parse('2026-10-06T12:05:00Z')
    const names = new RegExp(`pass --campaign <id> \\(registered read plans: ${RETEST} .*${APPS} .*${SEARCH} `)
    expect(() => resolveCampaignId({}, 'morning', now)).toThrow(names)
    // The count follows the registry (the real plans plus these two made-up arms), so adding a real arm never breaks this.
    const registered = Object.keys(ADS_READ_PLANS).length
    expect(registered).toBeGreaterThanOrEqual(3)
    expect(() => resolveCampaignId({}, 'morning', now)).toThrow(new RegExp(`${registered} campaigns have read plans, so the morning read cannot tell which one is meant`))
    for (const stage of POSTFLIGHT_STAGES) expect(() => resolveCampaignId({}, 'postflight', now, stage), stage).toThrow(names)
  })
  it('resolves each arm when --campaign names it', () => {
    register()
    const now = Date.parse('2026-10-06T12:05:00Z')
    for (const id of [APPS, SEARCH]) {
      expect(resolveCampaignId({ campaign: id }, 'morning', now)).toBe(id)
      for (const stage of POSTFLIGHT_STAGES) expect(resolveCampaignId({ campaign: id }, 'postflight', now, stage)).toBe(id)
    }
    expect(approvedPlacementsFor(APPS)).toBe(RETEST_APPROVED_PLACEMENTS)
  })
  it('a repeated --campaign exits the process non-zero and names both values (no last-wins)', () => {
    const tsx = path.join(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const r = spawnSync(process.execPath, [tsx, path.join(here, 'morning-read.ts'), '--campaign', RETEST, '--campaign', '99900000022', '--dry-run'], { encoding: 'utf8', stdio: 'pipe' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`--campaign was given 2 times ("${RETEST}" and "99900000022"); pass it once`)
    expect(r.stdout).toBe('')
  }, 30_000)
})

describe('the $100 decision for a search arm', () => {
  const cases = [
    { name: 'two-plus (exact)', input: { signUpsAtMost: 3, asks: 20, accepts: 9, exact: true }, row: 'two-plus' },
    { name: 'two-plus (bound)', input: { signUpsAtMost: 3, asks: 20, accepts: 9 }, row: 'two-plus' },
    { name: 'one (exact)', input: { signUpsAtMost: 1, asks: 20, accepts: 9, exact: true }, row: 'one' },
    { name: 'one (bound)', input: { signUpsAtMost: 1, asks: 20, accepts: 9 }, row: 'one' },
    { name: 'zero-rarely-shown', input: { signUpsAtMost: 0, asks: MIN_COHORT - 1, accepts: 0 }, row: 'zero-rarely-shown' },
    { name: 'zero-declined', input: { signUpsAtMost: 0, asks: 12, accepts: 0 }, row: 'zero-declined' },
    { name: 'zero-accepted-not-completed', input: { signUpsAtMost: 0, asks: 12, accepts: 2 }, row: 'zero-accepted-not-completed' },
  ] as const
  for (const c of cases) {
    it(`${c.name}: no display advice and no O3`, () => {
      const d = decideAt100({ ...c.input, channel: 'search' })
      expect(d.row).toBe(c.row)
      expect(d.reading).not.toMatch(/display/i)
      expect(d.next).not.toMatch(/display/i)
      expect(d.reading).not.toContain('O3')
      expect(d.next).not.toContain('O3')
    })
  }
  it('compares the search arm against its sibling arm (if any) where display was told to start O3', () => {
    for (const input of [{ signUpsAtMost: 3, asks: 20, accepts: 9, exact: true }, { signUpsAtMost: 3, asks: 20, accepts: 9 }, { signUpsAtMost: 0, asks: 12, accepts: 0 }]) {
      expect(decideAt100({ ...input, channel: 'search' }).next).toContain("on spend per tagged completer, per this campaign's pre-registered read")
      expect(decideAt100({ ...input, channel: 'search' }).next).not.toMatch(/flight[- ]2/i)
      // Display (explicit or default) keeps its O3 advice.
      expect(decideAt100({ ...input, channel: 'display' })).toEqual(decideAt100(input))
      expect(decideAt100(input).next).toContain('O3 (Search)')
    }
  })
})

describe('the search arm desktop-only device flag', () => {
  const base: DiagnosticsSection = {
    spendThroughEt: '2026-10-05',
    hourly: null,
    geo: null,
    devices: [
      { device: 'DESKTOP', impressions: 900, clicks: 30, ctr: 0.033, cost: 6.5 },
      { device: 'MOBILE', impressions: 40, clicks: 2, ctr: 0.05, cost: 0.42 },
      { device: 'TABLET', impressions: 3, clicks: 0, ctr: 0, cost: 0 },
      { device: 'CONNECTED_TV', impressions: 1, clicks: 0, ctr: 0, cost: 0.01 },
      { device: 'OTHER', impressions: 0, clicks: 0, ctr: 0, cost: 0.02 },
    ],
    targeting: null,
    recommendations: null,
    countryCounts: null,
    accountCrossCheck: null,
    errors: [],
  }
  it('flags closed-day spend on MOBILE, CONNECTED_TV and OTHER, not zero-cost TABLET or DESKTOP', () => {
    const lines = diagnosticsLines(base, 'search')
    const line = (dev: string) => lines.find((l) => l.startsWith(`  device: ${dev} `))!
    expect(line('MOBILE')).toContain(" — ANOMALY: yesterday's spend on MOBILE: $0.42; arm is desktop-only (closed day only, not the flight so far), propose to Mike")
    expect(line('CONNECTED_TV')).toContain("yesterday's spend on CONNECTED_TV")
    expect(line('OTHER')).toContain("yesterday's spend on OTHER")
    expect(line('TABLET')).not.toMatch(/ANOMALY/)
    expect(line('DESKTOP')).not.toMatch(/ANOMALY/)
    const withTablet = diagnosticsLines({ ...base, devices: [{ device: 'TABLET', impressions: 3, clicks: 1, ctr: 0.33, cost: 0.05 }] }, 'search')
    expect(withTablet.join('\n')).toContain("yesterday's spend on TABLET: $0.05; arm is desktop-only")
  })
  it('never adds the search flag to a display read', () => {
    expect(diagnosticsLines(base).join('\n')).not.toMatch(/desktop-only/)
  })
  it('is a printed flag only: the search morning read never trips or proposes on it, and skips the targeting query', async () => {
    register()
    const s = countedDeps(fixtureFor(SEARCH, SEARCH_UC, { noPlacements: true }), false)
    let targetingCalls = 0
    s.deps.ads!.devices = async () => [{ device: 'MOBILE', impressions: 40, clicks: 2, ctr: 0.05, cost: 0.42 }]
    s.deps.ads!.targeting = async () => {
      targetingCalls++
      return []
    }
    const r = await runMorningRead(s.deps, optsFor(SEARCH))
    expect(targetingCalls).toBe(0)
    expect(r.diagnostics.targeting).toBeNull()
    expect(r.diagnostics.devices).toHaveLength(1)
    expect(r.thresholdRead!.kill.tripped).toEqual([])
    expect(r.thresholdRead!.kill.proposal).toBe('CONTINUE')
    expect(formatMorningReport(r)).toContain("yesterday's spend on MOBILE: $0.42")
  })
})
