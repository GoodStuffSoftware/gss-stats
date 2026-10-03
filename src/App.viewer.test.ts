// @vitest-environment happy-dom
//
// Layout version 13: the page a viewer is on is theirs alone. It is remembered in this browser
// (lib/viewerPrefs.ts), a first-time viewer lands on ★ Overview, and switching pages never writes
// the shared config (no PUT). A real change still saves, as v13, with the landing page untouched.
// A drill creates its page at once, nested under the root page it came from.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from './App.vue'
import { stubAppFetch } from './testing/appFetch'
import Dashboard from './components/Dashboard.vue'
import { saveConfig, loadConfig } from './api'
import { VIEWER_PREFS_KEY } from './lib/viewerPrefs'
import PROD_V9 from './lib/__fixtures__/prodLayout.v9.json'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    loadConfig: vi.fn(async () => null),
    saveConfig: vi.fn(async () => true),
    // Charts never get data here; they just stay loading.
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
// The app's save debounce (700 ms) runs on a fake clock: stepping it forward is instant and
// cannot be stretched by a busy machine, where each real 800 ms sleep piled up past the test timeout.
const pastDebounce = () => vi.advanceTimersByTimeAsync(800)
function storedV12() {
  // The live layout as the v12 build stores it (before page navigation): no groups, the
  // "Best Sudoku · " names, and the Best Sudoku overview as the shared active page.
  const c: any = clone(PROD_V9)
  c.version = 12
  return c
}
async function mountApp() {
  const w = mount(App, { attachTo: document.body })
  await flushPromises()
  return w
}
const shownWidgetIds = (w: any) => (w.findComponent(Dashboard).props('widgets') as { id: string }[]).map((x) => x.id)
// Switch pages the way a viewer does: open the ☰ drawer and pick the page.
async function goTo(w: any, name: string) {
  await w.find('.drawer-btn').trigger('click')
  await flushPromises()
  Array.from(document.querySelectorAll<HTMLElement>('#nav-drawer .dr-page')).find((b) => b.textContent!.trim() === name)!.click()
  await flushPromises()
}
// The footer names the page on screen.
const shownPage = (w: any) => (w.find('.foot').text() as string).split(' · ')[0]
const remembered = () => JSON.parse(localStorage.getItem(VIEWER_PREFS_KEY) ?? 'null')

describe('App — the active page is per viewer (layout version 13)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(saveConfig).mockClear()
    vi.mocked(loadConfig).mockImplementation(async () => storedV12())
  })

  it('a first-time viewer lands on ★ Overview, not the shared config\'s old active page', async () => {
    const w = await mountApp()
    // ★ Overview (id default: RUM charts), not the Best Sudoku overview (cards) the v12 config had
    expect(shownWidgetIds(w)).toContain('trend')
    expect(shownWidgetIds(w)).not.toContain('ow-kpis')
    w.unmount()
  })

  it('switching pages is remembered in this browser and never saves the shared config', async () => {
    const w = await mountApp()
    await goTo(w, 'Traffic')
    expect(shownPage(w)).toBe('Traffic')
    expect(remembered()).toMatchObject({ active: 'bsk-launch', lastByGroup: { 'Best Sudoku': 'bsk-launch' } })
    await pastDebounce()
    expect(saveConfig).not.toHaveBeenCalled()
    w.unmount()

    // Back again later: this viewer lands where they left off.
    const again = await mountApp()
    expect(shownPage(again)).toBe('Traffic')
    again.unmount()
  })

  it('a real change saves the config as v13, with the landing page left at ★ Overview', async () => {
    const w = await mountApp()
    await goTo(w, 'Traffic')
    await w.find('.page-menu-btn').trigger('click')
    await flushPromises()
    Array.from(document.querySelectorAll<HTMLElement>('#page-menu [role="menuitem"]')).find((b) => b.textContent!.trim() === 'Rename')!.click()
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('nav.crumbs .seg.editing input')!
    input.value = 'Traffic (all)'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await pastDebounce()
    await flushPromises()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(saveConfig).mock.calls[0][0]
    expect(saved.version).toBe(13)
    expect(saved.activePageId).toBe('default')
    expect(saved.pages.find((p) => p.id === 'bsk-launch')).toMatchObject({ name: 'Traffic (all)', group: 'Best Sudoku', icon: 'trending-up' })
    w.unmount()
  })

  it('a drill opens a new page at once, nested under the page it came from, in its group, named by its own step', async () => {
    localStorage.setItem(VIEWER_PREFS_KEY, JSON.stringify({ active: 'bsk-launch' }))
    const w = await mountApp()
    w.findComponent(Dashboard).vm.$emit('drill', { widgetId: 'bsk-device', dimension: 'device', dataset: 'geo', value: 'mobile', label: 'mobile', x: 10, y: 10 })
    await flushPromises()
    ;(document.querySelector('.drill-act') as HTMLButtonElement).click()
    await flushPromises()
    const first = remembered().active as string
    expect(first).not.toBe('bsk-launch')

    // …and a drill from that drill page nests under THAT drill page, named by what it adds
    w.findComponent(Dashboard).vm.$emit('drill', { widgetId: 'x', dimension: 'region', dataset: 'geo', value: 'CA', label: 'California', x: 10, y: 10 })
    await flushPromises()
    ;(document.querySelector('.drill-act') as HTMLButtonElement).click()
    await flushPromises()
    await pastDebounce()
    await flushPromises()
    const saved = vi.mocked(saveConfig).mock.calls.at(-1)![0]
    const drills = saved.pages.filter((p) => p.parentId)
    expect(drills.map((p) => [p.name, p.parentId, p.group, p.icon ?? null])).toEqual([
      ['mobile', 'bsk-launch', 'Best Sudoku', null],
      ['California', first, 'Best Sudoku', null],
    ])
    // the breadcrumb shows the whole path
    expect(w.findAll('nav.crumbs .seg').map((x) => x.text())).toEqual(['BSBest Sudoku', 'Traffic', 'mobile', 'California'])
    w.unmount()
  })
})
