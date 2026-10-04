// ADR 0005 slice 3, step B2: the render-time mapping of a legacy Ads readings widget onto the
// readings-log card, that the stored fields survive normalizeConfig (so rollback loses nothing),
// and the per-cell tone hook and column hint the card needs.
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../defaults'
import { ADS_READINGS_LOG, presetById } from './presets'
import { ADS_READINGS_LOG_PRESET, cardRefFor, cardShowsOwnReload, legacyReadingsLimit } from './readingsCard'
import { readingScopeOf } from './readingsScope'
import { scopeTone, type ScopeInstance } from './scope'
import { MAX_READINGS_LIMIT, type CardSpec, type MetricItem } from './types'
import { validateCard } from './validate'
import type { ReadingRecord, RuleResult } from '../adsRules'
import type { DashboardConfig, Widget } from '../../types'

const legacy = (over: Partial<Widget> = {}): Widget => ({
  id: 'ar',
  i: 'ar',
  title: 'Ads readings',
  type: 'table',
  dataset: 'ads-readings',
  view: 'log',
  dimension: '',
  metric: 'pageviews',
  limit: 30,
  x: 0,
  y: 0,
  w: 12,
  h: 10,
  ...over,
})
const readingsLimitOf = (ref: ReturnType<typeof cardRefFor>): number | undefined => {
  if (!ref || !('spec' in ref)) return undefined
  return ref.spec.sections.find((s) => s.repeat?.over === 'readings')?.repeat?.limit
}

describe('cardRefFor: a legacy ads-readings widget draws the readings-log preset', () => {
  it('the default limit (30) is the preset itself', () => {
    expect(cardRefFor(legacy())).toEqual({ preset: ADS_READINGS_LOG_PRESET })
    expect(presetById(ADS_READINGS_LOG_PRESET)).toBe(ADS_READINGS_LOG)
  })
  it('another limit is an inline clone with that repeat.limit, and the preset is not mutated', () => {
    const before = JSON.stringify(ADS_READINGS_LOG)
    const ref = cardRefFor(legacy({ limit: 50 }))!
    expect('spec' in ref && ref.from).toBe(ADS_READINGS_LOG_PRESET)
    expect(readingsLimitOf(ref)).toBe(50)
    expect('spec' in ref && ref.spec).not.toBe(ADS_READINGS_LOG)
    expect(validateCard((ref as { spec: CardSpec }).spec)).toEqual([])
    expect(JSON.stringify(ADS_READINGS_LOG)).toBe(before)
  })
  it('caps at 500, floors a fraction, and falls back to 30 for an unusable limit', () => {
    expect(readingsLimitOf(cardRefFor(legacy({ limit: 9999 })))).toBe(MAX_READINGS_LIMIT)
    expect(MAX_READINGS_LIMIT).toBe(500)
    expect(readingsLimitOf(cardRefFor(legacy({ limit: 12.7 })))).toBe(12)
    for (const bad of [0, -5, Number.NaN, undefined as unknown as number]) {
      expect(legacyReadingsLimit({ limit: bad })).toBe(30)
      expect(cardRefFor(legacy({ limit: bad }))).toEqual({ preset: ADS_READINGS_LOG_PRESET })
    }
  })
  it('an unknown or legacy view still draws the log, and the widget is never written to', () => {
    const w = legacy({ view: 'summary-from-the-future', campaignIds: ['24279250691'], limit: 40 })
    const frozen = JSON.stringify(w)
    expect(cardRefFor(w)).not.toBeNull()
    expect(cardRefFor(legacy({ view: undefined }))).toEqual({ preset: ADS_READINGS_LOG_PRESET })
    expect(JSON.stringify(w)).toBe(frozen)
  })
  it('a widget that already has a card renders as today', () => {
    const card = { preset: 'bsk-kpis' }
    expect(cardRefFor(legacy({ card }))).toBe(card)
    expect(cardRefFor(legacy({ dataset: 'overview', view: 'kpis', card }))).toBe(card)
  })
  it('every other widget has no card', () => {
    expect(cardRefFor(legacy({ dataset: 'geo' }))).toBeNull()
    expect(cardRefFor(legacy({ dataset: 'campaigns', view: 'scorecard' }))).toBeNull()
    expect(cardRefFor(legacy({ dataset: undefined }))).toBeNull()
  })
  it('the readings preset has no own reload line, so the header reload stays', () => {
    expect(cardShowsOwnReload(cardRefFor(legacy()))).toBe(false)
    expect(cardShowsOwnReload(null)).toBe(false)
  })
})

