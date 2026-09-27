// The v10 layout migration (ADR 0003 slice 5 phase B): the Overview's bespoke 'kpis' and
// 'scorecard' panels gain `card: { preset }` and render as metric cards. Round trips on the real
// default layout, on the production layout (sanitised, read-only from KV: see
// __fixtures__/prodLayout.v8.json and its v9 normalisation prodLayout.v9.json), on custom,
// deleted and renamed variants, and on an already-v10 layout; plus normCardRef, which keeps a
// saved card through the field whitelist and turns a bad one into a placeholder.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, defaultConfig, migrateCardsV10, normalizeConfig, syncCardWithView, withCardForView } from './defaults'
import { INVALID_CARD_PRESET, normCardRef } from './metrics/validate'
import { presetById } from './metrics/presets'
import type { DashboardConfig, DashboardPage, Widget } from '../types'
import PROD_V8 from './__fixtures__/prodLayout.v8.json'
import PROD_V9 from './__fixtures__/prodLayout.v9.json'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
/** Relative ranges are recomputed on every load; blank them so layouts compare by content. */
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
/** A stable string of a value: object keys sorted, undefined fields dropped. */
function sorted(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))
}
const widgetsById = (cfg: DashboardConfig) => new Map(cfg.pages.flatMap((p) => p.widgets.map((w) => [`${p.id}/${w.id}`, w] as const)))
const page = (id: string, widgets: unknown[], name = id): any => ({ id, name, filters: {}, widgets })
const panel = (id: string, view: string, extra: Partial<Widget> = {}): Partial<Widget> => ({ id, i: id, title: 'T', type: 'table', dataset: 'overview', view, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 12, h: 8, ...extra })

describe('v10: the real default layout', () => {
  it('ships the two panels as cards, and survives a load/save round trip unchanged', () => {
    const d = defaultConfig()
    expect(d.version).toBe(10)
    expect(CONFIG_VERSION).toBe(10)
    const ov = d.pages.find((p) => p.id === 'bsk-overview')!
    expect(ov.widgets.find((w) => w.id === 'ow-kpis')!.card).toEqual({ preset: 'bsk-kpis' })
    expect(ov.widgets.find((w) => w.id === 'ow-scorecard')!.card).toEqual({ preset: 'campaign-scorecard' })
    expect(ov.widgets.find((w) => w.id === 'ow-release')!.card).toBeUndefined() // stays bespoke
    const once = normalizeConfig(clone(d))
    expect(stable(once)).toEqual(stable(normalizeConfig(clone(d))))
    expect(stable(normalizeConfig(clone(once)))).toEqual(stable(once))
    for (const [, w] of widgetsById(once)) if (w.card && 'preset' in w.card) expect(presetById(w.card.preset), w.id).toBeDefined()
  })
})

describe('v10: the production layout (sanitised)', () => {
  const v10FromV9 = normalizeConfig(clone(PROD_V9))
  const v10FromV8 = normalizeConfig(clone(PROD_V8))

  it('the fixtures are what they claim: v8 as stored, v9 as normalised by the v9 build', () => {
    expect((PROD_V8 as any).version).toBe(8)
    expect((PROD_V9 as any).version).toBe(9)
    expect(JSON.stringify(PROD_V8)).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/) // no emails
  })

  it('v9 → v10 changes exactly two widgets, by adding a card, and nothing else', () => {
    const before = widgetsById(PROD_V9 as unknown as DashboardConfig)
    const after = widgetsById(v10FromV9)
    expect([...after.keys()]).toEqual([...before.keys()]) // no widget added, removed or reordered
    // Compared by content: key order and absent-vs-undefined fields don't count (normWidget
    // re-orders a widget's keys on every load).
    const canon = (w: unknown) => sorted(stable({ pages: [{ filters: {}, widgets: [w] }] } as any))
    const changed = [...after].filter(([k, w]) => canon(w) !== canon(before.get(k)))
    expect(changed.map(([k]) => k)).toEqual(['bsk-overview/ow-kpis', 'bsk-overview/ow-scorecard'])
    for (const [k, w] of changed) {
      const { card, ...rest } = w
      expect(card, k).toEqual({ preset: k.endsWith('ow-kpis') ? 'bsk-kpis' : 'campaign-scorecard' })
      expect(rest, k).toEqual(before.get(k)) // id, title, dataset/view, x/y/w/h, notes: all kept
    }
    expect(v10FromV9.pages.map((p) => [p.id, p.name])).toEqual((PROD_V9 as any).pages.map((p: DashboardPage) => [p.id, p.name]))
    expect(v10FromV9.activePageId).toBe((PROD_V9 as any).activePageId)
  })

  it('v8 → v10 in one load equals v8 → v9 → v10', () => {
    expect(stable(v10FromV8)).toEqual(stable(v10FromV9))
  })

  it('v10 → v10 is a no-op (idempotent), and survives JSON', () => {
    expect(stable(normalizeConfig(clone(v10FromV9)))).toEqual(stable(v10FromV9))
  })
})

