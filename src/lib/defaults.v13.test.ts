// The v13 layout migration (page navigation): every page gets a group (built-ins by id, other pages
// from a name prefix, else "Mine"), the Best Sudoku built-ins lose their "Best Sudoku · " prefix,
// the pre-v13 tab order becomes the stored order (and is never re-sorted after that), Traffic gets
// the one explicit built-in icon, and the landing page becomes ★ Overview. Existing drill pages are
// NOT linked to a parent (nothing stored says where they came from). Run on the real default layout,
// on the sanitised production layout (prodLayout.v8/v9.json, normalised through v12), and on
// variants. (Layout version 12 is the Overview's one-row small-sample note; production is stored
// at v12, before page navigation, when v13 ships.)
import { describe, expect, it } from 'vitest'
import {
  CONFIG_VERSION,
  GROUP_ALL_SITES,
  GROUP_BEST_SUDOKU,
  GROUP_MINE,
  LAYOUT_VERSIONS,
  cleanGroupName,
  clonePage,
  defaultConfig,
  groupFromName,
  isBestSudokuLaunchPage,
  isBestSudokuPopupsPage,
  isCampaignComparePage,
  isOverviewPage,
  MAX_DRILL_DEPTH,
  migrateNavV13,
  normalizeConfig,
  normGroupMeta,
  normGroupOrder,
} from './defaults'
import type { DashboardConfig, DashboardPage } from '../types'
import { withV15Trends } from './__fixtures__/dateEtTrends'
import PROD_V8 from './__fixtures__/prodLayout.v8.json'
import PROD_V9 from './__fixtures__/prodLayout.v9.json'
import PROD_V12 from './__fixtures__/prodLayout.v12.json'
import { CAMPAIGN_RETURNS } from './metrics/presets'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
/** Relative ranges are recomputed to "now" on every load; pin them so two loads compare equal. */
function stable(cfg: DashboardConfig): DashboardConfig {
  const c = clone(cfg)
  const pin = (f: any) => {
    if (f?.rangeRel) Object.assign(f, { since: 'rel', until: 'rel' })
  }
  for (const p of c.pages) {
    pin(p.filters)
    for (const w of p.widgets) pin(w.filters)
  }
  return c
}
const rawPage = (id: string, name: string, extra: Record<string, unknown> = {}): any => ({ id, name, filters: { siteSel: [], since: '2026-01-01T00:00:00.000Z', until: '2026-01-02T00:00:00.000Z', rangeRel: '' }, widgets: [], ...extra })
/** Load a layout stored before page navigation (v12, as production stores it): the v13 step runs. */
const V12 = (pages: any[], extra: Record<string, unknown> = {}) => normalizeConfig({ version: 12, activePageId: pages[0].id, pages, ...extra })
/** Load a layout already at v13: only the every-load checks run. */
const V13 = (pages: any[], extra: Record<string, unknown> = {}) => normalizeConfig({ version: 13, activePageId: pages[0].id, pages, ...extra })
const summary = (cfg: DashboardConfig) => cfg.pages.map((p) => [p.id, p.group, p.name, p.icon ?? null, p.parentId ?? null])

describe('v13: the real default layout', () => {
  it('is version 13, lands on ★ Overview, and files the built-ins in order', () => {
    const d = defaultConfig()
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(LAYOUT_VERSIONS.navigation) // 14 since sparklines (defaults.v14.test.ts)
    expect(d.version).toBe(CONFIG_VERSION)
    expect(d.activePageId).toBe('default')
    expect(summary(d)).toEqual([
      ['default', GROUP_ALL_SITES, 'Overview', null, null],
      ['beacon', GROUP_ALL_SITES, 'Beacon', null, null],
      ['bsk-overview', GROUP_BEST_SUDOKU, 'Overview', null, null],
      ['bsk-campaigns', GROUP_BEST_SUDOKU, 'Campaigns', null, null],
      ['bsk-popups', GROUP_BEST_SUDOKU, 'Pop-ups', null, null],
      ['bsk-launch', GROUP_BEST_SUDOKU, 'Traffic', 'trending-up', null],
    ])
    expect(d.pages.find((p) => p.isDefault)!.id).toBe('default')
  })

  it('round-trips through a load unchanged', () => {
    const d = defaultConfig()
    const once = normalizeConfig(clone(d))
    expect(stable(once)).toEqual(stable({ ...d, syncRange: false }))
    expect(stable(normalizeConfig(clone(once)))).toEqual(stable(once))
  })
})

