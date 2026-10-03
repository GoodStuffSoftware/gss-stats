// @vitest-environment happy-dom
//
// Page navigation, second round (layout version 13): nested drill pages (Traffic › mobile ›
// California › Los Angeles) in the drawer, the breadcrumb and the search; renaming in place (one
// config behind every name on screen); group headers with their ⋯ menu and Delete group; the "+ New"
// wizards. Driven through the real App against the sanitised production layout.
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
  c.groupMeta = { 'Best Sudoku': { color: 'g3' } }
  return JSON.parse(JSON.stringify(c))
}
const mounted: VueWrapper[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  ;(window as any).innerWidth = 1024
})

// No real network from a mounted App: every endpoint it can reach answers from the stub (src/testing/appFetch.ts).
beforeEach(() => {
  stubAppFetch()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
beforeEach(() => {
  localStorage.clear()
  vi.mocked(saveConfig).mockClear()
  vi.mocked(loadConfig).mockImplementation(async () => stored())
})
async function mountApp(active?: string) {
  if (active) localStorage.setItem(VIEWER_PREFS_KEY, JSON.stringify({ active }))
  const w = mount(App, { attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  return w
}
async function key(el: Element, k: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  await flushPromises()
}
async function typeInto(input: HTMLInputElement, text: string) {
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}
const lastSave = async () => {
  await vi.advanceTimersByTimeAsync(800)
  await flushPromises()
  return vi.mocked(saveConfig).mock.calls.at(-1)?.[0]
}
const segTexts = (w: VueWrapper) => w.findAll('nav.crumbs .seg').map((s) => s.text())
const shownPage = (w: VueWrapper) => w.find('.foot').text().split(' · ')[0]
const drawer = () => document.getElementById('nav-drawer')
const drawerRows = () => Array.from(drawer()?.querySelectorAll<HTMLElement>('.dr-item') ?? [])
const rowName = (li: HTMLElement) => li.querySelector('.dr-page .nm')?.textContent!.trim() ?? ''
const drawerRow = (name: string) => drawerRows().find((li) => rowName(li) === name)!
const groupHeader = (name: string) => Array.from(drawer()!.querySelectorAll<HTMLElement>('.dr-gh')).find((g) => g.querySelector('.nm')?.textContent!.trim() === name)!
const items = (menuId: string) => Array.from(document.querySelectorAll<HTMLElement>(`#${menuId} [role="menuitem"], #${menuId} [role="menuitemradio"]`))
const itemTexts = (menuId: string) => items(menuId).map((b) => b.textContent!.replace(/\s+/g, ' ').trim())
const item = (menuId: string, label: string) => items(menuId).find((b) => (b.querySelector('.nm') ?? b).textContent!.trim() === label)!
async function openDrawer(w: VueWrapper) {
  await w.find('.drawer-btn').trigger('click')
  await flushPromises()
}
async function search(text: string) {
  await key(document.body, '/')
  const input = document.querySelector<HTMLInputElement>('[role="dialog"][aria-label="Search pages"] input')!
  await typeInto(input, text)
  const names = Array.from(document.querySelectorAll('#nav-search-list [role="option"] .nm')).map((n) => n.textContent!.replace(/\s+/g, ' ').trim())
  await key(input, 'Escape')
  return names
}

describe('nested drill pages', () => {
  it('the drawer indents group > page > drill > drill, ★ Overview unindented', async () => {
    const w = await mountApp('d-la')
    await openDrawer(w)
    const depth = (name: string) => drawerRow(name).style.getPropertyValue('--depth')
    expect(depth('Overview')).toBe('0')
    expect(['Traffic', 'mobile', 'California', 'Los Angeles', 'reddit.com'].map(depth)).toEqual(['1', '2', '3', '4', '2'])
    expect(depth('goodstuffsoftware.com')).toBe('1')
    expect(drawerRows().map(rowName).slice(4, 10)).toEqual(['Pop-ups', 'Traffic', 'mobile', 'California', 'Los Angeles', 'reddit.com'])
  })

  it('a page with drill pages folds them away (remembered in this browser); the path to the page on screen stays open', async () => {
    const w = await mountApp('bsk-launch')
    await openDrawer(w)
    const fold = drawerRow('mobile').querySelector<HTMLElement>('.dr-fold')!
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    fold.click()
    await flushPromises()
    expect(drawerRows().map(rowName)).not.toContain('California')
    expect(drawerRow('mobile').querySelector('.dr-fold')!.getAttribute('aria-expanded')).toBe('false')
    expect(JSON.parse(localStorage.getItem(VIEWER_PREFS_KEY)!).collapsedPages).toEqual(['d-mobile'])
    w.unmount()
    mounted.length = 0
    const w2 = await mountApp('d-la') // on Los Angeles: its whole path shows, folded or not
    await openDrawer(w2)
    expect(drawerRows().map(rowName)).toContain('Los Angeles')
  })

  it('the breadcrumb shows the whole path; each drill segment lists its siblings, its own drill pages and the way back', async () => {
    const w = await mountApp('d-ca')
    expect(segTexts(w)).toEqual(['BSBest Sudoku', 'Traffic', 'mobile', 'California'])
    await w.findAll('nav.crumbs .seg')[2].trigger('click') // mobile
    expect(itemTexts('crumb-drills')).toEqual(['mobile', 'California', 'Los Angeles', 'reddit.com', 'Back to Traffic'])
    await key(document.activeElement!, 'Escape')
    await w.findAll('nav.crumbs .seg')[3].trigger('click') // California
    expect(itemTexts('crumb-drills')).toEqual(['California', 'Los Angeles', 'Back to mobile'])
    item('crumb-drills', 'Los Angeles').click()
    await flushPromises()
    expect(shownPage(w)).toBe('Los Angeles')
  })

  it('on a phone the middle of the path folds into "…", which lists it', async () => {
    ;(window as any).innerWidth = 375
    const w = await mountApp('d-la')
    expect(segTexts(w)).toEqual(['BSBest Sudoku', '…', 'Los Angeles']) // (the badge is hidden on a phone: ☰ carries it)
    await w.find('nav.crumbs .seg.more').trigger('click')
    expect(itemTexts('crumb-more')).toEqual(['Traffic', 'mobile', 'California'])
    item('crumb-more', 'mobile').click()
    await flushPromises()
    expect(shownPage(w)).toBe('mobile')
    expect(segTexts(w)).toEqual(['BSBest Sudoku', '…', 'mobile'])
  })

  it('the search shows a drill page\'s path', async () => {
    await mountApp()
    expect(await search('los')).toEqual(['Traffic › mobile › California › Los Angeles'])
  })

  it('deleting a drill page deletes everything under it, asked once with the count', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const w = await mountApp('d-la')
    await openDrawer(w)
    drawerRow('mobile').querySelector<HTMLElement>('.dr-more')!.click()
    await flushPromises()
    expect(item('page-menu', 'Delete (+2 drill pages)')).toBeTruthy()
    item('page-menu', 'Delete (+2 drill pages)').click()
    await flushPromises()
    expect(confirm.mock.calls[0]).toEqual(['Delete "mobile" and its 2 drill pages? This can\'t be undone.'])
    const saved = (await lastSave())!
    expect(saved.pages.filter((p) => p.parentId).map((p) => p.id)).toEqual(['d-reddit'])
    expect(shownPage(w)).toBe('Traffic')
  })
})

describe('a drill page\'s ⋯ menu', () => {
  it('is the same page menu; Move to group makes it a page of its own there, with its drill pages', async () => {
    const w = await mountApp('d-ca')
    await openDrawer(w)
    const more = drawerRow('California').querySelector<HTMLElement>('.dr-more')!
    expect(more.getAttribute('aria-haspopup')).toBe('menu')
    more.click()
    await flushPromises()
    expect(itemTexts('page-menu')).toEqual(['Rename', 'Duplicate', 'Change icon…', 'Move to group', 'Restore default charts', 'Delete (+1 drill page)'])
    item('page-menu', 'Move to group').click()
    await flushPromises()
    // a drill page is in no group of its own yet: none is checked
    expect(items('page-menu').filter((b) => b.getAttribute('aria-checked') === 'true')).toEqual([])
    item('page-menu', 'Mine').click()
    await flushPromises()
    const saved = (await lastSave())!
    const moved = saved.pages.filter((p) => ['d-ca', 'd-la', 'd-mobile'].includes(p.id)).map((p) => [p.id, p.group, p.parentId ?? null])
    expect(moved).toEqual([
      ['d-ca', 'Mine', null],
      ['d-la', 'Mine', 'd-ca'],
      ['d-mobile', 'Best Sudoku', 'bsk-launch'],
    ])
    // placed after the pages already in Mine
    expect(saved.pages.map((p) => p.id).indexOf('d-ca')).toBe(saved.pages.map((p) => p.id).indexOf('7fc55dff') + 1)
    // its icon is its own now (from its charts), without the drill mark; the breadcrumb follows
    const icon = drawerRow('California').querySelector('.page-icon')!
    expect(icon.classList.contains('drill')).toBe(false)
    expect(icon.getAttribute('data-icon')).toBe('map-pin')
    expect(segTexts(w)).toEqual(['MIMine', 'California'])
  })
})

describe('renaming in place — every name comes from the one config', () => {
  it('a page renamed in the breadcrumb shows in the drawer, the search and the tab title at once', async () => {
    const w = await mountApp('bsk-launch')
    expect(document.title).toBe('Traffic · Best Sudoku · GSS Stats')
    await w.findAll('nav.crumbs .seg')[1].trigger('dblclick')
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('nav.crumbs .seg.editing input')!
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('Traffic')
    await typeInto(input, '  Launch   traffic ')
    await key(input, 'Enter')
    expect(segTexts(w)).toEqual(['BSBest Sudoku', 'Launch traffic'])
    expect(document.title).toBe('Launch traffic · Best Sudoku · GSS Stats')
    expect(shownPage(w)).toBe('Launch traffic')
    expect(document.activeElement).toBe(w.findAll('nav.crumbs .seg')[1].element)
    await openDrawer(w)
    expect(drawerRow('Launch traffic')).toBeTruthy()
    await key(drawer()!, 'Escape')
    expect(await search('launch tr')).toEqual(['Launch traffic'])
    expect((await lastSave())!.pages.find((p) => p.id === 'bsk-launch')!.name).toBe('Launch traffic')
  })

  it('a page renamed in the drawer shows in the breadcrumb and the tab title; Esc and an empty name change nothing', async () => {
    const w = await mountApp('d-ca')
    await openDrawer(w)
    drawerRow('mobile').querySelector<HTMLElement>('.dr-more')!.click()
    await flushPromises()
    item('page-menu', 'Rename').click()
    await flushPromises()
    let input = drawerRow('').querySelector<HTMLInputElement>('input')!
    expect(document.activeElement).toBe(input)
    await typeInto(input, 'phones')
    await key(input, 'Escape')
    expect(drawer()).not.toBeNull() // Esc only cancels the rename
    expect(segTexts(w)).toEqual(['BSBest Sudoku', 'Traffic', 'mobile', 'California'])
    drawerRow('mobile').querySelector<HTMLElement>('.dr-more')!.click()
    await flushPromises()
    item('page-menu', 'Rename').click()
    await flushPromises()
    input = drawerRow('').querySelector<HTMLInputElement>('input')!
    await typeInto(input, '   ')
    await key(input, 'Enter')
    expect(drawerRow('mobile')).toBeTruthy()
    drawerRow('mobile').querySelector<HTMLElement>('.dr-more')!.click()
    await flushPromises()
    item('page-menu', 'Rename').click()
    await flushPromises()
    input = drawerRow('').querySelector<HTMLInputElement>('input')!
    await typeInto(input, 'phones')
    input.dispatchEvent(new Event('blur')) // leaving the field saves
    await flushPromises()
    expect(segTexts(w)).toEqual(['BSBest Sudoku', 'Traffic', 'phones', 'California'])
    expect(document.title).toBe('Traffic › phones › California · Best Sudoku · GSS Stats')
    expect(drawerRow('phones')).toBeTruthy()
  })

  it('a group renamed in the breadcrumb renames it in the drawer; another group\'s name is refused inline', async () => {
    const w = await mountApp('bsk-popups')
    await w.findAll('nav.crumbs .seg')[0].trigger('dblclick')
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('nav.crumbs .seg.editing input')!
    expect(input.value).toBe('Best Sudoku')
    await typeInto(input, 'mine')
    await key(input, 'Enter')
    expect(document.querySelector('nav.crumbs [role="alert"]')!.textContent).toBe('There\'s already a group called "Mine".')
    expect(document.activeElement).toBe(input) // still editing
    await typeInto(input, 'BS Games')
    await key(input, 'Enter')
    expect(segTexts(w)).toEqual(['BGBS Games', 'Pop-ups'])
    expect(document.title).toBe('Pop-ups · BS Games · GSS Stats')
    await openDrawer(w)
    expect(groupHeader('BS Games')).toBeTruthy()
    expect(Array.from(drawer()!.querySelectorAll('.dr-gh .nm')).map((n) => n.textContent!.trim())).toEqual(['All sites', 'BS Games', 'Mine'])
    const saved = (await lastSave())!
    expect(saved.pages.filter((p) => p.group === 'BS Games')).toHaveLength(8)
    expect(saved.pages.some((p) => p.group === 'Best Sudoku')).toBe(false)
    expect(saved.groupOrder).toEqual(['All sites', 'BS Games', 'Mine'])
    expect(saved.groupMeta).toEqual({ 'BS Games': { color: 'g3' } })
  })

  it('a group renamed in the drawer (its ⋯ menu) shows in the breadcrumb', async () => {
    const w = await mountApp('bsk-launch')
    await openDrawer(w)
    const more = groupHeader('Best Sudoku').querySelector<HTMLElement>('.dr-gmore')!
    more.click()
    await flushPromises()
    item('group-menu', 'Rename').click()
    await flushPromises()
    const input = drawer()!.querySelector<HTMLInputElement>('.dr-gh input')!
    expect(document.activeElement).toBe(input)
    await typeInto(input, 'Sudoku')
    await key(input, 'Enter')
    expect(segTexts(w)).toEqual(['SUSudoku', 'Traffic'])
    expect(document.activeElement).toBe(groupHeader('Sudoku').querySelector('.dr-gbtn'))
  })
})

describe('group headers in the drawer', () => {
  it('have a ⋯ menu button left of the page count: Rename, New page in this group, Delete group…', async () => {
    const w = await mountApp()
    await openDrawer(w)
    const gh = groupHeader('Mine')
    const kids = Array.from(gh.children).map((c) => c.className.split(' ')[0])
    expect(kids).toEqual(['dr-gh-h', 'dr-gmore', 'cnt'])
    const more = gh.querySelector<HTMLElement>('.dr-gmore')!
    expect(more.getAttribute('aria-label')).toBe('Group options: Mine')
    expect(more.getAttribute('aria-haspopup')).toBe('menu')
    more.click()
    await flushPromises()
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById('group-menu')!.getAttribute('role')).toBe('menu')
    expect(drawer()!.contains(document.getElementById('group-menu'))).toBe(true)
    expect(itemTexts('group-menu')).toEqual(['Rename', 'New page in this group', 'Delete group…4 pages'])
    expect(document.activeElement).toBe(items('group-menu')[0])
    await key(document.activeElement!, 'Escape')
    expect(document.getElementById('group-menu')).toBeNull()
    expect(document.activeElement).toBe(more)
  })

  it('Delete group… says how many pages go and where (Mine by default); ★ Overview stays', async () => {
    const w = await mountApp('bsk-launch')
    await openDrawer(w)
    groupHeader('All sites').querySelector<HTMLElement>('.dr-gmore')!.click()
    await flushPromises()
    item('group-menu', 'Delete group…').click()
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="dg-title"]')!
    expect(dialog.textContent).toContain('It holds 1 page. They move to:')
    const radios = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ['Best Sudoku', false],
      ['Mine', true],
    ])
    radios[0].click()
    await flushPromises()
    Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Delete group')!.click()
    await flushPromises()
    expect(document.querySelector('[aria-labelledby="dg-title"]')).toBeNull()
    const saved = (await lastSave())!
    expect(saved.pages.find((p) => p.id === 'beacon')!.group).toBe('Best Sudoku')
    expect(saved.pages.find((p) => p.id === 'default')).toMatchObject({ isDefault: true, group: 'All sites' })
    expect(saved.groupOrder).toEqual(['Best Sudoku', 'Mine'])
    expect(Array.from(drawer()!.querySelectorAll('.dr-gh .nm')).map((n) => n.textContent!.trim())).toEqual(['Best Sudoku', 'Mine'])
    expect(drawer()!.querySelector('.dr-page .nm')!.textContent).toBe('Overview') // still pinned first
  })

  it('deleting Mine offers the first other group; Esc cancels', async () => {
    const w = await mountApp()
    await openDrawer(w)
    groupHeader('Mine').querySelector<HTMLElement>('.dr-gmore')!.click()
    await flushPromises()
    item('group-menu', 'Delete group…').click()
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[aria-labelledby="dg-title"]')!
    expect(dialog.querySelector<HTMLInputElement>('input:checked')!.value).toBe('All sites')
    await key(document.activeElement!, 'Escape')
    expect(document.querySelector('[aria-labelledby="dg-title"]')).toBeNull()
    expect(drawer()).not.toBeNull()
    expect(groupHeader('Mine')).toBeTruthy()
  })
})

