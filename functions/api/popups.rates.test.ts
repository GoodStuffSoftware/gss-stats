// The Pop-ups page's rate table — since layout version 11 the metric card `popup-rates` over POST
// /api/metrics (the 'rates' dimension of /api/popups retired with the bespoke table): VALID ratios
// only (numerator a declared subset of the denominator), each with n/d and MIN_COHORT gating.
// Runs the real handler over a node:sqlite-backed fake D1.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost } from './metrics'
import { PRESETS } from '../../src/lib/metrics/presets'
import {
  INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
  INSTALL_GAP_RATE_KEY,
  POPUPS,
  POPUP_RATE_SPECS,
  POPUP_RATE_TABLE_KEYS,
  MIN_COHORT,
} from '../../src/lib/popupEvents'

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE hits (
    ts INTEGER, site TEXT DEFAULT 'bestsudoku-web', path TEXT DEFAULT '', referrer TEXT DEFAULT '', country TEXT DEFAULT '',
    region TEXT DEFAULT '', city TEXT DEFAULT '', postal TEXT DEFAULT '', continent TEXT DEFAULT '', timezone TEXT DEFAULT '',
    lat TEXT DEFAULT '', lon TEXT DEFAULT '', colo TEXT DEFAULT '', org TEXT DEFAULT '', device TEXT DEFAULT 'mobile',
    browser TEXT DEFAULT 'Safari', os TEXT DEFAULT 'iOS', lang TEXT DEFAULT '', screenw INTEGER DEFAULT 390,
    visitor TEXT DEFAULT 'new', refpath TEXT DEFAULT '', source TEXT DEFAULT '', medium TEXT DEFAULT '', campaign TEXT DEFAULT ''
  )`)
})
afterEach(() => db.close())

const FIX = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS!
function add(path: string, n: number, ts = FIX + 3_600_000) {
  for (let i = 0; i < n; i++) db.prepare('INSERT INTO hits (ts, path) VALUES (?, ?)').run(ts + i, path)
}
const fakeGeo = () => ({
  prepare: (sql: string) => ({ bind: (...b: unknown[]) => ({ all: async () => ({ results: db.prepare(sql).all(...(b as any[])) }) }) }),
})
beforeEach(() => {
  ;(globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } }
})
afterEach(() => {
  delete (globalThis as any).caches
})
/** Every rate the card asks for, keyed like POPUP_RATE_TABLE_KEYS ("<popup>:tap", and the install
 * prompt's installed rate), with its value, n/d, status and notes. */
async function rates(context: Record<string, unknown> = {}) {
  const requests = [
    ...POPUPS.map((p) => ({ key: `${p.id}:tap`, ratio: 'popup.tapRate', params: { popup: p.id } })),
    { key: INSTALL_GAP_RATE_KEY, ratio: 'popup.installedRate', params: { popup: 'install' } },
  ]
  const body = JSON.stringify({ v: 1, context: { since: '2026-09-20', until: '2026-10-01', ...context }, requests })
  const res = await onRequestPost({ request: new Request('https://stats.goodstuff.software/api/metrics', { method: 'POST', body }), env: { gss_geo: fakeGeo() }, waitUntil: () => {} } as any)
  const results = ((await res.json()) as any).results
  return requests.map((r) => ({ key: r.key, ...results[r.key] }))
}

describe('POPUP_RATE_TABLE_KEYS: valid ratios only', () => {
  it('is exactly every pop-up tap rate plus install over post-fix install prompts', () => {
    expect(POPUP_RATE_TABLE_KEYS).toEqual([...POPUPS.map((p) => `${p.id}:tap`), INSTALL_GAP_RATE_KEY])
  })
  it('the popup-rates card asks for exactly these VALID RATIOS: a tap rate per pop-up, and install over post-fix prompts', () => {
    const items = PRESETS['popup-rates'].sections.flatMap((s) => s.items)
    const ratioItems = items.filter((i) => 'ratio' in i.data)
    expect(ratioItems.map((i) => ('ratio' in i.data ? i.data.ratio : ''))).toEqual(['popup.tapRate', 'popup.installedRate'])
    expect(ratioItems[0].repeat).toEqual({ over: 'popups' })
    expect(ratioItems[1].data).toMatchObject({ params: { popup: 'install' } })
  })
  // Added 2026-09-27 (review round, A2): the lagged pop-up outcomes (signed-in/returned/
  // still-playing) are COUNTS here, never a rate — see this file's own comment above on why
  // (numerator not a valid subset of a same-window denominator) — but they still need an
  // explicit-zero tile so a chart-only view of the outcome breakdown (which draws nothing for a
  // zero-row combination) never reads as "not wired up".
  it('also asks for signed-in/returned/still-playing as COUNTS (never a ratio), one row per pop-up each', () => {
    const items = PRESETS['popup-rates'].sections.flatMap((s) => s.items)
    const metricItems = items.filter((i) => 'metric' in i.data)
    expect(metricItems.map((i) => ('metric' in i.data ? i.data.metric : ''))).toEqual(['popup.outcomeSignedIn', 'popup.outcomeReturned', 'popup.outcomeStillPlaying'])
    for (const i of metricItems) {
      expect(i.repeat).toEqual({ over: 'popups' })
      expect(i.display).toEqual({ as: 'number' })
    }
  })
  it('contains no lagged outcome rate and no eligibility rate', () => {
    for (const key of POPUP_RATE_TABLE_KEYS) {
      const spec = POPUP_RATE_SPECS.find((s) => s.key === key)!
      expect(spec.kind === 'tap' || key === INSTALL_GAP_RATE_KEY).toBe(true)
      expect(spec.kind).not.toBe('eligibility')
    }
    for (const lagged of ['signin-prompt:outcome:returned', 'upsell:outcome:still-playing', 'signin-prompt:outcome:signed-in']) {
      expect(POPUP_RATE_TABLE_KEYS).not.toContain(lagged)
    }
  })
})

describe("the card's rates", () => {
  it('one row per valid rate, with n/d, a rate, "too few" gating and the no-data state', async () => {
    add('/signin-prompt/placement', 10)
    add('/signin-prompt/accept', 3)
    add('/upsell/shown/cadence', 3) // under MIN_COHORT
    add('/upsell/accept/cadence', 1)
    const rows = await rates()
    expect(rows.map((r) => r.key)).toEqual(POPUP_RATE_TABLE_KEYS)
    const signin = rows.find((r) => r.key === 'signin-prompt:tap')
    // 'partial': the range starts before pop-up tracking went live, so it is counted from then.
    expect(signin).toMatchObject({ numerator: 3, denominator: 10, value: 0.3, status: 'partial' })
    const upsell = rows.find((r) => r.key === 'upsell:tap')
    expect(upsell).toMatchObject({ numerator: 1, denominator: 3, value: null, status: 'too-few' })
    expect(3).toBeLessThan(MIN_COHORT)
    const promo = rows.find((r) => r.key === 'promo-first50:tap')
    expect(promo).toMatchObject({ numerator: 0, denominator: 0, value: null, status: 'no-data' })
  })

  it('install counts post-fix prompts only in its denominator, and carries the fix note when the range spans it', async () => {
    add('/install/prompt/android', 4, FIX - 3_600_000) // pre-fix showings: not in the denominator
    add('/install/prompt/android', 6)
    add('/popup-outcome/install-prompt/installed', 2)
    const install = (await rates()).find((r) => r.key === INSTALL_GAP_RATE_KEY)
    expect(install).toMatchObject({ numerator: 2, denominator: 6 })
    expect(install.value).toBeCloseTo(2 / 6)
    expect(install.noteIds).toContain('install-fix-note') // "install fix went live …", in the card's Notes
  })
})

describe('"Hide my visits" applies to the rate card exactly as it does to the pop-up bar chart', () => {
  const own = { excludeOwnVisits: true, ownBrowser: 'Opera', ownOS: 'Windows' }
  function addOwned(path: string, total: number, owner: number) {
    for (let i = 0; i < total; i++) {
      const mine = i < owner
      db.prepare('INSERT INTO hits (ts, path, browser, os) VALUES (?, ?, ?, ?)').run(FIX + 3_600_000 + i, path, mine ? 'Opera' : 'Safari', mine ? 'Windows' : 'iOS')
    }
  }
  it('20% of rows from the owner: both drop them, and agree', async () => {
    addOwned('/signin-prompt/placement', 20, 4)
    addOwned('/signin-prompt/accept', 10, 2)
    const withOwn = (await rates()).find((r) => r.key === 'signin-prompt:tap')
    expect(withOwn).toMatchObject({ numerator: 10, denominator: 20 })
    const mineHidden = (await rates(own)).find((r) => r.key === 'signin-prompt:tap')
    expect(mineHidden).toMatchObject({ numerator: 8, denominator: 16 })

    const { onRequestPost: geoPost } = await import('./geo')
    const res = await geoPost({
      request: { json: async () => ({ dimension: 'popupFamily', breakdown: 'popupOutcome', dims: ['popupFamily', 'popupOutcome'], since: '2026-09-20', until: '2026-10-01', limit: 100, ...own }) },
      env: { gss_geo: fakeGeo() },
      waitUntil: () => {},
    } as any)
    const bar: any = await res.json()
    const cell = (o: string) => bar.rows.find((r: any) => r.key.popupFamily === 'signin-prompt' && r.key.popupOutcome === o)?.pageviews
    expect([cell('accept'), cell('shown')]).toEqual([mineHidden.numerator, mineHidden.denominator])
  })
})
