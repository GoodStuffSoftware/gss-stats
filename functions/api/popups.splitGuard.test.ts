// /api/popups groups pop-up rows by UTC hour, so the rows the counts-only rule protects
// (src/lib/splitGuard.ts) are left out of its one query, as SQL literals that cost no binds. None is a
// pop-up event, so every pop-up count is unchanged.
import { describe, expect, it } from 'vitest'
import { onRequestPost } from './popups'
import { insertHits, openHitsDb, sqliteD1 } from '../_lib/testing/hitsDb'
import { SPLIT_REFUSED_PATH_PATTERNS } from '../../src/lib/splitGuard'

describe('/api/popups and the split guard', () => {
  it('its hourly query names the refused patterns as literals and never returns a refused row', async () => {
    const db = openHitsDb()
    const ts = Date.parse('2026-10-01T15:00:00Z')
    insertHits(db, [
      { ts, site: 'bestsudoku-web', path: '/signin-prompt/placement', n: 3 },
      ...['/return/x/d0', '/game/complete/normal/easy', '/game/start/easy', '/tour/skip', '/tour/exit-at/2', '/game/tutorial-complete/first-run'].map((path) => ({ ts, site: 'bestsudoku-web', path, n: 2 })),
      // Not in the rule: the query still reads them (the `/tour` event prefix), nothing here counts them.
      ...['/tour/start', '/tour/complete'].map((path) => ({ ts, site: 'bestsudoku-web', path, n: 2 })),
    ])
    const d1 = sqliteD1(db)
    const seen: { sql: string; binds: unknown[] }[] = []
    const spy = { prepare: (sql: string) => ({ bind: (...binds: unknown[]) => (seen.push({ sql, binds }), d1.prepare(sql).bind(...binds)) }) }
    const request = new Request('https://stats.example/api/popups', { method: 'POST', body: JSON.stringify({ dimension: 'kind', since: '2026-09-30', until: '2026-10-02' }), headers: { 'content-type': 'application/json' } })
    const res = await (onRequestPost as any)({ request, env: { gss_geo: spy }, waitUntil: () => {} })
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    // Literals, like the pop-up include clause's own prefixes: no pattern is a bind.
    expect(seen[0].sql).toContain(`NOT (${SPLIT_REFUSED_PATH_PATTERNS.map((p) => `path LIKE '${p}'`).join(' OR ')} OR instr(path, char(0)) > 0)`)
    for (const p of SPLIT_REFUSED_PATH_PATTERNS) expect(seen[0].binds).not.toContain(p)
    // Every `?` is a bind, and the statement stays far under D1's 100-parameter cap.
    expect(seen[0].sql.match(/\?/g)?.length ?? 0).toBe(seen[0].binds.length)
    expect(seen[0].binds.length).toBeLessThan(100)
    const rows = db.prepare(seen[0].sql).all(...(seen[0].binds as (string | number)[])) as { path: string }[]
    // Only the tour-skip row (and the rest of the rule's list) is gone; /tour/start and
    // /tour/complete are outside the rule, so the query still returns them.
    expect([...new Set(rows.map((r) => r.path))].sort()).toEqual(['/signin-prompt/placement', '/tour/complete', '/tour/start'])
  })
})
