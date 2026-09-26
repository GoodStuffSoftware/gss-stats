import { describe, expect, it } from 'vitest'
import {
  defaultConfig,
  normalizeConfig,
  reorderBskGroup,
  defaultOverviewWidgets,
  defaultCampaignsWidgets,
  isOverviewPage,
  isCampaignComparePage,
  isBestSudokuPopupsPage,
  isBestSudokuLaunchPage,
  CONFIG_VERSION,
} from './defaults'
import type { DashboardConfig, DashboardPage, Widget } from '../types'

// Minimal widget fixture — only the fields tests actually inspect matter; the rest are
// filled with harmless placeholders matching the real Widget shape.
function widget(over: Partial<Widget> & { id: string }): Widget {
  return { i: over.id, title: 'x', type: 'bar', dimension: '', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 6, ...over }
}
function page(over: Partial<DashboardPage> & { id: string; name: string }): DashboardPage {
  return { isDefault: false, filters: { siteSel: [], since: '2026-01-01', until: '2026-01-02', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }, widgets: [], ...over }
}

describe('reorderBskGroup', () => {
  it('puts GSS pages first, then the BSK group in fixed order, then user pages in their relative order', () => {
    const pages = [
      page({ id: 'user-2', name: 'My custom page' }),
      page({ id: 'bsk-launch', name: 'Best Sudoku launch' }),
      page({ id: 'default', name: 'Overview', isDefault: true }),
      page({ id: 'user-1', name: 'Another custom page' }),
      page({ id: 'bsk-popups', name: 'Best Sudoku pop-ups' }),
      page({ id: 'beacon', name: 'Beacon' }),
      page({ id: 'bsk-overview', name: 'Best Sudoku overview' }),
      page({ id: 'bsk-campaigns', name: 'Best Sudoku campaigns' }),
    ]
    const out = reorderBskGroup(pages)
    expect(out.map((p) => p.id)).toEqual([
      'default',
      'beacon',
      'bsk-overview',
      'bsk-campaigns',
      'bsk-popups',
      'bsk-launch',
      'user-2', // user pages keep their ORIGINAL relative order (user-2 was before user-1)
      'user-1',
    ])
  })

  it('renames the BSK group to the consistent "Best Sudoku · X" names, from their known old default names', () => {
    const pages = [
      page({ id: 'bsk-overview', name: 'Best Sudoku overview' }),
      page({ id: 'bsk-campaigns', name: 'Best Sudoku campaigns' }),
      page({ id: 'bsk-popups', name: 'Best Sudoku pop-ups' }),
      page({ id: 'bsk-launch', name: 'Best Sudoku launch' }),
    ]
    const out = reorderBskGroup(pages)
    expect(out.map((p) => p.name)).toEqual(['Best Sudoku · Overview', 'Best Sudoku · Campaigns', 'Best Sudoku · Pop-ups', 'Best Sudoku · Traffic'])
  })

  it('never renames a BSK page the user renamed to something else entirely', () => {
    const pages = [page({ id: 'bsk-overview', name: "Mike's dashboard" })]
    const out = reorderBskGroup(pages)
    expect(out[0].name).toBe("Mike's dashboard") // untouched — not one of the known old default names
  })

  it('is non-destructive: never drops a page or touches its widgets', () => {
    const w1 = widget({ id: 'w1', isDefault: true })
    const pages = [page({ id: 'bsk-overview', name: 'x', widgets: [w1] }), page({ id: 'user-1', name: 'Mine', widgets: [] })]
    const out = reorderBskGroup(pages)
    expect(out).toHaveLength(2)
    expect(out.find((p) => p.id === 'bsk-overview')!.widgets).toEqual([w1])
  })

  it('is idempotent: running it twice produces the identical order/names as running it once', () => {
    const pages = [
      page({ id: 'user-1', name: 'Mine' }),
      page({ id: 'bsk-launch', name: 'Best Sudoku launch' }),
      page({ id: 'default', name: 'Overview', isDefault: true }),
    ]
    const once = reorderBskGroup(pages)
    const twice = reorderBskGroup(once)
    expect(twice.map((p) => [p.id, p.name])).toEqual(once.map((p) => [p.id, p.name]))
  })

  it('is a no-op (same array reference) on an already-correctly-ordered, already-named config', () => {
    const pages = [
      page({ id: 'default', name: 'Overview', isDefault: true }),
      page({ id: 'beacon', name: 'Beacon' }),
      page({ id: 'bsk-overview', name: 'Best Sudoku · Overview' }),
      page({ id: 'bsk-campaigns', name: 'Best Sudoku · Campaigns' }),
      page({ id: 'bsk-popups', name: 'Best Sudoku · Pop-ups' }),
      page({ id: 'bsk-launch', name: 'Best Sudoku · Traffic' }),
      page({ id: 'user-1', name: 'Mine' }),
    ]
    const out = reorderBskGroup(pages)
    expect(out).toBe(pages) // same array reference — nothing moved or renamed
  })
})

