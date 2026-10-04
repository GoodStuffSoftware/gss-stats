// @vitest-environment happy-dom
//
// ADR 0005 slice 3, step A: MetricCard loads the ads readings itself (GET /api/ads/readings
// through api.ts) when its spec needs the answer (notices, a readings repeat, or a field bound to
// campaign.freshness / campaign.thresholds / reading.*; declaring the ads-refresh action alone is
// not a reason), nests each campaign's own readings under its card, and reloads them on the card
// reload, after an ads refresh and on return to the tab. A late older answer never overwrites a
// newer one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import AdsRefreshButton from '../AdsRefreshButton.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { __resetReturnRefreshForTests, RETURN_DEBOUNCE_MS, RETURN_MIN_AGE_MS } from '../../composables/useReturnRefresh'
import { fetchAdsReadings } from '../../api'
import type { CardSpec } from '../../lib/metrics/types'

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return { ...actual, fetchAdsReadings: vi.fn() }
})
const mocked = vi.mocked(fetchAdsReadings)

const A = '24279250691'
const B = '24215315197'

const rec = (id: string, campaignId: string, asks: number, extra: Record<string, unknown> = {}) => ({
  v: 1,
  id,
  campaignId,
  kind: 'daily',
  readAt: '2026-09-26T19:00:00Z',
  etDate: '2026-09-26',
  spendThroughEt: '2026-09-25',
  cumulativeSpend: 10,
  thresholds: [],
  complete: true,
  rules: null,
  proposal: null,
  decision: null,
  counts: { taggedArrivals: 1, asks, accepts: 2, authSuccess: 3, signUpsAtMost: 4, signUpsExact: 1, returnD0Web: 777, gameStart: 888 },
  notes: [],
  ...extra,
})
const campaign = (campaignId: string, readings: unknown[], extra: Record<string, unknown> = {}) => ({
  campaignId,
  label: campaignId,
  status: 'active',
  spend: {},
  spendThrough: '2026-09-25',
  lastSync: '2026-10-03T12:00:00Z',
  stale: false,
  thresholdsFired: null,
  readings,
  ...extra,
})
const response = (campaigns: unknown[], generatedAt = '2026-10-03T12:00:00Z') => ({ generatedAt, storeBound: true, storeReadable: true, campaigns, syncAlerts: [] }) as never

/** A card repeated per campaign, each with its own readings table. */
const logSpec = (limit?: number, ids: string[] = [A, B]): CardSpec => ({
  v: 1,
  repeat: { over: 'campaigns', ids },
  sections: [
    {
      layout: 'table',
      repeat: { over: 'readings', ...(limit ? { limit } : {}) },
      items: [
        { id: 'when', label: 'Read', data: { field: 'reading.readAt' }, display: { as: 'datetime-et' } },
        { id: 'asks', label: 'Asks', data: { field: 'reading.count.asks' }, display: { as: 'number' } },
        { id: 'su', label: 'Sign-ups', data: { field: 'reading.count.signUps' }, display: { as: 'text' } },
      ],
    },
  ],
})

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
}
let wrapper: VueWrapper | null = null
async function mountCard(spec: CardSpec, props: Record<string, unknown> = {}) {
  wrapper = mount(MetricCard, { props: { cardRef: { spec }, ...props } })
  await settle()
  return wrapper
}

beforeEach(() => {
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  setVisibility('visible')
  mocked.mockReset()
  mocked.mockResolvedValue(response([campaign(A, [rec('a1', A, 11), rec('a2', A, 12)]), campaign(B, [rec('b1', B, 21)])]))
  vi.useFakeTimers({ now: Date.parse('2026-10-03T14:00:00Z') })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } }) })))
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const rowsOf = (w: VueWrapper) => w.findAll('.metric-card-grid > *').map((card) => card.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => td.text())))

