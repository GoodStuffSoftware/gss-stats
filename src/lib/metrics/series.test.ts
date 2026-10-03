// Daily series (ADR 0005 slice 2): the pure series rules (series.ts) and the engine end to end on
// a node:sqlite fixture, where each point must equal an independent per-ET-day count of the rows.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { etDateFast } from '../etTime'
import { SPLIT_REFUSED_PATH_PATTERNS } from '../splitGuard'
import { buildFact, deriveBatch, newSideMemo, planBatch, type FactResult } from './engine'
import { FACTS, SPEND_DAYS_SQL } from './facts'
import { METRICS } from './metrics'
import { beaconSeries, seriesTwin, spendSeries, SERIES_MAX_DAYS } from './series'
import type { MetricValue } from './types'
import { MAX_STATEMENTS, validateMetricsRequest } from './validate'

const HITS_DDL =
  "CREATE TABLE hits (id INTEGER PRIMARY KEY, ts INTEGER, site TEXT DEFAULT 'bestsudoku-web', path TEXT DEFAULT '/', referrer TEXT DEFAULT '', region TEXT DEFAULT '', city TEXT DEFAULT '', org TEXT DEFAULT '', device TEXT DEFAULT '', browser TEXT DEFAULT '', os TEXT DEFAULT '', screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', medium TEXT DEFAULT '', campaign TEXT DEFAULT '', country TEXT DEFAULT '')"
const ADS_DDL = 'CREATE TABLE ads_daily_metrics (campaign_id TEXT, date TEXT, cost_micros INTEGER, impressions INTEGER, clicks INTEGER, source TEXT, fetched_at INTEGER, placements_fetched_at INTEGER)'

interface Hit {
  ts: number
  path?: string
  visitor?: string
  campaign?: string
}
const RETEST = '24279250691' // sudoku_funnel_retest, serving 2026-09-26 12:00 ET .. 10-02

function fixture(hits: Hit[], spend: { campaign_id: string; date: string; cost_micros: number }[] = []) {
  const geo = new DatabaseSync(':memory:')
  geo.exec(HITS_DDL)
  const ins = geo.prepare('INSERT INTO hits (ts, path, visitor, campaign) VALUES (?, ?, ?, ?)')
  for (const h of hits) ins.run(h.ts, h.path ?? '/', h.visitor ?? 'new', h.campaign ?? '')
  const ads = new DatabaseSync(':memory:')
  ads.exec(ADS_DDL)
  const sp = ads.prepare('INSERT INTO ads_daily_metrics (campaign_id, date, cost_micros, impressions, clicks, source, fetched_at) VALUES (?, ?, ?, 0, 0, ?, 0)')
  for (const s of spend) sp.run(s.campaign_id, s.date, s.cost_micros, 'api')
  return { geo, ads }
}

/** Runs a batch the way functions/api/metrics.ts does: plan, execute each planned statement on the
 * fixture, derive. Returns the results and how many statements the plan counted. */
function run(db: ReturnType<typeof fixture>, nowMs: number, context: Record<string, unknown>, requests: Record<string, unknown>[]) {
  const batch = validateMetricsRequest(JSON.stringify({ v: 1, context, requests }))
  if (!batch.ok) throw new Error(batch.error)
  const todayEt = etDateFast(nowMs)
  const env = { context: batch.context, nowMs, todayEt, hasAdsDb: true }
  const memo = newSideMemo()
  const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env, memo)
  const facts = new Map<string, FactResult>()
  for (const f of plan.facts) {
    const stmt = buildFact(f, nowMs)
    const raw = (stmt.db === 'gss_geo' ? db.geo : db.ads).prepare(stmt.sql).all(...(stmt.binds as never[])) as Record<string, unknown>[]
    facts.set(f.key, { ok: true, rows: FACTS[f.id].parse(raw), asOfMs: nowMs })
  }
  return { results: deriveBatch(batch.requests, { ...env, facts }, memo), plan, statements: [...facts.values()].length }
}

