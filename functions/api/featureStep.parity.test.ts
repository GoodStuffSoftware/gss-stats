// Parity: the Features page's step charts before T1 (one shared /api/features model, drawn by featureHealthChart.ts
// buildStepChartConfig) and after (the ordinary geo date line, lib/defaults.ts featureStepWidget, fetched by api.ts
// fetchSeriesStats and drawn by charts.ts buildSeriesLineConfig). Both REAL handlers run on one real SQLite (node:sqlite,
// D1's dialect) behind a fetch stub, so the client's own request bodies are what reach them. Made-up rows only.
//
// Compared for all 14 step charts (fw-funnel included), many windows, both "now" sides of ET noon, and the page toggles:
//   - per step, per ET day: the old model's count equals the new series' count (a day with no row is 0);
//   - the new series counts no day the old model does not have (today before noon ET above all);
//   - the drawn chart: the same series names, and the old axis and points from the first day any step has a row (the
//     generic series rule trims leading empty days; the old card drew them as 0, an intended difference).
// And the query load of one Features page: one /api/geo request and one D1 statement per step chart.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { onRequestPost as geoPost } from './geo'
import { onRequestPost as featuresPost } from './features'
import { fetchFeatureHealth, fetchSeriesStats, fetchStats } from '../../src/api'
import { defaultFeaturesWidgets, stepChartFor } from '../../src/lib/defaults'
import { FEATURES, flatSteps, stepsViewFor } from '../../src/lib/featureHealth'
import { buildStepChartConfig } from '../../src/lib/featureHealthChart'
import { buildSeriesLineConfig } from '../../src/lib/charts'
import { addDays, etWallTimeMs } from '../../src/lib/etTime'
import { BEST_SUDOKU_SITES } from '../../src/lib/bestSudokuSites'
import type { GlobalFilters, StatsResponse, Widget } from '../../src/types'
import { insertHits, installCaches, memoryCache, openHitsDb, sqliteD1, type HitRow } from '../_lib/testing/hitsDb'

const FIRST_DAY = '2026-09-18'
const LAST_DAY = '2026-10-27' // "today" in every case below (EDT: ET midnight is 04:00Z)
const days: string[] = []
for (let d = FIRST_DAY; d <= LAST_DAY; d = addDays(d, 1)) days.push(d)

// Every configured path shape: each exact path, a child of each prefix and each excepted path; and decoys no step has.
const flat = flatSteps(FEATURES)
const STEP_PATHS = [...new Set(flat.flatMap((f) => [...(f.step.match.exact ?? []), ...(f.step.match.prefix ?? []).map((p) => `${p}a`), ...(f.step.match.except ?? [])]))]
const DECOYS = ['/', '/game/startx', '/coach/shown', '/game/complete-deferred/normal/easy', '/tour/skip\u0000x']
const TIMES = ['00:30', '11:30', '12:30', '23:30'] // ET wall times: both sides of noon and of midnight
const OWN = { browser: 'Opera', os: 'Windows' }
const PLACE = { country: 'US', region: 'Ohio', city: 'Columbus', device: 'mobile', os: 'Android', browser: 'Chrome', screenw: 390 }

let db: DatabaseSync
let undo: () => void
let sites: string[] = []
const requests: { url: string; body: any }[] = []

function seed() {
  const rows: (HitRow & { n: number })[] = []
  days.forEach((day, di) => {
    // A quiet start: no rows on the first five days, so the first-data-day trim is exercised.
    if (di < 5) return
    ;[...STEP_PATHS, ...DECOYS].forEach((path, pi) => {
      // Some step paths skip some days, so per-day zeros inside the range are exercised too.
      if ((di + pi) % 6 === 0) return
      const n = 1 + ((di * 7 + pi * 3) % 4)
      const ts = etWallTimeMs(day, TIMES[(di + pi) % TIMES.length])
      rows.push({ ts, site: 'bestsudoku-web', path, n, ...PLACE })
      rows.push({ ts: ts + 1000, site: 'bestsudoku-app', path, n: n + 1, ...PLACE })
      rows.push({ ts: ts + 2000, site: 'starrupture', path, n: 1, ...PLACE })
      if (pi % 5 === 0) {
        rows.push({ ts, site: 'bestsudoku-web', path, n: 2, ...PLACE, campaign: 'manual_check' }) // never counted
        rows.push({ ts, site: 'bestsudoku-web', path, n: 1, ...PLACE, medium: 'lifecycle' }) // known traffic
        rows.push({ ts, site: 'bestsudoku-app', path, n: 1, ...PLACE, region: 'North Carolina', screenw: 412 }) // known traffic
        rows.push({ ts, site: 'bestsudoku-web', path, n: 1, ...PLACE, ...OWN }) // the owner's own visits
        rows.push({ ts, site: 'bestsudoku-web', path, n: 1, ...PLACE, campaign: 'flight3' }) // a tagged row
      }
    })
  })
  insertHits(db, rows)
}