describe('v13: the production layout (sanitised)', () => {
  const fromV8 = normalizeConfig(clone(PROD_V8))
  const fromV9 = normalizeConfig(clone(PROD_V9))

  it('files every page: built-ins by id with the short names, every other page under Mine, nothing linked', () => {
    expect(fromV9.version).toBe(CONFIG_VERSION)
    expect(summary(fromV9)).toEqual([
      ['default', GROUP_ALL_SITES, 'Overview', null, null],
      ['beacon', GROUP_ALL_SITES, 'Beacon', null, null],
      ['bsk-overview', GROUP_BEST_SUDOKU, 'Overview', null, null],
      ['bsk-campaigns', GROUP_BEST_SUDOKU, 'Campaigns', null, null],
      ['bsk-popups', GROUP_BEST_SUDOKU, 'Pop-ups', null, null],
      ['bsk-launch', GROUP_BEST_SUDOKU, 'Traffic', 'trending-up', null],
      // the owner's pages, two of them old drill pages: no name prefix names a group, and no
      // parent can be inferred, so they stay ordinary pages under Mine, names untouched
      ['a666a816', GROUP_MINE, 'goodstuffsoftware.com', null, null],
      ['782bef28', GROUP_MINE, '/products/best-sudoku-beta/', null, null],
      ['b8c47309', GROUP_MINE, 'Copy of Best Sudoku launch', null, null],
      ['7fc55dff', GROUP_MINE, '4 sites · New', null, null],
    ])
    expect(fromV9.activePageId).toBe('default') // was bsk-overview: a first-time viewer lands on ★ Overview
    expect(fromV9.groupMeta).toBeUndefined()
  })

  it('v8 → v13 in one load equals v9 → v13', () => {
    expect(stable(fromV8)).toEqual(stable(fromV9))
  })

  it('the v13 step changes no widget and no filter on any page', () => {
    // The same layout as the v12 build stores it (the old names, no v13 fields), migrated to v13.
    const oldNames = new Map((PROD_V9 as any).pages.map((p: any) => [p.id, p.name]))
    const asV12: any = clone(fromV9)
    asV12.version = 12
    asV12.activePageId = 'bsk-overview'
    for (const p of asV12.pages) {
      delete p.group
      delete p.icon
      delete p.parentId
      p.name = oldNames.get(p.id)
    }
    const migrated = normalizeConfig(clone(asV12))
    expect(migrated.pages.map((p) => p.id)).toEqual(asV12.pages.map((p: any) => p.id))
    const s = stable(migrated)
    const before = stable(asV12)
    s.pages.forEach((p, i) => {
      expect(p.widgets, p.id).toEqual(before.pages[i].widgets)
      expect(p.filters, p.id).toEqual(before.pages[i].filters)
      expect(p.isDefault, p.id).toBe(before.pages[i].isDefault)
    })
    expect(stable(migrated)).toEqual(stable(fromV9))
  })

  it('is idempotent: v13 → v13 changes nothing (names, groups, order, landing page)', () => {
    expect(stable(normalizeConfig(clone(fromV9)))).toEqual(stable(fromV9))
  })
})