const ms = (iso: string) => Date.parse(iso)
/** An independent per-ET-day tally (etDateFast is the JS twin of the SQL the facts use). */
function tally(hits: Hit[], keep: (h: Hit) => boolean = () => true): Map<string, number> {
  const m = new Map<string, number>()
  for (const h of hits) if (keep(h)) m.set(etDateFast(h.ts), (m.get(etDateFast(h.ts)) ?? 0) + 1)
  return m
}
const asMap = (v: MetricValue) => new Map((v.series ?? []).map((p) => [p.day, p.value]))

describe('seriesTwin: which metrics may have a series', () => {
  it('counts in the page window, and campaign counts in the attribution window', () => {
    expect(seriesTwin(METRICS.get('bsk.pageviews')!, 'page')).toBe('bskRangeDaily')
    expect(seriesTwin(METRICS.get('campaign.taggedArrivals')!, 'attribution')).toBe('campaignDaily')
    expect(seriesTwin(METRICS.get('campaign.spend')!, 'attribution')).toBe('adsSpendDaily')
  })
  it('never a today-so-far window, a release side, an instant or a code', () => {
    expect(seriesTwin(METRICS.get('bsk.pageviews')!, 'todaySoFar')).toBeNull()
    expect(seriesTwin(METRICS.get('bsk.pageviews')!, 'before')).toBeNull()
    expect(seriesTwin(METRICS.get('campaign.lastSync')!, 'attribution')).toBeNull()
    expect(seriesTwin(METRICS.get('campaign.spendSource')!, 'attribution')).toBeNull()
  })
})

describe('beaconSeries / spendSeries: gaps are not zeros', () => {
  const base = { onlyNew: false, anyTag: false, tags: null, capDay: '2026-10-05', reachCounted: false, measuredFromMs: null }
  it('a measured day with no rows reads 0; the axis is the window, oldest first', () => {
    const s = beaconSeries({ ...base, rows: [{ dt: '2026-10-01', path: '/', visitor: '', campaign: '', c: 3 }], firstDay: '2026-09-30', lastDay: '2026-10-02' })
    expect(s).toEqual([
      { day: '2026-09-30', value: 0 },
      { day: '2026-10-01', value: 3 },
      { day: '2026-10-02', value: 0 },
    ])
  })
  it('days before a partial go-live have no point at all', () => {
    const s = beaconSeries({ ...base, rows: [], firstDay: '2026-09-30', lastDay: '2026-10-02', measuredFromMs: ms('2026-10-01T16:00:00Z') })
    expect(s.map((p) => p.day)).toEqual(['2026-10-02']) // 10-01 begins (04:00Z) before the go-live
  })
  it('the axis never passes today and is capped at the latest SERIES_MAX_DAYS days', () => {
    const s = beaconSeries({ ...base, rows: [], firstDay: '2025-01-01', lastDay: '2026-12-31', capDay: '2026-10-05' })
    expect(s).toHaveLength(SERIES_MAX_DAYS)
    expect(s[s.length - 1].day).toBe('2026-10-05')
  })
  it('an attribution axis reaches the latest counted row past its end day', () => {
    const rows = [{ dt: '2026-10-04', path: '/', visitor: '', campaign: 'x', c: 2 }]
    const s = beaconSeries({ ...base, rows, firstDay: '2026-10-01', lastDay: '2026-10-02', reachCounted: true })
    expect(s[s.length - 1]).toEqual({ day: '2026-10-04', value: 2 })
  })
  it('visitor "new" counts only new rows; a refused-path row (visitor collapsed) is never counted as new', () => {
    const rows = [
      { dt: '2026-10-01', path: '/', visitor: 'new', campaign: '', c: 4 },
      { dt: '2026-10-01', path: '/', visitor: 'existing', campaign: '', c: 5 },
      { dt: '2026-10-01', path: '/return/x/d0', visitor: '', campaign: '', c: 6 },
    ]
    const s = beaconSeries({ ...base, rows, onlyNew: true, firstDay: '2026-10-01', lastDay: '2026-10-01' })
    expect(s).toEqual([{ day: '2026-10-01', value: 4 }])
  })
  it('spend: only stored days get a point (a day never synced is a gap, not $0), in dollars', () => {
    const rows = [
      { campaignId: 'a', date: '2026-10-02', costMicros: 5_250_000 },
      { campaignId: 'a', date: '2026-10-01', costMicros: 4_000_000 },
      { campaignId: 'b', date: '2026-10-01', costMicros: 9_000_000 },
    ]
    expect(spendSeries({ rows, campaignId: 'a', firstDay: null, capDay: '2026-10-05' })).toEqual([
      { day: '2026-10-01', value: 4 },
      { day: '2026-10-02', value: 5.25 },
    ])
  })
})

