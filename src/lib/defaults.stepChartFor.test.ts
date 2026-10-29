// Saved layouts after T1: every saved Features-page step chart (dataset 'features', view 'steps:<id>') is DRAWN as the
// ordinary geo chart through stepChartFor at render time, and nothing stored is rewritten (ADR 0005 decision 2). The
// fixture is the one shape every step chart has in the production layout (version 19, copied 2026-10-27): the 14 fw-*
// widgets differ only in id, title, view and grid cell. No env data in it.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, defaultFeaturesWidgets, featureStepWidget, normalizeConfig, stepChartFor } from './defaults'
import { FEATURES, stepsViewFor } from './featureHealth'
import type { Widget } from '../types'

const savedStepChart = (id: string, i: number, extra: Record<string, unknown> = {}): Widget =>
  ({ id: `fw-${id}`, title: FEATURES.find((f) => f.id === id)?.label ?? id, type: 'line', dataset: 'features', view: stepsViewFor(id), dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: (i % 2) * 6, y: Math.floor(i / 2) * 8, w: 6, h: 8, i: `fw-${id}`, ...extra }) as unknown as Widget
const SAVED = FEATURES.map((f, i) => savedStepChart(f.id, i))
// The other 'features' widgets in the production layout: not step charts, so stepChartFor leaves them alone.
const OTHERS = [
  { id: 'ow-feature-health', i: 'ow-feature-health', title: 'Feature health', type: 'table', dataset: 'features', view: 'health', dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: 0, y: 0, w: 12, h: 10 },
  { id: 'fw-coach-tips', i: 'fw-coach-tips', title: 'Coach tips', type: 'table', dataset: 'features', view: 'coach-tips', dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: 0, y: 56, w: 12, h: 10 },
  { id: 'fw-ask-order', i: 'fw-ask-order', title: 'Ask-order A/B', type: 'table', dataset: 'features', view: 'ask-order', dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: 0, y: 66, w: 12, h: 17 },
] as unknown as Widget[]
const QUERY_FIELDS = ['type', 'dataset', 'view', 'dimension', 'metric', 'limit', 'series', 'excludeKnownTraffic'] as const
const pick = (w: Widget, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, (w as any)[k]]))

describe('stepChartFor: every saved step chart shape is drawn as the new chart', () => {
  it('the fixture has the production layout: 14 step charts, fw-funnel included, one shape', () => {
    expect(SAVED).toHaveLength(14)
    expect(SAVED.map((w) => w.id)).toContain('fw-funnel')
  })

  for (const saved of SAVED) {
    it(`${saved.id}: the query is the default chart's, the stored identity and grid cell are kept`, () => {
      const f = FEATURES.find((x) => `fw-${x.id}` === saved.id)!
      const geom = { x: saved.x, y: saved.y, w: saved.w, h: saved.h }
      const mapped = stepChartFor(saved)
      expect(pick(mapped, QUERY_FIELDS)).toEqual(pick(featureStepWidget(f, geom), QUERY_FIELDS))
      expect(pick(mapped, ['id', 'i', 'title', 'x', 'y', 'w', 'h'])).toEqual(pick(saved, ['id', 'i', 'title', 'x', 'y', 'w', 'h']))
      expect(mapped.caption).toBe(featureStepWidget(f, geom).caption)
      // The same chart the default Features page ships (its grid cell aside).
      const shipped = defaultFeaturesWidgets().find((w) => w.id === saved.id)!
      expect(pick(mapped, [...QUERY_FIELDS, 'caption', 'title'])).toEqual(pick(shipped, [...QUERY_FIELDS, 'caption', 'title']))
      // The stored widget is not touched.
      expect(saved.dataset).toBe('features')
      expect(saved.view).toBe(stepsViewFor(f.id))
    })
  }

  it('keeps what a user set on a saved step chart: caption, site override, filters, fit, hidden caveats, known traffic shown', () => {
    const extra = { caption: 'my own words', siteSel: ['bestsudoku-app'], filters: { excludeOwnVisits: true }, fit: true, hiddenCaveats: ['refused-whole-days'], excludeKnownTraffic: false }
    const mapped = stepChartFor(savedStepChart('tour', 1, extra))
    expect(mapped).toMatchObject(extra)
    expect(mapped.dataset).toBe('geo')
    expect(mapped.series?.map((s) => s.filter?.[0].value)).toEqual(['tour.start', 'tour.complete', 'tour.skip'])
  })

  it('leaves alone a step chart naming a feature this build lacks, a card, the health table, Coach tips and Ask-order', () => {
    const unknown = savedStepChart('no-such-feature', 0)
    expect(stepChartFor(unknown)).toBe(unknown)
    const card = savedStepChart('tour', 0, { card: { preset: 'campaign-scorecard' } })
    expect(stepChartFor(card)).toBe(card)
    for (const w of OTHERS) expect(stepChartFor(w)).toBe(w)
    const shipped = defaultFeaturesWidgets()
    for (const w of shipped) expect(stepChartFor(w)).toBe(w)
  })
})

describe('saved layouts need no CONFIG_VERSION bump', () => {
  const page = (widgets: Widget[]) => ({ id: 'bsk-features', name: 'Features', isDefault: false, group: 'Best Sudoku', filters: { siteSel: [], since: '2026-09-27', until: '2026-10-27', rangeRel: '30d', excludeSelfReferrals: true, excludeOwnVisits: false, ownBrowser: '', ownOS: '', drill: [] }, widgets })

  it('the production layout is already at the current version: loading it runs no migration', () => {
    expect(CONFIG_VERSION).toBe(19)
  })

  it('loading the saved Features page leaves every stored widget as it was (no load-time rewrite)', () => {
    const raw = JSON.parse(JSON.stringify({ version: 19, activePageId: 'bsk-features', pages: [page([...SAVED, ...OTHERS.slice(1)])] }))
    const loaded = normalizeConfig(raw).pages.find((p) => p.id === 'bsk-features')!
    for (const w of [...SAVED, ...OTHERS.slice(1)]) {
      const got = loaded.widgets.find((x) => x.id === w.id)!
      expect(pick(got, Object.keys(w)), w.id).toEqual(pick(w, Object.keys(w)))
    }
  })

  it('a step chart saved from the editor in its new form loads back unchanged (no new Widget field, free-string series filters)', () => {
    for (const saved of SAVED) {
      const mapped = stepChartFor(saved)
      const raw = JSON.parse(JSON.stringify({ version: 19, pages: [page([mapped])] }))
      const got = normalizeConfig(raw).pages[0].widgets[0]
      expect(pick(got, Object.keys(mapped).filter((k) => (mapped as any)[k] !== undefined)), saved.id).toEqual(
        pick(mapped, Object.keys(mapped).filter((k) => (mapped as any)[k] !== undefined)),
      )
    }
  })
})
