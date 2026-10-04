// The engine's per-batch work (review finding #8): facts arrive aggregated by SQL, every possible
// request side is served by its fact's static cuts, identical requests share one result, and
// deltas are finite or absent.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { buildFact, deriveBatch, factCuts, newSideMemo, planBatch, releaseWindowsFor, type FactResult } from './engine'
import { releaseSubjectOn } from '../releases'
import { etMidnightMs } from './instrumentation'
import { FACTS, releaseSidesMs, type FactId } from './facts'
import { METRIC_DEFS, METRICS, metricWindows } from './metrics'
import { RATIO_DEFS, ratioParamsOf, ratioWindowsOf } from './ratios'
import { MAX_REQUESTS, validateMetricsRequest } from './validate'
import { prewarm, prewarmChunks, prewarmRequests } from './prewarm'
import { CAMPAIGNS } from '../campaigns'
import { POPUPS } from '../popupEvents'
import { isSplitRefusedPath } from '../splitGuard'
import { REFUSED_PATH_VOCABULARY } from '../__fixtures__/refusedPaths'
import type { MetricRequest } from './types'

const NOW = Date.parse('2026-09-26T21:00:00Z')
const TODAY = '2026-09-26'
const CONTEXT = { since: '2026-09-20', until: '2026-09-26', sites: ['bestsudoku-web'] }

/** Every metric and ratio, in every window, for every campaign and pop-up it takes. */
function everyRequest(): MetricRequest[] {
  const out: MetricRequest[] = []
  const add = (base: { metric?: string; ratio?: string }, params: string[], windows: string[]) => {
    const campaigns = params.includes('campaignId') ? CAMPAIGNS.map((c) => c.id) : [undefined]
    const popups = params.includes('popup') ? POPUPS.map((p) => p.id) : [undefined]
    for (const window of windows)
      for (const campaignId of campaigns)
        for (const popup of popups) out.push({ ...base, key: `r${out.length}`, window, params: { ...(campaignId ? { campaignId } : {}), ...(popup ? { popup } : {}) } })
  }
  for (const d of METRIC_DEFS) add({ metric: d.id }, d.params, metricWindows(d))
  for (const r of RATIO_DEFS) add({ ratio: r.id }, ratioParamsOf(r), ratioWindowsOf(r))
  return out
}

/** Synthetic facts: a few rows per planned fact, spread over every day and segment. */
function syntheticFacts(plan: ReturnType<typeof planBatch>): Map<string, FactResult> {
  const facts = new Map<string, FactResult>()
  const paths = ['/', '/game', '/game/complete/normal/easy', '/signin-prompt/placement', '/signin-prompt/accept', '/install/prompt/android', '/popup-outcome/install-prompt/installed', '/popup-outcome/upsell/returned', '/upsell/shown/limit', '/auth/success/google', '/signin-eligible/earned', '/return/sudoku_tired_of_ads/d0', '/return/sudoku_tired_of_ads/d2-7', '/return/sudoku_funnel_retest/d0']
  for (const f of plan.facts) {
    const raw =
      f.id === 'adsSpend'
        ? [{ campaign_id: CAMPAIGNS[0].id, cost_micros: 5_000_000, days: 2 }]
        : f.id === 'adsPlayDaily'
          ? [{ date: '2026-09-22', device_installs: 4, user_installs: 3, device_uninstalls: 1, active_device_installs: 40 }]
          : paths.flatMap((path, i) => [0, 1, 2, 3, 4, 5, 6, 7].map((d) => ({ path, visitor: (i + d) % 2 ? 'new' : 'returning', campaign: CAMPAIGNS[(i + d) % 3].ucValues[0], d, t: d > 0 && !isSplitRefusedPath(path) ? (i + d) % 2 : 0, s: (i + d) % (factCuts(f.id).length + 1), pf: d % 2, c: 1 + i })))
    facts.set(f.key, { ok: true, rows: FACTS[f.id].parse(raw), asOfMs: NOW })
  }
  return facts
}

