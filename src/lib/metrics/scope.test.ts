import { describe, expect, it } from 'vitest'
import { CAMPAIGNS, campaignById } from '../campaigns'
import { POPUPS } from '../popupEvents'
import { releaseAwaitingFullDay, releaseSubjectOn } from '../releases'
import {
  buildRequestSpec,
  flattenSectionItems,
  narrowToCampaigns,
  resolveBinding,
  resolveRepeat,
  scopeField,
  scopeVars,
  todayEtFrom,
  type ScopeInstance,
} from './scope'
import type { MetricItem, Section } from './types'

const CLOSED_ANDROID = campaignById('24215315197')! // status: closed
const CLOSED_SPEND_ONLY = campaignById('24234347705')! // status: closed, measurement: spend-only
const ACTIVE_RETEST = campaignById('24279250691')! // status: active, flightStart 2026-09-26

const campaignScope = (c = ACTIVE_RETEST): ScopeInstance => ({ kind: 'campaign', campaign: c })
const popupScope = (id = 'signin-prompt'): ScopeInstance => ({ kind: 'popup', popup: POPUPS.find((p) => p.id === id)! })

describe('resolveRepeat', () => {
  it('no repeat: a single root-scoped instance', () => {
    expect(resolveRepeat(undefined, { todayEt: '2026-09-27' })).toEqual([{ kind: 'root' }])
  })

  it('over campaigns: every campaign, in CAMPAIGNS order, by default', () => {
    const out = resolveRepeat({ over: 'campaigns' }, { todayEt: '2026-09-27' })
    expect(out.map((s) => (s as { campaign: { id: string } }).campaign.id)).toEqual(CAMPAIGNS.map((c) => c.id))
  })

  it('over campaigns: ids filters and preserves the given order', () => {
    const out = resolveRepeat({ over: 'campaigns', ids: [ACTIVE_RETEST.id, CLOSED_ANDROID.id] }, { todayEt: '2026-09-27' })
    expect(out.map((s) => (s as { campaign: { id: string } }).campaign.id)).toEqual([ACTIVE_RETEST.id, CLOSED_ANDROID.id])
  })

  it('over campaigns: status filters', () => {
    const out = resolveRepeat({ over: 'campaigns', status: ['closed'] }, { todayEt: '2026-09-27' })
    expect(out.every((s) => (s as { campaign: { status: string } }).campaign.status === 'closed')).toBe(true)
    expect(out.length).toBe(CAMPAIGNS.filter((c) => c.status === 'closed').length)
  })

  it('over campaigns: flightingToday keeps only campaigns serving on that ET date', () => {
    const out = resolveRepeat({ over: 'campaigns', flightingToday: true }, { todayEt: '2026-09-27' })
    // Only the active retest (flightStart 09-26, flightEnd 10-02) is serving on 09-27.
    expect(out).toEqual([{ kind: 'campaign', campaign: ACTIVE_RETEST }])
  })

  it('over campaigns: flightingToday on a date nothing serves yields no instances', () => {
    expect(resolveRepeat({ over: 'campaigns', flightingToday: true }, { todayEt: '2020-01-01' })).toEqual([])
  })

  it('over popups: every POPUPS entry by default, filterable by ids', () => {
    const all = resolveRepeat({ over: 'popups' }, { todayEt: '2026-09-27' })
    expect(all.length).toBe(POPUPS.length)
    const one = resolveRepeat({ over: 'popups', ids: ['install'] }, { todayEt: '2026-09-27' })
    expect(one).toEqual([{ kind: 'popup', popup: POPUPS.find((p) => p.id === 'install') }])
  })

  it('over windows: before/after by default', () => {
    expect(resolveRepeat({ over: 'windows' }, { todayEt: '2026-09-27' })).toEqual([
      { kind: 'window', window: 'before' },
      { kind: 'window', window: 'after' },
    ])
  })

  it('over readings: whatever the caller supplies, empty by default (slice 8 has no source yet)', () => {
    expect(resolveRepeat({ over: 'readings' }, { todayEt: '2026-09-27' })).toEqual([])
    const reading = { readAt: '2026-09-27', kind: 'morning', spend: 12.5 }
    expect(resolveRepeat({ over: 'readings' }, { todayEt: '2026-09-27', readings: [reading] })).toEqual([{ kind: 'reading', reading }])
  })
})

