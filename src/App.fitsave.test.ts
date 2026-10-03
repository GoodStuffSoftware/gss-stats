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
import Dashboard from './components/Dashboard.vue'
import ChartEditor from './components/ChartEditor.vue'
import { defaultConfig, normalizeConfig } from './lib/defaults'
import { fitRows } from './lib/fit'
import { FIT_SETTLE_MS } from './composables/useFitHeight'
import { loadConfig, saveConfig } from './api'
import type { DashboardConfig, Widget } from './types'

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

// The layout entry of the fit card, as the dashboard holds it (live and reactive).
const liveCard = () => (wrapper!.findComponent(Dashboard).props('widgets') as Widget[]).find((w) => w.fit === 'content')!
const sentCard = (call: number) => {
  const saved = vi.mocked(saveConfig).mock.calls[call][0]
  return saved.pages.find((p) => p.id === saved.activePageId)!.widgets.find((w) => w.fit === 'content')!
}
const refit = async (bottom: number) => {
  contentBottom = bottom
  fireResize()
  await sleep(FIT_SETTLE_MS + 100)
}
/** A PUT the test resolves by hand. */
function deferPut() {
  let resolve!: (v: boolean | 'stale') => void
  const p = new Promise<boolean | 'stale'>((r) => (resolve = r))
  vi.mocked(saveConfig).mockImplementationOnce(() => p)
  return resolve
}

describe('App: the editor and a refit while it is open', () => {
  it('Save keeps the live x/y/w/h: a card that refit under the open editor does not revert to the snapshot h', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    const live = liveCard()
    expect(live.h).toBe(fitRows(300))
    // App.vue's editChart hands the editor a JSON clone, exactly as the Edit menu does.
    wrapper!.findComponent(Dashboard).vm.$emit('edit', live)
    await flushPromises()
    await refit(520) // the data loads while the editor is open: the live card refits
    expect(liveCard().h).toBe(fitRows(520))
    await wrapper!.findComponent(ChartEditor).find('button.btn-primary').trigger('click')
    await flushPromises()
    expect(liveCard().h).toBe(fitRows(520)) // not the snapshot's 6
    await sleep(900)
    expect(vi.mocked(saveConfig).mock.calls.length).toBe(1)
    expect(sentCard(0).h).toBe(fitRows(520))
  }, 15000)
})

describe('App: a PUT in flight when the layout changes back', () => {
  it('A -> B (slow PUT) -> back to A: A is still sent after B lands, so the server ends on the latest layout', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    const resolveB = deferPut()
    await refit(520) // B
    await sleep(900)
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(sentCard(0).h).toBe(fitRows(520))
    await refit(300) // back to A while B is still in flight
    await sleep(900)
    expect(saveConfig).toHaveBeenCalledTimes(1) // serialised: waits for B
    resolveB(true)
    await sleep(100)
    expect(saveConfig).toHaveBeenCalledTimes(2)
    expect(sentCard(1).h).toBe(fitRows(300)) // the server ends on A, the latest
  }, 20000)

  it('a failed PUT leaves the skip state on what the server still holds', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    const failB = deferPut()
    await refit(520) // B
    await sleep(900)
    await refit(300) // back to A while B is in flight
    await sleep(900)
    failB(false)
    await sleep(100)
    // B never landed, the server still holds A, and the tab is on A: nothing to send.
    expect(saveConfig).toHaveBeenCalledTimes(1)
    await refit(520) // B again: must be sent, because the server does NOT hold B
    await sleep(900)
    expect(saveConfig).toHaveBeenCalledTimes(2)
    expect(sentCard(1).h).toBe(fitRows(520))
  }, 25000)

  it('a skipped save does not clear a standing "stale" label', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    vi.mocked(saveConfig).mockResolvedValueOnce('stale')
    await refit(520)
    await sleep(900)
    expect(wrapper!.find('.save-state').text()).toContain('out of date')
    await refit(300) // back to the loaded layout: the save is skipped
    await sleep(900)
    expect(wrapper!.find('.save-state').text()).toContain('out of date')
  }, 20000)

  it('an edit made while the tab is stale keeps the "out of date" label through the 700 ms pending window', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    vi.mocked(saveConfig).mockResolvedValue('stale')
    await refit(520)
    await sleep(900)
    expect(vi.mocked(saveConfig).mock.calls.length).toBe(1)
    expect(wrapper!.find('.save-state').text()).toContain('out of date')
    // A new edit starts a fresh debounce; the label must not flip to "Saving…" before the timer fires.
    contentBottom = 700
    fireResize()
    await sleep(FIT_SETTLE_MS + 100) // the edit has landed; its save timer is still pending
    expect(vi.mocked(saveConfig).mock.calls.length).toBe(1) // not yet sent
    expect(wrapper!.find('.save-state').text()).toContain('out of date')
    expect(wrapper!.find('.save-state').text()).not.toContain('Saving')
    vi.mocked(saveConfig).mockResolvedValue(true)
  }, 20000)

  it('"Save failed" clears once the tab is back on exactly what the server holds', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    vi.mocked(saveConfig).mockResolvedValueOnce(false)
    await refit(520)
    await sleep(900)
    expect(wrapper!.find('.save-state').text()).toContain('Save failed')
    await refit(300) // back to the loaded layout, which is what the server still holds
    await sleep(900)
    expect(vi.mocked(saveConfig).mock.calls.length).toBe(1) // nothing to send
    expect(wrapper!.find('.save-state').exists() ? wrapper!.find('.save-state').text() : '').not.toContain('Save failed')
  }, 20000)
})