// The live production layout as KV stores it when v13 ships (dashboard:default, read-only,
// 2026-09-30; owner browser/OS replaced as in prodLayout.v8): version 12 in the pre-navigation shape
// (no groups, the "Best Sudoku · " names, activePageId bsk-overview), its small-sample note already
// one row. Only the v13 step may change it, and only page names, groups, Traffic's icon and the
// landing page.
describe('v13: the live production layout (stored at v12)', () => {
  const stored = PROD_V12 as unknown as DashboardConfig
  const migrated = normalizeConfig(clone(PROD_V12))
  /** The runtime-only `moved` flag (vue-grid-layout) is never kept by normWidget, whatever the version. */
  const withoutMoved = (cfg: DashboardConfig): DashboardConfig => ({ ...cfg, pages: cfg.pages.map((p) => ({ ...p, widgets: p.widgets.map(({ moved: _m, ...w }: any) => w) })) })

  it('is the pre-navigation v12 shape it claims to be', () => {
    expect(stored.version).toBe(12)
    expect(stored.activePageId).toBe('bsk-overview')
    expect(stored.pages.some((p: any) => 'group' in p || 'icon' in p || 'parentId' in p)).toBe(false)
  })

  it('files every page: built-ins by id with the short names, Traffic\'s icon, every other page under Mine', () => {
    expect(migrated.version).toBe(CONFIG_VERSION)
    expect(summary(migrated)).toEqual([
      ['default', GROUP_ALL_SITES, 'Overview', null, null],
      ['beacon', GROUP_ALL_SITES, 'Beacon', null, null],
      ['bsk-overview', GROUP_BEST_SUDOKU, 'Overview', null, null],
      ['bsk-campaigns', GROUP_BEST_SUDOKU, 'Campaigns', null, null],
      ['bsk-popups', GROUP_BEST_SUDOKU, 'Pop-ups', null, null],
      ['bsk-launch', GROUP_BEST_SUDOKU, 'Traffic', 'trending-up', null],
      ['a666a816', GROUP_MINE, 'goodstuffsoftware.com', null, null],
      ['782bef28', GROUP_MINE, '/products/best-sudoku-beta/', null, null],
      ['b8c47309', GROUP_MINE, 'Copy of Best Sudoku launch', null, null],
      ['7fc55dff', GROUP_MINE, '4 sites · New', null, null],
    ])
    expect(migrated.pages.filter((p) => p.isDefault).map((p) => p.id)).toEqual(['default'])
  })

  it('makes ★ Overview the landing page and adds nothing else to the config', () => {
    expect(migrated.activePageId).toBe('default')
    expect(migrated.syncRange).toBe(false)
    expect('groupMeta' in migrated).toBe(false)
  })

  it('keeps every page, in the stored order, with every widget and filter exactly as stored', () => {
    expect(migrated.pages.map((p) => p.id)).toEqual(stored.pages.map((p) => p.id))
    const after = stable(migrated)
    const before = stable(withV15Trends(withoutMoved(stored))) // v15: the three geo trends move to dateEt (__fixtures__/dateEtTrends.ts)
    after.pages.forEach((p, i) => {
      expect(p.widgets, p.id).toEqual(before.pages[i].widgets)
      expect(p.filters, p.id).toEqual(before.pages[i].filters)
    })
    // …and exactly what a load that skips the v13 step makes of them (the step itself touches none)
    const skipped = stable(normalizeConfig({ ...clone(PROD_V12), version: 13 }))
    after.pages.forEach((p, i) => {
      expect(p.widgets, p.id).toEqual(skipped.pages[i].widgets)
      expect(p.filters, p.id).toEqual(skipped.pages[i].filters)
    })
  })

  it('does not run the v12 note step again: the Overview keeps its stored geometry', () => {
    const geom = (c: DashboardConfig) => c.pages.find((p) => p.id === 'bsk-overview')!.widgets.map((w) => [w.id, w.x, w.y, w.w, w.h])
    expect(geom(migrated)).toEqual(geom(stored))
    expect(geom(migrated)[0]).toEqual(['ow-note-smallsample', 0, 0, 12, 1])
  })

  it('is idempotent: loading the v13 result again changes nothing', () => {
    expect(stable(normalizeConfig(clone(migrated)))).toEqual(stable(migrated))
  })

  it('a v11 layout goes through the v12 note step and then the v13 step to the same result', () => {
    // The same layout as a v11 build stored it: the note three rows tall, everything below it two
    // rows lower.
    const asV11: any = clone(PROD_V12)
    asV11.version = 11
    const ov = asV11.pages.find((p: any) => p.id === 'bsk-overview')
    for (const w of ov.widgets) {
      if (w.id === 'ow-note-smallsample') w.h = 3
      else if (w.y >= 1) w.y += 2
    }
    const fromV11 = normalizeConfig(asV11)
    expect(stable(fromV11)).toEqual(stable(migrated))
  })
})

