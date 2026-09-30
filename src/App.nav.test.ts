// @vitest-environment happy-dom
//
// Page navigation (layout version 12): the header breadcrumb (Group / Page / Drill, each segment a
// menu of its siblings) and the / search. Driven through the real App against the sanitised
// production layout migrated to v12, with three drill pages under Traffic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'
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
vi.mock('./sitesStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sitesStore')>()
  return { ...actual, loadSites: vi.fn(async () => {}) }
})
vi.mock('./session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session')>()
  return { ...actual, loadIdentity: vi.fn(async () => {}), checkSessionExpired: vi.fn(async () => {}) }
})

function storedV12(): DashboardConfig {
  const c = normalizeConfig({ ...JSON.parse(JSON.stringify(PROD_V9)), version: 11 })
  const launch = c.pages.find((p) => p.id === 'bsk-launch')!
  const drill = (id: string, name: string) => ({ ...clonePage(launch, name), id, parentId: 'bsk-launch', icon: undefined })
  c.pages.push(drill('d-mobile', 'mobile'), drill('d-reddit', 'reddit.com'), drill('d-mobile-ca', 'mobile › California'))
  return JSON.parse(JSON.stringify(c))
}
const mounted: VueWrapper[] = []
afterEach(() => {
  // unmount even when a test failed half-way, so its teleported menus don't leak into the next
  while (mounted.length) mounted.pop()!.unmount()
})
async function mountApp(active?: string): Promise<VueWrapper> {
  if (active) localStorage.setItem(VIEWER_PREFS_KEY, JSON.stringify({ active }))
  const w = mount(App, { attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  return w
}
const segs = (w: VueWrapper) => w.findAll('nav.crumbs .seg')
const segTexts = (w: VueWrapper) => segs(w).map((s) => s.text())
const menu = (id: string) => document.getElementById(id)
const rows = (id: string) => Array.from(menu(id)?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
const rowTexts = (id: string) => rows(id).map((r) => r.textContent!.replace(/\s+/g, ' ').trim())
const shownPage = (w: VueWrapper) => w.find('.foot').text().split(' · ')[0]
async function key(el: Element, k: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  await flushPromises()
}

describe('App — breadcrumb (Group / Page / Drill)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(saveConfig).mockClear()
    vi.mocked(loadConfig).mockImplementation(async () => storedV12())
  })

  it('on a drill page shows its group, its page and the drill page, the last one current', async () => {
    const w = await mountApp('d-mobile-ca')
    expect(segTexts(w)).toEqual(['BSBest Sudoku', 'Traffic', 'mobile › California'])
    expect(segs(w).map((s) => s.attributes('aria-current') ?? null)).toEqual([null, null, 'page'])
  })

  it('on ★ Overview the group segment is ★ Overview itself', async () => {
    const w = await mountApp()
    expect(segTexts(w)).toEqual(['Overview'])
    expect(segs(w)[0].attributes('aria-label')).toMatch(/Overview \(pinned\)/)
    expect(segs(w)[0].attributes('aria-current')).toBe('page')
  })

  it('the page segment lists the group\'s pages; arrows move, Esc closes and returns focus', async () => {
    const w = await mountApp('d-mobile-ca')
    const pageSeg = segs(w)[1]
    await pageSeg.trigger('click')
    expect(pageSeg.attributes('aria-expanded')).toBe('true')
    expect(rowTexts('crumb-pages')).toEqual(['Overview', 'Campaigns', 'Pop-ups', 'Traffic3 drills', 'New page in Best Sudoku'])
    // focus starts on the current page, and ↓ moves to the next item
    expect(document.activeElement?.textContent).toContain('Traffic')
    await key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toContain('New page in Best Sudoku')
    await key(document.activeElement!, 'ArrowDown') // wraps
    expect(document.activeElement?.textContent).toContain('Overview')
    await key(document.activeElement!, 'Escape')
    expect(menu('crumb-pages')).toBeNull()
    expect(document.activeElement).toBe(segs(w)[1].element)
  })

  it('picking a page goes there; the drill segment goes away', async () => {
    const w = await mountApp('d-mobile-ca')
    await segs(w)[1].trigger('click')
    rows('crumb-pages')[2].click() // Pop-ups
    await flushPromises()
    expect(shownPage(w)).toBe('Pop-ups')
    expect(segTexts(w)).toEqual(['BSBest Sudoku', 'Pop-ups'])
  })

  it('the group segment lists ★ Overview and every group; a group opens the page last viewed there', async () => {
    const w = await mountApp('d-mobile-ca')
    // this viewer's last page in Best Sudoku is the drill page they're on
    await segs(w)[0].trigger('click')
    expect(rowTexts('crumb-groups')).toEqual(['Overviewpinned', 'ASAll sites1', 'BSBest Sudoku4', 'MIMine4'])
    rows('crumb-groups')[3].click() // Mine
    await flushPromises()
    expect(shownPage(w)).toBe('goodstuffsoftware.com') // Mine's first page
    await segs(w)[0].trigger('click')
    rows('crumb-groups')[2].click() // back to Best Sudoku
    await flushPromises()
    expect(shownPage(w)).toBe('mobile › California')
    await segs(w)[0].trigger('click')
    rows('crumb-groups')[0].click() // ★ Overview
    await flushPromises()
    expect(segTexts(w)).toEqual(['Overview'])
  })

  it('the drill segment lists the sibling drill pages and the way back', async () => {
    const w = await mountApp('d-mobile')
    await segs(w)[2].trigger('click')
    expect(rowTexts('crumb-drills')).toEqual(['mobile', 'reddit.com', 'mobile › California', 'Back to Traffic'])
    rows('crumb-drills')[3].click()
    await flushPromises()
    expect(segTexts(w)).toEqual(['BSBest Sudoku', 'Traffic'])
  })

  it('"New page in <group>" adds a copy of the page on screen to that group, as a page of its own', async () => {
    const w = await mountApp('d-mobile')
    await segs(w)[1].trigger('click')
    rows('crumb-pages').at(-1)!.click()
    await flushPromises()
    await new Promise((r) => setTimeout(r, 800))
    const saved = vi.mocked(saveConfig).mock.calls.at(-1)![0]
    const added = saved.pages.at(-1)!
    expect(added).toMatchObject({ name: 'Copy of mobile', group: 'Best Sudoku' })
    expect(added.parentId).toBeUndefined()
    expect(segTexts(w)).toEqual(['BSBest Sudoku', 'Copy of mobile'])
  })
})

