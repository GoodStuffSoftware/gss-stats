// The Feature health card as one grouped table (fix/feature-health-table): the saved Overview
// widget still maps to the preset at render time, and the preset's table keeps the old card's
// features, steps, windows and order.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, featureHealthCardFor } from '../defaults'
import { FEATURES } from '../featureHealth'
import type { Widget } from '../../types'
import { presetById } from './presets'
import { STATUS_PILL_TONES, windowHeading } from './render'
import { ROOT_SCOPE, lacksRequiredField, scopeField, sectionCells, tableRows } from './scope'
import { validateCard } from './validate'

const SAVED_HEALTH = { id: 'ow-feature-health', title: 'Feature health', type: 'table', dataset: 'features', view: 'health', dimension: '', metric: 'pageviews', limit: 1, excludeKnownTraffic: true, x: 0, y: 9, w: 12, h: 20, i: 'ow-feature-health' } as unknown as Widget
const ctx = { todayEt: '2026-10-29' }
const spec = presetById('feature-health')!
const section = spec.sections[0]
const stepOf = (s: { kind: string }) => (s as unknown as { step?: { id: string } }).step?.id
const featureOf = (s: unknown): string | undefined => {
  let cur = s as { kind?: string; feature?: { id: string }; parent?: unknown } | undefined
  while (cur) { if (cur.feature) return cur.feature.id; cur = cur.parent as typeof cur }
  return undefined
}

describe('Feature health table', () => {
  it('a saved layout still draws the preset, with no stored change and CONFIG_VERSION 19', () => {
    expect(featureHealthCardFor(SAVED_HEALTH).card).toEqual({ preset: 'feature-health' })
    expect(CONFIG_VERSION).toBe(19)
    expect(validateCard(spec)).toEqual([])
  })

  it('is one table: a group per feature, a row per step, in config order', () => {
    expect(spec.sections).toHaveLength(1)
    const rows = tableRows(section, ROOT_SCOPE, ctx)
    expect(rows.map((r) => stepOf(r.scope))).toEqual(FEATURES.flatMap((f) => f.steps.map((s) => s.id)))
    expect(rows.map((r) => featureOf(r.scope))).toEqual(FEATURES.flatMap((f) => f.steps.map(() => f.id)))
    expect(rows.filter((r) => r.first).map((r) => r.span)).toEqual(FEATURES.map((f) => f.steps.length))
  })

  it('asks for each step at latest day, day before and range, a ratio only where the step has one, and the status once per feature', () => {
    const cells = sectionCells(section, ROOT_SCOPE, ctx)
    const ids = (prefix: string) => cells.filter((c) => c.item.id.startsWith(prefix)).length
    const steps = FEATURES.reduce((n, f) => n + f.steps.length, 0)
    const rows = tableRows(section, ROOT_SCOPE, ctx)
    const ratioSteps = rows.filter((r) => scopeField(r.scope, 'step.ratioLabel') !== null).length
    const ratio = section.items.find((i) => i.id === 'ratio')!
    expect(rows.filter((r) => !lacksRequiredField(ratio, r.scope, ctx.todayEt)).length).toBe(ratioSteps)
    expect(ids('status')).toBe(FEATURES.length)
    expect(ids('latest')).toBe(steps)
    expect(ids('prev')).toBe(steps)
    expect(ids('range')).toBe(steps)
    expect(ids('ratio@')).toBe(steps * 3) // collected per row; rows without a ratio label are blank (gating.onlyWith)
    expect(ratioSteps).toBeGreaterThan(0)
    const windows = cells.filter((c) => c.item.id.startsWith('ratio@')).map((c) => c.item.id.split('@')[1])
    expect(new Set(windows)).toEqual(new Set(['latestDay', 'previousDay', 'page']))
  })

  it('heads a window column with its date, and colours the status pill by its note', () => {
    expect(windowHeading('latestDay', '2026-10-29')).toBe('Oct 28')
    expect(windowHeading('previousDay', '2026-10-29')).toBe('Oct 27')
    expect(windowHeading('page', '2026-10-29')).toBe('Range')
    expect(STATUS_PILL_TONES).toEqual({ 'feature.status.ok': 'good', 'feature.status.new': 'info', 'feature.status.silent': 'alert' })
  })

  it('rejects windows outside a row table', () => {
    const ratio = section.items.find((i) => i.id === 'ratio')!
    const withColumns = { ...spec, sections: [{ ...section, rowGroups: undefined, columns: { over: 'windows', ids: ['before', 'after'] } }] } as typeof spec
    expect(validateCard(withColumns).some((e) => e.includes('windows are for a metric or ratio in a row'))).toBe(true)
    const asRows = { ...spec, sections: [{ ...section, layout: 'rows', items: [ratio] }] } as typeof spec
    expect(validateCard(asRows).some((e) => e.includes('windows are for a metric or ratio in a row'))).toBe(true)
  })
})
