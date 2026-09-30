// @vitest-environment happy-dom
//
// Page navigation (layout version 12): the header breadcrumb (Group / Page / Drill, each segment a
// menu of its siblings) and the / search. Driven through the real App against the sanitised
// production layout migrated to v12, with three drill pages under Traffic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'
import Dashboard from './components/Dashboard.vue'
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

describe('App — page drawer, page menu, icon picker', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(saveConfig).mockClear()
    vi.mocked(loadConfig).mockImplementation(async () => storedV12())
  })
  const drawer = () => document.getElementById('nav-drawer')
  const drawerRows = () => Array.from(drawer()?.querySelectorAll<HTMLElement>('.dr-page') ?? [])
  const rowName = (r: HTMLElement) => r.querySelector('.nm')!.textContent!.trim()
  const drawerRow = (name: string) => drawerRows().find((b) => rowName(b) === name)!
  const menuItem = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>('#page-menu [role="menuitem"], #page-menu [role="menuitemradio"]')).find((b) => (b.querySelector('.nm') ?? b).textContent!.trim() === label)
  const lastSave = async () => {
    await new Promise((r) => setTimeout(r, 800))
    await flushPromises()
    return vi.mocked(saveConfig).mock.calls.at(-1)?.[0]
  }
  async function openDrawer(w: VueWrapper) {
    await w.find('.drawer-btn').trigger('click')
    await flushPromises()
  }
  async function openRowMenu(name: string) {
    const more = drawerRow(name).parentElement!.querySelector<HTMLElement>('.dr-more')!
    more.click()
    await flushPromises()
    return more
  }

  it('☰ opens the whole tree: ★ Overview, groups with badges and counts, drill pages under their page', async () => {
    const w = await mountApp('d-reddit')
    expect(w.find('.drawer-btn').attributes('aria-label')).toBe('Open pages (Best Sudoku)')
    await openDrawer(w)
    expect(drawer()!.getAttribute('role')).toBe('dialog')
    expect(w.find('.drawer-btn').attributes('aria-expanded')).toBe('true')
    const groups = Array.from(drawer()!.querySelectorAll('.dr-gbtn')).map((g) => ['.group-badge', '.nm', '.cnt'].map((c) => g.querySelector(c)!.textContent!.trim()))
    expect(groups).toEqual([
      ['AS', 'All sites', '1'],
      ['BS', 'Best Sudoku', '4'],
      ['MI', 'Mine', '4'],
    ])
    expect(drawerRows().map((r) => [rowName(r), r.classList.contains('kid')])).toEqual([
      ['Overview', false],
      ['Beacon', false],
      ['Overview', false],
      ['Campaigns', false],
      ['Pop-ups', false],
      ['Traffic', false],
      ['mobile', true],
      ['reddit.com', true],
      ['mobile › California', true],
      ['goodstuffsoftware.com', false],
      ['/products/best-sudoku-beta/', false],
      ['Copy of Best Sudoku launch', false],
      ['4 sites · New', false],
    ])
    // focus lands on the page on screen
    expect(document.activeElement).toBe(drawerRow('reddit.com'))
  })

  it('Esc or the scrim closes it and focus returns to ☰; picking a page closes it and goes there', async () => {
    const w = await mountApp()
    await openDrawer(w)
    await key(document.activeElement!, 'Escape')
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(w.find('.drawer-btn').element)
    await openDrawer(w)
    ;(document.querySelector('.dr-scrim') as HTMLElement).click()
    await flushPromises()
    expect(drawer()).toBeNull()
    await openDrawer(w)
    drawerRow('Campaigns').click()
    await flushPromises()
    expect(drawer()).toBeNull()
    expect(shownPage(w)).toBe('Campaigns')
    // the filter bar stays hidden on Campaigns (found by id)
    expect(w.find('.filterbar-inflow').exists()).toBe(false)
  })

  it('/ works over the drawer, and picking a result closes both', async () => {
    const w = await mountApp()
    await openDrawer(w)
    await key(document.activeElement!, '/')
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[role="dialog"][aria-label="Search pages"] input')!
    input.value = 'pop-ups'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await key(input, 'Enter')
    expect(drawer()).toBeNull()
    expect(shownPage(w)).toBe('Pop-ups')
  })

  it('Tab stays inside the drawer', async () => {
    const w = await mountApp()
    await openDrawer(w)
    const focusables = Array.from(drawer()!.querySelectorAll<HTMLElement>('button'))
    focusables.at(-1)!.focus()
    await key(document.activeElement!, 'Tab')
    expect(document.activeElement).toBe(focusables[0])
  })

  it('a group collapses (remembered in this browser); the group of the page on screen stays open', async () => {
    const w = await mountApp('bsk-launch')
    await openDrawer(w)
    const mine = Array.from(drawer()!.querySelectorAll<HTMLElement>('.dr-gbtn')).find((g) => g.textContent!.includes('Mine'))!
    mine.click()
    await flushPromises()
    expect(mine.getAttribute('aria-expanded')).toBe('false')
    expect(drawerRows().some((r) => rowName(r) === 'goodstuffsoftware.com')).toBe(false)
    expect(JSON.parse(localStorage.getItem(VIEWER_PREFS_KEY)!).collapsed).toEqual(['Mine'])
    const bs = Array.from(drawer()!.querySelectorAll<HTMLElement>('.dr-gbtn')).find((g) => g.textContent!.includes('Best Sudoku'))!
    bs.click()
    await flushPromises()
    expect(bs.getAttribute('aria-expanded')).toBe('true') // Traffic is on screen
  })

  it("page ⋯ menu: ★ Overview can't be moved or deleted; a page with drill pages says how many go with it", async () => {
    const w = await mountApp()
    await openDrawer(w)
    await openRowMenu('Overview')
    // opened from the (modal) drawer, the menu lives inside it, not outside the modal
    expect(drawer()!.contains(document.getElementById('page-menu'))).toBe(true)
    expect(Array.from(document.querySelectorAll('#page-menu [role="menuitem"]')).map((b) => b.textContent!.trim())).toEqual(['Rename', 'Duplicate', 'Change icon…', 'Restore default charts'])
    await key(document.activeElement!, 'Escape')
    await openRowMenu('Traffic')
    expect(Array.from(document.querySelectorAll('#page-menu [role="menuitem"]')).map((b) => b.textContent!.trim())).toEqual([
      'Rename',
      'Duplicate',
      'Change icon…',
      'Move to group',
      'Restore default charts',
      'Delete (+3 drill pages)',
    ])
  })

  it('delete asks once and removes the page with its drill pages; the viewer lands back on ★ Overview', async () => {
    const w = await mountApp('d-mobile')
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    await openDrawer(w)
    await openRowMenu('Traffic')
    menuItem('Delete (+3 drill pages)')!.click()
    await flushPromises()
    vi.unstubAllGlobals()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]).toEqual(['Delete "Traffic" and its 3 drill pages? This can\'t be undone.'])
    const saved = (await lastSave())!
    expect(saved.pages.filter((p) => ['bsk-launch', 'd-mobile', 'd-reddit', 'd-mobile-ca'].includes(p.id))).toEqual([])
    expect(saved.pages).toHaveLength(9)
    expect(segTexts(w)).toEqual(['Overview'])
  })

  it('declining the confirm deletes nothing; × on a drill row deletes just that drill page', async () => {
    const w = await mountApp('bsk-launch')
    vi.stubGlobal('confirm', vi.fn(() => false))
    await openDrawer(w)
    await openRowMenu('Traffic')
    menuItem('Delete (+3 drill pages)')!.click()
    await flushPromises()
    vi.stubGlobal('confirm', vi.fn(() => true))
    drawerRow('reddit.com').parentElement!.querySelector<HTMLElement>('.dr-x')!.click()
    await flushPromises()
    vi.unstubAllGlobals()
    const saved = (await lastSave())!
    expect(saved.pages.filter((p) => p.parentId === 'bsk-launch').map((p) => p.id)).toEqual(['d-mobile', 'd-mobile-ca'])
    expect(saved.pages.some((p) => p.id === 'bsk-launch')).toBe(true)
  })

  it('Move to group moves the page with its drill pages; New group… makes a group', async () => {
    const w = await mountApp()
    await openDrawer(w)
    await openRowMenu('Traffic')
    menuItem('Move to group')!.click()
    await flushPromises()
    expect(document.activeElement?.textContent?.trim()).toContain('Best Sudoku') // the current group, checked
    menuItem('Mine')!.click()
    await flushPromises()
    let saved = (await lastSave())!
    expect(saved.pages.slice(-4).map((p) => [p.id, p.group])).toEqual([
      ['bsk-launch', 'Mine'],
      ['d-mobile', 'Mine'],
      ['d-reddit', 'Mine'],
      ['d-mobile-ca', 'Mine'],
    ])
    await openRowMenu('Beacon')
    menuItem('Move to group')!.click()
    await flushPromises()
    vi.stubGlobal('prompt', vi.fn(() => '  Star   Rupture '))
    menuItem('New group…')!.click()
    await flushPromises()
    vi.unstubAllGlobals()
    saved = (await lastSave())!
    expect(saved.pages.at(-1)).toMatchObject({ id: 'beacon', group: 'Star Rupture' })
    expect(Array.from(drawer()!.querySelectorAll('.dr-gbtn .nm')).map((g) => g.textContent!.trim()).at(-1)).toBe('Star Rupture')
  })

  it('Change icon… picks an icon or goes back to Auto; Esc cancels and returns focus', async () => {
    const w = await mountApp('bsk-launch')
    const picker = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Icon for Traffic"]')
    await w.find('.page-menu-btn').trigger('click')
    menuItem('Change icon…')!.click()
    await flushPromises()
    expect(picker()).not.toBeNull()
    expect(picker()!.textContent).toContain('Would resolve to map pin, from geo charts')
    expect(picker()!.querySelector('.ip-icon[aria-pressed="true"]')!.getAttribute('aria-label')).toBe('Traffic line')
    ;(picker()!.querySelector('[aria-label="Launch"]') as HTMLElement).click()
    await flushPromises()
    expect(picker()).toBeNull()
    let saved = (await lastSave())!
    expect(saved.pages.find((p) => p.id === 'bsk-launch')!.icon).toBe('rocket')

    await w.find('.page-menu-btn').trigger('click')
    menuItem('Change icon…')!.click()
    await flushPromises()
    ;(picker()!.querySelector('.ip-auto') as HTMLElement).click()
    await flushPromises()
    saved = (await lastSave())!
    expect('icon' in saved.pages.find((p) => p.id === 'bsk-launch')!).toBe(false)

    await w.find('.page-menu-btn').trigger('click')
    menuItem('Change icon…')!.click()
    await flushPromises()
    await key(document.activeElement!, 'Escape')
    await flushPromises()
    expect(picker()).toBeNull()
    expect(document.activeElement).toBe(w.find('.page-menu-btn').element)
  })

  it("/ doesn't open search over the page menu, the icon picker, the drill menu or another modal", async () => {
    const w = await mountApp('bsk-launch')
    const search = () => document.querySelector('[role="dialog"][aria-label="Search pages"]')
    // page menu
    await w.find('.page-menu-btn').trigger('click')
    await flushPromises()
    expect(document.getElementById('page-menu')).not.toBeNull()
    await key(document.body, '/')
    expect(search()).toBeNull()
    // icon picker
    menuItem('Change icon…')!.click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"][aria-label="Icon for Traffic"]')).not.toBeNull()
    await key(document.body, '/')
    expect(search()).toBeNull()
    await key(document.activeElement!, 'Escape')
    // drill menu
    w.findComponent(Dashboard).vm.$emit('drill', { widgetId: 'bsk-device', dimension: 'device', dataset: 'geo', value: 'mobile', label: 'mobile', x: 10, y: 10 })
    await flushPromises()
    expect(document.querySelector('.drill-act')).not.toBeNull()
    await key(document.body, '/')
    expect(search()).toBeNull()
    document.body.click() // an outside click closes it
    await flushPromises()
    expect(document.querySelector('.drill-act')).toBeNull()
    // any other open modal dialog
    const other = document.createElement('div')
    other.setAttribute('role', 'dialog')
    other.setAttribute('aria-modal', 'true')
    document.body.appendChild(other)
    await key(document.body, '/')
    expect(search()).toBeNull()
    other.remove()
    // with all of them closed, / opens the search again
    await key(document.body, '/')
    expect(search()).not.toBeNull()
  })
})
