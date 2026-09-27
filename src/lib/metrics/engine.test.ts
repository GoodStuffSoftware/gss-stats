// The engine's per-batch work (review finding #8): facts arrive aggregated by SQL, every possible
// request side is served by its fact's static cuts, identical requests share one result, and
// deltas are finite or absent.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { buildFact, deriveBatch, factCuts, newSideMemo, planBatch, type FactResult } from './engine'
import { FACTS, type FactId } from './facts'
import { METRIC_DEFS, metricWindows } from './metrics'
import { RATIO_DEFS, ratioParamsOf, ratioWindowsOf } from './ratios'
import { MAX_REQUESTS, validateMetricsRequest } from './validate'
import { prewarm, prewarmChunks, prewarmRequests } from './prewarm'
import { CAMPAIGNS } from '../campaigns'
import { POPUPS } from '../popupEvents'
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
        : paths.flatMap((path, i) => [0, 1, 2, 3, 4, 5, 6, 7].map((d) => ({ path, visitor: (i + d) % 2 ? 'new' : 'returning', campaign: CAMPAIGNS[(i + d) % 3].ucValues[0], d, s: (i + d) % (factCuts(f.id).length + 1), pf: d % 2, c: 1 + i })))
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
      const env = { context: batch.context, nowMs: NOW, todayEt: TODAY, hasAdsDb: true }
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
    const bound = 8 * (factCuts('bskKpiDays').length + 1) * paths.length * 2 // days × segments × paths × visitor kinds
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

describe('deltas are finite or absent (JSON has no Infinity/NaN; both would arrive as null)', () => {
  function kpi(rows: { d: number; c: number }[]) {
    const batch = validateMetricsRequest(JSON.stringify({ v: 1, requests: [{ key: 'a', metric: 'bsk.pageviews', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] }] }))
    if (!batch.ok) throw new Error(batch.error)
    const env = { context: batch.context, nowMs: NOW, todayEt: TODAY, hasAdsDb: false }
    const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env)
    const facts = new Map<string, FactResult>([[plan.facts[0].key, { ok: true, rows: FACTS.bskKpiDays.parse(rows.map((r) => ({ path: '/', visitor: 'new', campaign: '', s: 0, ...r }))), asOfMs: NOW }]])
    // A real JSON round trip, exactly what the client receives.
    return JSON.parse(JSON.stringify(deriveBatch(batch.requests, { ...env, facts }))).a
  }
  it('against a zero day: the delta, and no percentage key at all (not null)', () => {
    const a = kpi([{ d: 0, c: 12 }])
    expect(a.deltas.yesterday).toEqual({ delta: 12 })
    expect('deltaPct' in a.deltas.yesterday).toBe(false)
    expect(a.deltas.avg7).toEqual({ delta: 12 })
  })
  it('an ordinary comparison keeps both numbers', () => {
    const a = kpi([
      { d: 0, c: 12 },
      { d: 1, c: 6 },
      { d: 3, c: 7 },
    ])
    expect(a.deltas.yesterday).toEqual({ delta: 6, deltaPct: 1 })
    expect(a.deltas.avg7).toEqual({ delta: 12 - 13 / 7, deltaPct: (12 - 13 / 7) / (13 / 7) })
  })
  it('a non-finite count yields an error status, never a null value or delta', () => {
    const inf = kpi([
      { d: 0, c: Number.POSITIVE_INFINITY },
      { d: 1, c: 3 },
    ])
    expect(inf).toEqual({ status: 'error', reason: 'non-finite' })
    const nan = kpi([
      { d: 0, c: 4 },
      { d: 1, c: Number.NaN },
    ])
    // A NaN count parses as 0 (lib/metrics/facts.ts), so the comparison is against zero.
    expect(nan.deltas.yesterday).toEqual({ delta: 4 })
    expect(JSON.stringify(inf) + JSON.stringify(nan)).not.toMatch(/null/)
  })
})
