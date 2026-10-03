// @vitest-environment happy-dom
//
// The ads readings widget refetches when the user comes back to the tab (composables/
// useReturnRefresh.ts), under the same rules as every other card: 60 s since its last load,
// nothing in flight, never while hidden; the table stays up while it reloads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AdsReadingsWidgetCard from './AdsReadingsWidgetCard.vue'
import { __resetReturnRefreshForTests, RETURN_DEBOUNCE_MS, RETURN_INFLIGHT_MAX_MS, RETURN_MIN_AGE_MS } from '../../composables/useReturnRefresh'
import { fetchAdsReadings } from '../../api'

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return { ...actual, fetchAdsReadings: vi.fn() }
})

const response = (generatedAt: string) => ({ generatedAt, storeBound: true, storeReadable: true, campaigns: [], syncAlerts: [] }) as never
const mocked = vi.mocked(fetchAdsReadings)

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}
async function comeBack() {
  setVisibility('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 20)
}
let wrapper: VueWrapper | null = null
async function mountWidget() {
  wrapper = mount(AdsReadingsWidgetCard, { props: { widget: {} } })
  await vi.advanceTimersByTimeAsync(0)
  return wrapper
}

beforeEach(() => {
  __resetReturnRefreshForTests()
  setVisibility('visible')
  mocked.mockReset()
  mocked.mockResolvedValue(response('2026-10-03T12:00:00Z'))
  vi.useFakeTimers()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  __resetReturnRefreshForTests()
})

describe('AdsReadingsWidgetCard: refetch on return to the tab', () => {
  it('refetches once when the tab comes back after 60 s (visibility + focus together)', async () => {
    await mountWidget()
    expect(mocked).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(mocked.mock.calls[1]).toEqual(mocked.mock.calls[0]) // same request: no bypass flag
  })

  it('does nothing under 60 s, nothing while hidden, nothing while a load is in flight', async () => {
    await mountWidget()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS - 5000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    setVisibility('hidden')
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(RETURN_DEBOUNCE_MS + 1000)
    expect(mocked).toHaveBeenCalledTimes(1)

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    mocked.mockImplementationOnce(async () => {
      await gate
      return response('2026-10-03T12:05:00Z')
    })
    await comeBack() // starts the (slow) refetch
    expect(mocked).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RETURN_INFLIGHT_MAX_MS - 5000)
    await comeBack() // still in flight: not doubled
    expect(mocked).toHaveBeenCalledTimes(2)
    release()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('keeps showing the loaded content while it refetches, and after a failed refetch', async () => {
    const w = await mountWidget()
    expect(w.text()).not.toContain('Loading')
    mocked.mockRejectedValueOnce(new Error('network down'))
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(w.find('.state.error').exists()).toBe(false)
    expect(w.text()).toContain('Proposals only')
  })
})

const withCampaign = (label: string) =>
  ({
    generatedAt: '2026-10-03T12:00:00Z',
    storeBound: false,
    storeReadable: false,
    campaigns: [{ campaignId: label, label, status: 'active', readings: [], spend: { source: 'config', spend: 1 } }],
    syncAlerts: [],
  }) as never
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('AdsReadingsWidgetCard: a background refetch is quiet', () => {
  it('shows no "Loading…" and keeps the table on screen while the refetch is pending', async () => {
    const w = await mountWidget()
    expect(w.text()).toContain('Proposals only')
    const slow = deferred<never>()
    mocked.mockImplementationOnce(() => slow.promise)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2) // under way, not answered
    expect(w.text()).not.toContain('Loading')
    expect(w.text()).toContain('Proposals only')
    slow.resolve(response('2026-10-03T12:05:00Z'))
    await vi.advanceTimersByTimeAsync(0)
    expect(w.text()).not.toContain('Loading')
    expect(w.text()).toContain('Proposals only')
  })

  it('keeps an error that is already up while the refetch is pending', async () => {
    mocked.mockRejectedValueOnce(new Error('first load failed'))
    const w = await mountWidget()
    expect(w.find('.state.error').exists()).toBe(true)
    const slow = deferred<never>()
    mocked.mockImplementationOnce(() => slow.promise)
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(w.find('.state.error').exists()).toBe(true) // not swapped for a spinner
    expect(w.text()).not.toContain('Loading')
    slow.resolve(response('2026-10-03T12:05:00Z'))
    await vi.advanceTimersByTimeAsync(0)
    expect(w.find('.state.error').exists()).toBe(false)
  })
})

describe('AdsReadingsWidgetCard: an older response never overwrites a newer one', () => {
  it('a refetch pending for the old query answers after the widget moved to a new one: the new data stays', async () => {
    const w = await mountWidget()
    const old = deferred<never>()
    mocked.mockImplementationOnce(() => old.promise) // the return refetch, for the old query
    mocked.mockImplementationOnce(async () => withCampaign('NEWQUERY')) // the edited widget's load
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2)
    await w.setProps({ widget: { campaignIds: ['2'] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(w.text()).toContain('NEWQUERY')
    old.resolve(withCampaign('OLDQUERY')) // late
    await vi.advanceTimersByTimeAsync(0)
    expect(w.text()).toContain('NEWQUERY')
    expect(w.text()).not.toContain('OLDQUERY')
  })

  it('an older failure cannot put an error over newer data either', async () => {
    const w = await mountWidget()
    let fail!: (e: Error) => void
    mocked.mockImplementationOnce(() => new Promise((_res, rej) => (fail = rej)))
    mocked.mockImplementationOnce(async () => withCampaign('NEWQUERY'))
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    await comeBack()
    await w.setProps({ widget: { campaignIds: ['2'] } })
    await vi.advanceTimersByTimeAsync(0)
    fail(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(w.find('.state.error').exists()).toBe(false)
    expect(w.text()).toContain('NEWQUERY')
  })
})

describe('AdsReadingsWidgetCard: a superseded FIRST load cannot touch the state of the newer one', () => {
  it('an older first load that fails after the newer one succeeded shows no error (error-write guard)', async () => {
    let fail!: (e: Error) => void
    mocked.mockImplementationOnce(() => new Promise((_res, rej) => (fail = rej)))
    mocked.mockImplementationOnce(async () => withCampaign('NEWQUERY'))
    wrapper = mount(AdsReadingsWidgetCard, { props: { widget: {} } })
    await vi.advanceTimersByTimeAsync(0)
    await wrapper.setProps({ widget: { campaignIds: ['2'] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('NEWQUERY')
    fail(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.find('.state.error').exists()).toBe(false)
    expect(wrapper.text()).toContain('NEWQUERY')
  })

  it('an older load that settles while the newer one is still pending leaves the "Loading…" state up (finally guard)', async () => {
    const old = deferred<never>()
    const newer = deferred<never>()
    mocked.mockImplementationOnce(() => old.promise)
    mocked.mockImplementationOnce(() => newer.promise)
    wrapper = mount(AdsReadingsWidgetCard, { props: { widget: {} } })
    await vi.advanceTimersByTimeAsync(0)
    await wrapper.setProps({ widget: { campaignIds: ['2'] } })
    await vi.advanceTimersByTimeAsync(0)
    old.resolve(withCampaign('OLDQUERY'))
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('Loading')
    expect(wrapper.text()).not.toContain('OLDQUERY')
    newer.resolve(withCampaign('NEWQUERY'))
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.text()).toContain('NEWQUERY')
    expect(wrapper.text()).not.toContain('Loading')
  })
})

describe('AdsReadingsWidgetCard: a hung load does not block the return refetch forever', () => {
  it('is still in flight before the age limit; past it a return refetches', async () => {
    mocked.mockImplementationOnce(() => new Promise(() => {}))
    await mountWidget()
    await vi.advanceTimersByTimeAsync(RETURN_INFLIGHT_MAX_MS - 5000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    await comeBack()
    expect(mocked).toHaveBeenCalledTimes(2)
  })
})
