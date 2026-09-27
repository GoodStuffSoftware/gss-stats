/// <reference types="@cloudflare/workers-types" />
//
// POST /api/metrics — one batched endpoint for every registered metric and ratio (ADR 0003
// section 3). The client sends registry ids and params, never SQL:
//
//   1. Validate  (src/lib/metrics/validate.ts): a 64 KiB body cap, at most 200 requests, keys
//      by regex, ids by registry Map lookup, only each metric's declared params, campaignId and
//      popup from their sets, sites/dates by the shared regexes, exact-true booleans.
//   2. Plan      (src/lib/metrics/engine.ts planBatch): distinct facts, deduplicated.
//   3. Budget    more than 40 statements → 413 { maxStatements } (D1 allows 50 per invocation).
//   4. Fetch     (functions/_lib/metricFacts.ts): each fact once, per-fact Cache API entries.
//   5. Derive    (engine.ts deriveBatch): counts, gateRate/MIN_COHORT rates with n/d,
//      instrumentation statuses, deltas, lag — numbers, enums and note ids only, never text.
//
// Behind functions/_middleware.ts like every /api/* route: the Google sign-in gate plus its
// Origin check on non-GET requests (ADR 0002). ANONYMOUS AGGREGATES ONLY: every fact is a
// COUNT(*) GROUP BY (or the stored-spend summary); nothing is a row fetch or a join.
//
// POST { v: 1, context?: { since?, until?, sites?, excludeOwnVisits?, ownBrowser?, ownOS? },
//        fresh?: true, requests: [{ key, metric | ratio, params?, window?, deltas?, minCohort? }] }

import { etDateFast } from '../../src/lib/etTime'
import { deriveBatch, factKeyString, needsReleaseWindows, newSideMemo, planBatch, releaseWindowsFor, type BatchEnv, type FactResult, type Plan } from '../../src/lib/metrics/engine'
import { prewarm } from '../../src/lib/metrics/prewarm'
import { MAX_BODY_BYTES, MAX_STATEMENTS, validateMetricsRequest } from '../../src/lib/metrics/validate'
import type { MetricsResponseBody } from '../../src/lib/metrics/types'
import { fetchFacts, prewarmFactKeys, type MetricFactsEnv } from '../_lib/metricFacts'
import type { CacheLike } from '../_lib/edgeCache'

// Compile the request path while the isolate starts, not on the first request (Workers Free
// allows 10 ms of CPU per request; start-up has its own, larger limit). See lib/metrics/prewarm.ts.
prewarm()
prewarmFactKeys()

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

/** The body as text, or null once it passes `max` bytes (read incrementally, never buffered past
 * the cap — a declared Content-Length is not trusted on its own). */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > max) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    buf.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(buf)
}

export const onRequestPost: PagesFunction<MetricFactsEnv> = async (ctx) => {
  const text = await readCapped(ctx.request, MAX_BODY_BYTES)
  if (text === null) return json({ error: 'body too large', maxBytes: MAX_BODY_BYTES }, 413)
  const batch = validateMetricsRequest(text)
  if (!batch.ok) return json({ error: batch.error, ...batch.detail }, batch.status)
  if (!ctx.env.gss_geo) return json({ error: 'geo DB not bound' }, 500)

  const nowMs = Date.now()
  const env: BatchEnv = { context: batch.context, nowMs, todayEt: etDateFast(nowMs), hasAdsDb: !!ctx.env.gss_stats_ads }
  const valid = batch.requests.flatMap((r) => (r.ok ? [r.req] : []))
  const cache = (caches as unknown as { default: CacheLike }).default
  const opts = { nowMs, todayEt: env.todayEt, fresh: batch.fresh, cache, waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p) }

  // Release windows (before/after) are sized by the first Best Sudoku hit, so that one cached
  // aggregate is read first; every other fact is planned with the windows known. A failed read
  // leaves env.release undefined, and those requests answer `error`.
  const facts = new Map<string, FactResult>()
  let cacheHits = 0
  let statements = 0
  if (needsReleaseWindows(valid)) {
    const first: Plan = { facts: [{ key: factKeyString('bskFirstHit', {}), id: 'bskFirstHit', params: {}, statements: 1 }], statements: 1 }
    const got = await fetchFacts(first, ctx.env, opts)
    const f = got.facts.get(first.facts[0].key)
    if (f?.ok && f.rows.kind === 'scalar') env.release = releaseWindowsFor(f.rows.value, nowMs)
    for (const [k, v] of got.facts) facts.set(k, v)
    cacheHits += got.cacheHits
    statements += got.statements
  }

  const memo = newSideMemo() // each request side is resolved once, for planning and derivation
  const plan = planBatch(valid, env, memo)
  if (plan.statements > MAX_STATEMENTS) {
    return json({ error: 'batch needs more statements than one request may run; split it', maxStatements: MAX_STATEMENTS, statements: plan.statements }, 413)
  }

  const rest = plan.facts.filter((f) => !facts.has(f.key))
  const fetched = await fetchFacts({ facts: rest, statements: rest.reduce((a, f) => a + f.statements, 0) }, ctx.env, opts)
  for (const [k, v] of fetched.facts) facts.set(k, v)
  const body: MetricsResponseBody = {
    v: 1,
    generatedAt: new Date(nowMs).toISOString(),
    results: deriveBatch(batch.requests, { ...env, facts }, memo),
    meta: { facts: plan.facts.length, cacheHits: cacheHits + fetched.cacheHits, statements: statements + fetched.statements },
  }
  return json(body)
}

export const onRequestGet: PagesFunction = async () =>
  json({ ok: true, hint: 'POST a metrics batch: { v: 1, context?, requests: [{ key, metric | ratio, params?, window?, deltas? }] }' })
