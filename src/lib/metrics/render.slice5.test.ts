// itemViewModel: what the slice-5 presets need from it ("new today", n/d always shown, muted
// status words, captions that read as one line) and the slice-4 review's hardening (non-finite
// numbers and deltas from the wire never render).
import { describe, expect, it } from 'vitest'
import { campaignById } from '../campaigns'
import { itemViewModel } from './render'
import type { ScopeInstance } from './scope'
import type { MetricItem, MetricValue } from './types'

const activeScope: ScopeInstance = { kind: 'campaign', campaign: campaignById('24279250691')! }
const rootScope: ScopeInstance = { kind: 'root' }
const opts = { todayEt: '2026-09-27' }

const numberItem = (o: Partial<MetricItem> = {}): MetricItem => ({ id: 'x', label: 'Arrivals', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' }, ...o })
const percentItem = (o: Partial<MetricItem> = {}): MetricItem => ({ id: 'x', label: 'Accept', data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'percent', decimals: 1 }, ...o })
const costItem = (o: Partial<MetricItem> = {}): MetricItem => ({ id: 'x', label: 'Cost / arrival', data: { ratio: 'campaign.costPerArrival' }, display: { as: 'currency' }, ...o })
const countsItem = (o: Partial<MetricItem> = {}): MetricItem => ({ id: 'x', label: 'Game-screen views', data: { ratio: 'campaign.gameViewsVsArrivals' }, display: { as: 'counts' }, ...o })
const kpi = (o: Partial<MetricItem> = {}): MetricItem => ({ id: 'k', label: 'Page views', data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: { as: 'number', deltas: ['yesterday', 'avg7'] }, ...o })

describe('"new today"', () => {
  it('a today-so-far count that asked for deltas and got none (every comparison predates the go-live)', () => {
    expect(itemViewModel(kpi(), { status: 'ok', value: 8 }, rootScope, opts).deltaLines).toEqual([{ text: 'new today', cls: 'new' }])
    expect(itemViewModel(kpi(), { status: 'partial', value: 8, measuredFrom: 0 }, rootScope, opts).deltaLines).toEqual([{ text: 'new today', cls: 'new' }])
  })
  it('not when a delta came back, when none was asked for, off today-so-far, or without a value', () => {
    expect(itemViewModel(kpi(), { status: 'ok', value: 8, deltas: { yesterday: { delta: 2, deltaPct: 0.33 } } }, rootScope, opts).deltaLines).toEqual([{ text: 'vs yesterday +2 (+33%)', cls: 'up' }])
    expect(itemViewModel(kpi({ display: { as: 'number' } }), { status: 'ok', value: 8 }, rootScope, opts).deltaLines).toEqual([])
    expect(itemViewModel(kpi({ data: { metric: 'bsk.pageviews', window: 'page' } }), { status: 'ok', value: 8 }, rootScope, opts).deltaLines).toEqual([])
    expect(itemViewModel(kpi(), { status: 'unmeasured', reason: 'not-live' }, rootScope, opts).deltaLines).toEqual([])
    expect(itemViewModel(kpi(), { status: 'no-data', value: null }, rootScope, opts).deltaLines).toEqual([])
  })
})

describe('non-finite values from the wire', () => {
  it('a non-finite delta survives JSON as null and is treated as absent: no line, no styling', () => {
    const sent: MetricValue = { status: 'ok', value: 5, deltas: { yesterday: { delta: Infinity, deltaPct: Infinity }, avg7: { delta: 3, deltaPct: NaN } } }
    const received = JSON.parse(JSON.stringify(sent)) as MetricValue
    expect(received.deltas?.yesterday).toEqual({ delta: null, deltaPct: null })
    expect(itemViewModel(kpi(), received, rootScope, opts).deltaLines).toEqual([{ text: 'vs 7d avg +3', cls: 'up' }])
  })

  it('fuzz: no value ever renders as NaN, Infinity, undefined or an object', () => {
    const junk: unknown[] = [NaN, Infinity, -Infinity, null, undefined, '12', {}, [], true, 1e308 * 10]
    const items = [numberItem(), percentItem(), costItem(), countsItem(), kpi()]
    for (const v of junk) {
      for (const n of junk) {
        for (const item of items) {
          for (const status of ['ok', 'partial', 'too-few', 'no-data'] as const) {
            const value = { status, value: v, numerator: n, denominator: v, deltas: { yesterday: { delta: n, deltaPct: v }, avg7: n } } as unknown as MetricValue
            const vm = itemViewModel(item, value, activeScope, opts)
            const shown = [vm.primary, ...vm.deltaLines.map((d) => d.text)].join(' | ')
            expect(shown, `${item.display.as} ${status} ${String(v)}/${String(n)}`).not.toMatch(/NaN|Infinity|undefined|\[object/)
          }
        }
      }
    }
  })
})

describe('a percent always shows its (n/d)', () => {
  it('"— (0/0)" with no data; "?" for a side that did not come back', () => {
    expect(itemViewModel(percentItem(), { status: 'no-data', value: null, numerator: 0, denominator: 0 }, activeScope, opts).primary).toBe('— (0/0)')
    expect(itemViewModel(percentItem(), { status: 'ok', value: 0.5, numerator: 3 }, activeScope, opts).primary).toBe('50.0% (3/?)')
    expect(itemViewModel(percentItem(), { status: 'too-few', value: null, denominator: 4 }, activeScope, opts).primary).toBe('too few to report (?/4)')
  })
  it('whenEmpty "omit" still hides a no-data percent', () => {
    expect(itemViewModel(percentItem({ gating: { whenEmpty: 'omit' } }), { status: 'no-data', value: null, numerator: 0, denominator: 0 }, activeScope, opts).visible).toBe(false)
  })
})

describe('captions and status words', () => {
  it('several notes on one value read as one caption, separated, never run together', () => {
    const vm = itemViewModel(numberItem({ caption: 'item caption' }), { status: 'partial', value: 2, measuredFrom: 0, noteIds: ['install-fix-note', 'still-arriving'] }, activeScope, opts)
    expect(vm.captionTokens.map((t) => t.value).join('')).toMatch(/not recorded · still arriving · item caption$/)
  })
  it('a status word in place of a value is muted (small, like the old "not yet tracking" tile)', () => {
    expect(itemViewModel(kpi(), { status: 'unmeasured', reason: 'not-live' }, rootScope, opts)).toMatchObject({ primary: 'not yet tracking', muted: true })
    expect(itemViewModel(kpi(), { status: 'ok', value: 3 }, rootScope, opts).muted).toBeUndefined()
  })
})
