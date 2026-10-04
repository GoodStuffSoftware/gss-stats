// @vitest-environment happy-dom
//
// ADR 0005 slice 3, step B1: the `ads-readings-log` preset on MetricCard keeps every behaviour the
// bespoke widget's return-refresh test (widgets/AdsReadingsWidgetCard.returnRefresh.test.ts, which
// B2 deletes) held: it refetches the readings when the user comes back to the tab, under the same
// rules as every other card (60 s since its last load, nothing in flight, never while hidden); the
// rows stay up while it reloads; an older response never overwrites a newer one (the reqId guard);
// and the refresh action reloads the readings. Each case here is the old case, re-aimed at the
// card; the one difference is how a load shows: the card's `.mc-live` status instead of an error
// block, and no "Loading…" text (the rows are simply not there yet).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import AdsRefreshButton from '../AdsRefreshButton.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { __resetReturnRefreshForTests, RETURN_DEBOUNCE_MS, RETURN_INFLIGHT_MAX_MS, RETURN_MIN_AGE_MS } from '../../composables/useReturnRefresh'
import { fetchAdsReadings } from '../../api'
import { CAMPAIGNS } from '../../lib/campaigns'

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return { ...actual, fetchAdsReadings: vi.fn() }
})
const mocked = vi.mocked(fetchAdsReadings)

const [X, Y] = [CAMPAIGNS[0].id, CAMPAIGNS[2].id]

/** A response whose one visible number is `tag` (the Asks cell), so which answer is on screen is
 * readable. Both campaigns carry it. */
const answer = (tag: number, generatedAt = '2026-10-03T12:00:00Z') => {
  const camp = (campaignId: string) => ({
    campaignId,
    label: campaignId,
    status: 'active',
    spend: {},
    spendThrough: '2026-10-02',
    lastSync: '2026-10-03T11:30:00Z',
    stale: false,
    thresholdsFired: null,
    readings: [
      {
        v: 1,
        id: `r-${campaignId}-${tag}`,
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
        counts: { taggedArrivals: 1, asks: tag, accepts: 2, authSuccess: 3, signUpsAtMost: 4, signUpsExact: 0 },
        notes: [],
      },
    ],
  })
  return { generatedAt, storeBound: true, storeReadable: true, campaigns: [camp(X), camp(Y)], syncAlerts: [] } as never
}
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
}
async function comeBack() {
  setVisibility('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 20)
  await flushPromises()
}
let wrapper: VueWrapper | null = null
async function mountLog(props: Record<string, unknown> = {}) {
  wrapper = mount(MetricCard, { props: { cardRef: { preset: 'ads-readings-log' }, ...props } })
  await settle()
  return wrapper
}
const asks = (w: VueWrapper) => [...new Set(w.findAll('tbody tr').map((tr) => tr.findAll('td')[6].text()))]
const failed = (w: VueWrapper) => w.find('.mc-live').text() !== ''

beforeEach(() => {
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  setVisibility('visible')
  mocked.mockReset()
  mocked.mockResolvedValue(answer(111))
  vi.useFakeTimers({ now: Date.parse('2026-10-03T14:00:00Z') })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } }) })))
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
})

describe('ads-readings-log card: refetch on return to the tab', () => {
  it('refetches once when the tab comes back after 60 s (visibility + focus together)', async () => {
    await mountLog()
    expect(mocked).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(mocked.mock.calls[1]).toEqual(mocked.mock.calls[0]) // same request: no bypass flag
  })

  it('does nothing under 60 s, nothing while hidden, nothing while a load is in flight', async () => {
    await mountLog()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS - 5000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    setVisibility('hidden')
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 1000)
    expect(mocked).toHaveBeenCalledTimes(1)

    const gate = deferred<never>()
    mocked.mockImplementationOnce(() => gate.promise)
    await comeBack() // starts the (slow) refetch
    expect(mocked).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RETURN_INFLIGHT_MAX_MS - 5000)
    await comeBack() // still in flight: not doubled
    expect(mocked).toHaveBeenCalledTimes(2)
    gate.resolve(answer(111))
    await settle()
  })

  it('keeps showing the loaded rows while it refetches, and after a failed refetch', async () => {
    const w = await mountLog()
    expect(asks(w)).toEqual(['111'])
    mocked.mockRejectedValueOnce(new Error('network down'))
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(failed(w)).toBe(false)
    expect(asks(w)).toEqual(['111'])
    expect(w.text()).toContain('Proposals only')
  })
})

