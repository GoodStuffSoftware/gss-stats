// The landingTag geo dimension (lib/campaigns.ts landingTagSqlCase / landingTagPrefilter): the Flight 3
// Apps arm's "No ads (hero) vs Features" donut, run through the REAL /api/geo handler on a real SQLite.
// Made-up data only. Covers slices and shares, the Untagged slice, rows that must not count, a STAGED arm
// (tags in no registered campaign: nothing matches, prefilter `1 = 0`), the counts-only split guard and the
// whole-ET-day window snap that /return/ rows get.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { onRequestPost } from './geo'
import { CAMPAIGNS, STAGED_FLIGHT_3, landingTagPrefilter, liveLandingTags, type CampaignFlight } from '../../src/lib/campaigns'
import { F3_APPS_BARE_TAG, F3_APPS_FEATURES_TAG, F3_APPS_HERO_TAG, landingArrivalPath } from '../../src/lib/landingTags'
import { landingLegendText } from '../../src/lib/charts'
import { insertHits, installCaches, memoryCache, openHitsDb, sqliteD1, type HitRow } from '../_lib/testing/hitsDb'

const real = CAMPAIGNS.slice()
const F3_IDS = new Set([STAGED_FLIGHT_3.apps.ids.campaignId, STAGED_FLIGHT_3.search.ids.campaignId])
const fake = (ucValues: string[], extra: Partial<CampaignFlight> = {}): CampaignFlight => ({
  id: 'F3-TEST', label: 'F3 test', ucValues, flightStart: '2026-10-10', flightEnd: '2026-10-16', status: 'active', kind: 'web', notes: 'landingTag test', ...extra,
})
const setRegistry = (list: CampaignFlight[]) => CAMPAIGNS.splice(0, CAMPAIGNS.length, ...list)
const ALL_TAGS = [F3_APPS_HERO_TAG, F3_APPS_FEATURES_TAG, F3_APPS_BARE_TAG]

let db: DatabaseSync
let undo: () => void
beforeEach(() => {
  db = openHitsDb()
  undo = installCaches(memoryCache())
})
afterEach(() => {
  undo()
  db.close()
  setRegistry(real)
})

const T = (iso: string) => Date.parse(iso)
// 2026-10-13 12:00 ET (16:00Z): inside the whole-ET-day window below.
const NOON = T('2026-10-13T16:00:00Z')
const arrival = (tag: string, extra: Partial<HitRow> = {}, n = 1): HitRow & { n: number } => ({ ts: NOON, site: 'bestsudoku-web', path: landingArrivalPath(tag), region: 'Ohio', device: 'mobile', n, ...extra })
// ET-midnight aligned (EDT): 2026-10-13 00:00 ET .. 2026-10-14 00:00 ET.
const DAY = { since: '2026-10-13T04:00:00Z', until: '2026-10-14T04:00:00Z' }

async function post(body: Record<string, unknown>) {
  const gss_geo = sqliteD1(db)
  const res = await onRequestPost({ request: { json: async () => ({ limit: 10, metric: 'pageviews', ...DAY, ...body }) }, env: { gss_geo }, waitUntil: () => {} } as any)
  return { body: (await res.json()) as any, statements: gss_geo.statements, status: res.status }
}
const slices = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.key.landingTag, r.pageviews]))

