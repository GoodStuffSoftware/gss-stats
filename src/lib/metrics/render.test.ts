import { describe, expect, it } from 'vitest'
import { campaignById } from '../campaigns'
import { itemLabelTokens, itemViewModel, resolveLabelTokens } from './render'
import type { ScopeInstance } from './scope'
import type { MetricItem, MetricValue } from './types'

const ACTIVE_RETEST = campaignById('24279250691')! // status: active
const CLOSED_ANDROID = campaignById('24215315197')! // status: closed
const activeScope: ScopeInstance = { kind: 'campaign', campaign: ACTIVE_RETEST }
const closedScope: ScopeInstance = { kind: 'campaign', campaign: CLOSED_ANDROID }
const rootScope: ScopeInstance = { kind: 'root' }
const todayEt = '2026-09-27'
const opts = { todayEt }

function numberItem(overrides: Partial<MetricItem> = {}): MetricItem {
  return { id: 'x', label: 'Arrivals', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' }, ...overrides }
}
function percentItem(overrides: Partial<MetricItem> = {}): MetricItem {
  return { id: 'x', label: 'Accept rate', data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'percent', decimals: 1 }, ...overrides }
}
function costItem(overrides: Partial<MetricItem> = {}): MetricItem {
  return { id: 'x', label: 'Cost / arrival', data: { ratio: 'campaign.costPerArrival' }, display: { as: 'currency' }, ...overrides }
}
function countsItem(overrides: Partial<MetricItem> = {}): MetricItem {
  return { id: 'x', label: 'Game-screen views', data: { ratio: 'campaign.gameViewsVsArrivals' }, display: { as: 'counts' }, ...overrides }
}

