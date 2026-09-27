import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetMetricsStateForTests, safeResultLookup, useMetrics, type MetricRequestSpec } from './useMetrics'
import { MAX_REQUESTS } from '../lib/metrics/validate'
import type { MetricsRequestBody, MetricsResponseBody } from '../lib/metrics/types'

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => JSON.parse(JSON.stringify(body)) }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  __resetMetricsStateForTests()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  __resetMetricsStateForTests()
})

const arrivalsSpec: MetricRequestSpec = { metric: 'campaign.taggedArrivals', params: { campaignId: '24279250691' }, window: 'attribution' }
const authSpec: MetricRequestSpec = { metric: 'campaign.authSuccess', params: { campaignId: '24279250691' }, window: 'attribution' }

describe('useMetrics — batching and coalescing', () => {
  it('collects every request() call made within the coalescing window into ONE POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } } satisfies MetricsResponseBody))
    vi.stubGlobal('fetch', fetchMock)

    const scope = effectScope()
    scope.run(() => {
      const { request } = useMetrics()
      request(arrivalsSpec)
      request(authSpec)
    })

    await vi.advanceTimersByTimeAsync(15)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as MetricsRequestBody
    expect(body.requests).toHaveLength(2)
    scope.stop()
    vi.unstubAllGlobals()
  })

  it('two components asking for the exact same request share ONE fetch and the same result', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as MetricsRequestBody
      const key = body.requests[0].key
      return jsonResponse({ v: 1, generatedAt: 'x', results: { [key]: { status: 'ok', value: 353 } }, meta: { facts: 1, cacheHits: 0, statements: 1 } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const scopeA = effectScope()
    const scopeB = effectScope()
    const refA = scopeA.run(() => useMetrics().request(arrivalsSpec))!
    const refB = scopeB.run(() => useMetrics().request(arrivalsSpec))!

    await vi.advanceTimersByTimeAsync(15)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body) as MetricsRequestBody
    expect(sentBody.requests).toHaveLength(1) // deduped into one request on the wire

    await Promise.resolve()
    expect(refA.value).toEqual({ status: 'ok', value: 353 })
    expect(refB.value).toBe(refA.value) // the SAME shared result, not merely equal

    scopeA.stop()
    scopeB.stop()
    vi.unstubAllGlobals()
  })

  it('a batch over MAX_REQUESTS splits into several POSTs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } }))
    vi.stubGlobal('fetch', fetchMock)

    const scope = effectScope()
    scope.run(() => {
      const { request } = useMetrics()
      for (let i = 0; i < MAX_REQUESTS + 25; i++) {
        request({ metric: 'campaign.taggedArrivals', params: { campaignId: '24279250691' }, window: 'attribution', minCohort: 5 + i }) // minCohort varies -> distinct keys
      }
    })

    await vi.advanceTimersByTimeAsync(15)
    expect(fetchMock).toHaveBeenCalledTimes(2) // MAX_REQUESTS in the first chunk, 25 in the second
    const sizes = fetchMock.mock.calls.map((c) => (JSON.parse(c[1].body as string) as MetricsRequestBody).requests.length).sort((a, b) => b - a)
    expect(sizes).toEqual([MAX_REQUESTS, 25])

    scope.stop()
    vi.unstubAllGlobals()
  })

  it('reload() always sends fresh: true, in a batch separate from ordinary pending requests', async () => {
    const bodies: MetricsRequestBody[] = []
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return jsonResponse({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const scope = effectScope()
    scope.run(() => {
      const { request, reload } = useMetrics()
      request(arrivalsSpec) // ordinary
      reload([authSpec]) // forced fresh — must not contaminate the ordinary batch
    })

    await vi.advanceTimersByTimeAsync(15)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies.some((b) => b.fresh === true && b.requests.length === 1)).toBe(true)
    expect(bodies.some((b) => !b.fresh && b.requests.length === 1)).toBe(true)

    scope.stop()
    vi.unstubAllGlobals()
  })
})