describe('v13: built-in pages', () => {
  it('are detected by id only — a renamed built-in keeps its behaviour, a look-alike name gets none', () => {
    for (const [fn, id] of [
      [isOverviewPage, 'bsk-overview'],
      [isCampaignComparePage, 'bsk-campaigns'],
      [isBestSudokuPopupsPage, 'bsk-popups'],
      [isBestSudokuLaunchPage, 'bsk-launch'],
    ] as const) {
      expect(fn({ id }), id).toBe(true)
      expect(fn({ id: 'user-1' }), id).toBe(false)
    }
    const cfg = V13([rawPage('default', 'Overview', { isDefault: true }), rawPage('u1', 'Best Sudoku · Campaigns'), rawPage('bsk-campaigns', 'Whatever I like')])
    expect(isCampaignComparePage(cfg.pages[1])).toBe(false)
    expect(isCampaignComparePage(cfg.pages[2])).toBe(true)
  })

  it('renames the Best Sudoku built-ins from every old default name, keeps an owner-chosen name', () => {
    const cfg = V12([
      rawPage('default', 'Overview', { isDefault: true }),
      rawPage('bsk-overview', "Mike's dashboard"),
      rawPage('bsk-campaigns', 'Best Sudoku · My campaigns'),
      rawPage('bsk-popups', 'Best Sudoku pop-ups'),
      rawPage('bsk-launch', 'Best Sudoku launch'),
    ])
    expect(cfg.pages.map((p) => [p.id, p.group, p.name])).toEqual([
      ['default', GROUP_ALL_SITES, 'Overview'],
      ['bsk-overview', GROUP_BEST_SUDOKU, "Mike's dashboard"],
      ['bsk-campaigns', GROUP_BEST_SUDOKU, 'My campaigns'],
      ['bsk-popups', GROUP_BEST_SUDOKU, 'Pop-ups'],
      ['bsk-launch', GROUP_BEST_SUDOKU, 'Traffic'],
    ])
  })

  it('does not bring back a built-in the owner deleted', () => {
    const cfg = V12([rawPage('default', 'Overview', { isDefault: true }), rawPage('bsk-overview', 'Best Sudoku · Overview'), rawPage('u1', 'Scratch')])
    expect(cfg.pages.map((p) => p.id)).toEqual(['default', 'bsk-overview', 'u1'])
  })

  it('puts the pages in the pre-v13 tab order once, and never re-sorts them after that', () => {
    const scattered = [
      rawPage('u2', 'My custom page'),
      rawPage('bsk-launch', 'Best Sudoku · Traffic'),
      rawPage('default', 'Overview', { isDefault: true }),
      rawPage('u1', 'Another custom page'),
      rawPage('bsk-popups', 'Best Sudoku · Pop-ups'),
      rawPage('beacon', 'Beacon'),
      rawPage('bsk-overview', 'Best Sudoku · Overview'),
      rawPage('bsk-campaigns', 'Best Sudoku · Campaigns'),
    ]
    expect(V12(scattered).pages.map((p) => p.id)).toEqual(['default', 'beacon', 'bsk-overview', 'bsk-campaigns', 'bsk-popups', 'bsk-launch', 'u2', 'u1'])
    // at v13 the order is data: kept exactly as stored
    expect(V13(scattered).pages.map((p) => p.id)).toEqual(scattered.map((p) => p.id))
  })

  it('writes only Traffic\'s icon, and keeps one someone already picked', () => {
    const cfg = V12([rawPage('default', 'Overview', { isDefault: true }), rawPage('beacon', 'Beacon'), rawPage('bsk-launch', 'Best Sudoku · Traffic'), rawPage('bsk-popups', 'Best Sudoku · Pop-ups')])
    // (in the pre-v13 tab order: Pop-ups before Traffic)
    expect(cfg.pages.map((p) => [p.id, p.icon ?? null])).toEqual([['default', null], ['beacon', null], ['bsk-popups', null], ['bsk-launch', 'trending-up']])
    const picked = V12([rawPage('default', 'Overview', { isDefault: true }), rawPage('bsk-launch', 'Best Sudoku · Traffic', { icon: 'rocket' })])
    expect(picked.pages[1].icon).toBe('rocket')
  })

  it('keeps an owner-changed v13 name, group and icon on later loads', () => {
    const once = normalizeConfig(clone(defaultConfig()))
    const edited = clone(once)
    edited.pages[5].name = 'Best Sudoku · Traffic' // renamed back by hand: v13 leaves it alone
    edited.pages[4].group = 'Mine'
    delete edited.pages[5].icon
    const again = normalizeConfig(edited)
    expect([again.pages[5].name, again.pages[4].group, again.pages[5].icon]).toEqual(['Best Sudoku · Traffic', 'Mine', undefined])
  })
})

describe('v13: the owner\'s pages', () => {
  it('file under the group their name starts with (dropping a " · " prefix), else Mine', () => {
    const cfg = V12([
      rawPage('default', 'Overview', { isDefault: true }),
      rawPage('a', 'Best Sudoku · Retention'),
      rawPage('b', 'best sudoku launch copy'),
      rawPage('c', 'Copy of Best Sudoku launch'),
      rawPage('d', 'All sites · Referrers'),
      rawPage('e', 'Minesweeper'),
      rawPage('f', 'Mine'),
      rawPage('g', 'Best Sudokus'),
      rawPage('h', 'Best Sudoku · '),
    ])
    expect(cfg.pages.slice(1).map((p) => [p.id, p.group, p.name])).toEqual([
      ['a', GROUP_BEST_SUDOKU, 'Retention'],
      ['b', GROUP_BEST_SUDOKU, 'best sudoku launch copy'],
      ['c', GROUP_MINE, 'Copy of Best Sudoku launch'],
      ['d', GROUP_ALL_SITES, 'Referrers'],
      ['e', GROUP_MINE, 'Minesweeper'],
      ['f', GROUP_MINE, 'Mine'],
      ['g', GROUP_MINE, 'Best Sudokus'],
      ['h', GROUP_BEST_SUDOKU, 'Best Sudoku ·'],
    ])
  })

  it('keep every widget and filter exactly, and every page is kept', () => {
    const widget = { id: 'w1', i: 'w1', title: 'Mine', type: 'hbar', dataset: 'geo', dimension: 'region', metric: 'pageviews', limit: 10, x: 1, y: 2, w: 3, h: 4, isDefault: true }
    const drillPage = rawPage('d1', '3 sites · mobile', { widgets: [widget], filters: { siteSel: ['bestsudoku'], drill: [{ key: 'device', value: 'mobile', label: 'mobile' }], since: '2026-01-01T00:00:00.000Z', until: '2026-01-02T00:00:00.000Z', rangeRel: '' } })
    const cfg = V12([rawPage('default', 'Overview', { isDefault: true }), drillPage])
    const d1 = cfg.pages[1]
    expect(d1).toMatchObject({ id: 'd1', name: '3 sites · mobile', group: GROUP_MINE })
    expect(d1.parentId).toBeUndefined() // an old drill page is not linked: its parent can't be known
    expect(d1.widgets).toEqual([widget])
    expect(d1.filters).toMatchObject(drillPage.filters)
  })

  it('migrateNavV13 never adds or drops a page', () => {
    const pages = V13([rawPage('default', 'Overview', { isDefault: true }), rawPage('x', 'X'), rawPage('y', 'Y')]).pages
    expect(migrateNavV13(pages).map((p) => p.id).sort()).toEqual(pages.map((p) => p.id).sort())
  })
})