describe('itemViewModel — display kinds (status "ok")', () => {
  it('number: formatted count, no deltas when none requested', () => {
    const vm = itemViewModel(numberItem(), { status: 'ok', value: 1234 }, activeScope, opts)
    expect(vm.visible).toBe(true)
    expect(vm.primary).toBe('1,234')
    expect(vm.deltaLines).toEqual([])
  })

  it('number: deltas rendered only for the requested names, with up/down class', () => {
    const item = numberItem({ display: { as: 'number', deltas: ['yesterday', 'avg7'] } })
    const value: MetricValue = { status: 'ok', value: 100, deltas: { yesterday: { delta: 10, deltaPct: 0.1 }, avg7: { delta: -5, deltaPct: -0.05 } } }
    const vm = itemViewModel(item, value, activeScope, opts)
    expect(vm.deltaLines).toEqual([
      { text: 'vs yesterday +10 (+10%)', cls: 'up' },
      { text: 'vs 7d avg -5 (-5%)', cls: 'down' },
    ])
  })

  it('currency: dollar-formatted', () => {
    const vm = itemViewModel(costItem(), { status: 'ok', value: 0.3521, numerator: 12.34, denominator: 35 }, activeScope, opts)
    expect(vm.primary).toBe('$0.35')
  })

  it('percent: always shows (n/d) alongside the percentage', () => {
    const vm = itemViewModel(percentItem(), { status: 'ok', value: 0.42, numerator: 21, denominator: 50 }, activeScope, opts)
    expect(vm.primary).toBe('42.0% (21/50)')
  })

  it('percent: honors a requested decimals count', () => {
    const vm = itemViewModel(percentItem({ display: { as: 'percent', decimals: 0 } }), { status: 'ok', value: 0.4278, numerator: 21, denominator: 49 }, activeScope, opts)
    expect(vm.primary).toBe('43% (21/49)')
  })

  it("per: a plain number with two decimals (can exceed 1), never a percent; too-few says so", () => {
    const item: MetricItem = { id: 'x', label: 'Per arrival', data: { ratio: 'campaign.engagementPerArrival' }, display: { as: 'number' } }
    expect(itemViewModel(item, { status: 'ok', value: 1.5, numerator: 30, denominator: 20 }, activeScope, opts).primary).toBe('1.50')
    expect(itemViewModel(item, { status: 'ok', value: 0.1234, numerator: 5, denominator: 40 }, activeScope, opts).primary).toBe('0.12')
    expect(itemViewModel(item, { status: 'too-few', value: null, numerator: 30, denominator: 4 }, activeScope, opts).primary).toBe('too few to report')
  })

  it('counts: "n unit · n unit", never a slash, always n/d regardless of size', () => {
    const vm = itemViewModel(countsItem(), { status: 'ok', numerator: 1111, denominator: 353, value: null }, activeScope, opts)
    expect(vm.primary).toBe('1,111 views · 353 arrivals')
  })

  it('dateRange field: "start → end (Nd)" when days is set', () => {
    const item: MetricItem = { id: 'flight', label: 'Flight', data: { field: 'campaign.flight' }, display: { as: 'dateRange', days: true } }
    const vm = itemViewModel(item, undefined, closedScope, opts) // field bindings need no value
    expect(vm.primary).toBe('2026-09-02 → 2026-09-09 (8d)')
  })

  it('dateRange field: without days, just the range', () => {
    const item: MetricItem = { id: 'flight', label: 'Flight', data: { field: 'campaign.flight' }, display: { as: 'dateRange' } }
    expect(itemViewModel(item, undefined, closedScope, opts).primary).toBe('2026-09-02 → 2026-09-09')
  })

  it('datetime/text field: the raw scope value, verbatim', () => {
    const item: MetricItem = { id: 'note', label: 'Note', data: { field: 'campaign.measurabilityNote' }, display: { as: 'text' } }
    const spendOnly = campaignById('24234347705')!
    const vm = itemViewModel(item, undefined, { kind: 'campaign', campaign: spendOnly }, opts)
    expect(vm.primary).toBe(spendOnly.measurabilityNote)
  })

  it('badge field: the tone from Display.tones, defaulting to neutral', () => {
    const item: MetricItem = { id: 'badge', label: '', data: { field: 'campaign.statusToday' }, display: { as: 'badge', tones: { 'flighting today': 'live' } } }
    const flighting = itemViewModel(item, undefined, activeScope, { todayEt: '2026-09-27' }) // ACTIVE_RETEST is flighting on 2026-09-27
    expect(flighting.primary).toBe('flighting today')
    expect(flighting.badgeTone).toBe('live')
    const notFlighting = itemViewModel(item, undefined, closedScope, { todayEt: '2026-09-27' })
    expect(notFlighting.badgeTone).toBe('neutral')
  })

  it('badge field: follows opts.todayEt, not the real clock (inclusive flight end, then ended)', () => {
    const item: MetricItem = { id: 'badge', label: '', data: { field: 'campaign.statusToday' }, display: { as: 'badge', tones: { 'flighting today': 'live' } } }
    const lastDay = itemViewModel(item, undefined, activeScope, { todayEt: ACTIVE_RETEST.flightEnd })
    expect(lastDay.primary).toBe('flighting today')
    expect(lastDay.badgeTone).toBe('live')
    const afterEnd = itemViewModel(item, undefined, activeScope, { todayEt: '2026-10-03' }) // the day after ACTIVE_RETEST's flightEnd
    expect(afterEnd.primary).toBe('active') // not flighting any more: the campaign's own status
    expect(afterEnd.badgeTone).toBe('neutral')
  })

  it('number/currency field: a numeric scope value formatted like the metric displays', () => {
    const numItem: MetricItem = { id: 'n', label: 'N', data: { field: 'reading.spend' }, display: { as: 'currency' } }
    const vm = itemViewModel(numItem, undefined, { kind: 'reading', reading: { readAt: '2026-09-27', kind: 'morning', spend: 12.5 } }, opts)
    expect(vm.primary).toBe('$12.50')
  })

  it('bar: falls back to the numeric value (MetricItem.vue scales the width against the section max)', () => {
    const item: MetricItem = { id: 'bar', label: 'Bar', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'bar' } }
    expect(itemViewModel(item, { status: 'ok', value: 353 }, activeScope, opts).primary).toBe('353')
  })

  it('sparkline: the headline stays the current value, with the per-day series attached', () => {
    const item: MetricItem = { id: 'spark', label: 'Trend', data: { metric: 'bsk.pageviews', window: 'page' }, display: { as: 'sparkline', series: 'daily' } }
    const series = [
      { day: '2026-09-25', value: 400 },
      { day: '2026-09-26', value: 500 },
    ]
    const vm = itemViewModel(item, { status: 'ok', value: 900, series }, rootScope, opts)
    expect(vm.primary).toBe('900')
    expect(vm.series).toEqual(series)
  })

  it('sparkline: a money metric reads as money', () => {
    const item: MetricItem = { id: 'spark', label: 'Spend', data: { metric: 'campaign.spend' }, display: { as: 'sparkline', series: 'daily' } }
    const vm = itemViewModel(item, { status: 'ok', value: 12.5, series: [{ day: '2026-09-26', value: 12.5 }] }, activeScope, opts)
    expect(vm.primary).toBe('$12.50')
  })

  it('sparkline: with no series from the server the number stands alone; another display never carries one', () => {
    const spark: MetricItem = { id: 'spark', label: 'Trend', data: { metric: 'bsk.pageviews', window: 'page' }, display: { as: 'sparkline', series: 'daily' } }
    expect(itemViewModel(spark, { status: 'ok', value: 900 }, rootScope, opts).series).toBeUndefined()
    expect(itemViewModel(numberItem(), { status: 'ok', value: 9, series: [{ day: '2026-09-26', value: 9 }] }, activeScope, opts).series).toBeUndefined()
  })

  it('sparkline: the empty states are unchanged (unmeasured, error carry no series)', () => {
    const spark: MetricItem = { id: 'spark', label: 'Trend', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'sparkline', series: 'daily' } }
    expect(itemViewModel(spark, { status: 'unmeasured', reason: 'not-live' }, activeScope, opts).series).toBeUndefined()
    expect(itemViewModel(spark, { status: 'error', error: 'boom' } as MetricValue, activeScope, opts).series).toBeUndefined()
  })
})

