// Runs the whole POST /api/metrics derivation path once over synthetic facts, so the JS engine
// compiles it while the isolate starts (functions/api/metrics.ts calls this at module scope)
// instead of during the first real request. Workers Free allows 10 ms of CPU per request, and a
// cold first request spent more than half of that compiling the validator, planner, fact
// builders, path classifiers and derivation (docs/capacity.md §7); isolate start-up has its own,
// much larger limit.
//
// Pure and self-contained: fixed instants, no I/O, no clock, no randomness, and every value it
// computes is thrown away. It never throws (a failure only means the first request compiles).

import { CAMPAIGNS } from '../campaigns'
import { POPUPS } from '../popupEvents'
import { etDateFast } from '../etTime'
import { buildFact, deriveBatch, planBatch, type FactResult } from './engine'
import { FACTS } from './facts'
import { METRIC_DEFS, metricWindows } from './metrics'
import { RATIO_DEFS, ratioParamsOf, ratioWindowsOf } from './ratios'
import { validateMetricsRequest } from './validate'
import type { MetricRequest } from './types'

const NOW = Date.UTC(2026, 8, 26, 21) // any fixed instant works; this one is inside every go-live
const SAMPLE_PATHS = [
  '/',
  '/game',
  '/game/complete/normal/easy',
  '/signin-prompt/placement',
  '/signin-prompt/accept',
  '/promo-first50/shown',
  '/upsell/shown/limit',
  '/upsell/accept/limit',
  '/install/prompt/android',
  '/install/pwa-installed',
  '/popup-outcome/install-prompt/installed',
  '/popup-outcome/signin-prompt/signed-in',
  '/popup-outcome/upsell/returned',
  '/signin-eligible/earned',
  '/auth/success/google',
  ...CAMPAIGNS.flatMap((c) => [`/return/${c.ucValues[0]}/d0`, `/return/${c.ucValues[0]}/d2-7`]),
]

export function prewarm(): void {
  try {
    const requests: MetricRequest[] = []
    const add = (base: Omit<MetricRequest, 'key' | 'params'>, params: string[], windows: string[]) => {
      const campaigns = params.includes('campaignId') ? CAMPAIGNS.map((c) => c.id) : [undefined]
      const popups = params.includes('popup') ? POPUPS.map((p) => p.id).slice(0, 2) : [undefined]
      for (const window of windows) {
        for (const campaignId of campaigns) {
          for (const popup of popups) {
            requests.push({ ...base, key: `w${requests.length}`, window, params: { ...(campaignId ? { campaignId } : {}), ...(popup ? { popup } : {}) }, ...(window === 'todaySoFar' && base.metric ? { deltas: ['yesterday', 'avg7'] } : {}) })
          }
        }
      }
    }
    for (const d of METRIC_DEFS) add({ metric: d.id }, d.params, metricWindows(d))
    for (const r of RATIO_DEFS) add({ ratio: r.id }, ratioParamsOf(r), ratioWindowsOf(r))
    const batch = validateMetricsRequest(JSON.stringify({ v: 1, context: { since: '2026-09-20', until: '2026-09-26', sites: ['bestsudoku-web'] }, requests: requests.slice(0, 200) }))
    if (!batch.ok) return
    const env = { context: batch.context, nowMs: NOW, todayEt: etDateFast(NOW), hasAdsDb: true }
    const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env)
    const facts = new Map<string, FactResult>()
    for (const f of plan.facts) {
      buildFact(f, NOW)
      const raw =
        f.id === 'adsSpend'
          ? CAMPAIGNS.map((c) => ({ campaign_id: c.id, cost_micros: 1_000_000, days: 1, first_date: '2026-09-20', last_date: '2026-09-20', fetched_at: '2026-09-20T12:00:00Z' }))
          : SAMPLE_PATHS.map((path, i) => ({ path, visitor: i % 2 ? 'new' : 'returning', campaign: CAMPAIGNS[i % CAMPAIGNS.length].ucValues[0], d: i % 8, s: i % 3, pf: i % 2, c: i + 1 }))
      facts.set(f.key, { ok: true, rows: FACTS[f.id].parse(raw), asOfMs: NOW })
    }
    JSON.stringify(deriveBatch(batch.requests, { ...env, facts }))
  } catch {
    // Compiling on the first request instead is only slower, never wrong.
  }
}