describe('v13: drill links and fields, checked on every load', () => {
  const base = () => [rawPage('default', 'Overview', { isDefault: true, group: 'All sites' }), rawPage('t', 'Traffic', { group: 'Best Sudoku' })]

  it('keep a drill page under its parent, in its top-level page\'s group', () => {
    const cfg = V13([...base(), rawPage('k', 'mobile', { group: 'Mine', parentId: 't' })])
    expect(cfg.pages[2]).toMatchObject({ parentId: 't', group: 'Best Sudoku' })
  })

  it('keep a drill of a drill page under that drill page, and drop a link to a missing page, to itself, or from the default page', () => {
    const cfg = V13([
      rawPage('default', 'Overview', { isDefault: true, group: 'All sites', parentId: 't' }),
      rawPage('t', 'Traffic', { group: 'Best Sudoku' }),
      rawPage('k1', 'mobile', { group: 'Best Sudoku', parentId: 't' }),
      rawPage('k2', 'mobile › DE', { group: 'Mine', parentId: 'k1' }),
      rawPage('gone', 'orphan', { group: 'Mine', parentId: 'nope' }),
      rawPage('self', 'self', { group: 'Mine', parentId: 'self' }),
    ])
    expect(cfg.pages.map((p) => [p.id, p.parentId ?? null, p.group])).toEqual([
      ['default', null, 'All sites'],
      ['t', null, 'Best Sudoku'],
      ['k1', 't', 'Best Sudoku'],
      ['k2', 'k1', 'Best Sudoku'],
      ['gone', null, 'Mine'],
      ['self', null, 'Mine'],
    ])
  })

  it('break a parent cycle without losing a page', () => {
    const cfg = V13([rawPage('default', 'Overview', { isDefault: true }), rawPage('a', 'A', { parentId: 'b' }), rawPage('b', 'B', { parentId: 'a' })])
    expect(cfg.pages).toHaveLength(3)
    const linked = cfg.pages.filter((p) => p.parentId)
    expect(linked).toHaveLength(1)
    expect(cfg.pages.find((p) => p.id === linked[0].parentId)!.parentId).toBeUndefined()
  })

  it('keep a deep tree as it is, three levels down, and repair a loop anywhere in it', () => {
    const cfg = V13([
      ...base(),
      rawPage('m', 'mobile', { parentId: 't' }),
      rawPage('ca', 'California', { parentId: 'm' }),
      rawPage('la', 'Los Angeles', { parentId: 'ca', group: 'Elsewhere' }),
      rawPage('x', 'X', { parentId: 'y' }),
      rawPage('y', 'Y', { parentId: 'z' }),
      rawPage('z', 'Z', { parentId: 'x' }),
    ])
    expect(cfg.pages.slice(2, 5).map((p) => [p.id, p.parentId, p.group])).toEqual([
      ['m', 't', 'Best Sudoku'],
      ['ca', 'm', 'Best Sudoku'],
      ['la', 'ca', 'Best Sudoku'],
    ])
    // x → y → z → x: the first link met that closes the loop goes; the others stay a chain
    expect(cfg.pages.slice(5).map((p) => [p.id, p.parentId ?? null])).toEqual([
      ['x', null],
      ['y', 'z'],
      ['z', 'x'],
    ])
    expect(stable(normalizeConfig(clone(cfg)))).toEqual(stable(cfg))
  })

  it(`re-attach a page nested deeper than ${MAX_DRILL_DEPTH} levels to its ancestor at depth ${MAX_DRILL_DEPTH - 1}`, () => {
    const chain = [rawPage('d0', 'd0', { group: 'Deep' })]
    for (let i = 1; i <= MAX_DRILL_DEPTH + 2; i++) chain.push(rawPage(`d${i}`, `d${i}`, { parentId: `d${i - 1}` }))
    const cfg = V13([rawPage('default', 'Overview', { isDefault: true }), ...chain])
    const parent = (id: string) => cfg.pages.find((p) => p.id === id)!.parentId
    expect(parent(`d${MAX_DRILL_DEPTH}`)).toBe(`d${MAX_DRILL_DEPTH - 1}`)
    expect(parent(`d${MAX_DRILL_DEPTH + 1}`)).toBe(`d${MAX_DRILL_DEPTH - 1}`)
    expect(parent(`d${MAX_DRILL_DEPTH + 2}`)).toBe(`d${MAX_DRILL_DEPTH - 1}`) // its parent moved up, so it is one level too deep too
    const depth = (id: string) => {
      let n = 0
      for (let p = parent(id); p; p = parent(p)) n++
      return n
    }
    expect(Math.max(...cfg.pages.map((p) => depth(p.id)))).toBe(MAX_DRILL_DEPTH)
    expect(cfg.pages.every((p) => p.isDefault || p.group === 'Deep')).toBe(true)
  })

  it('a drill from ★ Overview nests under it', () => {
    const cfg = V13([...base(), rawPage('k', 'mobile', { parentId: 'default' })])
    expect(cfg.pages[2]).toMatchObject({ parentId: 'default', group: 'All sites' })
  })

  it('fill a missing group (built-ins by id, else Mine) and clean a messy one', () => {
    const cfg = V13([rawPage('default', 'Overview', { isDefault: true }), rawPage('bsk-popups', 'Pop-ups'), rawPage('u', 'U', { group: '  Star   Rupture  ' }), rawPage('v', 'V', { group: 42 }), rawPage('w', 'W', { group: 'x'.repeat(200) })])
    expect(cfg.pages.map((p) => p.group)).toEqual(['All sites', 'Best Sudoku', 'Star Rupture', 'Mine', 'x'.repeat(60)])
    expect(cleanGroupName('\n')).toBe('')
  })

  it('keep a well-formed icon key (known or not) and drop anything else', () => {
    const cfg = V13([
      rawPage('default', 'Overview', { isDefault: true, icon: 'rocket' }),
      rawPage('a', 'A', { icon: 'not-in-registry-yet' }),
      rawPage('b', 'B', { icon: '<svg onload=alert(1)>' }),
      rawPage('c', 'C', { icon: 'Rocket' }),
      rawPage('d', 'D', { icon: 7 }),
    ])
    expect(cfg.pages.map((p) => p.icon ?? null)).toEqual(['rocket', 'not-in-registry-yet', null, null, null])
  })

  it('keep the stored landing page at v13 if it exists, else ★ Overview', () => {
    const pages = [rawPage('default', 'Overview', { isDefault: true }), rawPage('bsk-popups', 'Pop-ups')]
    expect(normalizeConfig({ version: 13, activePageId: 'bsk-popups', pages: clone(pages) }).activePageId).toBe('bsk-popups')
    expect(normalizeConfig({ version: 13, activePageId: 'gone', pages: clone(pages) }).activePageId).toBe('default')
    expect(normalizeConfig({ version: 12, activePageId: 'bsk-popups', pages: clone(pages) }).activePageId).toBe('default')
    expect(normalizeConfig({ version: 11, activePageId: 'bsk-popups', pages: clone(pages) }).activePageId).toBe('default')
  })
})

