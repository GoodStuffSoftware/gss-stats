// useMetrics (ADR 0003 section 3, "Client: one batch per page"): every MetricItem's data
// request goes through here, so N cards on one page collapse into ONE batched POST
// /api/metrics per tick (a synchronous tick plus a 10 ms coalescing window), identical
// requests — same metric/ratio, params, window, deltas, minCohort, same page context — share
// one cache entry and one fetch, and a request that no consumer wants any more is dropped from
// a batch that hasn't gone out yet or aborted if its POST is already in flight.
//
// No watcher is created here. The v0.8.0 campaignsData leak (lib/campaignsData.ts) was a
// `watch()` registered inside an async continuation, after Vue's synchronous effect-scope
// tracking had already closed — so it was never tied to the calling component and never
// stopped on unmount. This composable sidesteps the whole class of bug: cleanup is a single
// `onScopeDispose` callback per request, registered synchronously in `request()`'s own call
// (which must happen during a component's `setup()`, exactly like `campaignsData`'s outer
// `watch(campaigns, ...)` does) — never inside a `.then()`/`async` continuation.
import { getCurrentScope, onScopeDispose, shallowRef, type ShallowRef } from 'vue'
import { etMidnightUtcMs } from '../lib/campaigns'
import { addEtDays } from '../lib/overview'
import type { MetricsContext, MetricsRequestBody, MetricsResponseBody, MetricValue } from '../lib/metrics/types'
import { MAX_REQUESTS } from '../lib/metrics/validate'
import type { MetricRequestSpec } from '../lib/metrics/scope'

export type { MetricRequestSpec }

const ENDPOINT = '/api/metrics'
const COALESCE_MS = 10

// ── Page-range windows: always explicit ET-bounded ISO instants (review finding, 2026-09-27):
// `Date.parse('2026-09-26')` reads a bare YYYY-MM-DD as UTC midnight, not ET midnight, four or
// five hours off the actual ET calendar day the caller meant — and the server is moving to
// either reinterpret a bare date as an ET day itself or reject it outright. Normalizing here,
// at the one place that talks to the wire, is correct either way: a caller may still hand
// `useMetrics()` a bare ET date (the natural shape a date-range picker produces) and it always
// goes out as an unambiguous instant. Normalized ONCE per call so the context key used for
// caching and the context actually sent can never disagree. ──────────────────────────────────
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
function normalizeContext(context: MetricsContext | undefined): MetricsContext | undefined {
  if (!context) return context
  const sinceIsDate = context.since !== undefined && DATE_ONLY_RE.test(context.since)
  const untilIsDate = context.until !== undefined && DATE_ONLY_RE.test(context.until)
  if (!sinceIsDate && !untilIsDate) return context
  return {
    ...context,
    ...(sinceIsDate ? { since: new Date(etMidnightUtcMs(context.since!)).toISOString() } : {}),
    // `until` stays the ADR's [since, until) convention: the ET day AFTER the given date, so an
    // inclusive-until-that-day range keeps meaning what it always meant.
    ...(untilIsDate ? { until: new Date(etMidnightUtcMs(addEtDays(context.until!, 1))).toISOString() } : {}),
  }
}

// ── Stable keys ────────────────────────────────────────────────────────────────────────────
// validate.ts's KEY_RE (^[a-z0-9_.:-]{1,64}$) is lowercase-only, but a metric/ratio id carries
// camelCase ('campaign.taggedArrivals') — so the wire `key` can't just BE the id. It's a short
// hash of the canonical request instead: two requests with the same content always hash to the
// same key, which IS the dedupe (a repeat spec's own MetricItem.id is stable only within one
// card, never globally, so it can't do this job).
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}
function canonicalSpec(spec: MetricRequestSpec) {
  return {
    kind: spec.metric !== undefined ? 'metric' : 'ratio',
    id: spec.metric ?? spec.ratio ?? '',
    campaignId: spec.params?.campaignId ?? null,
    popup: spec.params?.popup ?? null,
    window: spec.window ?? null,
    deltas: spec.deltas?.length ? [...new Set(spec.deltas)].sort() : [],
    minCohort: spec.minCohort ?? null,
  }
}
function requestKey(spec: MetricRequestSpec): string {
  return `k${fnv1a(stableStringify(canonicalSpec(spec)))}`
}
function contextKey(context: MetricsContext | undefined): string {
  if (!context) return 'default'
  return stableStringify({
    since: context.since ?? null,
    until: context.until ?? null,
    sites: context.sites?.length ? [...context.sites].sort() : null,
    excludeOwnVisits: context.excludeOwnVisits ?? null,
    ownBrowser: context.ownBrowser ?? null,
    ownOS: context.ownOS ?? null,
  })
}
function cacheKeyOf(ctxKey: string, reqKey: string): string {
  return `${ctxKey}::${reqKey}`
}
function reqKeyFromCacheKey(cKey: string): string {
  return cKey.slice(cKey.indexOf('::') + 2)
}

