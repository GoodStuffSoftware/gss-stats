// useMetrics (ADR 0003 section 3, "Client: one batch per page"): every MetricItem's data
// request goes through here, so N cards on one page collapse into ONE batched POST
// /api/metrics per tick (a synchronous tick plus a 10 ms coalescing window), identical
// requests — same metric/ratio, params, window, deltas, minCohort, same page context — share
// one cache entry and one fetch, and a request that no consumer wants any more is dropped from
// a batch that hasn't gone out yet or aborted if its POST is already in flight.
//
// Effect-scope discipline. The v0.8.0 campaignsData leak (lib/campaignsData.ts) was a
// `watch()` registered inside an async continuation, after Vue's synchronous effect-scope
// tracking had already closed — so it was never tied to the calling component and never
// stopped on unmount. Everything reactive here — the one context watcher, the per-request
// `computed`, the one `onScopeDispose` — is created synchronously inside `useMetrics()` or
// `request()`, which must run during a component's `setup()`. A context change re-points each
// consumer at a different cache entry; it never creates a watcher.
//
// Page context (since/until/sites/…) may be a ref or a getter: when it changes after mount,
// every request this instance holds is re-planned against the new context (new cache keys,
// one new coalesced batch) and the old entries are released, so a card follows the page's
// main filter bar. Stale responses are dropped at the entry: only the POST most recently
// dispatched for an entry may write it (`entry.inflight === inflight`), so a slow ordinary
// fetch resolving after a reload, or after a context flip A → B → A, can never overwrite a
// fresher value.
import { computed, getCurrentScope, onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter, type Ref, type ShallowRef } from 'vue'
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
    // Only when set, so every request key made before the country split existed is unchanged.
    ...(spec.params?.country !== undefined ? { country: spec.params.country } : {}),
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
  liveKeys: Set<string> // cache keys this in-flight POST still has a live claim on
}
interface CacheEntry {
  spec: MetricRequestSpec
  value: ShallowRef<MetricValue | undefined>
  /** When this entry last received a successful response (epoch ms), for "Updated Xs ago". */
  loadedAt: ShallowRef<number | null>
  status: 'pending' | 'ok' | 'error'
  refCount: number
  /** The POST most recently dispatched for this entry — the only one allowed to write it. */
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

/** Points `entry` at a newly dispatched POST. The POST it pointed at before loses its claim on
 * the entry (its response is stale for it now), and is aborted once nothing else wants it. */
function claimEntry(entry: CacheEntry, cKey: string, inflight: Inflight) {
  const prev = entry.inflight
  if (prev && prev !== inflight) {
    prev.liveKeys.delete(cKey)
    if (prev.liveKeys.size === 0) prev.controller.abort()
  }
  entry.inflight = inflight
  inflight.liveKeys.add(cKey)
}

async function sendChunk(batch: Batch, reqKeys: string[]) {
  const controller = new AbortController()
  const inflight: Inflight = { controller, liveKeys: new Set() }
  const requests: MetricsRequestBody['requests'] = []
  for (const reqKey of reqKeys) {
    const cKey = cacheKeyOf(batch.contextKey, reqKey)
    const entry = cache.get(cKey)
    if (!entry || entry.refCount <= 0) continue
    claimEntry(entry, cKey, inflight)
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

  // The stale-response guard, checked BEFORE any write: only entries this POST still owns may
  // be written. A later dispatch for the same entry (a reload, or a context flip back to this
  // key) replaced `entry.inflight`; an entry released and re-created is a different object.
  const ownedEntries = (): [string, CacheEntry][] => {
    const out: [string, CacheEntry][] = []
    for (const reqKey of reqKeys) {
      const entry = cache.get(cacheKeyOf(batch.contextKey, reqKey))
      if (entry && entry.inflight === inflight) out.push([reqKey, entry])
    }
    return out
  }
  const body: MetricsRequestBody = { v: 1, requests, ...(batch.context ? { context: batch.context } : {}), ...(batch.fresh ? { fresh: true } : {}) }
  try {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
    if (!res.ok) throw new Error(`metrics request failed: ${res.status}`)
    const json = (await res.json()) as MetricsResponseBody
    const now = Date.now()
    for (const [reqKey, entry] of ownedEntries()) {
      const result = safeResultLookup(json.results, reqKey)
      entry.value.value = result
      entry.status = result ? 'ok' : 'error'
      if (result) entry.loadedAt.value = now
      entry.inflight = undefined
    }
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return // aborted: nobody wants it any more
    for (const [, entry] of ownedEntries()) {
      entry.status = 'error'
      entry.value.value = { status: 'error', reason: 'fetch-failed' }
      entry.inflight = undefined
    }
  }
}

function queueFetch(entry: CacheEntry, ctxKey: string, context: MetricsContext | undefined, reqKey: string, fresh: boolean) {
  entry.status = 'pending'
  const batch = ensureBatch(ctxKey, context, fresh)
  batch.keys.add(reqKey)
  scheduleFlush(batch)
}

/** Takes one reference on the entry for (context, request), creating it and queueing its fetch
 * when it is new. */
function acquireKey(ctxKey: string, context: MetricsContext | undefined, reqKey: string, spec: MetricRequestSpec): CacheEntry {
  const cKey = cacheKeyOf(ctxKey, reqKey)
  let entry = cache.get(cKey)
  if (!entry) {
    entry = { spec, value: shallowRef(undefined), loadedAt: shallowRef(null), status: 'pending', refCount: 0 }
    cache.set(cKey, entry)
    queueFetch(entry, ctxKey, context, reqKey, false)
  }
  entry.refCount++
  return entry
}

/** Drops one reference; the last one removes the entry, unqueues it and aborts its POST once
 * that POST has no other live claim. */
function releaseKey(cKey: string) {
  const entry = cache.get(cKey)
  if (!entry) return
  entry.refCount = Math.max(0, entry.refCount - 1)
  if (entry.refCount > 0) return
  const reqKey = reqKeyFromCacheKey(cKey)
  const ctxKey = cKey.slice(0, cKey.indexOf('::'))
  for (const batch of batches.values()) if (batch.contextKey === ctxKey) batch.keys.delete(reqKey)
  if (entry.inflight) {
    entry.inflight.liveKeys.delete(cKey)
    if (entry.inflight.liveKeys.size === 0) entry.inflight.controller.abort()
    entry.inflight = undefined
  }
  cache.delete(cKey)
}

export interface UseMetrics {
  /** Request one metric/ratio value, batched with every other `request()` call across every
   * card on the page. Returns a shared, reactive result — a second card asking for the exact
   * same request (content-equal, same page context) reads the SAME value and never triggers a
   * second fetch. It follows the page context: after a context change it reads the new
   * context's value (undefined while that loads). Must be called synchronously during a
   * component's `setup()` (a `MetricItem` mounted via `v-for` gets its own effect scope, same
   * as any other component). */
  request(spec: MetricRequestSpec): Readonly<Ref<MetricValue | undefined>>
  /** Force a fresh fetch for exactly these specs, bypassing the server's Cache API entry
   * (`fresh: true`) — a reload control, never automatic. Always its own batch, so it never
   * drags an unrelated pending request into `fresh: true` with it. */
  reload(specs: MetricRequestSpec[]): void
  /** `reload()` over every spec this instance has requested. */
  reloadAll(): void
  /** The latest successful load among this instance's current requests (epoch ms), or null
   * while none has loaded — MetricCard's "Updated Xs ago". */
  lastUpdated: Readonly<Ref<number | null>>
  /** True while any current request's value is an error (a failed batch, or the server's
   * per-request error) — MetricCard then says so instead of "Updated just now". */
  hasError: Readonly<Ref<boolean>>
}

interface Consumer {
  spec: MetricRequestSpec
  reqKey: string
  /** The cache entry for the CURRENT context — swapped (never watched) on a context change. */
  entry: ShallowRef<CacheEntry>
  /** That entry's cache key, for release. */
  cKey: string
}

/** `epoch` is a client-only part of the cache key, never sent: MetricCard passes today's ET
 * date, so at midnight every "today so far" value is re-requested instead of being served
 * from yesterday's entry (the request itself is identical across days). */
export function useMetrics(rawContext?: MaybeRefOrGetter<MetricsContext | undefined>, rawEpoch?: MaybeRefOrGetter<string | undefined>): UseMetrics {
  // Normalized ONCE per context value, so the context key used for caching/batching and the
  // context object actually sent in the POST body can never disagree with each other.
  const readContext = () => {
    const context = normalizeContext(toValue(rawContext))
    const epoch = toValue(rawEpoch)
    return { context, ctxKey: epoch ? `${contextKey(context)}@${epoch}` : contextKey(context) }
  }
  let current = readContext()
  const scope = getCurrentScope()
  const byReqKey = new Map<string, Consumer>()
  // Reactive only so lastUpdated re-reads when a consumer is added; the list itself is small.
  const consumers = shallowRef<Consumer[]>([])
  let disposed = false

  function addConsumer(spec: MetricRequestSpec): Consumer {
    const reqKey = requestKey(spec)
    const existing = byReqKey.get(reqKey)
    if (existing) return existing
    const entry = acquireKey(current.ctxKey, current.context, reqKey, spec)
    const c: Consumer = { spec, reqKey, entry: shallowRef(entry), cKey: cacheKeyOf(current.ctxKey, reqKey) }
    byReqKey.set(reqKey, c)
    consumers.value = [...consumers.value, c]
    return c
  }

  if (scope) {
    // Re-plan on a context change: acquire every consumer's entry under the new context first
    // (so they share one coalesced batch), then release the old ones. Keyed on the normalized
    // context's stable key, so a new-but-equal context object is not a change.
    watch(
      () => readContext().ctxKey,
      (ctxKey) => {
        if (disposed || ctxKey === current.ctxKey) return
        current = readContext()
        for (const c of consumers.value) {
          const oldKey = c.cKey
          c.entry.value = acquireKey(current.ctxKey, current.context, c.reqKey, c.spec)
          c.cKey = cacheKeyOf(current.ctxKey, c.reqKey)
          releaseKey(oldKey)
        }
      },
      { flush: 'sync' },
    )
    onScopeDispose(() => {
      disposed = true
      for (const c of consumers.value) releaseKey(c.cKey)
      consumers.value = []
      byReqKey.clear()
    })
  }

  function reload(specs: MetricRequestSpec[]) {
    for (const spec of specs) {
      const existing = byReqKey.get(requestKey(spec))
      const c = existing ?? addConsumer(spec)
      // A brand-new entry has already queued an ordinary fetch; the reload replaces it.
      if (!existing) for (const b of batches.values()) if (b.contextKey === current.ctxKey && !b.fresh) b.keys.delete(c.reqKey)
      queueFetch(c.entry.value, current.ctxKey, current.context, c.reqKey, true)
    }
  }

  const lastUpdated = computed<number | null>(() => {
    let max: number | null = null
    for (const c of consumers.value) {
      const t = c.entry.value.loadedAt.value
      if (t != null && (max === null || t > max)) max = t
    }
    return max
  })

  const hasError = computed(() => consumers.value.some((c) => c.entry.value.value.value?.status === 'error'))

  return {
    request: (spec) => {
      const c = addConsumer(spec)
      return computed(() => c.entry.value.value.value)
    },
    reload,
    reloadAll: () => reload(consumers.value.map((c) => c.spec)),
    lastUpdated,
    hasError,
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