describe('v13: groupMeta', () => {
  it('keeps a palette slot or hex colour and an https, same-origin or image data logo', () => {
    expect(
      normGroupMeta({
        'Best Sudoku': { color: 'g3', logo: 'https://cdn.example.com/bs.png' },
        Mine: { color: '#12abEF' },
        'Star Rupture': { logo: '/logos/sr.svg' },
        Data: { logo: 'data:image/png;base64,iVBORw0KGgo=' },
      }),
    ).toEqual({
      'Best Sudoku': { color: 'g3', logo: 'https://cdn.example.com/bs.png' },
      Mine: { color: '#12abEF' },
      'Star Rupture': { logo: '/logos/sr.svg' },
      Data: { logo: 'data:image/png;base64,iVBORw0KGgo=' },
    })
  })

  it('drops anything that could be markup, script or a foreign scheme, and is absent when nothing is left', () => {
    expect(
      normGroupMeta({
        A: { color: 'red; background:url(x)', logo: 'javascript:alert(1)' },
        B: { logo: '//evil.example/x.png' },
        C: { logo: 'http://plain.example/x.png' },
        D: { logo: 'https://x.example/a.png" onerror="alert(1)' },
        E: 'nope',
      }),
    ).toBeUndefined()
    expect(normGroupMeta(['g1'])).toBeUndefined()
    expect(normGroupMeta(null)).toBeUndefined()
  })

  it('survives a load and is left out of a config that has none', () => {
    const pages = [rawPage('default', 'Overview', { isDefault: true })]
    expect(normalizeConfig({ version: 13, activePageId: 'default', pages, groupMeta: { Mine: { color: 'g5' } } }).groupMeta).toEqual({ Mine: { color: 'g5' } })
    expect('groupMeta' in normalizeConfig({ version: 13, activePageId: 'default', pages })).toBe(false)
  })
})