/** `results[key]`, but never through the prototype chain (review finding, 2026-09-27): `results`
 * is ordinary `JSON.parse` output — a real `{}`, not the server's own `Object.create(null)`
 * (`deriveBatch`); that guarantee doesn't survive the wire. A bracket read for a key like
 * 'constructor' or '__proto__' that isn't one of `results`' OWN properties resolves through
 * `Object.prototype` instead of coming back `undefined`, handing a Function through as if it
 * were a MetricValue. Our own request keys can never literally collide with one (`requestKey`
 * always returns `k<base36 hash>`), but the read pattern is checked here regardless, once, so
 * every caller gets it for free. */
export function safeResultLookup(results: Record<string, MetricValue>, key: string): MetricValue | undefined {
  return Object.hasOwn(results, key) ? results[key] : undefined
}

// ── Module state (intentionally module-level: it's what makes results shared across every
// MetricCard on the page, not per-component). ─────────────────────────────────────────────
interface Inflight {
  controller: AbortController
  liveKeys: Set<string> // cache keys this in-flight POST still has a live consumer for
}
interface CacheEntry {
  spec: MetricRequestSpec
  value: ShallowRef<MetricValue | undefined>
  status: 'pending' | 'ok' | 'error'
  refCount: number
  inflight?: Inflight
}
interface Batch {
  contextKey: string
  context: MetricsContext | undefined
  fresh: boolean
  keys: Set<string>
  timer: ReturnType<typeof setTimeout> | null
}

const cache = new Map<string, CacheEntry>()
const batches = new Map<string, Batch>()

function batchMapKey(ctxKey: string, fresh: boolean): string {
  return `${ctxKey}#${fresh ? 'fresh' : 'std'}`
}
function ensureBatch(ctxKey: string, context: MetricsContext | undefined, fresh: boolean): Batch {
  const bmKey = batchMapKey(ctxKey, fresh)
  let b = batches.get(bmKey)
  if (!b) {
    b = { contextKey: ctxKey, context, fresh, keys: new Set(), timer: null }
    batches.set(bmKey, b)
  }
  return b
}
function scheduleFlush(batch: Batch) {
  if (batch.timer) return
  batch.timer = setTimeout(() => {
    batch.timer = null
    batches.delete(batchMapKey(batch.contextKey, batch.fresh))
    void flush(batch)
  }, COALESCE_MS)
}

/** One tick's worth of requests, chunked into POSTs of at most MAX_REQUESTS (the ADR's 200-
 * request cap) — the client-side half of "split into chunks" (the server's own 40-statement
 * budget is a separate, per-POST concern the caller can't see ahead of sending). */
async function flush(batch: Batch) {
  const allKeys = [...batch.keys]
  for (let i = 0; i < allKeys.length; i += MAX_REQUESTS) {
    void sendChunk(batch, allKeys.slice(i, i + MAX_REQUESTS))
  }
}

