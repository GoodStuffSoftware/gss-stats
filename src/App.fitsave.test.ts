// @vitest-environment happy-dom
//
// A fit card (Widget.fit) passes through a placeholder height while its data loads, so the layout
// is mutated even when it ends where it started. The save step must not PUT a layout that equals
// the one last loaded or saved (otherwise every page load writes the layout), and must still PUT a
// real change. Geometry is stubbed (happy-dom has no layout); real timers, because the debounces
// (settle 300ms, save 700ms) are the thing under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'
import { defaultConfig, normalizeConfig } from './lib/defaults'
import { fitRows } from './lib/fit'
import { FIT_SETTLE_MS } from './composables/useFitHeight'
import { loadConfig, saveConfig } from './api'
import type { DashboardConfig } from './types'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, loadConfig: vi.fn(), saveConfig: vi.fn(async () => true) }
})
vi.mock('./sitesStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sitesStore')>()
  return { ...actual, loadSites: vi.fn(async () => {}) }
})
vi.mock('./session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session')>()
  return { ...actual, loadIdentity: vi.fn(async () => {}), checkSessionExpired: vi.fn(async () => {}) }
})

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
const observers: (() => void)[] = []
const live = new Set<object>()
class FakeResizeObserver {
  cb: () => void
  constructor(cb: () => void) {
    this.cb = cb
    observers.push(cb)
  }
  observe() {
    live.add(this)
  }
  unobserve() {}
  disconnect() {
    live.delete(this)
  }
}

let contentBottom = 300
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let wrapper: VueWrapper | null = null

/** The stored layout: the default config with the first metric card on the active page set to fit
 * at the height its (stubbed) content needs. */
function storedConfig(): DashboardConfig {
  const cfg = normalizeConfig(JSON.parse(JSON.stringify(defaultConfig())))
  const page = cfg.pages.find((p) => p.id === cfg.activePageId)!
  const card = page.widgets.find((w) => w.card)!
  card.fit = 'content'
  card.h = fitRows(300)
  return cfg
}

beforeEach(() => {
  contentBottom = 300
  observers.length = 0
  live.clear()
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('innerWidth', 1280)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => 400)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('chart-card') ? 999 : contentBottom
  })
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(() => 0)
  vi.mocked(loadConfig).mockResolvedValue(storedConfig())
  vi.mocked(saveConfig).mockClear()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function load() {
  wrapper = mount(App, { attachTo: document.body })
  await flushPromises()
}
function fireResize() {
  for (const cb of observers) cb()
}

describe('App: saving a fit card layout', () => {
  it('no PUT when the card passes through a placeholder height and settles back to the stored h', async () => {
    contentBottom = 120 // the loading placeholder: 3 rows
    await load()
    await sleep(FIT_SETTLE_MS + 100) // h becomes 3 (a mutation: the save timer starts)
    contentBottom = 300 // the data arrives: back to the stored 6 rows
    fireResize()
    await sleep(FIT_SETTLE_MS + 100)
    await sleep(900) // longer than the 700ms save debounce
    expect(saveConfig).not.toHaveBeenCalled()
  }, 15000)

  it('still PUTs a layout whose fitted h really changed', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    contentBottom = 520
    fireResize()
    await sleep(FIT_SETTLE_MS + 100)
    await sleep(900)
    expect(saveConfig).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(saveConfig).mock.calls[0][0]
    const card = saved.pages.find((p) => p.id === saved.activePageId)!.widgets.find((w) => w.fit === 'content')!
    expect(card.h).toBe(fitRows(520))
  }, 15000)
})