describe('every request side is served by its fact', () => {
  it('no metric or ratio, in any window, for any campaign or pop-up, fails to derive', () => {
    const requests = everyRequest()
    expect(requests.length).toBeGreaterThan(150)
    for (let i = 0; i < requests.length; i += 200) {
      const batch = validateMetricsRequest(JSON.stringify({ v: 1, context: CONTEXT, requests: requests.slice(i, i + 200) }))
      if (!batch.ok) throw new Error(batch.error)
      expect(batch.requests.filter((r) => !r.ok)).toEqual([])
      // A release window two days either side of 2026-09-24, so the release sides derive too.
      const env = { context: batch.context, nowMs: NOW, todayEt: TODAY, hasAdsDb: true, release: { dateEt: '2026-09-24', days: 2, ...releaseSidesMs('2026-09-24', 2) } }
      const memo = newSideMemo()
      const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env, memo)
      const results = deriveBatch(batch.requests, { ...env, facts: syntheticFacts(plan) }, memo)
      const failed = Object.entries(results).filter(([, v]) => v.status === 'error')
      expect(failed).toEqual([])
    }
  })
  it('a timed fact has cuts; an untimed one has none', () => {
    for (const id of Object.keys(FACTS) as FactId[]) {
      if (FACTS[id].bucketMs === null) expect(factCuts(id)).toEqual([])
      else expect(factCuts(id).length).toBeGreaterThan(0)
    }
  })
  it('prewarm runs the whole path and reports success (it swallows errors, so the flag is the check)', () => {
    let ok: boolean | undefined
    expect(() => (ok = prewarm())).not.toThrow()
    expect(ok).toBe(true)
  })
  it('prewarm warms every registry request in chunks of at most MAX_REQUESTS — none truncated', () => {
    const all = prewarmRequests()
    const chunks = prewarmChunks()
    expect(chunks.flat()).toEqual(all)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_REQUESTS)
    // Every request is one the endpoint accepts (a refused one would make prewarm() false).
    for (const c of chunks) {
      const b = validateMetricsRequest(JSON.stringify({ v: 1, context: { since: '2026-09-20', until: '2026-09-26', sites: ['bestsudoku-web'] }, requests: c }))
      expect(b.ok && b.requests.every((r) => r.ok)).toBe(true)
    }
  })
})

describe('a fact does not grow with traffic', () => {
  it('bskKpiDays returns one row per (day, segment, path, visitor, tag), however many hits', () => {
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE TABLE hits (id INTEGER PRIMARY KEY, ts INTEGER, site TEXT DEFAULT 'bestsudoku-web', path TEXT DEFAULT '/', referrer TEXT DEFAULT '', region TEXT DEFAULT '', city TEXT DEFAULT '', org TEXT DEFAULT '', device TEXT DEFAULT '', browser TEXT DEFAULT '', os TEXT DEFAULT '', screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', medium TEXT DEFAULT '', campaign TEXT DEFAULT '')")
    const ins = db.prepare('INSERT INTO hits (ts, path, visitor) VALUES (?, ?, ?)')
    const start = Date.parse('2026-09-18T05:00:00Z')
    const paths = ['/', '/game', '/stats']
    const count = (n: number) => {
      db.exec('DELETE FROM hits')
      for (let i = 0; i < n; i++) ins.run(start + Math.floor(((NOW - start) * i) / n), paths[i % 3], i % 2 ? 'new' : 'returning')
      const stmt = buildFact({ id: 'bskKpiDays', params: { todayEt: TODAY } }, NOW)
      return db.prepare(stmt.sql).all(...(stmt.binds as number[])).length
    }
    const bound = 8 * 2 * (factCuts('bskKpiDays').length + 1) * paths.length * 2 // days × same-time flag × segments × paths × visitor kinds
    const small = count(2_000)
    const large = count(40_000)
    expect(small).toBeLessThanOrEqual(bound)
    expect(large).toBeLessThanOrEqual(bound) // 20x the hits, still within the same small bound
    expect(large).toBeLessThan(small * 1.5)
  })
})

describe('identical requests share one derivation', () => {
  it('200 requests naming five metrics plan one fact and return equal results per metric', () => {
    const ids = ['bsk.pageviews', 'bsk.gameViews', 'bsk.popupShown', 'bsk.authSuccess', 'bsk.returnsD1plus']
    const requests = Array.from({ length: 200 }, (_, i) => ({ key: `w${i}`, metric: ids[i % 5], window: 'todaySoFar', deltas: ['yesterday', 'avg7'] }))
    const batch = validateMetricsRequest(JSON.stringify({ v: 1, requests }))
    if (!batch.ok) throw new Error(batch.error)
    const env = { context: batch.context, nowMs: NOW, todayEt: TODAY, hasAdsDb: false }
    const memo = newSideMemo()
    const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env, memo)
    expect(plan.facts.map((f) => f.id)).toEqual(['bskKpiDays'])
    expect(memo.size).toBe(5)
    const results = deriveBatch(batch.requests, { ...env, facts: syntheticFacts(plan) }, memo)
    expect(results.w0).toBe(results.w5) // the same object: derived once
    expect(results.w0).toEqual(results.w195)
  })
})