describe('useMetrics — abort on unmount, no leftover state', () => {
  it('a request whose only consumer unmounts before the coalescing window fires is never sent', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const scope = effectScope()
    scope.run(() => useMetrics().request(arrivalsSpec))
    scope.stop() // unmount before the 10ms window elapses

    await vi.advanceTimersByTimeAsync(15)
    expect(fetchMock).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('an in-flight request is aborted once its only consumer unmounts', async () => {
    const { promise, resolve } = deferred<Response>()
    const fetchMock = vi.fn().mockReturnValue(promise)
    vi.stubGlobal('fetch', fetchMock)

    const scope = effectScope()
    scope.run(() => useMetrics().request(arrivalsSpec))
    await vi.advanceTimersByTimeAsync(15) // the POST goes out, but nothing has resolved it yet

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal!
    expect(signal.aborted).toBe(false)

    scope.stop() // unmount while the fetch is still in flight
    expect(signal.aborted).toBe(true)

    resolve(jsonResponse({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } }) as unknown as Response)
    await Promise.resolve()
    vi.unstubAllGlobals()
  })

  it('an in-flight request is NOT aborted while at least one other consumer still wants it', async () => {
    const { promise, resolve } = deferred<Response>()
    const fetchMock = vi.fn().mockReturnValue(promise)
    vi.stubGlobal('fetch', fetchMock)

    const scopeA = effectScope()
    const scopeB = effectScope()
    scopeA.run(() => useMetrics().request(arrivalsSpec))
    scopeB.run(() => useMetrics().request(arrivalsSpec))
    await vi.advanceTimersByTimeAsync(15)

    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal!
    scopeA.stop() // one consumer leaves — the other still needs the in-flight fetch
    expect(signal.aborted).toBe(false)

    scopeB.stop()
    expect(signal.aborted).toBe(true)

    resolve(jsonResponse({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } }) as unknown as Response)
    await Promise.resolve()
    vi.unstubAllGlobals()
  })

  it('stopping every consuming scope leaves no cache/batch state behind (the effect-scope cleanup regression, ported from campaignsData)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } }))
    vi.stubGlobal('fetch', fetchMock)

    const scopes = Array.from({ length: 5 }, () => effectScope())
    for (const s of scopes) s.run(() => useMetrics().request(arrivalsSpec))
    await vi.advanceTimersByTimeAsync(15)

    for (const s of scopes) s.stop()

    // No lingering subscription: a fresh request after every consumer left triggers a brand
    // new fetch rather than resolving instantly from stale shared state.
    fetchMock.mockClear()
    const scope2 = effectScope()
    scope2.run(() => useMetrics().request(arrivalsSpec))
    await vi.advanceTimersByTimeAsync(15)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    scope2.stop()
    vi.unstubAllGlobals()
  })
})

describe('safeResultLookup — prototype-pollution-safe results read', () => {
  it('reads an own property normally', () => {
    const results = JSON.parse('{"kabc123": {"status":"ok","value":5}}')
    expect(safeResultLookup(results, 'kabc123')).toEqual({ status: 'ok', value: 5 })
  })

  it('never resolves "constructor" or "__proto__" through the prototype chain when they are not own properties of results', () => {
    // A plain JSON.parse object still has Object.prototype in its chain — a naive results[key]
    // for one of these names would return a Function, not undefined.
    const results = JSON.parse('{"kabc123": {"status":"ok","value":5}}')
    expect(safeResultLookup(results, 'constructor')).toBeUndefined()
    expect(safeResultLookup(results, '__proto__')).toBeUndefined()
    expect(safeResultLookup(results, 'toString')).toBeUndefined()
  })

  it('DOES return "constructor"/"__proto__" when the server legitimately sent them as own keys (JSON.parse gives them real own-property semantics, unlike an object literal)', () => {
    const results = JSON.parse('{"constructor": {"status":"ok","value":1}, "__proto__": {"status":"ok","value":2}}')
    expect(Object.hasOwn(results, 'constructor')).toBe(true)
    expect(Object.hasOwn(results, '__proto__')).toBe(true)
    expect(safeResultLookup(results, 'constructor')).toEqual({ status: 'ok', value: 1 })
    expect(safeResultLookup(results, '__proto__')).toEqual({ status: 'ok', value: 2 })
  })

  it('end to end: a response whose results object also carries __proto__/constructor keys never corrupts an unrelated lookup', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as MetricsRequestBody
      const realKey = body.requests[0].key
      const raw = `{"v":1,"generatedAt":"x","results":{"${realKey}":{"status":"ok","value":353},"__proto__":{"status":"ok","value":999},"constructor":{"status":"ok","value":888}},"meta":{"facts":1,"cacheHits":0,"statements":1}}`
      return { ok: true, status: 200, json: async () => JSON.parse(raw) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const scope = effectScope()
    const ref = scope.run(() => useMetrics().request(arrivalsSpec))!
    await vi.advanceTimersByTimeAsync(15)
    await Promise.resolve()
    expect(ref.value).toEqual({ status: 'ok', value: 353 })

    scope.stop()
    vi.unstubAllGlobals()
  })
})
