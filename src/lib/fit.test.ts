// Fit-to-content card height (lib/fit.ts, Widget.fit): the row maths, which widgets can fit, the
// editor model (set and clear), and that the option rides through a saved layout. No migration:
// CONFIG_VERSION stays put and a layout without `fit` loads exactly as it did.
import { describe, expect, it } from 'vitest'
import { FIT_MAX_ROWS, FIT_MIN_ROWS, GRID_MARGIN, GRID_ROW_HEIGHT, canFit, fitRows, isFit, setFit, widgetNeedsChartHeight } from './fit'
import { CONFIG_VERSION, defaultConfig, normalizeConfig } from './defaults'
import { onRequestGet, onRequestPut } from '../../functions/api/config'
import type { DashboardConfig, Widget } from '../types'
import PROD_V9 from './__fixtures__/prodLayout.v9.json'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const wd = (extra: Partial<Widget> = {}): Widget =>
  ({ id: 'w', i: 'w', title: 'w', type: 'table', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 6, h: 6, ...extra }) as Widget
// Geometry of every widget (the time-relative filter windows in a default layout move with the clock).
const geometry = (cfg: DashboardConfig) => cfg.pages.flatMap((p) => p.widgets.map((w) => [p.id, w.id, w.x, w.y, w.w, w.h]))
const allWidgets = (cfg: DashboardConfig) => cfg.pages.flatMap((p) => p.widgets)
const heightOf = (rows: number) => rows * GRID_ROW_HEIGHT + (rows - 1) * GRID_MARGIN

describe('fitRows: the smallest whole number of rows that holds the content', () => {
  it('uses the grid maths: h rows are h*40 + (h-1)*14 px tall', () => {
    expect(heightOf(3)).toBe(148)
    // [content px, rows]: the boundary px that still fits, and one px more.
    const table: [number, number][] = [
      [148, 3],
      [149, 4], // one px over 3 rows needs a fourth
      [202, 4],
      [203, 5],
      [256, 5],
      [257, 6],
      [310, 6],
      [311, 7],
    ]
    for (const [px, rows] of table) expect(fitRows(px), `${px}px`).toBe(rows)
  })

  it('always holds the content: the chosen height is never shorter than the content', () => {
    for (let px = 1; px <= 1200; px++) {
      const rows = fitRows(px)
      if (rows > FIT_MIN_ROWS) expect(heightOf(rows), `${px}px`).toBeGreaterThanOrEqual(px)
      if (rows > FIT_MIN_ROWS) expect(heightOf(rows - 1), `${px}px`).toBeLessThan(px) // and one row fewer would not
    }
  })

  it('never goes below the grid item minimum or above the cap, and survives bad input', () => {
    expect(fitRows(1)).toBe(FIT_MIN_ROWS)
    expect(fitRows(0)).toBe(FIT_MIN_ROWS)
    expect(fitRows(-50)).toBe(FIT_MIN_ROWS)
    expect(fitRows(NaN)).toBe(FIT_MIN_ROWS)
    expect(fitRows(Infinity)).toBe(FIT_MIN_ROWS)
    expect(fitRows(10_000_000)).toBe(FIT_MAX_ROWS)
  })

  it('takes its row height and gap from the arguments', () => {
    expect(fitRows(100, 20, 0, 1)).toBe(5)
    expect(fitRows(101, 20, 0, 1)).toBe(6)
  })
})

describe('which widgets can fit: canvas widgets never', () => {
  const CANVAS = ['bar', 'hbar', 'stackedBar', 'breakdownBar', 'line', 'area', 'doughnut', 'nestedDoughnut', 'pie', 'map'] as const
  it.each(CANVAS)('a %s chart cannot fit, even with fit on', (type) => {
    const w = wd({ type, fit: 'content' })
    expect(widgetNeedsChartHeight(w)).toBe(true)
    expect(canFit(w)).toBe(false)
    expect(isFit(w)).toBe(false)
  })

  it('stat, table, rate, note, and the content-driven panels can', () => {
    for (const w of [wd({ type: 'stat' }), wd({ type: 'table' }), wd({ type: 'rate' }), wd({ type: 'note' }), wd({ type: 'bar', dataset: 'overview' }), wd({ type: 'line', dataset: 'campaigns' }), wd({ type: 'bar', dataset: 'ads-readings' })]) {
      expect(canFit(w), `${w.type}/${w.dataset}`).toBe(true)
    }
  })

  it('a metric card can whatever chart type it saved with (the signin-eligibility card is type "bar")', () => {
    const w = wd({ type: 'bar', dataset: 'popup', card: { preset: 'signin-eligibility' }, fit: 'content' })
    expect(canFit(w)).toBe(true)
    expect(isFit(w)).toBe(true)
  })

  it('is in effect only when the option is on', () => {
    expect(isFit(wd())).toBe(false)
    expect(isFit(wd({ fit: 'content' }))).toBe(true)
  })
})

