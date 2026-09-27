// At exactly ET midnight the today-so-far window is empty (start == end). It must read as a
// measured 0, not 'unmeasured': every KPI tile would otherwise flip to "not yet tracking" for
// the first moments of the day, and the answer could sit in the fact cache for up to 90 s.
// Run through the real POST /api/metrics handler over the node:sqlite fixture.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost as metricsPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import { bskFixture } from '../_lib/testing/bskFixture'
import { measuredInterval } from '../../src/lib/metrics/instrumentation'
import type { MetricRequest, MetricsResponseBody } from '../../src/lib/metrics/types'

const MIDNIGHT_ET = Date.parse('2026-09-27T04:00:00.000Z') // 00:00:00.000 EDT on 2026-09-27
let db: ReturnType<typeof openHitsDb>
let undoCaches: () => void

beforeAll(() => {
  db = openHitsDb()
  insertHits(db, bskFixture())
})
beforeEach(() => {
  undoCaches = installCaches(memoryCache())
})
afterEach(() => {
  vi.useRealTimers()
  undoCaches()
})

async function metricsAt(nowMs: number, requests: MetricRequest[]) {
  vi.useFakeTimers({ now: nowMs, toFake: ['Date'] })
  const waited: Promise<unknown>[] = []
  const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, requests }), { gss_geo: sqliteD1(db) }, waited) as never)
  await Promise.all(waited)
  expect(res.status).toBe(200)
  return ((await res.json()) as MetricsResponseBody).results
}

const TILES: MetricRequest[] = [
  { key: 'pv', metric: 'bsk.pageviews', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] },
  { key: 'played', metric: 'bsk.gameViews', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] },
  { key: 'completed', metric: 'bsk.completions', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] },
  { key: 'shown', metric: 'bsk.popupShown', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] },
  { key: 'auth', metric: 'bsk.authSuccess', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] },
  { key: 'install', metric: 'bsk.installs', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] },
  { key: 'returns', metric: 'bsk.returnsD1plus', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] },
  { key: 'tap', ratio: 'bsk.popupTapRate', window: 'todaySoFar' },
]

describe('today so far at exactly ET midnight', () => {
  it('every KPI tile is a measured 0, never "unmeasured"', async () => {
    const r = await metricsAt(MIDNIGHT_ET, TILES)
    for (const t of TILES.filter((x) => x.metric)) {
      expect(r[t.key], t.key).toMatchObject({ status: 'ok', value: 0 })
    }
    // A rate over an empty day has nothing to divide: no data, not "not yet tracking".
    expect(r.tap.status).toBe('no-data')
  })

  it('a minute later it is still measured (the same rule, a non-empty window)', async () => {
    const r = await metricsAt(MIDNIGHT_ET + 60_000, TILES)
    for (const t of TILES.filter((x) => x.metric)) expect(r[t.key].status, t.key).toBe('ok')
  })

  it('measuredInterval: an empty window is measured; a go-live after it still leaves it unmeasured', () => {
    expect(measuredInterval({ rules: [], window: [MIDNIGHT_ET, MIDNIGHT_ET] })).toMatchObject({ status: 'measured', from: MIDNIGHT_ET })
    expect(measuredInterval({ rules: [{ kind: 'liveAt', atMs: MIDNIGHT_ET - 1, source: 't' }], window: [MIDNIGHT_ET, MIDNIGHT_ET] })).toMatchObject({ status: 'measured' })
    expect(measuredInterval({ rules: [{ kind: 'liveAt', atMs: MIDNIGHT_ET + 1, source: 't' }], window: [MIDNIGHT_ET, MIDNIGHT_ET] })).toMatchObject({ status: 'unmeasured', reason: 'not-live' })
  })
})

describe('a window that has not started yet (start after end)', () => {
  const RETEST = '24279250691'
  const BEFORE_NOON = Date.parse('2026-09-26T15:59:00Z') // 11:59 EDT, the retest starts at 12:00 ET

  it('the retest at 11:59 ET on its first day: "not-started", never a measured 0 and never "not yet tracking"', async () => {
    const p = { campaignId: RETEST }
    const r = await metricsAt(BEFORE_NOON, [
      { key: 'arrivals', metric: 'campaign.taggedArrivals', params: p },
      { key: 'asks', metric: 'campaign.asks', params: p },
      { key: 'accept', ratio: 'campaign.acceptPerAsk', params: p },
      { key: 'pair', ratio: 'campaign.gameViewsVsArrivals', params: p },
    ])
    for (const k of ['arrivals', 'asks', 'accept', 'pair']) expect(r[k], k).toEqual({ status: 'unmeasured', reason: 'not-started', noteIds: ['not-started'] })
  })

  it('at 12:00 ET it starts: measured', async () => {
    const r = await metricsAt(Date.parse('2026-09-26T16:00:00Z'), [{ key: 'arrivals', metric: 'campaign.taggedArrivals', params: { campaignId: RETEST } }])
    expect(r.arrivals.status).toBe('ok')
  })

  it('measuredInterval: start after end is not-started; start == end is a measured 0', () => {
    expect(measuredInterval({ rules: [], window: [BEFORE_NOON + 60_000, BEFORE_NOON] })).toMatchObject({ status: 'unmeasured', reason: 'not-started', noteIds: ['not-started'] })
    expect(measuredInterval({ rules: [], window: [BEFORE_NOON, BEFORE_NOON] })).toMatchObject({ status: 'measured' })
  })
})
