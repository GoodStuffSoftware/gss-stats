// Editor tool T2, slice 1: the metric registry's Feature health fact (src/lib/featureHealthSql.ts featureDaysStatement,
// ONE statement) read through foldFeatureDays + assembleHealth gives exactly the model the old /api/features pipeline
// (two statements) gives: per feature its status, statusNote and totals, per step its latest / prev / range / perDay
// counts and ratio, and the range's days. Both run on one real SQLite (node:sqlite, D1's dialect) with made-up rows,
// over many windows, clocks and filters, with ok / went-silent / new features, decoys, a NUL path, another site,
// manual checks and own visits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openHitsDb, insertHits, sqliteD1, pagesContext, postJson, type HitRow } from '../_lib/testing/hitsDb'
import { addDays, etWallTimeMs } from '../../src/lib/etTime'
import { FEATURES, assembleHealth, flatSteps } from '../../src/lib/featureHealth'
import { featureDaysStatement, foldFeatureDays } from '../../src/lib/featureHealthSql'
import { BEST_SUDOKU_SITES } from '../../src/lib/bestSudokuSites'

const TODAY = '2026-10-20'
const at = (date: string, hours: number) => etWallTimeMs(date) + hours * 3_600_000

/** A path of the step: its first exact path, else its first prefix plus a suffix. */
function pathOf(match: { exact?: readonly string[]; prefix?: readonly string[] }): string | null {
  if (match.exact?.length) return match.exact[0]
  if (match.prefix?.length) return `${match.prefix[0]}x`
  return null
}

function seed(db: DatabaseSync): void {
  const rows: (HitRow & { n?: number })[] = []
  for (const fs of flatSteps()) {
    const path = pathOf(fs.step.match)
    if (!path) continue
    const pattern = fs.featureIndex % 3 // 0 steady (ok), 1 went silent 3 days ago, 2 new (last 5 days only)
    for (let k = 0; k <= 45; k++) {
      if (pattern === 1 && k >= 1 && k <= 3) continue
      if (pattern === 2 && k > 5) continue
      if ((k + fs.index) % 11 === 7) continue // gap days
      const day = addDays(TODAY, -k)
      const n = 6 + ((k * 7 + fs.index * 3) % 5)
      for (const h of [0.5, 11.5, 12.5, 23.5]) {
        const site = (k + h) % 2 ? 'bestsudoku-web' : 'bestsudoku-app'
        rows.push({ ts: at(day, h), site, path, n })
      }
      rows.push({ ts: at(day, 9), site: 'other-site', path, n: 2 })
      rows.push({ ts: at(day, 10), site: 'bestsudoku-web', path, browser: 'Chrome', os: 'Windows', n: 3 })
      rows.push({ ts: at(day, 13), site: 'bestsudoku-web', path, campaign: 'manual_check', n: 1 })
    }
  }
  rows.push({ ts: at(addDays(TODAY, -2), 8), site: 'bestsudoku-web', path: '/not/a/step', n: 9 })
  rows.push({ ts: at(addDays(TODAY, -2), 8), site: 'bestsudoku-web', path: '/tour/start\u0000', n: 9 })
  insertHits(db, rows)
}

let db: DatabaseSync
let d1: ReturnType<typeof sqliteD1>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  db = openHitsDb()
  d1 = sqliteD1(db)
  seed(db)
  ;(globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } }
})
afterEach(() => {
  vi.useRealTimers()
  db.close()
  delete (globalThis as any).caches
})

const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

async function oldModel(body: Record<string, unknown>) {
  const { onRequestPost } = await import('./features')
  const res = await onRequestPost(pagesContext(postJson('/api/features', body), { gss_geo: d1 }) as any)
  expect(res.status).toBe(200)
  const { meta: _meta, ...model } = (await res.json()) as any
  return model
}