async function sendChunk(batch: Batch, reqKeys: string[]) {
  const controller = new AbortController()
  const inflight: Inflight = { controller, liveKeys: new Set() }
  const requests: MetricsRequestBody['requests'] = []
  for (const reqKey of reqKeys) {
    const cKey = cacheKeyOf(batch.contextKey, reqKey)
    const entry = cache.get(cKey)
    if (!entry || entry.refCount <= 0) continue
    entry.inflight = inflight
    inflight.liveKeys.add(cKey)
    requests.push({
      key: reqKey,
      ...(entry.spec.metric !== undefined ? { metric: entry.spec.metric } : { ratio: entry.spec.ratio }),
      ...(entry.spec.params ? { params: entry.spec.params } : {}),
      ...(entry.spec.window ? { window: entry.spec.window } : {}),
      ...(entry.spec.deltas?.length ? { deltas: entry.spec.deltas } : {}),
      ...(entry.spec.minCohort != null ? { minCohort: entry.spec.minCohort } : {}),
    })
  }
  if (!requests.length) return // every consumer unmounted before this chunk was built

  const body: MetricsRequestBody = { v: 1, requests, ...(batch.context ? { context: batch.context } : {}), ...(batch.fresh ? { fresh: true } : {}) }
  try {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
    if (!res.ok) throw new Error(`metrics request failed: ${res.status}`)
    const json = (await res.json()) as MetricsResponseBody
    for (const reqKey of reqKeys) {
      const cKey = cacheKeyOf(batch.contextKey, reqKey)
      const entry = cache.get(cKey)
      if (!entry) continue
      const result = safeResultLookup(json.results, reqKey)
      entry.value.value = result
      entry.status = result ? 'ok' : 'error'
      if (entry.inflight === inflight) entry.inflight = undefined
    }
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return // aborted: nobody wants it any more
    for (const reqKey of reqKeys) {
      const cKey = cacheKeyOf(batch.contextKey, reqKey)
      const entry = cache.get(cKey)
      if (!entry) continue
      entry.status = 'error'
      entry.value.value = { status: 'error', reason: 'fetch-failed' }
      if (entry.inflight === inflight) entry.inflight = undefined
    }
  }
}

export interface UseMetrics {
  /** Request one metric/ratio value, batched with every other `request()` call across every
   * card on the page. Returns a shared, reactive result — a second card asking for the exact
   * same request (content-equal, same page context) gets the SAME ref and never triggers a
   * second fetch. Must be called synchronously during a component's `setup()` (a `MetricItem`
   * mounted via `v-for` gets its own effect scope, same as any other component). */
  request(spec: MetricRequestSpec): ShallowRef<MetricValue | undefined>
  /** Force a fresh fetch for exactly these specs, bypassing the server's Cache API entry
   * (`fresh: true`) — ChartCard's reload control, never automatic. Always its own batch, so it
   * never drags an unrelated pending request into `fresh: true` with it. */
  reload(specs: MetricRequestSpec[]): void
}

export function useMetrics(rawContext?: MetricsContext): UseMetrics {
  // Normalized ONCE, here, so the context key used for caching/batching and the context object
  // actually sent in the POST body can never disagree with each other.
  const context = normalizeContext(rawContext)
  const ctxKey = contextKey(context)
  const scope = getCurrentScope()
  const owned = new Set<string>() // cache keys this useMetrics() instance holds a refcount on

  function release(cKey: string) {
    const entry = cache.get(cKey)
    if (!entry) return
    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount > 0) return
    const reqKey = reqKeyFromCacheKey(cKey)
    for (const batch of batches.values()) batch.keys.delete(reqKey)
    if (entry.inflight) {
      entry.inflight.liveKeys.delete(cKey)
      if (entry.inflight.liveKeys.size === 0) entry.inflight.controller.abort()
    }
    cache.delete(cKey)
  }

  function acquire(spec: MetricRequestSpec, fresh: boolean): ShallowRef<MetricValue | undefined> {
    const reqKey = requestKey(spec)
    const cKey = cacheKeyOf(ctxKey, reqKey)
    let entry = cache.get(cKey)
    const needsFetch = fresh || !entry
    if (!entry) {
      entry = { spec, value: shallowRef(undefined), status: 'pending', refCount: 0 }
      cache.set(cKey, entry)
    }
    if (!owned.has(cKey)) {
      entry.refCount++
      owned.add(cKey)
      if (scope) onScopeDispose(() => release(cKey))
    }
    if (needsFetch) {
      entry.status = 'pending'
      const batch = ensureBatch(ctxKey, context, fresh)
      batch.keys.add(reqKey)
      scheduleFlush(batch)
    }
    return entry.value
  }

  return {
    request: (spec) => acquire(spec, false),
    reload: (specs) => {
      for (const spec of specs) acquire(spec, true)
    },
  }
}

/** Test-only: drops every cached entry, pending batch and timer. The module state above is
 * intentionally shared across every `useMetrics()` call (that sharing IS the batching/dedupe
 * mechanism), which means it otherwise leaks between test cases in the same file. */
export function __resetMetricsStateForTests(): void {
  for (const batch of batches.values()) if (batch.timer) clearTimeout(batch.timer)
  for (const entry of cache.values()) entry.inflight?.controller.abort()
  cache.clear()
  batches.clear()
}