describe('itemViewModel — status × gating', () => {
  it('too-few: percent shows the "too few" text with (n/d) still attached', () => {
    const vm = itemViewModel(percentItem(), { status: 'too-few', value: null, numerator: 2, denominator: 3 }, activeScope, opts)
    expect(vm.visible).toBe(true)
    expect(vm.primary).toBe('too few to report (2/3)')
  })

  it('too-few: currency shows just the "too few" text', () => {
    const vm = itemViewModel(costItem(), { status: 'too-few', value: null, numerator: 1, denominator: 2 }, activeScope, opts)
    expect(vm.primary).toBe('too few to report')
  })

  it('too-few: counts ignores status entirely — n/d is unconditional', () => {
    const vm = itemViewModel(countsItem(), { status: 'ok', numerator: 3, denominator: 4, value: null }, activeScope, opts)
    expect(vm.primary).toBe('3 views · 4 arrivals')
  })

  it('no-data: default whenEmpty is a dash', () => {
    const vm = itemViewModel(numberItem(), { status: 'no-data', value: null }, activeScope, opts)
    expect(vm.visible).toBe(true)
    expect(vm.primary).toBe('—')
  })

  it('no-data: whenEmpty "omit" hides the item', () => {
    const vm = itemViewModel(numberItem({ gating: { whenEmpty: 'omit' } }), { status: 'no-data', value: null }, activeScope, opts)
    expect(vm.visible).toBe(false)
  })

  it('no-data: whenEmpty a note renders that note', () => {
    const vm = itemViewModel(numberItem({ gating: { whenEmpty: { note: 'no-campaign-flighting' } } }), { status: 'no-data', value: null }, activeScope, opts)
    expect(vm.primary).toBe('no campaign flighting today')
  })

  // A2c (review round 2026-09-27): a measured zero is never blank by default — only an item
  // that opts in with gating.whenZero: 'omit' (the per-campaign d0 return row and the upsell
  // rows, presets.ts) hides itself at 0. The site-wide "Return visits (day 1+)" tile
  // (presets.ts bsk.returnsD1plus) carries no gating override, so it follows this default:
  // a real, visible "0" for a range with no matching rows, same as the untouched auth-error/
  // auth-redirect tiles already prove for their own metrics.
  it('ok + value 0, no gating override: shows an explicit "0", never blank or hidden', () => {
    const vm = itemViewModel(numberItem(), { status: 'ok', value: 0 }, activeScope, opts)
    expect(vm.visible).toBe(true)
    expect(vm.primary).toBe('0')
  })

  it('ok + value 0, gating.whenZero "omit": hides the item (the documented, opt-in exception)', () => {
    const vm = itemViewModel(numberItem({ gating: { whenZero: 'omit' } }), { status: 'ok', value: 0 }, activeScope, opts)
    expect(vm.visible).toBe(false)
  })

  it('unmeasured: auto + closed campaign omits the item', () => {
    const vm = itemViewModel(numberItem(), { status: 'unmeasured', reason: 'not-seen-in-flight' }, closedScope, opts)
    expect(vm.visible).toBe(false)
  })

  it('unmeasured: auto + active campaign shows the "not yet tracking" label', () => {
    const vm = itemViewModel(numberItem(), { status: 'unmeasured', reason: 'not-live' }, activeScope, opts)
    expect(vm.visible).toBe(true)
    expect(vm.primary).toBe('not yet tracking')
  })

  it('unmeasured: gating "omit" always hides it, even for an active campaign', () => {
    const vm = itemViewModel(numberItem({ gating: { whenUnmeasured: 'omit' } }), { status: 'unmeasured', reason: 'not-live' }, activeScope, opts)
    expect(vm.visible).toBe(false)
  })

  it('unmeasured: gating "label" always shows it, even for a closed campaign', () => {
    const vm = itemViewModel(numberItem({ gating: { whenUnmeasured: 'label' } }), { status: 'unmeasured', reason: 'not-seen-in-flight' }, closedScope, opts)
    expect(vm.visible).toBe(true)
    expect(vm.primary).toBe('not yet tracking')
  })

  it('unmeasured: a specific registry reason (flight-pending) is preferred over the generic label', () => {
    const vm = itemViewModel(numberItem(), { status: 'unmeasured', reason: 'flight-pending', noteIds: ['flight-pending'] }, activeScope, opts)
    expect(vm.primary).toBe('pending — start date not yet confirmed')
  })

  it('error: the muted status word "unavailable" (never a dash, which reads as no value), and the item caption still renders', () => {
    const vm = itemViewModel(numberItem({ caption: 'still shown' }), { status: 'error', reason: 'fetch-failed' }, activeScope, opts)
    expect(vm.visible).toBe(true)
    expect(vm).toMatchObject({ primary: 'unavailable', muted: true, error: true })
    expect(vm.captionTokens.map((t) => t.value).join('')).toBe('still shown')
  })

  it('partial: formats normally and captions "counted from <date>"', () => {
    const vm = itemViewModel(numberItem(), { status: 'partial', value: 40, measuredFrom: Date.parse('2026-09-26T16:26:36Z'), noteIds: ['counted-from'] }, activeScope, opts)
    expect(vm.primary).toBe('40')
    expect(vm.captionTokens.map((t) => t.value).join('')).toContain('2026-09-26')
  })

  it('provisional (still-arriving) rides along in noteIds, same as any other caption note', () => {
    const vm = itemViewModel(percentItem(), { status: 'ok', value: 0, numerator: 0, denominator: 33, provisional: true, noteIds: ['still-arriving'] }, activeScope, opts)
    expect(vm.captionTokens.map((t) => t.value).join('')).toBe('still arriving')
  })

  it('an unknown metric/ratio id renders like a server error rather than throwing', () => {
    const item: MetricItem = { id: 'x', label: 'X', data: { metric: 'nope.nothere' }, display: { as: 'number' } }
    const vm = itemViewModel(item, undefined, activeScope, opts)
    expect(vm.visible).toBe(true)
    expect(vm.primary).toBe('—')
  })

  it('a value not yet loaded (in flight) shows a loading placeholder, not a dash', () => {
    const vm = itemViewModel(numberItem(), undefined, activeScope, opts)
    expect(vm.visible).toBe(true)
    expect(vm.primary).toBe('…')
  })
})

