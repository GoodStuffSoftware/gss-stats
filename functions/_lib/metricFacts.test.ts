// The metrics engine end to end below the HTTP layer: planBatch → fetchFacts (real SQLite,
// in-memory Cache API) → deriveBatch. Covers the statuses the equivalence fixture does not
// reach (too-few, no-data, a raised minCohort) and the ads store's fail-soft read.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { deriveBatch, planBatch } from '../../src/lib/metrics/engine'
import { validateMetricsRequest } from '../../src/lib/metrics/validate'
import { etDateFromMs } from '../../src/lib/popupEvents'
import { fetchFacts, factTtlSeconds } from './metricFacts'
import { insertHits, memoryCache, openHitsDb, sqliteD1 } from './testing/hitsDb'

const NOW = Date.parse('2026-09-26T21:00:00Z')
const RETEST = '24279250691'
const ANDROID = '24215315197'

async function run(requests: unknown[], opts: { seed?: Parameters<typeof insertHits>[1]; ads?: D1Database } = {}) {
  const db = openHitsDb()
  insertHits(db, opts.seed ?? [])
  const batch = validateMetricsRequest(JSON.stringify({ v: 1, requests }))
  if (!batch.ok) throw new Error(batch.error)
  const env = { context: batch.context, nowMs: NOW, todayEt: etDateFromMs(NOW), hasAdsDb: !!opts.ads }
  const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env)
  const fetched = await fetchFacts(plan, { gss_geo: sqliteD1(db), gss_stats_ads: opts.ads }, { nowMs: NOW, fresh: false, cache: memoryCache(), waitUntil: () => {} })
  return deriveBatch(batch.requests, { ...env, facts: fetched.facts })
}
const retestRows = (path: string, n: number) => ({ ts: Date.parse('2026-09-26T18:00:00Z'), site: 'bestsudoku-web', campaign: 'sudoku_funnel_retest', path, visitor: 'returning', n })

describe('proportion statuses (gateRate / MIN_COHORT)', () => {
  it('too few in the denominator: status too-few, value null, n/d still returned', async () => {
    const r = await run([{ key: 'a', ratio: 'campaign.acceptPerAsk', params: { campaignId: RETEST } }], { seed: [retestRows('/signin-prompt/placement', 3), retestRows('/signin-prompt/accept', 1)] })
    expect(r.a).toEqual({ status: 'too-few', value: null, numerator: 1, denominator: 3 })
  })
  it('an empty denominator: status no-data (0/0 is still returned)', async () => {
    const r = await run([{ key: 'a', ratio: 'campaign.acceptPerAsk', params: { campaignId: RETEST } }])
    expect(r.a).toEqual({ status: 'no-data', value: null, numerator: 0, denominator: 0 })
  })
  it('a card may RAISE the floor: 6 asks pass MIN_COHORT but not minCohort 10', async () => {
    const seed = [retestRows('/signin-prompt/placement', 6), retestRows('/signin-prompt/accept', 3)]
    expect((await run([{ key: 'a', ratio: 'campaign.acceptPerAsk', params: { campaignId: RETEST } }], { seed })).a).toEqual({ status: 'ok', value: 0.5, numerator: 3, denominator: 6 })
    expect((await run([{ key: 'a', ratio: 'campaign.acceptPerAsk', params: { campaignId: RETEST }, minCohort: 10 }], { seed })).a).toMatchObject({ status: 'too-few', value: null })
  })
})

describe('spend and costs', () => {
  function adsDb(rows: [string, string, number][] | 'broken'): D1Database {
    const db = new DatabaseSync(':memory:')
    if (rows !== 'broken') {
      db.exec('CREATE TABLE ads_daily_metrics (campaign_id TEXT, date TEXT, cost_micros INTEGER, impressions INTEGER, clicks INTEGER, fetched_at TEXT)')
      for (const [id, date, micros] of rows) db.prepare('INSERT INTO ads_daily_metrics VALUES (?, ?, ?, 0, 0, ?)').run(id, date, micros, '2026-09-26T12:00:00Z')
    }
    return sqliteD1(db)
  }
  it('stored Google Ads spend beats the hand-entered CAMPAIGN_SPEND (lib/adsRules.ts resolveCampaignSpend)', async () => {
    const r = await run([{ key: 's', metric: 'campaign.spend', params: { campaignId: ANDROID } }], { ads: adsDb([[ANDROID, '2026-09-02', 100_000_000], [ANDROID, '2026-09-03', 30_000_000]]) })
    expect(r.s).toEqual({ status: 'ok', value: 130 })
  })
  it('an unreadable ads store is read fail-soft: spend falls back to CAMPAIGN_SPEND', async () => {
    expect((await run([{ key: 's', metric: 'campaign.spend', params: { campaignId: ANDROID } }], { ads: adsDb('broken') })).s).toEqual({ status: 'ok', value: 124.47 })
    expect((await run([{ key: 's', metric: 'campaign.spend', params: { campaignId: ANDROID } }])).s).toEqual({ status: 'ok', value: 124.47 })
  })
  it('no spend known at all: the spend is no-data, and so is its cost', async () => {
    const seed = [{ ts: Date.parse('2026-09-26T18:00:00Z'), site: 'bestsudoku-web', campaign: 'sudoku_funnel_retest', path: '/game', visitor: 'new', n: 9 }]
    const r = await run([{ key: 's', metric: 'campaign.spend', params: { campaignId: RETEST } }, { key: 'c', ratio: 'campaign.costPerArrival', params: { campaignId: RETEST } }], { seed })
    expect(r.s).toEqual({ status: 'no-data', value: null })
    expect(r.c).toEqual({ status: 'no-data', value: null, denominator: 9, noteIds: ['arrivals-caveat'] })
  })
  it('a cost over too few arrivals is too-few, never a fabricated ceiling', async () => {
    const seed = [{ ts: Date.parse('2026-09-03T18:00:00Z'), site: 'bestsudoku-web', campaign: 'sudoku_tired_of_ads', path: '/game', visitor: 'new', n: 3 }]
    expect((await run([{ key: 'c', ratio: 'campaign.costPerArrival', params: { campaignId: ANDROID } }], { seed })).c).toMatchObject({ status: 'too-few', value: null, numerator: 124.47, denominator: 3 })
  })
})

describe('cache lifetimes', () => {
  const now = new Date(NOW)
  it('a closed campaign\'s rows live 15 minutes, an active one\'s 90 seconds', () => {
    expect(factTtlSeconds('campaign', { params: { campaignId: ANDROID } }, now)).toBe(900)
    expect(factTtlSeconds('campaign', { params: { campaignId: RETEST } }, now)).toBe(90)
  })
  it('a finished serving window lives a day; an open one 90 seconds; a page range by its end', () => {
    expect(factTtlSeconds('flightWindow', { params: { campaignId: ANDROID } }, now)).toBe(86_400)
    expect(factTtlSeconds('flightWindow', { params: { campaignId: RETEST } }, now)).toBe(90)
    expect(factTtlSeconds('range', { params: { until: '2026-09-20' } }, now)).toBe(86_400)
    expect(factTtlSeconds('range', { params: { until: '2026-09-26' } }, now)).toBe(90)
    expect(factTtlSeconds({ seconds: 300 }, { params: {} }, now)).toBe(300)
  })
})
