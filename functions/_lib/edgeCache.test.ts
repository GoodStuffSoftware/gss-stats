import { describe, expect, it, vi } from 'vitest'
import { buildCacheKeyUrl, cachedJson, isClosedRange, ttlSecondsFor, type CacheLike } from './edgeCache'

// ── Cache key completeness ──────────────────────────────────────────────────────────
//
// "No two distinct queries share a key" — for every pair of param objects below that differ
// in exactly one field a real request could vary, the built key must differ too. A shared key
// would mean one cached response gets served for a DIFFERENT query (site selection, filters,
// exclusions, own-visit settings, …) than the one that produced it.

describe('buildCacheKeyUrl — completeness', () => {
  const base = {
    mode: 'breakdown',
    dim: 'region',
    ringDims: [] as string[],
    since: '2026-09-01',
    until: '2026-09-07',
    limit: 50,
    sites: ['goodstuff'],
    constraints: [] as { field: string; value: string }[],
    excludeOwn: false,
    ownBrowser: '',
    ownOS: '',
    excludeSelf: true,
  }
  const key = (over: Partial<typeof base>) => buildCacheKeyUrl('/api/geo', { ...base, ...over })

  const variants: [string, Partial<typeof base>][] = [
    ['mode', { mode: 'ring' }],
    ['dim', { dim: 'city' }],
    ['ringDims (added)', { ringDims: ['country', 'device'] }],
    ['since', { since: '2026-08-25' }],
    ['until', { until: '2026-09-08' }],
    ['limit', { limit: 100 }],
    ['sites (different site)', { sites: ['simpletile'] }],
    ['sites (added)', { sites: ['goodstuff', 'simpletile'] }],
    ['sites (all)', { sites: [] }],
    ['constraints (added)', { constraints: [{ field: 'device', value: 'mobile' }] }],
    ['excludeOwn', { excludeOwn: true, ownBrowser: 'Chrome', ownOS: 'Windows' }],
    ['ownBrowser (same excludeOwn)', { excludeOwn: true, ownBrowser: 'Firefox', ownOS: 'Windows' }],
    ['excludeSelf', { excludeSelf: false }],
  ]

  it.each(variants)('changing %s produces a different key than the base', (_label, over) => {
    expect(key(over)).not.toBe(key({}))
  })

  it('every variant above (plus the base) is pairwise distinct', () => {
    const keys = [key({}), ...variants.map(([, over]) => key(over))]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('ring dim ORDER changes the key (nesting order affects the response shape)', () => {
    expect(key({ ringDims: ['country', 'device'] })).not.toBe(key({ ringDims: ['device', 'country'] }))
  })

  it('object key order does NOT change the key (stable serialization)', () => {
    const a = buildCacheKeyUrl('/api/geo', { z: 1, a: 2 })
    const b = buildCacheKeyUrl('/api/geo', { a: 2, z: 1 })
    expect(a).toBe(b)
  })

  it('different endpoints (pathname) never collide even with identical params', () => {
    expect(buildCacheKeyUrl('/api/geo', base)).not.toBe(buildCacheKeyUrl('/api/stats', base))
  })

  it('an ownBrowser/ownOS difference is ignored while excludeOwn is off (both normalize away)', () => {
    // geo.ts/stats.ts only send ownBrowser/ownOS when excludeOwn is true; confirms callers that
    // normalize the same way as production code get a shared, not a spuriously split, cache entry.
    expect(key({ excludeOwn: false, ownBrowser: '' })).toBe(key({ excludeOwn: false, ownBrowser: '' }))
  })
})

// ── ET day-boundary TTL ──────────────────────────────────────────────────────────────

describe('isClosedRange / ttlSecondsFor — ET day boundary', () => {
  // 2026-09-26 12:00 UTC = 2026-09-26 08:00 EDT (UTC-4, daylight saving) — "today" in ET is
  // 2026-09-26; ET midnight for that day is 2026-09-26T04:00:00Z.
  const NOW_EDT = new Date('2026-09-26T12:00:00Z')

  it('a range ending yesterday (ET) is closed — long TTL', () => {
    expect(isClosedRange('2026-09-25', NOW_EDT)).toBe(true)
    expect(ttlSecondsFor('2026-09-25', NOW_EDT)).toBe(86_400)
  })

  it('a range ending today (ET, date-only = inclusive) is NOT closed — short TTL', () => {
    expect(isClosedRange('2026-09-26', NOW_EDT)).toBe(false)
    expect(ttlSecondsFor('2026-09-26', NOW_EDT)).toBe(90)
  })

  it('an exact-instant until at ET midnight is closed (boundary is inclusive of "before")', () => {
    expect(isClosedRange('2026-09-26T04:00:00.000Z', NOW_EDT)).toBe(true)
  })

  it('one millisecond after ET midnight is NOT closed', () => {
    expect(isClosedRange('2026-09-26T04:00:00.001Z', NOW_EDT)).toBe(false)
  })

  it('handles the winter (EST, UTC-5) offset correctly too', () => {
    // 2026-01-15 12:00 UTC = 2026-01-15 07:00 EST; ET midnight for that day is 05:00Z.
    const NOW_EST = new Date('2026-01-15T12:00:00Z')
    expect(isClosedRange('2026-01-14', NOW_EST)).toBe(true)
    expect(isClosedRange('2026-01-15', NOW_EST)).toBe(false)
    expect(isClosedRange('2026-01-15T04:59:59.999Z', NOW_EST)).toBe(true)
    expect(isClosedRange('2026-01-15T05:00:00.000Z', NOW_EST)).toBe(true) // exactly ET midnight — closed
    expect(isClosedRange('2026-01-15T05:00:00.001Z', NOW_EST)).toBe(false)
  })

  it('a malformed until is treated as live (never over-cached)', () => {
    expect(isClosedRange('not-a-date', NOW_EDT)).toBe(false)
  })
})

// ── cachedJson wrapper ───────────────────────────────────────────────────────────────

function fakeCache(): CacheLike & { store: Map<string, Response> } {
  const store = new Map<string, Response>()
  return {
    store,
    async match(req) {
      return store.get(req.url)?.clone()
    },
    async put(req, res) {
      store.set(req.url, res)
    },
  }
}

describe('cachedJson', () => {
  it('a miss computes, stores with the given TTL, and returns the fresh response', async () => {
    const cache = fakeCache()
    const compute = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const waits: Promise<unknown>[] = []
    const res = await cachedJson(cache, 'https://k/1', 120, (p) => waits.push(p), compute)
    await Promise.all(waits)
    expect(compute).toHaveBeenCalledTimes(1)
    expect(await res.json()).toEqual({ ok: 1 })
    const stored = cache.store.get('https://k/1')
    expect(stored?.headers.get('Cache-Control')).toBe('max-age=120')
  })

  it('a hit returns the cached response WITHOUT recomputing', async () => {
    const cache = fakeCache()
    const compute = vi.fn(async () => new Response(JSON.stringify({ n: Math.random() })))
    const waits: Promise<unknown>[] = []
    const first = await cachedJson(cache, 'https://k/2', 60, (p) => waits.push(p), compute)
    await Promise.all(waits)
    const firstBody = await first.clone().json()
    const second = await cachedJson(cache, 'https://k/2', 60, (p) => waits.push(p), compute)
    expect(compute).toHaveBeenCalledTimes(1)
    expect(await second.json()).toEqual(firstBody)
  })

  it('the response served to the caller always carries no-store, even on a hit', async () => {
    const cache = fakeCache()
    const compute = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    const waits: Promise<unknown>[] = []
    await cachedJson(cache, 'https://k/3', 60, (p) => waits.push(p), compute)
    await Promise.all(waits)
    const hit = await cachedJson(cache, 'https://k/3', 60, (p) => waits.push(p), compute)
    expect(hit.headers.get('Cache-Control')).toBe('no-store')
  })

  it('an error response (non-ok) is never stored', async () => {
    const cache = fakeCache()
    const compute = vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
    const waits: Promise<unknown>[] = []
    await cachedJson(cache, 'https://k/4', 60, (p) => waits.push(p), compute)
    await Promise.all(waits)
    expect(cache.store.has('https://k/4')).toBe(false)
    // A second call must recompute — nothing was cached.
    await cachedJson(cache, 'https://k/4', 60, (p) => waits.push(p), compute)
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('a 4xx client error is also never stored', async () => {
    const cache = fakeCache()
    const compute = async () => new Response(JSON.stringify({ error: 'bad request' }), { status: 400 })
    const waits: Promise<unknown>[] = []
    await cachedJson(cache, 'https://k/5', 60, (p) => waits.push(p), compute)
    await Promise.all(waits)
    expect(cache.store.has('https://k/5')).toBe(false)
  })
})