describe('v13: groupOrder (additive, stored only when it says more than the pages)', () => {
  const pages = () => [
    rawPage('default', 'Overview', { isDefault: true, group: 'All sites' }),
    rawPage('beacon', 'Beacon', { group: 'All sites' }),
    rawPage('t', 'Traffic', { group: 'Best Sudoku' }),
    rawPage('m', 'mine', { group: 'Mine' }),
  ]
  it('is left out when it is just the order the pages give (and when absent or garbage)', () => {
    expect('groupOrder' in V13(pages())).toBe(false)
    expect('groupOrder' in V13(pages(), { groupOrder: ['All sites', 'Best Sudoku', 'Mine'] })).toBe(false)
    expect('groupOrder' in V13(pages(), { groupOrder: 'Mine' })).toBe(false)
    expect('groupOrder' in V13(pages(), { groupOrder: [7, null, {}, '  '] })).toBe(false)
  })
  it('keeps an order of its own and empty groups; groups the pages use but it misses follow, in page order', () => {
    const cfg = V13(pages(), { groupOrder: ['Mine', 'Empty', 'All sites'] })
    expect(cfg.groupOrder).toEqual(['Mine', 'Empty', 'All sites', 'Best Sudoku'])
    // ★ Overview's group alone doesn't make a group: listed or not, it shows only when listed
    const onlyPinned = V13([rawPage('default', 'Overview', { isDefault: true, group: 'All sites' }), rawPage('m', 'M', { group: 'Mine' })], { groupOrder: ['All sites'] })
    expect(onlyPinned.groupOrder).toEqual(['All sites', 'Mine'])
  })
  it('sanitises: strings only, cleaned like a group name, no repeats, at most 50', () => {
    expect(normGroupOrder(['  Star   Rupture ', 'Star Rupture', 42, '', 'x'.repeat(99), 'Mine'], [])).toEqual(['Star Rupture', 'x'.repeat(60), 'Mine'])
    const many = Array.from({ length: 80 }, (_, i) => `G${i}`)
    expect(normGroupOrder(many, [])).toHaveLength(50)
    // …but every group a page uses is always listed, cap or not
    const withPage = normGroupOrder(many, [{ id: 'p', name: 'P', isDefault: false, group: 'Real', filters: {} as any, widgets: [] }])!
    expect(withPage).toHaveLength(51)
    expect(withPage.at(-1)).toBe('Real')
  })
  it('is idempotent', () => {
    const once = V13(pages(), { groupOrder: ['Empty', 'Mine', 'Mine', ' Best  Sudoku '] })
    expect(once.groupOrder).toEqual(['Empty', 'Mine', 'Best Sudoku', 'All sites'])
    expect(stable(normalizeConfig(clone(once)))).toEqual(stable(once))
  })
  it('the production layouts migrate exactly as before: no groupOrder is added', () => {
    expect('groupOrder' in normalizeConfig(clone(PROD_V12))).toBe(false)
    expect('groupOrder' in normalizeConfig(clone(PROD_V9))).toBe(false)
    expect('groupOrder' in defaultConfig()).toBe(false)
  })
})

describe('groupFromName', () => {
  it('prefers the longest matching group', () => {
    expect(groupFromName('Best Sudoku Pro · Stats', ['Best Sudoku', 'Best Sudoku Pro'])).toEqual({ group: 'Best Sudoku Pro', name: 'Stats' })
  })
  it('accepts other separators after the group name, keeping the name', () => {
    expect(groupFromName('Best Sudoku: funnel', ['Best Sudoku'])).toEqual({ group: 'Best Sudoku', name: 'Best Sudoku: funnel' })
    expect(groupFromName('Best Sudoku — funnel', ['Best Sudoku'])).toEqual({ group: 'Best Sudoku', name: 'Best Sudoku — funnel' })
  })
  it('null when no group starts the name', () => {
    expect(groupFromName('Scratch', ['Best Sudoku', 'Mine'])).toBeNull()
  })
})

