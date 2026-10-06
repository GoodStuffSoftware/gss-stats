/// <reference types="@cloudflare/workers-types" />
//
// Runs the facts a /api/metrics batch planned (src/lib/metrics/engine.ts planBatch) and caches
// each one on its own (ADR 0003 section 3, step 4): the Workers Cache API (`caches.default`),
// never KV (Free-plan KV allows 1,000 writes/day). Caching is per fact, not per batch, so
// different batches and pages share entries — a closed campaign's rows are read from D1 at most
// once per colo per 15 minutes however many cards show them.
//
// The cache key is the fact id, its keyed params, the entry format version, and a hash of the
// statement's SQL text AND its bound values — the values built with a fixed "now", so the KPI
// fact's live upper bounds (today so far, and the same time on each earlier day) never split the
// key, while any config the statement depends on (a campaign's tags, flightStart,
// flightStartTimeEt or flightEnd, the exclusions, the install fix, a fact's cuts) does. A
// changed statement or changed config can therefore never be answered from an entry built for
// the old one. `fresh` skips the lookup but still refreshes the entry. An error is never cached.
// Runs behind the auth gate (functions/_middleware.ts) like every /api/* route, so a hit never
// bypasses sign-in.

import { CAMPAIGNS, campaignById, ORGANIC_ARM_ID } from '../../src/lib/campaigns'
import { FACTS, rangeMs, type FactStatement, type FactTtl } from '../../src/lib/metrics/facts'
import { buildFact, type FactResult, type Plan, type PlannedFact } from '../../src/lib/metrics/engine'
import { etMidnightMs, servingEndMs } from '../../src/lib/metrics/instrumentation'
import { addDays, etDateFast } from '../../src/lib/etTime'
import { buildCacheKeyUrl, type CacheLike } from './edgeCache'

export interface MetricFactsEnv {
  gss_geo: D1Database
  gss_stats_ads?: D1Database
}

export interface FetchOptions {
  nowMs: number
  /** ET calendar date of nowMs (computed when absent). */
  todayEt?: string
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
const CLOSED_SECONDS = 24 * 60 * 60
const CLOSED_CAMPAIGN_SECONDS = 15 * 60
/** Bumped whenever the cached body's shape changes. */
export const FACT_CACHE_FORMAT = 2
/** The fixed "now" a statement is built with for its cache key (see the header). */
export const KEY_NOW = 0

function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}
// A fact's SQL text depends only on its shape (how many tags, sites and cuts it has), not on the
// day or the range, so its hash is computed once per distinct text (prewarmFactKeys does the
// common ones at isolate start-up) and only the bound values are hashed per key.
const sqlHashMemo = new Map<string, number>()
/** FNV-1a (32-bit, hex) of the statement text and its bound values (see the header). A plain
 * loop: measured cheaper on a cold isolate than a first call into WebCrypto. */
export function statementHash(sql: string, binds: readonly unknown[]): string {
  let h = sqlHashMemo.get(sql)
  if (h === undefined) {
    if (sqlHashMemo.size > 200) sqlHashMemo.clear()
    sqlHashMemo.set(sql, (h = fnv1a(sql)))
  }
  return fnv1a('\u0000' + JSON.stringify(binds), h).toString(16).padStart(8, '0')
}

/** The cache key of one statement: its fact, params, entry format and statement hash. */
export function statementCacheKeyUrl(f: Pick<PlannedFact, 'id' | 'params'>, keyed: FactStatement): string {
  return buildCacheKeyUrl(`/fact/${f.id}`, { ...f.params, v: FACT_CACHE_FORMAT, h: statementHash(keyed.sql, keyed.binds) })
}

const keyMemo = new Map<string, string>()
/** The cache key of one planned fact: its statement built with the fixed KEY_NOW. A pure function
 * of the fact, its params and the deployed config, so memoized per isolate (a config change is a
 * deploy, which starts new isolates). */
export function factCacheKeyUrl(f: Pick<PlannedFact, 'id' | 'params'>): string {
  const memoKey = JSON.stringify([f.id, f.params])
  let url = keyMemo.get(memoKey)
  if (url === undefined) {
    url = statementCacheKeyUrl(f, buildFact(f, KEY_NOW))
    if (keyMemo.size > 500) keyMemo.clear()
    keyMemo.set(memoKey, url)
  }
  return url
}

/** Computes the cache keys of the facts whose params are fixed by config (the campaign facts and
 * the spend summary), and the SQL-text hashes of the others, while the isolate starts, so no
 * request pays for hashing their SQL. */
