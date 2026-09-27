import { describe, expect, it } from 'vitest'
import {
  defaultConfig,
  normalizeConfig,
  reorderBskGroup,
  defaultOverviewWidgets,
  defaultCampaignsWidgets,
  defaultBestSudokuPopupsWidgets,
  migratePopupCaveatTitles,
  isOverviewPage,
  isCampaignComparePage,
  isBestSudokuPopupsPage,
  isBestSudokuLaunchPage,
  overviewPageIsUncustomized,
  popupsPageV8FactoryIds,
  migratePopupsPageV9,
  migrateDeviceMixV9,
  DEVICE_MIX_TITLE,
  CONFIG_VERSION,
} from './defaults'
import { NO_OUTCOME_TRACKING_NOTE, SIGNIN_ELIGIBLE_CAVEAT } from './popupEvents'
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

describe('overviewPageIsUncustomized', () => {
  it('true for the exact pre-completions factory widget id set, in any order', () => {
    const ids = ['ow-note-smallsample', 'ow-kpis', 'ow-timeline', 'ow-scorecard', 'ow-release']
    const p = page({ id: 'bsk-overview', name: 'Best Sudoku · Overview', widgets: [...ids].reverse().map((id) => widget({ id })) })
    expect(overviewPageIsUncustomized(p)).toBe(true)
  })
  it('false when a default chart is missing (the owner removed one)', () => {
    const p = page({ id: 'bsk-overview', name: 'Best Sudoku · Overview', widgets: ['ow-note-smallsample', 'ow-kpis', 'ow-timeline', 'ow-scorecard'].map((id) => widget({ id })) })
    expect(overviewPageIsUncustomized(p)).toBe(false)
  })
  it('false when an extra chart has been added', () => {
    const ids = ['ow-note-smallsample', 'ow-kpis', 'ow-timeline', 'ow-scorecard', 'ow-release', 'my-extra-chart']
    const p = page({ id: 'bsk-overview', name: 'Best Sudoku · Overview', widgets: ids.map((id) => widget({ id })) })
    expect(overviewPageIsUncustomized(p)).toBe(false)
  })
})

