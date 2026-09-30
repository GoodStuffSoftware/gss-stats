// The v11 layout migration (ADR 0003 slice 7): every remaining bespoke panel swapped in place —
// a card preset (the release panel; the campaign funnel, country, cost and returns panels; the
// Pop-ups rate table and sign-in eligibility) or a standard chart (arrivals by ET hour, daily
// arrivals by flight day). Matched by what a widget IS (panelKey / its campaigns view), never by
// its title or its page's name; idempotent; never adds, removes or moves a widget, so a panel
// the owner deleted stays deleted. Run on the real default layout, on the sanitised production
// layout (prodLayout.v8.json as KV stores it, and its v9 normalisation), and on variants.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, defaultConfig, flightDayWidget, hourOfDayWidget, migratePanelsV11, normalizeConfig, panelKey, swapPanelChart } from './defaults'
import { presetById } from './metrics/presets'
import type { DashboardConfig, Widget } from '../types'
import PROD_V8 from './__fixtures__/prodLayout.v8.json'
import PROD_V9 from './__fixtures__/prodLayout.v9.json'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
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
function sorted(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))
}
const canon = (w: unknown) => sorted(stable({ pages: [{ filters: {}, widgets: [w] }] } as any))
const byKey = (cfg: DashboardConfig) => new Map<string, Widget>(cfg.pages.flatMap((p) => p.widgets.map((w) => [`${p.id}/${w.id}`, w] as const)))
const page = (id: string, widgets: unknown[], name = id): any => ({ id, name, filters: {}, widgets })
const panel = (id: string, dataset: string, view: string, extra: Partial<Widget> = {}): Partial<Widget> => ({ id, i: id, title: 'T', type: 'table', dataset: dataset as Widget['dataset'], view, dimension: '', metric: 'pageviews', limit: 1, x: 1, y: 2, w: 6, h: 7, ...extra })
const load = (pages: any[], version = 10) => normalizeConfig({ version, activePageId: pages[0].id, pages })

/** Nothing bespoke is left: every overview/campaigns/popup panel renders as a card or a chart. */
function bespokeLeft(cfg: DashboardConfig): string[] {
  return [...byKey(cfg)].filter(([, w]) => panelKey(w) !== null && !w.card).map(([k]) => k)
}

describe('v11: the real default layout', () => {
  it('ships every former panel as a card or a standard chart, and round-trips unchanged', () => {
    const d = defaultConfig()
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(11)
    expect(d.version).toBe(CONFIG_VERSION)
    expect(bespokeLeft(d)).toEqual([])
    const w = byKey(d)
    expect(w.get('bsk-campaigns/cw-hour')).toMatchObject({ type: 'breakdownBar', dataset: 'geo', dimension: 'hourEt' })
    expect(w.get('bsk-campaigns/cw-flightday')).toMatchObject({ type: 'line', dataset: 'geo', dimension: 'flightDay', cumulative: true })
    for (const [k, x] of w) if (x.card && 'preset' in x.card) expect(presetById(x.card.preset), k).toBeDefined()
    const once = normalizeConfig(clone(d))
    expect(stable(normalizeConfig(clone(once)))).toEqual(stable(once))
    expect(stable(once)).toEqual(stable(normalizeConfig(clone(d))))
  })
})

