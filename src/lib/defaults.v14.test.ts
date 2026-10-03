// The sparkline layout version (ADR 0005 slice 2). It is a SAVE-GUARD bump only: no stored layout
// is rewritten by the version step. A stored sparkline item that the stricter validation now
// refuses (a today window, returnD0: main's editor never blocked them) is downgraded to its plain
// form at load by normCardRef, so it never blanks its card. Page navigation holds layout 13
// (defaults.v13.test.ts), so sparklines are 14. The number lives in LAYOUT_VERSIONS.sparklines.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, LAYOUT_VERSIONS, defaultConfig, normalizeConfig } from './defaults'
import { validateCard } from './metrics/validate'
import type { CardSpec } from './metrics/types'
import PROD_V8 from './__fixtures__/prodLayout.v8.json'
import PROD_V9 from './__fixtures__/prodLayout.v9.json'
import PROD_V12 from './__fixtures__/prodLayout.v12.json'
import { withV15Trends } from './__fixtures__/dateEtTrends'
import { withV16Caveats } from './__fixtures__/autoCaveats'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

describe('sparkline layout version', () => {
  it('the layout versions 12, 13 and 14 are unchanged (15 is the ET-day trends step: defaults.v15.test.ts)', () => {
    expect(LAYOUT_VERSIONS).toMatchObject({ compactNoteRow: 12, navigation: 13, sparklines: 14 })
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(LAYOUT_VERSIONS.sparklines)
    expect(CONFIG_VERSION).toBe(Math.max(...Object.values(LAYOUT_VERSIONS))) // follows the map, never hand-pointed
    expect(LAYOUT_VERSIONS.navigation).toBeGreaterThan(LAYOUT_VERSIONS.compactNoteRow)
    expect(LAYOUT_VERSIONS.sparklines).toBeGreaterThan(LAYOUT_VERSIONS.navigation)
  })

  it('a fresh config is written at CONFIG_VERSION', () => {
    expect(defaultConfig().version).toBe(CONFIG_VERSION)
  })

  it('a stored layout one version behind loads with the version raised and every widget untouched', () => {
    const stored = normalizeConfig(clone(defaultConfig()))
    // Some filters carry clock-derived ISO dates, so mask those and compare everything else.
    const widgetsOf = (c: typeof stored) => JSON.stringify(c.pages.map((pg) => pg.widgets)).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')
    const before = widgetsOf(withV16Caveats(stored)) // v16 (defaults.captions.test.ts) hides the automatic caveats a pre-v16 chart did not show
    const older = { ...clone(stored), version: LAYOUT_VERSIONS.sparklines - 1 }
    const after = normalizeConfig(clone(older))
    expect(after.version).toBe(CONFIG_VERSION)
    expect(widgetsOf(after)).toBe(before) // no data migration: the bump is only the save guard
  })

  it('the production layouts (v8, v9) load at the current version with their widgets intact', () => {
    for (const prod of [PROD_V8, PROD_V9]) {
      const a = normalizeConfig(clone(prod) as never)
      expect(a.version).toBe(CONFIG_VERSION)
      expect(a.pages.length).toBeGreaterThan(0)
    }
  })

  it('a card with a sparkline item survives a load unchanged', () => {
    const spec: CardSpec = {
      v: 1,
      sections: [{ layout: 'rows', items: [{ id: 'pv', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'page' }, display: { as: 'sparkline', series: 'daily' } }] }],
    }
    expect(validateCard(spec)).toEqual([])
    const cfg = clone(defaultConfig())
    const w = cfg.pages[0].widgets[0]
    w.card = { spec }
    const out = normalizeConfig(clone(cfg))
    expect(out.pages[0].widgets.find((x) => x.id === w.id)!.card).toEqual({ spec })
  })

  it('a nav-shaped v13 layout loaded under v14 changes only its version', () => {
    const nav = normalizeConfig(clone(PROD_V12) as never) // pages, groups and activePageId all in place
    const mask = (c: unknown) => JSON.stringify(c).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')
    const stored = { ...clone(nav), version: LAYOUT_VERSIONS.navigation }
    const out = normalizeConfig(clone(stored))
    expect(out.version).toBe(CONFIG_VERSION)
    // v15 moves the geo default trends to dateEt; v16 hides the automatic caveats a chart did not show; nothing else moves.
    expect(JSON.parse(mask({ ...out, version: stored.version }))).toEqual(JSON.parse(mask(withV16Caveats(withV15Trends(stored))))) // key order aside
  })

  describe('a stored sparkline that cannot be drawn degrades to a number, the rest of the card survives', () => {
    const load = (items: unknown[]): CardSpec | undefined => {
      const cfg = clone(defaultConfig())
      const w = cfg.pages[0].widgets[0]
      w.card = { spec: { v: 1, sections: [{ layout: 'rows', items }] } as CardSpec }
      const out = normalizeConfig({ ...clone(cfg), version: LAYOUT_VERSIONS.navigation }) // a stored v13 layout
      const card = out.pages[0].widgets.find((x) => x.id === w.id)!.card as { spec?: CardSpec; preset?: string }
      expect(card.preset).toBeUndefined() // never the invalid-card placeholder
      return card.spec
    }
    const sparkline = { as: 'sparkline', series: 'daily' }
    const ok = { id: 'ok', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'page' }, display: sparkline }

    it('a today-window sparkline (bsk-kpis shape) loads as a working number item', () => {
      const bad = { id: 'pv', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: sparkline }
      const spec = load([bad, ok])!
      expect(spec.sections[0].items[0].display).toEqual({ as: 'number' })
      expect(spec.sections[0].items[0].data).toEqual(bad.data) // nothing else about the item moves
      expect(spec.sections[0].items[1].display).toEqual(sparkline) // the drawable one keeps its sparkline
      expect(validateCard(spec)).toEqual([])
    })

    it('a returnD0 sparkline loads as a working number item', () => {
      const bad = { id: 'd0', label: { metric: true }, data: { metric: 'campaign.returnD0', params: { campaignId: '24215315197' } }, display: sparkline }
      const spec = load([bad])
      expect(spec).toBeDefined()
      expect(spec!.sections[0].items[0].display).toEqual({ as: 'number' })
      expect(validateCard(spec!)).toEqual([])
    })

    it('a card whose only problem was one undrawable sparkline is a plain card; a real error still blanks it', () => {
      const cfg = clone(defaultConfig())
      const w = cfg.pages[0].widgets[0]
      w.card = { spec: { v: 1, sections: [{ layout: 'rows', items: [{ id: 'x', label: 'x', data: { metric: 'no.such.metric' }, display: sparkline }] }] } as CardSpec }
      const out = normalizeConfig({ ...clone(cfg), version: LAYOUT_VERSIONS.navigation })
      expect(out.pages[0].widgets.find((x) => x.id === w.id)!.card).toEqual({ preset: 'invalid-card' })
    })
  })
})
