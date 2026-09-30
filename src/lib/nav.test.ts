import { describe, expect, it } from 'vitest'
import {
  addGroup,
  ancestorsOf,
  childrenOf,
  deleteGroup,
  deleteGroupTargets,
  depthOf,
  descendantsOf,
  drillParentFor,
  drillTrail,
  groupLandingPage,
  groupNameError,
  groupNames,
  highlightParts,
  insertPageInGroup,
  landingAfterDelete,
  movePageToGroup,
  navOrder,
  navTree,
  orderedGroups,
  pageNameError,
  pagesToDelete,
  parentOf,
  pathLabel,
  pathOf,
  renameGroup,
  rootOf,
  rootsInGroup,
  searchPages,
  type NavNode,
} from './nav'
import { MAX_DRILL_DEPTH } from './defaults'
import type { DashboardPage, GlobalFilters } from '../types'

const f = (over: Partial<GlobalFilters> = {}): GlobalFilters => ({
  siteSel: [],
  since: '2026-09-01T00:00:00.000Z',
  until: '2026-09-08T00:00:00.000Z',
  rangeRel: '7d',
  excludeSelfReferrals: true,
  excludeOwnVisits: true,
  ownBrowser: '',
  ownOS: '',
  ...over,
})
const page = (id: string, over: Partial<DashboardPage> = {}): DashboardPage => ({ id, name: id, isDefault: false, group: 'Mine', filters: f(), widgets: [], ...over })
const label = (t: string) => `<${t}>`

describe('drill tree helpers', () => {
  const pages = [page('default', { isDefault: true }), page('t'), page('k1', { parentId: 't' }), page('k2', { parentId: 't' }), page('stale', { parentId: 'gone' })]
  it('parentOf / rootOf follow a drill page to its root; a root (or a stale link) is its own root', () => {
    expect(parentOf(pages[2], pages)?.id).toBe('t')
    expect(rootOf(pages[2], pages).id).toBe('t')
    expect(rootOf(pages[1], pages).id).toBe('t')
    expect(parentOf(pages[4], pages)).toBeUndefined()
    expect(rootOf(pages[4], pages).id).toBe('stale')
  })
  it('childrenOf lists a page\'s own drill pages in array order', () => {
    expect(childrenOf('t', pages).map((p) => p.id)).toEqual(['k1', 'k2'])
    expect(childrenOf('default', pages)).toEqual([])
  })
})