describe('ads-readings-log card: a background refetch is quiet', () => {
  it('keeps the rows on screen, with no status, while the refetch is pending, then shows the new ones', async () => {
    const w = await mountLog()
    const slow = deferred<never>()
    mocked.mockImplementationOnce(() => slow.promise)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2) // under way, not answered
    expect(asks(w)).toEqual(['111'])
    expect(failed(w)).toBe(false)
    expect(w.text()).toContain('Proposals only')
    slow.resolve(answer(222, '2026-10-03T12:05:00Z'))
    await settle()
    expect(asks(w)).toEqual(['222'])
    expect(failed(w)).toBe(false)
  })

  it('keeps a failure that is already up while the refetch is pending; the answer clears it', async () => {
    mocked.mockRejectedValueOnce(new Error('first load failed'))
    const w = await mountLog()
    expect(failed(w)).toBe(true)
    const slow = deferred<never>()
    mocked.mockImplementationOnce(() => slow.promise)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(failed(w)).toBe(true) // not swapped for anything else while it is pending
    slow.resolve(answer(222))
    await settle()
    expect(failed(w)).toBe(false)
    expect(asks(w)).toEqual(['222'])
  })
})

describe('ads-readings-log card: an older response never overwrites a newer one (the reqId guard)', () => {
  it('a refetch pending for the old query answers after the card moved to a new one: the new data stays', async () => {
    const w = await mountLog()
    const old = deferred<never>()
    mocked.mockImplementationOnce(() => old.promise) // the return refetch, for the old query
    mocked.mockImplementationOnce(async () => answer(333)) // the edited card's load
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2)
    await w.setProps({ campaignIds: [Y] })
    await settle()
    expect(asks(w)).toEqual(['333'])
    old.resolve(answer(222)) // late
    await settle()
    expect(asks(w)).toEqual(['333'])
  })

  it('an older failure cannot put an error over newer data either', async () => {
    const w = await mountLog()
    const old = deferred<never>()
    mocked.mockImplementationOnce(() => old.promise)
    mocked.mockImplementationOnce(async () => answer(333))
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    await w.setProps({ campaignIds: [Y] })
    await settle()
    old.reject(new Error('late failure'))
    await settle()
    expect(failed(w)).toBe(false)
    expect(asks(w)).toEqual(['333'])
  })

  it('a reload() while an older load is out: the older answer is dropped', async () => {
    const old = deferred<never>()
    mocked.mockReset()
    mocked.mockImplementationOnce(() => old.promise)
    mocked.mockResolvedValue(answer(222))
    const w = await mountLog() // request 1 pending
    ;(w.vm as unknown as { reload: () => void }).reload() // request 2 answers first
    await settle()
    expect(asks(w)).toEqual(['222'])
    old.resolve(answer(111))
    await settle()
    expect(asks(w)).toEqual(['222'])
  })
})

describe('ads-readings-log card: a superseded FIRST load cannot touch the state of the newer one', () => {
  it('an older first load that fails after the newer one succeeded shows no error (error-write guard)', async () => {
    const old = deferred<never>()
    mocked.mockReset()
    mocked.mockImplementationOnce(() => old.promise)
    mocked.mockImplementationOnce(async () => answer(333))
    const w = await mountLog()
    await w.setProps({ campaignIds: [Y] })
    await settle()
    expect(asks(w)).toEqual(['333'])
    old.reject(new Error('late failure'))
    await settle()
    expect(failed(w)).toBe(false)
    expect(asks(w)).toEqual(['333'])
  })

  it('an older load that settles while the newer one is still pending shows nothing of its own (finally guard)', async () => {
    const old = deferred<never>()
    const newer = deferred<never>()
    mocked.mockReset()
    mocked.mockImplementationOnce(() => old.promise)
    mocked.mockImplementationOnce(() => newer.promise)
    const w = await mountLog()
    await w.setProps({ campaignIds: [Y] })
    await settle()
    old.resolve(answer(222))
    await settle()
    expect(asks(w)).toEqual([]) // the old answer is not drawn
    expect(w.text()).not.toContain('No campaign has readings or stored spend yet.') // still loading, not "empty"
    newer.resolve(answer(333))
    await settle()
    expect(asks(w)).toEqual(['333'])
  })
})

describe('ads-readings-log card: a hung load does not block the return refetch forever', () => {
  it('is still in flight before the age limit; past it a return refetches', async () => {
    mocked.mockImplementationOnce(() => new Promise(() => {}))
    await mountLog()
    await vi.advanceTimersByTimeAsync(RETURN_INFLIGHT_MAX_MS - 5000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2)
  })
})

describe('ads-readings-log card: the refresh action reloads the readings', () => {
  it('a refreshed result reloads them and shows the new rows; a not-refreshed one does not', async () => {
    const w = await mountLog()
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(w.findAllComponents(AdsRefreshButton)).toHaveLength(1) // one button for the whole card
    const btn = w.findComponent(AdsRefreshButton)
    btn.vm.$emit('refreshed', { refreshed: false })
    await settle()
    expect(mocked).toHaveBeenCalledTimes(1)
    mocked.mockResolvedValueOnce(answer(222))
    btn.vm.$emit('refreshed', { refreshed: true })
    await settle()
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(asks(w)).toEqual(['222'])
  })

  it('the button covers the campaigns the card shows (campaignIds narrows it)', async () => {
    const w = await mountLog({ campaignIds: [Y] })
    expect(w.findComponent(AdsRefreshButton).props('campaignIds')).toEqual([Y])
  })
})
