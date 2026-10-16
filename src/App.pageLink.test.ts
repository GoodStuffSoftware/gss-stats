// @vitest-environment happy-dom
//
// Page deep links: ?page=<id> opens that page and wins over the remembered one, an unknown id falls
// back to the remembered page, and switching pages keeps the address bar on the page shown
// (replaceState: no history entries added).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'
import { stubAppFetch } from './testing/appFetch'
import { saveConfig, loadConfig } from './api'
import { VIEWER_PREFS_KEY } from './lib/viewerPrefs'
import { defaultConfig } from './lib/defaults'

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
vi.mock('./sitesStore', async (importOriginal) => ({ ...(await importOriginal<typeof import('./sitesStore')>()), loadSites: vi.fn(async () => {}) }))
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  loadIdentity: vi.fn(async () => {}),
  checkSessionExpired: vi.fn(async () => {}),
}))

const mounted: VueWrapper[] = []
beforeEach(() => {
  stubAppFetch() // also resets the address bar to "/"
  localStorage.clear()
  vi.mocked(saveConfig).mockClear()
  vi.mocked(loadConfig).mockImplementation(async () => JSON.parse(JSON.stringify(defaultConfig())))
})
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.unstubAllGlobals()
})
async function mountAt(url: string, remembered?: string) {
  history.replaceState(null, '', url)
  if (remembered) localStorage.setItem(VIEWER_PREFS_KEY, JSON.stringify({ active: remembered }))
  const w = mount(App, { attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  return w
}
const shownPage = (w: VueWrapper) => w.find('.foot').text().split(' · ')[0]
const pageParam = () => new URLSearchParams(location.search).get('page')

describe('App: page deep links', () => {
  it('?page=bsk-features opens the Features page, over the remembered page', async () => {
    const w = await mountAt('/?page=bsk-features', 'bsk-launch')
    expect(shownPage(w)).toBe('Features')
    expect(pageParam()).toBe('bsk-features')
  })

  it('an unknown id falls back to the remembered page and the address bar is corrected', async () => {
    const w = await mountAt('/?page=no-such-page', 'bsk-features')
    expect(shownPage(w)).toBe('Features')
    expect(pageParam()).toBe('bsk-features')
  })

  it('a hostile id changes nothing and is never followed', async () => {
    const before = location.href
    const w = await mountAt('/?page=//evil.example/x', 'bsk-features')
    expect(shownPage(w)).toBe('Features')
    expect(location.origin).toBe(new URL(before).origin)
    expect(pageParam()).toBe('bsk-features')
  })

  it('with no param, the landing page shows and the address bar names it', async () => {
    const w = await mountAt('/')
    expect(shownPage(w)).toBe('Overview')
    expect(pageParam()).toBe('default') // the default config's landing page id
  })

  it('switching pages updates the URL with replaceState: same history length, other params kept', async () => {
    const w = await mountAt('/?utm_source=x&page=bsk-features')
    const length = history.length
    await w.find('.drawer-btn').trigger('click')
    await flushPromises()
    const row = Array.from(document.querySelectorAll<HTMLElement>('#nav-drawer .dr-page')).find((r) => r.querySelector('.nm')!.textContent!.trim() === 'Campaigns')!
    row.click()
    await flushPromises()
    expect(shownPage(w)).toBe('Campaigns')
    expect(pageParam()).toBe('bsk-campaigns')
    expect(new URLSearchParams(location.search).get('utm_source')).toBe('x')
    expect(history.length).toBe(length)
  })
})