describe('the drill tree, nested to any depth', () => {
  // Traffic › mobile › California › Los Angeles, and Traffic › reddit.com
  const pages = [
    page('default', { isDefault: true }),
    page('t', { name: 'Traffic', group: 'Best Sudoku' }),
    page('m', { name: 'mobile', parentId: 't', group: 'Best Sudoku' }),
    page('r', { name: 'reddit.com', parentId: 't', group: 'Best Sudoku' }),
    page('ca', { name: 'California', parentId: 'm', group: 'Best Sudoku' }),
    page('la', { name: 'Los Angeles', parentId: 'ca', group: 'Best Sudoku' }),
    page('x', { name: 'Other' }),
  ]
  const byId = (id: string) => pages.find((p) => p.id === id)!
  it('a drill page\'s parent is the page it was drilled from; its root the top-level page', () => {
    expect(parentOf(byId('la'), pages)?.id).toBe('ca')
    expect(ancestorsOf(byId('la'), pages).map((p) => p.id)).toEqual(['ca', 'm', 't'])
    expect(rootOf(byId('la'), pages).id).toBe('t')
    expect(pathOf(byId('la'), pages).map((p) => p.id)).toEqual(['t', 'm', 'ca', 'la'])
    expect([depthOf(byId('t'), pages), depthOf(byId('m'), pages), depthOf(byId('la'), pages)]).toEqual([0, 1, 3])
    expect(pathLabel(byId('ca'), pages)).toBe('Traffic › mobile › California')
  })
  it('descendantsOf walks the whole subtree in tree order', () => {
    expect(descendantsOf('t', pages).map((p) => p.id)).toEqual(['m', 'ca', 'la', 'r'])
    expect(descendantsOf('ca', pages).map((p) => p.id)).toEqual(['la'])
    expect(pagesToDelete('m', pages)).toEqual(['m', 'ca', 'la'])
  })
  it('navTree nests each drill page under its own parent; navOrder flattens it depth first', () => {
    const t = navTree(pages)
    const shape = (n: NavNode): unknown => [n.page.id, n.children.map(shape)]
    expect(t.groups.map((g) => [g.name, g.nodes.map(shape)])).toEqual([
      ['Best Sudoku', [['t', [['m', [['ca', [['la', []]]]]], ['r', []]]]]],
      ['Mine', [['x', []]]],
    ])
    expect(navOrder(pages).map((p) => p.id)).toEqual(['default', 't', 'm', 'ca', 'la', 'r', 'x'])
  })
  it('a loop in the links never hangs anything (normDrillLinks repairs it on load)', () => {
    const loop = [page('a', { parentId: 'b' }), page('b', { parentId: 'a' })]
    expect(ancestorsOf(loop[0], loop).map((p) => p.id)).toEqual(['b'])
    expect(descendantsOf('a', loop).map((p) => p.id)).toEqual(['b'])
    expect(rootOf(loop[0], loop).id).toBe('b')
  })
  it(`drillParentFor: the page drilled from, until it is ${MAX_DRILL_DEPTH} deep — then its parent`, () => {
    expect(drillParentFor(byId('la'), pages).id).toBe('la')
    const chain = [page('d0')]
    for (let i = 1; i <= MAX_DRILL_DEPTH; i++) chain.push(page(`d${i}`, { parentId: `d${i - 1}` }))
    expect(depthOf(chain.at(-1)!, chain)).toBe(MAX_DRILL_DEPTH)
    expect(drillParentFor(chain.at(-1)!, chain).id).toBe(`d${MAX_DRILL_DEPTH - 1}`)
    expect(drillParentFor(chain.at(-2)!, chain).id).toBe(`d${MAX_DRILL_DEPTH - 1}`)
  })
  it('landingAfterDelete: the nearest ancestor left, else the page before in the group, else its first page, else ★ Overview', () => {
    const after = (gone: string[]) => pages.filter((p) => !gone.includes(p.id))
    expect(landingAfterDelete(byId('la'), pages, after(['la']))?.id).toBe('ca')
    expect(landingAfterDelete(byId('m'), pages, after(pagesToDelete('m', pages)))?.id).toBe('t')
    const g = [page('default', { isDefault: true }), page('a'), page('b'), page('c'), page('solo', { group: 'Solo' })]
    const drop = (id: string) => g.filter((p) => p.id !== id)
    expect(landingAfterDelete(g[3], g, drop('c'))?.id).toBe('b')
    expect(landingAfterDelete(g[1], g, drop('a'))?.id).toBe('b')
    expect(landingAfterDelete(g[4], g, drop('solo'))?.id).toBe('default')
  })
  it('Move to group: a drill page becomes a page of its own there, with its own drill pages', () => {
    const out = movePageToGroup(pages, 'm', 'Mine')
    expect(out.map((p) => [p.id, p.group, p.parentId ?? null])).toEqual([
      ['default', 'Mine', null],
      ['t', 'Best Sudoku', null],
      ['r', 'Best Sudoku', 't'],
      ['x', 'Mine', null],
      ['m', 'Mine', null],
      ['ca', 'Mine', 'm'],
      ['la', 'Mine', 'ca'],
    ])
    // …even into the group it's already in
    const same = movePageToGroup(pages, 'ca', 'Best Sudoku')
    expect(same.find((p) => p.id === 'ca')!.parentId).toBeUndefined()
    expect(same.find((p) => p.id === 'la')!.parentId).toBe('ca')
    expect(pages.find((p) => p.id === 'm')!.parentId).toBe('t') // the input is not mutated
  })
})