describe('engine series on a sqlite fixture', () => {
  it('a campaign attribution series equals the per-ET-day count of its tagged arrivals, and sums to the value', () => {
    const tag = 'sudoku_funnel_retest'
    const hits: Hit[] = [
      { ts: ms('2026-09-26T15:00:00Z'), campaign: tag }, // 11:00 ET: before the 12:00 start, pre-launch QA, excluded
      { ts: ms('2026-09-26T17:00:00Z'), campaign: tag }, // 13:00 ET 09-26
      { ts: ms('2026-09-26T18:00:00Z'), campaign: tag },
      { ts: ms('2026-09-27T03:30:00Z'), campaign: tag }, // 23:30 ET 09-26 (UTC says 09-27)
      { ts: ms('2026-09-28T14:00:00Z'), campaign: tag },
      { ts: ms('2026-09-28T15:00:00Z'), campaign: tag, visitor: 'existing' }, // not an arrival
      { ts: ms('2026-09-29T14:00:00Z'), campaign: 'someone_else' }, // another campaign
      { ts: ms('2026-09-29T14:00:00Z') }, // untagged
    ]
    const db = fixture(hits)
    const { results } = run(db, ms('2026-09-30T16:00:00Z'), { since: '2026-09-20', until: '2026-09-30', sites: ['bestsudoku-web'] }, [
      { key: 'a', metric: 'campaign.taggedArrivals', window: 'attribution', params: { campaignId: RETEST }, series: 'daily' },
    ])
    const v = results.a as MetricValue
    expect(v.status).not.toBe('error')
    const counted = hits.filter((h) => h.campaign === tag && (h.visitor ?? 'new') === 'new' && h.ts >= ms('2026-09-26T16:00:00Z'))
    const want = tally(counted)
    expect(want.get('2026-09-26')).toBe(3) // the 23:30 ET row stays on 09-26
    expect(v.series).toBeDefined()
    const got = asMap(v)
    for (const [day, n] of want) expect(got.get(day)).toBe(n)
    expect(got.get('2026-09-27')).toBe(0) // a measured day with no arrivals reads 0
    expect([...got.values()].reduce((a, b) => a + b, 0)).toBe(v.value)
    expect(v.series!.map((p) => p.day)).toEqual([...v.series!.map((p) => p.day)].sort()) // oldest first
  })

  it('a page-range series matches per-ET-day counts across the November DST change', () => {
    // 2026-11-01 is the fall-back day: 01:00-02:00 ET happens twice, the day has 25 hours.
    const stamps = ['2026-10-31T03:30:00Z', '2026-10-31T23:00:00Z', '2026-11-01T04:30:00Z', '2026-11-01T05:30:00Z', '2026-11-02T04:59:00Z', '2026-11-02T05:00:00Z', '2026-11-02T20:00:00Z']
    const hits: Hit[] = stamps.map((t) => ({ ts: ms(t) }))
    const db = fixture(hits)
    const { results } = run(db, ms('2026-11-03T16:00:00Z'), { since: '2026-10-30', until: '2026-11-02', sites: ['bestsudoku-web'] }, [
      { key: 'p', metric: 'bsk.pageviews', window: 'page', series: 'daily' },
    ])
    const v = results.p as MetricValue
    const want = tally(hits)
    const got = asMap(v)
    // 10-31T03:30Z is 23:30 ET on 10-30, and 11-02T04:59Z is 23:59 ET on 11-01 (EST): the SQL day must agree with etDateFast.
    for (const day of ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']) expect(got.get(day) ?? 0).toBe(want.get(day) ?? 0)
    expect([...got.values()].reduce((a, b) => a + b, 0)).toBe(v.value)
  })

  it('a series is not returned unless asked for, and the scalar is unchanged by asking', () => {
    const hits: Hit[] = [{ ts: ms('2026-10-01T16:00:00Z') }, { ts: ms('2026-10-02T16:00:00Z') }]
    const db = fixture(hits)
    const ctx = { since: '2026-10-01', until: '2026-10-02', sites: ['bestsudoku-web'] }
    const { results } = run(db, ms('2026-10-03T16:00:00Z'), ctx, [
      { key: 'plain', metric: 'bsk.pageviews', window: 'page' },
      { key: 'with', metric: 'bsk.pageviews', window: 'page', series: 'daily' },
    ])
    expect((results.plain as MetricValue).series).toBeUndefined()
    expect((results.with as MetricValue).series).toHaveLength(2)
    expect((results.with as MetricValue).value).toBe((results.plain as MetricValue).value)
  })

  it('a refused-path row never rides with a device kind: the twin collapses its visitor and only counts per day', () => {
    const hits: Hit[] = [
      { ts: ms('2026-10-01T16:00:00Z'), path: '/return/sudoku_funnel_retest/d0', visitor: 'new' },
      { ts: ms('2026-10-01T17:00:00Z'), path: '/return/sudoku_funnel_retest/d0', visitor: 'existing' },
      { ts: ms('2026-10-01T18:00:00Z'), path: '/', visitor: 'new' },
      { ts: ms('2026-10-01T18:00:00Z'), path: '/', visitor: 'existing' },
    ]
    const db = fixture(hits)
    const stmt = buildFact({ id: 'bskRangeDaily', params: { since: '2026-10-01', until: '2026-10-01' } }, ms('2026-10-02T16:00:00Z'))
    const rows = db.geo.prepare(stmt.sql).all(...(stmt.binds as never[])) as { dt: string; path: string; v: string; c: number }[]
    // The two /return rows collapse into ONE group per day and path with no visitor kind.
    const ret = rows.filter((r) => r.path.startsWith('/return/'))
    expect(ret).toEqual([{ dt: '2026-10-01', path: '/return/sudoku_funnel_retest/d0', v: '', campaign: '', c: 2 }])
    // Ordinary paths keep the kind (a plain site count, not a refused path).
    expect(rows.filter((r) => r.path === '/').map((r) => r.v).sort()).toEqual(['existing', 'new'])
    for (const p of SPLIT_REFUSED_PATH_PATTERNS) {
      for (const r of rows) if (new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$').test(r.path)) expect(r.v).toBe('')
    }
  })

  it('a spend series carries one point per stored day (no gap filled with $0)', () => {
    const db = fixture([], [
      { campaign_id: RETEST, date: '2026-09-26', cost_micros: 6_000_000 },
      { campaign_id: RETEST, date: '2026-09-28', cost_micros: 12_500_000 },
    ])
    const { results } = run(db, ms('2026-09-30T16:00:00Z'), { since: '2026-09-20', until: '2026-09-30', sites: ['bestsudoku-web'] }, [
      { key: 's', metric: 'campaign.spend', window: 'attribution', params: { campaignId: RETEST }, series: 'daily' },
    ])
    const v = results.s as MetricValue
    expect(v.series).toEqual([
      { day: '2026-09-26', value: 6 },
      { day: '2026-09-28', value: 12.5 },
    ])
  })
})

describe('validation and the statement budget', () => {
  const ctx = { since: '2026-10-01', until: '2026-10-02', sites: ['bestsudoku-web'] }
  const check = (r: Record<string, unknown>) => {
    const b = validateMetricsRequest(JSON.stringify({ v: 1, context: ctx, requests: [{ key: 'k', ...r }] }))
    if (!b.ok) throw new Error(b.error)
    return b.requests[0]
  }
  it('a ratio series is rejected (no per-day rate escapes MIN_COHORT)', () => {
    const r = check({ ratio: 'campaign.acceptPerAsk', params: { campaignId: RETEST }, window: 'attribution', series: 'daily' })
    expect(r.ok).toBe(false)
  })
  it('a country split, a today window, an unknown series kind and a store metric are rejected', () => {
    expect(check({ metric: 'campaign.taggedArrivals', params: { campaignId: RETEST, country: 'US' }, window: 'attribution', series: 'daily' }).ok).toBe(false)
    expect(check({ metric: 'bsk.pageviews', window: 'todaySoFar', series: 'daily' }).ok).toBe(false)
    expect(check({ metric: 'bsk.pageviews', window: 'page', series: 'hourly' }).ok).toBe(false)
    expect(check({ metric: 'campaign.lastSync', params: { campaignId: RETEST }, window: 'attribution', series: 'daily' }).ok).toBe(false)
  })
  it('a valid series request is accepted', () => {
    expect(check({ metric: 'bsk.pageviews', window: 'page', series: 'daily' }).ok).toBe(true)
    expect(check({ metric: 'campaign.spend', params: { campaignId: RETEST }, window: 'attribution', series: 'daily' }).ok).toBe(true)
  })
  it('the twin is one more statement per series, counted against MAX_STATEMENTS', () => {
    const mk = (series: boolean) => {
      const b = validateMetricsRequest(JSON.stringify({ v: 1, context: ctx, requests: [{ key: 'k', metric: 'bsk.pageviews', window: 'page', ...(series ? { series: 'daily' } : {}) }] }))
      if (!b.ok) throw new Error(b.error)
      return planBatch(b.requests.flatMap((r) => (r.ok ? [r.req] : [])), { context: b.context, nowMs: ms('2026-10-03T16:00:00Z'), todayEt: '2026-10-03', hasAdsDb: true })
    }
    expect(mk(false).statements).toBe(1)
    const withSeries = mk(true)
    expect(withSeries.statements).toBe(2)
    expect(withSeries.facts.map((f) => f.id).sort()).toEqual(['bskRangeDaily', 'bskRangePath'])
    expect(withSeries.statements).toBeLessThanOrEqual(MAX_STATEMENTS)
  })
  it('SPEND_DAYS_SQL reads only the ads store', () => {
    expect(SPEND_DAYS_SQL).toMatch(/FROM ads_daily_metrics/)
  })
})

describe('the daily twins read the same range the scalar does (docs/capacity.md method)', () => {
  const nowMs = Date.parse('2026-10-02T16:00:00Z')
  const plan = (db: ReturnType<typeof fixture>, id: 'campaignDaily' | 'bskRangeDaily' | 'popupRangeDaily') => {
    db.geo.exec('CREATE INDEX idx_hits_ts ON hits (ts); CREATE INDEX idx_hits_site_ts ON hits (site, ts)')
    const params = id === 'campaignDaily' ? { since: '2026-09-26', until: '2026-10-02', campaignId: RETEST, sites: ['bestsudoku-web'] } : { since: '2026-09-26', until: '2026-10-02', sites: ['bestsudoku-web'] }
    const stmt = buildFact({ id, params } as never, nowMs)
    const rows = db.geo.prepare('EXPLAIN QUERY PLAN ' + stmt.sql).all(...(stmt.binds as never[])) as { detail: string }[]
    return rows.map((r) => r.detail).join(' | ')
  }
  for (const id of ['campaignDaily', 'bskRangeDaily', 'popupRangeDaily'] as const) {
    it(`${id}: an index range search on ts (no full-table scan), one GROUP BY pass`, () => {
      const detail = plan(fixture([]), id)
      expect(detail).toMatch(/SEARCH hits USING (COVERING )?INDEX idx_hits_(site_)?ts/)
      expect(detail).not.toMatch(/SCAN hits(?! USING)/)
    })
  }
})