describe('v10: custom, deleted and renamed variants', () => {
  const load = (pages: any[], version = 9) => normalizeConfig({ version, activePageId: pages[0].id, pages })

  it('keeps a renamed, moved, resized, captioned, default-marked panel exactly, adding only the card', () => {
    const custom = panel('ow-kpis', 'kpis', { title: 'My glance', x: 2, y: 40, w: 6, h: 11, notes: ['small-sample'], isDefault: true })
    const out = load([page('bsk-overview', [custom], 'My renamed overview')])
    const w = out.pages[0].widgets[0]
    expect(w).toMatchObject({ ...custom, card: { preset: 'bsk-kpis' } })
    expect(out.pages[0].name).toBe('My renamed overview')
  })

  it('never resurrects a deleted panel: an Overview without a scorecard stays without one', () => {
    const out = load([page('bsk-overview', [panel('ow-kpis', 'kpis'), panel('ow-release', 'releasePanel')])])
    expect(out.pages.find((p) => p.id === 'bsk-overview')!.widgets.map((w) => w.id)).toEqual(['ow-kpis', 'ow-release'])
  })

  it('matches panels by what they are, on any page, whatever their id or title — never by a name', () => {
    const out = load([page('bsk-campaigns', [panel('abc123', 'scorecard', { title: 'Campaign scorecard (copy)' })], 'Best Sudoku · Campaigns'), page('p2', [panel('x9', 'kpis')], 'Scratch')])
    expect(out.pages.find((p) => p.id === 'bsk-campaigns')!.widgets[0].card).toEqual({ preset: 'campaign-scorecard' })
    expect(out.pages.find((p) => p.id === 'p2')!.widgets[0].card).toEqual({ preset: 'bsk-kpis' })
  })

  it('a widget titled like a panel but not one (another dataset or view) is left alone', () => {
    const out = load([page('p', [{ ...panel('a', 'releasePanel'), title: 'Today at a glance' }, { id: 'b', title: 'Campaign scorecard', type: 'bar', dataset: 'geo', dimension: 'site', metric: 'pageviews', limit: 5, x: 0, y: 0, w: 4, h: 4 }])])
    for (const w of out.pages[0].widgets) expect(w.card, w.id).toBeUndefined()
  })

  it('an existing card (a customised spec or another preset) is never replaced', () => {
    const spec = { v: 1, sections: [{ layout: 'tiles', items: [{ id: 'pv', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: { as: 'number' } }] }] }
    const out = load([page('p', [panel('a', 'kpis', { card: { spec } as any }), panel('b', 'scorecard', { card: { preset: 'bsk-kpis' } })])], 10)
    expect(out.pages[0].widgets[0].card).toEqual({ spec })
    expect(out.pages[0].widgets[1].card).toEqual({ preset: 'bsk-kpis' })
  })

  it('an invalid saved card becomes the placeholder, never a crash; other widgets load normally', () => {
    const bad = [
      { spec: { v: 1, sections: 'nope' } },
      { spec: { v: 1, sections: [{ layout: 'tiles', items: [{ id: 'x', label: 'X', data: { metric: 'nope' }, display: { as: 'number' } }] }] } },
      { spec: { v: 1, sections: Array.from({ length: 9 }, () => ({ layout: 'rows', items: [] })) } },
      { spec: { v: 1, sections: [{ layout: 'rows', items: [{ id: 'x', label: 'x'.repeat(201), data: { field: 'campaign.label' }, display: { as: 'text' } }] }] } },
      { preset: 42 },
      { preset: 'Not A Valid Id!' },
    ]
    const out = load([page('p', [...bad.map((card, i) => ({ id: `w${i}`, title: 't', type: 'card', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: i, w: 4, h: 4, card })), { id: 'ok', title: 'ok', type: 'bar', dimension: 'site', metric: 'pageviews', limit: 5, x: 0, y: 99, w: 4, h: 4 }])], 10)
    const ws = out.pages[0].widgets
    for (let i = 0; i < bad.length; i++) expect(ws[i].card, `bad[${i}]`).toEqual({ preset: INVALID_CARD_PRESET })
    expect(ws[ws.length - 1].id).toBe('ok')
  })
})

describe('normCardRef', () => {
  it('absent or not an object: no card', () => {
    for (const x of [undefined, null, 'bsk-kpis', 7, [], true]) expect(normCardRef(x)).toBeUndefined()
    expect(normCardRef({})).toBeUndefined()
  })
  it('a preset is kept by id; an unknown id is kept too (MetricCard shows it as unknown, never guessed)', () => {
    expect(normCardRef({ preset: 'bsk-kpis', extra: 1 })).toEqual({ preset: 'bsk-kpis' })
    expect(normCardRef({ preset: 'constructor' })).toEqual({ preset: 'constructor' })
  })
  it('a valid spec is kept as a plain-JSON copy', () => {
    const spec = { v: 1, sections: [{ layout: 'tiles', items: [{ id: 'pv', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: { as: 'number' } }] }] }
    const out = normCardRef({ spec })
    expect(out).toEqual({ spec })
    expect((out as any).spec).not.toBe(spec)
  })
  it('an oversized spec is the placeholder', () => {
    const big = { v: 1, sections: [{ layout: 'rows', items: Array.from({ length: 41 }, (_, i) => ({ id: `i${i}`, label: 'x', data: { field: 'campaign.label' }, display: { as: 'text' } })) }] }
    expect(normCardRef({ spec: big })).toEqual({ preset: INVALID_CARD_PRESET })
  })
})

describe('the chart editor keeps the card in step with the view', () => {
  it('into a card panel: gets the card; away from it: loses the preset card that came with the old view', () => {
    const w = panel('a', 'kpis') as Widget
    expect(syncCardWithView(w).card).toEqual({ preset: 'bsk-kpis' })
    const moved = { ...withCardForView(w), view: 'releasePanel' }
    expect(syncCardWithView(moved).card).toBeUndefined()
    const custom = { ...(panel('b', 'releasePanel') as Widget), card: { spec: {} as any } }
    expect(syncCardWithView(custom).card).toEqual({ spec: {} }) // a customised card is not the view's
  })
  it('migrateCardsV10 returns the same page object when there is nothing to do', () => {
    const p = { id: 'p', name: 'p', isDefault: false, filters: {} as any, widgets: [withCardForView(panel('a', 'kpis') as Widget)] }
    expect(migrateCardsV10(p)).toBe(p)
  })
})