describe('scopeField', () => {
  it('campaign.* fields', () => {
    const s = campaignScope(CLOSED_ANDROID)
    expect(scopeField(s, 'campaign.id')).toBe(CLOSED_ANDROID.id)
    expect(scopeField(s, 'campaign.label')).toBe(CLOSED_ANDROID.label)
    expect(scopeField(s, 'campaign.status')).toBe('closed')
    expect(scopeField(s, 'campaign.flight')).toBe('2026-09-02|2026-09-09')
    expect(scopeField(campaignScope(CLOSED_SPEND_ONLY), 'campaign.measurabilityNote')).toBe(CLOSED_SPEND_ONLY.measurabilityNote)
  })

  it('campaign.statusToday: "flighting today" only while the flight is actually serving', () => {
    expect(scopeField(campaignScope(ACTIVE_RETEST), 'campaign.statusToday', '2026-09-27')).toBe('flighting today')
    expect(scopeField(campaignScope(ACTIVE_RETEST), 'campaign.statusToday', '2020-01-01')).toBe('active')
    expect(scopeField(campaignScope(CLOSED_ANDROID), 'campaign.statusToday', '2026-09-27')).toBe('closed')
  })

  it('release.label names the compared release and notes a newer one waiting for a full day', () => {
    const root: ScopeInstance = { kind: 'root' }
    const subject = releaseSubjectOn('2026-10-03')!
    const waiting = releaseAwaitingFullDay('2026-10-03')!
    expect(scopeField(root, 'release.label', '2026-10-03')).toBe(`${subject.version} (${subject.dateEt}); ${waiting.version} needs a full day`)
    const later = releaseSubjectOn('2099-01-01')!
    expect(scopeField(root, 'release.label', '2099-01-01')).toBe(`${later.version} (${later.dateEt})`)
  })

  it('release.label with no subject but a release waiting names only the waiting one', () => {
    expect(releaseSubjectOn('2000-01-01')).toBeNull()
    const waiting = releaseAwaitingFullDay('2000-01-01')!
    expect(scopeField({ kind: 'root' }, 'release.label', '2000-01-01')).toBe(`${waiting.version} needs a full day`)
  })

  it('a field not answerable by the current scope kind is null, not a throw', () => {
    expect(scopeField(popupScope(), 'campaign.label')).toBeNull()
    expect(scopeField({ kind: 'root' }, 'popup.id')).toBeNull()
  })

  it('popup.* and window.label', () => {
    expect(scopeField(popupScope('install'), 'popup.id')).toBe('install')
    expect(scopeField(popupScope('install'), 'popup.label')).toBe('Install prompt')
    expect(scopeField({ kind: 'window', window: 'before' }, 'window.label')).toBe('Before')
    expect(scopeField({ kind: 'window', window: 'after' }, 'window.label')).toBe('After')
  })

  it('reading.* fields', () => {
    const reading = { readAt: '2026-09-27T08:00:00Z', kind: 'morning', spend: 12.5, rules: 'r1', proposal: 'p1' }
    const s: ScopeInstance = { kind: 'reading', reading }
    expect(scopeField(s, 'reading.readAt')).toBe(reading.readAt)
    expect(scopeField(s, 'reading.kind')).toBe('morning')
    expect(scopeField(s, 'reading.spend')).toBe('12.5')
    expect(scopeField(s, 'reading.rules')).toBe('r1')
    expect(scopeField(s, 'reading.proposal')).toBe('p1')
  })

  it('an unconfirmed flight has no campaign.flight value', () => {
    const pending = { ...ACTIVE_RETEST, flightStart: null }
    expect(scopeField({ kind: 'campaign', campaign: pending }, 'campaign.flight')).toBeNull()
  })
})

describe('scopeVars', () => {
  it('flattens the bound object for {campaign.label}-style label interpolation', () => {
    const vars = scopeVars(campaignScope(ACTIVE_RETEST), '2026-09-27')
    expect(vars.campaign).toEqual({ id: ACTIVE_RETEST.id, label: ACTIVE_RETEST.label, status: 'active', statusToday: 'flighting today' })
  })

  it('a root scope has no vars', () => {
    expect(scopeVars({ kind: 'root' })).toEqual({})
  })
})

