// Flight 4 (Android installs, campaign 24392866056) is registered SPEND-ONLY with NO read plan:
// Google counts its Play installs, it writes no beacon rows, and nothing reads or rules it. This
// pins what that means: a never-empty placeholder tag, no read plan (so no morning or post-flight
// default, no kill rules), no placement pull in the sync (and no "missing placement day"), and no
// beacon-based readout. Fixture only: the made-up arm ids are registered at runtime and removed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADS_READ_PLANS, buildReadPlan, channelOf, defaultReadCampaignId, readPlanFor, POSTFLIGHT_STAGES, RETEST_APPROVED_PLACEMENTS } from '../../src/lib/adsRules'
import { CAMPAIGNS, assertOrganicReserved, campaignById, F4_NO_BEACON_TAG, parseReturnPath, type CampaignFlight } from '../../src/lib/campaigns'
import { planCampaignSync, pullsPlacements, syncAdsData, campaignsConfigHash, type AdsMetricsSource } from '../../src/lib/adsSync'
import { createSqlAdsStore, type PlacementDayRow } from '../../src/lib/adsStore'
import { configRuling } from '../../src/lib/metrics/scope'
import { resolveCampaignId } from './cli'
import { closedPlayDirectCampaigns } from './playDirect'
import { openMigratedSqlite, sqliteAdsDb } from './sqliteDb'

const F4 = '24392866056'
const ANDROID_LAUNCH = '24215315197'
const PLAY_DIRECT_SEPT = '24234347705' // closed Display ads to the Play listing: 56 stored placement rows
const DISPLAY_NO_PLAN = '99900000031' // made up: a display campaign with no read plan and no noPlacements flag
const DISPLAY_PLAN = '99900000032' // made up: a display campaign with a read plan

const f4 = () => campaignById(F4)!
const day = (usd: number) => ({ costMicros: Math.round(usd * 1e6), impressions: 1000, clicks: 10 })
const pl = (date: string): PlacementDayRow => ({ date, placement: 'mobileapp::2-com.easybrain.sudoku.android', displayName: 'x', type: 'MOBILE_APPLICATION', targetUrl: null, approved: true, costMicros: 1_000_000, impressions: 100, clicks: 1 })
const testFlight = (id: string): CampaignFlight => ({
  id,
  label: `test ${id}`,
  ucValues: [`sudoku_test_${id}`],
  flightStart: '2026-10-26',
  flightEnd: '2026-11-02',
  status: 'active',
  kind: 'web',
  dailyBudgetUsd: 10,
  hardCapUsd: 70,
  notes: 'test fixture only',
})
function unregister() {
  for (const id of [DISPLAY_NO_PLAN, DISPLAY_PLAN]) {
    for (let i = CAMPAIGNS.findIndex((c) => c.id === id); i >= 0; i = CAMPAIGNS.findIndex((c) => c.id === id)) CAMPAIGNS.splice(i, 1)
    delete ADS_READ_PLANS[id]
  }
}
beforeEach(unregister)
afterEach(unregister)

describe('the F4 registry entry', () => {
  it('is a spend-only Play-direct arm with the brief\'s ids, dates, budget and cap', () => {
    const c = f4()
    expect(c.label).toBe('Flight 4 — Android installs')
    expect(c.kind).toBe('play-direct')
    expect(c.measurement).toBe('spend-only')
    expect(c.status).toBe('active')
    expect(c.flightStart).toBe('2026-10-26')
    expect(c.flightStartTimeEt).toBe('12:00')
    expect(c.flightEnd).toBe('2026-11-02')
    expect(c.dailyBudgetUsd).toBe(10)
    expect(c.hardCapUsd).toBe(75)
    expect(c.noPlacements).toBe(true)
    expect(c.measurabilityNote).toMatch(/Google counts the Play installs/)
    expect(c.notes).toMatch(/829601920531/)
  })
  it('never has an empty ucValues (an empty array breaks the beacon SQL) and uses a valid, unique, never-seen tag', () => {
    for (const c of CAMPAIGNS) expect(c.ucValues.length, c.id).toBeGreaterThan(0)
    expect(f4().ucValues).toEqual([F4_NO_BEACON_TAG])
    expect(parseReturnPath(`/return/${F4_NO_BEACON_TAG}/d0`)).toEqual({ uc: F4_NO_BEACON_TAG, bucket: 'd0' }) // passes the tag shape the readers accept
    for (const c of CAMPAIGNS.filter((x) => x.id !== F4)) expect(c.ucValues).not.toContain(F4_NO_BEACON_TAG)
    expect(() => assertOrganicReserved(CAMPAIGNS)).not.toThrow()
  })
})

