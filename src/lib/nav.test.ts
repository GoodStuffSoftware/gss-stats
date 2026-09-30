import { describe, expect, it } from 'vitest'
import { drillChildren, drillTrail, groupLandingPage, groupNames, highlightParts, movePageToGroup, navOrder, navTree, pagesToDelete, parentOf, rootOf, rootsInGroup, searchPages } from './nav'
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
  it('drillChildren lists a root\'s drill pages in array order', () => {
    expect(drillChildren('t', pages).map((p) => p.id)).toEqual(['k1', 'k2'])
    expect(drillChildren('default', pages)).toEqual([])
  })
})

describe('drillTrail (a drill page\'s name)', () => {
  const mobile = { key: 'device', value: 'mobile', label: 'mobile' }
  const de = { key: 'country', value: 'DE', label: 'Germany' }
  it('names a first drill by its value alone — the root\'s own site pick is not repeated', () => {
    const root = f({ siteSel: ['bestsudoku', 'bestsudoku-app'] })
    expect(drillTrail(f({ siteSel: ['bestsudoku', 'bestsudoku-app'], drill: [mobile] }), root, label)).toBe('mobile')
  })
  it('a drill from a drill page carries the trail forward, joined with " › "', () => {
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
    expect(t.pinned).toMatchObject({ page: { id: 'default' }, children: [{ id: 'k0' }] })
    expect(t.groups.map((g) => [g.name, g.nodes.map((n) => [n.page.id, n.children.map((c) => c.id)])])).toEqual([
      ['All sites', [['beacon', []]]],
      ['Mine', [['mine-1', []], ['stale', []]]],
      ['Best Sudoku', [['bsk-overview', []], ['bsk-popups', []], ['bsk-launch', ['k1', 'k2']]]],
    ])
    expect(navOrder(pages).map((p) => p.id)).toEqual(['default', 'k0', 'beacon', 'mine-1', 'stale', 'bsk-overview', 'bsk-popups', 'bsk-launch', 'k1', 'k2'])
  })

  it('leaves out a group whose only page is ★ Overview, but still offers it to move pages into', () => {
    const only = [page('default', { isDefault: true, group: 'All sites' }), page('x', { group: 'Mine' })]
    expect(navTree(only).groups.map((g) => g.name)).toEqual(['Mine'])
    expect(groupNames(only)).toEqual(['All sites', 'Mine'])
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
  it('a new group goes last; ★ Overview, a drill page, or the same group moves nothing', () => {
    expect(movePageToGroup(pages, 'beacon', 'Star Rupture').map((p) => p.id).at(-1)).toBe('beacon')
    expect(movePageToGroup(pages, 'm1', 'All sites').map((p) => p.id)).toEqual(['default', 'beacon', 'm1', 't', 'k1', 'k2', 'm2'])
    for (const [id, g] of [['default', 'Mine'], ['k1', 'Mine'], ['m1', 'Mine'], ['m1', '']]) expect(movePageToGroup(pages, id, g)).toBe(pages)
  })
})
