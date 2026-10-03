/// <reference types="@cloudflare/workers-types" />
//
// Shared per-colo response caching for D1/GraphQL-backed API routes (geo.ts, sites.ts,
// stats.ts). Uses the Workers Cache API (`caches.default`), never KV — Free-plan KV allows
// only 1,000 writes/day account-wide, far too tight for per-query response caching, while the
// Cache API has no such write cap. Runs strictly AFTER the auth gate in functions/_middleware.ts
// (every /api/* route is wrapped by authGate before its handler runs), so a cache hit never
// bypasses sign-in — it just skips redoing the D1/GraphQL work an already-authenticated request
// would have triggered. The cache is per-colo and never sent to the browser as a distinguishable
// signal; every signed-in user is allowlisted anyway, so sharing entries across users is fine.
//
// Two independent pieces, kept pure/testable apart from the Cache API itself:
//   1. buildCacheKeyUrl — turns a normalized param object into a stable synthetic GET URL, used
//      as the Cache API key for POST endpoints (Cache API only keys on Request; a POST body
//      can't be a cache key directly, so we fold the normalized body into the URL instead).
//   2. isClosedRange / ttlSecondsFor — a `[since, until)` range that ends before "today" in
//      America/New_York is immutable (it can never gain or lose rows), so it gets a long TTL;
//      a range that includes today is still live and gets a short one.
// cachedJson wraps the two around a CacheLike (real caches.default in production, an in-memory
// fake in tests) so the request-handling code in geo.ts/sites.ts/stats.ts stays a one-liner.

const IMMUTABLE_TTL_SECONDS = 24 * 60 * 60 // 24h — a closed day can't change.
const LIVE_TTL_SECONDS = 90 // within the requested 60-120s window for ranges including today.
const ET_TIME_ZONE = 'America/New_York'

// ── Stable cache keys ────────────────────────────────────────────────────────────────

// Recursively sort object keys (so { a:1, b:2 } and { b:2, a:1 } produce the same string) while
// preserving array ELEMENT ORDER (an ordered list like geo.ts's `dims` ring order changes the
// response shape, so two orderings must NOT collide on the same cache entry).
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// A synthetic, never-fetched URL used purely as a Cache API key. `pathname` namespaces distinct
// endpoints (and modes within an endpoint, e.g. geo's points/ring/breakdown branches) so their
// param spaces never collide even if the param shapes happened to serialize identically.
export function buildCacheKeyUrl(pathname: string, params: Record<string, unknown>): string {
  return `https://edge-cache.internal${pathname}?p=${encodeURIComponent(stableStringify(params))}`
}

// ── ET day-boundary TTL ──────────────────────────────────────────────────────────────

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const isDateOnly = (v: string): boolean => DATE_ONLY_RE.test(v)

// The UTC instant of the most recent America/New_York midnight at-or-before `now` — i.e. the
// start of "today" in ET. Computed without a timezone library: format `now`'s ET wall-clock
// fields as though they were UTC, and the delta between that and the real instant IS the ET
// UTC offset (handles EST/EDT automatically, since Intl resolves the real DST rule for the date).
function etMidnightMs(now: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: ET_TIME_ZONE,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>
  const hour = parts.hour === '24' ? 0 : Number(parts.hour) // midnight can format as "24" with hour12:false
  const etNowAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second))
  const offsetMs = etNowAsUtc - now.getTime() // e.g. -4h in EDT, -5h in EST
  const etMidnightAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0)
  return etMidnightAsUtc - offsetMs
}

// True when the query's upper bound falls at-or-before the start of today (ET) — the range is
// "closed": nothing more can ever be written into it, so its result is safe to cache forever
// (we still cap it at 24h, generous but bounded). `untilRaw` is the same since/until value
// geo.ts/stats.ts already accept — a bare YYYY-MM-DD date (inclusive; expanded to the following
// midnight, mirroring each endpoint's own `isDateOnly` handling) or a full ISO datetime.
export function isClosedRange(untilRaw: string, now: Date): boolean {
  const untilMs = isDateOnly(untilRaw) ? Date.parse(untilRaw) + 86_400_000 : Date.parse(untilRaw)
  if (Number.isNaN(untilMs)) return false // malformed — treat as live so we never over-cache it
  return untilMs <= etMidnightMs(now)
}

export function ttlSecondsFor(untilRaw: string, now: Date): number {
  return isClosedRange(untilRaw, now) ? IMMUTABLE_TTL_SECONDS : LIVE_TTL_SECONDS
}

// ── Cache wrapper ────────────────────────────────────────────────────────────────────

// The subset of the Workers `Cache` interface this module needs — lets tests supply an
// in-memory fake instead of the real `caches.default` (only available inside workerd).
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

// A handler that wants ONE ok response left out of the cache sets this header on it; it is
// removed before the response is returned, so it never reaches the browser.
export const SKIP_EDGE_CACHE_HEADER = 'X-Skip-Edge-Cache'

// Serve `keyUrl` from `cache` if present; otherwise run `compute()`, store a copy (only when
// the response is ok and not marked SKIP_EDGE_CACHE_HEADER — an error is never cached, so a
// transient D1/GraphQL failure doesn't get pinned for the TTL) tagged with `ttlSeconds`, and return the fresh response. The stored copy
// carries `Cache-Control: max-age=<ttl>` so the Cache API knows how long to keep it; the
// response actually sent to the browser always keeps the endpoints' existing `no-store` (a
// stale copy is fine for the shared edge cache to reuse deliberately, but browsers must not
// cache it themselves) — done by rebuilding the outgoing response rather than mutating the one
// the cache holds. `waitUntil` lets the store happen after the response is already on its way.
export async function cachedJson(
  cache: CacheLike,
  keyUrl: string,
  ttlSeconds: number,
  waitUntil: (p: Promise<unknown>) => void,
  compute: () => Promise<Response>,
): Promise<Response> {
  const key = new Request(keyUrl)
  const hit = await cache.match(key)
  if (hit) return withNoStore(hit)

  const res = await compute()
  const skip = res.headers.has(SKIP_EDGE_CACHE_HEADER)
  if (skip) res.headers.delete(SKIP_EDGE_CACHE_HEADER)
  if (res.ok && !skip) {
    const body = await res.clone().text()
    const stored = new Response(body, { status: res.status, headers: res.headers })
    stored.headers.set('Cache-Control', `max-age=${ttlSeconds}`)
    waitUntil(cache.put(key, stored))
  }
  return res
}

function withNoStore(res: Response): Response {
  const out = new Response(res.body, res)
  out.headers.set('Cache-Control', 'no-store')
  return out
}