describe('landingTag: slices and shares', () => {
  beforeEach(() => setRegistry([fake(ALL_TAGS)]))

  it('counts arrival rows per tag, biggest first, and the legend shares come out of the plotted sum', async () => {
    insertHits(db, [arrival(F3_APPS_HERO_TAG, {}, 6), arrival(F3_APPS_FEATURES_TAG, {}, 3), arrival(F3_APPS_BARE_TAG, {}, 1)])
    const { body, status } = await post({ dimension: 'landingTag' })
    expect(status).toBe(200)
    expect(body.rows.map((r: any) => r.key.landingTag)).toEqual([F3_APPS_HERO_TAG, F3_APPS_FEATURES_TAG, F3_APPS_BARE_TAG])
    expect(slices(body.rows)).toEqual({ [F3_APPS_HERO_TAG]: 6, [F3_APPS_FEATURES_TAG]: 3, [F3_APPS_BARE_TAG]: 1 })
    const values = body.rows.map((r: any) => r.pageviews)
    expect(values.map((v: number) => landingLegendText('x', v, values))).toEqual(['x · 6 · 60%', 'x · 3 · 30%', 'x · 1 · 10%'])
  })

  it('Untagged (the bare tag) only appears when it has arrivals', async () => {
    insertHits(db, [arrival(F3_APPS_HERO_TAG, {}, 2), arrival(F3_APPS_FEATURES_TAG, {}, 2)])
    const { body } = await post({ dimension: 'landingTag' })
    expect(Object.keys(slices(body.rows)).sort()).toEqual([F3_APPS_FEATURES_TAG, F3_APPS_HERO_TAG].sort())
  })

  it('counts the app site as well as the web site', async () => {
    insertHits(db, [arrival(F3_APPS_HERO_TAG, { site: 'bestsudoku-app' }, 2), arrival(F3_APPS_HERO_TAG, {}, 3)])
    expect(slices((await post({ dimension: 'landingTag' })).body.rows)).toEqual({ [F3_APPS_HERO_TAG]: 5 })
  })

  it('ignores everything that is not a landing arrival', async () => {
    insertHits(db, [
      arrival(F3_APPS_HERO_TAG, {}, 1), // the one real arrival
      arrival(F3_APPS_HERO_TAG, { path: '/return/sudoku_funnel_f3_apps_hero/d1' }), // a later return day
      arrival(F3_APPS_HERO_TAG, { path: '/' }), // a page view
      arrival(F3_APPS_HERO_TAG, { path: '/game/first-move' }),
      arrival('some_other_tag'), // a tag that is not one of the donut slices
      arrival(F3_APPS_HERO_TAG, { site: 'goodstuff-main' }), // another site
      arrival(F3_APPS_FEATURES_TAG, { region: 'North Carolina', screenw: 412 }), // an EXCLUSIONS household row
      arrival(F3_APPS_FEATURES_TAG, { medium: 'lifecycle' }), // lifecycle email traffic
      arrival(F3_APPS_FEATURES_TAG, { ts: T('2026-10-12T16:00:00Z') }), // outside the window
    ])
    expect(slices((await post({ dimension: 'landingTag' })).body.rows)).toEqual({ [F3_APPS_HERO_TAG]: 1 })
  })

  it('a row before the campaign attribution start has no slice', async () => {
    setRegistry([fake(ALL_TAGS, { flightStart: '2026-10-14', flightEnd: '2026-10-20' })])
    insertHits(db, [arrival(F3_APPS_HERO_TAG, {}, 4)])
    expect((await post({ dimension: 'landingTag' })).body.rows).toEqual([])
  })

  it('returns counts only: no cost, spend or impression field anywhere in the response', async () => {
    insertHits(db, [arrival(F3_APPS_HERO_TAG, {}, 2)])
    const { body } = await post({ dimension: 'landingTag' })
    expect(JSON.stringify(body)).not.toMatch(/cost|spend|impress|cpc|budget/i)
  })
})