describe('normalizeConfig — v7 bespoke → widget migration', () => {
  it('populates default widgets on a v6 config whose Overview/Campaigns pages are still empty (the pre-migration bespoke shape)', () => {
    const raw: any = {
      version: 6,
      activePageId: 'bsk-overview',
      pages: [
        page({ id: 'default', name: 'Overview', isDefault: true }),
        page({ id: 'bsk-overview', name: 'Best Sudoku overview', widgets: [] }),
        page({ id: 'bsk-campaigns', name: 'Best Sudoku campaigns', widgets: [] }),
      ],
    }
    const norm = normalizeConfig(raw)
    const ov = norm.pages.find((p) => isOverviewPage(p))!
    const cp = norm.pages.find((p) => isCampaignComparePage(p))!
    expect(ov.widgets.length).toBeGreaterThan(0)
    expect(ov.widgets.some((w) => w.dataset === 'overview' && w.view === 'timeline')).toBe(true)
    expect(cp.widgets.length).toBeGreaterThan(0)
    expect(cp.widgets.some((w) => w.dataset === 'campaigns' && w.view === 'funnel')).toBe(true)
    expect(norm.version).toBe(CONFIG_VERSION)
  })

  it('never overwrites a page that already has widgets — not on first run, and not if run again (no duplication)', () => {
    const customWidget = widget({ id: 'my-custom-overview-widget', title: 'My chart', dataset: 'overview', view: 'kpis', isDefault: true })
    const raw: any = {
      version: 6,
      activePageId: 'bsk-overview',
      pages: [page({ id: 'default', name: 'Overview', isDefault: true }), page({ id: 'bsk-overview', name: 'Best Sudoku overview', widgets: [customWidget] })],
    }
    const once = normalizeConfig(raw)
    const ov1 = once.pages.find((p) => isOverviewPage(p))!
    expect(ov1.widgets).toEqual([customWidget]) // untouched, not replaced with the factory set

    const twice = normalizeConfig(once)
    const ov2 = twice.pages.find((p) => isOverviewPage(p))!
    expect(ov2.widgets).toEqual([customWidget]) // still untouched — idempotent
  })

  it('MEDIUM regression: a page id\'d bsk-campaigns but named like the overview page (stale/manual-edit mismatch) gets CAMPAIGNS widgets, matched by id first', () => {
    // isOverviewPage/isCampaignComparePage both match by NAME as a fallback, so a page
    // whose id says one thing and whose name says another used to satisfy BOTH predicates —
    // the migration loop ran the overview branch first, filled p.widgets, and the campaigns
    // branch's `widgets.length === 0` guard was then already false, silently skipping it.
    const raw: any = {
      version: 6,
      activePageId: 'default',
      pages: [
        page({ id: 'default', name: 'Overview', isDefault: true }),
        // id says campaigns; name says overview.
        page({ id: 'bsk-campaigns', name: 'Best Sudoku overview', widgets: [] }),
      ],
    }
    const norm = normalizeConfig(raw)
    const p = norm.pages.find((x) => x.id === 'bsk-campaigns')!
    expect(p.widgets.some((w) => w.dataset === 'campaigns')).toBe(true)
    expect(p.widgets.some((w) => w.dataset === 'overview')).toBe(false)
  })

  it('MEDIUM regression: the reverse mismatch — id bsk-overview, name like campaigns — gets OVERVIEW widgets', () => {
    const raw: any = {
      version: 6,
      activePageId: 'default',
      pages: [page({ id: 'default', name: 'Overview', isDefault: true }), page({ id: 'bsk-overview', name: 'Best Sudoku campaigns', widgets: [] })],
    }
    const norm = normalizeConfig(raw)
    const p = norm.pages.find((x) => x.id === 'bsk-overview')!
    expect(p.widgets.some((w) => w.dataset === 'overview')).toBe(true)
    expect(p.widgets.some((w) => w.dataset === 'campaigns')).toBe(false)
  })
})

