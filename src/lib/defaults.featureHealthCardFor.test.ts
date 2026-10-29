// Saved layouts after T2: a saved Overview "Feature health" table (dataset 'features', view 'health') that hides known
// traffic is DRAWN as the ordinary feature-health card through featureHealthCardFor at render time, and nothing stored is
// rewritten (ADR 0005 decision 2). The fixtures are the production layout's own shapes (version 19, copied 2026-10-27):
// ow-feature-health on the Overview, fw-coach-tips and fw-ask-order on the Features page. No env data in them.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, featureHealthCardFor, featureHealthWidget, normalizeConfig, stepChartFor } from './defaults'
import { presetById } from './metrics/presets'
import type { Widget } from '../types'

const SAVED_HEALTH = { id: 'ow-feature-health', title: 'Feature health', type: 'table', dataset: 'features', view: 'health', dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: 0, y: 9, w: 12, h: 20, i: 'ow-feature-health' } as unknown as Widget
const SAVED_COACH = { id: 'fw-coach-tips', title: 'Coach tips', type: 'table', dataset: 'features', view: 'coach-tips', dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: 0, y: 56, w: 12, h: 10, i: 'fw-coach-tips' } as unknown as Widget
const SAVED_ASK = { id: 'fw-ask-order', title: 'Ask-order A/B', type: 'table', dataset: 'features', view: 'ask-order', dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: 0, y: 66, w: 12, h: 17, i: 'fw-ask-order' } as unknown as Widget
const pick = (w: Widget, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, (w as any)[k]]))
const filters = { siteSel: [], since: '2026-09-27', until: '2026-10-27', rangeRel: '30d', excludeSelfReferrals: true, excludeOwnVisits: false, ownBrowser: '', ownOS: '', drill: [] }
const layout = (overview: Widget[], features: Widget[]) =>
  JSON.parse(JSON.stringify({ version: 19, activePageId: 'bsk-overview', pages: [
    { id: 'bsk-overview', name: 'Overview', isDefault: false, group: 'Best Sudoku', filters, widgets: overview },
    { id: 'bsk-features', name: 'Features', isDefault: false, group: 'Best Sudoku', filters, widgets: features },
  ] }))

describe('featureHealthCardFor: the saved Feature health table is drawn as the feature-health card', () => {
  it('maps the saved Overview widget (known traffic hidden) to the preset, keeping its identity, grid cell and query fields', () => {
    const mapped = featureHealthCardFor(SAVED_HEALTH)
    expect(mapped.card).toEqual({ preset: 'feature-health' })
    expect(presetById('feature-health')).toBeDefined()
    expect(pick(mapped, Object.keys(SAVED_HEALTH))).toEqual(pick(SAVED_HEALTH, Object.keys(SAVED_HEALTH)))
    expect(SAVED_HEALTH.card).toBeUndefined() // the stored widget is not touched
  })

  it('the default Overview widget maps the same way', () => {
    const def = featureHealthWidget({ x: 0, y: 9, w: 12, h: 20 })
    expect(def.excludeKnownTraffic).toBe(true)
    expect(featureHealthCardFor(def).card).toEqual({ preset: 'feature-health' })
  })

  it('keeps what a user set: caption, site override, filters, fit, hidden caveats', () => {
    const extra = { caption: 'my own words', siteSel: ['bestsudoku-app'], filters: { excludeOwnVisits: true }, fit: true, hiddenCaveats: ['refused-whole-days'] }
    expect(featureHealthCardFor({ ...SAVED_HEALTH, ...extra } as Widget)).toMatchObject({ ...extra, card: { preset: 'feature-health' } })
  })

  it('leaves alone a health table that SHOWS known traffic (the card always hides it), Coach tips, Ask-order and a card', () => {
    const shows = { ...SAVED_HEALTH, excludeKnownTraffic: false } as Widget
    expect(featureHealthCardFor(shows)).toBe(shows)
    const unset = { ...SAVED_HEALTH } as Widget
    delete (unset as any).excludeKnownTraffic
    expect(featureHealthCardFor(unset)).toBe(unset)
    // Coach tips is T3's mapping; until then it keeps the old body, with known traffic hidden or shown.
    expect(featureHealthCardFor(SAVED_COACH)).toBe(SAVED_COACH)
    expect(featureHealthCardFor({ ...SAVED_COACH, excludeKnownTraffic: false } as Widget).card).toBeUndefined()
    expect(featureHealthCardFor(SAVED_ASK)).toBe(SAVED_ASK)
    const card = { ...SAVED_HEALTH, card: { preset: 'bsk-kpis' } } as Widget
    expect(featureHealthCardFor(card)).toBe(card)
  })

  it('composes with stepChartFor in either order (Dashboard.vue applies both)', () => {
    expect(featureHealthCardFor(stepChartFor(SAVED_HEALTH))).toEqual(stepChartFor(featureHealthCardFor(SAVED_HEALTH)))
  })
})

describe('saved layouts need no CONFIG_VERSION bump', () => {
  it('the production layout is already at the current version: loading it runs no migration', () => {
    expect(CONFIG_VERSION).toBe(19)
  })

  it('loading the saved Overview and Features pages leaves every stored widget as it was (no load-time rewrite)', () => {
    const loaded = normalizeConfig(layout([SAVED_HEALTH], [SAVED_COACH, SAVED_ASK]))
    for (const [pageId, w] of [['bsk-overview', SAVED_HEALTH], ['bsk-features', SAVED_COACH], ['bsk-features', SAVED_ASK]] as const) {
      const got = loaded.pages.find((p) => p.id === pageId)!.widgets.find((x) => x.id === w.id)!
      expect(pick(got, Object.keys(w)), w.id).toEqual(pick(w, Object.keys(w)))
      expect(got.card, w.id).toBeUndefined()
    }
  })

  it('the mapped widget, saved back as it is drawn, loads back unchanged (card is an existing Widget field)', () => {
    const mapped = featureHealthCardFor(SAVED_HEALTH)
    const got = normalizeConfig(layout([mapped], [])).pages.find((p) => p.id === 'bsk-overview')!.widgets.find((x) => x.id === mapped.id)!
    expect(pick(got, Object.keys(mapped))).toEqual(JSON.parse(JSON.stringify(mapped)))
  })
})