describe('MetricCard: the readings load', () => {
  it('loads on mount and nests each campaign\'s own readings under its card', async () => {
    const w = await mountCard(logSpec())
    expect(mocked).toHaveBeenCalledTimes(1)
    const rows = rowsOf(w)
    expect(rows).toHaveLength(2)
    expect(rows[0].map((r) => r[1])).toEqual(['11', '12']) // campaign A: its two readings only
    expect(rows[1].map((r) => r[1])).toEqual(['21']) // campaign B: its one
    expect(rows[0][0][0]).toBe('Sep 26, 3:00 PM ET')
    expect(rows[0][0][2]).toBe('4 (exact)')
  })

  it('draws no refused count and no time beside one (counts only)', async () => {
    const w = await mountCard(logSpec())
    expect(w.text()).not.toMatch(/777|888/)
  })

  it('asks for the limit the spec asks for (default 30, the biggest of its repeats, capped at 500)', async () => {
    await mountCard(logSpec())
    expect(new URLSearchParams(mocked.mock.calls[0][0] as string).get('limit')).toBe('30')
    wrapper?.unmount()
    mocked.mockClear()
    await mountCard(logSpec(12))
    expect(new URLSearchParams(mocked.mock.calls[0][0] as string).get('limit')).toBe('12')
    wrapper?.unmount()
    mocked.mockClear()
    await mountCard(logSpec(9999))
    expect(new URLSearchParams(mocked.mock.calls[0][0] as string).get('limit')).toBe('500')
  })

  it('narrows the request to the widget campaignIds, and the cards to the same', async () => {
    const w = await mountCard(logSpec(), { campaignIds: [B] })
    const q = new URLSearchParams(mocked.mock.calls[0][0] as string)
    expect(q.getAll('campaignId')).toEqual([B])
    expect(rowsOf(w)).toHaveLength(1)
  })

  it('refetches when the narrowing changes', async () => {
    const w = await mountCard(logSpec(), { campaignIds: [A] })
    expect(mocked).toHaveBeenCalledTimes(1)
    await w.setProps({ campaignIds: [A, B] })
    await settle()
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(new URLSearchParams(mocked.mock.calls[1][0] as string).getAll('campaignId')).toEqual([A, B])
  })

  it('the readings prop overrides the load: a card that only needs rows does not fetch', async () => {
    const w = await mountCard(logSpec(), { readings: [{ campaignId: A, readAt: '2026-09-26T19:00:00Z', kind: 'daily', spend: 1, counts: { asks: 99 } }] })
    expect(mocked).not.toHaveBeenCalled()
    expect(rowsOf(w)[0][0][1]).toBe('99')
  })

  it('a card that reads nothing from the readings (even one with ads-refresh) never fetches them', async () => {
    await mountCard({ v: 1, sections: [{ layout: 'rows', items: [{ id: 'k', label: 'K', data: { field: 'campaign.label' }, display: { as: 'text' } }] }] })
    expect(mocked).not.toHaveBeenCalled()
  })

  it('a card without a readings repeat that reads campaign.freshness fetches with limit 1 (freshness only)', async () => {
    const spec: CardSpec = { v: 1, actions: ['ads-refresh'], repeat: { over: 'campaigns', ids: [A] }, sections: [{ layout: 'rows', items: [{ id: 'f', label: 'Fresh', data: { field: 'campaign.freshness' }, display: { as: 'text' } }] }] }
    const w = await mountCard(spec)
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(new URLSearchParams(mocked.mock.calls[0][0] as string).get('limit')).toBe('1')
    expect(w.text()).toContain('Spend through Sep 25')
  })

  it('the campaign-cost preset (ads-refresh, no readings fields) makes no readings call and shows no Loading placeholder; refresh still reloads it', async () => {
    wrapper = mount(MetricCard, { props: { cardRef: { preset: 'campaign-cost' } } })
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    const w = wrapper
    expect(mocked).not.toHaveBeenCalled()
    expect(w.text()).not.toContain('Loading')
    const statsCalls = () => vi.mocked(fetch).mock.calls.length
    const before = statsCalls()
    expect(before).toBeGreaterThan(0)
    w.findComponent(AdsRefreshButton).vm.$emit('refreshed', { refreshed: true })
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(statsCalls()).toBeGreaterThan(before) // the refresh reloaded the card's own metrics
    expect(mocked).not.toHaveBeenCalled()
  })

  it('shows the freshness and fired thresholds of its own campaign', async () => {
    mocked.mockResolvedValue(response([campaign(A, [rec('a1', A, 1)], { thresholdsFired: [{ threshold: 50, firedAt: '2026-10-01T19:00:00Z' }] }), campaign(B, [], { spendThrough: null, lastSync: null })]))
    const spec: CardSpec = {
      v: 1,
      repeat: { over: 'campaigns', ids: [A, B] },
      sections: [{ layout: 'rows', items: [{ id: 't', label: 'Thresholds', data: { field: 'campaign.thresholds' }, display: { as: 'text' } }] }],
    }
    const w = await mountCard({ ...spec, actions: ['ads-refresh'] })
    expect(w.text()).toContain('$50 · Oct 1, 3:00 PM ET')
  })
})

