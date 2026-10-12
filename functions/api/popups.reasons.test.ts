// POST /api/popups 'reason' for an outcome kind: the provisional /popup-outcome/<popup>/<reason>/<outcome>
// rows (best-sudoku P1, lib/popupEvents.ts) break down by reason, and the old /<popup>/<outcome> rows show
// as the 'legacy' reason. Runs the real handler over a node:sqlite-backed fake D1.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost } from './popups'
import { INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS } from '../../src/lib/popupEvents'

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE hits (ts INTEGER, site TEXT DEFAULT 'bestsudoku-web', path TEXT DEFAULT '', browser TEXT DEFAULT 'Safari', os TEXT DEFAULT 'iOS', visitor TEXT DEFAULT 'new', campaign TEXT DEFAULT '')`)
})
afterEach(() => db.close())

const TS = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS! + 3_600_000
function add(path: string, n: number) {
  for (let i = 0; i < n; i++) db.prepare('INSERT INTO hits (ts, path) VALUES (?, ?)').run(TS + i, path)
}
const fakeGeo = () => ({
  prepare: (sql: string) => ({ bind: (...b: unknown[]) => ({ all: async () => ({ results: db.prepare(sql).all(...(b as any[])) }) }) }),
})
async function post(body: Record<string, unknown>) {
  const since = new Date(TS - 86_400_000).toISOString().slice(0, 10)
  const until = new Date(TS + 86_400_000).toISOString().slice(0, 10)
  const res = await onRequestPost({ request: new Request('https://stats.goodstuff.software/api/popups', { method: 'POST', body: JSON.stringify({ since, until, ...body }) }), env: { gss_geo: fakeGeo() } } as any)
  return (await res.json()) as any
}

describe('/api/popups reason breakdown of an outcome kind', () => {
  it('splits new-shape outcomes by reason, shows old-shape rows as legacy, and ignores the A/B twins', async () => {
    add('/popup-outcome/signin-prompt/signed-in', 4)
    add('/popup-outcome/signin-prompt/placement/signed-in', 3)
    add('/popup-outcome/signin-prompt/committed-repeat/signed-in', 2)
    add('/popup-outcome/signin-prompt/placement/returned', 5)
    add('/ab/ask-order/A/popup-outcome/signin-prompt/placement/signed-in', 50)
    const r = await post({ dimension: 'reason', popup: 'signin-prompt', kind: 'signed-in' })
    const byReason = Object.fromEntries(r.rows.map((x: any) => [x.key.reason, x.pageviews]))
    expect(byReason).toEqual({ legacy: 4, placement: 3, 'committed-repeat': 2 })
    const o = await post({ dimension: 'outcome', popup: 'signin-prompt' })
    expect(Object.fromEntries(o.rows.map((x: any) => [x.key.outcome, x.pageviews]))).toMatchObject({ 'signed-in': 9, returned: 5 })
  })
})