describe('drillTrail (a drill page\'s name)', () => {
  const mobile = { key: 'device', value: 'mobile', label: 'mobile' }
  const de = { key: 'country', value: 'DE', label: 'Germany' }
  it('names a first drill by its value alone — the root\'s own site pick is not repeated', () => {
    const root = f({ siteSel: ['bestsudoku', 'bestsudoku-app'] })
    expect(drillTrail(f({ siteSel: ['bestsudoku', 'bestsudoku-app'], drill: [mobile] }), root, label)).toBe('mobile')
  })
  it('a drill from a drill page is named by its own step alone (its parent is the drill page)', () => {
    expect(drillTrail(f({ drill: [mobile, de] }), f({ drill: [mobile] }), label)).toBe('Germany')
  })
  it('what differs from the parent is joined with " › "', () => {
    expect(drillTrail(f({ drill: [mobile, de] }), f(), label)).toBe('mobile › Germany')
  })
  it('a drill that replaces a constraint on the same dimension shows only the new value', () => {
    expect(drillTrail(f({ drill: [de, { key: 'device', value: 'desktop', label: 'desktop' }] }), f(), label)).toBe('Germany › desktop')
  })
  it('a site drill names the site (or the count of sites)', () => {
    expect(drillTrail(f({ siteSel: ['stats.goodstuff.software'] }), f(), label)).toBe('<stats.goodstuff.software>')
    expect(drillTrail(f({ siteSel: ['a', 'b'], drill: [mobile] }), f(), label)).toBe('2 sites › mobile')
  })
  it('a date drill ends with the day; a later drill from it keeps the date range', () => {
    const day = f({ drill: [mobile], since: '2026-09-28T00:00:00.000Z', until: '2026-09-28T23:59:59.999Z', rangeRel: '' })
    expect(drillTrail(day, f(), label, 'Sep 28')).toBe('mobile › Sep 28')
    expect(drillTrail({ ...day, drill: [mobile, de] }, f(), label)).toBe('mobile › Germany › Sep 28 – Sep 28')
  })
  it('an absolute root range copied unchanged is not a date part', () => {
    const root = f({ since: '2026-01-01T00:00:00.000Z', rangeRel: '' })
    expect(drillTrail({ ...root, drill: [mobile] }, root, label)).toBe('mobile')
  })
  it('"Filtered" when nothing differs from the root', () => {
    expect(drillTrail(f(), f(), label)).toBe('Filtered')
  })
})

describe('the page tree', () => {
  const w = (title: string) => ({ id: title, i: title, title, type: 'bar' as const, dimension: '', metric: 'pageviews' as const, limit: 1, x: 0, y: 0, w: 1, h: 1 })
  const pages = [
    page('default', { isDefault: true, name: 'Overview', group: 'All sites' }),
    page('beacon', { name: 'Beacon', group: 'All sites' }),
    page('mine-1', { name: 'Filtered', group: 'Mine', widgets: [w('Pop-ups: shown, taps and outcomes')] }),
    page('bsk-overview', { name: 'Overview', group: 'Best Sudoku' }),
    page('bsk-popups', { name: 'Pop-ups', group: 'Best Sudoku', widgets: [w('Pop-ups: shown, taps and outcomes')] }),
    page('bsk-launch', { name: 'Traffic', group: 'Best Sudoku', widgets: [w('Visits over time')] }),
    page('k1', { name: 'mobile', group: 'Best Sudoku', parentId: 'bsk-launch' }),
    page('k0', { name: 'reddit.com', group: 'All sites', parentId: 'default' }),
    page('k2', { name: 'mobile › California', group: 'Best Sudoku', parentId: 'bsk-launch' }),
    page('stale', { name: 'Old drill', group: 'Mine', parentId: 'deleted' }),
  ]

  it('pins ★ Overview (with its drill pages) and lists groups in first-appearance order, pages in array order', () => {
    const t = navTree(pages)
    expect(t.pinned).toMatchObject({ page: { id: 'default' }, children: [{ page: { id: 'k0' } }] })
    expect(t.groups.map((g) => [g.name, g.nodes.map((n) => [n.page.id, n.children.map((c) => c.page.id)])])).toEqual([
      ['All sites', [['beacon', []]]],
      ['Mine', [['mine-1', []], ['stale', []]]],
      ['Best Sudoku', [['bsk-overview', []], ['bsk-popups', []], ['bsk-launch', ['k1', 'k2']]]],
    ])
    expect(navOrder(pages).map((p) => p.id)).toEqual(['default', 'k0', 'beacon', 'mine-1', 'stale', 'bsk-overview', 'bsk-popups', 'bsk-launch', 'k1', 'k2'])
  })

  it('leaves out a group whose only page is ★ Overview — unless the group order lists it', () => {
    const only = [page('default', { isDefault: true, group: 'All sites' }), page('x', { group: 'Mine' })]
    expect(navTree(only).groups.map((g) => g.name)).toEqual(['Mine'])
    expect(groupNames(only)).toEqual(['All sites', 'Mine'])
    expect(navTree(only, ['All sites', 'Mine']).groups.map((g) => [g.name, g.nodes.length])).toEqual([
      ['All sites', 0],
      ['Mine', 1],
    ])
  })

  it('groupOrder orders the groups and keeps empty ones; groups it misses follow in page order', () => {
    expect(orderedGroups(pages, ['Best Sudoku', 'Empty'])).toEqual(['Best Sudoku', 'Empty', 'All sites', 'Mine'])
    const t = navTree(pages, ['Best Sudoku', 'Empty'])
    expect(t.groups.map((g) => [g.name, g.nodes.length])).toEqual([
      ['Best Sudoku', 3],
      ['Empty', 0],
      ['All sites', 1],
      ['Mine', 2],
    ])
    expect(navOrder(pages, ['Best Sudoku']).map((p) => p.id).slice(0, 6)).toEqual(['default', 'k0', 'bsk-overview', 'bsk-popups', 'bsk-launch', 'k1'])
    expect(searchPages('', pages, ['Mine'])[2].page.id).toBe('mine-1')
  })

  it('rootsInGroup and groupLandingPage: the page last viewed in a group, else its first page', () => {
    expect(rootsInGroup('Best Sudoku', pages).map((p) => p.id)).toEqual(['bsk-overview', 'bsk-popups', 'bsk-launch'])
    expect(groupLandingPage('Best Sudoku', pages)?.id).toBe('bsk-overview')
    expect(groupLandingPage('Best Sudoku', pages, { 'Best Sudoku': 'k2' })?.id).toBe('k2')
    // a remembered page that has since moved to another group (or gone) is ignored
    expect(groupLandingPage('Best Sudoku', pages, { 'Best Sudoku': 'beacon' })?.id).toBe('bsk-overview')
    expect(groupLandingPage('Best Sudoku', pages, { 'Best Sudoku': 'gone' })?.id).toBe('bsk-overview')
    expect(groupLandingPage('Nope', pages)).toBeUndefined()
  })
})

