// /api/features with view 'coach-tips' (the Coach tips card) on a REAL SQLite engine (node:sqlite),
// with made-up rows. Proves: one row per tip with shown / dismissed / closed counts and plain ratios
// (null for a zero denominator), the tour-opened total with no tip, the latest complete ET day and the
// range, "ever seen" for the not-yet-shipped caption, the shared filters, and that the query asks for no
// hour, place, device or visitor dimension (splitGuard's refusals on /coach/shown/%, /coach/dismissed/%
// and /coach/closed-at/% stay respected: those paths are only read as per-ET-day totals).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openHitsDb, insertHits, sqliteD1, pagesContext, postJson } from '../_lib/testing/hitsDb'
import { etWallTimeMs } from '../../src/lib/etTime'
import { COACH_TIPS, COACH_TIP_FEATURES, COACH_TIPS_VIEW } from '../../src/lib/coachTips'
import { FEATURES, flatSteps } from '../../src/lib/featureHealth'
import { isSplitRefusedPath } from '../../src/lib/splitGuard'
import { viewerMayRequest } from '../_lib/auth'

const NOW = '2026-10-15T16:00:00Z'
const TODAY = '2026-10-15'
const LATEST = '2026-10-14'
const PREV = '2026-10-13'
const at = (date: string, hh: number) => etWallTimeMs(date) + hh * 3_600_000

let db: DatabaseSync
let d1: ReturnType<typeof sqliteD1>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  db = openHitsDb()
  d1 = sqliteD1(db)
  ;(globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } }
})
afterEach(() => {
  vi.useRealTimers()
  db.close()
  delete (globalThis as any).caches
})

const post = async (body: Record<string, unknown>) => {
  const { onRequestPost } = await import('./features')
  const res = await onRequestPost(pagesContext(postJson('/api/features', body), { gss_geo: d1 }) as any)
  return { status: res.status, body: (await res.json()) as any }
}
const range = { since: '2026-10-08', until: '2026-10-15', view: COACH_TIPS_VIEW }
const tip = (body: any, id: string) => body.features.find((f: any) => f.id === `tip-${id}`)
const st = (body: any, id: string, step: string) => tip(body, id).steps.find((s: any) => s.id === step)
const hit = (path: string, ts: number, extra: Record<string, string | number> = {}) => ({ ts, site: 'bestsudoku-web', path, ...extra })

describe('coach tips: per-tip rows and ratios', () => {
  it('answers one row per tip, in the card order, then the tour-opened total', async () => {
    const { status, body } = await post(range)
    expect(status).toBe(200)
    expect(body.features.map((f: any) => f.id)).toEqual([...COACH_TIPS.map((t) => `tip-${t.id}`), 'tour-opened'])
    expect(body.latestDay).toBe(LATEST)
    expect(tip(body, 'place').steps.map((s: any) => s.id)).toEqual(['shown', 'dismissed', 'closed'])
  })

  it('counts shown, dismissed and closed per tip for the latest day and the range, web and app combined', async () => {
    insertHits(db, [
      hit('/coach/shown/place', at(LATEST, 9), { n: 10 }),
      hit('/coach/shown/place', at(LATEST, 10), { n: 2, site: 'bestsudoku-app' }),
      hit('/coach/dismissed/place', at(LATEST, 11), { n: 3 }),
      hit('/coach/closed-at/place', at(LATEST, 12), { n: 6 }),
      hit('/coach/shown/place', at('2026-10-09', 9), { n: 8 }),
      hit('/coach/dismissed/place', at('2026-10-09', 9), { n: 4 }),
      hit('/coach/shown/wheel', at(LATEST, 9), { n: 5 }),
      hit('/coach/dismissed/wheel', at(PREV, 9), { n: 1 }),
      hit('/coach/closed-at/clash', at(LATEST, 9), { n: 3 }),
    ])
    const { body } = await post(range)
    expect(st(body, 'place', 'shown')).toMatchObject({ latest: 12, range: 20 })
    expect(st(body, 'place', 'dismissed')).toMatchObject({ latest: 3, range: 7 })
    expect(st(body, 'place', 'closed')).toMatchObject({ latest: 6, range: 6 })
    expect(st(body, 'place', 'dismissed').ratio.latest).toBeCloseTo(3 / 12)
    expect(st(body, 'place', 'dismissed').ratio.range).toBeCloseTo(7 / 20)
    expect(st(body, 'place', 'closed').ratio.latest).toBeCloseTo(6 / 12)
    expect(st(body, 'wheel', 'shown')).toMatchObject({ latest: 5, range: 5 })
    // Dismissed with no shown that day: a null ratio (the card draws a dash), never Infinity or NaN.
    expect(st(body, 'wheel', 'dismissed').ratio.prev).toBeNull()
    expect(st(body, 'clash', 'closed').ratio.latest).toBeNull()
    // A tip with no rows reads 0 and null ratios.
    expect(st(body, 'hint', 'shown')).toMatchObject({ latest: 0, range: 0 })
    expect(st(body, 'hint', 'dismissed').ratio).toMatchObject({ latest: null, range: null })
  })

  it('tour-opened is one total with no tip, and is not counted under any tip', async () => {
    insertHits(db, [
      hit('/coach/tour-opened', at(LATEST, 9), { n: 4 }),
      hit('/coach/tour-opened', at(PREV, 9), { n: 3 }),
      hit('/coach/tour-opened/place', at(LATEST, 9), { n: 9 }), // not a real path: counted nowhere
    ])
    const { body } = await post(range)
    const opened = body.features.find((f: any) => f.id === 'tour-opened')
    expect(opened.steps).toHaveLength(1)
    expect(opened.steps[0]).toMatchObject({ id: 'opened', latest: 4, prev: 3, range: 7 })
    for (const t of COACH_TIPS) expect(tip(body, t.id).latest).toBe(0)
  })

  it('does not count look-alike paths (an unknown tip, a prefix, a different case)', async () => {
    insertHits(db, [
      hit('/coach/shown/unknown', at(LATEST, 9)),
      hit('/coach/shown/placeholder', at(LATEST, 9)),
      hit('/coach/shown/place/extra', at(LATEST, 9)),
      hit('/coach/shown/Place', at(LATEST, 9)),
      hit('/coach/shown/', at(LATEST, 9)),
    ])
    const { body } = await post(range)
    expect(body.everSeen).toBe(false)
    for (const t of COACH_TIPS) expect(tip(body, t.id).range).toBe(0)
  })

  it('everSeen tells "not shipped yet" from a quiet range', async () => {
    expect((await post(range)).body.everSeen).toBe(false)
    insertHits(db, [hit('/coach/shown/notes', at('2026-09-20', 9))]) // long before the selected range
    const quiet = (await post(range)).body
    expect(quiet.everSeen).toBe(true)
    expect(tip(quiet, 'notes').range).toBe(0)
  })

  it('applies the same exclusions as the other cards (sites, own visits, known traffic)', async () => {
    insertHits(db, [
      hit('/coach/shown/hint', at(LATEST, 9), { n: 3 }),
      hit('/coach/shown/hint', at(LATEST, 9), { n: 5, site: 'other-site' }),
    ])
    const { body } = await post({ ...range, sites: ['bestsudoku-web'] })
    expect(st(body, 'hint', 'shown').latest).toBe(3)
    expect(st((await post(range)).body, 'hint', 'shown').latest).toBe(8)
  })

  it('a request without the view still answers the feature health model', async () => {
    const { body } = await post({ since: range.since, until: range.until })
    expect(body.features).toHaveLength(FEATURES.length)
    expect(body.everSeen).toBeUndefined()
  })
})

