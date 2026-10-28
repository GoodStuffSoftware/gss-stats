// Google Ads installs per campaign per day (campaign.adsInstalls) and cost per install
// (campaign.costPerAdsInstall), data path first: the engine on a node:sqlite ads store built from
// the real migrations (0001..0007), the way f3Daily.test.ts runs the geo side. Counts only: a
// campaign's own Google-reported conversions on its registered install action, per ET day.
//   ratio of sums        cost per install = sum(spend) / sum(installs), never a mean of daily ratios
//   no value, not zero   no installActionId, or no stored spend day, or no installs
//   gap, not zero        a day the ads store never synced has no series point
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { campaignById, CAMPAIGNS } from '../campaigns'
import { etDateFast } from '../etTime'
import { buildFact, deriveBatch, newSideMemo, planBatch, type FactResult } from './engine'
import { FACTS, installsDaysStatement } from './facts'
import { METRICS } from './metrics'
import { RATIOS } from './ratios'
import { installsSeries, seriesTwin } from './series'
import type { MetricValue } from './types'
import { validateMetricsRequest } from './validate'

const F4 = '24392866056' // the registered Android installs campaign: the only one with an installActionId
const F4_ACTION = '7756366796'
const OTHER_ACTION = '1234567890' // made up: another conversion action on the same campaign
const NO_ACTION = CAMPAIGNS.find((c) => !c.installActionId && c.id !== F4)!.id // a registered campaign with no installActionId
const NOW = Date.parse('2026-10-28T16:00:00Z')
const CTX = { since: '2026-10-26', until: '2026-10-28', sites: ['bestsudoku-web'] }

interface Spend {
  campaign_id: string
  date: string
  cost: number // dollars
  clicks?: number
}
interface Conv {
  campaign_id: string
  date: string
  action: string
  conversions: number
}

/** The real ads schema (every migration, in order), with only the rows the case needs. */
function adsDb(spend: Spend[], convs: Conv[]): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const dir = 'migrations/gss-stats-ads'
  for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) db.exec(readFileSync(`${dir}/${f}`, 'utf8'))
  const ids = new Set([...spend.map((s) => s.campaign_id), ...convs.map((c) => c.campaign_id)])
  for (const id of ids) {
    db.prepare(
      "INSERT INTO ads_campaigns (id, name, uc_values, kind, flight_start, flight_end, status, measurement, synced_at) VALUES (?, 'x', '[]', 'web', '2026-10-26', '2026-11-02', 'active', 'spend-only', '2026-10-28T00:00:00Z')",
    ).run(id)
  }
  for (const s of spend) {
    db.prepare("INSERT INTO ads_daily_metrics (campaign_id, date, cost_micros, impressions, clicks, source, fetched_at) VALUES (?, ?, ?, 1000, ?, 'google-ads-api', '2026-10-28T00:00:00Z')").run(
      s.campaign_id,
      s.date,
      Math.round(s.cost * 1_000_000),
      s.clicks ?? 0,
    )
  }
  for (const c of convs) {
    db.prepare(
      "INSERT INTO ads_daily_conversions (campaign_id, date, conversion_action_id, conversion_action_name, conversions, all_conversions, source, fetched_at) VALUES (?, ?, ?, NULL, ?, ?, 'google-ads-api', '2026-10-28T00:00:00Z')",
    ).run(c.campaign_id, c.date, c.action, c.conversions, c.conversions)
  }
  return db
}

/** The batch the way functions/api/metrics.ts runs it (the ads side only: no geo fact is planned for these requests). */
function run(db: DatabaseSync, requests: Record<string, unknown>[], context: Record<string, unknown> = CTX) {
  const batch = validateMetricsRequest(JSON.stringify({ v: 1, context, requests }))
  if (!batch.ok) throw new Error(batch.error)
  const env = { context: batch.context, nowMs: NOW, todayEt: etDateFast(NOW), hasAdsDb: true }
  const memo = newSideMemo()
  const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env, memo)
  const facts = new Map<string, FactResult>()
  for (const f of plan.facts) {
    const stmt = buildFact(f, NOW)
    if (stmt.db !== 'gss_stats_ads') throw new Error(`unexpected geo fact ${f.id}`)
    const raw = db.prepare(stmt.sql).all(...(stmt.binds as never[])) as Record<string, unknown>[]
    facts.set(f.key, { ok: true, rows: FACTS[f.id].parse(raw), asOfMs: NOW })
  }
  return deriveBatch(batch.requests, { ...env, facts }, memo)
}
const installs = (campaignId = F4, extra: Record<string, unknown> = {}) => ({ key: 'i', metric: 'campaign.adsInstalls', window: 'attribution', params: { campaignId }, ...extra })
const cpi = (campaignId = F4) => ({ key: 'c', ratio: 'campaign.costPerAdsInstall', window: 'attribution', params: { campaignId } })

