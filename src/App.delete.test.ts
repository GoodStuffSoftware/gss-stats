// @vitest-environment happy-dom
//
// Where the viewer lands after the page on screen is deleted: its nearest surviving ancestor, else
// the previous page in its group, else the group's first page, else ★ Overview — from the drawer,
// the page menu (drawer row or header), every time, and remembered in this browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'
import { stubAppFetch } from './testing/appFetch'
import { saveConfig, loadConfig } from './api'
import { VIEWER_PREFS_KEY } from './lib/viewerPrefs'
import { clonePage, normalizeConfig } from './lib/defaults'
import type { DashboardConfig } from './types'
import PROD_V9 from './lib/__fixtures__/prodLayout.v9.json'

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

/** The production layout with a drill tree under Traffic: mobile › California › Los Angeles, and reddit.com. */
function stored(): DashboardConfig {
  const c = normalizeConfig({ ...JSON.parse(JSON.stringify(PROD_V9)), version: 11 })
  const launch = c.pages.find((p) => p.id === 'bsk-launch')!
  const drill = (id: string, name: string, parentId: string) => ({ ...clonePage(launch, name), id, parentId, icon: undefined })
  c.pages.push(drill('d-mobile', 'mobile', 'bsk-launch'), drill('d-ca', 'California', 'd-mobile'), drill('d-la', 'Los Angeles', 'd-ca'), drill('d-reddit', 'reddit.com', 'bsk-launch'))
  return JSON.parse(JSON.stringify(c))
}
const mounted: VueWrapper[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.unstubAllGlobals()
})

// No real network from a mounted App: every endpoint it can reach answers from the stub (src/testing/appFetch.ts).
beforeEach(() => {
  stubAppFetch()
})
beforeEach(() => {
  localStorage.clear()
  vi.mocked(saveConfig).mockClear()
  vi.mocked(loadConfig).mockImplementation(async () => stored())
  vi.stubGlobal('confirm', vi.fn(() => true))
})
async function mountApp(active: string) {
  localStorage.setItem(VIEWER_PREFS_KEY, JSON.stringify({ active }))
  const w = mount(App, { attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  return w
}
const shownPage = (w: VueWrapper) => w.find('.foot').text().split(' · ')[0]
const remembered = () => JSON.parse(localStorage.getItem(VIEWER_PREFS_KEY)!).active
const menuItem = (label: RegExp) => Array.from(document.querySelectorAll<HTMLElement>('#page-menu [role="menuitem"]')).find((b) => label.test(b.textContent!.trim()))
const drawerRow = (name: string) => Array.from(document.querySelectorAll<HTMLElement>('#nav-drawer .dr-page')).find((r) => r.querySelector('.nm')!.textContent!.trim() === name)!
async function deleteFromHeader(w: VueWrapper) {
  await w.find('.page-menu-btn').trigger('click')
  await flushPromises()
  menuItem(/^Delete/)!.click()
  await flushPromises()
}
async function deleteFromDrawerMenu(w: VueWrapper, name: string) {
  await w.find('.drawer-btn').trigger('click')
  await flushPromises()
  drawerRow(name).parentElement!.querySelector<HTMLElement>('.dr-more')!.click()
  await flushPromises()
  menuItem(/^Delete/)!.click()
  await flushPromises()
}

describe('App — where deleting the page on screen lands', () => {
  it('a drill page deleted from the header menu goes back to its parent (remembered)', async () => {
    const w = await mountApp('d-reddit')
    await deleteFromHeader(w)
    expect(shownPage(w)).toBe('Traffic')
    expect(remembered()).toBe('bsk-launch')
  })

  it('a nested drill page goes back to its own parent, not the top-level page', async () => {
    const w = await mountApp('d-la')
    await deleteFromHeader(w)
    expect(shownPage(w)).toBe('California')
    expect(remembered()).toBe('d-ca')
  })

  it('deleting an ancestor of the page on screen lands on that ancestor\'s parent', async () => {
    const w = await mountApp('d-la')
    await deleteFromDrawerMenu(w, 'mobile')
    expect(shownPage(w)).toBe('Traffic')
    expect(remembered()).toBe('bsk-launch')
  })

  it('a drill page deleted with the drawer × goes back to its parent', async () => {
    const w = await mountApp('d-reddit')
    await w.find('.drawer-btn').trigger('click')
    await flushPromises()
    drawerRow('reddit.com').parentElement!.querySelector<HTMLElement>('.dr-x')!.click()
    await flushPromises()
    expect(shownPage(w)).toBe('Traffic')
    expect(remembered()).toBe('bsk-launch')
  })

  it('a top-level page goes to the previous page in its group, else the group\'s first page', async () => {
    let w = await mountApp('bsk-popups')
    await deleteFromHeader(w)
    expect(shownPage(w)).toBe('Campaigns')
    expect(remembered()).toBe('bsk-campaigns')
    w.unmount()
    mounted.length = 0
    w = await mountApp('bsk-overview')
    await deleteFromHeader(w)
    expect(shownPage(w)).toBe('Campaigns') // the first page left in Best Sudoku
    expect(remembered()).toBe('bsk-campaigns')
  })

  it('the last page of a group goes to ★ Overview', async () => {
    const w = await mountApp('beacon')
    await deleteFromHeader(w)
    expect(shownPage(w)).toBe('Overview')
    expect(w.findAll('nav.crumbs .seg').map((s) => s.text())).toEqual(['Overview'])
    expect(remembered()).toBe('default')
  })
})
