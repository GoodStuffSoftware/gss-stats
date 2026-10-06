// itemViewModel: what the slice-5 presets need from it ("new today", n/d always shown, muted
// status words, captions that read as one line) and the slice-4 review's hardening (non-finite
// numbers and deltas from the wire never render).
import { describe, expect, it } from 'vitest'
import { campaignById } from '../campaigns'
import { itemViewModel } from './render'
import { buildRequestSpec, flattenSectionItems, unmeasuredByConfig } from './scope'
import type { ScopeInstance } from './scope'
import type { CardSpec, MetricItem, MetricValue } from './types'
import { validateCard } from './validate'

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

describe('whole-day context (a count that can count a refused row)', () => {
  const lines = (display: MetricItem['display'], value: MetricValue) => itemViewModel(kpi({ display }), value, rootScope, opts).deltaLines
  const both: MetricItem['display'] = { as: 'number', deltas: ['yesterday', 'avg7'] }

  it('one neutral line: yesterday and the 7-day daily average, no arrow and no percent', () => {
    expect(lines(both, { status: 'ok', value: 900, wholeDays: { yesterday: 1234, avg7: 1180.4 } })).toEqual([{ text: 'Yesterday 1,234 · 7-day avg 1,180/day', cls: '' }])
  })
  it('only the part asked for, or only the part present', () => {
    const wd = { yesterday: 1234, avg7: 1180 }
    expect(lines({ as: 'number', deltas: ['yesterday'] }, { status: 'ok', value: 9, wholeDays: wd })).toEqual([{ text: 'Yesterday 1,234', cls: '' }])
    expect(lines({ as: 'number', deltas: ['avg7'] }, { status: 'ok', value: 9, wholeDays: wd })).toEqual([{ text: '7-day avg 1,180/day', cls: '' }])
    expect(lines(both, { status: 'ok', value: 9, wholeDays: { avg7: 1180 } })).toEqual([{ text: '7-day avg 1,180/day', cls: '' }])
    expect(lines(both, { status: 'ok', value: 9, wholeDays: { yesterday: 40 } })).toEqual([{ text: 'Yesterday 40', cls: '' }])
  })
  it('the average is a whole number from 10 up and one decimal below', () => {
    const avg = (n: number) => lines(both, { status: 'ok', value: 1, wholeDays: { avg7: n } })[0]!.text
    expect(avg(10)).toBe('7-day avg 10/day')
    expect(avg(10.4)).toBe('7-day avg 10/day')
    expect(avg(9.96)).toBe('7-day avg 10/day')
    expect(avg(1234.6)).toBe('7-day avg 1,235/day')
    expect(avg(9.94)).toBe('7-day avg 9.9/day')
    expect(avg(3)).toBe('7-day avg 3.0/day')
    expect(avg(0.43)).toBe('7-day avg 0.4/day')
    expect(avg(0)).toBe('7-day avg 0.0/day')
  })
  it('a non-finite part (null after JSON) is absent; with both absent there is no line', () => {
    const received = JSON.parse(JSON.stringify({ status: 'ok', value: 5, wholeDays: { yesterday: Infinity, avg7: 12 } })) as MetricValue
    expect(lines(both, received)).toEqual([{ text: '7-day avg 12/day', cls: '' }])
    expect(lines(both, { status: 'ok', value: 5, wholeDays: { yesterday: NaN } })).toEqual([])
  })
  it('is not "new today": the line replaces it, and an absent wholeDays still reads "new today"', () => {
    expect(lines(both, { status: 'ok', value: 8, wholeDays: { yesterday: 5 } }).some((l) => l.cls === 'new')).toBe(false)
    expect(lines(both, { status: 'ok', value: 8 })).toEqual([{ text: 'new today', cls: 'new' }])
  })
  it('nothing when no delta name was asked for', () => {
    expect(lines({ as: 'number' }, { status: 'ok', value: 8, wholeDays: { yesterday: 5, avg7: 4 } })).toEqual([])
  })
})

