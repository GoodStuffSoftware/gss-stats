// Editor tools T7 and T4: no bespoke 'features' body is left. Every saved 'features' widget must reach the screen through
// the render-time mappings (stepChartFor, featureHealthCardFor, coachTipsCardFor, askOrderCardFor; ADR 0005 decision 2),
// with nothing stored rewritten; and the "Best Sudoku · Features" page template builds the page from editor widgets.
// The fixtures are the production layout's own widget shapes (version 19, read 2026-10-29: ids, views and switches;
// the grid cells are made up). No env data.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, TEMPLATE_WIDGETS, askOrderCardFor, coachTipsCardFor, defaultFeaturesWidgets, defaultWidgetsForPage, featureHealthCardFor, normalizeConfig, stepChartFor } from './defaults'
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
const shown = (w: Widget) => askOrderCardFor(coachTipsCardFor(featureHealthCardFor(stepChartFor(w)))) // Dashboard.vue's chain
// ChartCard.vue's routing for the dataset: the retired-panel text for any 'features' widget no mapping covered,
// everything else a card or an ordinary chart.
const body = (w: Widget) => (w.card ? 'card' : w.dataset === 'features' ? 'retired' : 'chart')

describe('T7 saved-layout safety: the old Feature health bodies are gone, saved widgets still render', () => {
  it('normalizeConfig leaves every stored features widget exactly as saved (no migration, layout version unchanged)', () => {
    const cfg = normalizeConfig(layout())
    expect(CONFIG_VERSION).toBe(19)
    const page = (id: string) => cfg.pages.find((p: DashboardPage) => p.id === id)!
    expect(JSON.parse(JSON.stringify(page('bsk-overview').widgets.filter((w) => w.dataset === 'features')))).toEqual(JSON.parse(JSON.stringify(SAVED_OVERVIEW)))
    expect(JSON.parse(JSON.stringify(page('bsk-features').widgets.filter((w) => w.dataset === 'features')))).toEqual(JSON.parse(JSON.stringify(SAVED_FEATURES)))
  })

  it('every saved widget renders as an editor card or chart; none falls to the retired text', () => {
    const cfg = normalizeConfig(layout())
    const all = cfg.pages.flatMap((p: DashboardPage) => p.widgets).filter((w) => w.dataset === 'features')
    expect(all).toHaveLength(17)
    const out = all.map((w) => ({ id: w.id, body: body(shown(w)), w: shown(w) }))
    expect(out.filter((x) => x.body === 'retired')).toEqual([])
    for (const x of out.filter((o) => o.body === 'card')) expect(validateCard(presetById((x.w.card as { preset: string }).preset)!), x.id).toEqual([])
    expect(out.filter((x) => x.body === 'card').map((x) => [x.id, (x.w.card as { preset: string }).preset])).toEqual([['ow-feature-health', 'feature-health'], ['fw-coach-tips', 'coach-tips'], ['fw-ask-order', 'ask-order']])
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
  it.runIf(!!process.env.T7_PROD_COPY)('the full production layout copy: stored widgets unchanged, every features widget mapped', async () => {
    const fs = await import('node:fs')
    const raw = JSON.parse(fs.readFileSync(process.env.T7_PROD_COPY!, 'utf8'))
    // Widget ids repeat across pages, so a widget is keyed by its page and id.
    const key = (p: DashboardPage, w: Widget) => `${p.id}/${w.id}`
    const before = (raw.pages as DashboardPage[]).flatMap((p) => p.widgets.map((w) => [key(p, w), w] as const))
    const norm = normalizeConfig(JSON.parse(JSON.stringify(raw))).pages as DashboardPage[]
    const after = norm.flatMap((p) => p.widgets)
    const byId = new Map(norm.flatMap((p) => p.widgets.map((w) => [key(p, w), w] as const)))
    const changed = before.filter(([k, w]) => JSON.stringify(byId.get(k)) !== JSON.stringify(w)).map(([k]) => k)
    console.log(`prod copy: ${before.length} widgets, changed by normalizeConfig: ${changed.join(', ') || 'none'}`)
    for (const [k, w] of before.filter(([, x]) => x.dataset === 'features')) expect(JSON.parse(JSON.stringify(byId.get(k))), k).toEqual(JSON.parse(JSON.stringify(w)))
    const feats = after.filter((w) => w.dataset === 'features')
    expect(feats.filter((w) => body(shown(w)) === 'retired').map((w) => w.id)).toEqual([])
    expect(after.flatMap((w) => unknownFeatureStepValues(shown(w).series))).toEqual([])
  })

  it('a features widget no mapping covers (shows known traffic, or names an unknown feature) gets the retired text, not an old body', () => {
    const shows = { ...legacy('x-health', 'health', 0), excludeKnownTraffic: false } as Widget
    const tipsShows = { ...legacy('x-tips', 'coach-tips', 0), excludeKnownTraffic: false } as Widget
    const askShows = { ...legacy('x-ask', ASK_ORDER_VIEW, 0), excludeKnownTraffic: false } as Widget
    const unknown = legacy('x-steps', stepsViewFor('no-such-feature'), 0)
    for (const w of [shows, tipsShows, askShows, unknown]) expect(body(shown(w)), w.id).toBe('retired')
  })
})

describe('T7 page template: Best Sudoku · Features', () => {
  const tpl = PAGE_TEMPLATES.find((t) => t.id === 'tpl-bsk-features')!
  const built = () => buildPage({ ...newPageDraft('Best Sudoku'), name: 'My features', start: 'tpl-bsk-features' }, { id: 'x', name: 'x', isDefault: false, group: 'Best Sudoku', filters: filters as any, widgets: [] })

  it('is offered under that name, and its chart set is the Features page restore set', () => {
    expect(tpl.label).toBe('Best Sudoku · Features')
    expect(JSON.stringify(TEMPLATE_WIDGETS['tpl-bsk-features']())).toBe(JSON.stringify(defaultFeaturesWidgets()))
  })

  it('builds 14 chart-editor step charts, the Coach tips and Ask-order A/B card-editor presets', () => {
    const page = built()
    expect(page.templateId).toBe('tpl-bsk-features')
    expect(page.id).not.toBe('bsk-features')
    const kinds = page.widgets.map((w) => body(w))
    expect(kinds).toEqual([...FEATURES.map(() => 'chart'), 'card', 'card'])
    const charts = page.widgets.slice(0, FEATURES.length)
    for (const [i, w] of charts.entries()) {
      expect(w).toMatchObject({ type: 'line', dataset: 'geo', dimension: 'dateEt', excludeKnownTraffic: true, title: FEATURES[i].label })
      expect(unknownFeatureStepValues(w.series)).toEqual([])
    }
    expect(page.widgets[FEATURES.length].card).toEqual({ preset: 'coach-tips' })
    expect(page.widgets[FEATURES.length + 1].card).toEqual({ preset: 'ask-order' })
    // Drawn as they are: the mappings have nothing left to change on a template page.
    for (const w of page.widgets) expect(shown(w)).toEqual(w)
  })

  it('Restore default charts on a page built from it gives the same set back', () => {
    const page = built()
    expect(JSON.stringify(defaultWidgetsForPage({ ...page, widgets: [] }).map((w) => w.id))).toBe(JSON.stringify(defaultFeaturesWidgets().map((w) => w.id)))
  })
})
