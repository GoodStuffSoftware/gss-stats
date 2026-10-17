// The Flight 3 per-arm daily card and the Cost card additions, data path first: the engine on a
// node:sqlite fixture (the way series.test.ts runs it), so every figure is checked against an
// independent per-ET-day tally of the rows. Most cases use the retest flight (a closed, registered
// campaign with simple dates); one case reads the real F3 arm ids.
//   campaign.completions / campaign.f3Asks / campaign.newAccounts   daily series, ET day only
//   campaign.clicks, campaign.avgCpc, campaign.costPerComplete        the Cost card additions
// Counts-only shape: grouped by ET day (plus the row's path / visitor / campaign), never an hour, a
// place or a device; no country is accepted for the three; the series sums to the headline value.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { FLIGHT3_ASK_PATHS } from '../adsRules'
import { STAGED_FLIGHT_3 } from '../campaigns'
import { etDateFast } from '../etTime'
import { buildFact, deriveBatch, newSideMemo, planBatch, type FactResult } from './engine'
import { FACTS } from './facts'
import { METRICS } from './metrics'
import { RATIOS } from './ratios'
import type { MetricValue } from './types'
import { validateMetricsRequest } from './validate'

const HITS_DDL =
  "CREATE TABLE hits (id INTEGER PRIMARY KEY, ts INTEGER, site TEXT DEFAULT 'bestsudoku-web', path TEXT DEFAULT '/', referrer TEXT DEFAULT '', region TEXT DEFAULT '', city TEXT DEFAULT '', org TEXT DEFAULT '', device TEXT DEFAULT '', browser TEXT DEFAULT '', os TEXT DEFAULT '', screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', medium TEXT DEFAULT '', campaign TEXT DEFAULT '', country TEXT DEFAULT '')"
const ADS_DDL = 'CREATE TABLE ads_daily_metrics (campaign_id TEXT, date TEXT, cost_micros INTEGER, impressions INTEGER, clicks INTEGER, source TEXT, fetched_at INTEGER, placements_fetched_at INTEGER)'

interface Hit {
  ts: number
  path: string
  visitor?: string
  campaign?: string
}
interface Spend {
  campaign_id: string
  date: string
  cost_micros: number
  clicks?: number
}
const RETEST = '24279250691' // sudoku_funnel_retest, serving 2026-09-26 12:00 ET .. 10-02
const TAG = 'sudoku_funnel_retest'
const NOW0 = Date.parse('2026-09-30T16:00:00Z')
const NOW = NOW0
const CTX = { since: '2026-09-20', until: '2026-09-30', sites: ['bestsudoku-web'] }
const ms = (iso: string) => Date.parse(iso)

function fixture(hits: Hit[], spend: Spend[] = []) {
  const geo = new DatabaseSync(':memory:')
  geo.exec(HITS_DDL)
  const ins = geo.prepare('INSERT INTO hits (ts, path, visitor, campaign) VALUES (?, ?, ?, ?)')
  for (const h of hits) ins.run(h.ts, h.path, h.visitor ?? 'new', h.campaign ?? TAG)
  const ads = new DatabaseSync(':memory:')
  ads.exec(ADS_DDL)
  const sp = ads.prepare('INSERT INTO ads_daily_metrics (campaign_id, date, cost_micros, impressions, clicks, source, fetched_at) VALUES (?, ?, ?, 0, ?, ?, 0)')
  for (const s of spend) sp.run(s.campaign_id, s.date, s.cost_micros, s.clicks ?? 0, 'api')
  return { geo, ads }
}

/** The batch the way functions/api/metrics.ts runs it: plan, execute each planned statement on the
 * fixture, derive. */