const SPEND: Spend[] = [
  { campaign_id: F4, date: '2026-10-26', cost: 40 },
  { campaign_id: F4, date: '2026-10-27', cost: 50 },
]
const CONVS: Conv[] = [
  { campaign_id: F4, date: '2026-10-26', action: F4_ACTION, conversions: 4 },
  { campaign_id: F4, date: '2026-10-27', action: F4_ACTION, conversions: 20 },
  { campaign_id: F4, date: '2026-10-27', action: OTHER_ACTION, conversions: 99 }, // another action: never counted
]

describe('registry', () => {
  it('only the Android installs campaign names an install action', () => {
    expect(campaignById(F4)!.installActionId).toBe(F4_ACTION)
    expect(CAMPAIGNS.filter((c) => c.installActionId).map((c) => c.id)).toEqual([F4])
  })
  it('registers the two metrics beside campaign.spend and campaign.clicks', () => {
    const def = METRICS.get('campaign.adsInstalls')!
    expect(def).toMatchObject({ unit: 'install', params: ['campaignId'], windows: { attribution: 'adsInstallsDaily' } })
    expect(def.caveats).toContain('ads-installs-google')
    expect(RATIOS.get('campaign.costPerAdsInstall')).toMatchObject({ kind: 'cost', num: 'campaign.spend', den: 'campaign.adsInstalls' })
  })
  it('installs have a daily series (and clicks share the spend twin); the ratio has none', () => {
    expect(seriesTwin(METRICS.get('campaign.adsInstalls')!, 'attribution')).toBe('adsInstallsDaily')
    expect(seriesTwin(METRICS.get('campaign.clicks')!, 'attribution')).toBe('adsSpendDaily')
  })
})

describe('installsDaysStatement on the real schema', () => {
  const stmt = (db: DatabaseSync, pairs: { campaignId: string; actionId: string }[]) => {
    const s = installsDaysStatement(pairs)
    return db.prepare(s.sql).all(...(s.binds as never[])) as { campaign_id: string; date: string; installs: number }[]
  }
  it('one row per stored spend day; the install action only; a spend day with no conversion row is 0; an unsynced day has no row', () => {
    const db = adsDb(
      [...SPEND, { campaign_id: F4, date: '2026-10-28', cost: 5 }], // 10-28 stored, no conversion row
      CONVS,
    )
    expect(stmt(db, [{ campaignId: F4, actionId: F4_ACTION }])).toEqual([
      { campaign_id: F4, date: '2026-10-26', installs: 4 },
      { campaign_id: F4, date: '2026-10-27', installs: 20 },
      { campaign_id: F4, date: '2026-10-28', installs: 0 },
    ])
  })
  it('a conversion on a day with no stored spend is not a row (no spend day to hang it on)', () => {
    const db = adsDb(SPEND, [...CONVS, { campaign_id: F4, date: '2026-10-29', action: F4_ACTION, conversions: 7 }])
    expect(stmt(db, [{ campaignId: F4, actionId: F4_ACTION }]).map((r) => r.date)).toEqual(['2026-10-26', '2026-10-27'])
  })
  it('each campaign counts only its own action, and a campaign not in the list has no rows', () => {
    const OTHER = '9100000001' // made up
    const db = adsDb(
      [...SPEND, { campaign_id: OTHER, date: '2026-10-26', cost: 3 }, { campaign_id: '9100000002', date: '2026-10-26', cost: 3 }],
      [...CONVS, { campaign_id: OTHER, date: '2026-10-26', action: OTHER_ACTION, conversions: 6 }, { campaign_id: '9100000002', date: '2026-10-26', action: F4_ACTION, conversions: 8 }],
    )
    const rows = stmt(db, [
      { campaignId: F4, actionId: F4_ACTION },
      { campaignId: OTHER, actionId: OTHER_ACTION },
    ])
    expect(rows.filter((r) => r.campaign_id === F4).map((r) => r.installs)).toEqual([4, 20]) // OTHER_ACTION on F4 stays out
    expect(rows.filter((r) => r.campaign_id === OTHER).map((r) => r.installs)).toEqual([6])
    expect(rows.some((r) => r.campaign_id === '9100000002')).toBe(false)
  })
  it('no campaign names an action: an empty, valid statement', () => {
    expect(stmt(adsDb(SPEND, CONVS), [])).toEqual([])
  })
  it('the planned fact binds one (campaign, action) pair per action campaign, then the campaign list', () => {
    const s = buildFact({ id: 'adsInstallsDaily', params: {} } as never, NOW)
    expect(s.db).toBe('gss_stats_ads')
    expect(s.binds).toEqual([F4, F4_ACTION, F4])
  })
})

