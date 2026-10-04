import { computed, effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetMetricsStateForTests, peekMetricValue, useMetrics } from './useMetrics'

// peekMetricValue: what the "Insert value" picker reads to label a metric option. It looks in the
// page's cache and NEVER fetches or holds an entry (a value is only there if a card put it there).
beforeEach(() => {
  __resetMetricsStateForTests()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetMetricsStateForTests()
})

const spec = { metric: 'bsk.pageviews', window: 'page' } as const
const ctx = { since: '2026-09-01T04:00:00.000Z', until: '2026-10-01T04:00:00.000Z' }

describe('peekMetricValue', () => {
  it('is undefined for a value nothing requested, and never starts a fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(peekMetricValue(spec, ctx, '2026-10-03')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(50)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the value a card loaded for the same context and epoch, reactively, and not another context\'s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { requests: { key: string }[] }
        return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results: { [body.requests[0].key]: { status: 'ok', value: 77 } }, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
      }),
    )
    const seen = computed(() => peekMetricValue(spec, ctx, '2026-10-03')?.status)
    expect(seen.value).toBeUndefined()
    const scope = effectScope()
    scope.run(() => useMetrics(ctx, () => '2026-10-03').request(spec))
    await vi.advanceTimersByTimeAsync(50)
    expect(seen.value).toBe('ok') // the computed re-ran when the entry arrived
    expect(peekMetricValue(spec, ctx, '2026-10-03')).toMatchObject({ status: 'ok', value: 77 })
    expect(peekMetricValue(spec, { ...ctx, until: '2026-09-15T04:00:00.000Z' }, '2026-10-03')).toBeUndefined()
    expect(peekMetricValue(spec, ctx, '2026-10-04')).toBeUndefined()
    scope.stop()
    expect(seen.value).toBeUndefined() // released with the last holder
  })
})