describe('searchPages', () => {
  const w = (title: string) => ({ id: title, i: title, title, type: 'bar' as const, dimension: '', metric: 'pageviews' as const, limit: 1, x: 0, y: 0, w: 1, h: 1 })
  const pages = [
    page('default', { isDefault: true, name: 'Overview', group: 'All sites' }),
    page('mine-1', { name: 'Filtered', group: 'Mine', widgets: [w('Top pages'), w('Pop-ups: shown, taps and outcomes')] }),
    page('bsk-popups', { name: 'Pop-ups', group: 'Best Sudoku', widgets: [w('Pop-ups: shown, taps and outcomes')] }),
    page('app-pop', { name: 'App popularity', group: 'Mine' }),
    page('re-pop', { name: 'Repopulated', group: 'Mine' }),
  ]
  it('page names first — a name starting with the query, then a word starting with it, then the rest — then chart titles, each page once', () => {
    const hits = searchPages('pop', pages)
    expect(hits.map((h) => [h.page.id, h.match])).toEqual([
      ['bsk-popups', 'name'],
      ['app-pop', 'name'],
      ['re-pop', 'name'],
      ['mine-1', 'chart'],
    ])
    expect(hits[3]).toMatchObject({ chart: 'Pop-ups: shown, taps and outcomes', at: 0, len: 3 })
  })
  it('is case-insensitive and lists every page (in navigation order) for an empty query', () => {
    expect(searchPages('OVER', pages).map((h) => h.page.id)).toEqual(['default'])
    expect(searchPages('  ', pages).map((h) => [h.page.id, h.match])).toEqual([
      ['default', 'all'],
      ['mine-1', 'all'],
      ['app-pop', 'all'],
      ['re-pop', 'all'],
      ['bsk-popups', 'all'],
    ])
    expect(searchPages('zzz', pages)).toEqual([])
  })
  it('highlightParts splits the text around the match (rendered as text, never HTML)', () => {
    expect(highlightParts('Pop-ups', 0, 3)).toEqual([
      { text: 'Pop', mark: true },
      { text: '-ups', mark: false },
    ])
    expect(highlightParts('<b>x</b>', 3, 1)).toEqual([
      { text: '<b>', mark: false },
      { text: 'x', mark: true },
      { text: '</b>', mark: false },
    ])
    expect(highlightParts('Traffic', -1, 0)).toEqual([{ text: 'Traffic', mark: false }])
  })
})