export function prewarmFactKeys(): void {
  try {
    for (const c of CAMPAIGNS) {
      for (const id of ['campaignPathVisitor', 'campaignReturns', 'flightPathsSeen'] as const) {
        if (id === 'flightPathsSeen' && !c.flightStart) continue
        factCacheKeyUrl({ id, params: { campaignId: c.id } })
      }
    }
    factCacheKeyUrl({ id: 'adsSpend', params: {} })
    // The date- and range-dependent facts: their keys change daily, but their SQL text does not,
    // so hashing that text now leaves only their bound values for the first request of a day.
    // The organic baseline arm keys on todayEt too (its ET-day maturity band, lib/metrics/facts.ts
    // ORGANIC_MATURITY_SQL), exactly as lib/metrics/engine.ts factParamsFor plans it.
    factCacheKeyUrl({ id: 'campaignReturns', params: { campaignId: ORGANIC_ARM_ID, todayEt: '2026-01-01' } })
    factCacheKeyUrl({ id: 'bskKpiDays', params: { todayEt: '2026-01-01' } })
    factCacheKeyUrl({ id: 'bskKpiDays', params: { todayEt: '2026-01-01', closed: true } })
    factCacheKeyUrl({ id: 'bskRangePath', params: { since: '2026-01-01', until: '2026-01-02' } })
    for (const sites of [[], ['bestsudoku-web'], ['bestsudoku-web', 'bestsudoku', 'bestsudoku-app']]) {
      factCacheKeyUrl({ id: 'popupRangePath', params: { since: '2026-01-01', until: '2026-01-02', sites } })
    }
  } catch {
    // Only slower on the first request, never wrong.
  }
}

/** A cache entry's lifetime. A window counts as closed once it ends at or before today's ET
 * midnight: nothing more can be written into it. */
export function factTtlSeconds(ttl: FactTtl, f: Pick<PlannedFact, 'params'>, todayEt: string): number {
  // A closed KPI day (the day picker): nothing is written into it any more, bar a late beacon from a
  // session that straddled midnight, so yesterday is re-read within 15 minutes and older days daily.
  if (f.params.closed && f.params.todayEt) return addDays(f.params.todayEt, 1) >= todayEt ? CLOSED_CAMPAIGN_SECONDS : CLOSED_SECONDS
  if (typeof ttl === 'object') return ttl.seconds
  const todayStart = etMidnightMs(todayEt)
  if (ttl === 'range') {
    const end = f.params.since && f.params.until ? rangeMs(f.params.since, f.params.until)[1] : NaN
    return end <= todayStart ? CLOSED_SECONDS : LIVE_SECONDS
  }
  const campaign = f.params.campaignId ? campaignById(f.params.campaignId) : undefined
  if (!campaign) return LIVE_SECONDS
  if (ttl === 'campaign') return campaign.status === 'closed' ? CLOSED_CAMPAIGN_SECONDS : LIVE_SECONDS
  return servingEndMs(campaign) <= todayStart ? CLOSED_SECONDS : LIVE_SECONDS // 'flightWindow'
}

export async function fetchFacts(plan: Plan, env: MetricFactsEnv, opts: FetchOptions): Promise<FetchedFacts> {
  let cacheHits = 0
  let statements = 0
  const todayEt = opts.todayEt ?? etDateFast(opts.nowMs)
  const facts = new Map<string, FactResult>()
  await Promise.all(
    plan.facts.map(async (f) => {
      const def = FACTS[f.id]
      const stmt = buildFact(f, opts.nowMs)
      const db = stmt.db === 'gss_stats_ads' ? env.gss_stats_ads : env.gss_geo
      // The ads store is optional and read fail-soft, like lib/adsStore.ts readSpendSummaries:
      // absent or unreadable means "nothing stored", and spend falls back to CAMPAIGN_SPEND.
      const failSoft = stmt.db === 'gss_stats_ads'
      if (!db) {
        facts.set(f.key, failSoft ? { ok: true, rows: def.parse([]), asOfMs: opts.nowMs } : { ok: false, error: 'db-not-bound' })
        return
      }
      const key = new Request(factCacheKeyUrl(f))
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
        // The spend facts read any error as "nothing stored" (CAMPAIGN_SPEND fills in). Play has no
        // fallback and its card says "no Play figures stored yet", so only a missing table (migration
        // 0005 not applied) is empty there; any other error is a real per-metric error.
        const empty = failSoft && (f.id !== 'adsPlayDaily' || /no such table/i.test(String(e)))
        facts.set(f.key, empty ? { ok: true, rows: def.parse([]), asOfMs: opts.nowMs } : { ok: false, error: String(e) })
        return
      }
      facts.set(f.key, { ok: true, rows: def.parse(raw), asOfMs: opts.nowMs })
      const ttl = factTtlSeconds(def.ttl, f, todayEt)
      const body = JSON.stringify({ asOfMs: opts.nowMs, raw })
      opts.waitUntil(opts.cache.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` } })))
    }),
  )
  return { facts, cacheHits, statements }
}