describe('v11: the production layout (sanitised)', () => {
  const fromV8 = normalizeConfig(clone(PROD_V8))
  const fromV9 = normalizeConfig(clone(PROD_V9))
  /** What slice 7 changes on production, on top of what the deployed v10 build already renders
   * (v10 added the kpis and scorecard cards). */
  const V11_CARDS: Record<string, string> = {
    'bsk-overview/ow-release': 'release-before-after',
    'bsk-campaigns/cw-funnel': 'campaign-funnel',
    'bsk-campaigns/cw-country': 'campaign-country',
    'bsk-campaigns/cw-cost': 'campaign-cost',
    'bsk-campaigns/cw-returns': 'campaign-returns',
    'bsk-popups/pu-rates': 'popup-rates',
    'bsk-popups/pu-eligible-bd': 'signin-eligibility',
  }
  const V11_CHARTS: Record<string, (g: { x: number; y: number; w: number; h: number }, id?: string, title?: string) => Widget> = {
    'bsk-campaigns/cw-hour': hourOfDayWidget,
    'bsk-campaigns/cw-flightday': flightDayWidget,
  }

  it('v9 → v11: exactly the eleven panels change (two v10 cards, seven v11 cards, two charts), nothing else', () => {
    const before = byKey(PROD_V9 as unknown as DashboardConfig)
    const after = byKey(fromV9)
    expect([...after.keys()]).toEqual([...before.keys()]) // none added, removed or reordered
    const changed = [...after].filter(([k, w]) => canon(w) !== canon(before.get(k))).map(([k]) => k)
    expect(changed.sort()).toEqual(['bsk-overview/ow-kpis', 'bsk-overview/ow-scorecard', ...Object.keys(V11_CARDS), ...Object.keys(V11_CHARTS)].sort())
    expect(bespokeLeft(fromV9)).toEqual([])
  })

  it('each v11 card keeps everything and only gains its card', () => {
    const before = byKey(PROD_V9 as unknown as DashboardConfig)
    const after = byKey(fromV9)
    for (const [k, preset] of Object.entries(V11_CARDS)) {
      const { card, ...rest } = after.get(k)!
      expect(card, k).toEqual({ preset })
      expect(canon(rest), k).toBe(canon(before.get(k))) // id, title, dataset/view/type, x/y/w/h, notes
    }
  })

  it('each chart keeps its id, title, place, size and captions; its data is the standard chart', () => {
    const before = byKey(PROD_V9 as unknown as DashboardConfig)
    const after = byKey(fromV9)
    for (const [k, make] of Object.entries(V11_CHARTS)) {
      const was = before.get(k)!
      const now = after.get(k)!
      expect([now.id, now.title, now.x, now.y, now.w, now.h, now.notes, now.isDefault], k).toEqual([was.id, was.title, was.x, was.y, was.w, was.h, was.notes, was.isDefault])
      const fresh = make({ x: was.x, y: was.y, w: was.w, h: was.h }, was.id, was.title)
      expect(canon({ ...now, notes: fresh.notes, isDefault: fresh.isDefault }), k).toBe(canon(fresh))
      expect(now.dataset).toBe('geo')
      expect(now.view).toBeUndefined()
    }
  })

  it('v8 → v11 in one load equals v8 → v9 → v11; v11 → v11 is a no-op', () => {
    expect(stable(fromV8)).toEqual(stable(fromV9))
    expect(stable(normalizeConfig(clone(fromV9)))).toEqual(stable(fromV9))
    // Every page is kept, in order (its v13 name and group: defaults.v13.test.ts).
    expect(fromV9.pages.map((p) => p.id)).toEqual((PROD_V9 as any).pages.map((p: any) => p.id))
  })
})

