// The routine's beacon reads and the counts-only rule (src/lib/splitGuard.ts): the reads that
// group by UTC hour (siteEventsQuery) or by country (taggedCountryQuery) leave out every row the
// rule protects, as SQL literals that cost no binds, while every other row counts as before.
import { describe, expect, it } from 'vitest'
import { siteEventsQuery, siteFirstSessionQuery, taggedCountryQuery, WEB_SITE } from './beacon'
import { DatabaseSync } from 'node:sqlite'
import { campaignById } from '../../src/lib/campaigns'
import { SPLIT_REFUSED_PATH_PATTERNS, refusedPathMatch } from '../../src/lib/splitGuard'

const ANDROID = campaignById('24215315197')!
const at = (iso: string) => Date.parse(iso)
const REFUSED = ['/return/sudoku_tired_of_ads/d0', '/game/complete/normal/easy', '/game/complete-deferred/normal/easy', '/game/tutorial-complete/first-run', '/game/start/easy', '/tour/skip', '/tour/exit-at/3']

function guarded(q: { sql: string; binds: unknown[] }) {
  // The exclusion names each pattern as a literal (lib/splitGuard.ts refusedPathMatch); none is
  // a bind.
  expect(q.sql).toContain(`NOT (${SPLIT_REFUSED_PATH_PATTERNS.map((p) => `path LIKE '${p}'`).join(' OR ')})`)
  for (const p of SPLIT_REFUSED_PATH_PATTERNS) expect(q.binds).not.toContain(p)
}
// A local hits table (not functions/_lib/testing/hitsDb: that pulls Workers types into this
// Node-typed project).
function openHitsDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const text = ['site', 'path', 'referrer', 'country', 'region', 'city', 'postal', 'continent', 'timezone', 'lat', 'lon', 'colo', 'org', 'device', 'browser', 'os', 'lang', 'refpath', 'source', 'medium', 'campaign']
  db.exec(`CREATE TABLE hits (ts INTEGER, screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', ${text.map((c) => `${c} TEXT DEFAULT ''`).join(', ')})`)
  return db
}
type Row = { ts: number; site: string; path: string; country?: string; campaign?: string; n: number }
function insertHits(db: DatabaseSync, rows: Row[]): void {
  const ins = db.prepare('INSERT INTO hits (ts, site, path, country, campaign) VALUES (?, ?, ?, ?, ?)')
  for (const r of rows) for (let i = 0; i < r.n; i++) ins.run(r.ts, r.site, r.path, r.country ?? '', r.campaign ?? '')
}
const run = (db: DatabaseSync, q: { sql: string; binds: unknown[] }) => db.prepare(q.sql).all(...(q.binds as (string | number)[])) as Record<string, unknown>[]

describe('routine beacon reads leave the split-refused rows out', () => {
  it('siteEventsQuery (by UTC hour): only pop-up event rows, never a refused row', () => {
    const db = openHitsDb()
    const ts = at('2026-10-01T15:00:00Z')
    insertHits(db, [
      { ts, site: WEB_SITE, path: '/signin-prompt/placement', n: 3 },
      { ts, site: WEB_SITE, path: '/install/prompt/android', n: 2 },
      ...REFUSED.map((path) => ({ ts, site: WEB_SITE, path, n: 4 })),
    ])
    const q = siteEventsQuery(at('2026-09-30T00:00:00Z'))
    guarded(q)
    const rows = run(db, q)
    expect(rows.map((r) => r.path).sort()).toEqual(['/install/prompt/android', '/signin-prompt/placement'])
    expect(rows.reduce((a, r) => a + Number(r.c), 0)).toBe(5)
  })

  it('siteFirstSessionQuery keeps tour skips as a per-path total (counts only: no hour, place or device column)', () => {
    const db = openHitsDb()
    const ts = at('2026-10-01T15:00:00Z')
    insertHits(db, [
      { ts, site: WEB_SITE, path: '/tour/skip', country: 'US', n: 3 },
      { ts: ts + 1, site: WEB_SITE, path: '/tour/skip', country: 'CA', n: 2 },
      { ts, site: WEB_SITE, path: '/tour/start', country: 'US', n: 4 },
      { ts, site: 'bestsudoku-app', path: '/tour/skip', country: 'US', n: 9 },
    ])
    const q = siteFirstSessionQuery(at('2026-10-01T00:00:00Z'), at('2026-10-02T00:00:00Z'))
    // A total per path over the window: the skips from every place and hour are summed, and the
    // only selected columns are the path and the count.
    expect(q.sql).toMatch(/^SELECT path AS p, COUNT\(\*\) AS c FROM hits WHERE /)
    expect(q.sql).toMatch(/GROUP BY p$/)
    expect(Object.fromEntries(run(db, q).map((r) => [r.p, Number(r.c)]))).toEqual({ '/tour/skip': 5, '/tour/start': 4 })
  })

  it('every guarded read binds well under the D1 100-parameter cap (the patterns are literals)', () => {
    // Each read here carries the guard as literals, so the guard adds no binds at all.
    for (const q of [siteEventsQuery(0), taggedCountryQuery(ANDROID), siteFirstSessionQuery(0, 1)]) {
      expect(q.binds.length).toBeLessThan(100)
      expect(q.sql.match(/\?/g)?.length ?? 0).toBe(q.binds.length)
    }
    const m = refusedPathMatch()
    expect(m.binds).toEqual([])
  })

  it('taggedCountryQuery (by country): campaign rows by country, refused rows in no country', () => {
    const db = openHitsDb()
    const ts = at('2026-09-03T15:00:00Z')
    const tag = { site: WEB_SITE, campaign: 'sudoku_tired_of_ads' }
    insertHits(db, [
      { ...tag, ts, path: '/game', country: 'US', n: 5 },
      { ...tag, ts, path: '/', country: 'CA', n: 2 },
      ...REFUSED.map((path) => ({ ...tag, ts, path, country: 'FR', n: 7 })),
    ])
    const q = taggedCountryQuery(ANDROID)
    guarded(q)
    expect(run(db, q).map((r) => [r.country, Number(r.c)])).toEqual([['US', 5], ['CA', 2]])
  })
})
