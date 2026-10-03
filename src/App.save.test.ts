// @vitest-environment happy-dom
//
// Saving the shared config while PUTs are in flight, and a browser whose localStorage throws.
// - A change reverted while a save is in flight still reaches KV (a second PUT with the reverted
//   body), instead of being skipped as "same as the last completed save".
// - One PUT at a time: an edit made while a PUT is out is sent after it answers, so the store ends
//   on the newest body (two PUTs never race).
// - Blocked storage (private window, disabled site data) doesn't stop the dashboard loading.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'
import { stubAppFetch } from './testing/appFetch'
import Dashboard from './components/Dashboard.vue'
import { saveConfig, loadConfig } from './api'
import PROD_V9 from './lib/__fixtures__/prodLayout.v9.json'
import type { DashboardConfig } from './types'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    loadConfig: vi.fn(async () => null),
    saveConfig: vi.fn(async () => true),
    fetchStats: vi.fn(() => new Promise(() => {})),
    fetchSeriesStats: vi.fn(() => new Promise(() => {})),
  }
})
vi.mock('./sitesStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sitesStore')>()
  return { ...actual, loadSites: vi.fn(async () => {}) }
})
vi.mock('./session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session')>()
  return { ...actual, loadIdentity: vi.fn(async () => {}), checkSessionExpired: vi.fn(async () => {}) }
})

// No real network from a mounted App: every endpoint it can reach answers from the stub (src/testing/appFetch.ts).
beforeEach(() => {
  stubAppFetch()
})

const stored = () => ({ ...JSON.parse(JSON.stringify(PROD_V9)), version: 11 })
// The app's save debounce (700 ms) runs on a fake clock: stepping it forward is instant and
// cannot be stretched by a busy machine, where a real 800 ms sleep per step piled up past the
// test timeout.
const pastDebounce = async () => {
  await vi.advanceTimersByTimeAsync(800)
  await flushPromises()
}
const mounted: VueWrapper[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function mountApp() {
  const w = mount(App, { attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  return w
}
// Rename the page on screen through its ⋯ menu.
/** ⋯ → Rename: the page's breadcrumb segment turns into a field; type the name, Enter. */
async function rename(w: VueWrapper, name: string) {
  await w.find('.page-menu-btn').trigger('click')
  await flushPromises()
  Array.from(document.querySelectorAll<HTMLElement>('#page-menu [role="menuitem"]')).find((b) => b.textContent!.trim() === 'Rename')!.click()
  await flushPromises()
  const input = document.querySelector<HTMLInputElement>('nav.crumbs .seg.editing input')!
  input.value = name
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
}
const shownName = (w: VueWrapper) => (w.find('.foot').text() as string).split(' · ')[0]
const savedName = (c: DashboardConfig) => c.pages.find((p) => p.id === 'default')!.name
// saveConfig answers only when the test says so.
function deferredSaves() {
  const pending: ((ok: boolean | 'stale') => void)[] = []
  vi.mocked(saveConfig).mockImplementation(() => new Promise((res) => pending.push(res)))
  return pending
}

describe('App — saving while a PUT is in flight', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    localStorage.clear()
    vi.mocked(saveConfig).mockReset()
    vi.mocked(loadConfig).mockImplementation(async () => stored())
  })

  it('a change reverted while its save is in flight sends a second PUT with the reverted body', async () => {
    const pending = deferredSaves()
    const w = await mountApp()
    const original = shownName(w)
    await rename(w, 'Renamed')
    await pastDebounce()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(savedName(vi.mocked(saveConfig).mock.calls[0][0])).toBe('Renamed')

    // revert while that PUT is still out
    await rename(w, original)
    pending[0](true)
    await flushPromises()
    await pastDebounce()
    expect(saveConfig).toHaveBeenCalledTimes(2)
    expect(savedName(vi.mocked(saveConfig).mock.calls[1][0])).toBe(original)
    pending[1](true)
    await flushPromises()
    await pastDebounce()
    expect(saveConfig).toHaveBeenCalledTimes(2) // settled: nothing more to send
  })

  it('one PUT at a time: an edit made while a PUT is out goes next, and the store ends on the newest body', async () => {
    const pending = deferredSaves()
    const w = await mountApp()
    await rename(w, 'B')
    await pastDebounce()
    await rename(w, 'C')
    await pastDebounce()
    // C waits for B's answer, so two PUTs can never answer out of order
    expect(vi.mocked(saveConfig).mock.calls.map((c) => savedName(c[0]))).toEqual(['B'])
    pending[0](true)
    await flushPromises()
    expect(vi.mocked(saveConfig).mock.calls.map((c) => savedName(c[0]))).toEqual(['B', 'C'])
    pending[1](true)
    await flushPromises()
    await pastDebounce()
    expect(saveConfig).toHaveBeenCalledTimes(2) // C is on screen and saved: nothing to send

    // The store holds C, so going back to B is a change and must be saved.
    await rename(w, 'B')
    await pastDebounce()
    expect(saveConfig).toHaveBeenCalledTimes(3)
    expect(savedName(vi.mocked(saveConfig).mock.calls[2][0])).toBe('B')
  })

  it('a 409 still reports the tab as out of date', async () => {
    vi.mocked(saveConfig).mockImplementation(async () => 'stale')
    const w = await mountApp()
    await rename(w, 'Renamed')
    await pastDebounce()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('This tab is out of date, reload')
  })
})

describe('App — blocked localStorage', () => {
  it('the dashboard still loads, and the theme toggle still works, when every storage call throws', async () => {
    vi.mocked(loadConfig).mockImplementation(async () => stored())
    const boom = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 })
    const w = mount(App, { attachTo: document.body })
    mounted.push(w)
    await flushPromises()
    expect(loadConfig).toHaveBeenCalled()
    expect(w.findComponent(Dashboard).exists()).toBe(true)
    expect(shownName(w)).toBe('Overview')
    await w.find('button[title="Dark mode"]').trigger('click')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    await w.find('button[title="Light mode"]').trigger('click')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
