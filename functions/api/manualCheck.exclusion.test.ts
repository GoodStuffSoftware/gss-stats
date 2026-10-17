// The manual production checks (utm_campaign=manual_check, arrival paths /return/manual_check/...) are
// never visitors: /api/popups, /api/completions, /api/sites and the two pop-up range facts drop them
// whatever the viewer's "hide known traffic" setting (lib/campaigns.ts applyAlwaysExclusions). Each
// builder runs its real SQL on node:sqlite; every row below is made up.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { onRequestPost as popupsPost } from './popups'
import { onRequestPost as completionsPost } from './completions'
import { onRequestGet as sitesGet } from './sites'
import { onRequestPost as geoPost } from './geo'
import { FACTS, flightPathsSeenStatement } from '../../src/lib/metrics/facts'
import { CAMPAIGNS, etFlightRangeMs } from '../../src/lib/campaigns'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'

const NOW = Date.parse('2026-10-16T16:00:00Z')
const T = Date.parse('2026-10-14T16:00:00Z') // inside the 2026-10-13..10-15 windows below
const SITE = 'bestsudoku-web'
const POPUP_PATH = '/popup-outcome/signin-prompt/placement/signed-in'

let db: DatabaseSync
let undo: () => void
beforeEach(() => {
  db = openHitsDb()
  undo = installCaches(memoryCache())
})
afterEach(() => {
  undo()
  db.close()
})

describe('/api/popups', () => {
  it('leaves manual-check rows out of the counts', async () => {
    insertHits(db, [
      { ts: T, site: SITE, path: POPUP_PATH, n: 3 },
      { ts: T + 1, site: SITE, path: POPUP_PATH, campaign: 'manual_check', n: 5 },
      { ts: T + 2, site: SITE, path: '/return/manual_check/d0', n: 4 },
    ])
    const res = await popupsPost(pagesContext(postJson('/api/popups', { dimension: 'outcome', popup: 'signin-prompt', since: '2026-10-13', until: '2026-10-15' }), { gss_geo: sqliteD1(db) }))
    const body = (await res.json()) as { totals: { pageviews: number } }
    expect(body.totals.pageviews).toBe(3)
  })
})

describe('/api/completions', () => {
  it('leaves manual-check rows out of the counts', async () => {
    insertHits(db, [
      { ts: T, site: SITE, path: '/game/complete/daily/easy', n: 2 },
      { ts: T + 1, site: SITE, path: '/game/complete/daily/easy', campaign: 'manual_check', n: 7 },
      { ts: T + 2, site: SITE, path: '/return/manual_check/d0', n: 4 },
    ])
    const res = await completionsPost(pagesContext(postJson('/api/completions', { dimension: 'mode', since: '2026-10-13', until: '2026-10-15' }), { gss_geo: sqliteD1(db) }))
    const body = (await res.json()) as { totals: { pageviews: number } }
    expect(body.totals.pageviews).toBe(2)
  })
})

describe('/api/sites', () => {
  it('leaves manual-check rows out of a site tag\'s beacon count', async () => {
    const now = Date.now()
    insertHits(db, [
      { ts: now - 1000, site: SITE, path: '/', n: 3 },
      { ts: now - 900, site: SITE, path: '/', campaign: 'manual_check', n: 6 },
      { ts: now - 800, site: SITE, path: '/return/manual_check/d0', n: 4 },
      { ts: now - 700, site: 'bestsudoku-app', path: '/', campaign: 'manual_check', n: 5 }, // only checks: no site at all
    ])
    const env = { CF_ANALYTICS_TOKEN: '', gss_geo: sqliteD1(db), STATS_CONFIG: { get: async () => JSON.stringify({ map: {}, ts: Date.now() }), put: async () => {} } }
    const res = await sitesGet(pagesContext(new Request('https://stats.goodstuff.software/api/sites'), env) as never)
    const body = (await res.json()) as { sites: { subs: { tag: string | null; geo: number }[] }[] }
    const subs = body.sites.flatMap((s) => s.subs)
    expect(subs.find((s) => s.tag === SITE)?.geo).toBe(3)
    expect(subs.find((s) => s.tag === 'bestsudoku-app')).toBeUndefined()
  })
})

describe('the pop-up range facts', () => {
  const params = { since: '2026-10-13', until: '2026-10-15' }
  const sum = (stmt: { sql: string; binds: unknown[] }) => (db.prepare(stmt.sql).all(...(stmt.binds as (string | number)[])) as { c: number }[]).reduce((a, r) => a + r.c, 0)
  beforeEach(() => {
    insertHits(db, [
      { ts: T, site: SITE, path: POPUP_PATH, n: 3 },
      { ts: T + 1, site: SITE, path: POPUP_PATH, campaign: 'manual_check', n: 5 },
      { ts: T + 2, site: SITE, path: '/return/manual_check/d0', n: 4 },
    ])
  })
  it('popupRangePath drops them', () => {
    expect(sum(FACTS.popupRangePath.build(params, NOW))).toBe(3)
  })
  it('popupRangeDaily, its twin, drops them too', () => {
    expect(sum(FACTS.popupRangeDaily.build(params, NOW))).toBe(3)
  })
})

describe('/api/geo with the hide-known-traffic option off', () => {
  const rows = () =>
    insertHits(db, [
      { ts: T, site: SITE, path: '/', n: 3 },
      { ts: T + 1, site: SITE, path: '/', campaign: 'manual_check', n: 6 },
      { ts: T + 2, site: SITE, path: '/return/manual_check/d0', n: 4 },
    ])
  const total = async (excludeKnownTraffic: boolean) => {
    const res = await geoPost(pagesContext(postJson('/api/geo', { dimension: 'site', since: '2026-10-13', until: '2026-10-15', ...(excludeKnownTraffic ? { excludeKnownTraffic: true } : {}) }), { gss_geo: sqliteD1(db) }))
    return ((await res.json()) as { totals: { pageviews: number } }).totals.pageviews
  }
  it('still drops manual-check rows (the always entries)', async () => {
    rows()
    expect(await total(false)).toBe(3)
  })
  it('drops them with the option on as well', async () => {
    rows()
    expect(await total(true)).toBe(3)
  })
})

describe('flightPathsSeenStatement', () => {
  it('does not count a path only the manual checks sent as seen', () => {
    const flight = CAMPAIGNS.find((c) => c.flightStart)!
    const [startMs, endMs] = etFlightRangeMs(flight.flightStart!, flight.flightEnd)
    const mid = Math.floor((startMs + endMs) / 2)
    insertHits(db, [
      { ts: mid, site: SITE, path: '/seen/by-visitors', n: 2 },
      { ts: mid + 1, site: SITE, path: '/seen/by-checks-only', campaign: 'manual_check', n: 5 },
      { ts: mid + 2, site: SITE, path: '/return/manual_check/d0', n: 4 },
    ])
    const stmt = flightPathsSeenStatement(flight)
    const seen = db.prepare(stmt.sql).all(...(stmt.binds as (string | number)[])) as { path: string; c: number }[]
    expect(Object.fromEntries(seen.map((r) => [r.path, r.c]))).toEqual({ '/seen/by-visitors': 2 })
  })
})