describe('normalizeConfig — fixtures', () => {
  it('a fresh default config: GSS first, BSK group in order, all BSK-named consistently', () => {
    const norm = normalizeConfig(defaultConfig())
    const bskIds = ['bsk-overview', 'bsk-campaigns', 'bsk-popups', 'bsk-launch']
    const order = norm.pages.map((p) => p.id)
    expect(order.indexOf('default')).toBeLessThan(order.indexOf('bsk-overview'))
    expect(order.indexOf('beacon')).toBeLessThan(order.indexOf('bsk-overview'))
    for (let i = 1; i < bskIds.length; i++) {
      expect(order.indexOf(bskIds[i - 1])).toBeLessThan(order.indexOf(bskIds[i]))
    }
    expect(isBestSudokuPopupsPage(norm.pages.find((p) => p.id === 'bsk-popups')!)).toBe(true)
    expect(isBestSudokuLaunchPage(norm.pages.find((p) => p.id === 'bsk-launch')!)).toBe(true)
  })

  it('a customised config: BSK pages scattered + renamed + user pages + pre-populated widgets — reordered without loss', () => {
    const pinnedWidget = widget({ id: 'pinned-1', title: 'Pinned', dataset: 'campaigns', view: 'funnel', isDefault: true })
    const raw: DashboardConfig = {
      version: CONFIG_VERSION,
      activePageId: 'bsk-campaigns',
      pages: [
        page({ id: 'user-a', name: 'Team A dashboard' }),
        page({ id: 'bsk-launch', name: 'Best Sudoku · Traffic' }),
        page({ id: 'bsk-overview', name: 'Best Sudoku · Overview' }),
        page({ id: 'default', name: 'Overview', isDefault: true }),
        page({ id: 'bsk-campaigns', name: 'Best Sudoku · Campaigns', widgets: [pinnedWidget] }),
        page({ id: 'user-b', name: 'Team B dashboard' }),
        page({ id: 'bsk-popups', name: 'Best Sudoku · Pop-ups' }),
      ],
    }
    const norm = normalizeConfig(raw)
    const order = norm.pages.map((p) => p.id)
    expect(order).toEqual(['default', 'bsk-overview', 'bsk-campaigns', 'bsk-popups', 'bsk-launch', 'user-a', 'user-b'])
    // the user's pinned widget on Campaigns survives untouched (not replaced by the factory set)
    expect(norm.pages.find((p) => p.id === 'bsk-campaigns')!.widgets).toEqual([pinnedWidget])
    // activePageId is preserved through the reorder
    expect(norm.activePageId).toBe('bsk-campaigns')
  })

  it('an already-ordered config round-trips with the same order and widget contents', () => {
    const first = normalizeConfig(defaultConfig())
    const second = normalizeConfig(JSON.parse(JSON.stringify(first)))
    expect(second.pages.map((p) => p.id)).toEqual(first.pages.map((p) => p.id))
    expect(second.pages.map((p) => p.name)).toEqual(first.pages.map((p) => p.name))
    expect(second.pages.map((p) => p.widgets.length)).toEqual(first.pages.map((p) => p.widgets.length))
  })
})

