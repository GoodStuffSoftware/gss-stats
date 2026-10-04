// Layout version 15: the two default geo trend charts, "Pageviews over time" (Beacon) and "Visits
// over time" (Best Sudoku Traffic), bucket by ET day (`dateEt`) instead of the UTC `date`, so the
// counts-only split-guard caption goes away (src/lib/splitGuard.ts refuses `date`, allows
// `dateEt`). Stored layouts move through migrateDateEtTrendsV15, version-gated and matching only
// a widget that is still exactly the shipped default.
import { describe, expect, it } from 'vitest'
import {
  CONFIG_VERSION,
  LAYOUT_VERSIONS,
  V14_DATE_TREND_DEFAULTS,
  defaultBeaconWidgets,
  defaultBestSudokuLaunchWidgets,
  defaultConfig,
  migrateDateEtTrendsV15,
  normalizeConfig,
} from './defaults'
import { SPLIT_REFUSED_DIMS, splitRefused } from './splitGuard'
import type { DashboardConfig, DashboardPage, Widget } from '../types'
import PROD_V8 from './__fixtures__/prodLayout.v8.json'
import PROD_V9 from './__fixtures__/prodLayout.v9.json'
import PROD_V12 from './__fixtures__/prodLayout.v12.json'
import { V15_TREND_KEYS } from './__fixtures__/dateEtTrends'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

/** The two default trend widgets exactly as v14 stored them (UTC `date` axis, grid cell x3 y0 w9 h8),
 * written out as literals and NOT read from the factories: if a factory is edited later, these
 * stay what a stored v14 layout holds, so the migration tests keep describing real stored data. */
const V14_TRENDS: Record<'bcn-trend' | 'bsk-trend', Widget> = {
  'bcn-trend': { id: 'bcn-trend', i: 'bcn-trend', title: 'Pageviews over time', type: 'area', dataset: 'geo', metric: 'pageviews', dimension: 'date', limit: 90, x: 3, y: 0, w: 9, h: 8 },
  'bsk-trend': { id: 'bsk-trend', i: 'bsk-trend', title: 'Visits over time', type: 'area', dataset: 'geo', metric: 'pageviews', dimension: 'date', limit: 90, markers: 'releases', x: 3, y: 0, w: 9, h: 8 },
}
const oldTrend = (id: 'bcn-trend' | 'bsk-trend'): Widget => clone(V14_TRENDS[id])
/** A stored config at `version`: the default Overview plus a page `beacon` holding `widgets`. */
const stored = (version: number, widgets: Widget[]): DashboardConfig => {
  const base = clone(defaultConfig())
  const page: DashboardPage = { ...clone(base.pages[0]), id: 'beacon', name: 'Beacon', isDefault: false, widgets: clone(widgets) }
  return { ...base, version, activePageId: base.pages[0].id, pages: [base.pages[0], page] }
}
const widgetsOf = (cfg: DashboardConfig) => cfg.pages.find((p) => p.id === 'beacon')!.widgets
const mask = (x: unknown) => JSON.stringify(x).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')

describe('v15: the layout version', () => {
  it('is 15, after navigation (13) and sparklines (14); a newer step (captions) follows it', () => {
    expect(LAYOUT_VERSIONS.dateEtTrends).toBe(15)
    expect(CONFIG_VERSION).toBeGreaterThan(LAYOUT_VERSIONS.dateEtTrends)
    expect(CONFIG_VERSION).toBe(Math.max(...Object.values(LAYOUT_VERSIONS)))
    expect(LAYOUT_VERSIONS.dateEtTrends).toBeGreaterThan(LAYOUT_VERSIONS.sparklines)
  })
  it('a fresh config is written at the newest version (15 or later)', () => {
    expect(defaultConfig().version).toBe(CONFIG_VERSION)
  })
})