describe('editor model: setting and clearing the option', () => {
  it('on sets fit to "content"; off removes the key entirely', () => {
    const d = wd()
    setFit(d, true)
    expect(d.fit).toBe('content')
    setFit(d, false)
    expect('fit' in d).toBe(false)
    expect(JSON.stringify(d)).not.toContain('fit')
  })

  it('clearing something that was never set leaves the widget unchanged', () => {
    const d = wd()
    const before = clone(d)
    setFit(d, false)
    expect(d).toEqual(before)
  })

  it('refuses to turn it on for a canvas widget, and clears a stale value on one', () => {
    const chart = wd({ type: 'line' })
    setFit(chart, true)
    expect('fit' in chart).toBe(false)
    const stale = wd({ type: 'pie', fit: 'content' })
    setFit(stale, stale.fit === 'content') // what ChartEditor.save does
    expect('fit' in stale).toBe(false)
  })
})

describe('a layout without fit loads exactly as before', () => {
  it('adds no migration or bump of its own (13 is the navigation step, 14 sparklines; not fit)', () => {
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(13)
  })

  it('the production layout and the factory layout get no fit key, and the same geometry', () => {
    for (const cfg of [normalizeConfig(clone(PROD_V9)), defaultConfig(), normalizeConfig(clone(defaultConfig()))]) {
      for (const p of cfg.pages) for (const w of p.widgets) expect(w.fit, `${p.id}/${w.id}`).toBeUndefined()
      expect(JSON.stringify(cfg)).not.toContain('"fit"')
    }
    // The geometry is the stored one, widget for widget (the v12 migration aside, which has already
    // run on this fixture's later pages): normalising twice changes nothing.
    const once = normalizeConfig(clone(PROD_V9))
    expect(geometry(normalizeConfig(clone(once)))).toEqual(geometry(once))
  })

  it('an older layout (no fit field anywhere) round-trips through a save and reload with no fit added', () => {
    const stored = clone(defaultConfig())
    for (const p of stored.pages) for (const w of p.widgets) delete (w as Partial<Widget>).fit
    const reloaded = normalizeConfig(JSON.parse(JSON.stringify(stored)))
    expect(geometry(reloaded)).toEqual(geometry(stored))
    expect(JSON.stringify(reloaded)).not.toContain('"fit"')
  })
})

describe('persistence: save and reload keeps fit', () => {
  it('survives normalizeConfig (the field whitelist) and drops anything but "content"', () => {
    const cfg = clone(defaultConfig())
    const target = allWidgets(cfg).find((w) => w.card)!
    target.fit = 'content'
    const bad = allWidgets(cfg).find((w) => w.id !== target.id)!
    ;(bad as any).fit = 'fill'
    const out = allWidgets(normalizeConfig(JSON.parse(JSON.stringify(cfg))))
    expect(out.find((w) => w.id === target.id)!.fit).toBe('content')
    expect(out.find((w) => w.id === bad.id)!.fit).toBeUndefined()
  })

  it('goes through the real config endpoint and back: PUT to KV, GET, normalise', async () => {
    const store = new Map<string, string>()
    const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) }
    const env = { STATS_CONFIG: kv }

    const cfg: DashboardConfig = clone(defaultConfig())
    const fitted = allWidgets(cfg).find((w) => w.card)!
    fitted.fit = 'content'
    fitted.h = 7

    const put = await onRequestPut({ request: { text: async () => JSON.stringify(cfg) }, env } as any)
    expect(put.status).toBe(200)
    const got = await onRequestGet({ env } as any)
    const reloaded = normalizeConfig(await got.json())

    const back = allWidgets(reloaded).find((w) => w.id === fitted.id)!
    expect(back.fit).toBe('content')
    expect(back.h).toBe(7) // the last fitted height is kept as an ordinary saved h
    // and every other widget is untouched
    for (const w of allWidgets(reloaded)) if (w.id !== fitted.id) expect(w.fit).toBeUndefined()
  })

  it('turning it off and saving stores no fit key at all', () => {
    const cfg = clone(defaultConfig())
    const w0 = cfg.pages[0].widgets[0]
    w0.fit = 'content'
    setFit(w0, false)
    expect(JSON.stringify(cfg)).not.toContain('"fit"')
  })
})