describe('KPI comparison: refused-row metrics get whole-day context, opt-outs keep same-time deltas; all finite or absent', () => {
  // JSON has no Infinity/NaN; both would arrive as null. Rows carry the fact's own columns: d is the
  // whole ET day, t the same-time flag (1 only on a non-refused row before today's clock time).
  type Row = { d: number; c: number; t?: number; path?: string }
  // `late` moves the clock past the tour-tracking go-live and all of its 8 days, for the tutorial metric.
  function kpi(rows: Row[], metric = 'bsk.pageviews', deltas: string[] = ['yesterday', 'avg7'], late = metric === 'bsk.tutorialFirstRun') {
    const now = late ? Date.parse('2026-10-12T16:00:00Z') : NOW
    const today = late ? '2026-10-12' : TODAY
    const batch = validateMetricsRequest(JSON.stringify({ v: 1, requests: [{ key: 'a', metric, window: 'todaySoFar', deltas }] }))
    if (!batch.ok) throw new Error(batch.error)
    const env = { context: batch.context, nowMs: now, todayEt: today, hasAdsDb: false }
    const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env)
    const facts = new Map<string, FactResult>([[plan.facts[0].key, { ok: true, rows: FACTS.bskKpiDays.parse(rows.map((r) => ({ path: '/', visitor: 'new', campaign: '', s: 0, t: 0, ...r }))), asOfMs: now }]])
    // A real JSON round trip, exactly what the client receives.
    return JSON.parse(JSON.stringify(deriveBatch(batch.requests, { ...env, facts }))).a
  }

  // A metric that can still count a refused row: first-run tutorial completions (its rows are refused beacons).
  const REFUSED_METRIC = 'bsk.tutorialFirstRun'
  const DONE = '/game/tutorial-complete/first-run'
  it('a refused-row metric (bsk.tutorialFirstRun) gets whole-day yesterday and 7-day average, and no deltas', () => {
    const a = kpi(
      [
        { d: 0, c: 12, path: DONE },
        { d: 1, c: 4, t: 1, path: DONE }, // the flag never splits a refused-row metric: both halves of the day count
        { d: 1, c: 2, t: 0, path: DONE },
        { d: 3, c: 7, path: DONE },
      ],
      REFUSED_METRIC,
    )
    expect(a.value).toBe(12)
    expect('deltas' in a).toBe(false)
    expect(a.wholeDays).toEqual({ yesterday: 6, avg7: 13 / 7 })
  })
  it('wholeDays follows the requested comparisons', () => {
    const rows = [
      { d: 0, c: 12, path: DONE },
      { d: 1, c: 6, path: DONE },
    ]
    expect(kpi(rows, REFUSED_METRIC, ['yesterday']).wholeDays).toEqual({ yesterday: 6 })
    expect(kpi(rows, REFUSED_METRIC, ['avg7']).wholeDays).toEqual({ avg7: 6 / 7 })
    expect('wholeDays' in kpi(rows, REFUSED_METRIC, [])).toBe(false)
  })
  it('empty days: zero whole-day context (a number, never null), and no deltas', () => {
    for (const rows of [[], [{ d: 0, c: 12, path: DONE }]]) {
      const a = kpi(rows, REFUSED_METRIC)
      expect('deltas' in a).toBe(false)
      expect(a.wholeDays).toEqual({ yesterday: 0, avg7: 0 })
    }
  })
  it('Page views leaves every refused row out of its count, so it keeps same-time deltas (0.27.3)', () => {
    const def = METRICS.get('bsk.pageviews')!
    expect(def.countsRefused).toBe(false)
    for (const p of REFUSED_PATH_VOCABULARY) expect(def.path!(p, { params: {}, window: 'todaySoFar' }), p).toBe(false)
    expect(def.path!('/', { params: {}, window: 'todaySoFar' })).toBe(true)
    // Refused rows (any t) add nothing to today or to a day's same-time window; plain rows do.
    const a = kpi([
      { d: 0, c: 12 },
      { d: 0, c: 99, path: '/game/start/easy' },
      { d: 0, c: 99, path: '/TOUR/SKIP/x' },
      { d: 1, c: 6, t: 1 },
      { d: 1, c: 100, t: 0 }, // later in the day than now: not compared
      { d: 1, c: 50, t: 0, path: '/tour/exit-at/3' },
      { d: 3, c: 7, t: 1 },
    ])
    expect(a.value).toBe(12)
    expect(a.deltas.yesterday).toEqual({ delta: 6, deltaPct: 1 })
    expect(a.deltas.avg7).toEqual({ delta: 12 - 13 / 7, deltaPct: (12 - 13 / 7) / (13 / 7) })
    expect('wholeDays' in a).toBe(false)
  })
  it('an opt-out metric (bsk.gameViews) sums only the same-time rows for earlier days: its deltas are unchanged', () => {
    // The old fact returned, for each earlier day, only the rows inside its same-time window. The
    // new one returns the whole day with those rows flagged t = 1; the deltas must be the same.
    const before = kpi(
      [
        { d: 0, c: 12, path: '/game' },
        { d: 1, c: 6, path: '/game', t: 1 },
        { d: 3, c: 7, path: '/game', t: 1 },
      ],
      'bsk.gameViews',
    )
    const after = kpi(
      [
        { d: 0, c: 12, path: '/game' },
        { d: 1, c: 6, path: '/game', t: 1 },
        { d: 1, c: 100, path: '/game', t: 0 }, // later in the day than now: not compared
        { d: 3, c: 7, path: '/game', t: 1 },
        { d: 5, c: 50, path: '/game', t: 0 },
      ],
      'bsk.gameViews',
    )
    expect(after.value).toBe(12)
    expect(after.deltas.yesterday).toEqual({ delta: 6, deltaPct: 1 })
    expect(after.deltas.avg7).toEqual({ delta: 12 - 13 / 7, deltaPct: (12 - 13 / 7) / (13 / 7) })
    expect(after).toEqual(before)
    expect('wholeDays' in after).toBe(false)
  })
  it('against a zero day an opt-out delta has no percentage key at all (not null)', () => {
    const a = kpi([{ d: 0, c: 12, path: '/game' }], 'bsk.gameViews')
    expect(a.deltas.yesterday).toEqual({ delta: 12 })
    expect('deltaPct' in a.deltas.yesterday).toBe(false)
    expect(a.deltas.avg7).toEqual({ delta: 12 })
  })
  it('a non-finite count yields an error status, never a null value, delta or whole-day number', () => {
    const inf = kpi(
      [
        { d: 0, c: Number.POSITIVE_INFINITY, path: DONE },
        { d: 1, c: 3, path: DONE },
      ],
      REFUSED_METRIC,
    )
    expect(inf).toEqual({ status: 'error', reason: 'non-finite' })
    const nan = kpi(
      [
        { d: 0, c: 4, path: DONE },
        { d: 1, c: Number.NaN, path: DONE },
      ],
      REFUSED_METRIC,
    )
    // A NaN count parses as 0 (lib/metrics/facts.ts), so yesterday is zero.
    expect(nan.wholeDays).toEqual({ yesterday: 0, avg7: 0 })
    const nanOptOut = kpi(
      [
        { d: 0, c: 4, path: '/game' },
        { d: 1, c: Number.NaN, path: '/game', t: 1 },
      ],
      'bsk.gameViews',
    )
    expect(nanOptOut.deltas.yesterday).toEqual({ delta: 4 })
    expect(JSON.stringify(inf) + JSON.stringify(nan) + JSON.stringify(nanOptOut)).not.toMatch(/null/)
  })
})

describe('releaseWindowsFor', () => {
  const FIRST_HIT = Date.parse('2026-07-13T12:00:00Z')
  const addDaysEt = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
  it('on a release day compares the older release; its after window starts the ET midnight after its date', () => {
    const w = releaseWindowsFor(FIRST_HIT, Date.parse('2026-10-03T16:00:00Z'))
    expect(w).not.toBeNull()
    expect(w!.dateEt).toBe(releaseSubjectOn('2026-10-03')!.dateEt)
    expect(w!.dateEt < '2026-10-02').toBe(true)
    expect(w!.after[0]).toBe(etMidnightMs(addDaysEt(w!.dateEt, 1)))
    expect(w!.before[1]).toBe(etMidnightMs(w!.dateEt))
  })
  it('a release dated 10-02 is the subject on 10-04 with an after window starting 10-03', () => {
    const w = releaseWindowsFor(FIRST_HIT, Date.parse('2026-10-04T16:00:00Z'))
    expect(w).toMatchObject({ dateEt: '2026-10-02', days: 1 })
    expect(w!.after[0]).toBe(etMidnightMs('2026-10-03'))
  })
})