describe('v11: custom, deleted and renamed variants', () => {
  it('keeps a renamed, moved, resized, captioned, default-marked card panel exactly, adding only the card', () => {
    const custom = panel('cw-funnel', 'campaigns', 'funnel', { title: 'My funnel', x: 3, y: 50, w: 8, h: 20, notes: ['small-sample'], isDefault: true, campaignIds: ['24279250691'] })
    const w = load([page('bsk-campaigns', [custom], 'My campaigns')]).pages[0].widgets[0]
    expect(w).toMatchObject({ ...custom, card: { preset: 'campaign-funnel' } })
  })

  it('matches panels by what they are, on any page, whatever their id or title', () => {
    const out = load([
      page('scratch', [
        panel('a1', 'campaigns', 'returns', { title: 'Anything' }),
        panel('a2', 'overview', 'releasePanel', { title: 'Mine' }),
        { id: 'a3', i: 'a3', title: 'Rates', type: 'rateTable', dataset: 'popup', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 4, h: 4 },
        { id: 'a4', i: 'a4', title: 'Elig', type: 'doughnut', dataset: 'popup', dimension: 'eligible', metric: 'pageviews', limit: 3, x: 0, y: 0, w: 4, h: 4 },
        panel('a5', 'campaigns', 'hourOfDay', { title: 'Hours' }),
      ]),
    ])
    const w = out.pages[0].widgets
    expect(w.map((x) => (x.card && 'preset' in x.card ? x.card.preset : `${x.type}:${x.dimension}`))).toEqual(['campaign-returns', 'release-before-after', 'popup-rates', 'signin-eligibility', 'breakdownBar:hourEt'])
    expect(w[4]).toMatchObject({ id: 'a5', title: 'Hours', x: 1, y: 2, w: 6, h: 7 })
  })

  it('leaves alone what is not a panel: another dataset, a popup rate tile, a titled look-alike', () => {
    const out = load([
      page('p', [
        { id: 'b1', i: 'b1', title: 'Funnel per campaign', type: 'bar', dataset: 'geo', dimension: 'campaignFlight', metric: 'pageviews', limit: 5, x: 0, y: 0, w: 4, h: 4 },
        { id: 'b2', i: 'b2', title: 'Sign-in eligibility rate', type: 'rate', dataset: 'popup', dimension: 'signin-eligible:rate', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 4 },
        { id: 'b3', i: 'b3', title: 'Upsell reasons', type: 'hbar', dataset: 'popup', dimension: 'reason', popup: 'upsell', metric: 'pageviews', limit: 8, x: 0, y: 0, w: 4, h: 4 },
      ]),
    ])
    for (const w of out.pages[0].widgets) {
      expect(w.card, w.id).toBeUndefined()
      expect(w.dataset, w.id).not.toBe(undefined)
    }
    expect(out.pages[0].widgets.map((w) => w.type)).toEqual(['bar', 'rate', 'hbar'])
  })

  it('never resurrects a deleted panel: a Campaigns page without some panels stays without them', () => {
    const out = load([page('bsk-campaigns', [panel('cw-cost', 'campaigns', 'cost')], 'Best Sudoku · Campaigns')])
    expect(out.pages.find((p) => p.id === 'bsk-campaigns')!.widgets.map((w) => w.id)).toEqual(['cw-cost'])
  })

  it('an existing card (a customised spec or another preset) is never replaced', () => {
    const spec = { v: 1, sections: [{ layout: 'rows', items: [{ id: 'x', label: { metric: true }, data: { metric: 'campaign.spend' }, display: { as: 'currency' } }] }], repeat: { over: 'campaigns' } }
    const out = load([page('p', [panel('c1', 'campaigns', 'cost', { card: { spec } as any }), panel('c2', 'campaigns', 'funnel', { card: { preset: 'campaign-scorecard' } })])], 11)
    expect(out.pages[0].widgets[0].card).toEqual({ spec })
    expect(out.pages[0].widgets[1].card).toEqual({ preset: 'campaign-scorecard' })
  })

  it('a chart panel scoped to one campaign keeps that scope as a campaignFlight filter', () => {
    const one = swapPanelChart(panel('h', 'campaigns', 'hourOfDay', { campaignIds: ['24279250691'] }) as Widget)
    expect(one.filters?.drill).toEqual([
      { key: 'arrival', value: 'tagged', label: 'Tagged' },
      { key: 'campaignFlight', value: '24279250691', label: 'US+CA web retest' },
    ])
    const several = swapPanelChart(panel('f', 'campaigns', 'flightDay', { campaignIds: ['24279250691', '24215315197'] }) as Widget)
    expect(several.filters?.drill).toEqual([{ key: 'arrival', value: 'tagged', label: 'Tagged' }])
  })

  it('idempotent at every level: a swapped chart and a carded panel are left as they are', () => {
    const p = { id: 'p', name: 'p', isDefault: false, group: 'Mine', filters: {} as any, widgets: [hourOfDayWidget({ x: 0, y: 0, w: 1, h: 1 }), { ...(panel('r', 'campaigns', 'returns') as Widget), card: { preset: 'campaign-returns' } }] }
    expect(migratePanelsV11(p)).toBe(p)
    const once = migratePanelsV11({ ...p, widgets: [panel('x', 'campaigns', 'flightDay') as Widget] })
    expect(migratePanelsV11(once)).toBe(once)
  })
})