describe('resolveBinding', () => {
  it('field binding: reads the scope directly, no params/window', () => {
    const r = resolveBinding({ field: 'campaign.label' }, campaignScope(ACTIVE_RETEST))
    expect(r).toEqual({ kind: 'field', params: {}, fieldValue: ACTIVE_RETEST.label })
  })

  it('metric binding: campaignId param and window default come from the scope', () => {
    const r = resolveBinding({ metric: 'campaign.taggedArrivals' }, campaignScope(ACTIVE_RETEST))
    expect(r?.kind).toBe('metric')
    expect(r?.params).toEqual({ campaignId: ACTIVE_RETEST.id })
    expect(r?.window).toBe('attribution') // the first declared window
  })

  it('an explicit string param PINS it instead of reading the scope', () => {
    const r = resolveBinding({ metric: 'campaign.taggedArrivals', params: { campaignId: CLOSED_ANDROID.id } }, campaignScope(ACTIVE_RETEST))
    expect(r?.params).toEqual({ campaignId: CLOSED_ANDROID.id })
  })

  it('an explicit window overrides the default', () => {
    const r = resolveBinding({ metric: 'campaign.taggedArrivals', window: 'todaySoFar' }, campaignScope(ACTIVE_RETEST))
    expect(r?.window).toBe('todaySoFar')
  })

  it('ratio binding: params are the union of both sides', () => {
    const r = resolveBinding({ ratio: 'campaign.acceptPerAsk' }, campaignScope(ACTIVE_RETEST))
    expect(r?.kind).toBe('ratio')
    expect(r?.params).toEqual({ campaignId: ACTIVE_RETEST.id })
  })

  it('popup binding: the popup param comes from a popup scope', () => {
    const r = resolveBinding({ metric: 'popup.shown' }, popupScope('install'))
    expect(r?.params).toEqual({ popup: 'install' })
  })

  it('an unknown metric/ratio id resolves to null', () => {
    expect(resolveBinding({ metric: 'nope.nothere' }, campaignScope())).toBeNull()
    expect(resolveBinding({ ratio: 'nope.nothere' }, campaignScope())).toBeNull()
  })
})

describe('buildRequestSpec', () => {
  it('a field item never produces a request', () => {
    const item: MetricItem = { id: 'flight', label: 'Flight', data: { field: 'campaign.flight' }, display: { as: 'dateRange' } }
    expect(buildRequestSpec(item, campaignScope())).toBeNull()
  })

  it('carries deltas only for a number display, and minCohort only when the item raises it', () => {
    const item: MetricItem = {
      id: 'arrivals',
      label: 'Arrivals',
      data: { metric: 'campaign.taggedArrivals', window: 'todaySoFar' },
      display: { as: 'number', deltas: ['yesterday', 'avg7'] },
      gating: { minCohort: 25 },
    }
    const spec = buildRequestSpec(item, campaignScope(ACTIVE_RETEST))
    expect(spec).toEqual({
      metric: 'campaign.taggedArrivals',
      params: { campaignId: ACTIVE_RETEST.id },
      window: 'todaySoFar',
      deltas: ['yesterday', 'avg7'],
      minCohort: 25,
    })
  })

  it('a sparkline display asks for the daily series; no other display does', () => {
    const spark: MetricItem = { id: 's', label: 'S', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'sparkline', series: 'daily' } }
    expect(buildRequestSpec(spark, campaignScope(ACTIVE_RETEST))?.series).toBe('daily')
    const num: MetricItem = { id: 'n', label: 'N', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }
    expect(buildRequestSpec(num, campaignScope(ACTIVE_RETEST))?.series).toBeUndefined()
  })

  it('a percent display never carries deltas even if somehow present on the item', () => {
    const item: MetricItem = { id: 'rate', label: 'Rate', data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'percent', decimals: 1 } }
    const spec = buildRequestSpec(item, campaignScope(ACTIVE_RETEST))
    expect(spec?.deltas).toBeUndefined()
  })
})

