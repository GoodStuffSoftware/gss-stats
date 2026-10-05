// meta.liveSafe on /api/geo: true only when no refused path can be counted by the query (the same
// reachableRefusedPatterns call that drives the refused-whole-days caption), and the key is
// absent otherwise. Nothing else about the response or its edge-cache key changes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost } from './geo'
import type { CacheLike } from '../_lib/edgeCache'

const noopCache: CacheLike = { match: async () => undefined, put: async () => {} }

let db: DatabaseSync
beforeEach(() => {
  ;(globalThis as any).caches = { default: noopCache }
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE hits (
    ts INTEGER, site TEXT DEFAULT '', path TEXT DEFAULT '', referrer TEXT DEFAULT '', country TEXT DEFAULT '',
    region TEXT DEFAULT '', city TEXT DEFAULT '', postal TEXT DEFAULT '', continent TEXT DEFAULT '',
    timezone TEXT DEFAULT '', lat TEXT DEFAULT '', lon TEXT DEFAULT '', colo TEXT DEFAULT '', org TEXT DEFAULT '',
    device TEXT DEFAULT '', browser TEXT DEFAULT '', os TEXT DEFAULT '', lang TEXT DEFAULT '',
    screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', refpath TEXT DEFAULT '', source TEXT DEFAULT '',
    medium TEXT DEFAULT '', campaign TEXT DEFAULT ''
  )`)
  const ins = db.prepare('INSERT INTO hits (ts, site, path, country, region, city, lat, lon, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const path of ['/', '/game/first-move', '/return/organic/d1', '/game/complete/normal/easy']) {
    ins.run(Date.parse('2026-10-01T15:30:00Z'), 'bestsudoku-web', path, 'US', 'Ohio', 'Columbus', '39.9', '-83.0', 'mobile')
  }
})
afterEach(() => {
  db.close()
  delete (globalThis as any).caches
})

async function post(body: Record<string, unknown>) {
  const gss_geo = {
    prepare(sql: string) {
      return { bind: (...binds: unknown[]) => ({ all: async () => ({ results: db.prepare(sql).all(...(binds as any[])) }) }) }
    },
  }
  const keys: string[] = []
  ;(globalThis as any).caches = { default: { match: async (r: Request) => (keys.push(r.url), undefined), put: async () => {} } }
  const res = await onRequestPost({ request: { json: async () => body }, env: { gss_geo }, waitUntil: () => {} } as any)
  return { meta: ((await res.json()) as any).meta as Record<string, unknown>, cacheKey: keys[0] }
}
const range = { since: '2026-09-30', until: '2026-10-02', limit: 100 }
const withoutLiveSafe = (m: Record<string, unknown>) => {
  const { liveSafe: _l, ...rest } = m
  return rest
}

describe('/api/geo meta.liveSafe', () => {
  it('a plain page-view map (points, event beacons off) has it', async () => {
    expect((await post({ dimension: 'points', ...range })).meta.liveSafe).toBe(true)
  })
  it('a plain page-view breakdown and ring have it', async () => {
    expect((await post({ dimension: 'country', ...range })).meta.liveSafe).toBe(true)
    expect((await post({ dimensions: ['country', 'region'], ...range })).meta.liveSafe).toBe(true)
  })
  it('includeEventBeacons lacks it (the key is absent, not false)', async () => {
    for (const body of [{ dimension: 'points' }, { dimension: 'country' }, { dimensions: ['country', 'region'] }]) {
      const { meta } = await post({ ...body, includeEventBeacons: true, ...range })
      expect('liveSafe' in meta).toBe(false)
    }
  })
  it('a shape with an event dimension lacks it', async () => {
    const { meta } = await post({ dimension: 'gameMode', ...range })
    expect('liveSafe' in meta).toBe(false)
  })
  it('a drill onto a refused path family lacks it', async () => {
    const { meta } = await post({ dimension: 'country', constraints: [{ field: 'path', value: '/return/organic/d1' }], includeEventBeacons: true, ...range })
    expect('liveSafe' in meta).toBe(false)
  })
  it('a NUL (U+0000) in a path drill value lacks it, whichever mode and toggle (fail-closed)', async () => {
    for (const body of [{ dimension: 'country' }, { dimension: 'points' }, { dimensions: ['country', 'region'] }]) {
      for (const includeEventBeacons of [true, false]) {
        const { meta } = await post({ ...body, constraints: [{ field: 'path', value: '/tour/skip\u0000x' }], includeEventBeacons, ...range })
        expect('liveSafe' in meta).toBe(false)
      }
    }
    // A NUL inside the value, not only at its end, and a NUL in a pathFamily value.
    for (const c of [{ field: 'path', value: '/\u0000' }, { field: 'path', value: '\u0000/tour/skip' }, { field: 'pathFamily', value: 'page\u0000' }]) {
      const { meta } = await post({ dimension: 'country', constraints: [c], includeEventBeacons: true, ...range })
      expect('liveSafe' in meta).toBe(false)
    }
  })
  it('a NUL in a drill value on a non-path dimension does not change it', async () => {
    const { meta } = await post({ dimension: 'country', constraints: [{ field: 'referrer', value: 'a\u0000b' }], ...range })
    expect(meta.liveSafe).toBe(true)
  })
  it('is computed whether or not the window moved (a whole-day window still has it)', async () => {
    const { meta } = await post({ dimension: 'country', since: '2026-09-30', until: '2026-10-02', limit: 100 })
    expect(meta.liveSafe).toBe(true)
    const moved = await post({ dimension: 'country', since: '2026-09-30T12:00:00Z', until: '2026-10-02T12:00:00Z', limit: 100 })
    expect(moved.meta.liveSafe).toBe(true)
  })
  it('changes neither the rest of the meta nor the edge-cache key', async () => {
    const safe = await post({ dimension: 'country', ...range })
    expect(safe.meta.liveSafe).toBe(true)
    expect(withoutLiveSafe(safe.meta)).toEqual({ site: 'all', since: '2026-09-30', until: '2026-10-02', dimensions: ['country'], metric: 'pageviews', dataset: 'geo', splitGuard: true })
    // The same query with event beacons on: no flag, the same remaining meta, and a key that never mentions liveSafe.
    // The key as it was before liveSafe existed (captured from the unchanged key builder).
    expect(safe.cacheKey).toBe(
      'https://edge-cache.internal/api/geo?p=%7B%22constraints%22%3A%5B%5D%2C%22dim%22%3A%22country%22%2C%22excludeKnownTraffic%22%3Afalse%2C%22excludeOwn%22%3Afalse%2C%22excludeSelf%22%3Atrue%2C%22includeEventBeacons%22%3Afalse%2C%22limit%22%3A100%2C%22mode%22%3A%22breakdown%22%2C%22ownBrowser%22%3A%22%22%2C%22ownOS%22%3A%22%22%2C%22ringDims%22%3A%5B%5D%2C%22since%22%3A%222026-09-30%22%2C%22sites%22%3A%5B%5D%2C%22splitGuard%22%3A%22%2Freturn%2F%25%7C%2Fgame%2Fcomplete%2F%25%7C%2Fgame%2Fcomplete-deferred%2F%25%7C%2Fgame%2Ftutorial-complete%2F%25%7C%2Fgame%2Fstart%2F%25%7C%2Ftour%2Fexit-at%2F%25%7C%2Ftour%2Fexit-at%7C%2Ftour%2Fskip%7C%2Ftour%2Fskip%2F%25%22%2C%22until%22%3A%222026-10-02%22%7D',
    )
    const unsafe = await post({ dimension: 'country', includeEventBeacons: true, ...range })
    expect(unsafe.cacheKey).not.toContain('liveSafe')
    expect(withoutLiveSafe(unsafe.meta)).toEqual(withoutLiveSafe(safe.meta))
  })
})
