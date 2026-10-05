// `liveSafe: true` on /api/metrics values: only where the metric (or both sides of a ratio) can never
// count a refused row (MetricDef.countsRefused === false). Fail-closed: refused-capable metrics,
// ratios with a refused-capable side, and unknown ids get no key. Every other field is unchanged.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import { bskFixture, FIXTURE_NOW } from '../_lib/testing/bskFixture'
import { requestNeverCountsRefused } from '../../src/lib/metrics/engine'
import { METRICS, type MetricDef } from '../../src/lib/metrics/metrics'
import { RATIOS, type RatioDef } from '../../src/lib/metrics/ratios'
import type { MetricFactsEnv } from '../_lib/metricFacts'

let db: ReturnType<typeof openHitsDb>
let undoCaches: () => void
beforeAll(() => {
  db = openHitsDb()
  insertHits(db, bskFixture())
})
beforeEach(() => {
  vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
})
afterEach(() => {
  vi.useRealTimers()
  undoCaches()
})

async function post(requests: unknown[]) {
  const waited: Promise<unknown>[] = []
  const res = await onRequestPost(pagesContext(postJson('/api/metrics', { v: 1, requests }), { gss_geo: sqliteD1(db) } as unknown as MetricFactsEnv, waited))
  await Promise.all(waited)
  return ((await res.json()) as any).results as Record<string, Record<string, unknown>>
}
const strip = (v: Record<string, unknown>) => {
  const { liveSafe: _l, ...rest } = v
  return rest
}

describe('/api/metrics value.liveSafe', () => {
  it('a safe metric and a safe ratio have it', async () => {
    const r = await post([
      { key: 'pv', metric: 'bsk.pageviews', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] },
      { key: 'gv', metric: 'bsk.gameViews' },
      { key: 'tap', ratio: 'bsk.popupTapRate', window: 'todaySoFar' },
    ])
    for (const k of ['pv', 'gv', 'tap']) expect(r[k].liveSafe, k).toBe(true)
  })

  it('a refused-capable metric and a refused-capable ratio lack the key (absent, not false)', async () => {
    const r = await post([
      { key: 'done', metric: 'bsk.completions' },
      { key: 'ret', metric: 'bsk.returnsD1plus' },
      { key: 'ask', ratio: 'campaign.acceptPerAsk', params: { campaignId: '24215315197' } },
    ])
    for (const k of ['done', 'ret', 'ask']) expect('liveSafe' in r[k], k).toBe(false)
  })

  it('unknown ids and rejected requests get no flag', async () => {
    const r = await post([
      { key: 'nope', metric: 'bsk.nope' },
      { key: 'badwin', metric: 'bsk.pageviews', window: 'nope' },
      { key: 'bad', ratio: 'nope.ratio' },
    ])
    for (const k of ['nope', 'badwin', 'bad']) expect('liveSafe' in r[k], k).toBe(false)
  })

  it('adds nothing but the flag: every other field equals the unflagged derivation', async () => {
    const one = await post([{ key: 'a', metric: 'bsk.pageviews', window: 'todaySoFar', deltas: ['yesterday'] }])
    const twin = await post([
      { key: 'a', metric: 'bsk.pageviews', window: 'todaySoFar', deltas: ['yesterday'] },
      { key: 'b', metric: 'bsk.pageviews', window: 'todaySoFar', deltas: ['yesterday'] }, // identical request: shared object upstream
    ])
    expect(one.a.liveSafe).toBe(true)
    expect(strip(twin.b)).toEqual(strip(twin.a))
    expect(twin.a.liveSafe).toBe(true)
    expect(twin.b.liveSafe).toBe(true)
  })

  it('a flagged value does not leak onto a refused-capable result in the same batch', async () => {
    const r = await post([
      { key: 'pv', metric: 'bsk.pageviews' },
      { key: 'done', metric: 'bsk.completions' },
    ])
    expect(r.pv.liveSafe).toBe(true)
    expect('liveSafe' in r.done).toBe(false)
  })
})

describe('requestNeverCountsRefused (injected registries)', () => {
  const safe = { ...METRICS.get('bsk.pageviews')!, id: 'x.safe' } as MetricDef
  const safe2 = { ...METRICS.get('bsk.gameViews')!, id: 'x.safe2' } as MetricDef
  const refused = { ...METRICS.get('campaign.taggedArrivals')!, id: 'x.refused' } as MetricDef
  const metrics = new Map([safe, safe2, refused].map((m) => [m.id, m]))
  const ratio = (id: string, num: string, den: string) => [id, { id, label: `label.${id}`, kind: 'pair', num, den } as RatioDef] as const
  const ratios = new Map([ratio('r.both', 'x.safe', 'x.safe2'), ratio('r.numOnly', 'x.safe', 'x.refused'), ratio('r.denOnly', 'x.refused', 'x.safe'), ratio('r.dangling', 'x.safe', 'x.gone')])

  it('metric: only when countsRefused === false', () => {
    expect(requestNeverCountsRefused({ kind: 'metric', id: 'x.safe' }, metrics, ratios)).toBe(true)
    expect(requestNeverCountsRefused({ kind: 'metric', id: 'x.refused' }, metrics, ratios)).toBe(false)
    expect(requestNeverCountsRefused({ kind: 'metric', id: 'x.unknown' }, metrics, ratios)).toBe(false)
  })
  it('ratio: both sides, either one refused-capable, an unknown ratio or a missing side is false', () => {
    expect(requestNeverCountsRefused({ kind: 'ratio', id: 'r.both' }, metrics, ratios)).toBe(true)
    expect(requestNeverCountsRefused({ kind: 'ratio', id: 'r.numOnly' }, metrics, ratios)).toBe(false)
    expect(requestNeverCountsRefused({ kind: 'ratio', id: 'r.denOnly' }, metrics, ratios)).toBe(false)
    expect(requestNeverCountsRefused({ kind: 'ratio', id: 'r.dangling' }, metrics, ratios)).toBe(false)
    expect(requestNeverCountsRefused({ kind: 'ratio', id: 'r.unknown' }, metrics, ratios)).toBe(false)
  })
  it('the real registries: bsk.popupTapRate is safe, campaign.acceptPerAsk is not', () => {
    expect(requestNeverCountsRefused({ kind: 'ratio', id: 'bsk.popupTapRate' })).toBe(true)
    expect(requestNeverCountsRefused({ kind: 'ratio', id: 'campaign.acceptPerAsk' })).toBe(false)
    expect(RATIOS.has('bsk.popupTapRate')).toBe(true)
  })
})
