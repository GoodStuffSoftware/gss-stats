// The counts-only split guard on the metrics side (R-1b, src/lib/splitGuard.ts): through the
// real POST /api/metrics handler over one node:sqlite `hits` fixture, a row the rule protects
// (a return, a game start or completion) has no country bucket, so a country cell never counts
// it, while an unfiltered count still does; completions take no country param at all; and the
// new/returning `visitor` bit stays on a refused row, because campaign.taggedArrivals reads it
// there (an arrival that came in on a /return/<uc>/d0 row is still an arrival).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost as metricsPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import { FIXTURE_NOW } from '../_lib/testing/bskFixture'
import { buildFact } from '../../src/lib/metrics/engine'
import { SPLIT_REFUSED_PATH_PATTERNS } from '../../src/lib/splitGuard'
import type { MetricRequest, MetricValue, MetricsResponseBody } from '../../src/lib/metrics/types'

const ANDROID = '24215315197'
const TAG = { site: 'bestsudoku-web', campaign: 'sudoku_tired_of_ads' }
const at = (iso: string) => Date.parse(iso)
let db: ReturnType<typeof openHitsDb>
let undoCaches: () => void

beforeAll(() => {
  db = openHitsDb()
  insertHits(db, [
    { ...TAG, ts: at('2026-09-03T15:00:00Z'), path: '/game', visitor: 'new', country: 'US', n: 5 },
    { ...TAG, ts: at('2026-09-03T15:01:00Z'), path: '/game', visitor: 'returning', country: 'CA', n: 7 },
    // Refused rows: a first-ever beacon that is a d0 return row (an arrival), completions, a start.
    { ...TAG, ts: at('2026-09-03T15:02:00Z'), path: '/return/sudoku_tired_of_ads/d0', visitor: 'new', country: 'US', n: 3 },
    { ...TAG, ts: at('2026-09-03T15:10:00Z'), path: '/game/complete/classic/easy', visitor: 'returning', country: 'US', n: 4 },
    { ...TAG, ts: at('2026-09-03T15:11:00Z'), path: '/GAME/COMPLETE/classic/hard', visitor: 'new', country: 'CA', n: 2 },
    { ...TAG, ts: at('2026-09-03T15:12:00Z'), path: '/game/start/easy', visitor: 'new', country: 'CA', n: 6 },
  ])
})
beforeEach(() => {
  vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
})
afterEach(() => {
  vi.useRealTimers()
  undoCaches()
})

async function metrics(requests: MetricRequest[]): Promise<Record<string, MetricValue>> {
  const waited: Promise<unknown>[] = []
  const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, requests }), { gss_geo: sqliteD1(db) }, waited) as any)
  await Promise.all(waited)
  if (res.status !== 200) throw new Error(await res.text())
  return ((await res.json()) as MetricsResponseBody).results
}

describe('campaignPathVisitor: refused rows have no country bucket', () => {
  it("reports cb = '' for every refused row (case folded) and the bucket for the rest", () => {
    const stmt = buildFact({ id: 'campaignPathVisitor', params: { campaignId: ANDROID } }, FIXTURE_NOW)
    // The patterns are SQL literals (lib/splitGuard.ts refusedPathMatch), never binds.
    for (const p of SPLIT_REFUSED_PATH_PATTERNS) expect(stmt.sql).toContain(`path LIKE '${p}'`)
    for (const p of SPLIT_REFUSED_PATH_PATTERNS) expect(stmt.binds).not.toContain(p)
    const rows = db.prepare(stmt.sql).all(...(stmt.binds as (string | number)[])) as { path: string; visitor: string; cb: string; c: number }[]
    const cbOf = (path: string) => [...new Set(rows.filter((r) => r.path === path).map((r) => r.cb))]
    expect(cbOf('/game')).toEqual(expect.arrayContaining(['US', 'CA']))
    for (const p of ['/return/sudoku_tired_of_ads/d0', '/game/complete/classic/easy', '/GAME/COMPLETE/classic/hard', '/game/start/easy']) expect(cbOf(p), p).toEqual([''])
    // `visitor` is kept on a refused row (the arrivals ruling).
    expect(rows.find((r) => r.path === '/return/sudoku_tired_of_ads/d0')?.visitor).toBe('new')
  })
})

describe('/api/metrics over the guarded fact', () => {
  it('a country cell leaves refused rows out; the unfiltered count keeps them', async () => {
    const p = { campaignId: ANDROID }
    const r = await metrics([
      { key: 'arrivals', metric: 'campaign.taggedArrivals', params: p },
      { key: 'arrivals_us', metric: 'campaign.taggedArrivals', params: { ...p, country: 'US' } },
      { key: 'arrivals_ca', metric: 'campaign.taggedArrivals', params: { ...p, country: 'CA' } },
      { key: 'hits', metric: 'campaign.taggedHits', params: p },
      { key: 'hits_us', metric: 'campaign.taggedHits', params: { ...p, country: 'US' } },
      { key: 'hits_other', metric: 'campaign.taggedHits', params: { ...p, country: 'other' } },
    ])
    // Arrivals: 5 (/game) + 3 (d0 return) + 2 (completion) + 6 (start) — visitor='new' on any path.
    expect(r.arrivals.value).toBe(16)
    // By country: only the non-refused /game rows have a bucket.
    expect(r.arrivals_us.value).toBe(5)
    expect(r.arrivals_ca.value).toBe(0)
    expect(r.hits.value).toBe(27)
    expect(r.hits_us.value).toBe(5)
    expect(r.hits_other.value).toBe(0) // a refused row is never folded into 'other' either
  })

  it('campaign.completions refuses a country param', async () => {
    const r = await metrics([{ key: 'c', metric: 'campaign.completions', params: { campaignId: ANDROID, country: 'US' } }])
    expect(r.c).toMatchObject({ status: 'error' })
    expect(JSON.stringify(r.c)).toContain('bad-param')
  })
})