describe('clonePage (+ Page, Duplicate)', () => {
  const src: DashboardPage = { id: 's', name: 'Traffic', isDefault: true, group: 'Best Sudoku', icon: 'rocket', filters: { siteSel: ['a'], since: 'x', until: 'y', excludeSelfReferrals: true, excludeOwnVisits: true, ownBrowser: '', ownOS: '' }, widgets: [{ id: 'w', i: 'w', title: 'T', type: 'bar', dimension: 'd', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 1, h: 1 }] }
  it('keeps the group and the icon, with fresh ids and never the default mark', () => {
    const c = clonePage(src, 'Copy of Traffic')
    expect(c).toMatchObject({ name: 'Copy of Traffic', group: 'Best Sudoku', icon: 'rocket', isDefault: false })
    expect(c.id).not.toBe('s')
    expect(c.widgets[0].id).not.toBe('w')
    expect(c.parentId).toBeUndefined()
  })
  it('a copy of a drill page stays under the same root', () => {
    expect(clonePage({ ...src, isDefault: false, parentId: 'root' }, 'Copy').parentId).toBe('root')
  })
})

describe('v13: fields main added since the nav branch point survive the nav migration', () => {
  // Widget.fit (fit height to content), a card item's sparkline display (keeps `series`), and a
  // repeat's `organic` arm (the Campaign returns preset). The v13 step maps pages with a spread,
  // so none of these may be dropped or rewritten on the way from a stored v12 layout to v13.
  const sparkSpec = (): any => {
    const spec = clone(CAMPAIGN_RETURNS) as any
    spec.sections[0].items.push({ id: 'd0-trend', label: { metric: true }, data: { metric: 'campaign.taggedArrivals' }, display: { as: 'sparkline', series: 'daily' } })
    return spec
  }
  const widgets = (): any[] => [
    { id: 'w-fit-card', type: 'card', title: 'Returns', x: 0, y: 0, w: 6, h: 6, fit: 'content', card: { spec: clone(CAMPAIGN_RETURNS), from: 'campaign-returns' } },
    { id: 'w-fit-preset', type: 'card', title: 'Scorecard', x: 6, y: 0, w: 6, h: 4, fit: 'content', card: { preset: 'campaign-scorecard' } },
    { id: 'w-spark', type: 'card', title: 'Trend', x: 0, y: 6, w: 6, h: 4, card: { spec: sparkSpec() } },
  ]
  const pages = (overviewName: string) => [rawPage('bsk-overview', overviewName, { widgets: widgets() }), rawPage('p-mine', 'My page', { widgets: widgets() })]

  it('migrateNavV13 itself passes every widget through untouched (fit, sparkline series, organic)', () => {
    const before = pages('Best Sudoku · Overview')
    const out = migrateNavV13(clone(before))
    out.forEach((p, i) => expect(p.widgets, p.id).toEqual(before[i].widgets))
    const spark = out[0].widgets.find((w) => w.id === 'w-spark')!.card as any
    expect(spark.spec.sections[0].items.at(-1).display).toEqual({ as: 'sparkline', series: 'daily' })
    expect((out[1].widgets[0].card as any).spec.repeat.organic).toBe(true)
  })

  it('a stored v12 layout keeps fit, the organic arm and the sparkline series through load, and is idempotent', () => {
    const migrated = V12(pages('Best Sudoku · Overview'))
    expect(migrated.version).toBe(CONFIG_VERSION)
    for (const p of migrated.pages) {
      const byId = Object.fromEntries(p.widgets.map((w) => [w.id, w as any]))
      expect(byId['w-fit-card'].fit, p.id).toBe('content')
      expect(byId['w-fit-preset'].fit, p.id).toBe('content')
      expect(byId['w-fit-card'].card.spec.repeat.organic, p.id).toBe(true)
      expect(byId['w-fit-card'].card.from, p.id).toBe('campaign-returns')
      expect(byId['w-spark'].card.spec.sections[0].items.at(-1).display, p.id).toEqual({ as: 'sparkline', series: 'daily' })
    }
    // exactly what a load that skips the v13 step makes of the same widgets
    const skipped = V13(pages('Overview'))
    migrated.pages.forEach((p, i) => expect(stable(migrated).pages[i].widgets, p.id).toEqual(stable(skipped).pages[i].widgets))
    expect(stable(normalizeConfig(clone(migrated)))).toEqual(stable(migrated))
  })

  it('the live production layout with fit on every widget keeps it through the v13 step', () => {
    const raw = clone(PROD_V12) as any
    for (const p of raw.pages) for (const w of p.widgets) w.fit = 'content'
    const migrated = normalizeConfig(raw)
    const all = migrated.pages.flatMap((p) => p.widgets)
    expect(all.length).toBe((PROD_V12 as any).pages.reduce((n: number, p: any) => n + p.widgets.length, 0))
    expect(all.every((w) => w.fit === 'content')).toBe(true)
    expect(stable(normalizeConfig(clone(migrated)))).toEqual(stable(migrated))
  })
})