describe('normalizeConfig keeps a legacy ads-readings widget exactly as stored (lossless rollback)', () => {
  it('dataset, view, campaignIds, limit and type survive, and no card is written', () => {
    const raw = { version: 10, activePageId: 'p1', pages: [{ id: 'p1', name: 'P', filters: { siteSel: [] }, widgets: [legacy({ campaignIds: ['24279250691'], limit: 50 })] }] } as unknown as DashboardConfig
    const w = normalizeConfig(raw).pages[0].widgets.find((x) => x.id === 'ar')!
    expect(w).toMatchObject({ dataset: 'ads-readings', view: 'log', campaignIds: ['24279250691'], limit: 50, type: 'table' })
    expect(w.card).toBeUndefined()
  })
})

const rule = (id: string, status: RuleResult['status']): RuleResult => ({ id, status }) as RuleResult
const record = (over: Partial<ReadingRecord> = {}): ReadingRecord =>
  ({ v: 1, id: 'r1', campaignId: '24279250691', kind: 'daily', readAt: '2026-10-02T12:00:00Z', etDate: '2026-10-02', spendThroughEt: null, cumulativeSpend: 1, thresholds: [], complete: true, rules: null, proposal: null, decision: null, counts: {}, notes: [], ...over }) as ReadingRecord

describe('the per-cell tone hook', () => {
  it('readingScopeOf carries the rules tone, and a trip tone for a PROPOSE PAUSE proposal only', () => {
    expect(readingScopeOf(record({ rules: [rule('K1', 'trip')] })).tones).toEqual({ rules: 'trip' })
    expect(readingScopeOf(record({ rules: [rule('K1', 'clear'), rule('K2', 'watch')], proposal: 'PROPOSE PAUSE' })).tones).toEqual({ rules: 'watch', proposal: 'trip' })
    expect(readingScopeOf(record({ rules: null, proposal: 'HOLD' })).tones).toEqual({ rules: 'muted' })
  })
  it('scopeTone answers for reading.rules and reading.proposal only, and for readings only', () => {
    const scope: ScopeInstance = { kind: 'reading', reading: { campaignId: 'c', readAt: 'x', kind: 'daily', spend: 1, tones: { rules: 'watch', proposal: 'trip' } } }
    expect(scopeTone(scope, 'reading.rules')).toBe('watch')
    expect(scopeTone(scope, 'reading.proposal')).toBe('trip')
    expect(scopeTone(scope, 'reading.spend')).toBeNull()
    expect(scopeTone({ kind: 'root' }, 'reading.rules')).toBeNull()
    expect(scopeTone({ kind: 'reading', reading: { campaignId: 'c', readAt: 'x', kind: 'daily', spend: 1 } }, 'reading.rules')).toBeNull()
  })
})

describe('MetricItem.hint (a table column tooltip)', () => {
  const card = (item: Partial<MetricItem>): CardSpec => ({
    v: 1,
    sections: [{ layout: 'pills', items: [{ id: 'x', label: 'X', data: { metric: 'bsk.pageviews' }, display: { as: 'number' }, ...item } as MetricItem] }],
  })
  it('accepts a registered note id as a hint on a metric item', () => {
    expect(validateCard(card({ hint: { note: 'label.reading.signUpsHint' } }))).toEqual([])
  })
  it('rejects a malformed note id', () => {
    expect(validateCard(card({ hint: { note: 'Not A Note' } })).join('\n')).toMatch(/hint/)
  })
  it('the readings log marks its Sign-ups column with the hint', () => {
    const items = ADS_READINGS_LOG.sections.flatMap((s) => s.items)
    expect(items.some((i) => typeof i.hint === 'object' && 'note' in i.hint && i.hint.note === 'label.reading.signUpsHint')).toBe(true)
  })
})