describe('resolveLabelTokens — every Label kind', () => {
  it('a literal string interpolates {campaign.label}-style scope vars', () => {
    const tokens = resolveLabelTokens('Tagged arrivals — {campaign.label}', activeScope, undefined, todayEt)
    expect(tokens.map((t) => t.value).join('')).toBe(`Tagged arrivals — ${ACTIVE_RETEST.label}`)
  })

  it('{=…} fills the fixed dates the card editor offers; a chart or metric path has nothing to read and shows the dash', () => {
    const tokens = resolveLabelTokens('Live {=golive.web|date}, {=chart.total|number}, {=metric:bsk.pageviews@page|number}', activeScope, undefined, todayEt)
    expect(tokens.map((t) => t.value).join('')).toMatch(/^Live [A-Z][a-z]{2} \d{1,2}, \d{4}, —, —$/)
  })

  it('{ bind } reads a scope field as plain text', () => {
    const tokens = resolveLabelTokens({ bind: 'campaign.label' }, activeScope, undefined, todayEt)
    expect(tokens).toEqual([{ type: 'text', value: ACTIVE_RETEST.label }])
  })

  it('{ bind } to a field the scope cannot answer renders nothing', () => {
    expect(resolveLabelTokens({ bind: 'popup.label' }, activeScope, undefined, todayEt)).toEqual([])
  })

  it('{ metric: true } uses the data binding\'s own registry label', () => {
    const tokens = itemLabelTokens({ id: 'x', label: { metric: true }, data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }, activeScope, todayEt)
    expect(tokens.map((t) => t.value).join('')).toBe('Tagged arrivals')
  })

  it('{ metric: true } with no data binding (a bug in a saved card) renders nothing, not a crash', () => {
    expect(resolveLabelTokens({ metric: true }, activeScope, undefined, todayEt)).toEqual([])
  })

  it('{ note } renders the registry note, with vars resolved from scope paths', () => {
    const tokens = resolveLabelTokens({ note: 'label.campaign.gameViews' }, activeScope, undefined, todayEt)
    expect(tokens.map((t) => t.value).join('')).toBe('Game-screen views')
  })

  it('{ note } with an unsafe/unregistered id (e.g. a prototype-polluting id) renders nothing (a note from a newer build), never crashes', () => {
    for (const evil of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(() => resolveLabelTokens({ note: evil }, activeScope, undefined, todayEt)).not.toThrow()
      expect(resolveLabelTokens({ note: evil }, activeScope, undefined, todayEt)).toEqual([])
    }
  })
})