describe('defaultOverviewWidgets / defaultCampaignsWidgets', () => {
  it('cover every documented view exactly once', () => {
    const overviewViews = defaultOverviewWidgets()
      .filter((w) => w.dataset === 'overview')
      .map((w) => w.view)
    expect(new Set(overviewViews)).toEqual(new Set(['kpis', 'timeline', 'scorecard', 'releasePanel']))

    const campaignsViews = defaultCampaignsWidgets()
      .filter((w) => w.dataset === 'campaigns')
      .map((w) => w.view)
    expect(new Set(campaignsViews)).toEqual(new Set(['funnel', 'hourOfDay', 'country', 'flightDay', 'cost', 'deviceMix', 'returns']))
  })

  it('the note-type widgets point at registry ids (noteId), not baked-in literal text', () => {
    const notes = [...defaultOverviewWidgets(), ...defaultCampaignsWidgets()].filter((w) => w.type === 'note')
    expect(notes.length).toBeGreaterThan(0)
    for (const n of notes) {
      expect(n.noteId).toBeTruthy()
      expect(n.note).toBeUndefined() // registry id, not custom text, for every shipped default
    }
  })

  it('chart widgets carry sensible attached-caption defaults from the registry (per view)', () => {
    const funnel = defaultCampaignsWidgets().find((w) => w.view === 'funnel')!
    expect(funnel.notes).toEqual(expect.arrayContaining(['arrivals-caveat', 'min-cohort-caveat']))
  })
})

describe('normWidget — notes/noteId/longText round-trip (via normalizeConfig)', () => {
  function withWidgets(widgets: Widget[]): DashboardConfig {
    return { version: CONFIG_VERSION, activePageId: 'user-1', pages: [page({ id: 'user-1', name: 'Mine', widgets })] }
  }

  it('preserves a new-style note widget\'s noteId/longText/notes fields exactly', () => {
    const w = widget({ id: 'n1', type: 'note', noteId: 'small-sample', longText: false })
    const norm = normalizeConfig(withWidgets([w]))
    const out = norm.pages[0].widgets[0]
    expect(out.noteId).toBe('small-sample')
    expect(out.note).toBeUndefined()
  })

  it('preserves a chart widget\'s explicit `notes` (attached captions) list', () => {
    const w = widget({ id: 'c1', type: 'hbar', dataset: 'campaigns', notes: ['arrivals-caveat'] })
    const norm = normalizeConfig(withWidgets([w]))
    expect(norm.pages[0].widgets[0].notes).toEqual(['arrivals-caveat'])
  })

  it('MIGRATION DEFAULT: a widget saved before noteId/notes existed (plain object with neither field) normalizes with both absent — never backfilled to a guessed value', () => {
    const legacy = { id: 'old1', title: 'Old note', type: 'note', dimension: '', metric: 'pageviews', limit: 1, note: 'Some custom text from before the registry shipped', x: 0, y: 0, w: 4, h: 4 }
    const norm = normalizeConfig(withWidgets([legacy as unknown as Widget]))
    const out = norm.pages[0].widgets[0]
    expect(out.note).toBe('Some custom text from before the registry shipped') // custom text: untouched
    expect(out.noteId).toBeUndefined()
    expect(out.notes).toBeUndefined()
  })

  it('drops a non-string/non-array notes value rather than crashing', () => {
    const legacy = { id: 'old2', title: 'x', type: 'hbar', dimension: '', metric: 'pageviews', limit: 1, notes: 'not-an-array', x: 0, y: 0, w: 4, h: 4 }
    const norm = normalizeConfig(withWidgets([legacy as unknown as Widget]))
    expect(norm.pages[0].widgets[0].notes).toBeUndefined()
  })
})