describe('"+ New" wizards', () => {
  const newBtn = () => drawer()!.querySelector<HTMLElement>('.wz-new')!
  const fwd = () => drawer()!.querySelector<HTMLButtonElement>('.wz-fwd, .wz-create')!
  const step = () => drawer()!.querySelector<HTMLElement>('.wz-step.current')!
  const stepTitle = () => drawer()!.querySelector('.wz-step-title')!.textContent!.trim()

  it('"+ New" opens a menu of what to create; Esc closes it, and focus goes back', async () => {
    const w = await mountApp()
    await openDrawer(w)
    expect(drawer()!.textContent).not.toContain('New page\n')
    newBtn().click()
    await flushPromises()
    expect(newBtn().getAttribute('aria-expanded')).toBe('true')
    expect(itemTexts('drawer-new-types')).toEqual(['PageA page of charts, in any group', 'GroupA group to file pages under'])
    expect(document.activeElement).toBe(items('drawer-new-types')[0])
    await key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(items('drawer-new-types')[1])
    await key(document.activeElement!, 'Escape')
    expect(document.getElementById('drawer-new-types')).toBeNull()
    expect(drawer()).not.toBeNull()
    expect(document.activeElement).toBe(newBtn())
  })

  it('a new page: name, group (a new one named inline), start from a built-in\'s charts; Create opens it', async () => {
    const w = await mountApp()
    await openDrawer(w)
    newBtn().click()
    await flushPromises()
    items('drawer-new-types')[0].click()
    await flushPromises()
    expect(stepTitle()).toBe('1/3 · Name')
    const name = step().querySelector<HTMLInputElement>('input')!
    expect(document.activeElement).toBe(name)
    expect(fwd().disabled).toBe(true)
    await typeInto(name, '   ')
    expect(step().textContent).toContain('Give the page a name.')
    await typeInto(name, 'Retention')
    expect(fwd().disabled).toBe(false)
    await key(name, 'Enter') // Enter moves on
    expect(stepTitle()).toBe('2/3 · Group')
    const groupStep = step()
    const radios = Array.from(groupStep.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    expect(radios.map((r) => r.value)).toEqual(['All sites', 'Best Sudoku', 'Mine', '__new__'])
    radios[3].click()
    await flushPromises()
    const newGroup = step().querySelector<HTMLInputElement>('#wz-page-newgroup')!
    expect(fwd().disabled).toBe(true)
    await typeInto(newGroup, 'best sudoku')
    expect(step().textContent).toContain('There\'s already a group called "Best Sudoku".')
    expect(fwd().disabled).toBe(true)
    await typeInto(newGroup, 'Star Rupture')
    fwd().click()
    await flushPromises()
    expect(stepTitle()).toBe('3/3 · Start from')
    expect(fwd().textContent!.trim()).toBe('Create')
    const tpl = Array.from(step().querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) => r.value === 'tpl-beacon')!
    tpl.click()
    await flushPromises()
    expect(step().querySelector('.wf-icon-now')!.textContent!.trim()).toBe('Auto: map pin')
    fwd().click()
    await flushPromises()
    expect(drawer()).toBeNull()
    expect(segTexts(w)).toEqual(['SRStar Rupture', 'Retention'])
    const saved = (await lastSave())!
    const made = saved.pages.at(-1)!
    expect(made).toMatchObject({ name: 'Retention', group: 'Star Rupture', isDefault: false })
    expect(made.parentId).toBeUndefined()
    expect(made.widgets.length).toBeGreaterThan(0)
    expect(made.widgets.every((wd) => wd.dataset === 'geo' || wd.type === 'note')).toBe(true)
    expect(saved.groupOrder).toEqual(['All sites', 'Best Sudoku', 'Mine', 'Star Rupture'])
  })

  it('"New page in this group" starts the page wizard with that group picked; Back returns, Esc resets', async () => {
    const w = await mountApp()
    await openDrawer(w)
    groupHeader('Mine').querySelector<HTMLElement>('.dr-gmore')!.click()
    await flushPromises()
    item('group-menu', 'New page in this group').click()
    await flushPromises()
    expect(stepTitle()).toBe('1/3 · Name')
    await typeInto(step().querySelector<HTMLInputElement>('input')!, 'Notes')
    fwd().click()
    await flushPromises()
    expect(step().querySelector<HTMLInputElement>('input:checked')!.value).toBe('Mine')
    expect(document.activeElement).toBe(step().querySelector('input:checked'))
    drawer()!.querySelector<HTMLElement>('.wz-back')!.click()
    await flushPromises()
    expect(stepTitle()).toBe('1/3 · Name')
    expect(step().querySelector<HTMLInputElement>('input')!.value).toBe('Notes')
    await key(document.activeElement!, 'Escape')
    expect(drawer()!.querySelector('.wz-run')).toBeNull()
    expect(drawer()).not.toBeNull()
    expect(document.activeElement).toBe(newBtn())
    expect(vi.mocked(saveConfig)).not.toHaveBeenCalled()
  })

  it('a new group: a unique name, pages to move in (optional), a review; Create lists it and shows it', async () => {
    const w = await mountApp()
    await openDrawer(w)
    newBtn().click()
    await flushPromises()
    items('drawer-new-types')[1].click()
    await flushPromises()
    const name = step().querySelector<HTMLInputElement>('input')!
    await typeInto(name, ' MINE ')
    expect(step().textContent).toContain('There\'s already a group called "Mine".')
    expect(fwd().disabled).toBe(true)
    await typeInto(name, 'Launch')
    fwd().click()
    await flushPromises()
    expect(stepTitle()).toBe('2/3 · Pages')
    const labels = Array.from(step().querySelectorAll('label')).map((l) => l.querySelector('.nm')!.textContent!.trim())
    expect(labels).not.toContain('Overview (pinned)')
    expect(labels.slice(0, 3)).toEqual(['Beacon', 'Overview', 'Campaigns'])
    expect(step().querySelectorAll('label .page-icon')).toHaveLength(labels.length)
    Array.from(step().querySelectorAll('label')).find((l) => l.textContent!.includes('Traffic'))!.querySelector<HTMLInputElement>('input')!.click()
    await flushPromises()
    fwd().click()
    await flushPromises()
    expect(stepTitle()).toBe('3/3 · Review')
    expect(step().textContent).toContain('1 page move here:')
    expect(step().textContent).toContain('Trafficfrom Best Sudoku')
    fwd().click()
    await flushPromises()
    expect(drawer()).not.toBeNull() // stays open, showing the new group
    const sec = drawer()!.querySelector<HTMLElement>('[data-group="Launch"]')!
    expect(sec.classList.contains('flash')).toBe(true)
    expect(document.activeElement).toBe(sec.querySelector('.dr-gbtn'))
    const saved = (await lastSave())!
    expect(saved.groupOrder).toEqual(['All sites', 'Best Sudoku', 'Mine', 'Launch'])
    expect(saved.pages.filter((p) => p.group === 'Launch').map((p) => p.id)).toEqual(['bsk-launch', 'd-mobile', 'd-ca', 'd-la', 'd-reddit'])
  })

  it('an empty new group exists (with no page in it) and survives a reload', async () => {
    const w = await mountApp()
    await openDrawer(w)
    newBtn().click()
    await flushPromises()
    items('drawer-new-types')[1].click()
    await flushPromises()
    await typeInto(step().querySelector<HTMLInputElement>('input')!, 'Later')
    fwd().click()
    await flushPromises()
    fwd().click()
    await flushPromises()
    expect(step().textContent).toContain('An empty group.')
    fwd().click()
    await flushPromises()
    expect(groupHeader('Later').querySelector('.cnt')!.textContent).toBe('0')
    expect(drawer()!.querySelector('[data-group="Later"] .dr-empty')!.textContent).toBe('No pages yet')
    const saved = (await lastSave())!
    expect(saved.groupOrder).toEqual(['All sites', 'Best Sudoku', 'Mine', 'Later'])
    expect(normalizeConfig(JSON.parse(JSON.stringify(saved))).groupOrder).toEqual(['All sites', 'Best Sudoku', 'Mine', 'Later'])
  })
})