describe('App — / search', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(loadConfig).mockImplementation(async () => storedV12())
  })
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Search pages"]')
  const options = () => Array.from(document.querySelectorAll<HTMLElement>('#nav-search-list [role="option"]'))
  async function type(text: string) {
    const input = dialog()!.querySelector('input')!
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
  }

  it('/ opens it; names match first, then chart titles; ↓ ↵ opens a result', async () => {
    const w = await mountApp()
    await key(document.body, '/')
    await flushPromises()
    expect(dialog()).not.toBeNull()
    expect(document.activeElement?.getAttribute('role')).toBe('combobox')
    const shown = () => options().map((o) => [o.querySelector('.nm')!.textContent!.replace(/\s+/g, ' ').trim(), o.querySelector('.gname')!.textContent])
    await type('pop')
    expect(shown()).toEqual([['Pop-ups', 'Best Sudoku']])
    expect(options()[0].querySelector('mark')!.textContent).toBe('Pop')
    await type('over time')
    // no page is named that: the pages with a chart titled so, each once, with the chart shown
    expect(shown().length).toBeGreaterThan(1)
    for (const [name] of shown()) expect(name).toMatch(/· chart “[^”]*over time[^”]*”/i)
    await type('traffic')
    expect(options()[0].getAttribute('aria-selected')).toBe('true')
    await key(document.activeElement!, 'Enter')
    expect(dialog()).toBeNull()
    expect(shownPage(w)).toBe('Traffic')
  })

  it('Esc closes it and puts focus back; / typed into a field types a slash instead', async () => {
    const w = await mountApp()
    const btn = w.find('.nav-search-btn')
    ;(btn.element as HTMLElement).focus()
    await btn.trigger('click')
    await flushPromises()
    expect(dialog()).not.toBeNull()
    expect(document.activeElement?.getAttribute('role')).toBe('combobox')
    await key(document.activeElement!, 'Escape')
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(btn.element)

    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()
    await key(field, '/')
    expect(dialog()).toBeNull()
    field.remove()
  })
})