describe('v15: the defaults', () => {
  const bcn = () => defaultBeaconWidgets().find((w) => w.id === 'bcn-trend')!
  const bsk = () => defaultBestSudokuLaunchWidgets().find((w) => w.id === 'bsk-trend')!

  it('Pageviews over time (Beacon) and Visits over time (Traffic) use dateEt, and nothing else changed', () => {
    expect(bcn()).toMatchObject({ title: 'Pageviews over time', dataset: 'geo', dimension: 'dateEt', type: 'area', metric: 'pageviews', limit: 90 })
    expect(bsk()).toMatchObject({ title: 'Visits over time', dataset: 'geo', dimension: 'dateEt', type: 'area', metric: 'pageviews', limit: 90, markers: 'releases' })
    expect({ ...oldTrend('bcn-trend'), dimension: 'dateEt' }).toEqual(clone(bcn()))
    expect({ ...oldTrend('bsk-trend'), dimension: 'dateEt' }).toEqual(clone(bsk()))
  })

  it('the migration match shapes are frozen literals, pinned here: editing a factory does not move them', () => {
    // These are the two shapes a stored v14 layout holds. If this fails, someone changed
    // V14_DATE_TREND_DEFAULTS: stored v14 charts would stop matching and never move.
    expect(V14_DATE_TREND_DEFAULTS).toEqual([
      { title: 'Pageviews over time', type: 'area', dataset: 'geo', metric: 'pageviews', dimension: 'date', limit: 90 },
      { title: 'Visits over time', type: 'area', dataset: 'geo', metric: 'pageviews', dimension: 'date', limit: 90, markers: 'releases' },
    ])
    expect(Object.isFrozen(V14_DATE_TREND_DEFAULTS)).toBe(true)
  })

  it('FAILS if a factory default is edited: the frozen v14 shape and the factory differ only by dimension', () => {
    // The v15 migration does NOT follow the factories. If you change a default (title, limit,
    // markers, a new field) this test fails on purpose: decide consciously whether stored v14
    // charts should still migrate (they match the frozen literal, not your edit) and whether a
    // further layout step is needed for charts stored at v15 with the old shape.
    const content = (w: Widget) => Object.fromEntries(Object.entries(w).filter(([k, v]) => v !== undefined && !['id', 'i', 'x', 'y', 'w', 'h', 'moved'].includes(k)))
    expect({ ...content(bcn()), dimension: 'date' }).toEqual(V14_DATE_TREND_DEFAULTS[0])
    expect({ ...content(bsk()), dimension: 'date' }).toEqual(V14_DATE_TREND_DEFAULTS[1])
  })

  it('a stored v14 chart migrates from the literal shape whatever the factories build today', () => {
    // Fixture is the literal (V14_TRENDS), not the factory: a changed factory cannot change this.
    const out = widgetsOf(normalizeConfig(stored(14, [oldTrend('bcn-trend'), oldTrend('bsk-trend')])))
    expect(out.map((w) => [w.id, w.dimension])).toEqual([['bcn-trend', 'dateEt'], ['bsk-trend', 'dateEt']])
  })

  it('their dimension is not one the counts-only guard refuses, so /api/geo sets no splitGuard caption', () => {
    // functions/api/geo.ts raises meta.splitGuard (the ChartCard caption) exactly when splitRefused
    // is true for the query's dimensions; these charts have no filter or drill (geo.splitGuard.test.ts
    // runs the handler itself on a dateEt query).
    for (const w of [bcn(), bsk()]) {
      expect(SPLIT_REFUSED_DIMS.has(w.dimension), w.id).toBe(false)
      expect(splitRefused({ points: false, fields: [w.dimension] }), w.id).toBe(false)
    }
    // ...and the UTC axis they used to have is what raised it.
    expect(splitRefused({ points: false, fields: ['date'] })).toBe(true)
  })

  it('an hourly custom chart is unchanged by the load and is still a refused split', () => {
    const hourly: Widget = { ...oldTrend('bcn-trend'), id: 'hourly', i: 'hourly', title: 'Arrivals by hour', type: 'bar', dimension: 'hourEt' }
    expect(widgetsOf(normalizeConfig(stored(14, [hourly])))[0].dimension).toBe('hourEt')
    expect(splitRefused({ points: false, fields: ['hourEt'] })).toBe(true)
  })
})