describe('flattenSectionItems', () => {
  const baseItem: MetricItem = { id: 'x', label: 'X', data: { field: 'campaign.label' }, display: { as: 'text' } }

  it('no repeat anywhere: one (item, outerScope) pair per item, in order', () => {
    const section: Section = { layout: 'rows', items: [baseItem, { ...baseItem, id: 'y' }] }
    const out = flattenSectionItems(section, campaignScope(ACTIVE_RETEST), { todayEt: '2026-09-27' })
    expect(out).toEqual([
      { item: section.items[0], scope: campaignScope(ACTIVE_RETEST) },
      { item: section.items[1], scope: campaignScope(ACTIVE_RETEST) },
    ])
  })

  it('an item-level repeat expands in place, one entry per instance', () => {
    const item: MetricItem = { ...baseItem, repeat: { over: 'campaigns', status: ['closed'] } }
    const section: Section = { layout: 'tiles', items: [item] }
    const out = flattenSectionItems(section, { kind: 'root' }, { todayEt: '2026-09-27' })
    expect(out.length).toBe(CAMPAIGNS.filter((c) => c.status === 'closed').length)
    expect(out.every((fi) => fi.item === item && fi.scope.kind === 'campaign')).toBe(true)
  })

  it('an item repeat that matches nothing renders its `empty` placeholder once, if given', () => {
    const item: MetricItem = {
      ...baseItem,
      repeat: { over: 'campaigns', flightingToday: true, empty: { label: 'Arrivals', text: { note: 'no-campaign-flighting' } } },
    }
    const section: Section = { layout: 'tiles', items: [item] }
    const out = flattenSectionItems(section, { kind: 'root' }, { todayEt: '2020-01-01' })
    expect(out).toEqual([{ item, scope: { kind: 'root' }, emptyOf: item.repeat!.empty }])
  })

  it('organic + flightingToday with no campaign flighting: the plain `empty`, never "no tracked campaign"', () => {
    // The organic arm is the only instance, and a binding it does not serve drops it, so the repeat
    // is empty. Only a dropped CAMPAIGN instance means "a campaign is flighting but untracked".
    const empty = { label: 'Arrivals', text: { note: 'no-campaign-flighting' } }
    const item: MetricItem = {
      id: 'arr',
      label: 'Arrivals',
      data: { metric: 'campaign.taggedArrivals' },
      display: { as: 'number' },
      repeat: { over: 'campaigns', flightingToday: true, organic: true, empty },
    }
    const section: Section = { layout: 'tiles', items: [item] }
    const ctx = { todayEt: '2020-01-01' }
    expect(resolveRepeat(item.repeat, ctx)).toEqual([{ kind: 'organic' }])
    const out = flattenSectionItems(section, { kind: 'root' }, ctx)
    expect(out).toEqual([{ item, scope: { kind: 'root' }, emptyOf: empty }])
    expect(JSON.stringify(out)).not.toContain('no-tracked-campaign-flighting')
  })

  it('an item repeat that matches nothing and has no `empty` renders nothing', () => {
    const item: MetricItem = { ...baseItem, repeat: { over: 'campaigns', flightingToday: true } }
    const section: Section = { layout: 'tiles', items: [item] }
    expect(flattenSectionItems(section, { kind: 'root' }, { todayEt: '2020-01-01' })).toEqual([])
  })

  it('a section-level repeat multiplies every item across every instance', () => {
    const section: Section = { layout: 'rows', repeat: { over: 'popups', ids: ['install', 'signin-prompt'] }, items: [baseItem] }
    const out = flattenSectionItems(section, { kind: 'root' }, { todayEt: '2026-09-27' })
    expect(out.length).toBe(2)
    expect(out.map((fi) => (fi.scope as { popup: { id: string } }).popup.id)).toEqual(['install', 'signin-prompt'])
  })

  it('a section repeat that matches nothing renders its own `empty` placeholder', () => {
    const section: Section = {
      layout: 'rows',
      repeat: { over: 'campaigns', flightingToday: true, empty: { label: 'None', text: 'nothing today' } },
      items: [baseItem],
    }
    const out = flattenSectionItems(section, { kind: 'root' }, { todayEt: '2020-01-01' })
    expect(out.length).toBe(1)
    expect(out[0].emptyOf).toEqual(section.repeat!.empty)
  })
})

describe('todayEtFrom', () => {
  it('is a plain YYYY-MM-DD ET calendar date', () => {
    expect(todayEtFrom(Date.parse('2026-09-27T15:00:00Z'))).toBe('2026-09-27')
  })
})

describe('narrowToCampaigns: withActivity (the ads readings log campaign filter)', () => {
  const adsInfo = (hasActivity: boolean) => ({ spendThrough: null, lastSync: null, stale: false, storeBound: true, thresholdsFired: null, loadedAtMs: 0, hasActivity })
  const withAds = (c = ACTIVE_RETEST, hasActivity = true): ScopeInstance => ({ kind: 'campaign', campaign: c, ads: adsInfo(hasActivity) })
  const all: ScopeInstance[] = [campaignScope(CLOSED_ANDROID), withAds(CLOSED_SPEND_ONLY, false), withAds(ACTIVE_RETEST, true)]
  const repeat = { over: 'campaigns', withActivity: true } as const

  it('keeps only campaigns the readings load found something for; one it has not answered for yet is hidden', () => {
    expect(narrowToCampaigns(all, repeat, undefined).map((i) => (i.kind === 'campaign' ? i.campaign.id : i.kind))).toEqual([ACTIVE_RETEST.id])
  })
  it('an explicit campaignIds selection wins: it shows those, active or not', () => {
    expect(narrowToCampaigns(all, repeat, [CLOSED_SPEND_ONLY.id]).map((i) => (i.kind === 'campaign' ? i.campaign.id : i.kind))).toEqual([CLOSED_SPEND_ONLY.id])
  })
  it('without the flag nothing is filtered', () => {
    expect(narrowToCampaigns(all, { over: 'campaigns' }, undefined)).toHaveLength(3)
  })
})