describe('a chosen past day (pastDay)', () => {
  const past = { ...opts, pastDay: true }
  const vm = (display: MetricItem['display'], value: MetricValue, o: { todayEt: string; pastDay?: boolean } = past) => itemViewModel(kpi({ display }), value, rootScope, o).deltaLines
  const both: MetricItem['display'] = { as: 'number', deltas: ['yesterday', 'avg7'] }
  it('names the comparison the prior day, not yesterday', () => {
    expect(vm(both, { status: 'ok', value: 8, deltas: { yesterday: { delta: 2, deltaPct: 0.33 } } })[0]!.text).toBe('vs prior day +2 (+33%)')
    expect(vm(both, { status: 'ok', value: 900, wholeDays: { yesterday: 1234, avg7: 1180.4 } })).toEqual([{ text: 'Prior day 1,234 · 7-day avg 1,180/day', cls: '' }])
  })
  it('a go-live that very day reads "new that day", not "new today"', () => {
    expect(vm(both, { status: 'ok', value: 8 })).toEqual([{ text: 'new that day', cls: 'new' }])
  })
  it('today keeps its wording', () => {
    expect(vm(both, { status: 'ok', value: 8, deltas: { yesterday: { delta: 2, deltaPct: 0.33 } } }, opts)[0]!.text).toBe('vs yesterday +2 (+33%)')
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
  it('an error is the muted status word "unavailable", flagged as an error — never a dash', () => {
    expect(itemViewModel(numberItem(), { status: 'error', reason: 'fetch-failed' }, activeScope, opts)).toMatchObject({ primary: 'unavailable', muted: true, error: true, visible: true })
  })
  it('a tile gets a percent split: the rate, and its (n/d) for the small line', () => {
    expect(itemViewModel(percentItem(), { status: 'ok', value: 5 / 41, numerator: 5, denominator: 41 }, activeScope, opts).split).toEqual({ main: '12.2%', sub: '(5/41)' })
    expect(itemViewModel(percentItem(), { status: 'too-few', value: null, numerator: 1, denominator: 3 }, activeScope, opts).split).toEqual({ main: 'too few to report', sub: '(1/3)' })
    expect(itemViewModel(percentItem(), { status: 'no-data', value: null, numerator: 0, denominator: 0 }, activeScope, opts).split).toEqual({ main: '—', sub: '(0/0)' })
    expect(itemViewModel(numberItem(), { status: 'ok', value: 3 }, activeScope, opts).split).toBeUndefined()
  })
})

describe('decided from the campaign config, on the client (spend-only, flight pending)', () => {
  const spendOnly: ScopeInstance = { kind: 'campaign', campaign: campaignById('24234347705')! }
  const pending: ScopeInstance = { kind: 'campaign', campaign: { ...campaignById('24279250691')!, flightStart: null, status: 'upcoming' } }
  const spend = (o: Partial<MetricItem> = {}): MetricItem => ({ id: 's', label: 'Spend', data: { metric: 'campaign.spend' }, display: { as: 'currency' }, ...o })
  const flight: MetricItem = { id: 'f', label: 'Flight', data: { field: 'campaign.flight' }, display: { as: 'dateRange', days: true }, gating: { whenEmpty: { note: 'flight-pending' } } }

  it('beacon items are omitted and never requested, whatever the status, even before any value arrives', () => {
    for (const scope of [spendOnly, pending]) {
      for (const item of [numberItem(), percentItem(), costItem(), countsItem()]) {
        expect(unmeasuredByConfig(item.data, scope, undefined, opts.todayEt), `${scope.kind} ${item.data}`).toBe(true)
        expect(buildRequestSpec(item, scope)).toBeNull()
        expect(itemViewModel(item, undefined, scope, opts).visible).toBe(false) // no "…" flash
        expect(itemViewModel(item, { status: 'unmeasured', reason: 'spend-only' }, scope, opts).visible).toBe(false) // never "not yet tracking"
      }
    }
  })
  it('spend itself stays measurable; the Flight row alone says "pending"', () => {
    expect(unmeasuredByConfig(spend().data, spendOnly, undefined, opts.todayEt)).toBe(false)
    expect(unmeasuredByConfig(spend().data, pending, undefined, opts.todayEt)).toBe(false)
    expect(buildRequestSpec(spend(), spendOnly)).not.toBeNull()
    expect(itemViewModel(flight, undefined, pending, opts).primary).toBe('pending — start date not yet confirmed')
  })
  it('an ordinary active campaign and site-wide items are unaffected', () => {
    expect(unmeasuredByConfig(numberItem().data, activeScope, undefined, opts.todayEt)).toBe(false)
    expect(unmeasuredByConfig(kpi().data, spendOnly, undefined, opts.todayEt)).toBe(false) // no campaign param: site-wide
  })
})

describe('whenNotStarted: an upcoming flight keeps its items', () => {
  const pending: ScopeInstance = { kind: 'campaign', campaign: { ...campaignById('24279250691')!, flightStart: null, status: 'upcoming' } }
  const spendOnly: ScopeInstance = { kind: 'campaign', campaign: campaignById('24234347705')! }
  const notOpen: MetricValue = { status: 'unmeasured', reason: 'not-started', noteIds: ['not-started'] }
  const bar = (o: Partial<MetricItem> = {}) => numberItem({ display: { as: 'bar' }, ...o })

  it('no start date yet: "label" reads "not started", "zero" a 0 bar; neither is ever requested', () => {
    const label = numberItem({ gating: { whenNotStarted: 'label' } })
    const zero = bar({ gating: { whenNotStarted: 'zero' } })
    expect(unmeasuredByConfig(label.data, pending, label.gating, opts.todayEt)).toBe(false)
    expect(buildRequestSpec(label, pending)).toBeNull()
    expect(buildRequestSpec(zero, pending)).toBeNull()
    expect(itemViewModel(label, undefined, pending, opts)).toMatchObject({ visible: true, primary: 'not started', muted: true })
    expect(itemViewModel(percentItem({ gating: { whenNotStarted: 'label' } }), undefined, pending, opts)).toMatchObject({ visible: true, primary: 'not started' })
    expect(itemViewModel(zero, undefined, pending, opts)).toMatchObject({ visible: true, primary: '0', barValue: 0 })
  })
  it('a window that opens later: "zero" turns the server\'s "not started" into 0; "label" and no gating keep it', () => {
    const scope: ScopeInstance = { kind: 'campaign', campaign: campaignById('24279250691')! }
    expect(itemViewModel(bar({ gating: { whenNotStarted: 'zero' } }), notOpen, scope, opts)).toMatchObject({ visible: true, primary: '0', barValue: 0 })
    expect(itemViewModel(bar({ gating: { whenNotStarted: 'label' } }), notOpen, scope, opts).primary).toBe('not started')
    expect(itemViewModel(bar(), notOpen, scope, opts).primary).toBe('not started')
  })
  it('without it a pending flight still omits the item (the scorecard), and a spend-only campaign always does', () => {
    expect(itemViewModel(numberItem(), undefined, pending, opts).visible).toBe(false)
    for (const whenNotStarted of ['label', 'zero'] as const) {
      const item = numberItem({ gating: { whenNotStarted } })
      expect(unmeasuredByConfig(item.data, spendOnly, item.gating, opts.todayEt)).toBe(true)
      expect(itemViewModel(item, undefined, spendOnly, opts).visible).toBe(false)
    }
  })
  it('validateCard accepts only "label" or "zero"', () => {
    const card = (g: unknown): CardSpec => ({ v: 1, repeat: { over: 'campaigns' }, sections: [{ layout: 'rows', items: [numberItem({ gating: g as MetricItem['gating'] })] }] })
    expect(validateCard(card({ whenNotStarted: 'label' }))).toEqual([])
    expect(validateCard(card({ whenNotStarted: 'zero' }))).toEqual([])
    expect(validateCard(card({ whenNotStarted: 'omit' })).join()).toMatch(/whenNotStarted must be/)
  })
})

describe('comparisons hidden after the first, partial day', () => {
  const retest = campaignById('24279250691')! // flight starts 2026-09-26 at 12:00 ET
  const arrivals: MetricItem = { id: 'a', label: 'Arrivals', data: { metric: 'campaign.taggedArrivals', window: 'todaySoFar' }, display: { as: 'number', deltas: ['yesterday', 'avg7'] } }
  const scope: ScopeInstance = { kind: 'campaign', campaign: retest }
  it('on the first day itself: "new today"', () => {
    expect(itemViewModel(arrivals, { status: 'ok', value: 7 }, scope, { todayEt: '2026-09-26' }).deltaLines).toEqual([{ text: 'new today', cls: 'new' }])
  })
  it('on the days after: "no comparison yet (first day partial)", never "new today"', () => {
    expect(itemViewModel(arrivals, { status: 'ok', value: 7 }, scope, { todayEt: '2026-09-27' }).deltaLines).toEqual([{ text: 'no comparison yet (first day partial)', cls: '' }])
  })
  it('a site-wide metric the day after its go-live reads the same way', () => {
    // Games completed went live on 2026-09-26 (GAME_COMPLETE_LIVE_AT).
    const done: MetricItem = { id: 'c', label: 'Games completed', data: { metric: 'bsk.completions', window: 'todaySoFar' }, display: { as: 'number', deltas: ['yesterday', 'avg7'] } }
    expect(itemViewModel(done, { status: 'ok', value: 3 }, rootScope, { todayEt: '2026-09-27' }).deltaLines).toEqual([{ text: 'no comparison yet (first day partial)', cls: '' }])
    expect(itemViewModel(done, { status: 'ok', value: 3 }, rootScope, { todayEt: '2026-09-26' }).deltaLines).toEqual([{ text: 'new today', cls: 'new' }])
  })
})

describe('percent decimals', () => {
  it('are clamped to an integer from 0 to 4 when rendering, so a bad saved value never throws', () => {
    for (const decimals of [1000, -3, 2.7, NaN, Infinity]) {
      const item = { ...percentItem(), display: { as: 'percent', decimals } } as unknown as MetricItem
      expect(() => itemViewModel(item, { status: 'ok', value: 0.5, numerator: 1, denominator: 2 }, activeScope, opts)).not.toThrow()
    }
    const at = (decimals: number) => itemViewModel({ ...percentItem(), display: { as: 'percent', decimals } } as unknown as MetricItem, { status: 'ok', value: 1 / 3, numerator: 1, denominator: 3 }, activeScope, opts).primary
    expect(at(1000)).toBe('33.3333% (1/3)')
    expect(at(-3)).toBe('33% (1/3)')
  })
  it('validateCard accepts 0 to 4 and refuses anything else', () => {
    const card = (decimals: unknown) => ({ v: 1, repeat: { over: 'campaigns' }, sections: [{ layout: 'rows', items: [{ id: 'a', label: 'A', data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'percent', decimals } }] }] }) as unknown as CardSpec
    for (const d of [0, 1, 4]) expect(validateCard(card(d))).toEqual([])
    for (const d of [5, 1000, -1, 1.5, '2']) expect(validateCard(card(d)).join('\n')).toMatch(/decimals must be an integer from 0 to 4/)
  })
})

describe('"not started" (a window that has not begun)', () => {
  it('reads "not started", muted — never "not yet tracking" — from the note or from the reason alone', () => {
    expect(itemViewModel(numberItem(), { status: 'unmeasured', reason: 'not-started', noteIds: ['not-started'] }, activeScope, opts)).toMatchObject({ primary: 'not started', muted: true, visible: true })
    expect(itemViewModel(numberItem(), { status: 'unmeasured', reason: 'not-started' }, activeScope, opts).primary).toBe('not started')
    expect(itemViewModel(percentItem(), { status: 'unmeasured', reason: 'not-started', noteIds: ['not-started'] }, activeScope, opts).primary).toBe('not started')
  })
})

describe('a flighting-today repeat whose only campaigns are spend-only', () => {
  const tile: MetricItem = {
    id: 'arrivals',
    label: { note: 'label.card.taggedArrivalsFor', vars: { campaign: 'campaign.label' } },
    data: { metric: 'campaign.taggedArrivals', window: 'todaySoFar' },
    display: { as: 'number' },
    repeat: { over: 'campaigns', flightingToday: true, empty: { label: { note: 'label.campaign.taggedArrivals' }, text: { note: 'no-campaign-flighting' } } },
  }
  const section = { layout: 'tiles' as const, items: [tile] }
  it('says so in the placeholder instead of dropping the tile silently', () => {
    const only = flattenSectionItems(section, rootScope, { todayEt: '2026-09-11' }) // Play-direct (spend-only) alone
    expect(only).toHaveLength(1)
    expect(only[0].emptyOf?.text).toEqual({ note: 'no-tracked-campaign-flighting' })
  })
  it('a tracked campaign flighting alongside it gets its tile; nothing flighting keeps the usual text', () => {
    const both = flattenSectionItems(section, rootScope, { todayEt: '2026-09-09' }) // Android + Play-direct
    expect(both.map((f) => (f.scope.kind === 'campaign' ? f.scope.campaign.id : f.emptyOf))).toEqual(['24215315197'])
    const none = flattenSectionItems(section, rootScope, { todayEt: '2026-09-20' })
    expect(none[0].emptyOf?.text).toEqual({ note: 'no-campaign-flighting' })
  })
})
