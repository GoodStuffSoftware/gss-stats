// The rate-tile layout version (ADR 0005 slice 4). It is a SAVE-GUARD bump only: no stored layout is
// rewritten and there is no migration function. A legacy `type: 'rate'` widget is mapped to a one-item
// card at render time (lib/metrics/rateTileCard.ts), so rolling the code back loses nothing. Written
// against the LAYOUT_VERSIONS key, never a literal.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, LAYOUT_VERSIONS, defaultConfig, normalizeConfig } from './defaults'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const mask = (x: unknown) => JSON.stringify(x).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')

describe('rate tile layout version', () => {
  it('comes after readingsLog, and CONFIG_VERSION follows the map', () => {
    expect(LAYOUT_VERSIONS.rateTile).toBeGreaterThan(LAYOUT_VERSIONS.readingsLog)
    expect(CONFIG_VERSION).toBe(Math.max(...Object.values(LAYOUT_VERSIONS)))
    expect(defaultConfig().version).toBe(CONFIG_VERSION)
  })

  const rate = { id: 'rate-w', title: 'Upsell tap rate', type: 'rate', dataset: 'popup', dimension: 'upsell:tap', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3 }
  const load = (w: Record<string, unknown>) => {
    const cfg = clone(defaultConfig())
    cfg.pages[0].widgets.push(clone(w) as never)
    const out = normalizeConfig({ ...clone(cfg), version: LAYOUT_VERSIONS.readingsLog })
    return { out, found: out.pages[0].widgets.find((x) => x.id === 'rate-w') as unknown as Record<string, unknown> }
  }

  it('a stored rate tile loads with its own fields and no card written', () => {
    const { out, found } = load(rate)
    expect(out.version).toBe(CONFIG_VERSION)
    for (const k of ['type', 'dataset', 'dimension']) expect(found[k]).toBe((rate as Record<string, unknown>)[k])
    expect(found.card).toBeUndefined()
  })
  it('loading it twice is the same as loading it once (idempotent)', () => {
    const { out } = load(rate)
    expect(mask(normalizeConfig(clone(out)))).toBe(mask(out))
  })
  it('a layout with no rate tile changes only its version', () => {
    const cfg = clone(defaultConfig())
    const older = normalizeConfig({ ...clone(cfg), version: LAYOUT_VERSIONS.readingsLog })
    const current = normalizeConfig({ ...clone(cfg), version: CONFIG_VERSION })
    expect(older.version).toBe(CONFIG_VERSION)
    expect(mask({ ...older, version: 0 })).toBe(mask({ ...current, version: 0 }))
  })
})