beforeEach(() => {
  db = openHitsDb()
  undo = installCaches(memoryCache())
  requests.length = 0
  sites = []
  const gss_geo = sqliteD1(db)
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    // The site list the page would resolve (src/sitesStore.ts needs the /api/sites tree): the same for both endpoints.
    const body = { ...JSON.parse(String(init?.body ?? '{}')), sites }
    requests.push({ url, body })
    const handler = url === '/api/geo' ? geoPost : url === '/api/features' ? featuresPost : null
    if (!handler) throw new Error(`unexpected fetch ${url}`)
    return handler({ request: { json: async () => body }, env: { gss_geo }, waitUntil: () => {} } as any)
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  ;(globalThis as any).__statements = gss_geo.statements
  seed()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  undo()
  db.close()
})

const statements = (): string[] => (globalThis as any).__statements
const stepCharts = (): Widget[] => defaultFeaturesWidgets().filter((w) => w.id.startsWith('fw-') && w.dataset === 'geo')
const legacy = (featureId: string, extra: Partial<Widget> = {}): Widget =>
  ({ id: `fw-${featureId}`, i: `fw-${featureId}`, title: featureId, type: 'line', dataset: 'features', view: stepsViewFor(featureId), dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: 0, y: 0, w: 6, h: 8, ...extra }) as Widget
const filtersFor = (since: string, until: string, extra: Partial<GlobalFilters> = {}): GlobalFilters =>
  ({ siteSel: [], drill: [], since, until, excludeSelfReferrals: true, excludeOwnVisits: false, ownBrowser: '', ownOS: '', ...extra }) as GlobalFilters

const at = (hhmmEt: string) => new Date(etWallTimeMs(LAST_DAY, hhmmEt))
const iso = (ms: number) => new Date(ms).toISOString()

interface Case {
  name: string
  now: Date
  since: string
  until: string
  known?: boolean
  sites?: string[]
  own?: boolean
}
function windows(nowLabel: string, now: Date): Case[] {
  const n = now.getTime()
  return [
    { name: `30d at ${nowLabel}`, now, since: iso(n - 30 * 86_400_000), until: iso(n) },
    { name: `7d at ${nowLabel}`, now, since: iso(n - 7 * 86_400_000), until: iso(n) },
    { name: `ET-aligned 10-01..10-15 at ${nowLabel}`, now, since: iso(etWallTimeMs('2026-10-01')), until: iso(etWallTimeMs('2026-10-16')) },
    { name: `sub-day 10-20 15:00..10-22 09:00 ET at ${nowLabel}`, now, since: iso(etWallTimeMs('2026-10-20', '15:00')), until: iso(etWallTimeMs('2026-10-22', '09:00')) },
    { name: `single ET day 10-10 at ${nowLabel}`, now, since: iso(etWallTimeMs('2026-10-10')), until: iso(etWallTimeMs('2026-10-11')) },
    { name: `bare dates 2026-10-01..2026-10-14 at ${nowLabel}`, now, since: '2026-10-01', until: '2026-10-14' },
    { name: `since before the first row at ${nowLabel}`, now, since: iso(etWallTimeMs('2026-09-01')), until: iso(n) },
  ]
}
const CASES: Case[] = [
  ...windows('10:00 ET', at('10:00')),
  ...windows('15:00 ET', at('15:00')),
  // The page toggles, on the 30-day range after noon.
  ...[true, false].flatMap((known) =>
    [[], ['bestsudoku-web'], BEST_SUDOKU_SITES].flatMap((s) =>
      [false, true].map((own): Case => ({ name: `30d at 15:00 ET, known traffic ${known ? 'hidden' : 'shown'}, sites [${s.join(',')}], own visits ${own ? 'hidden' : 'shown'}`, now: at('15:00'), since: iso(at('15:00').getTime() - 30 * 86_400_000), until: iso(at('15:00').getTime()), known, sites: s, own })),
    ),
  ),
]

const byDay = (r: StatsResponse) => new Map(r.rows.map((x) => [x.key.dateEt, x.pageviews]))

