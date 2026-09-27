// The Pop-ups page's rate table ('rates' dimension of functions/api/popups.ts, rendered by a
// 'rateTable' widget): VALID ratios only (docs/adr/0003), each with n/d and MIN_COHORT gating.
// Runs the real handler over a node:sqlite-backed fake D1.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost } from './popups'
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
  db.exec(`CREATE TABLE hits (ts INTEGER, site TEXT DEFAULT 'bestsudoku-web', path TEXT)`)
})
afterEach(() => db.close())

const FIX = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS!
function add(path: string, n: number, ts = FIX + 3_600_000) {
  for (let i = 0; i < n; i++) db.prepare('INSERT INTO hits (ts, path) VALUES (?, ?)').run(ts + i, path)
}
async function rates() {
  const gss_geo = {
    prepare: (sql: string) => ({ bind: (...b: unknown[]) => ({ all: async () => ({ results: db.prepare(sql).all(...(b as any[])) }) }) }),
  }
  const body = { dimension: 'rates', since: '2026-09-20', until: '2026-10-01' }
  const res = await onRequestPost({ request: { json: async () => body }, env: { gss_geo }, waitUntil: () => {} } as any)
  return ((await res.json()) as any).rateRows as any[]
}

describe('POPUP_RATE_TABLE_KEYS: valid ratios only', () => {
  it('is exactly every pop-up tap rate plus install over post-fix install prompts', () => {
    expect(POPUP_RATE_TABLE_KEYS).toEqual([...POPUPS.map((p) => `${p.id}:tap`), INSTALL_GAP_RATE_KEY])
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

describe("the 'rates' response", () => {
  it('one row per valid rate, with n/d, a rate, "too few" gating and the no-data state', async () => {
    add('/signin-prompt/placement', 10)
    add('/signin-prompt/accept', 3)
    add('/upsell/shown/cadence', 3) // under MIN_COHORT
    add('/upsell/accept/cadence', 1)
    const rows = await rates()
    expect(rows.map((r) => r.key)).toEqual(POPUP_RATE_TABLE_KEYS)
    const signin = rows.find((r) => r.key === 'signin-prompt:tap')
    expect(signin).toMatchObject({ numerator: 3, denominator: 10, value: 0.3, insufficientCohort: false })
    const upsell = rows.find((r) => r.key === 'upsell:tap')
    expect(upsell).toMatchObject({ numerator: 1, denominator: 3, value: null, insufficientCohort: true })
    expect(3).toBeLessThan(MIN_COHORT)
    const promo = rows.find((r) => r.key === 'promo-first50:tap')
    expect(promo).toMatchObject({ numerator: 0, denominator: 0, value: null, insufficientCohort: false })
  })

  it('install counts post-fix prompts only in its denominator, and carries the fix note when the range spans it', async () => {
    add('/install/prompt/android', 4, FIX - 3_600_000) // pre-fix showings: not in the denominator
    add('/install/prompt/android', 6)
    add('/popup-outcome/install-prompt/installed', 2)
    const install = (await rates()).find((r) => r.key === INSTALL_GAP_RATE_KEY)
    expect(install).toMatchObject({ numerator: 2, denominator: 6 })
    expect(install.value).toBeCloseTo(2 / 6)
    expect(install.note).toMatch(/install fix went live/)
  })
})
