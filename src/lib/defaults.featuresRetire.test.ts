// Editor tools T7: FeatureHealthCard draws only the Ask-order A/B now. Every other saved 'features' widget must reach the
// screen through the render-time mappings (stepChartFor, featureHealthCardFor, coachTipsCardFor; ADR 0005 decision 2),
// with nothing stored rewritten; and the "Best Sudoku · Features" page template builds the page from editor widgets.
// The fixtures are the production layout's own widget shapes (version 19, read 2026-10-29: ids, views and switches;
// the grid cells are made up). No env data.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, TEMPLATE_WIDGETS, coachTipsCardFor, defaultFeaturesWidgets, defaultWidgetsForPage, featureHealthCardFor, normalizeConfig, stepChartFor } from './defaults'
import { buildPage, newPageDraft, PAGE_TEMPLATES } from './wizards'
import { FEATURES, featureStepOf, stepsViewFor, unknownFeatureStepValues } from './featureHealth'
import { ASK_ORDER_VIEW } from './askOrder'
import { presetById } from './metrics/presets'
import { validateCard } from './metrics/validate'
import type { DashboardPage, Widget } from '../types'

const legacy = (id: string, view: string, y: number) =>
  ({ id, i: id, title: id, type: 'table', dataset: 'features', view, dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: 0, y, w: 12, h: 8 }) as unknown as Widget
// The 17 saved 'features' widgets in production: Feature health on the Overview, 14 step charts, Coach tips and Ask-order.
const STEP_IDS = ['coach', 'tour', 'signin', 'first50-promo', 'first50-congrats', 'upsell', 'install', 'welcome', 'games', 'games-easy', 'games-medium', 'games-hard', 'games-expert', 'funnel']
const SAVED_OVERVIEW = [legacy('ow-feature-health', 'health', 9)]
const SAVED_FEATURES = [...STEP_IDS.map((id, n) => legacy(`fw-${id}`, stepsViewFor(id), n * 8)), legacy('fw-coach-tips', 'coach-tips', 112), legacy('fw-ask-order', ASK_ORDER_VIEW, 122)]
const filters = { siteSel: [], since: '2026-09-29', until: '2026-10-29', excludeSelfReferrals: true, excludeOwnVisits: false, ownBrowser: '', ownOS: '', drill: [] }
const layout = () =>
  JSON.parse(JSON.stringify({ version: 19, activePageId: 'bsk-overview', pages: [
    { id: 'bsk-overview', name: 'Overview', isDefault: false, group: 'Best Sudoku', filters, widgets: SAVED_OVERVIEW },
    { id: 'bsk-features', name: 'Features', isDefault: false, group: 'Best Sudoku', filters, widgets: SAVED_FEATURES },
  ] }))
const shown = (w: Widget) => coachTipsCardFor(featureHealthCardFor(stepChartFor(w))) // Dashboard.vue's chain
// ChartCard.vue's routing for the dataset: FeatureHealthCard for Ask-order, the retired-panel text for any other
// 'features' widget no mapping covered, everything else a card or an ordinary chart.
const body = (w: Widget) => (w.card ? 'card' : w.dataset === 'features' ? (w.view === ASK_ORDER_VIEW ? 'ask-order' : 'retired') : 'chart')