describe('v15: the migration (stored version below 15 only)', () => {
  it('moves a pristine "Pageviews over time" and "Visits over time" to dateEt, changing only the dimension', () => {
    const bcn = oldTrend('bcn-trend')
    const bsk = oldTrend('bsk-trend')
    const out = normalizeConfig(stored(14, [bcn, bsk]))
    expect(out.version).toBe(CONFIG_VERSION)
    const [a, b] = widgetsOf(out)
    expect(a).toMatchObject({ id: 'bcn-trend', dimension: 'dateEt', title: 'Pageviews over time', dataset: 'geo', limit: 90, x: 3, y: 0, w: 9, h: 8 })
    expect(b).toMatchObject({ id: 'bsk-trend', dimension: 'dateEt', title: 'Visits over time', dataset: 'geo', limit: 90, markers: 'releases', x: 3, y: 0, w: 9, h: 8 })
    // the same load of the same widgets stored at 15 (no step) differs only by the dimension
    const same = widgetsOf(normalizeConfig(stored(15, [bcn, bsk])))
    expect(mask([{ ...a, dimension: 'date' }, { ...b, dimension: 'date' }])).toBe(mask(same))
  })

  it('moves a pristine chart whatever its id: the known `trend` id and a random one, wherever it sits on the grid', () => {
    for (const id of ['bcn-trend', 'bsk-trend', 'trend', '455a6868', 'zz9']) {
      const w = { ...oldTrend('bcn-trend'), id, i: id, x: 6, y: 4, w: 6, h: 8 }
      expect(widgetsOf(normalizeConfig(stored(12, [w])))[0].dimension, id).toBe('dateEt')
    }
    const visits = { ...oldTrend('bsk-trend'), id: 'q1', i: 'q1' }
    expect(widgetsOf(normalizeConfig(stored(12, [visits])))[0].dimension).toBe('dateEt')
  })

  it('leaves every customised date chart untouched: other title, any extra field, other params, other dataset', () => {
    const base = oldTrend('bcn-trend')
    const variants: Record<string, Widget> = {
      renamed: { ...base, title: 'Pageviews over time (mine)' },
      visitsTitleNoMarkers: { ...base, title: 'Visits over time' }, // the Visits title without its release markers
      extraFilter: { ...base, filters: { siteSel: ['bestsudoku-web'] } as any },
      siteOverride: { ...base, siteSel: ['bestsudoku-web'] },
      otherLimit: { ...base, limit: 30 },
      visitsMetric: { ...base, metric: 'visits' },
      otherType: { ...base, type: 'line' },
      breakdown: { ...base, breakdown: 'site' },
      caption: { ...base, notes: ['overview-timeline-caption'] },
      knownTraffic: { ...base, excludeKnownTraffic: true },
      eventBeacons: { ...base, includeEventBeacons: true },
      pageviewsWithMarkers: { ...base, markers: 'releases' },
      visitsNoMarkers: { ...oldTrend('bsk-trend'), markers: undefined },
      series: { ...base, series: [{ label: 'x', axis: 'left', style: 'solid' }] },
      fit: { ...base, fit: 'content' },
      analytics: { ...base, dataset: undefined }, // the all-sites chart: never carries the caption
      popup: { ...base, dataset: 'popup' },
    }
    for (const [name, w] of Object.entries(variants)) {
      const out = widgetsOf(normalizeConfig(stored(14, [{ ...w, id: name, i: name }])))[0]
      expect(out.dimension, name).toBe('date')
    }
  })

  it('moves only the matching widget on a page and no other', () => {
    const mine = { ...oldTrend('bcn-trend'), id: 'mine', i: 'mine', title: 'My trend' }
    const hourly: Widget = { ...oldTrend('bcn-trend'), id: 'h', i: 'h', title: 'By hour', dimension: 'hourEt' }
    const out = widgetsOf(normalizeConfig(stored(14, [oldTrend('bcn-trend'), mine, hourly])))
    expect(out.map((w) => [w.id, w.dimension])).toEqual([['bcn-trend', 'dateEt'], ['mine', 'date'], ['h', 'hourEt']])
  })

  it('is version-gated: a layout already at 15 with a date chart is left as it is, so a later choice of `date` sticks', () => {
    const w = oldTrend('bcn-trend')
    expect(widgetsOf(normalizeConfig(stored(15, [w])))[0].dimension).toBe('date')
    // idempotent: loading the migrated result again changes nothing
    const once = normalizeConfig(stored(14, [w]))
    expect(mask(normalizeConfig(clone(once)))).toBe(mask(once))
    // an owner who sets it back to date after the migration keeps it
    const back = clone(once)
    back.pages[1].widgets[0].dimension = 'date'
    expect(widgetsOf(normalizeConfig(back))[0].dimension).toBe('date')
  })

  it('returns the same page object when nothing matches', () => {
    const page = stored(14, [{ ...oldTrend('bcn-trend'), title: 'Mine' }]).pages[1]
    expect(migrateDateEtTrendsV15(page)).toBe(page)
  })
})

describe('v15: the production layouts (sanitised)', () => {
  it.each([
    ['v8', PROD_V8],
    ['v9', PROD_V9],
    ['v12', PROD_V12],
  ])('%s: exactly the three geo "Pageviews over time" trends move to dateEt; every other widget loads as before', (_n, fixture) => {
    const out = normalizeConfig(clone(fixture) as never)
    const moved = out.pages.flatMap((p) => p.widgets.filter((w) => w.dataset === 'geo' && w.title === 'Pageviews over time' && w.dimension === 'dateEt').map((w) => `${p.id}/${w.id}`))
    expect(moved.sort()).toEqual([...V15_TREND_KEYS].sort())
    // The same load with those three widgets renamed (so the v15 step cannot match them): every
    // widget is identical, and the three differ only by their dimension.
    const renamed = clone(fixture) as any
    for (const p of renamed.pages) for (const w of p.widgets) if (V15_TREND_KEYS.includes(`${p.id}/${w.id}`)) w.title += ' (x)'
    const skipped = normalizeConfig(renamed)
    const flat = (cfg: DashboardConfig) => new Map(cfg.pages.flatMap((p) => p.widgets.map((w) => [`${p.id}/${w.id}`, w] as const)))
    const a = flat(out)
    const b = flat(skipped)
    expect([...a.keys()]).toEqual([...b.keys()])
    for (const [k, w] of a) {
      const was = b.get(k)!
      if (V15_TREND_KEYS.includes(k)) expect(mask(w), k).toBe(mask({ ...was, title: was.title.replace(' (x)', ''), dimension: 'dateEt' }))
      else expect(mask(w), k).toBe(mask(was))
    }
    // the all-sites Overview and Beacon trends (no dataset) stay on date
    for (const id of ['default', 'beacon']) expect(out.pages.find((p) => p.id === id)!.widgets.find((w) => w.id === 'trend')!.dimension).toBe('date')
  })
})
