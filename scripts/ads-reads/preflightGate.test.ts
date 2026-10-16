// The flight 3 pre-flight gate line: organic rows on the new paths since the v1.99.1 web release, on a
// real SQLite hits table. Made-up rows only.
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createBeaconSource, preflightGateLine, preflightGateMet, preflightGateQuery, PREFLIGHT_RELEASE_UTC, WEB_SITE } from './beacon'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead, type MorningOptions } from './read'
import { formatMorningReport } from './report'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import { assertReadOnlySql, inlineBinds } from './d1'

const REL = Date.parse(PREFLIGHT_RELEASE_UTC.replace(' ', 'T') + 'Z')
function openHitsDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const text = ['site', 'path', 'referrer', 'country', 'region', 'city', 'postal', 'continent', 'timezone', 'lat', 'lon', 'colo', 'org', 'device', 'browser', 'os', 'lang', 'refpath', 'source', 'medium', 'campaign']
  db.exec(`CREATE TABLE hits (ts INTEGER, screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', ${text.map((c) => `${c} TEXT DEFAULT ''`).join(', ')})`)
  return db
}
type Row = { path: string; ts?: number; site?: string; campaign?: string | null; region?: string; screenw?: number; medium?: string }
function seed(db: DatabaseSync, rows: Row[]) {
  const ins = db.prepare('INSERT INTO hits (ts, site, path, campaign, region, screenw, medium) VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const r of rows) ins.run(r.ts ?? REL + 1000, r.site ?? WEB_SITE, r.path, r.campaign === undefined ? '' : r.campaign, r.region ?? '', r.screenw ?? 0, r.medium ?? '')
}
const read = (db: DatabaseSync) => createBeaconSource((async (sql: string, binds: unknown[]) => db.prepare(sql).all(...(binds as (string | number)[]))) as never).preflightGate!()

describe('pre-flight gate', () => {
  it('query is read-only and cuts at the release in SQL, not a hand epoch', () => {
    const q = preflightGateQuery()
    expect(() => assertReadOnlySql(inlineBinds(q.sql, q.binds))).not.toThrow()
    expect(q.sql).toContain(`strftime('%s','2026-10-16 21:07:00')*1000`)
  })
  it('NOT YET with no rows, and with coach only', async () => {
    const db = openHitsDb()
    expect(await read(db)).toEqual({ coach: 0, committed: 0, eligible: 0 })
    seed(db, [{ path: '/coach/shown/place' }])
    const c = await read(db)
    expect(c).toEqual({ coach: 1, committed: 0, eligible: 0 })
    expect(preflightGateLine(c)).toBe('Pre-flight gate (organic since v1.99.1 web, 2026-10-16 21:07Z): /coach/* 1 · /signin-prompt/committed-* 0 · /signin-eligible/* 0 → NOT YET')
  })
  it('NOT YET with sign-in rows but no coach rows', async () => {
    const db = openHitsDb()
    seed(db, [{ path: '/signin-eligible/x' }, { path: '/signin-prompt/committed-repeat' }])
    expect(preflightGateMet(await read(db))).toBe(false)
  })
  it('MET with coach and either sign-in family', async () => {
    const a = openHitsDb()
    seed(a, [{ path: '/coach/shown/place' }, { path: '/coach/shown/hint' }, { path: '/signin-eligible/x' }])
    const ca = await read(a)
    expect(ca).toEqual({ coach: 2, committed: 0, eligible: 1 })
    expect(preflightGateLine(ca)).toContain('/coach/* 2 · /signin-prompt/committed-* 0 · /signin-eligible/* 1 → MET')
    const b = openHitsDb()
    seed(b, [{ path: '/coach/tour-opened' }, { path: '/signin-prompt/committed-challenge' }])
    expect(preflightGateMet(await read(b))).toBe(true)
  })
  it('leaves out pre-release, app, campaign-tagged, household, verification and lifecycle rows', async () => {
    const db = openHitsDb()
    seed(db, [
      { path: '/coach/shown/place', ts: REL - 1 },
      { path: '/coach/shown/place', site: 'bestsudoku-app' },
      { path: '/coach/shown/place', campaign: 'sudoku_funnel_f3_search' },
      { path: '/coach/shown/place', region: 'North Carolina', screenw: 412 },
      { path: '/coach/shown/place', medium: 'lifecycle' },
      { path: '/coach/shown/place', campaign: 'email_welcome' },
      { path: '/signin-eligible/x', campaign: 'sudoku_funnel_f3_apps_hero' },
      { path: '/signin-prompt/placement' }, // not a gate path
      { path: '/coach/shown/place', ts: REL }, // at the instant: counts
    ])
    expect(await read(db)).toEqual({ coach: 1, committed: 0, eligible: 0 })
  })
})

describe('pre-flight gate in the morning read and report', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const fx = (): Fixture => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8'))
  const opts: MorningOptions = { campaignId: '24279250691', releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 }
  const run = async (gate: (() => Promise<{ coach: number; committed: number; eligible: number }>) | undefined) => {
    const d = fixtureDeps(fx(), true)
    const deps = { ...d, beacon: { ...d.beacon!, ...(gate ? { preflightGate: gate } : {}) } }
    const r = await runMorningRead(deps as never, opts)
    return { r, lines: formatMorningReport(r).split(String.fromCharCode(10)) }
  }
  it('prints the line right after the tag split block, MET', async () => {
    const { r, lines } = await run(async () => ({ coach: 2, committed: 1, eligible: 0 }))
    expect(r.preflightGate).toEqual({ ok: true, counts: { coach: 2, committed: 1, eligible: 0 } })
    const i = lines.findIndex((l) => l.startsWith('Pre-flight gate'))
    expect(lines[i]).toBe('Pre-flight gate (organic since v1.99.1 web, 2026-10-16 21:07Z): /coach/* 2 · /signin-prompt/committed-* 1 · /signin-eligible/* 0 → MET')
    expect(lines[i - 1]).toMatch(/^Tagged so far|^  /)
  })
  it('prints NOT YET', async () => {
    const { lines } = await run(async () => ({ coach: 0, committed: 0, eligible: 0 }))
    expect(lines.find((l) => l.startsWith('Pre-flight gate'))).toMatch(/→ NOT YET$/)
  })
  it('a failed read prints NOT READ and does not throw', async () => {
    const { r, lines } = await run(async () => {
      throw new Error('boom')
    })
    expect(r.preflightGate?.ok).toBe(false)
    expect(lines.find((l) => l.startsWith('Pre-flight gate'))).toContain('NOT READ')
  })
  it('a source without the read prints no gate line', async () => {
    const { r, lines } = await run(undefined)
    expect(r.preflightGate).toBeNull()
    expect(lines.some((l) => l.startsWith('Pre-flight gate'))).toBe(false)
  })
})
