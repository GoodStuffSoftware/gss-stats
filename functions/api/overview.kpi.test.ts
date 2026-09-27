// /api/overview's "Today at a glance" tiles, end to end against a real SQLite `hits` table
// (functions/_lib/testing/hitsDb.ts): the handler's own SQL runs, only the clock is fixed.
// ADR 0003 slice 1: the "Tagged arrivals" tile uses campaignAttributionClause (so the retest's
// pre-noon and 2026-09-23 QA rows never count), and "Games played" is "Game-screen views".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from './overview'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'

const NOW = Date.parse('2026-09-26T21:00:00Z') // 17:00 ET on the retest's first day
const RETEST = 'sudoku_funnel_retest'
let undoCaches: () => void

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
})
afterEach(() => {
  vi.useRealTimers()
  undoCaches()
})

async function overview(seed: Parameters<typeof insertHits>[1]) {
  const db = openHitsDb()
  insertHits(db, seed)
  const res = await onRequestPost(pagesContext(postJson('/api/overview', {}), { gss_geo: sqliteD1(db) }))
  expect(res.status).toBe(200)
  return (await res.json()) as any
}

describe('/api/overview KPI tiles (ADR 0003 slice 1)', () => {
  it('"Tagged arrivals — US+CA web retest" counts only rows attributed from 12:00 ET, like the campaign card', async () => {
    const data = await overview([
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
    ])
    const tile = data.kpis.find((k: any) => k.key === 'arrivals-24279250691')
    expect(tile.today).toBe(7) // 2 at noon + 5 after; not the 3 + 1 before noon
    expect(tile.vsYesterday.delta).toBe(7)
    expect(tile.vsAvg7.delta).toBe(7) // the 09-23 QA rows are out of the 7-day average too (was 9/7)
    // The campaign scorecard (campaignAttributionClause in SQL) agrees with the tile.
    expect(data.scorecard.find((r: any) => r.id === '24279250691').taggedArrivals).toBe(7)
  })

  it('the /game page-view tile is labelled "Game-screen views", not "Games played"', async () => {
    const data = await overview([{ ts: Date.parse('2026-09-26T18:00:00Z'), site: 'bestsudoku-web', path: '/game', n: 3 }])
    const tile = data.kpis.find((k: any) => k.key === 'played')
    expect(tile.label).toBe('Game-screen views')
    expect(tile.today).toBe(3)
  })
})
