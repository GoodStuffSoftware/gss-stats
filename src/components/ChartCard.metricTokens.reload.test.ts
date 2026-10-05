// @vitest-environment happy-dom
//
// A chart's ↻ refetches the `{=metric:…}` tokens in its caption too (they used to keep their old
// values until the page reloaded), bypassing the server cache like every reload. That is the ONLY way
// they are refetched on demand: a live push (composables/useLiveChanges.ts) still refetches a caption
// token only when the server flagged that token's own last answer `liveSafe === true`, exactly as it
// refetches a chart (counts-only guarantee 5). Reload may refetch anything; a push never goes
// through reload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import { __resetMetricsStateForTests } from '../composables/useMetrics'
import { __resetReturnRefreshForTests, emitLiveChange, RETURN_MIN_AGE_MS } from '../composables/useReturnRefresh'
import { fetchStats } from '../api'
import type { GlobalFilters, Widget } from '../types'
import type { MetricsRequestBody } from '../lib/metrics/types'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: vi.fn(), fetchSeriesStats: vi.fn() }
})
vi.mock('../session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session')>()
  return { ...actual, checkSessionExpired: vi.fn(async () => {}) }
})

const SAFE = 'bsk.pageviews' // the fake server flags this one liveSafe
const UNSAFE = 'bsk.popupTapRate' // and never this one
const filters: GlobalFilters = { siteSel: [], since: '2026-09-01', until: '2026-09-26', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
const stat: Widget = {
  id: 'w1', i: 'w1', title: 'Pageviews', type: 'stat', dataset: 'geo', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3,
  caption: `Views {=metric:${SAFE}@page|number}, tap rate {=metric:${UNSAFE}@page|pct}`,
}

const stats = vi.mocked(fetchStats)
let metricsFetch: ReturnType<typeof vi.fn>
let wrapper: VueWrapper | null = null
const posts = () => metricsFetch.mock.calls.map((c) => JSON.parse(c[1].body) as MetricsRequestBody)
const ids = (p: MetricsRequestBody) => p.requests.map((r) => r.metric ?? r.ratio).sort()

beforeEach(() => {
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  vi.useFakeTimers()
  stats.mockReset()
  stats.mockImplementation(
    async () =>
      ({
        rows: [{ key: {}, pageviews: 5, visits: 5 }],
        totals: { pageviews: 5, visits: 5 },
        meta: { site: 'all', host: null, since: 'a', until: 'b', dimensions: [], metric: 'pageviews', liveSafe: true },
      }) as never,
  )
  metricsFetch = vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as MetricsRequestBody
    const results = Object.fromEntries(
      body.requests.map((r) => [r.key, { status: 'ok', value: 0.5, ...((r.metric ?? r.ratio) === SAFE ? { liveSafe: true } : {}) }]),
    )
    return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
  })
  vi.stubGlobal('fetch', metricsFetch)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
})

async function mountCard(w: Widget = stat) {
  wrapper = mount(ChartCard, { props: { widget: w, filters, dark: false, drillOpen: false } })
  await vi.advanceTimersByTimeAsync(50)
  return wrapper
}

describe('ChartCard: reload and caption metric tokens', () => {
  it('the ↻ button refetches every caption token, bypassing the server cache, alongside the chart', async () => {
    const c = await mountCard()
    expect(posts()).toHaveLength(1)
    expect(posts()[0].fresh).toBeUndefined() // the first load is an ordinary batch
    expect(ids(posts()[0])).toEqual([UNSAFE, SAFE].sort())
    expect(stats).toHaveBeenCalledTimes(1)

    await c.get('button[title="Reload"]').trigger('click')
    await vi.advanceTimersByTimeAsync(50)

    expect(posts()).toHaveLength(2)
    expect(posts()[1].fresh).toBe(true)
    expect(ids(posts()[1])).toEqual([UNSAFE, SAFE].sort()) // the non-liveSafe token too: a user reload may refetch anything
    expect(stats).toHaveBeenCalledTimes(2)
  })

  it('a live push refetches the liveSafe caption token only, never the unflagged one, and never as a reload', async () => {
    await mountCard()
    expect(posts()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000) // past the 60 s stale gate
    emitLiveChange()
    await vi.advanceTimersByTimeAsync(50)

    expect(stats).toHaveBeenCalledTimes(2) // the premise: the push got through to the (liveSafe) chart
    expect(posts()).toHaveLength(2)
    expect(ids(posts()[1])).toEqual([SAFE]) // the token the server flagged...
    expect(posts()[1].fresh).toBeUndefined() // ...as an ordinary batch, not a reload
    expect(posts().slice(1).flatMap(ids)).not.toContain(UNSAFE) // ...and the unflagged one is left alone
  })

  it('a caption whose tokens the server never flags is never refetched by a push', async () => {
    await mountCard({ ...stat, caption: `Tap rate {=metric:${UNSAFE}@page|pct}` })
    expect(posts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    emitLiveChange()
    await vi.advanceTimersByTimeAsync(50)
    expect(posts()).toHaveLength(1)
  })

  it('a reload refetches the token and a later push still keeps the unflagged one out', async () => {
    const c = await mountCard()
    await c.get('button[title="Reload"]').trigger('click')
    await vi.advanceTimersByTimeAsync(50)
    const before = posts().length
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    emitLiveChange()
    await vi.advanceTimersByTimeAsync(50)
    expect(posts().length).toBe(before + 1)
    expect(ids(posts()[before])).toEqual([SAFE])
  })

  it('a token deleted from the caption is released: a push no longer refetches it', async () => {
    const w = { ...stat } as Widget
    const c = await mountCard(w)
    expect(ids(posts()[0])).toEqual([UNSAFE, SAFE].sort())
    await c.setProps({ widget: { ...stat, caption: `Tap rate {=metric:${UNSAFE}@page|pct}` } })
    await c.setProps({ widget: { ...stat, caption: 'No values here' } })
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    emitLiveChange()
    await vi.advanceTimersByTimeAsync(50)
    expect(posts()).toHaveLength(1) // nothing was refetched: the SAFE token was dropped from the caption
  })
})
