// Saved layouts after T3: a saved Features-page "Coach tips" table (dataset 'features', view 'coach-tips') that hides known
// traffic is DRAWN as the ordinary coach-tips card through coachTipsCardFor at render time, and nothing stored is rewritten
// (ADR 0005 decision 2). The fixtures are the production layout's own shapes (version 19, copied 2026-10-27). No env data.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, coachTipsCardFor, featureHealthCardFor, normalizeConfig, stepChartFor } from './defaults'
import { presetById } from './metrics/presets'
import { validateCard } from './metrics/validate'
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
const shown = (w: Widget) => coachTipsCardFor(featureHealthCardFor(stepChartFor(w))) // Dashboard.vue's chain

describe('coachTipsCardFor: the saved Coach tips table is drawn as the coach-tips card', () => {
  it('maps the saved Features-page widget (known traffic hidden) to a valid preset, keeping its identity, grid cell and query fields', () => {
    const mapped = coachTipsCardFor(SAVED_COACH)
    expect(mapped.card).toEqual({ preset: 'coach-tips' })
    expect(validateCard(presetById('coach-tips')!)).toEqual([])
    expect(pick(mapped, Object.keys(SAVED_COACH))).toEqual(pick(SAVED_COACH, Object.keys(SAVED_COACH)))
    expect(SAVED_COACH.card).toBeUndefined()
  })

  it('keeps what a user set: caption, site override, filters, fit, hidden caveats', () => {
    const extra = { caption: 'my own words', siteSel: ['bestsudoku-app'], filters: { excludeOwnVisits: true }, fit: true, hiddenCaveats: ['coach-measurement'] }
    expect(coachTipsCardFor({ ...SAVED_COACH, ...extra } as unknown as Widget)).toMatchObject({ ...extra, card: { preset: 'coach-tips' } })
  })

  it('only the Coach tips widget maps: one that SHOWS known traffic, Feature health, Ask-order and a card are left alone', () => {
    const shows = { ...SAVED_COACH, excludeKnownTraffic: false } as Widget
    expect(coachTipsCardFor(shows)).toBe(shows)
    const unset = { ...SAVED_COACH } as Widget
    delete (unset as any).excludeKnownTraffic
    expect(coachTipsCardFor(unset)).toBe(unset)
    expect(coachTipsCardFor(SAVED_HEALTH)).toBe(SAVED_HEALTH)
    expect(coachTipsCardFor(SAVED_ASK)).toBe(SAVED_ASK)
    const card = { ...SAVED_COACH, card: { preset: 'bsk-kpis' } } as Widget
    expect(coachTipsCardFor(card)).toBe(card)
  })

  it("Dashboard.vue's chain: Coach tips -> coach-tips, Feature health -> feature-health, Ask-order untouched", () => {
    expect(shown(SAVED_COACH).card).toEqual({ preset: 'coach-tips' })
    expect(shown(SAVED_HEALTH).card).toEqual({ preset: 'feature-health' })
    expect(shown(SAVED_ASK)).toEqual(stepChartFor(SAVED_ASK))
  })
})

describe('saved layouts need no CONFIG_VERSION bump', () => {
  it('the production layout is already at the current version', () => {
    expect(CONFIG_VERSION).toBe(19)
  })

  it('loading the saved Overview and Features pages leaves every stored widget as it was', () => {
    const loaded = normalizeConfig(layout([SAVED_HEALTH], [SAVED_COACH, SAVED_ASK]))
    for (const [pageId, w] of [['bsk-overview', SAVED_HEALTH], ['bsk-features', SAVED_COACH], ['bsk-features', SAVED_ASK]] as const) {
      const got = loaded.pages.find((p) => p.id === pageId)!.widgets.find((x) => x.id === w.id)!
      expect(pick(got, Object.keys(w)), w.id).toEqual(pick(w, Object.keys(w)))
      expect(got.card, w.id).toBeUndefined()
    }
  })

  it('the mapped widget, saved back as it is drawn, loads back unchanged', () => {
    const mapped = coachTipsCardFor(SAVED_COACH)
    const got = normalizeConfig(layout([], [mapped])).pages.find((p) => p.id === 'bsk-features')!.widgets.find((x) => x.id === mapped.id)!
    expect(pick(got, Object.keys(mapped))).toEqual(JSON.parse(JSON.stringify(mapped)))
  })
})
