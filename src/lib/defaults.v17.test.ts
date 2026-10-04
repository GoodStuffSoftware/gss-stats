// The readings-log layout version (ADR 0005 slice 3). It is a SAVE-GUARD bump only: no stored layout
// is rewritten and there is no migration function. A legacy `dataset: 'ads-readings'` widget is mapped
// to the `ads-readings-log` card at render time (lib/metrics/readingsCard.ts), so rolling the code back
// loses nothing. PROVISIONAL number: it renumbers to 16 if it lands before `captions` (PR #76).
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, LAYOUT_VERSIONS, defaultConfig, normalizeConfig } from './defaults'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const mask = (x: unknown) => JSON.stringify(x).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')

describe('readings log layout version', () => {
  it('is 17, the newest, and CONFIG_VERSION follows the map', () => {
    expect(LAYOUT_VERSIONS.readingsLog).toBe(17)
    expect(CONFIG_VERSION).toBe(Math.max(...Object.values(LAYOUT_VERSIONS)))
    expect(defaultConfig().version).toBe(CONFIG_VERSION)
  })

  // Put one readings-shaped widget onto the first page, store the layout one version behind, load it.
  const load = (extra: Record<string, unknown> | null) => {
    const cfg = clone(defaultConfig())
    const base = cfg.pages[0].widgets[0] as unknown as Record<string, unknown>
    const w = extra ? { ...clone(base), id: 'readings-w', ...extra } : null
    if (w) cfg.pages[0].widgets.push(w as never)
    const out = normalizeConfig({ ...clone(cfg), version: LAYOUT_VERSIONS.dateEtTrends })
    return { out, w, found: out.pages[0].widgets.find((x) => x.id === 'readings-w') as unknown as Record<string, unknown> | undefined }
  }
  const keeps = (shape: Record<string, unknown>) => {
    const { out, found } = load(shape)
    expect(out.version).toBe(CONFIG_VERSION)
    expect(found).toBeDefined()
    for (const k of ['dataset', 'view', 'campaignIds', 'limit', 'card']) {
      if (k in shape) expect(found![k]).toEqual(shape[k])
    }
    return found!
  }

  it('a legacy ads-readings widget with no card loads unchanged (no card written)', () => {
    const f = keeps({ type: 'table', dataset: 'ads-readings', view: 'readings', campaignIds: ['24215315197'], limit: 30 })
    expect(f.card).toBeUndefined()
  })
  it('the same with a card keeps it', () => {
    keeps({ type: 'table', dataset: 'ads-readings', view: 'readings', campaignIds: ['24215315197'], limit: 50, card: { preset: 'ads-readings-log' } })
  })
  it('an unknown view is kept as stored', () => {
    keeps({ type: 'table', dataset: 'ads-readings', view: 'somethingElse', campaignIds: [], limit: 10 })
  })
  it('a layout with no readings widget changes only its version', () => {
    const cfg = clone(defaultConfig())
    const older = normalizeConfig({ ...clone(cfg), version: LAYOUT_VERSIONS.dateEtTrends })
    const current = normalizeConfig({ ...clone(cfg), version: CONFIG_VERSION })
    expect(older.version).toBe(CONFIG_VERSION)
    expect(mask({ ...older, version: 0 })).toBe(mask({ ...current, version: 0 }))
  })
  it('an already-preset card is untouched', () => {
    keeps({ type: 'table', dataset: 'ads-readings', card: { preset: 'ads-readings-log' }, limit: 500 })
  })
})