function run(db: ReturnType<typeof fixture>, requests: Record<string, unknown>[], context: Record<string, unknown> = CTX, NOW = NOW0) {
  const batch = validateMetricsRequest(JSON.stringify({ v: 1, context, requests }))
  if (!batch.ok) throw new Error(batch.error)
  const env = { context: batch.context, nowMs: NOW, todayEt: etDateFast(NOW), hasAdsDb: true }
  const memo = newSideMemo()
  const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env, memo)
  const facts = new Map<string, FactResult>()
  const executed: { sql: string; binds: unknown[] }[] = []
  for (const f of plan.facts) {
    const stmt = buildFact(f, NOW)
    executed.push({ sql: stmt.sql, binds: stmt.binds as unknown[] })
    const raw = (stmt.db === 'gss_geo' ? db.geo : db.ads).prepare(stmt.sql).all(...(stmt.binds as never[])) as Record<string, unknown>[]
    facts.set(f.key, { ok: true, rows: FACTS[f.id].parse(raw), asOfMs: NOW })
  }
  return { results: deriveBatch(batch.requests, { ...env, facts }, memo), executed }
}
const daily = (key: string, metric: string, params: Record<string, unknown> = { campaignId: RETEST }) => ({ key, metric, window: 'attribution', params, series: 'daily' })

/** An independent per-ET-day tally (etDateFast is the JS twin of the SQL the facts use). */
function tally(hits: Hit[], keep: (h: Hit) => boolean): Map<string, number> {
  const m = new Map<string, number>()
  for (const h of hits) if (keep(h)) m.set(etDateFast(h.ts), (m.get(etDateFast(h.ts)) ?? 0) + 1)
  return m
}
const asMap = (v: MetricValue) => new Map((v.series ?? []).map((p) => [p.day, p.value]))
const at = (iso: string, path: string, extra: Partial<Hit> = {}): Hit => ({ ts: ms(iso), path, ...extra })

// Rows over three ET days (09-28, 09-29, 09-30), tagged and not, every family the three metrics
// must count or leave out. 23:30 ET on 09-28 is 03:30Z on 09-29 (the ET day, not the UTC one).
const HITS: Hit[] = [
  // completed games (a split-refused path family: read as a per-day total only)
  at('2026-09-28T14:00:00Z', '/game/complete/classic'),
  at('2026-09-28T15:00:00Z', '/game/complete/classic'),
  at('2026-09-29T03:30:00Z', '/game/complete/daily'), // 23:30 ET 09-28
  at('2026-09-29T14:00:00Z', '/game/complete/classic'),
  at('2026-09-29T14:30:00Z', '/game/complete/classic', { campaign: 'someone_else' }), // another campaign
  at('2026-09-29T15:00:00Z', '/game/complete/classic', { campaign: '' }), // untagged
  at('2026-09-30T14:00:00Z', '/game/complete/classic', { visitor: 'existing' }), // completions count every visitor kind
  // the three F3 sign-in asks, plus the asks the F3 client silences or keeps separate, plus a twin
  at('2026-09-28T14:10:00Z', '/signin-prompt/placement'),
  at('2026-09-28T14:20:00Z', '/signin-prompt/committed-repeat'),
  at('2026-09-29T14:10:00Z', '/signin-prompt/committed-challenge'),
  at('2026-09-29T14:20:00Z', '/signin-prompt/committed-challenge'),
  at('2026-09-29T14:30:00Z', '/signin-prompt/streak'), // silenced
  at('2026-09-29T14:40:00Z', '/signin-prompt/tutorial'), // silenced
  at('2026-09-29T14:50:00Z', '/promo-first50/shown'), // separate offer
  at('2026-09-29T15:10:00Z', '/ab/ask-order/ask-first/signin-prompt/placement'), // the A/B twin of a real row
  at('2026-09-30T14:10:00Z', '/signin-prompt/placement', { campaign: 'someone_else' }),
  // sign-ins: only /new counts as a new account
  at('2026-09-28T14:30:00Z', '/auth/success/google/new'),
  at('2026-09-29T14:30:00Z', '/auth/success/email/new'),
  at('2026-09-29T14:35:00Z', '/auth/success/google/existing'),
  at('2026-09-29T14:36:00Z', '/auth/success/google/unknown'),
  at('2026-09-29T14:37:00Z', '/auth/success/google'), // the pre-v1.99.2 base row, no status
  at('2026-09-30T14:30:00Z', '/auth/success/google/new', { campaign: 'someone_else' }),
]