describe('F4 has no read plan', () => {
  it('is not in ADS_READ_PLANS, and a read with rules refuses it', () => {
    expect(ADS_READ_PLANS[F4]).toBeUndefined()
    expect(() => readPlanFor(F4)).toThrow(/no ads read plan for campaign 24392866056/)
  })
  it('leaves the morning and post-flight default selection to the registered plans only', () => {
    const planned = Object.values(ADS_READ_PLANS).map((p) => p.campaignId)
    expect(planned).not.toContain(F4)
    const now = Date.parse('2026-10-28T12:05:00Z')
    // The default either names the one registered plan or refuses; its error lists plan ids and never F4.
    const attempt = (fn: () => string): string => {
      try {
        return fn()
      } catch (e) {
        return String((e as Error).message)
      }
    }
    for (const out of [attempt(() => resolveCampaignId({}, 'morning', now)), ...POSTFLIGHT_STAGES.map((s) => attempt(() => resolveCampaignId({}, 'postflight', now, s)))]) {
      expect(out).not.toContain(F4)
      if (!/^\d+$/.test(out)) expect(out).toMatch(/registered read plans/)
      else expect(planned).toContain(out)
    }
    // The pure rule on the real registry never names F4 either.
    let named = ''
    try {
      named = defaultReadCampaignId('morning', '2026-10-28')
    } catch (e) {
      named = String((e as Error).message)
    }
    expect(named).not.toContain(F4)
  })
  it('an explicit --campaign F4 resolves as a known campaign, but the read itself refuses it (no plan)', () => {
    expect(resolveCampaignId({ campaign: F4 }, 'morning', Date.now())).toBe(F4)
    expect(() => readPlanFor(F4)).toThrow()
  })
})

