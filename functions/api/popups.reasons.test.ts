// POST /api/popups 'reason' for an outcome kind: the provisional /popup-outcome/<popup>/<reason>/<outcome>
// rows (best-sudoku P1, lib/popupEvents.ts) break down by reason, and the old /<popup>/<outcome> rows show
// as the 'legacy' reason. Runs the real handler over a node:sqlite-backed fake D1.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost } from './popups'
import { INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS } from '../../src/lib/popupEvents'
import { defaultBestSudokuPopupsWidgets } from '../../src/lib/defaults'

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
    add('/popup-outcome/signin-prompt/first-finish/signed-in', 6)
    add('/ab/ask-order/A/popup-outcome/signin-prompt/placement/signed-in', 50)
    const r = await post({ dimension: 'reason', popup: 'signin-prompt', kind: 'signed-in' })
    const byReason = Object.fromEntries(r.rows.map((x: any) => [x.key.reason, x.pageviews]))
    expect(byReason).toEqual({ legacy: 4, placement: 3, 'committed-repeat': 2, 'first-finish': 6 })
    const o = await post({ dimension: 'outcome', popup: 'signin-prompt' })
    expect(Object.fromEntries(o.rows.map((x: any) => [x.key.outcome, x.pageviews]))).toMatchObject({ 'signed-in': 15, returned: 5 })
  })
})

// The two default Pop-ups charts (pu-upsell-dismiss-reasons, pu-upsell-signedin-reasons): the request body is built
// from the widget's own fields, the way src/api.ts does, so a drift in either shows here.
describe('the upsell-by-reason default charts', () => {
  const chart = (id: string) => defaultBestSudokuPopupsWidgets().find((w) => w.id === id)!
  const bodyOf = (id: string) => {
    const wd = chart(id)
    return { dimension: wd.dimension, popup: wd.popup, kind: wd.popupKind }
  }
  const byReason = (r: any) => Object.fromEntries(r.rows.map((x: any) => [x.key.reason, x.pageviews]))

  it('dismissals count per reason on the upsell, and only the upsell ones', async () => {
    add('/upsell/dismiss/limit', 3)
    add('/upsell/dismiss/daily-locked', 2)
    add('/upsell/shown/limit', 9) // shown is another kind
    add('/signin-prompt/dismiss/placement', 7) // another pop-up
    const r = await post(bodyOf('pu-upsell-dismiss-reasons'))
    expect(byReason(r)).toEqual({ limit: 3, 'daily-locked': 2 })
  })

  it('sign-ins after an upsell count per reason, old-shape rows as legacy, other pop-ups and A/B twins left out', async () => {
    add('/popup-outcome/upsell/limit/signed-in', 4)
    add('/popup-outcome/upsell/cadence/signed-in', 1)
    add('/popup-outcome/upsell/signed-in', 2)
    add('/popup-outcome/upsell/limit/returned', 6) // another outcome
    add('/popup-outcome/signin-prompt/placement/signed-in', 8) // another pop-up
    add('/ab/ask-order/A/popup-outcome/upsell/limit/signed-in', 50)
    const r = await post(bodyOf('pu-upsell-signedin-reasons'))
    expect(byReason(r)).toEqual({ limit: 4, legacy: 2, cadence: 1 })
  })

  it('both charts are an empty list, not an error, when the range has no upsell rows', async () => {
    add('/signin-prompt/shown/placement', 3)
    for (const id of ['pu-upsell-dismiss-reasons', 'pu-upsell-signedin-reasons']) {
      const r = await post(bodyOf(id))
      expect(r.rows, id).toEqual([])
    }
  })

  it('counts only: a per-reason row has no hour, place or device key, and the chart asks for none', async () => {
    add('/popup-outcome/upsell/limit/signed-in', 2)
    const r = await post(bodyOf('pu-upsell-signedin-reasons'))
    for (const row of r.rows) expect(Object.keys(row.key)).toEqual(['reason'])
    for (const id of ['pu-upsell-dismiss-reasons', 'pu-upsell-signedin-reasons']) {
      const wd = chart(id)
      expect(wd).toMatchObject({ dataset: 'popup', dimension: 'reason', popup: 'upsell', metric: 'pageviews' })
      expect(wd.breakdown).toBeUndefined()
    }
  })

  it('an outcome kind trends per ET day too (date dimension)', async () => {
    add('/popup-outcome/upsell/limit/signed-in', 3)
    const r = await post({ dimension: 'date', popup: 'upsell', kind: 'signed-in' })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].pageviews).toBe(3)
  })
})
