/// <reference types="@cloudflare/workers-types" />
//
// Runs the facts a /api/metrics batch planned (src/lib/metrics/engine.ts planBatch) and caches
// each one on its own (ADR 0003 section 3, step 4): the Workers Cache API (`caches.default`),
// never KV (Free-plan KV allows 1,000 writes/day). Caching is per fact, not per batch, so
// different batches and pages share entries — a closed campaign's rows are read from D1 at most
// once per colo per 15 minutes however many cards show them.
//
// The cache key is the fact id, its keyed params AND a hash of its SQL text, so a changed
// statement can never be answered from an entry an older build stored. `fresh` skips the lookup
// but still refreshes the entry. An error is never cached. Runs behind the auth gate
// (functions/_middleware.ts) like every /api/* route, so a hit never bypasses sign-in.

import { campaignById } from '../../src/lib/campaigns'
import { FACTS, type FactTtl } from '../../src/lib/metrics/facts'
import type { FactResult, Plan, PlannedFact } from '../../src/lib/metrics/engine'
import { buildCacheKeyUrl, ttlSecondsFor, type CacheLike } from './edgeCache'

export interface MetricFactsEnv {
  gss_geo: D1Database
  gss_stats_ads?: D1Database
}

export interface FetchOptions {
  nowMs: number
  fresh: boolean
  cache: CacheLike
  waitUntil: (p: Promise<unknown>) => void
}

export interface FetchedFacts {
  facts: Map<string, FactResult>
  cacheHits: number
  /** Statements actually sent to D1 (cache hits cost none). */
  statements: number
}

const LIVE_SECONDS = 90
const CLOSED_CAMPAIGN_SECONDS = 15 * 60

/** FNV-1a of the statement text: part of the cache key (see the header). */
function sqlHash(sql: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < sql.length; i++) {
    h ^= sql.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function factTtlSeconds(ttl: FactTtl, f: Pick<PlannedFact, 'params'>, now: Date): number {
  if (typeof ttl === 'object') return ttl.seconds
  if (ttl === 'range') return ttlSecondsFor(f.params.until ?? '', now)
  const campaign = f.params.campaignId ? campaignById(f.params.campaignId) : undefined
  if (!campaign) return LIVE_SECONDS
  if (ttl === 'campaign') return campaign.status === 'closed' ? CLOSED_CAMPAIGN_SECONDS : LIVE_SECONDS
  return ttlSecondsFor(campaign.flightEnd, now) // 'flightWindow': the serving window, as campaignInstrumentation.ts
}

export async function fetchFacts(plan: Plan, env: MetricFactsEnv, opts: FetchOptions): Promise<FetchedFacts> {
  let cacheHits = 0
  let statements = 0
  const facts = new Map<string, FactResult>()
  await Promise.all(
    plan.facts.map(async (f) => {
      const def = FACTS[f.id]
      const stmt = def.build(f.params, opts.nowMs)
      const db = stmt.db === 'gss_stats_ads' ? env.gss_stats_ads : env.gss_geo
      // The ads store is optional and read fail-soft, like lib/adsStore.ts readSpendSummaries:
      // absent or unreadable means "nothing stored", and spend falls back to CAMPAIGN_SPEND.
      const failSoft = stmt.db === 'gss_stats_ads'
      if (!db) {
        facts.set(f.key, failSoft ? { ok: true, rows: def.parse([]), asOfMs: opts.nowMs } : { ok: false, error: 'db-not-bound' })
        return
      }
      const key = new Request(buildCacheKeyUrl(`/fact/${f.id}`, { ...f.params, s: sqlHash(stmt.sql) }))
      if (!opts.fresh) {
        const hit = await opts.cache.match(key)
        if (hit) {
          const cached = (await hit.json()) as { asOfMs: number; raw: Record<string, unknown>[] }
          facts.set(f.key, { ok: true, rows: def.parse(cached.raw), asOfMs: cached.asOfMs })
          cacheHits++
          return
        }
      }
      let raw: Record<string, unknown>[]
      try {
        statements++
        raw = ((await db.prepare(stmt.sql).bind(...stmt.binds).all()).results ?? []) as Record<string, unknown>[]
      } catch (e) {
        facts.set(f.key, failSoft ? { ok: true, rows: def.parse([]), asOfMs: opts.nowMs } : { ok: false, error: String(e) })
        return
      }
      facts.set(f.key, { ok: true, rows: def.parse(raw), asOfMs: opts.nowMs })
      const ttl = factTtlSeconds(def.ttl, f, new Date(opts.nowMs))
      const body = JSON.stringify({ asOfMs: opts.nowMs, raw })
      opts.waitUntil(opts.cache.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` } })))
    }),
  )
  return { facts, cacheHits, statements }
}
