// POST /api/metrics at the HTTP boundary: body cap, batch rejections, per-request errors,
// the planner's fact dedupe, per-fact caching and `fresh`. (Equivalence with the existing
// endpoints: metrics.equivalence.test.ts. The statement budget: metrics.budget.test.ts.)
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet, onRequestPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import { bskFixture, FIXTURE_NOW } from '../_lib/testing/bskFixture'
import { MAX_BODY_BYTES, MAX_REQUESTS } from '../../src/lib/metrics/validate'
import type { MetricsResponseBody } from '../../src/lib/metrics/types'
import type { MetricFactsEnv } from '../_lib/metricFacts'

let db: ReturnType<typeof openHitsDb>
let cache: ReturnType<typeof memoryCache>
let undoCaches: () => void
beforeAll(() => {
  db = openHitsDb()
  insertHits(db, bskFixture())
})
beforeEach(() => {
  vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ['Date'] })
  cache = memoryCache()
  undoCaches = installCaches(cache)
})
afterEach(() => {
  vi.useRealTimers()
  undoCaches()
})

async function post(body: unknown, init: { raw?: string; env?: Record<string, unknown> } = {}) {
  const d1 = sqliteD1(db)
  const waited: Promise<unknown>[] = []
  const req = init.raw !== undefined ? new Request('https://stats.goodstuff.software/api/metrics', { method: 'POST', body: init.raw }) : postJson('/api/metrics', body)
  const res = await onRequestPost(pagesContext(req, (init.env ?? { gss_geo: d1 }) as unknown as MetricFactsEnv, waited))
  await Promise.all(waited)
  return { res, json: (await res.json()) as any, statements: d1.statements }
}

const ANDROID = '24215315197'
const RETEST = '24279250691'

describe('batch-level rejections', () => {
  it(`a body over ${MAX_BODY_BYTES} bytes is a 413 before it is parsed`, async () => {
    const big = JSON.stringify({ v: 1, requests: [{ key: 'a', metric: 'bsk.pageviews', pad: 'x'.repeat(MAX_BODY_BYTES) }] })
    const { res, json, statements } = await post(null, { raw: big })
    expect(res.status).toBe(413)
    expect(json).toEqual({ error: 'body too large', maxBytes: MAX_BODY_BYTES })
    expect(statements).toEqual([])
  })
  it('a declared Content-Length over the cap is refused without reading the body', async () => {
    const req = new Request('https://stats.goodstuff.software/api/metrics', { method: 'POST', headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) }, body: '{}' })
    const res = await onRequestPost(pagesContext(req, { gss_geo: sqliteD1(db) }))
    expect(res.status).toBe(413)
  })
  it(`more than ${MAX_REQUESTS} requests is a 413 with maxRequests`, async () => {
    const requests = Array.from({ length: MAX_REQUESTS + 1 }, (_, i) => ({ key: `k${i}`, metric: 'bsk.pageviews' }))
    const { res, json } = await post({ v: 1, requests })
    expect(res.status).toBe(413)
    expect(json).toEqual({ error: 'too many requests', maxRequests: MAX_REQUESTS })
  })
  it.each([
    ['malformed JSON', null, '{"v":1,', 'invalid JSON body'],
    ['SQL in place of the body', null, 'SELECT * FROM hits', 'invalid JSON body'],
    ['an extra top-level field', { v: 1, requests: [{ key: 'a', metric: 'bsk.pageviews' }], sql: 'x' }, undefined, 'sql is not accepted'],
    ['a bad key', { v: 1, requests: [{ key: '../etc', metric: 'bsk.pageviews' }] }, undefined, 'every request needs a key matching ^[a-z0-9_.:-]{1,64}$'],
    ['a bad context date', { v: 1, context: { since: 'yesterday', until: 'today' }, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }, undefined, 'context.since must be YYYY-MM-DD or an ISO datetime'],
  ])('%s is a 400 and runs no statement', async (_n, body, raw, error) => {
    const { res, json, statements } = await post(body, raw === undefined ? {} : { raw })
    expect(res.status).toBe(400)
    expect(json.error).toBe(error)
    expect(statements).toEqual([])
  })
  it('a missing geo binding is a 500', async () => {
    const { res } = await post({ v: 1, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }, { env: {} })
    expect(res.status).toBe(500)
  })
  it('GET answers a hint, never data', async () => {
    const res = await onRequestGet(pagesContext(new Request('https://stats.goodstuff.software/api/metrics'), {}))
    expect(await res.json()).toMatchObject({ ok: true })
  })
})

