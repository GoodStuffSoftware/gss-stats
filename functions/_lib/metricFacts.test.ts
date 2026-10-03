// The metrics engine end to end below the HTTP layer: planBatch → fetchFacts (real SQLite,
// in-memory Cache API) → deriveBatch. Covers the statuses the equivalence fixture does not
// reach (too-few, no-data, a raised minCohort) and the ads store's fail-soft read.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { deriveBatch, planBatch } from '../../src/lib/metrics/engine'
import { validateMetricsRequest } from '../../src/lib/metrics/validate'
import { etDateFromMs } from '../../src/lib/popupEvents'
import { fetchFacts, factCacheKeyUrl, factTtlSeconds, KEY_NOW, statementCacheKeyUrl } from './metricFacts'
import { FACTS } from '../../src/lib/metrics/facts'
import { campaignById } from '../../src/lib/campaigns'
import { factCuts } from '../../src/lib/metrics/engine'
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
  const today = '2026-09-26'
  it('a closed campaign\'s rows live 15 minutes, an active one\'s 90 seconds', () => {
    expect(factTtlSeconds('campaign', { params: { campaignId: ANDROID } }, today)).toBe(900)
    expect(factTtlSeconds('campaign', { params: { campaignId: RETEST } }, today)).toBe(90)
  })
  it('a finished serving window lives a day; an open one 90 seconds; a page range by its end', () => {
    expect(factTtlSeconds('flightWindow', { params: { campaignId: ANDROID } }, today)).toBe(86_400)
    expect(factTtlSeconds('flightWindow', { params: { campaignId: RETEST } }, today)).toBe(90)
    expect(factTtlSeconds('range', { params: { since: '2026-09-14', until: '2026-09-20' } }, today)).toBe(86_400)
    expect(factTtlSeconds('range', { params: { since: '2026-09-14', until: '2026-09-25' } }, today)).toBe(86_400) // ends at today's ET midnight
    expect(factTtlSeconds('range', { params: { since: '2026-09-20', until: '2026-09-26' } }, today)).toBe(90)
    expect(factTtlSeconds('range', { params: { since: '2026-09-20T00:00:00Z', until: '2026-09-26T03:59:59Z' } }, today)).toBe(86_400) // before ET midnight
    expect(factTtlSeconds('range', { params: { since: '2026-09-20T00:00:00Z', until: '2026-09-26T04:00:01Z' } }, today)).toBe(90)
    expect(factTtlSeconds({ seconds: 300 }, { params: {} }, today)).toBe(300)
  })
})

describe('cache keys (review finding #9): SQL and bound values, never the live "now"', () => {
  const keyFor = (id: 'campaignPathVisitor' | 'flightPathsSeen' | 'campaignReturns', campaignId: string) =>
    statementCacheKeyUrl({ id, params: { campaignId } }, FACTS[id].build({ campaignId }, KEY_NOW, factCuts(id)))
  it('changing a campaign\'s flightStartTimeEt, flightStart, flightEnd or tags changes its facts\' keys', () => {
    const retest = campaignById(RETEST)!
    const saved = { ...retest }
    const before = { pv: keyFor('campaignPathVisitor', RETEST), seen: keyFor('flightPathsSeen', RETEST), ret: keyFor('campaignReturns', RETEST) }
    try {
      retest.flightStartTimeEt = '13:00'
      expect(keyFor('campaignPathVisitor', RETEST)).not.toBe(before.pv)
      Object.assign(retest, saved, { flightStart: '2026-09-25' })
      expect(keyFor('campaignPathVisitor', RETEST)).not.toBe(before.pv)
      expect(keyFor('flightPathsSeen', RETEST)).not.toBe(before.seen)
      Object.assign(retest, saved, { flightEnd: '2026-10-03' })
      expect(keyFor('flightPathsSeen', RETEST)).not.toBe(before.seen)
      Object.assign(retest, saved, { ucValues: ['sudoku_funnel_retest', 'sudoku_funnel_retest_2'] })
      expect(keyFor('campaignPathVisitor', RETEST)).not.toBe(before.pv)
      expect(keyFor('campaignReturns', RETEST)).not.toBe(before.ret)
    } finally {
      Object.assign(retest, saved)
    }
    expect(keyFor('campaignPathVisitor', RETEST)).toBe(before.pv) // restored config, same key
  })
  it('the KPI fact keys on its day, not on "now": two fetches of one day share an entry, another day does not', () => {
    const a = factCacheKeyUrl({ id: 'bskKpiDays', params: { todayEt: '2026-09-26' } })
    expect(factCacheKeyUrl({ id: 'bskKpiDays', params: { todayEt: '2026-09-26' } })).toBe(a)
    expect(factCacheKeyUrl({ id: 'bskKpiDays', params: { todayEt: '2026-09-27' } })).not.toBe(a)
    // What is hashed is the statement built at KEY_NOW, so the live bounds never enter it.
    const live1 = FACTS.bskKpiDays.build({ todayEt: '2026-09-26' }, NOW, factCuts('bskKpiDays'))
    const live2 = FACTS.bskKpiDays.build({ todayEt: '2026-09-26' }, NOW + 60_000, factCuts('bskKpiDays'))
    expect(live1.binds).not.toEqual(live2.binds)
    // The same-time bounds are inlined integers now, so the live statements differ as well.
    expect(live1.sql).not.toBe(live2.sql)
  })
  it('a key carries the entry format version and a statement hash', () => {
    const url = decodeURIComponent(factCacheKeyUrl({ id: 'adsSpend', params: {} }))
    expect(url).toMatch(/"v":2/)
    expect(url).toMatch(/"h":"[0-9a-f]{8}"/)
  })
})