describe('T7 saved-layout safety: the old Feature health bodies are gone, saved widgets still render', () => {
  it('normalizeConfig leaves every stored features widget exactly as saved (no migration, layout version unchanged)', () => {
    const cfg = normalizeConfig(layout())
    expect(CONFIG_VERSION).toBe(19)
    const page = (id: string) => cfg.pages.find((p: DashboardPage) => p.id === id)!
    expect(JSON.parse(JSON.stringify(page('bsk-overview').widgets.filter((w) => w.dataset === 'features')))).toEqual(JSON.parse(JSON.stringify(SAVED_OVERVIEW)))
    expect(JSON.parse(JSON.stringify(page('bsk-features').widgets.filter((w) => w.dataset === 'features')))).toEqual(JSON.parse(JSON.stringify(SAVED_FEATURES)))
  })

  it('every saved widget but Ask-order renders as an editor card or chart; none falls to the retired text', () => {
    const cfg = normalizeConfig(layout())
    const all = cfg.pages.flatMap((p: DashboardPage) => p.widgets).filter((w) => w.dataset === 'features')
    expect(all).toHaveLength(17)
    const out = all.map((w) => ({ id: w.id, body: body(shown(w)), w: shown(w) }))
    expect(out.filter((x) => x.body === 'ask-order').map((x) => x.id)).toEqual(['fw-ask-order'])
    expect(out.filter((x) => x.body === 'retired')).toEqual([])
    for (const x of out.filter((o) => o.body === 'card')) expect(validateCard(presetById((x.w.card as { preset: string }).preset)!), x.id).toEqual([])
    expect(out.filter((x) => x.body === 'card').map((x) => [x.id, (x.w.card as { preset: string }).preset])).toEqual([['ow-feature-health', 'feature-health'], ['fw-coach-tips', 'coach-tips']])
    const charts = out.filter((x) => x.body === 'chart')
    expect(charts.map((x) => x.id)).toEqual(STEP_IDS.map((id) => `fw-${id}`))
    for (const x of charts) {
      expect(x.w).toMatchObject({ type: 'line', dataset: 'geo', dimension: 'dateEt' })
      expect(unknownFeatureStepValues(x.w.series), x.id).toEqual([])
      expect(x.w.series!.every((s) => featureStepOf(s.filter![0].value)), x.id).toBe(true)
    }
  })

  // A one-off check on a full read-only copy of the production layout (never committed: it is a prod copy). Set
  // T7_PROD_COPY to its path to run it; skipped otherwise.
  it.runIf(!!process.env.T7_PROD_COPY)('the full production layout copy: stored widgets unchanged, every features widget but Ask-order mapped', async () => {
    const fs = await import('node:fs')
    const raw = JSON.parse(fs.readFileSync(process.env.T7_PROD_COPY!, 'utf8'))
    const before = raw.pages.flatMap((p: DashboardPage) => p.widgets) as Widget[]
    const after = normalizeConfig(JSON.parse(JSON.stringify(raw))).pages.flatMap((p: DashboardPage) => p.widgets)
    const byId = new Map(after.map((w) => [w.id, w]))
    const changed = before.filter((w) => JSON.stringify(byId.get(w.id)) !== JSON.stringify(w)).map((w) => w.id)
    console.log(`prod copy: ${before.length} widgets, changed by normalizeConfig: ${changed.join(', ') || 'none'}`)
    for (const w of before.filter((x) => x.dataset === 'features')) expect(JSON.parse(JSON.stringify(byId.get(w.id))), w.id).toEqual(JSON.parse(JSON.stringify(w)))
    const feats = after.filter((w) => w.dataset === 'features')
    expect(feats.filter((w) => body(shown(w)) === 'retired').map((w) => w.id)).toEqual([])
    expect(feats.filter((w) => body(shown(w)) === 'ask-order').map((w) => w.id)).toEqual(['fw-ask-order'])
    expect(after.flatMap((w) => unknownFeatureStepValues(shown(w).series))).toEqual([])
  })

  it('a features widget no mapping covers (shows known traffic, or names an unknown feature) gets the retired text, not an old body', () => {
    const shows = { ...legacy('x-health', 'health', 0), excludeKnownTraffic: false } as Widget
    const tipsShows = { ...legacy('x-tips', 'coach-tips', 0), excludeKnownTraffic: false } as Widget
    const unknown = legacy('x-steps', stepsViewFor('no-such-feature'), 0)
    for (const w of [shows, tipsShows, unknown]) expect(body(shown(w)), w.id).toBe('retired')
  })
})

describe('T7 page template: Best Sudoku · Features', () => {
  const tpl = PAGE_TEMPLATES.find((t) => t.id === 'tpl-bsk-features')!
  const built = () => buildPage({ ...newPageDraft('Best Sudoku'), name: 'My features', start: 'tpl-bsk-features' }, { id: 'x', name: 'x', isDefault: false, group: 'Best Sudoku', filters: filters as any, widgets: [] })

  it('is offered under that name, and its chart set is the Features page restore set', () => {
    expect(tpl.label).toBe('Best Sudoku · Features')
    expect(JSON.stringify(TEMPLATE_WIDGETS['tpl-bsk-features']())).toBe(JSON.stringify(defaultFeaturesWidgets()))
  })

  it('builds 14 chart-editor step charts, the Coach tips card-editor preset, and the Ask-order A/B (bespoke until T4)', () => {
    const page = built()
    expect(page.templateId).toBe('tpl-bsk-features')
    expect(page.id).not.toBe('bsk-features')
    const kinds = page.widgets.map((w) => body(w))
    expect(kinds).toEqual([...FEATURES.map(() => 'chart'), 'card', 'ask-order'])
    const charts = page.widgets.slice(0, FEATURES.length)
    for (const [i, w] of charts.entries()) {
      expect(w).toMatchObject({ type: 'line', dataset: 'geo', dimension: 'dateEt', excludeKnownTraffic: true, title: FEATURES[i].label })
      expect(unknownFeatureStepValues(w.series)).toEqual([])
    }
    expect(page.widgets[FEATURES.length].card).toEqual({ preset: 'coach-tips' })
    // Drawn as they are: the mappings have nothing left to change on a template page.
    for (const w of page.widgets) expect(shown(w)).toEqual(w)
  })

  it('Restore default charts on a page built from it gives the same set back', () => {
    const page = built()
    expect(JSON.stringify(defaultWidgetsForPage({ ...page, widgets: [] }).map((w) => w.id))).toBe(JSON.stringify(defaultFeaturesWidgets().map((w) => w.id)))
  })
})
