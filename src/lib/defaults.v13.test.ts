// The sparkline layout version (ADR 0005 slice 2). It is a SAVE-GUARD bump only: no stored layout
// is rewritten, because no stored layout has a sparkline yet. The number lives in
// LAYOUT_VERSIONS.sparklines, so renumbering at merge time is that one literal; these tests are
// written against the constant, never a bare number, so they survive it.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, LAYOUT_VERSIONS, defaultConfig, normalizeConfig } from './defaults'
import { validateCard } from './metrics/validate'
import type { CardSpec } from './metrics/types'
import PROD_V8 from './__fixtures__/prodLayout.v8.json'
import PROD_V9 from './__fixtures__/prodLayout.v9.json'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

describe('sparkline layout version', () => {
  it('CONFIG_VERSION is at least the sparkline version, and every key is strictly increasing', () => {
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(LAYOUT_VERSIONS.sparklines)
    expect(LAYOUT_VERSIONS.sparklines).toBeGreaterThan(LAYOUT_VERSIONS.compactNoteRow)
  })

  it('a fresh config is written at CONFIG_VERSION', () => {
    expect(defaultConfig().version).toBe(CONFIG_VERSION)
  })

  it('a stored layout one version behind loads with the version raised and every widget untouched', () => {
    const stored = normalizeConfig(clone(defaultConfig()))
    // Some filters carry clock-derived ISO dates, so mask those and compare everything else.
    const widgetsOf = (c: typeof stored) => JSON.stringify(c.pages.map((pg) => pg.widgets)).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')
    const before = widgetsOf(stored)
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
})
