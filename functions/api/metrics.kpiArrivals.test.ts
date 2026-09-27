// The "Today at a glance" arrivals tile through POST /api/metrics, end to end against a real
// SQLite `hits` table (functions/_lib/testing/hitsDb.ts): the handler's own SQL runs, only the
// clock is fixed. ADR 0003 slice 1: the tile uses campaign attribution (so the retest's pre-noon
// and 2026-09-23 QA rows never count) and agrees with the campaign card. Moved here from the
// retired /api/overview KPI section (CONFIG_VERSION 10: the tiles are the 'bsk-kpis' card).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import type { MetricRequest, MetricsResponseBody } from '../../src/lib/metrics/types'

const NOW = Date.parse('2026-09-26T21:00:00Z') // 17:00 ET on the retest's first day
const RETEST = 'sudoku_funnel_retest'
const RETEST_ID = '24279250691'
let undoCaches: () => void

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
})
afterEach(() => {
  vi.useRealTimers()
  undoCaches()
})

async function metrics(seed: Parameters<typeof insertHits>[1], requests: MetricRequest[]) {
  const db = openHitsDb()
  insertHits(db, seed)
  const waited: Promise<unknown>[] = []
  const res = await onRequestPost(pagesContext(postJson('/api/metrics', { v: 1, requests }), { gss_geo: sqliteD1(db) }, waited) as never)
  await Promise.all(waited)
  expect(res.status).toBe(200)
  return ((await res.json()) as MetricsResponseBody).results
}

describe('the KPI arrivals tile (ADR 0003 slice 1, now the bsk-kpis card)', () => {
  it('"Tagged arrivals — US+CA web retest" counts only rows attributed from 12:00 ET, like the campaign card', async () => {
    const r = await metrics(
      [
        // Pre-launch QA on 2026-09-23 (inside the 7-day average's windows) — never attributed.
        { ts: Date.parse('2026-09-23T14:00:00Z'), site: 'bestsudoku-web', path: '/game', visitor: 'new', campaign: RETEST, n: 9 },
        // Today before the noon-ET schedule start (11:30 ET) — pre-launch QA, never attributed.
        { ts: Date.parse('2026-09-26T15:30:00Z'), site: 'bestsudoku-web', path: '/game', visitor: 'new', campaign: RETEST, n: 3 },
        // The last minute before noon, and noon itself (the bound is inclusive).
        { ts: Date.parse('2026-09-26T15:59:59Z'), site: 'bestsudoku-web', path: '/game', visitor: 'new', campaign: RETEST, n: 1 },
        { ts: Date.parse('2026-09-26T16:00:00Z'), site: 'bestsudoku-web', path: '/game', visitor: 'new', campaign: RETEST, n: 2 },
        // Real traffic after noon ET.
        { ts: Date.parse('2026-09-26T17:00:00Z'), site: 'bestsudoku-web', path: '/game', visitor: 'new', campaign: RETEST, n: 5 },
        // A returning visitor is a tagged hit, not an arrival.
        { ts: Date.parse('2026-09-26T17:05:00Z'), site: 'bestsudoku-web', path: '/game', visitor: 'returning', campaign: RETEST, n: 4 },
      ],
      [
        { key: 'tile', metric: 'campaign.taggedArrivals', params: { campaignId: RETEST_ID }, window: 'todaySoFar', deltas: ['yesterday', 'avg7'] },
        { key: 'card', metric: 'campaign.taggedArrivals', params: { campaignId: RETEST_ID } },
      ],
    )
    expect(r.tile.value).toBe(7) // 2 at noon + 5 after; not the 3 + 1 before noon
    // Comparisons before the flight's first full day are hidden ("new today"), never "+7".
    expect(r.tile.deltas).toBeUndefined()
    // The campaign card (attribution window) agrees with the tile.
    expect(r.card.value).toBe(7)
  })

  it('the /game page views are "Game-screen views", not "Games played"', async () => {
    const r = await metrics([{ ts: Date.parse('2026-09-26T18:00:00Z'), site: 'bestsudoku-web', path: '/game', n: 3 }], [{ key: 'played', metric: 'bsk.gameViews', window: 'todaySoFar' }])
    expect(r.played.value).toBe(3)
  })
})