describe('page operations', () => {
  const pages = [
    page('default', { isDefault: true, group: 'All sites' }),
    page('beacon', { group: 'All sites' }),
    page('t', { group: 'Best Sudoku' }),
    page('k1', { group: 'Best Sudoku', parentId: 't' }),
    page('m1', { group: 'Mine' }),
    page('k2', { group: 'Best Sudoku', parentId: 't' }),
    page('m2', { group: 'Mine' }),
  ]
  it('pagesToDelete: the page and its drill pages', () => {
    expect(pagesToDelete('t', pages)).toEqual(['t', 'k1', 'k2'])
    expect(pagesToDelete('m1', pages)).toEqual(['m1'])
  })
  it('movePageToGroup moves the page with its drill pages to the end of the group, keeping everything else', () => {
    const out = movePageToGroup(pages, 't', 'Mine')
    expect(out.map((p) => [p.id, p.group])).toEqual([
      ['default', 'All sites'],
      ['beacon', 'All sites'],
      ['m1', 'Mine'],
      ['m2', 'Mine'],
      ['t', 'Mine'],
      ['k1', 'Mine'],
      ['k2', 'Mine'],
    ])
    expect(out.find((p) => p.id === 't')!.widgets).toBe(pages[2].widgets)
    expect(pages[2].group).toBe('Best Sudoku') // the input is not mutated
  })
  it('a new group goes last; ★ Overview, the same group or no group moves nothing', () => {
    expect(movePageToGroup(pages, 'beacon', 'Star Rupture').map((p) => p.id).at(-1)).toBe('beacon')
    expect(movePageToGroup(pages, 'm1', 'All sites').map((p) => p.id)).toEqual(['default', 'beacon', 'm1', 't', 'k1', 'k2', 'm2'])
    for (const [id, g] of [['default', 'Mine'], ['m1', 'Mine'], ['m1', ''], ['nope', 'Mine']]) expect(movePageToGroup(pages, id, g)).toBe(pages)
  })
  it('insertPageInGroup puts a new page after the pages already in its group', () => {
    expect(insertPageInGroup(pages, page('n'), 'All sites').map((p) => p.id)).toEqual(['default', 'beacon', 'n', 't', 'k1', 'm1', 'k2', 'm2'])
    expect(insertPageInGroup(pages, page('n'), 'New').map((p) => [p.id, p.group]).at(-1)).toEqual(['n', 'New'])
  })
})

describe('names', () => {
  it('pageNameError: only an empty name is refused', () => {
    expect(pageNameError('   ')).toBe('Give the page a name.')
    expect(pageNameError(' x ')).toBeNull()
  })
  it('groupNameError: empty, or another group\'s name in any case, is refused; its own name in a new case is fine', () => {
    const groups = ['All sites', 'Mine']
    expect(groupNameError('  ', groups)).toBe('Give the group a name.')
    expect(groupNameError(' mine ', groups)).toBe('There\'s already a group called "Mine".')
    expect(groupNameError('MINE', groups, 'Mine')).toBeNull()
    expect(groupNameError('Star   Rupture', groups)).toBeNull()
  })
})