describe('gating.whenEmpty note id — same unsafe-id neutralization as a label', () => {
  it('an unregistered whenEmpty note id renders as a dash instead of crashing', () => {
    const item = numberItem({ gating: { whenEmpty: { note: 'constructor' } } })
    expect(() => itemViewModel(item, { status: 'no-data', value: null }, activeScope, opts)).not.toThrow()
    expect(itemViewModel(item, { status: 'no-data', value: null }, activeScope, opts).primary).toBe('—')
  })
})

describe('value.noteIds — unsafe ids from the server are skipped, not crashed on', () => {
  it('a noteIds entry that is not an own NOTES_REGISTRY property is dropped from the caption', () => {
    const vm = itemViewModel(numberItem(), { status: 'ok', value: 10, noteIds: ['constructor', '__proto__'] }, activeScope, opts)
    expect(() => vm).not.toThrow()
    expect(vm.captionTokens).toEqual([])
  })
})

describe('itemViewModel — retention verdict "maturing" shows its days left', () => {
  const item: MetricItem = { id: 'verdict', label: 'Verdict', data: { metric: 'campaign.retentionVerdict' }, display: { as: 'status' } }
  const maturing: MetricValue = { status: 'ok', value: 1, noteIds: ['verdict.maturing', 'bar.fixed-days'] }
  const at = (todayEt: string, value: MetricValue = maturing, scope: ScopeInstance = activeScope) => itemViewModel(item, value, scope, { todayEt })
  // ACTIVE_RETEST flightEnd is 2026-10-02, so its d2-7 window closes on 2026-10-10.
  it('many days: "maturing (N days left)", whole ET days from the flight end', () => {
    expect(at('2026-10-05').primary).toBe('maturing (5 days left)')
    expect(at('2026-10-03').primary).toBe('maturing (7 days left)')
  })
  it('one day: "1 day left"', () => {
    expect(at('2026-10-09').primary).toBe('maturing (1 day left)')
  })
  it('zero days or no campaign in scope: plain "maturing"', () => {
    expect(at('2026-10-10').primary).toBe('maturing')
    expect(at('2026-10-05', maturing, rootScope).primary).toBe('maturing')
  })
  it('other verdicts are untouched', () => {
    expect(at('2026-10-05', { status: 'ok', value: 5, noteIds: ['verdict.go', 'bar.organic'] }).primary).toBe('GO')
  })
  it('does not repeat the status as a caption', () => {
    expect(at('2026-10-05').captionTokens.map((t) => ('value' in t ? t.value : '')).join('')).not.toContain('maturing')
  })
})