async function newModel(body: { since: string; until: string; sites?: string[]; excludeKnownTraffic?: boolean; excludeOwnVisits?: boolean; ownBrowser?: string; ownOS?: string }) {
  const nowMs = Date.now()
  const st = featureDaysStatement({
    sinceMs: Date.parse(body.since),
    untilMs: isDateOnly(body.until) ? Date.parse(body.until) + 86_400_000 : Date.parse(body.until),
    nowMs,
    sites: body.sites ?? [],
    excludeKnownTraffic: body.excludeKnownTraffic === true,
    excludeOwn: body.excludeOwnVisits === true,
    ownBrowser: body.ownBrowser,
    ownOS: body.ownOS,
  })
  const before = d1.statements.length
  const raw = (await d1.prepare(st.sql).bind(...st.binds).all()).results as Record<string, unknown>[]
  expect(d1.statements.length - before).toBe(1)
  const folded = foldFeatureDays(raw, FEATURES, st.newCutoffDay)
  return { model: assembleHealth({ rows: folded.rows, before: folded.before, nowMs, rangeFrom: st.rangeFrom, rangeTo: st.rangeTo }), sql: st.sql }
}

const NOWS = ['2026-10-20T14:00:00Z', '2026-10-20T19:00:00Z', '2026-10-21T03:30:00Z'] // 10:00, 15:00, 23:30 ET
const WINDOWS = (now: string) => {
  const today = now.slice(0, 10)
  return [
    { since: addDays(today, -29), until: today },
    { since: addDays(today, -6), until: today },
    { since: `${addDays(today, -7)}T04:00:00Z`, until: `${today}T04:00:00Z` },
    { since: `${addDays(today, -3)}T15:30:00Z`, until: now },
    { since: addDays(today, -1), until: addDays(today, -1) },
    { since: '2026-01-01', until: today },
    { since: '2020-01-01', until: '2028-12-31' },
  ]
}
const TOGGLES = [
  { excludeKnownTraffic: true },
  { excludeKnownTraffic: false },
  { excludeKnownTraffic: true, sites: ['bestsudoku-web'] },
  { excludeKnownTraffic: true, sites: [...BEST_SUDOKU_SITES] },
  { excludeKnownTraffic: false, sites: ['bestsudoku-app'], excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows' },
  { excludeKnownTraffic: true, excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows' },
]

describe('featureDays (one statement) == /api/features health (two statements)', () => {
  for (const now of NOWS) {
    it(`every window and filter at ${now}`, async () => {
      vi.setSystemTime(new Date(now))
      let cases = 0
      for (const w of WINDOWS(now)) {
        for (const t of TOGGLES) {
          const body = { ...w, ...t }
          const old = await oldModel(body)
          const { model } = await newModel(body)
          expect(model, JSON.stringify(body)).toEqual(old)
          cases++
        }
      }
      expect(cases).toBe(WINDOWS(now).length * TOGGLES.length)
    }, 60_000)
  }

  it('the seed reaches every status (ok, went silent, new)', async () => {
    vi.setSystemTime(new Date(NOWS[1]))
    const { model } = await newModel({ since: addDays(TODAY, -29), until: TODAY, excludeKnownTraffic: true })
    const statuses = new Set(model.features.map((f) => f.status))
    expect([...statuses].sort()).toEqual(['new', 'ok', 'silent'])
  })

  it('counts only: grouped by the ET day alone, no visitor, hour, place or device column, no JOIN', async () => {
    vi.setSystemTime(new Date(NOWS[1]))
    const { sql } = await newModel({ since: addDays(TODAY, -6), until: TODAY, excludeKnownTraffic: true })
    expect(sql).toMatch(/GROUP BY d ORDER BY d$/)
    expect(sql).not.toMatch(/\bJOIN\b/i)
    const select = sql.slice(0, sql.indexOf(' FROM hits '))
    for (const col of ['visitor', 'country', 'region', 'city', 'device', 'browser', 'os', 'colo', 'lat', 'lon', 'postal', 'timezone']) {
      expect(select).not.toMatch(new RegExp(`\\b${col}\\b`))
    }
  })
})