describe('normalizeConfig — v8 completions-widget migration', () => {
  it('adds the completions widget once to an untouched factory Overview layout on an old-version config', () => {
    const ids = ['ow-note-smallsample', 'ow-kpis', 'ow-timeline', 'ow-scorecard', 'ow-release']
    const raw: any = {
      version: 7,
      activePageId: 'bsk-overview',
      pages: [page({ id: 'default', name: 'Overview', isDefault: true }), page({ id: 'bsk-overview', name: 'Best Sudoku · Overview', widgets: ids.map((id) => widget({ id })) })],
    }
    const norm = normalizeConfig(raw)
    const ov = norm.pages.find((p) => isOverviewPage(p))!
    expect(ov.widgets.some((w) => w.dataset === 'completions')).toBe(true)
    expect(ov.widgets).toHaveLength(6)
    expect(norm.version).toBe(CONFIG_VERSION)
  })
  it('does NOT add it to a customised Overview layout (owner already added/removed a chart)', () => {
    const customWidget = widget({ id: 'my-custom-overview-widget', dataset: 'overview', view: 'kpis' })
    const raw: any = {
      version: 7,
      activePageId: 'bsk-overview',
      pages: [page({ id: 'default', name: 'Overview', isDefault: true }), page({ id: 'bsk-overview', name: 'Best Sudoku · Overview', widgets: [customWidget] })],
    }
    const norm = normalizeConfig(raw)
    const ov = norm.pages.find((p) => isOverviewPage(p))!
    expect(ov.widgets).toEqual([customWidget]) // untouched — no completions widget forced onto it
  })
  it('running the migration twice on the same v7 config does not duplicate the widget', () => {
    const ids = ['ow-note-smallsample', 'ow-kpis', 'ow-timeline', 'ow-scorecard', 'ow-release']
    const raw: any = {
      version: 7,
      activePageId: 'bsk-overview',
      pages: [page({ id: 'default', name: 'Overview', isDefault: true }), page({ id: 'bsk-overview', name: 'Best Sudoku · Overview', widgets: ids.map((id) => widget({ id })) })],
    }
    const once = normalizeConfig(raw)
    const twice = normalizeConfig(once)
    const ov = twice.pages.find((p) => isOverviewPage(p))!
    expect(ov.widgets.filter((w) => w.dataset === 'completions')).toHaveLength(1)
  })
  it('does not duplicate the completions widget on a second run (already-migrated config)', () => {
    const raw: any = { version: CONFIG_VERSION, activePageId: 'bsk-overview', pages: [page({ id: 'default', name: 'Overview', isDefault: true }), page({ id: 'bsk-overview', name: 'Best Sudoku · Overview', widgets: defaultOverviewWidgets() })] }
    const once = normalizeConfig(raw)
    const twice = normalizeConfig(once)
    const ov = twice.pages.find((p) => isOverviewPage(p))!
    expect(ov.widgets.filter((w) => w.dataset === 'completions')).toHaveLength(1)
  })
  it('a brand-new default config gets the completions widget straight from defaultOverviewWidgets(), not the migration', () => {
    const norm = normalizeConfig(defaultConfig())
    const ov = norm.pages.find((p) => isOverviewPage(p))!
    expect(ov.widgets.filter((w) => w.dataset === 'completions')).toHaveLength(1)
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
    expect(new Set(campaignsViews)).toEqual(new Set(['funnel', 'hourOfDay', 'country', 'flightDay', 'cost', 'returns']))
    // The device mix is the standard nested doughnut now, not a bespoke 'deviceMix' view.
    const mix = defaultCampaignsWidgets().find((w) => w.id === 'cw-devicemix')!
    expect(mix).toMatchObject({ type: 'nestedDoughnut', dataset: 'geo', dimension: 'campaignFlight', breakdown: 'device', rings: ['os'], includeEventBeacons: true })
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

describe('normWidget — includeEventBeacons round-trip (via normalizeConfig)', () => {
  function withWidgets(widgets: Widget[]): DashboardConfig {
    return { version: CONFIG_VERSION, activePageId: 'user-1', pages: [page({ id: 'user-1', name: 'Mine', widgets })] }
  }

  it('a geo chart with includeEventBeacons set survives a save + normalizeConfig round-trip', () => {
    const w = widget({ id: 'g1', type: 'hbar', dataset: 'geo', dimension: 'pathFamily', includeEventBeacons: true })
    const norm = normalizeConfig(withWidgets([w]))
    expect(norm.pages[0].widgets[0].includeEventBeacons).toBe(true)
    // Round-trip again (normalizeConfig applied to its own prior output — the "save, then load
    // again" path) to prove it isn't a one-shot pass-through that a second normalization drops.
    const again = normalizeConfig({ version: CONFIG_VERSION, activePageId: 'user-1', pages: norm.pages })
    expect(again.pages[0].widgets[0].includeEventBeacons).toBe(true)
  })

  it('MIGRATION DEFAULT: a widget saved before this option existed (field absent) normalizes with it undefined, not true or false', () => {
    const legacy = { id: 'g2', title: 'x', type: 'hbar', dataset: 'geo', dimension: 'device', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 4, h: 4 }
    const norm = normalizeConfig(withWidgets([legacy as unknown as Widget]))
    expect(norm.pages[0].widgets[0].includeEventBeacons).toBeUndefined()
  })

  it('a non-boolean saved value normalizes to undefined (fails closed to the excluding default), never to true', () => {
    const legacy = { id: 'g3', title: 'x', type: 'hbar', dataset: 'geo', dimension: 'device', metric: 'pageviews', limit: 10, includeEventBeacons: 'yes', x: 0, y: 0, w: 4, h: 4 }
    const norm = normalizeConfig(withWidgets([legacy as unknown as Widget]))
    expect(norm.pages[0].widgets[0].includeEventBeacons).toBeUndefined()
  })

  it('the PAGE-level filters.includeEventBeacons (set by App.vue openFilteredPage on an event-family drill) also survives normalizeConfig', () => {
    const cfg: DashboardConfig = {
      version: CONFIG_VERSION,
      activePageId: 'user-1',
      pages: [page({ id: 'user-1', name: 'Filtered', widgets: [widget({ id: 'w1', type: 'hbar', dataset: 'geo', dimension: 'device' })] })],
    }
    cfg.pages[0].filters.includeEventBeacons = true
    const norm = normalizeConfig(cfg)
    expect(norm.pages[0].filters.includeEventBeacons).toBe(true)
  })
})

describe('defaultBestSudokuPopupsWidgets — one bar chart, a valid-rates table, eligibility', () => {
  const widgets = defaultBestSudokuPopupsWidgets()

  it('is exactly the breakdown bar, the rate table and the eligibility bar', () => {
    expect(widgets.map((w) => w.id)).toEqual(['pu-bars', 'pu-rates', 'pu-eligible-bd'])
  })

  it('the bar chart puts every pop-up on the axis and shown + outcomes as the series, over geo', () => {
    const bars = widgets.find((w) => w.id === 'pu-bars')!
    expect(bars).toMatchObject({ type: 'breakdownBar', dataset: 'geo', dimension: 'popupFamily', breakdown: 'popupOutcome', barMode: 'grouped' })
  })

  it('the eligibility bar keeps its plain title and the signin-eligible-caveat caption', () => {
    const bd = widgets.find((w) => w.id === 'pu-eligible-bd')!
    expect(bd.title).toBe('Sign-in eligibility — earned / capped / unearned')
    expect(bd.title).not.toContain(SIGNIN_ELIGIBLE_CAVEAT)
    expect(bd.notes).toEqual(['signin-eligible-caveat'])
  })

  it('no generated caveat text in any title', () => {
    for (const w of widgets) expect(w.title).not.toContain(NO_OUTCOME_TRACKING_NOTE)
  })
})

// ── v9: Pop-ups page rebuild + device-mix swap ─────────────────────────────────────────────
describe('normalizeConfig — v9 migration (Pop-ups page + device mix)', () => {
  // A v8-era saved layout: the old generated Pop-ups tiles (moved/resized by the owner), one
  // chart the owner added there, the bespoke device-mix table between other campaign widgets
  // (renamed), and a customised page elsewhere.
  function v8Config(): any {
    const oldPopupTiles = popupsPageV8FactoryIds().map((id, i) => widget({ id, dataset: 'popup', x: (i % 2) * 6, y: i * 4, w: 6, h: 4 }))
    const mine = widget({ id: 'my-popup-chart', title: 'My upsell reasons', dataset: 'popup', dimension: 'reason', popup: 'upsell', x: 3, y: 200, w: 5, h: 7 })
    const campaigns = [
      widget({ id: 'cw-funnel', dataset: 'campaigns', view: 'funnel', type: 'table', x: 0, y: 0, w: 12, h: 14 }),
      widget({ id: 'cw-devicemix', title: 'Devices per flight', dataset: 'campaigns', view: 'deviceMix', type: 'table', x: 2, y: 51, w: 10, h: 9, isDefault: true }),
      widget({ id: 'cw-returns', dataset: 'campaigns', view: 'returns', type: 'table', x: 0, y: 63, w: 12, h: 11 }),
    ]
    const custom = [widget({ id: 'u1', title: 'Custom', dataset: 'geo', dimension: 'city', type: 'hbar', x: 1, y: 2, w: 3, h: 4, notes: ['small-sample'] })]
    return {
      version: 8,
      activePageId: 'bsk-popups',
      pages: [
        page({ id: 'default', name: 'Overview', isDefault: true, widgets: custom }),
        page({ id: 'bsk-campaigns', name: 'Best Sudoku · Campaigns', widgets: campaigns }),
        page({ id: 'bsk-popups', name: 'Best Sudoku · Pop-ups', widgets: [...oldPopupTiles, mine] }),
        page({ id: 'user-x', name: 'Mine', widgets: [widget({ id: 'dm2', title: 'Device mix', dataset: 'campaigns', view: 'deviceMix', type: 'table', x: 0, y: 5, w: 6, h: 8 })] }),
      ],
    }
  }

  it('rebuilds the Pop-ups page: new chart + table on top, eligibility and the owner\'s own chart kept below', () => {
    const norm = normalizeConfig(v8Config())
    expect(norm.version).toBe(CONFIG_VERSION)
    expect(CONFIG_VERSION).toBe(9)
    const pu = norm.pages.find((p) => p.id === 'bsk-popups')!
    expect(pu.widgets.map((w) => w.id)).toEqual(['pu-bars', 'pu-rates', 'pu-eligible-bd', 'my-popup-chart'])
    const mine = pu.widgets.find((w) => w.id === 'my-popup-chart')!
    expect(mine).toMatchObject({ title: 'My upsell reasons', x: 3, w: 5, h: 7, dimension: 'reason', popup: 'upsell' })
    // kept widgets sit below the new block, in their original relative order
    const blockBottom = Math.max(...pu.widgets.slice(0, 2).map((w) => w.y + w.h))
    const kept = pu.widgets.slice(2)
    for (const k of kept) expect(k.y).toBeGreaterThanOrEqual(blockBottom)
    expect(kept[0].y).toBeLessThan(kept[1].y)
  })

  it('swaps the bespoke device mix for the nested doughnut in place, keeping id, position, size, title and default mark', () => {
    const norm = normalizeConfig(v8Config())
    const cw = norm.pages.find((p) => p.id === 'bsk-campaigns')!
    expect(cw.widgets.map((w) => w.id)).toEqual(['cw-funnel', 'cw-devicemix', 'cw-returns'])
    const mix = cw.widgets[1]
    expect(mix).toMatchObject({
      type: 'nestedDoughnut',
      dataset: 'geo',
      dimension: 'campaignFlight',
      breakdown: 'device',
      rings: ['os'],
      includeEventBeacons: true,
      title: 'Devices per flight', // the owner's own title survives
      isDefault: true,
      x: 2,
      y: 51,
      w: 10,
      h: 9,
    })
    expect(mix.view).toBeUndefined()
    expect(mix.filters?.rangeRel).toBe('12mo')
    // a copy on another page is swapped too; the default title moves to the new one
    const other = norm.pages.find((p) => p.id === 'user-x')!.widgets[0]
    expect(other).toMatchObject({ id: 'dm2', type: 'nestedDoughnut', title: DEVICE_MIX_TITLE, x: 0, y: 5, w: 6, h: 8 })
  })

  it('leaves every other page and widget exactly as saved', () => {
    const raw = v8Config()
    const norm = normalizeConfig(raw)
    expect(norm.pages.find((p) => p.id === 'default')!.widgets).toEqual(raw.pages[0].widgets)
    const cw = norm.pages.find((p) => p.id === 'bsk-campaigns')!.widgets
    expect(cw[0]).toEqual(raw.pages[1].widgets[0])
    expect(cw[2]).toEqual(raw.pages[1].widgets[2])
  })

  it('is idempotent: normalizing the migrated config again changes no widget', () => {
    const once = normalizeConfig(v8Config())
    const twice = normalizeConfig(JSON.parse(JSON.stringify(once)))
    const strip = (c: DashboardConfig) => c.pages.map((p) => ({ id: p.id, widgets: p.widgets.map((w) => ({ ...w, filters: w.filters ? { ...w.filters, since: '', until: '' } : w.filters })) }))
    expect(strip(twice)).toEqual(strip(once))
    // and the migration functions themselves are no-ops on their own output
    const pu = once.pages.find((p) => p.id === 'bsk-popups')!
    expect(migratePopupsPageV9(pu)).toBe(pu)
    const cw = once.pages.find((p) => p.id === 'bsk-campaigns')!
    expect(migrateDeviceMixV9(cw)).toBe(cw)
  })

  it('is version-gated: a v9 config with a hand-added old tile keeps it', () => {
    const cfg: any = { version: 9, activePageId: 'bsk-popups', pages: [page({ id: 'bsk-popups', name: 'Best Sudoku · Pop-ups', widgets: [widget({ id: 'pu-upsell-kind', dataset: 'popup' })] })] }
    const norm = normalizeConfig(cfg)
    expect(norm.pages.find((p) => p.id === 'bsk-popups')!.widgets.map((w) => w.id)).toEqual(['pu-upsell-kind'])
  })

  it('a Pop-ups page the owner emptied gets the two new widgets but not the eligibility bar back', () => {
    const out = migratePopupsPageV9(page({ id: 'bsk-popups', name: 'Best Sudoku · Pop-ups', widgets: [] }))
    expect(out.widgets.map((w) => w.id)).toEqual(['pu-bars', 'pu-rates'])
  })

  it('a fresh default config needs no migration and already has the new page', () => {
    const norm = normalizeConfig(defaultConfig())
    expect(norm.pages.find((p) => p.id === 'bsk-popups')!.widgets.map((w) => w.id)).toEqual(['pu-bars', 'pu-rates', 'pu-eligible-bd'])
    expect(norm.pages.find((p) => p.id === 'bsk-campaigns')!.widgets.some((w) => w.view === 'deviceMix')).toBe(false)
  })
})

describe('normWidget — v9 fields survive the whitelist (via normalizeConfig)', () => {
  it('keeps barMode, and drops an unknown barMode value', () => {
    const cfg: DashboardConfig = {
      version: CONFIG_VERSION,
      activePageId: 'u',
      pages: [
        page({
          id: 'u',
          name: 'Mine',
          widgets: [
            widget({ id: 'a', type: 'breakdownBar', dataset: 'geo', dimension: 'popupFamily', breakdown: 'popupOutcome', barMode: 'stacked' }),
            widget({ id: 'b', type: 'breakdownBar', dataset: 'geo', dimension: 'popupFamily', breakdown: 'popupOutcome', barMode: 'sideways' as any }),
          ],
        }),
      ],
    }
    const [a, b] = normalizeConfig(JSON.parse(JSON.stringify(cfg))).pages[0].widgets
    expect(a.barMode).toBe('stacked')
    expect(b.barMode).toBeUndefined()
  })
  it('the device-mix doughnut round-trips with its rings, event-beacon opt-in and filter override', () => {
    const cfg: DashboardConfig = { version: CONFIG_VERSION, activePageId: 'bsk-campaigns', pages: [page({ id: 'bsk-campaigns', name: 'Best Sudoku · Campaigns', widgets: defaultCampaignsWidgets() })] }
    const mix = normalizeConfig(JSON.parse(JSON.stringify(cfg))).pages[0].widgets.find((w) => w.id === 'cw-devicemix')!
    expect(mix).toMatchObject({ rings: ['os'], includeEventBeacons: true, notes: ['device-mix-population'] })
    expect(mix.filters?.rangeRel).toBe('12mo')
  })
})

describe('migratePopupCaveatTitles', () => {
  function popupPage(widgets: Widget[]): DashboardPage {
    return page({ id: 'bsk-popups', name: 'Best Sudoku · Pop-ups', widgets })
  }

  it('restores the plain title and adds the caption for a widget with EXACTLY the old generated title', () => {
    const oldKind = widget({
      id: 'pu-first50-congrats-kind',
      title: `First 50 congrats — shown / accepted / dismissed (${NO_OUTCOME_TRACKING_NOTE})`,
      type: 'bar',
      dataset: 'popup',
    })
    const [out] = migratePopupCaveatTitles([popupPage([oldKind])])
    const w = out.widgets[0]
    expect(w.title).toBe('First 50 congrats — shown / accepted / dismissed')
    expect(w.notes).toEqual(['no-outcome-tracking'])
  })

  it('migrates both sign-in-eligibility widgets from their old caveat-suffixed titles', () => {
    const bd = widget({ id: 'pu-eligible-bd', title: `Sign-in eligibility — earned / capped / unearned (${SIGNIN_ELIGIBLE_CAVEAT})`, type: 'bar', dataset: 'popup' })
    const rate = widget({ id: 'pu-eligible-rate', title: `Sign-in eligibility rate (${SIGNIN_ELIGIBLE_CAVEAT})`, type: 'rate', dataset: 'popup' })
    const [out] = migratePopupCaveatTitles([popupPage([bd, rate])])
    expect(out.widgets[0].title).toBe('Sign-in eligibility — earned / capped / unearned')
    expect(out.widgets[0].notes).toEqual(['signin-eligible-caveat'])
    expect(out.widgets[1].title).toBe('Sign-in eligibility rate')
    expect(out.widgets[1].notes).toEqual(['signin-eligible-caveat'])
  })

  it('leaves a USER-EDITED title (no longer an exact match) completely untouched', () => {
    const edited = widget({
      id: 'pu-eligible-bd',
      title: 'My custom eligibility chart', // user renamed it — does not match the old string
      type: 'bar',
      dataset: 'popup',
    })
    const [out] = migratePopupCaveatTitles([popupPage([edited])])
    expect(out.widgets[0].title).toBe('My custom eligibility chart')
    expect(out.widgets[0].notes ?? []).toEqual([])
  })

  it('leaves an ALREADY-plain title (already migrated, or a fresh default widget) untouched — idempotent', () => {
    const already = widget({ id: 'pu-eligible-rate', title: 'Sign-in eligibility rate', type: 'rate', dataset: 'popup', notes: ['signin-eligible-caveat'] })
    const [out] = migratePopupCaveatTitles([popupPage([already])])
    expect(out.widgets[0]).toEqual(already)
  })

  it('does not duplicate the caption if the widget somehow already has it', () => {
    const oldTitleAlreadyTagged = widget({
      id: 'pu-eligible-rate',
      title: `Sign-in eligibility rate (${SIGNIN_ELIGIBLE_CAVEAT})`,
      type: 'rate',
      dataset: 'popup',
      notes: ['signin-eligible-caveat'],
    })
    const [out] = migratePopupCaveatTitles([popupPage([oldTitleAlreadyTagged])])
    expect(out.widgets[0].notes).toEqual(['signin-eligible-caveat'])
  })

  it('is a no-op (same array reference) when nothing on the page matches', () => {
    const pages = [popupPage([widget({ id: 'pu-eligible-rate', title: 'Sign-in eligibility rate', type: 'rate', dataset: 'popup' })])]
    const out = migratePopupCaveatTitles(pages)
    expect(out).toBe(pages)
  })

  it('running it twice in a row is idempotent (second pass changes nothing further)', () => {
    const oldKind = widget({ id: 'pu-first50-congrats-kind', title: `First 50 congrats — shown / accepted / dismissed (${NO_OUTCOME_TRACKING_NOTE})`, type: 'bar', dataset: 'popup' })
    const once = migratePopupCaveatTitles([popupPage([oldKind])])
    const twice = migratePopupCaveatTitles(once)
    expect(twice[0].widgets[0]).toEqual(once[0].widgets[0])
  })

  it('end to end via normalizeConfig: an old-shape pop-ups page in a full config gets migrated on load', () => {
    const raw: any = {
      version: 6,
      activePageId: 'bsk-popups',
      pages: [
        page({ id: 'default', name: 'Overview', isDefault: true }),
        popupPage([
          widget({ id: 'pu-eligible-bd', title: `Sign-in eligibility — earned / capped / unearned (${SIGNIN_ELIGIBLE_CAVEAT})`, type: 'bar', dataset: 'popup' }),
        ]),
      ],
    }
    const norm = normalizeConfig(raw)
    const popupsPage = norm.pages.find((p) => isBestSudokuPopupsPage(p))!
    const w = popupsPage.widgets.find((w) => w.id === 'pu-eligible-bd')!
    expect(w.title).toBe('Sign-in eligibility — earned / capped / unearned')
    expect(w.notes).toEqual(['signin-eligible-caveat'])
  })
})
