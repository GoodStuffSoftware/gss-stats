// Saved layouts after T4: a saved Features-page "Ask-order A/B" widget (dataset 'features', view 'ask-order') that hides
// known traffic is DRAWN as the ordinary ask-order card through askOrderCardFor at render time, and nothing stored is
// rewritten (ADR 0005 decision 2). The fixture is the production layout's own shape (version 19). No env data.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, askOrderCardFor, coachTipsCardFor, featureHealthCardFor, normalizeConfig, stepChartFor } from './defaults'
import { presetById } from './metrics/presets'
import { validateCard } from './metrics/validate'
import type { Widget } from '../types'

const SAVED_ASK = { id: 'fw-ask-order', title: 'Ask-order A/B', type: 'table', dataset: 'features', view: 'ask-order', dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: 0, y: 66, w: 12, h: 17, i: 'fw-ask-order' } as unknown as Widget
const SAVED_COACH = { ...SAVED_ASK, id: 'fw-coach-tips', i: 'fw-coach-tips', title: 'Coach tips', view: 'coach-tips' } as unknown as Widget
const SAVED_HEALTH = { ...SAVED_ASK, id: 'ow-feature-health', i: 'ow-feature-health', title: 'Feature health', view: 'health' } as unknown as Widget
const pick = (w: Widget, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, (w as any)[k]]))
const filters = { siteSel: [], since: '2026-09-29', until: '2026-10-29', excludeSelfReferrals: true, excludeOwnVisits: false, ownBrowser: '', ownOS: '', drill: [] }
const layout = (features: Widget[]) =>
  JSON.parse(JSON.stringify({ version: 19, activePageId: 'bsk-features', pages: [{ id: 'bsk-features', name: 'Features', isDefault: false, group: 'Best Sudoku', filters, widgets: features }] }))
const shown = (w: Widget) => askOrderCardFor(coachTipsCardFor(featureHealthCardFor(stepChartFor(w)))) // Dashboard.vue's chain

describe('askOrderCardFor: the saved Ask-order A/B is drawn as the ask-order card', () => {
  it('maps the saved widget (known traffic hidden) to a valid preset, keeping its identity, grid cell and query fields', () => {
    const mapped = askOrderCardFor(SAVED_ASK)
    expect(mapped.card).toEqual({ preset: 'ask-order' })
    expect(validateCard(presetById('ask-order')!)).toEqual([])
    expect(pick(mapped, Object.keys(SAVED_ASK))).toEqual(pick(SAVED_ASK, Object.keys(SAVED_ASK)))
    expect(SAVED_ASK.card).toBeUndefined()
  })

  it('keeps what a user set: caption, site override, filters, fit, hidden caveats', () => {
    const extra = { caption: 'my own words', siteSel: ['bestsudoku-app'], filters: { excludeOwnVisits: true }, fit: true, hiddenCaveats: ['ask-order-caption'] }
    expect(askOrderCardFor({ ...SAVED_ASK, ...extra } as unknown as Widget)).toMatchObject({ ...extra, card: { preset: 'ask-order' } })
  })

  it('only the Ask-order widget maps: one that SHOWS known traffic, Coach tips, Feature health and a card are left alone', () => {
    const shows = { ...SAVED_ASK, excludeKnownTraffic: false } as Widget
    expect(askOrderCardFor(shows)).toBe(shows)
    const unset = { ...SAVED_ASK } as Widget
    delete (unset as any).excludeKnownTraffic
    expect(askOrderCardFor(unset)).toBe(unset)
    expect(askOrderCardFor(SAVED_COACH)).toBe(SAVED_COACH)
    expect(askOrderCardFor(SAVED_HEALTH)).toBe(SAVED_HEALTH)
    const card = { ...SAVED_ASK, card: { preset: 'bsk-kpis' } } as Widget
    expect(askOrderCardFor(card)).toBe(card)
  })

  it("Dashboard.vue's chain draws each saved widget as its own preset", () => {
    expect(shown(SAVED_ASK).card).toEqual({ preset: 'ask-order' })
    expect(shown(SAVED_COACH).card).toEqual({ preset: 'coach-tips' })
    expect(shown(SAVED_HEALTH).card).toEqual({ preset: 'feature-health' })
  })
})

describe('saved layouts need no CONFIG_VERSION bump', () => {
  it('the production layout is already at the current version, and loading it leaves the stored widget as it was', () => {
    expect(CONFIG_VERSION).toBe(19)
    const got = normalizeConfig(layout([SAVED_ASK])).pages[0].widgets.find((x: Widget) => x.id === SAVED_ASK.id)!
    expect(pick(got, Object.keys(SAVED_ASK))).toEqual(pick(SAVED_ASK, Object.keys(SAVED_ASK)))
    expect(got.card).toBeUndefined()
  })

  it('the mapped widget, saved back as it is drawn, loads back unchanged', () => {
    const mapped = askOrderCardFor(SAVED_ASK)
    const got = normalizeConfig(layout([mapped])).pages[0].widgets.find((x: Widget) => x.id === mapped.id)!
    expect(pick(got, Object.keys(mapped))).toEqual(JSON.parse(JSON.stringify(mapped)))
  })
})