describe('the three F3 daily metrics: per-ET-day counts that sum to the value', () => {
  const db = fixture(HITS)
  const { results } = run(db, [daily('done', 'campaign.completions'), daily('asks', 'campaign.f3Asks'), daily('accounts', 'campaign.newAccounts')])
  const tagged = (h: Hit) => (h.campaign ?? TAG) === TAG
  const want = {
    done: tally(HITS, (h) => tagged(h) && h.path.startsWith('/game/complete/')),
    asks: tally(HITS, (h) => tagged(h) && (FLIGHT3_ASK_PATHS as readonly string[]).includes(h.path)),
    accounts: tally(HITS, (h) => tagged(h) && /^\/auth\/success\/(google|email)\/new$/.test(h.path)),
  }

  for (const key of ['done', 'asks', 'accounts'] as const) {
    it(`${key}: one point per ET day equal to an independent tally, summing to the value`, () => {
      const v = results[key] as MetricValue
      expect(v.status, key).not.toBe('error')
      expect(v.series, key).toBeDefined()
      const got = asMap(v)
      for (const [day, n] of want[key]) expect(got.get(day), `${key} ${day}`).toBe(n)
      expect([...got.values()].reduce((a, b) => a + b, 0)).toBe(v.value)
      expect(v.value).toBe([...want[key].values()].reduce((a, b) => a + b, 0))
      expect(v.series!.map((p) => p.day)).toEqual([...v.series!.map((p) => p.day)].sort()) // oldest first
    })
  }

  it('the expected figures themselves (so the tally cannot drift with the rows)', () => {
    expect(Object.fromEntries(want.done)).toEqual({ '2026-09-28': 3, '2026-09-29': 1, '2026-09-30': 1 }) // the 23:30 ET row stays on 09-28
    expect(Object.fromEntries(want.asks)).toEqual({ '2026-09-28': 2, '2026-09-29': 2 })
    expect(Object.fromEntries(want.accounts)).toEqual({ '2026-09-28': 1, '2026-09-29': 1 })
  })

  it('asks are only the three F3 paths: streak, tutorial, promo and the /ab/ask-order twin are not counted', () => {
    const v = results.asks as MetricValue
    expect(v.value).toBe(4)
    expect(asMap(v).get('2026-09-29')).toBe(2) // committed-challenge x2, not the 3 silenced/twin rows beside them
  })

  it('new accounts are /auth/success/<provider>/new only: not existing, unknown or the base row', () => {
    const v = results.accounts as MetricValue
    expect(v.value).toBe(2)
    expect(asMap(v).get('2026-09-29')).toBe(1)
  })

  it('a measured day with no rows reads 0, not a gap', () => {
    expect(asMap(results.asks as MetricValue).get('2026-09-30')).toBe(0)
    expect(asMap(results.accounts as MetricValue).get('2026-09-30')).toBe(0)
  })

  it('an unrelated campaign id reads nothing at all (no rows of another campaign leak in)', () => {
    const none = run(db, [daily('x', 'campaign.f3Asks', { campaignId: '99999999999' })])
    const v = none.results.x as MetricValue
    expect(v.series ?? []).toEqual([])
  })
})

