// @vitest-environment happy-dom
//
// A token removed from a label or caption is let go (NIT-1 of #94): its cache entry leaves the
// shared cache â€” and with it the live-refetch set â€” unless another consumer still holds it, and
// asking for it again starts from nothing (no value, no liveSafe flag) until a fresh response lands.
// Counts-only guarantee 5 must survive all of this: a push refetches only entries whose OWN last
// response carried `liveSafe === true`.
import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetMetricsStateForTests, peekMetricValue, useMetrics, type MetricRequestSpec } from './useMetrics'
import { todayEtFrom } from '../lib/metrics/scope'
import { __resetReturnRefreshForTests, emitLiveChange, RETURN_INFLIGHT_MAX_MS, RETURN_MIN_AGE_MS } from './useReturnRefresh'
import { useMetricTokens } from './useMetricTokens'
import { metricRequestSpec, metricRefsIn } from '../lib/metricValueTokens'
import type { MetricsRequestBody } from '../lib/metrics/types'

const A = '{=metric:bsk.pageviews@page|number}'
const B = '{=metric:bsk.popupTapRate@page|pct}'
const PATH_B = 'metric:bsk.popupTapRate@page'
const specB = metricRequestSpec(metricRefsIn([B])[0])

let fetchMock: ReturnType<typeof vi.fn>
/** Which metric ids the (fake) server flags liveSafe; `hang` makes a response never arrive. */
let safe: Set<string>
let hang: boolean
const posts = () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body) as MetricsRequestBody)
/** What a token's own instance holds for a spec: same page context (none) and ET-day epoch. */
const today = () => todayEtFrom(Date.now())
const peek = (spec: MetricRequestSpec) => peekMetricValue(spec, undefined, today())
const idsPosted = (p: MetricsRequestBody) => p.requests.map((r) => r.metric ?? r.ratio).sort()

beforeEach(() => {
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  vi.useFakeTimers()
  safe = new Set(['bsk.pageviews', 'bsk.popupTapRate'])
  hang = false
  fetchMock = vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
    if (hang) return new Promise(() => {})
    const body = JSON.parse(init.body as string) as MetricsRequestBody
    const results = Object.fromEntries(
      body.requests.map((r) => [r.key, { status: 'ok', value: 0.5, ...(safe.has((r.metric ?? r.ratio) as string) ? { liveSafe: true } : {}) }]),
    )
    return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
})

async function push() {
  await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
  emitLiveChange()
  await vi.advanceTimersByTimeAsync(20)
}

