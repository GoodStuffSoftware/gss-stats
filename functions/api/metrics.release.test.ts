// The release before/after panel through POST /api/metrics: the "after" side leaves out the
// release's own ET day (v1.96.0, dated 2026-10-02, went live at 22:21 ET that day).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import type { MetricFactsEnv } from '../_lib/metricFacts'

const WEB = 'bestsudoku-web'
const at = (iso: string) => Date.parse(iso)
let undoCaches: () => void
beforeEach(() => {
  undoCaches = installCaches(memoryCache())
})
afterEach(() => {
  vi.useRealTimers()
  undoCaches()
})

async function asOf(now: string) {
  const db = openHitsDb()
  insertHits(db, [
    { site: WEB, ts: at('2026-10-01T14:00:00Z'), path: '/', visitor: 'returning', n: 3 },
    { site: WEB, ts: at('2026-10-02T14:00:00Z'), path: '/', visitor: 'returning', n: 100 }, // release day
    { site: WEB, ts: at('2026-10-03T14:00:00Z'), path: '/', visitor: 'returning', n: 7 },
  ])
  vi.useFakeTimers({ now: at(now), toFake: ['Date'] })
  const waited: Promise<unknown>[] = []
  const res = await onRequestPost(
    pagesContext(
      postJson('/api/metrics', { v: 1, requests: [
        { key: 'b', metric: 'bsk.pageviews', window: 'before' },
        { key: 'a', metric: 'bsk.pageviews', window: 'after' },
        { key: 'd', metric: 'release.windowDays', window: 'after' },
      ] }),
      { gss_geo: sqliteD1(db) } as unknown as MetricFactsEnv,
      waited,
    ),
  )
  await Promise.all(waited)
  return (await res.json()) as { results: Record<string, { value: number }> }
}

describe('release panel counts', () => {
  it('v1.96.0 on 10-04: after is 10-03 only (7), not the release day (100)', async () => {
    const { results } = await asOf('2026-10-04T16:00:00Z')
    expect(results.b.value).toBe(3)
    expect(results.a.value).toBe(7)
    expect(results.d.value).toBe(1)
  })
})