describe('campaign.adsInstalls and cost per install', () => {
  it('installs are the sum of the install action over the stored spend days, with a daily series that sums to it', () => {
    const r = run(adsDb(SPEND, CONVS), [installs(F4, { series: 'daily' })])
    const v = r.i as MetricValue
    expect(v.value).toBe(24)
    expect(v.series).toEqual([
      { day: '2026-10-26', value: 4 },
      { day: '2026-10-27', value: 20 },
    ])
    expect(v.noteIds).toContain('ads-installs-google')
  })
  it('cost per install is a ratio of sums: $90 over 24 installs, not the mean of the daily ratios', () => {
    const v = run(adsDb(SPEND, CONVS), [cpi()]).c as MetricValue
    expect(v.numerator).toBe(90)
    expect(v.denominator).toBe(24)
    expect(v.value).toBeCloseTo(90 / 24, 6) // 3.75; the mean of 10 and 2.5 would be 6.25
  })
  it('a fractional (credit-split) install count is kept', () => {
    const v = run(adsDb(SPEND, [{ campaign_id: F4, date: '2026-10-26', action: F4_ACTION, conversions: 10.5 }]), [installs()]).i as MetricValue
    expect(v.value).toBe(10.5)
  })
  it('zero installs on the stored days: cost per install is null, never a figure over zero', () => {
    const r = run(adsDb(SPEND, []), [cpi()])
    expect(r.c).toMatchObject({ status: 'no-data', value: null })
  })
  it('fewer than 5 installs: the cost is withheld as too-few, not a figure over a tiny cohort', () => {
    const v = run(adsDb(SPEND, [{ campaign_id: F4, date: '2026-10-26', action: F4_ACTION, conversions: 4 }]), [cpi()]).c as MetricValue
    expect(v.status).toBe('too-few')
  })
  it('no stored spend day: no installs value and no cost per install', () => {
    const r = run(adsDb([], []), [installs(), cpi()])
    expect(r.i).toMatchObject({ value: null })
    expect(r.c).toMatchObject({ value: null })
  })
  it('a campaign without an installActionId has no installs and no cost per install (never 0), whatever the table holds', () => {
    const db = adsDb([{ campaign_id: NO_ACTION, date: '2026-10-26', cost: 20 }], [{ campaign_id: NO_ACTION, date: '2026-10-26', action: F4_ACTION, conversions: 50 }])
    const r = run(db, [installs(NO_ACTION), cpi(NO_ACTION)])
    expect(r.i).toMatchObject({ value: null })
    expect(r.c).toMatchObject({ value: null })
  })
})

describe('installsSeries', () => {
  const rows = [
    { campaignId: 'a', date: '2026-10-27', installs: 20 },
    { campaignId: 'a', date: '2026-10-26', installs: 4 },
    { campaignId: 'b', date: '2026-10-26', installs: 9 },
    { campaignId: 'a', date: '2026-10-30', installs: 3 },
  ]
  it('sorted by day, one campaign, a gap (an unsynced day) is no point, and nothing past the cap day', () => {
    expect(installsSeries({ rows, campaignId: 'a', capDay: '2026-10-28' })).toEqual([
      { day: '2026-10-26', value: 4 },
      { day: '2026-10-27', value: 20 },
    ])
  })
})