describe('coach tips: counts only (no refused dimension)', () => {
  it('every tip path is a refused path, and the card reads them only as per-ET-day totals', async () => {
    const paths = flatSteps(COACH_TIP_FEATURES).flatMap((f) => f.step.match.exact ?? [])
    expect(paths).toHaveLength(COACH_TIPS.length * 3 + 1)
    for (const p of paths) if (p !== '/coach/tour-opened') expect(isSplitRefusedPath(p), p).toBe(true)
    insertHits(db, paths.map((p) => hit(p, at(LATEST, 9), { n: 2 })))
    const { body } = await post(range)
    for (const t of COACH_TIPS) expect(st(body, t.id, 'shown').latest).toBe(2)
  })

  it('no executed statement has an hour, place, device or visitor dimension, or a MIN/MAX of ts', async () => {
    insertHits(db, [hit('/coach/shown/place', at(LATEST, 9))])
    await post({ ...range, sites: ['bestsudoku-web'], excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows', excludeKnownTraffic: true })
    expect(d1.statements).toHaveLength(2)
    for (const sql of d1.statements) {
      const groupBy = sql.match(/GROUP BY (.*?)( ORDER BY|$)/)?.[1] ?? ''
      expect(['d', '']).toContain(groupBy)
      expect(sql).not.toMatch(/MIN\(\s*ts|MAX\(\s*ts/i)
      const select = sql.slice(0, sql.indexOf(' FROM hits')).replace(/'[^']*'/g, "''")
      expect(select).not.toMatch(/\b(hourEt|country|region|city|postal|device|visitor|colo|org|lat|lon|screenw|browser|os)\b/)
      // Only the coach tip paths are matched, never the health table's other families.
      expect(sql).not.toMatch(/\/tour\/|\/game\//)
    }
  })

  it('a request window that is not ET-midnight aligned is snapped to whole ET days', async () => {
    insertHits(db, [hit('/coach/shown/place', at(LATEST, 1)), hit('/coach/shown/place', at(LATEST, 23))])
    // 02:00 ET on the latest day to 02:00 ET the next day: not ET midnights, snapped to the nearest ones.
    const { body } = await post({ since: new Date(at(LATEST, 2)).toISOString(), until: new Date(at(TODAY, 2)).toISOString(), view: COACH_TIPS_VIEW })
    expect(st(body, 'place', 'shown').range).toBe(2) // the whole day, including the row before 02:00
  })

  it('the response carries no hour, place or device field', async () => {
    insertHits(db, [hit('/coach/shown/place', at(LATEST, 9), { country: 'US', device: 'mobile' })])
    const text = JSON.stringify((await post(range)).body)
    expect(text).not.toMatch(/hour|country|region|city|device|visitor|browser/i)
  })

  it('everSeen ignores the site and exclusion filters, so a narrowed selection never reads as not shipped', async () => {
    insertHits(db, [hit('/coach/shown/place', at('2026-09-20', 9), { site: 'other-site' })])
    const { body } = await post({ ...range, sites: ['bestsudoku-web'], excludeKnownTraffic: true })
    expect(body.everSeen).toBe(true)
    expect(st(body, 'place', 'shown').range).toBe(0)
  })

  it('a view-only session may read it (the same POST /api/features)', () => {
    expect(viewerMayRequest('POST', '/api/features')).toBe(true)
  })

  it('today is read too, and the day before the latest is its own column', async () => {
    insertHits(db, [hit('/coach/shown/place', at(TODAY, 9), { n: 7 }), hit('/coach/shown/place', at(PREV, 9), { n: 1 })])
    const { body } = await post(range)
    expect(st(body, 'place', 'shown')).toMatchObject({ latest: 0, prev: 1, range: 8 })
  })
})
