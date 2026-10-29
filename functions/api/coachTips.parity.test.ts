// Editor tool T3: the card editor's Coach tips readout (the coach-tips preset's requests, POST /api/metrics) gives every
// number the old Coach tips table (POST /api/features { view: 'coach-tips' }) gives: per tip shown / dismissed / closed
// for the latest day, the day before and the range, dismissed and closed per shown, the "Show me around" total, and
// whether any coach row ever arrived (everSeen). Both run on one real SQLite (node:sqlite, D1's dialect) with made-up
// rows: every tip path, decoys (an unknown tip, a near-miss path, a NUL path), another site, manual checks and own visits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openHitsDb, insertHits, sqliteD1, pagesContext, postJson, type HitRow } from '../_lib/testing/hitsDb'
import { addDays, etWallTimeMs } from '../../src/lib/etTime'
import { flatSteps } from '../../src/lib/featureHealth'
import { COACH_TIP_FEATURES, COACH_TIP_ROWS } from '../../src/lib/coachTips'
import { BEST_SUDOKU_SITES } from '../../src/lib/bestSudokuSites'
import { FACTS } from '../../src/lib/metrics/facts'
import { COACH_TIPS } from '../../src/lib/metrics/presets'

const TODAY = '2026-10-20'
const at = (date: string, hours: number) => etWallTimeMs(date) + hours * 3_600_000

function seed(db: DatabaseSync, { onlyHidden = false } = {}): void {
  const rows: (HitRow & { n?: number })[] = []
  for (const fs of flatSteps(COACH_TIP_FEATURES)) {
    const path = fs.step.match.exact![0]
    if (onlyHidden) {
      // Only rows the "ever" read drops (manual checks), and decoys: everSeen stays false.
      rows.push({ ts: at(addDays(TODAY, -3), 13), site: 'bestsudoku-web', path, campaign: 'manual_check', n: 4 })
      continue
    }
    for (let k = 0; k <= 45; k++) {
      if ((k + fs.index) % 11 === 7) continue // gap days
      const day = addDays(TODAY, -k)
      const n = 6 + ((k * 7 + fs.index * 3) % 5)
      for (const h of [0.5, 11.5, 12.5, 23.5]) rows.push({ ts: at(day, h), site: (k + h) % 2 ? 'bestsudoku-web' : 'bestsudoku-app', path, n })
      rows.push({ ts: at(day, 9), site: 'other-site', path, n: 2 })
      rows.push({ ts: at(day, 10), site: 'bestsudoku-web', path, browser: 'Chrome', os: 'Windows', n: 3 })
      rows.push({ ts: at(day, 13), site: 'bestsudoku-web', path, campaign: 'manual_check', n: 1 })
    }
  }
  for (const k of [1, 2, 9]) {
    rows.push({ ts: at(addDays(TODAY, -k), 8), site: 'bestsudoku-web', path: '/coach/shown/unknown-tip', n: 5 })
    rows.push({ ts: at(addDays(TODAY, -k), 8), site: 'bestsudoku-web', path: '/coach/shown/placex', n: 5 })
    rows.push({ ts: at(addDays(TODAY, -k), 8), site: 'bestsudoku-web', path: '/coach/dismissed/hint\u0000', n: 5 })
  }
  insertHits(db, rows)
}

let db: DatabaseSync
const closeDb = () => { try { db?.close() } catch { /* already closed */ } }
let d1: ReturnType<typeof sqliteD1>
function open(opts?: { onlyHidden?: boolean; empty?: boolean }) {
  closeDb()
  db = openHitsDb()
  d1 = sqliteD1(db)
  if (!opts?.empty) seed(db, opts)
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  open()
  ;(globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } }
})
afterEach(() => {
  vi.useRealTimers()
  closeDb()
  delete (globalThis as any).caches
})