describe('useMetricTokens: releasing a dropped token', () => {
  it('a token dropped from the text is released and leaves the live-refetch set', async () => {
    const text = ref(`${A} and ${B}`)
    const scope = effectScope()
    scope.run(() => useMetricTokens(() => [text.value], () => undefined))
    await vi.advanceTimersByTimeAsync(50)
    expect(posts()).toHaveLength(1)
    expect(idsPosted(posts()[0])).toEqual(['bsk.pageviews', 'bsk.popupTapRate'])
    expect(peek(specB)).toBeDefined()

    text.value = A // B removed
    expect(peek(specB)).toBeUndefined() // the entry left the shared cache

    await push()
    expect(posts()).toHaveLength(2)
    expect(idsPosted(posts()[1])).toEqual(['bsk.pageviews']) // only the token still named is refetched
    scope.stop()
  })

  it('dropping every token releases them all, and a later token is requested again', async () => {
    const text = ref(`${A} ${B}`)
    const scope = effectScope()
    const tokens = scope.run(() => useMetricTokens(() => [text.value], () => undefined))!
    await vi.advanceTimersByTimeAsync(50)
    text.value = 'plain text'
    expect(peek(specB)).toBeUndefined()
    expect(tokens.values.value).toEqual({})
    await push()
    expect(posts()).toHaveLength(1) // nothing left to refetch
    text.value = B
    await vi.advanceTimersByTimeAsync(50)
    expect(tokens.values.value[PATH_B]).toBeDefined()
    scope.stop()
  })

  it('an unsent request for a dropped token never goes out', async () => {
    const text = ref(`${A} ${B}`)
    const scope = effectScope()
    scope.run(() => useMetricTokens(() => [text.value], () => undefined))
    text.value = A // before the 10 ms coalescing window closes
    await vi.advanceTimersByTimeAsync(50)
    expect(idsPosted(posts()[0])).toEqual(['bsk.pageviews'])
    scope.stop()
  })

  it('a token another consumer still holds stays cached and keeps its own liveSafe flag', async () => {
    const text = ref(B)
    const scope = effectScope()
    scope.run(() => {
      useMetricTokens(() => [text.value], () => undefined)
      useMetrics(undefined, today).request(specB) // e.g. a card on the same page asking for the same value
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(posts()).toHaveLength(1) // one shared fetch
    text.value = 'gone'
    expect(peek(specB)?.status).toBe('ok') // the card still holds it
    await push()
    expect(idsPosted(posts()[1])).toEqual(['bsk.popupTapRate']) // and a push still refreshes it
    scope.stop()
  })

  it('the same token written twice is one hold, released when the text no longer names it', async () => {
    const text = ref(`${B} again ${B}`)
    const scope = effectScope()
    scope.run(() => useMetricTokens(() => [text.value], () => undefined))
    await vi.advanceTimersByTimeAsync(50)
    text.value = `only ${B}` // still named once
    expect(peek(specB)).toBeDefined()
    text.value = ''
    expect(peek(specB)).toBeUndefined()
    scope.stop()
  })
})

describe('useMetricTokens: re-acquiring a released token', () => {
  it('starts with no value and NO liveSafe flag: a push cannot refetch it before a fresh response arrives', async () => {
    const text = ref(B)
    const scope = effectScope()
    scope.run(() => useMetricTokens(() => [text.value], () => undefined))
    await vi.advanceTimersByTimeAsync(50) // answered, liveSafe
    expect(peek(specB)?.liveSafe).toBe(true)

    text.value = '' // released
    hang = true // its next answer never arrives
    text.value = B // re-acquired
    expect(peek(specB)).toBeUndefined() // a new entry: no old value, no old flag
    const before = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(20) // the new fetch goes out (and hangs)
    expect(fetchMock.mock.calls.length).toBe(before + 1)

    // Even once the hung fetch no longer counts as in flight, a push must leave the entry alone.
    await vi.advanceTimersByTimeAsync(RETURN_INFLIGHT_MAX_MS + RETURN_MIN_AGE_MS)
    emitLiveChange()
    await vi.advanceTimersByTimeAsync(20)
    expect(fetchMock.mock.calls.length).toBe(before + 1)
    scope.stop()
  })

  it('once a fresh liveSafe response arrives, the entry is back in the live set', async () => {
    const text = ref(B)
    const scope = effectScope()
    scope.run(() => useMetricTokens(() => [text.value], () => undefined))
    await vi.advanceTimersByTimeAsync(50)
    text.value = ''
    text.value = B
    await vi.advanceTimersByTimeAsync(50) // fresh response, flagged
    expect(peek(specB)?.liveSafe).toBe(true)
    const before = fetchMock.mock.calls.length
    await push()
    expect(fetchMock.mock.calls.length).toBe(before + 1)
    scope.stop()
  })

  it('a re-acquired token the server does not flag stays out of the live set', async () => {
    safe.clear()
    const text = ref(B)
    const scope = effectScope()
    scope.run(() => useMetricTokens(() => [text.value], () => undefined))
    await vi.advanceTimersByTimeAsync(50)
    text.value = ''
    text.value = B
    await vi.advanceTimersByTimeAsync(50)
    const before = fetchMock.mock.calls.length
    await push()
    expect(fetchMock.mock.calls.length).toBe(before)
    scope.stop()
  })
})

describe('useMetrics.release', () => {
  it('gives back one hold per request(): the entry goes with the last one, and an unknown spec is ignored', async () => {
    const scope = effectScope()
    const m = scope.run(() => {
      const m = useMetrics(undefined, today)
      m.request(specB)
      m.request(specB)
      return m
    })!
    await vi.advanceTimersByTimeAsync(50)
    m.release(specB)
    expect(peek(specB)).toBeDefined()
    m.release(specB)
    expect(peek(specB)).toBeUndefined()
    m.release(specB) // already gone: no throw
    scope.stop()
  })
})