describe('the sync skips F4\'s placements and treats nothing as missing', () => {
  it('pullsPlacements: F4 never; every other campaign exactly as before (display with/without a plan, closed Play-direct, search)', () => {
    expect(pullsPlacements(F4, {})).toBe(false)
    expect(pullsPlacements(F4, { placements: true })).toBe(false)
    expect(channelOf(F4)).toBe('display') // the default channel is unchanged; the flag is what skips it
    // Every existing campaign keeps its old answer: display pulls, search does not.
    for (const c of CAMPAIGNS.filter((x) => x.id !== F4)) {
      const expected = channelOf(c.id) === 'display'
      expect(pullsPlacements(c.id, {}), c.id).toBe(expected)
    }
    expect(pullsPlacements(ANDROID_LAUNCH, {})).toBe(true) // closed, no plan
    expect(pullsPlacements(PLAY_DIRECT_SEPT, {})).toBe(true) // closed Play-direct Display campaign with stored placements: unchanged
    expect(pullsPlacements(ANDROID_LAUNCH, { placements: false })).toBe(false)
    CAMPAIGNS.push(testFlight(DISPLAY_NO_PLAN), testFlight(DISPLAY_PLAN))
    ADS_READ_PLANS[DISPLAY_PLAN] = buildReadPlan(DISPLAY_PLAN, { thresholds: [18, 35, 53, 70], killRulesFrom: 35, placementLeakMaxShare: 0.1, ctrFloor: 0.0015, approvedPlacements: RETEST_APPROVED_PLACEMENTS, morningReadFirstEt: '2026-10-27', morningReadLastEt: '2026-11-03' })
    expect(pullsPlacements(DISPLAY_NO_PLAN, {})).toBe(true)
    expect(pullsPlacements(DISPLAY_PLAN, {})).toBe(true)
  })

  it('the plan has no missing placement day for F4 when placements are off, and has them when on (the old behaviour)', () => {
    const rows = [{ date: '2026-10-26', costMicros: 4_000_000, impressions: 100, clicks: 5, fetchedAt: '2026-10-27T08:00:00Z', placementsFetchedAt: null }]
    const nowMs = Date.parse('2026-10-28T15:00:00Z')
    const off = planCampaignSync(f4(), rows, '2026-10-28', { placements: false, nowMs, lastPullAt: '2026-10-28T14:00:00Z' })
    expect(off.missingPlacementDays).toEqual([])
    const on = planCampaignSync(f4(), rows, '2026-10-28', { placements: true, nowMs, lastPullAt: '2026-10-28T14:00:00Z' })
    expect(on.missingPlacementDays).toEqual(['2026-10-26']) // what a display arm would be told, and what F4 is spared
  })

  it('syncs F4\'s daily spend without calling the placement report, reports no placement failure, and a rerun is a no-op', async () => {
    const daily: Record<string, ReturnType<typeof day>> = { '2026-10-26': day(4), '2026-10-27': day(9) }
    const calls: { kind: string; id: string }[] = []
    const src: AdsMetricsSource = {
      async rangeTotal(id) {
        calls.push({ kind: 'total', id })
        return null
      },
      async daily(id, since, until) {
        calls.push({ kind: 'daily', id })
        return Object.fromEntries(Object.entries(daily).filter(([d]) => d >= since && d <= until))
      },
      async placements(id) {
        calls.push({ kind: 'placements', id })
        throw new Error('group_placement_view is not valid on an App campaign') // the App-campaign failure this skip exists to avoid
      },
    }
    const sqlite = openMigratedSqlite()
    const store = createSqlAdsStore(sqliteAdsDb(sqlite), { dryRun: false, kind: 'sqlite' })
    const now = Date.parse('2026-10-28T13:00:00Z')
    const r = await syncAdsData({ ads: src, store }, { campaignIds: [F4], now, dryRun: false, source: 'ads-sync' })
    expect(r.status).toBe('ok')
    expect(calls.filter((c) => c.kind === 'placements')).toEqual([])
    const c = r.campaigns.find((x) => x.campaignId === F4)!
    expect(c.dailyOk).toBe(true)
    expect(c.placementsOk).toBeNull()
    expect(c.error).toBeNull()
    expect(c.spendThrough).toBe('2026-10-27')
    expect(sqlite.prepare('SELECT date, cost_micros FROM ads_daily_metrics WHERE campaign_id = ? ORDER BY date').all(F4)).toEqual([
      { date: '2026-10-26', cost_micros: 4_000_000 },
      { date: '2026-10-27', cost_micros: 9_000_000 },
    ])
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM ads_placement_daily WHERE campaign_id = ?').get(F4)).toEqual({ n: 0 })
    // Nothing is left "due" for placements: a rerun right after pulls nothing for F4.
    calls.length = 0
    const again = await syncAdsData({ ads: src, store }, { campaignIds: [F4], now: now + 60_000, dryRun: false, source: 'ads-sync' })
    expect(again.nothingDue).toBe(true)
    expect(calls).toEqual([])
  })

  it('a display campaign with no read plan and no flag still pulls and stores placements (unchanged)', async () => {
    CAMPAIGNS.push(testFlight(DISPLAY_NO_PLAN))
    const calls: string[] = []
    const src: AdsMetricsSource = {
      async rangeTotal() {
        return null
      },
      async daily(_id, since, until) {
        return Object.fromEntries(Object.entries({ '2026-10-26': day(4), '2026-10-27': day(9) }).filter(([d]) => d >= since && d <= until))
      },
      async placements(id) {
        calls.push(id)
        return [pl('2026-10-26'), pl('2026-10-27')]
      },
    }
    const sqlite = openMigratedSqlite()
    const store = createSqlAdsStore(sqliteAdsDb(sqlite), { dryRun: false, kind: 'sqlite' })
    const r = await syncAdsData({ ads: src, store }, { campaignIds: [DISPLAY_NO_PLAN], now: Date.parse('2026-10-28T13:00:00Z'), dryRun: false, source: 'ads-sync' })
    expect(calls).toEqual([DISPLAY_NO_PLAN])
    expect(r.campaigns[0].placementsOk).toBe(true)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM ads_placement_daily WHERE campaign_id = ?').get(DISPLAY_NO_PLAN)).toEqual({ n: 2 })
  })

  it('the config hash moves with the flag and stays put for a campaign without it', () => {
    const base = campaignsConfigHash(CAMPAIGNS)
    const without = CAMPAIGNS.map((c) => (c.id === F4 ? { ...c, noPlacements: undefined } : c))
    expect(campaignsConfigHash(without)).not.toBe(base)
    // A campaign without the flag hashes as before: the flag only adds to its own tuple.
    const others = CAMPAIGNS.filter((c) => c.id !== F4)
    expect(campaignsConfigHash(others)).toBe(campaignsConfigHash(others.map((c) => ({ ...c, noPlacements: undefined }))))
  })
})

describe('F4 is never a baseline twin', () => {
  it('closedPlayDirectCampaigns leaves F4 out even once it is marked closed, and still finds the September twin', () => {
    const closedF4: CampaignFlight = { ...f4(), status: 'closed' }
    const found = closedPlayDirectCampaigns([...CAMPAIGNS.filter((c) => c.id !== F4), closedF4]).map((c) => c.id)
    expect(found).not.toContain(F4)
    expect(found).toContain(PLAY_DIRECT_SEPT)
  })
})

describe('readers never show F4 as 0 arrivals', () => {
  it('every beacon-based binding is ruled out by config (spend-only), exactly as for the September Play-direct arm', () => {
    for (const binding of [{ metric: 'campaign.taggedArrivals' }, { metric: 'campaign.authSuccess' }, { metric: 'campaign.installs' }, { ratio: 'campaign.returnD2to7PerD0' }, { ratio: 'campaign.costPerArrival' }]) {
      expect(configRuling(binding, { kind: 'campaign', campaign: f4() }, '2026-10-28'), JSON.stringify(binding)).toBe('spend-only')
      expect(configRuling(binding, { kind: 'campaign', campaign: campaignById(PLAY_DIRECT_SEPT)! }, '2026-10-28')).toBe('spend-only')
    }
  })
})