describe('empty and staged states', () => {
  it('a registered campaign with no rows at all: zero value, no error', () => {
    const { results } = run(fixture([]), [daily('asks', 'campaign.f3Asks'), daily('accounts', 'campaign.newAccounts'), daily('done', 'campaign.completions')])
    for (const key of ['asks', 'accounts', 'done']) {
      const v = results[key] as MetricValue
      expect(v.status, key).not.toBe('error')
      expect(v.value, key).toBe(0)
    }
  })
  it('the real F3 arm ids read their own tags: both creatives of the Apps arm, nothing of the Search arm', () => {
    const f3Now = ms('2026-10-20T16:00:00Z')
    const f3Hits: Hit[] = [
      at('2026-10-18T14:00:00Z', '/signin-prompt/placement', { campaign: 'sudoku_funnel_f3_apps_hero' }),
      at('2026-10-18T15:00:00Z', '/signin-prompt/committed-repeat', { campaign: 'sudoku_funnel_f3_apps_feat' }),
      at('2026-10-19T15:00:00Z', '/signin-prompt/committed-challenge', { campaign: 'sudoku_funnel_f3_apps_hero' }),
      at('2026-10-19T15:00:00Z', '/signin-prompt/placement', { campaign: 'sudoku_funnel_f3_search' }),
      at('2026-10-19T16:00:00Z', '/signin-prompt/placement', { campaign: TAG }), // another flight
    ]
    const ctx = { since: '2026-10-17', until: '2026-10-20', sites: ['bestsudoku-web'] }
    const { results } = run(fixture(f3Hits), [daily('apps', 'campaign.f3Asks', { campaignId: STAGED_FLIGHT_3.apps.ids.campaignId }), daily('search', 'campaign.f3Asks', { campaignId: STAGED_FLIGHT_3.search.ids.campaignId })], ctx, f3Now)
    const apps = results.apps as MetricValue
    const search = results.search as MetricValue
    expect(apps.value).toBe(3)
    expect(Object.fromEntries(asMap(apps))).toMatchObject({ '2026-10-18': 2, '2026-10-19': 1 })
    expect(search.value).toBe(1)
    expect(apps.series!.reduce((a, p) => a + p.value, 0)).toBe(apps.value)
  })
})

describe('counts only: a day is the finest cut', () => {
  const ctx = { since: '2026-09-28', until: '2026-09-30', sites: ['bestsudoku-web'] }
  const check = (r: Record<string, unknown>) => {
    const b = validateMetricsRequest(JSON.stringify({ v: 1, context: ctx, requests: [{ key: 'k', ...r }] }))
    if (!b.ok) throw new Error(b.error)
    return b.requests[0]
  }
  it('none of the three accepts a country (or any other split) parameter', () => {
    for (const metric of ['campaign.completions', 'campaign.f3Asks', 'campaign.newAccounts']) {
      expect(check({ metric, params: { campaignId: RETEST }, window: 'attribution', series: 'daily' }).ok, metric).toBe(true)
      expect(check({ metric, params: { campaignId: RETEST, country: 'US' }, window: 'attribution', series: 'daily' }).ok, metric).toBe(false)
      expect(check({ metric, params: { campaignId: RETEST, hour: 14 }, window: 'attribution', series: 'daily' }).ok, metric).toBe(false)
    }
  })
  it('no hourly series kind, no today window and no ratio series', () => {
    expect(check({ metric: 'campaign.f3Asks', params: { campaignId: RETEST }, window: 'attribution', series: 'hourly' }).ok).toBe(false)
    expect(check({ metric: 'campaign.f3Asks', params: { campaignId: RETEST }, window: 'todaySoFar', series: 'daily' }).ok).toBe(false)
    expect(check({ ratio: 'campaign.costPerComplete', params: { campaignId: RETEST }, window: 'attribution', series: 'daily' }).ok).toBe(false)
  })
  it('the statements the series run select the ET day, path, visitor and campaign only: no hour, place or device column', () => {
    const { executed } = run(fixture(HITS), [daily('asks', 'campaign.f3Asks'), daily('accounts', 'campaign.newAccounts'), daily('done', 'campaign.completions')])
    const daySql = executed.filter((s) => /GROUP BY/i.test(s.sql) && /dt/.test(s.sql))
    expect(daySql.length).toBeGreaterThan(0)
    for (const s of daySql) {
      // The grouping and the selected columns (the WHERE only filters out excluded visits).
      expect(/GROUP BY (.*)$/i.exec(s.sql)![1].trim()).toBe('dt, path, v, campaign')
      const selected = s.sql.slice(0, s.sql.search(/FROM hits/))
      expect(selected).toMatch(/AS dt, path, visitor AS v, campaign, COUNT\(\*\) AS c $/)
    }
  })
  it('the daily rows carry only the day, path, visitor, campaign and the count', () => {
    const stmt = buildFact({ id: 'campaignDaily', params: { since: '2026-09-26', until: '2026-09-30', campaignId: RETEST } } as never, NOW)
    const rows = fixture(HITS).geo.prepare(stmt.sql).all(...(stmt.binds as never[])) as Record<string, unknown>[]
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['c', 'campaign', 'dt', 'path', 'v'])
  })
  it('the metrics are registered counts with no country param', () => {
    for (const id of ['campaign.completions', 'campaign.f3Asks', 'campaign.newAccounts']) {
      const def = METRICS.get(id)!
      expect(def, id).toBeDefined()
      expect(def.params, id).toEqual(['campaignId'])
    }
  })
})

