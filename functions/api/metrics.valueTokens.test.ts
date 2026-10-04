// The counts-only rule for `{=metric:<id>@<window>}` value tokens (notes plan slice 1d, release 2).
// A token sends only { metric | ratio, window } (src/lib/metricValueTokens.ts metricRequestSpec):
// no params, deltas or series. Through the real POST /api/metrics handler over one node:sqlite
// fixture, every metric the picker offers that counts a refused row (return, start, completion,
// tutorial, tour exit) therefore takes the shipped server-side rule on a sub-day page range: it
// snaps to whole ET days and says so (refused-whole-days). Three consecutive one-hour ranges can
// never read back per-hour refused counts through a token.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost as metricsPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import { etWallTimeMs } from '../../src/lib/etTime'
import { METRICS } from '../../src/lib/metrics/metrics'
import { metricRequestSpec, metricTokenOptions, parseMetricPath } from '../../src/lib/metricValueTokens'
import type { MetricsResponseBody } from '../../src/lib/metrics/types'

const Z = (iso: string) => Date.parse(iso)
const SITE = 'bestsudoku-web'
const HOURS: [string, string][] = [
  ['2026-10-04T14:00:00.000Z', '2026-10-04T15:00:00.000Z'],
  ['2026-10-04T15:00:00.000Z', '2026-10-04T16:00:00.000Z'],
  ['2026-10-04T16:00:00.000Z', '2026-10-04T17:00:00.000Z'],
]
const DAY = etWallTimeMs('2026-10-04')

let db: DatabaseSync
let undoCaches: () => void
beforeEach(() => {
  vi.useFakeTimers({ now: Z('2026-10-06T12:00:00Z'), toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
  db = openHitsDb()
  insertHits(db, [
    { ts: Z('2026-10-04T14:30:00Z'), site: SITE, path: '/game/complete/normal/easy', n: 8 },
    { ts: Z('2026-10-04T15:30:00Z'), site: SITE, path: '/game/complete/normal/easy', n: 16 },
    { ts: Z('2026-10-04T16:30:00Z'), site: SITE, path: '/game/complete/normal/easy', n: 32 },
    { ts: Z('2026-10-04T15:30:00Z'), site: SITE, path: '/return/organic/d1', n: 2 },
    { ts: Z('2026-10-04T15:30:00Z'), site: SITE, path: '/tour/exit-at/3', n: 4 },
    { ts: DAY - 60_000, site: SITE, path: '/game/complete/normal/easy', n: 100 },
  ])
})
afterEach(() => {
  db.close()
  undoCaches()
  vi.useRealTimers()
})

async function post(since: string, until: string, requests: object[]) {
  const waited: Promise<unknown>[] = []
  const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, context: { since, until }, requests }), { gss_geo: sqliteD1(db) }, waited) as any)
  await Promise.all(waited)
  if (res.status !== 200) throw new Error(await res.text())
  return ((await res.json()) as MetricsResponseBody).results
}

// Every bsk.* metric the picker offers over its `page` window that counts a refused row (all but the
// opt-outs, MetricDef.countsRefused: false), as the exact
// request a token sends.
const refusedRefs = metricTokenOptions()
  .map((o) => o.ref)
  .filter((r) => r.of === 'metric' && r.window === 'page' && r.id.startsWith('bsk.') && METRICS.get(r.id)?.countsRefused !== false)

describe('metric tokens on counts-only rows', () => {
  it('the picker offers the counts-only metrics, and a token request carries no params, deltas or series', () => {
    expect(refusedRefs.map((r) => r.id)).toEqual(expect.arrayContaining(['bsk.completions', 'bsk.tutorialFirstRun', 'bsk.tourExitHub', 'bsk.returnsD1plus']))
    for (const r of refusedRefs) expect(Object.keys(metricRequestSpec(r)).sort(), r.path).toEqual(['metric', 'window'])
    // A typed token cannot add a parameter either: the grammar has no place for one.
    expect(parseMetricPath('metric:bsk.completions@page?country=US')).toBeNull()
    expect(parseMetricPath('metric:bsk.completions@page:country')).toBeNull()
  })

  it('a sub-day page range snaps to whole ET days with the refused-whole-days note, never per hour', async () => {
    const requests = refusedRefs.map((r) => ({ key: `k${refusedRefs.indexOf(r)}`, ...metricRequestSpec(r) }))
    const got = []
    for (const [since, until] of HOURS) got.push(await post(since, until, requests))
    for (const r of got) refusedRefs.forEach((ref, i) => expect(r[`k${i}`].noteIds, ref.id).toContain('refused-whole-days'))
    // Completions: 10-11 ET snaps to an empty window, 11-12 ET to the whole day, 12-13 ET to empty.
    expect(got.map((r) => r[`k${refusedRefs.findIndex((x) => x.id === 'bsk.completions')}`].value)).toEqual([0, 56, 0])
  })
})