describe('group operations', () => {
  const state = () => ({
    pages: [
      page('default', { isDefault: true, group: 'All sites' }),
      page('beacon', { group: 'All sites' }),
      page('t', { group: 'Best Sudoku' }),
      page('k1', { group: 'Best Sudoku', parentId: 't' }),
      page('m1', { group: 'Mine' }),
      page('m2', { group: 'Mine' }),
    ],
    groupOrder: ['All sites', 'Best Sudoku', 'Mine', 'Empty'],
    groupMeta: { 'Best Sudoku': { color: 'g3' }, Mine: { color: 'g1' } },
  })
  it('renameGroup renames it on every page (★ Overview and drill pages too), in the order and in groupMeta, at once', () => {
    const s = state()
    const r = renameGroup(s, 'Best Sudoku', '  BS   Games ')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.pages.map((p) => p.group)).toEqual(['All sites', 'All sites', 'BS Games', 'BS Games', 'Mine', 'Mine'])
    expect(r.result.groupOrder).toEqual(['All sites', 'BS Games', 'Mine', 'Empty'])
    expect(r.result.groupMeta).toEqual({ 'BS Games': { color: 'g3' }, Mine: { color: 'g1' } })
    const pinned = renameGroup(s, 'All sites', 'Sites')
    expect(pinned.ok && pinned.result.pages.filter((p) => p.group === 'Sites').map((p) => p.id)).toEqual(['default', 'beacon'])
    expect(s.pages[2].group).toBe('Best Sudoku') // the input is not mutated
  })
  it('renameGroup refuses another group\'s name (no silent merge), an empty name, or a group that isn\'t there', () => {
    expect(renameGroup(state(), 'Mine', 'best sudoku')).toEqual({ ok: false, error: 'There\'s already a group called "Best Sudoku".' })
    expect(renameGroup(state(), 'Mine', ' ')).toEqual({ ok: false, error: 'Give the group a name.' })
    expect(renameGroup(state(), 'Nope', 'X').ok).toBe(false)
    const empty = renameGroup(state(), 'Empty', 'Later')
    expect(empty.ok && empty.result.groupOrder).toEqual(['All sites', 'Best Sudoku', 'Mine', 'Later'])
  })
  it('deleteGroupTargets: Mine by default, the first other group when Mine goes', () => {
    expect(deleteGroupTargets('Best Sudoku', ['All sites', 'Best Sudoku', 'Mine'])).toEqual({ options: ['All sites', 'Mine'], fallback: 'Mine' })
    expect(deleteGroupTargets('Best Sudoku', ['Best Sudoku'])).toEqual({ options: ['Mine'], fallback: 'Mine' })
    expect(deleteGroupTargets('Mine', ['All sites', 'Mine'])).toEqual({ options: ['All sites'], fallback: 'All sites' })
    expect(deleteGroupTargets('Mine', ['Mine'])).toEqual({ options: [], fallback: null })
  })
  it('deleteGroup moves its pages (with their drill pages) to the destination and drops it from the order and groupMeta', () => {
    const r = deleteGroup(state(), 'Best Sudoku', 'Mine')!
    expect(r.pages.map((p) => [p.id, p.group])).toEqual([
      ['default', 'All sites'],
      ['beacon', 'All sites'],
      ['m1', 'Mine'],
      ['m2', 'Mine'],
      ['t', 'Mine'],
      ['k1', 'Mine'],
    ])
    expect(r.groupOrder).toEqual(['All sites', 'Mine', 'Empty'])
    expect(r.groupMeta).toEqual({ Mine: { color: 'g1' } })
  })
  it('deleteGroup never moves ★ Overview, deletes an empty group outright, and refuses nowhere to go', () => {
    const r = deleteGroup(state(), 'All sites', 'Mine')!
    expect(r.pages.find((p) => p.id === 'default')!.group).toBe('All sites')
    expect(r.pages.find((p) => p.id === 'beacon')!.group).toBe('Mine')
    expect(r.groupOrder).toEqual(['Best Sudoku', 'Mine', 'Empty'])
    expect(deleteGroup(state(), 'Empty', null)!.groupOrder).toEqual(['All sites', 'Best Sudoku', 'Mine'])
    expect(deleteGroup(state(), 'Mine', null)).toBeNull()
    expect(deleteGroup(state(), 'Mine', 'Mine')).toBeNull()
    // a destination that isn't listed yet joins the order
    expect(deleteGroup(state(), 'Mine', 'Archive')!.groupOrder).toEqual(['All sites', 'Best Sudoku', 'Empty', 'Archive'])
  })
  it('addGroup lists a new, empty group last; a taken name is refused', () => {
    expect(addGroup(state(), ' Star  Rupture ')!.groupOrder).toEqual(['All sites', 'Best Sudoku', 'Mine', 'Empty', 'Star Rupture'])
    expect(addGroup(state(), 'mine')).toBeNull()
    expect(addGroup({ pages: state().pages }, 'X')!.groupOrder).toEqual(['All sites', 'Best Sudoku', 'Mine', 'X'])
  })
})
