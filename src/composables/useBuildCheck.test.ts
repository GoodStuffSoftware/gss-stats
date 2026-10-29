// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { fetchLiveBuildId, useBuildCheck } from './useBuildCheck'
import { BUILD_CHECK_INTERVAL_MS } from './buildCheck'

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
}

function mountWith(current: string, enabled: boolean, fetchImpl: typeof fetch) {
  let api!: ReturnType<typeof useBuildCheck>
  const wrapper = mount(defineComponent({ setup() { api = useBuildCheck(current, enabled, fetchImpl); return () => h('div') } }))
  return { api, wrapper }
}

beforeEach(() => { vi.useFakeTimers(); setVisibility('visible') })
afterEach(() => { vi.useRealTimers() })

describe('fetchLiveBuildId', () => {
  it('requests only the static file, uncached', async () => {
    const f = vi.fn(async () => json({ id: 'x' }))
    expect(await fetchLiveBuildId(f as unknown as typeof fetch)).toBe('x')
    expect(f).toHaveBeenCalledWith('/build-id.json', expect.objectContaining({ cache: 'no-store', redirect: 'manual' }))
  })
  it('is null on a non-ok reply, a bad body or a network error', async () => {
    expect(await fetchLiveBuildId((async () => json({ id: 'x' }, false)) as unknown as typeof fetch)).toBeNull()
    expect(await fetchLiveBuildId((async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBeNull()
    expect(await fetchLiveBuildId((async () => ({ ok: true, json: async () => { throw new Error('html') } })) as unknown as typeof fetch)).toBeNull()
  })
})

describe('useBuildCheck', () => {
  it('flags a newer build on the 5-minute tick and never reloads', async () => {
    const f = vi.fn(async () => json({ id: 'b' }))
    const { api, wrapper } = mountWith('a', true, f as unknown as typeof fetch)
    expect(api.updateAvailable.value).toBe(false)
    await vi.advanceTimersByTimeAsync(BUILD_CHECK_INTERVAL_MS)
    expect(api.updateAvailable.value).toBe(true)
    wrapper.unmount()
  })
  it('stays quiet when the build matches', async () => {
    const f = vi.fn(async () => json({ id: 'a' }))
    const { api, wrapper } = mountWith('a', true, f as unknown as typeof fetch)
    await vi.advanceTimersByTimeAsync(BUILD_CHECK_INTERVAL_MS)
    expect(f).toHaveBeenCalledTimes(1)
    expect(api.updateAvailable.value).toBe(false)
    wrapper.unmount()
  })
  it('skips the tick while hidden and checks when the tab becomes visible', async () => {
    const f = vi.fn(async () => json({ id: 'b' }))
    const { api, wrapper } = mountWith('a', true, f as unknown as typeof fetch)
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(BUILD_CHECK_INTERVAL_MS * 2)
    expect(f).not.toHaveBeenCalled()
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()
    expect(api.updateAvailable.value).toBe(true)
    wrapper.unmount()
  })
  it('does nothing when disabled', async () => {
    const f = vi.fn(async () => json({ id: 'b' }))
    const { wrapper } = mountWith('a', false, f as unknown as typeof fetch)
    await vi.advanceTimersByTimeAsync(BUILD_CHECK_INTERVAL_MS * 3)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(f).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
