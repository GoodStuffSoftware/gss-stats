// /api/popups groups pop-up rows by UTC hour, so the rows the counts-only rule protects
// (src/lib/splitGuard.ts) are left out of its one query — bound, never interpolated. None is a
// pop-up event, so every pop-up count is unchanged.
import { describe, expect, it } from 'vitest'
import { onRequestPost } from './popups'
import { insertHits, openHitsDb, sqliteD1 } from '../_lib/testing/hitsDb'
import { SPLIT_REFUSED_PATH_PATTERNS } from '../../src/lib/splitGuard'

describe('/api/popups and the split guard', () => {
  it('its hourly query binds the refused patterns and never returns a refused row', async () => {
    const db = openHitsDb()
    const ts = Date.parse('2026-10-01T15:00:00Z')
    insertHits(db, [
      { ts, site: 'bestsudoku-web', path: '/signin-prompt/placement', n: 3 },
      ...['/return/x/d0', '/game/complete/normal/easy', '/game/start/easy', '/tour/exit-at/2', '/game/tutorial-complete/first-run'].map((path) => ({ ts, site: 'bestsudoku-web', path, n: 2 })),
    ])
    const d1 = sqliteD1(db)
    const seen: { sql: string; binds: unknown[] }[] = []
    const spy = { prepare: (sql: string) => ({ bind: (...binds: unknown[]) => (seen.push({ sql, binds }), d1.prepare(sql).bind(...binds)) }) }
    const request = new Request('https://stats.example/api/popups', { method: 'POST', body: JSON.stringify({ dimension: 'kind', since: '2026-09-30', until: '2026-10-02' }), headers: { 'content-type': 'application/json' } })
    const res = await (onRequestPost as any)({ request, env: { gss_geo: spy }, waitUntil: () => {} })
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    // All placeholders (the pop-up include clause names its own prefixes as literals).
    expect(seen[0].sql).toContain(`NOT (${SPLIT_REFUSED_PATH_PATTERNS.map(() => 'path LIKE ?').join(' OR ')})`)
    for (const p of SPLIT_REFUSED_PATH_PATTERNS) expect(seen[0].binds).toContain(p)
    const rows = db.prepare(seen[0].sql).all(...(seen[0].binds as (string | number)[])) as { path: string }[]
    expect([...new Set(rows.map((r) => r.path))]).toEqual(['/signin-prompt/placement'])
  })
})
