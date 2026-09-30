import { describe, expect, it } from 'vitest'
import { applyGroupDraft, applyPageDraft, buildPage, groupStepError, movablePages, newGroupDraft, newPageDraft, pageStepError, PAGE_TEMPLATES, WIZARDS } from './wizards'
import { defaultBeaconWidgets, defaultConfig } from './defaults'
import type { DashboardPage } from '../types'

const cfg = () => {
  const c = defaultConfig()
  const launch = c.pages.find((p) => p.id === 'bsk-launch')!
  c.pages.push({ ...launch, id: 'kid', name: 'mobile', parentId: 'bsk-launch', widgets: [] })
  return c
}
const groups = ['All sites', 'Best Sudoku']

describe('the wizard registry', () => {
  it('offers a page and a group, three steps each', () => {
    expect(WIZARDS.map((w) => [w.id, w.steps.map((s) => s.id)])).toEqual([
      ['page', ['name', 'group', 'start']],
      ['group', ['name', 'pages', 'review']],
    ])
  })
})

describe('new page', () => {
  it('each step says why it is not complete yet', () => {
    const d = newPageDraft('Mine')
    expect(pageStepError('name', d, groups)).toBe('Give the page a name.')
    expect(pageStepError('name', { ...d, name: ' x ' }, groups)).toBeNull()
    expect(pageStepError('group', d, groups)).toBe('Pick a group.') // "Mine" isn't a group here
    expect(pageStepError('group', { ...d, group: 'Best Sudoku' }, groups)).toBeNull()
    expect(pageStepError('group', { ...d, groupMode: 'new', newGroup: 'best sudoku' }, groups)).toBe('There\'s already a group called "Best Sudoku".')
    expect(pageStepError('group', { ...d, groupMode: 'new', newGroup: 'Star Rupture' }, groups)).toBeNull()
    expect(pageStepError('start', { ...d, start: 'nope' }, groups)).toBe('Pick what to start from.')
  })
  it('builds a blank page, a copy of the page on screen, or a built-in\'s default charts — always top-level, fresh ids', () => {
    const c = cfg()
    const kid = c.pages.find((p) => p.id === 'kid')!
    const base = { ...newPageDraft('Mine'), name: '  Retention  ' }
    const blank = buildPage(base, kid)
    expect(blank).toMatchObject({ name: 'Retention', group: 'Mine', isDefault: false, widgets: [] })
    const copy = buildPage({ ...base, start: 'duplicate', icon: 'rocket' }, c.pages[0])
    expect(copy.widgets.map((w) => w.title)).toEqual(c.pages[0].widgets.map((w) => w.title))
    expect(copy.widgets[0].id).not.toBe(c.pages[0].widgets[0].id)
    expect(copy.icon).toBe('rocket')
    const fromDrill = buildPage({ ...base, start: 'duplicate' }, kid)
    expect(fromDrill.parentId).toBeUndefined()
    const tpl = buildPage({ ...base, start: 'tpl-beacon' }, kid)
    expect(tpl.widgets.map((w) => w.title)).toEqual(defaultBeaconWidgets().map((w) => w.title))
    expect(tpl.id).not.toBe('beacon')
    expect(PAGE_TEMPLATES.every((t) => buildPage({ ...base, start: t.id }, kid).widgets.length > 0)).toBe(true)
  })
  it('Create: the page goes after its group\'s pages; a new group is listed last', () => {
    const c = cfg()
    const { result, page } = applyPageDraft(c, { ...newPageDraft('All sites'), name: 'X' }, c.pages[0])
    expect(result.pages.map((p) => p.id).indexOf(page.id)).toBe(2) // after Overview and Beacon
    expect(result.groupOrder).toEqual(['All sites', 'Best Sudoku'])
    const fresh = applyPageDraft(c, { ...newPageDraft('All sites'), name: 'Y', groupMode: 'new', newGroup: ' Star  Rupture ' }, c.pages[0])
    expect(fresh.page.group).toBe('Star Rupture')
    expect(fresh.result.pages.at(-1)!.id).toBe(fresh.page.id)
    expect(fresh.result.groupOrder).toEqual(['All sites', 'Best Sudoku', 'Star Rupture'])
  })
})

describe('new group', () => {
  it('needs a unique name; picking pages is optional', () => {
    const d = newGroupDraft()
    expect(groupStepError('name', d, groups)).toBe('Give the group a name.')
    expect(groupStepError('name', { ...d, name: 'ALL SITES' }, groups)).toBe('There\'s already a group called "All sites".')
    expect(groupStepError('pages', d, groups)).toBeNull()
  })
  it('offers every top-level page but ★ Overview', () => {
    const c = cfg()
    expect(movablePages(c.pages).map((p: DashboardPage) => p.id)).toEqual(['beacon', 'bsk-overview', 'bsk-campaigns', 'bsk-popups', 'bsk-launch'])
  })
  it('Create lists the group (even empty) and moves the picked pages with their drill pages', () => {
    const c = cfg()
    const r = applyGroupDraft(c, { name: 'Launch', pageIds: ['bsk-launch', 'default'] })!
    expect(r.groupOrder).toEqual(['All sites', 'Best Sudoku', 'Launch'])
    expect(r.pages.filter((p) => p.group === 'Launch').map((p) => p.id)).toEqual(['bsk-launch', 'kid'])
    expect(r.pages.find((p) => p.id === 'default')!.group).toBe('All sites')
    expect(applyGroupDraft(c, { name: 'Empty', pageIds: [] })!.groupOrder).toEqual(['All sites', 'Best Sudoku', 'Empty'])
    expect(applyGroupDraft(c, { name: 'best sudoku', pageIds: [] })).toBeNull()
  })
})
