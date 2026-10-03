// @vitest-environment happy-dom
//
// The ads readings widget refetches when the user comes back to the tab (composables/
// useReturnRefresh.ts), under the same rules as every other card: 60 s since its last load,
// nothing in flight, never while hidden; the table stays up while it reloads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AdsReadingsWidgetCard from './AdsReadingsWidgetCard.vue'
import { __resetReturnRefreshForTests, RETURN_DEBOUNCE_MS, RETURN_MIN_AGE_MS } from '../../composables/useReturnRefresh'
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
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
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