describe('App: leaving the page with an edit still in the debounce', () => {
  it('pagehide sends the pending edit now instead of waiting out the 700 ms', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    await refit(520) // the edit has landed; the save timer is pending
    expect(saveConfig).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(sentCard(0).h).toBe(fitRows(520))
    await sleep(900) // the cleared timer does not fire a second PUT
    expect(saveConfig).toHaveBeenCalledTimes(1)
  }, 20000)

  it('unmounting sends the pending edit and clears the timer', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    // Record the 700 ms save timer's id so the test can see it cleared (a second fire would be a
    // no-op behind the lastPersisted check, so the PUT count alone cannot tell).
    const saveTimerIds: unknown[] = []
    const realSetTimeout = window.setTimeout.bind(window)
    vi.spyOn(window, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
      const id = realSetTimeout(fn, ms, ...a)
      if (ms === 700) saveTimerIds.push(id)
      return id
    }) as typeof window.setTimeout)
    await refit(520)
    expect(saveConfig).not.toHaveBeenCalled()
    expect(saveTimerIds).toHaveLength(1)
    const clearSpy = vi.spyOn(window, 'clearTimeout')
    wrapper!.unmount()
    wrapper = null
    await flushPromises()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(clearSpy).toHaveBeenCalledWith(saveTimerIds[0])
    await sleep(900)
    expect(saveConfig).toHaveBeenCalledTimes(1)
  }, 20000)

  it('the pagehide flush is a keepalive PUT, so the browser lets it finish after the page is gone', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    await refit(520)
    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveConfig).mock.calls[0][1]).toEqual({ keepalive: true })
  }, 20000)

  it('a layout over the keepalive size cap falls back to the ordinary PUT on pagehide', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    liveCard().title = 'x'.repeat(70_000) // a body over the 64 KiB keepalive limit
    await flushPromises()
    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveConfig).mock.calls[0][1]).toEqual({ keepalive: false })
  }, 20000)

  it('an ordinary debounced save is never keepalive', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    await refit(520)
    await sleep(900)
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveConfig).mock.calls[0][1]).toEqual({ keepalive: false })
  }, 20000)

  it('an edit queued behind an in-flight PUT is sent when that PUT resolves (documented limit: a closing page may not live to see it)', async () => {
    await load()
    await sleep(FIT_SETTLE_MS + 100)
    const resolveB = deferPut()
    await refit(520)
    await sleep(900) // B is in flight
    await refit(300)
    window.dispatchEvent(new Event('pagehide')) // leaving: the second edit can only queue
    await flushPromises()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    resolveB(true)
    await sleep(100)
    expect(saveConfig).toHaveBeenCalledTimes(2)
    expect(sentCard(1).h).toBe(fitRows(300))
  }, 20000)
})