describe('per-request errors never sink the batch', () => {
  it('unknown ids and params come back as error results next to real values; nothing unknown reaches SQL', async () => {
    const { res, json, statements } = await post({
      v: 1,
      requests: [
        { key: 'ok', metric: 'bsk.pageviews' },
        { key: 'unknown', metric: 'bsk.nope' },
        { key: 'sql', ratio: "x' UNION SELECT id, ts FROM hits --" },
        { key: 'param', metric: 'bsk.pageviews', params: { campaignId: ANDROID } },
        { key: 'campaign', metric: 'campaign.asks', params: { campaignId: '0 OR 1=1' } },
        { key: 'window', metric: 'campaign.asks', params: { campaignId: ANDROID }, window: 'page' },
      ],
    })
    expect(res.status).toBe(200)
    expect(json.results.ok).toMatchObject({ status: 'ok', value: 86 })
    expect(json.results.unknown).toEqual({ status: 'error', reason: 'unknown-id' })
    expect(json.results.sql).toEqual({ status: 'error', reason: 'unknown-id' })
    expect(json.results.param).toEqual({ status: 'error', reason: 'bad-param' })
    expect(json.results.campaign).toEqual({ status: 'error', reason: 'bad-param' })
    expect(json.results.window).toEqual({ status: 'error', reason: 'bad-window' })
    expect(statements).toHaveLength(1) // only the valid request's fact ran
    expect(statements.join(' ')).not.toMatch(/UNION|OR 1=1/)
  })
  it('the response carries numbers, enums and note ids only — never label text', async () => {
    const { json } = await post({ v: 1, requests: [{ key: 'a', metric: 'campaign.taggedArrivals', params: { campaignId: RETEST } }, { key: 'b', ratio: 'campaign.installPerPrompt', params: { campaignId: RETEST } }] })
    const text = JSON.stringify(json.results)
    expect(text).not.toMatch(/Tagged arrivals|Install rate|Floor —/)
    expect(json.results.a.noteIds).toEqual(['arrivals-caveat'])
  })
})

describe('planning and caching', () => {
  const OVERVIEW_BATCH = [
    ...[ANDROID, RETEST].flatMap((id) => [
      { key: `${id}.arrivals`, metric: 'campaign.taggedArrivals', params: { campaignId: id } },
      { key: `${id}.auth`, metric: 'campaign.authSuccess', params: { campaignId: id } },
      { key: `${id}.installs`, metric: 'campaign.installs', params: { campaignId: id } },
      { key: `${id}.accept`, ratio: 'campaign.acceptPerAsk', params: { campaignId: id } },
      { key: `${id}.cpa`, ratio: 'campaign.costPerArrival', params: { campaignId: id } },
      { key: `${id}.ret`, ratio: 'campaign.returnD2to7PerD0', params: { campaignId: id } },
    ]),
    { key: 'pv', metric: 'bsk.pageviews', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] },
    { key: 'gv', metric: 'bsk.gameViews', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] },
    { key: 'tap', ratio: 'bsk.popupTapRate', window: 'todaySoFar' },
  ]

  it('dedupes facts: 15 requests over two campaigns and today read 6 distinct facts', async () => {
    const { json, statements } = await post({ v: 1, requests: OVERVIEW_BATCH })
    const body = json as MetricsResponseBody
    // Android launch (closed): campaignPathVisitor + flightPathsSeen — its return rate is
    // unmeasured from config alone (the flight ended before the return beacon), so its
    // campaignReturns is never read. Retest: campaignPathVisitor + campaignReturns. Shared:
    // bskKpiMinutes, and adsSpend (0 statements without the ads binding).
    expect(body.meta).toEqual({ facts: 6, cacheHits: 0, statements: 5 })
    expect(statements).toHaveLength(5)
    expect(new Set(statements).size).toBe(statements.length) // no statement ran twice
  })

  it('caches per fact: the same batch again is all cache hits and runs nothing; fresh runs everything again', async () => {
    await post({ v: 1, requests: OVERVIEW_BATCH })
    const again = await post({ v: 1, requests: OVERVIEW_BATCH })
    expect(again.json.meta).toMatchObject({ cacheHits: 5, statements: 0 })
    expect(again.statements).toEqual([])
    const fresh = await post({ v: 1, fresh: true, requests: OVERVIEW_BATCH })
    expect(fresh.json.meta).toMatchObject({ cacheHits: 0, statements: 5 })
    expect(fresh.json.results).toEqual(again.json.results)
  })

  it('entries are shared across different batches: another card reusing a campaign fact hits the cache', async () => {
    await post({ v: 1, requests: [{ key: 'a', metric: 'campaign.asks', params: { campaignId: RETEST } }] })
    const other = await post({ v: 1, requests: [{ key: 'b', ratio: 'campaign.gameViewsVsArrivals', params: { campaignId: RETEST } }] })
    expect(other.json.meta).toEqual({ facts: 1, cacheHits: 1, statements: 0 })
    expect(other.json.results.b).toMatchObject({ status: 'ok', numerator: 21, denominator: 7, value: null })
  })

  it('a spend-only campaign plans no beacon fact at all', async () => {
    const { json } = await post({ v: 1, requests: [{ key: 'a', metric: 'campaign.taggedArrivals', params: { campaignId: '24234347705' } }] })
    expect(json.meta).toEqual({ facts: 0, cacheHits: 0, statements: 0 })
    expect(json.results.a).toEqual({ status: 'unmeasured', reason: 'spend-only' })
  })
})