async function oldModel(body: Record<string, unknown>) {
  const { onRequestPost } = await import('./features')
  const res = await onRequestPost(pagesContext(postJson('/api/features', { ...body, view: 'coach-tips' }), { gss_geo: d1 }) as any)
  expect(res.status).toBe(200)
  return (await res.json()) as any
}

// The coach-tips preset's own requests: every tip x shown / dismissed / closed x the three windows (count and ratio), the
// "Show me around" total, and everSeen. (The preset shows the latest day and the range; the day before is compared too.)
type Req = { key: string; metric: string; window: string; params: { feature?: string; step?: string } }
function presetRequests(): Req[] {
  const out: Req[] = []
  const add = (metric: string, window: string, params: Req['params']) => out.push({ key: `k${out.length}`, metric, window, params })
  for (const f of COACH_TIP_ROWS) for (const s of f.steps) for (const w of ['latestDay', 'previousDay', 'page']) {
    add('feature.step', w, { feature: f.id, step: s.id })
    add('feature.stepRatio', w, { feature: f.id, step: s.id })
  }
  for (const w of ['latestDay', 'previousDay', 'page']) add('feature.total', w, { feature: 'tour-opened' })
  add('coach.everSeen', 'page', {})
  return out
}
async function cardValues(body: Record<string, unknown>) {
  const { onRequestPost } = await import('./metrics')
  const requests = presetRequests()
  const context = { since: body.since, until: body.until, sites: body.sites ?? [], ...(body.excludeOwnVisits ? { excludeOwnVisits: true, ownBrowser: body.ownBrowser, ownOS: body.ownOS } : {}) }
  const waited: Promise<unknown>[] = []
  const before = d1.statements.length
  const res = await onRequestPost(pagesContext(postJson('/api/metrics', { v: 1, context, requests }), { gss_geo: d1 }, waited) as any)
  await Promise.all(waited)
  const json = (await res.json()) as any
  return { status: res.status, error: json.error as string | undefined, requests, results: json.results as Record<string, { status: string; value?: number | null; noteIds?: string[] }>, statements: d1.statements.slice(before) }
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
  ]
}
// The card hides known traffic always (lib/defaults.ts coachTipsCardFor maps only a widget that hides it).
const TOGGLES = [
  { excludeKnownTraffic: true },
  { excludeKnownTraffic: true, sites: ['bestsudoku-web'] },
  { excludeKnownTraffic: true, sites: [...BEST_SUDOKU_SITES] },
  { excludeKnownTraffic: true, excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows' },
]
const WIN = { latestDay: 'latest', previousDay: 'prev', page: 'range' } as const

async function compare(body: Record<string, unknown>): Promise<number> {
  const got = await cardValues(body)
  expect(got.status, `${JSON.stringify(body)} ${got.error}`).toBe(200)
  const old = await oldModel(body)
  let n = 0
  for (const r of got.requests) {
    const v = got.results[r.key]
    const label = `${JSON.stringify(body)} ${r.metric} ${r.window} ${r.params.feature ?? ''} ${r.params.step ?? ''}`
    if (r.metric === 'coach.everSeen') {
      expect(v.status, label).toBe(old.everSeen ? 'ok' : 'no-data')
      n++
      continue
    }
    const f = old.features.find((x: any) => x.id === r.params.feature)
    const s = r.params.step ? f.steps.find((x: any) => x.id === r.params.step) : undefined
    const wk = WIN[r.window as keyof typeof WIN]
    const want = r.metric === 'feature.total' ? f[wk] : r.metric === 'feature.step' ? s[wk] : (s.ratio?.[wk] ?? null)
    expect(v?.status, label).toBe(want === null ? 'no-data' : 'ok')
    expect(v?.value ?? null, label).toEqual(want)
    n++
  }
  return n
}

describe('the coach-tips preset (POST /api/metrics) == /api/features { view: coach-tips }', () => {
  for (const now of NOWS) {
    it(`every number of the old table, every window and known-traffic-hidden filter at ${now}`, async () => {
      vi.setSystemTime(new Date(now))
      let compared = 0
      for (const w of WINDOWS(now)) for (const t of TOGGLES) compared += await compare({ ...w, ...t })
      expect(compared).toBe(WINDOWS(now).length * TOGGLES.length * presetRequests().length)
    }, 120_000)
  }

  it('everSeen false: no coach row ever, or only manual checks and decoys (the old "no coach data yet" note)', async () => {
    vi.setSystemTime(new Date(NOWS[1]))
    for (const opts of [{ empty: true }, { onlyHidden: true }]) {
      open(opts)
      const body = { since: addDays(TODAY, -29), until: TODAY, excludeKnownTraffic: true }
      expect((await oldModel(body)).everSeen).toBe(false)
      const got = await cardValues(body)
      expect(got.results[got.requests.at(-1)!.key].status).toBe('no-data')
      await compare(body)
    }
  })

  it('everSeen is about the beacons, not the selection: rows on another site only still count', async () => {
    vi.setSystemTime(new Date(NOWS[1]))
    open({ empty: true })
    insertHits(db, [{ ts: at(addDays(TODAY, -40), 9), site: 'other-site', path: '/coach/shown/place' }])
    const body = { since: addDays(TODAY, -6), until: TODAY, excludeKnownTraffic: true, sites: ['bestsudoku-web'] }
    expect((await oldModel(body)).everSeen).toBe(true)
    await compare(body)
  })

  it('load: the whole card is ONE POST and two statements (the featureDays read over the tips, and the ever count), as the old card', async () => {
    vi.setSystemTime(new Date(NOWS[1]))
    expect(presetRequests().length).toBeLessThanOrEqual(200)
    const got = await cardValues({ since: addDays(TODAY, -29), until: TODAY, excludeKnownTraffic: true })
    expect(got.statements).toHaveLength(2)
  })
})

describe('counts only', () => {
  it('featureDays over the tips: COUNT(*) per ET day and path; the ever read: one whole COUNT(*); no visitor, hour, place or device column, no JOIN', () => {
    const days = FACTS.featureDays.build({ since: addDays(TODAY, -6), until: TODAY, sites: [], todayEt: TODAY, set: 'coach-tips' }, Date.now())
    expect(days.sql).toMatch(/ END AS d, path, COUNT\(\*\) AS n FROM hits .* GROUP BY d, path ORDER BY d$/)
    for (const p of flatSteps(COACH_TIP_FEATURES).map((f) => f.step.match.exact![0])) expect(days.sql).toContain(`'${p}'`) // the validated tip paths, as literals
    const ever = FACTS.coachEver.build({ todayEt: TODAY }, Date.now())
    expect(ever.sql).toMatch(/^SELECT COUNT\(\*\) AS n FROM hits WHERE ts < \? AND /)
    expect(ever.sql).not.toMatch(/GROUP BY/)
    expect(ever.binds[0]).toBe(etWallTimeMs(addDays(TODAY, 1)))
    for (const sql of [days.sql, ever.sql]) {
      expect(sql).not.toMatch(/\bJOIN\b/i)
      const select = sql.slice(0, sql.indexOf(' FROM hits '))
      for (const col of ['visitor', 'country', 'region', 'city', 'device', 'browser', 'os', 'colo', 'lat', 'lon', 'postal', 'timezone', 'hour']) {
        expect(select).not.toMatch(new RegExp(`\\b${col}\\b`))
      }
    }
  })

  it('the preset reads only feature.* counts and ratios and coach.everSeen', () => {
    const metrics = COACH_TIPS.sections.flatMap((s) => s.items).map((i) => (i.data as any).metric).filter(Boolean)
    expect([...new Set(metrics)].sort()).toEqual(['coach.everSeen', 'feature.step', 'feature.stepRatio', 'feature.total'])
  })
})