describe('Cost card additions: average CPC and cost per completed game', () => {
  const spend: Spend[] = [
    { campaign_id: RETEST, date: '2026-09-28', cost_micros: 6_000_000, clicks: 10 },
    { campaign_id: RETEST, date: '2026-09-29', cost_micros: 4_000_000, clicks: 10 },
  ]
  const ratio = (key: string, id: string) => ({ key, ratio: id, window: 'attribution', params: { campaignId: RETEST } })

  it('registers both as cost ratios over stored spend', () => {
    expect(RATIOS.get('campaign.avgCpc')).toMatchObject({ kind: 'cost', num: 'campaign.spend', den: 'campaign.clicks' })
    expect(RATIOS.get('campaign.costPerComplete')).toMatchObject({ kind: 'cost', num: 'campaign.spend', den: 'campaign.completions' })
  })
  it('clicks are the stored Google Ads clicks of the spend days', () => {
    const { results } = run(fixture([], spend), [{ key: 'k', metric: 'campaign.clicks', window: 'attribution', params: { campaignId: RETEST } }])
    expect((results.k as MetricValue).value).toBe(20)
  })
  it('average CPC is spend over clicks; cost per completed game is spend over tagged completions', () => {
    const hits: Hit[] = Array.from({ length: 8 }, (_, i) => at(`2026-09-28T1${i}:00:00Z`, '/game/complete/classic'))
    const { results } = run(fixture(hits, spend), [ratio('cpc', 'campaign.avgCpc'), ratio('cpg', 'campaign.costPerComplete')])
    const cpc = results.cpc as MetricValue
    const cpg = results.cpg as MetricValue
    expect(cpc.status).not.toBe('error')
    expect(cpc.value).toBeCloseTo(10 / 20, 6) // $10 over 20 clicks
    expect(cpg.status).not.toBe('error')
    expect(cpg.value).toBeCloseTo(10 / 8, 6) // $10 over 8 completed games
  })
  it('too few completions: the cost per game is withheld, not a figure over a tiny cohort', () => {
    const hits: Hit[] = [at('2026-09-28T14:00:00Z', '/game/complete/classic'), at('2026-09-28T15:00:00Z', '/game/complete/classic')]
    const { results } = run(fixture(hits, spend), [ratio('cpg', 'campaign.costPerComplete')])
    const v = results.cpg as MetricValue
    expect(v.status).toBe('too-few')
  })
  it('no stored spend (config-only or none): no clicks, so no average CPC (never a figure over zero)', () => {
    const { results } = run(fixture([]), [{ key: 'clicks', metric: 'campaign.clicks', window: 'attribution', params: { campaignId: RETEST } }, ratio('cpc', 'campaign.avgCpc')])
    const clicks = results.clicks as MetricValue
    expect(clicks).toMatchObject({ status: 'no-data', value: null })
    expect(results.cpc).toMatchObject({ status: 'no-data', value: null })
  })
  it('hand-entered spend (CAMPAIGN_SPEND, no ads-store rows) has a spend but no clicks: the average CPC reads no data', () => {
    const hand = '24215315197' // $124.47 hand-entered
    const { results } = run(fixture([]), [
      { key: 'spend', metric: 'campaign.spend', window: 'attribution', params: { campaignId: hand } },
      { key: 'clicks', metric: 'campaign.clicks', window: 'attribution', params: { campaignId: hand } },
      { key: 'cpc', ratio: 'campaign.avgCpc', window: 'attribution', params: { campaignId: hand } },
    ])
    expect((results.spend as MetricValue).value).toBe(124.47)
    expect(results.clicks).toMatchObject({ status: 'no-data', value: null })
    expect(results.cpc).toMatchObject({ status: 'no-data', value: null })
  })
})