describe('MetricCard: reloading the readings', () => {
  it('the ads refresh button reloads them (a refreshed result only)', async () => {
    const spec: CardSpec = { ...logSpec(), actions: ['ads-refresh'] }
    const w = await mountCard(spec)
    expect(mocked).toHaveBeenCalledTimes(1)
    const btn = w.findComponent(AdsRefreshButton)
    btn.vm.$emit('refreshed', { refreshed: false })
    await settle()
    expect(mocked).toHaveBeenCalledTimes(1)
    btn.vm.$emit('refreshed', { refreshed: true })
    await settle()
    expect(mocked).toHaveBeenCalledTimes(2)
  })

  it('the exposed reload() refetches them', async () => {
    const w = await mountCard(logSpec())
    ;(w.vm as unknown as { reload: () => void }).reload()
    await settle()
    expect(mocked).toHaveBeenCalledTimes(2)
  })

  it('refetches on return to the tab after 60 s, not before', async () => {
    await mountCard(logSpec())
    const back = async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 20)
      await flushPromises()
    }
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS - 10_000)
    await back()
    expect(mocked).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS)
    await back()
    expect(mocked).toHaveBeenCalledTimes(2)
  })

  it('keeps the rows up when a return refetch fails', async () => {
    const w = await mountCard(logSpec())
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    mocked.mockRejectedValueOnce(new Error('network down'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 20)
    await flushPromises()
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(rowsOf(w)[0]).toHaveLength(2)
    expect(w.find('.mc-live').text()).toBe('')
  })

  it('a late older response never overwrites a newer one (the request-id guard)', async () => {
    let releaseOld!: () => void
    const old = new Promise<void>((r) => (releaseOld = r))
    mocked.mockReset()
    mocked.mockImplementationOnce(async () => {
      await old
      return response([campaign(A, [rec('old', A, 1)]), campaign(B, [])])
    })
    mocked.mockResolvedValueOnce(response([campaign(A, [rec('new', A, 2)]), campaign(B, [])]))
    const w = await mountCard(logSpec()) // request 1 is slow and still pending
    ;(w.vm as unknown as { reload: () => void }).reload() // request 2 answers first
    await settle()
    expect(rowsOf(w)[0].map((r) => r[1])).toEqual(['2'])
    releaseOld()
    await settle()
    expect(rowsOf(w)[0].map((r) => r[1])).toEqual(['2']) // the stale answer is dropped
  })
})

describe('MetricCard: a failed readings load', () => {
  it('shows the card load-failed status and no rows; a reload recovers', async () => {
    mocked.mockReset()
    mocked.mockRejectedValueOnce(new Error('boom'))
    mocked.mockResolvedValue(response([campaign(A, [rec('a1', A, 5)]), campaign(B, [])]))
    const w = await mountCard(logSpec())
    expect(w.find('.mc-live').text()).not.toBe('')
    expect(w.findAll('tbody tr')).toHaveLength(0)
    ;(w.vm as unknown as { reload: () => void }).reload()
    await settle()
    expect(w.find('.mc-live').text()).toBe('')
    expect(rowsOf(w)[0][0][1]).toBe('5')
  })

  it('says nothing about "no campaign has readings" while the load has failed (status + Retry only)', async () => {
    mocked.mockReset()
    mocked.mockRejectedValue(new Error('boom'))
    const base = logSpec()
    const w = await mountCard({ ...base, repeat: { over: 'campaigns', withActivity: true, empty: { label: '', text: { note: 'no-ads-campaign' } } } })
    expect(w.find('.mc-live').text()).not.toBe('')
    expect(w.text()).not.toContain('No campaign has readings')
  })
})
