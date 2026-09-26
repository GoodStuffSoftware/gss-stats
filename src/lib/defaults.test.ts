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
})