describe('step charts: the old Features card and the ordinary chart count the same', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      vi.setSystemTime(c.now)
      sites = c.sites ?? []
      const filters = filtersFor(c.since, c.until, c.own ? { excludeOwnVisits: true, ownBrowser: OWN.browser, ownOS: OWN.os } : {})
      const known = c.known ?? true
      const old = await fetchFeatureHealth(legacy('coach', { excludeKnownTraffic: known }), filters, true)
      let compared = 0
      for (const widget of stepCharts()) {
        const w = { ...widget, excludeKnownTraffic: known }
        const f = FEATURES.find((x) => `fw-${x.id}` === w.id)!
        const oldFeature = old.features.find((x) => x.id === f.id)!
        const series = await fetchSeriesStats(w, filters)
        expect(series).toHaveLength(f.steps.length)
        const oldDays = new Set(old.days)
        f.steps.forEach((s, i) => {
          const got = byDay(series[i])
          const want = oldFeature.steps[i]
          expect(want.id).toBe(s.id)
          // Per day: the same count; and no counted day outside the old axis.
          expect(old.days.map((d) => got.get(d) ?? 0), `${w.id} ${s.id}`).toEqual(want.perDay)
          for (const d of got.keys()) expect(oldDays.has(d!), `${w.id} ${s.id} counts ${d}, which the old card has not`).toBe(true)
          expect(series[i].totals.pageviews, `${w.id} ${s.id} total`).toBe(want.range)
          compared += want.range
        })
        // The drawn chart: the old one from its first day with a row.
        const before = buildStepChartConfig(old, oldFeature)
        const after = buildSeriesLineConfig(w, series)!
        const first = old.days.findIndex((_, di) => oldFeature.steps.some((s) => s.perDay[di] > 0))
        const from = first < 0 ? 0 : first
        expect(after.data.datasets.map((d) => d.label)).toEqual(before.data.datasets.map((d) => d.label))
        expect(after.data.labels, w.id).toEqual(before.data.labels!.slice(from))
        after.data.datasets.forEach((d, i) => expect(d.data, `${w.id} ${d.label}`).toEqual((before.data.datasets[i].data as number[]).slice(from)))
      }
      // A case that counted nothing would prove nothing (the single-day and bare-date ones still have rows).
      expect(compared, c.name).toBeGreaterThan(0)
    })
  }

  it('a saved (pre-T1) step chart, drawn through stepChartFor, reads the same as the new default', async () => {
    vi.setSystemTime(at('15:00'))
    const filters = filtersFor(iso(at('15:00').getTime() - 30 * 86_400_000), iso(at('15:00').getTime()))
    for (const f of FEATURES) {
      const mapped = stepChartFor(legacy(f.id))
      const fresh = stepCharts().find((w) => w.id === `fw-${f.id}`)!
      expect(await fetchSeriesStats(mapped, filters)).toEqual(await fetchSeriesStats(fresh, filters))
    }
  })
})

describe('step charts: the query load of one Features page', () => {
  it('one /api/geo request and one D1 statement per step chart (14), where one query per series was 44', async () => {
    vi.setSystemTime(at('15:00'))
    const filters = filtersFor(iso(at('15:00').getTime() - 30 * 86_400_000), iso(at('15:00').getTime()))
    const charts = stepCharts()
    expect(charts).toHaveLength(14)
    const seriesCount = charts.reduce((a, w) => a + (w.series?.length ?? 0), 0)
    expect(seriesCount).toBe(flat.length)

    // Now: one batched request per chart.
    requests.length = 0
    statements().length = 0
    const batched = await Promise.all(charts.map((w) => fetchSeriesStats(w, filters)))
    expect(requests.filter((r) => r.url === '/api/geo')).toHaveLength(14)
    expect(statements()).toHaveLength(14)

    // Leg 2's shape, one request per series (the per-series path every other series chart still takes), for the count.
    installCaches(memoryCache())
    requests.length = 0
    statements().length = 0
    const perSeries = await Promise.all(charts.map((w) => Promise.all((w.series ?? []).map((s) => fetchStats({ ...w, series: undefined }, filters, s.filter ?? [])))))
    expect(requests).toHaveLength(44)
    expect(statements()).toHaveLength(44)
    expect(batched).toEqual(perSeries)

    // Before T1: one shared /api/features request (two statements) drew all 14 charts.
    installCaches(memoryCache())
    statements().length = 0
    await fetchFeatureHealth(legacy('coach'), filters, true)
    expect(statements()).toHaveLength(2)
  })
})