describe('landingTag: a staged arm is never read', () => {
  it('with no registered campaign carrying the tags the prefilter is `1 = 0` and nothing matches', async () => {
    // The registry with the Apps arm staged (its dates null in STAGED_FLIGHT_3_DATES): the arm is only STAGED_FLIGHT_3, not in CAMPAIGNS.
    // Built from the real list minus the F3 ids so that filling the dates (the activation) never turns this red.
    setRegistry(real.filter((c) => !F3_IDS.has(c.id)))
    expect(liveLandingTags()).toEqual([])
    expect(STAGED_FLIGHT_3.apps.ucValues).toEqual(expect.arrayContaining(ALL_TAGS))
    const w: string[] = []
    landingTagPrefilter(w, [])
    expect(w).toEqual(['1 = 0'])
    insertHits(db, [arrival(F3_APPS_HERO_TAG, {}, 5), arrival(F3_APPS_FEATURES_TAG, {}, 5)])
    const { body, statements } = await post({ dimension: 'landingTag' })
    expect(body.rows).toEqual([])
    expect(statements.length).toBeGreaterThan(0)
    for (const s of statements) expect(s).toContain('1 = 0')
  })

  it('a registered campaign carrying the tags switches the prefilter to the live arrival paths', async () => {
    setRegistry([fake([F3_APPS_HERO_TAG, F3_APPS_FEATURES_TAG])])
    expect(liveLandingTags()).toEqual([F3_APPS_HERO_TAG, F3_APPS_FEATURES_TAG])
    const w: string[] = []
    landingTagPrefilter(w, [])
    expect(w).toEqual([`path IN ('/return/${F3_APPS_HERO_TAG}/d0', '/return/${F3_APPS_FEATURES_TAG}/d0')`])
    insertHits(db, [arrival(F3_APPS_HERO_TAG, {}, 2), arrival(F3_APPS_BARE_TAG, {}, 9)]) // the bare tag is not registered here
    expect(slices((await post({ dimension: 'landingTag' })).body.rows)).toEqual({ [F3_APPS_HERO_TAG]: 2 })
  })
})

describe('landingTag: counts-only guard and whole-day window', () => {
  beforeEach(() => setRegistry([fake(ALL_TAGS)]))

  it('an hour, place or device split of the same query removes the /return/ rows', async () => {
    insertHits(db, [arrival(F3_APPS_HERO_TAG, {}, 3), arrival(F3_APPS_FEATURES_TAG, {}, 2)])
    expect((await post({ dimension: 'landingTag' })).body.rows).toHaveLength(2)
    for (const other of ['hourEt', 'country', 'region', 'device', 'visitor']) {
      const ring = await post({ dimension: 'landingTag', breakdown: other, dims: ['landingTag', other] })
      expect(ring.status, `ring with ${other}`).toBe(200)
      expect(ring.body.rows, `ring with ${other}`).toEqual([])
    }
    for (const c of [{ field: 'country', value: 'US' }, { field: 'device', value: 'mobile' }, { field: 'hourEt', value: '12' }]) {
      const drilled = await post({ dimension: 'landingTag', constraints: [c] })
      expect(drilled.status, `drill ${c.field}`).toBe(200)
      expect(drilled.body.rows, `drill ${c.field}`).toEqual([])
    }
  })

  it('a window on ET midnights is exact and carries no whole-days caption', async () => {
    insertHits(db, [arrival(F3_APPS_HERO_TAG, {}, 2)])
    const { body } = await post({ dimension: 'landingTag' })
    expect(body.meta.refusedWholeDays).toBeUndefined()
    expect(body.meta.liveSafe).toBeUndefined() // an event dim lifts the exclusion: never a live-refetch chart
  })

  it('a window that is not on ET midnights snaps to whole ET days and says so', async () => {
    // 20:00 ET on the 13th is outside a 00:00-13:00 ET window, but the /return/ rows are counted over whole days.
    insertHits(db, [arrival(F3_APPS_HERO_TAG, { ts: T('2026-10-14T00:00:00Z') }, 4)])
    const { body } = await post({ dimension: 'landingTag', since: '2026-10-13T04:00:00Z', until: '2026-10-13T17:00:00Z' })
    expect(slices(body.rows)).toEqual({ [F3_APPS_HERO_TAG]: 4 })
    expect(body.meta.refusedWholeDays).toBe(true)
  })
})
