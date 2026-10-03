// The web-only organic baseline arm (lib/campaigns.ts ORGANIC_ARM_ID) across the metrics layer:
// which bindings serve it, how a campaigns repeat carries it, and what the server accepts.
import { describe, expect, it } from 'vitest'
import { CAMPAIGNS, campaignById, ORGANIC_ARM_ID } from '../campaigns'
import { noteRawText } from '../notes'
import { METRICS, rowMatcher, type MetricCtx } from './metrics'
import { RATIOS, ratioSupportsOrganic } from './ratios'
import { CAMPAIGN_RETURNS } from './presets'
import {
  armIdOfScope,
  buildRequestSpec,
  campaignOfScope,
  columnDefaultLabel,
  configRuling,
  narrowToCampaigns,
  resolveBinding,
  resolveRepeat,
  scopeField,
  scopeVars,
  unmeasuredByConfig,
  type ScopeInstance,
} from './scope'
import { bindingSupportsOrganic, validateCard, validateMetricsRequest } from './validate'
import type { CardSpec, MetricItem } from './types'
import type { BeaconRow } from './facts'
import { isReturnD1Plus } from '../overview'
import { releaseAwaitingFullDay, releaseSubjectOn } from '../releases'
import { tallySiteFirstSession } from '../adsRules'

const ORGANIC: ScopeInstance = { kind: 'organic' }
const TODAY = '2026-09-27'
const RETEST = campaignById('24279250691')!
const row = (path: string): BeaconRow => ({ path, visitor: 'new', ts: 0 }) as unknown as BeaconRow
const ctx = (campaignId: string): MetricCtx => ({ params: { campaignId }, campaign: campaignById(campaignId), window: 'attribution' })
const RETURN_METRICS = ['campaign.returnD0', 'campaign.returnD1', 'campaign.returnD2to7', 'campaign.returnD8to14', 'campaign.returnD15to30', 'campaign.returnD31to60']

describe('which bindings serve the organic arm', () => {
  it('exactly the return metrics', () => {
    expect([...METRICS.values()].filter((d) => d.organic).map((d) => d.id).sort()).toEqual([...RETURN_METRICS].sort())
  })
  it('a ratio only when BOTH sides do — never organic over campaign or the reverse', () => {
    expect([...RATIOS.values()].filter((r) => ratioSupportsOrganic(r)).map((r) => r.id).sort()).toEqual(
      ['campaign.returnD1PerD0', 'campaign.returnD2to7PerD0', 'campaign.returnD8to14PerD0', 'campaign.returnD15to30PerD0', 'campaign.returnD31to60PerD0'].sort(),
    )
    expect(ratioSupportsOrganic({ num: 'campaign.returnD1', den: 'campaign.taggedArrivals' })).toBe(false)
    expect(ratioSupportsOrganic({ num: 'campaign.taggedArrivals', den: 'campaign.returnD0' })).toBe(false)
    expect(bindingSupportsOrganic({ metric: 'campaign.taggedArrivals' })).toBe(false)
    expect(bindingSupportsOrganic({ ratio: 'campaign.acceptPerAsk' })).toBe(false)
    expect(bindingSupportsOrganic({ metric: 'campaign.returnD0' })).toBe(true)
  })
  it('an organic return bucket counts only /return/organic/ rows, and a campaign never counts them', () => {
    const d0 = METRICS.get('campaign.returnD0')!
    expect(rowMatcher(d0, ctx(ORGANIC_ARM_ID))(row('/return/organic/d0'))).toBe(true)
    expect(rowMatcher(d0, ctx(ORGANIC_ARM_ID))(row('/return/organic/d1'))).toBe(false)
    expect(rowMatcher(d0, ctx(ORGANIC_ARM_ID))(row('/return/sudoku_funnel_retest/d0'))).toBe(false)
    expect(rowMatcher(d0, ctx(RETEST.id))(row('/return/organic/d0'))).toBe(false)
    expect(rowMatcher(d0, ctx(RETEST.id))(row('/return/sudoku_funnel_retest/d0'))).toBe(true)
  })
})

describe('the server whitelist', () => {
  const one = (req: Record<string, unknown>) => {
    const b = validateMetricsRequest(JSON.stringify({ v: 1, requests: [{ key: 'k', ...req }] }))
    if (!b.ok) throw new Error(b.error)
    return b.requests[0]
  }
  it('accepts organic on a return metric and a return ratio', () => {
    expect(one({ metric: 'campaign.returnD0', params: { campaignId: ORGANIC_ARM_ID } })).toMatchObject({ ok: true, req: { params: { campaignId: ORGANIC_ARM_ID } } })
    expect(one({ ratio: 'campaign.returnD1PerD0', params: { campaignId: ORGANIC_ARM_ID } })).toMatchObject({ ok: true })
  })
  it.each(['campaign.taggedArrivals', 'campaign.asks', 'campaign.spend'])('rejects organic on metric %s', (metric) => {
    expect(one({ metric, params: { campaignId: ORGANIC_ARM_ID } })).toEqual({ key: 'k', ok: false, reason: 'bad-param' })
  })
  it.each(['campaign.acceptPerAsk', 'campaign.costPerArrival', 'campaign.gameViewsVsArrivals'])('rejects organic on ratio %s', (ratio) => {
    expect(one({ ratio, params: { campaignId: ORGANIC_ARM_ID } })).toEqual({ key: 'k', ok: false, reason: 'bad-param' })
  })

  const card = (data: MetricItem['data'], repeat?: CardSpec['repeat']): CardSpec => ({
    v: 1,
    ...(repeat ? { repeat } : {}),
    sections: [{ layout: 'rows', items: [{ id: 'x', label: 'X', data, display: { as: 'number' } }] }],
  })
  it('a card may pin organic only on a binding that serves it', () => {
    expect(validateCard(card({ metric: 'campaign.returnD0', params: { campaignId: ORGANIC_ARM_ID } }))).toEqual([])
    expect(validateCard(card({ metric: 'campaign.taggedArrivals', params: { campaignId: ORGANIC_ARM_ID } })).join()).toMatch(/campaignId 'organic'/)
  })
  it('repeat.organic: campaigns only, true only; never a pickable campaign id', () => {
    expect(validateCard(card({ metric: 'campaign.returnD0' }, { over: 'campaigns', organic: true }))).toEqual([])
    expect(validateCard(card({ metric: 'bsk.pageviews' }, { over: 'popups', organic: true })).join()).toMatch(/organic is for campaigns/)
    expect(validateCard(card({ metric: 'campaign.returnD0' }, { over: 'campaigns', organic: false })).join()).toMatch(/organic is for campaigns/)
    expect(validateCard(card({ metric: 'campaign.returnD0' }, { over: 'campaigns', ids: [ORGANIC_ARM_ID] })).join()).toMatch(/organic/)
    expect(validateCard(card({ metric: 'campaign.returnD0' }, { over: 'campaigns', organic: true, flightingToday: true })).join()).toMatch(/flightingToday/)
  })
})

describe('the organic scope instance', () => {
  const T = { todayEt: '2026-09-27' }
  it('a campaigns repeat with organic appends ONE organic instance after every campaign, whatever the filters', () => {
    const out = resolveRepeat({ over: 'campaigns', organic: true }, T)
    expect(out.length).toBe(CAMPAIGNS.length + 1)
    expect(out.at(-1)).toEqual(ORGANIC)
    expect(resolveRepeat({ over: 'campaigns', organic: true, ids: [RETEST.id], status: ['active'], tracked: true, flightingToday: true }, T)).toEqual([
      { kind: 'campaign', campaign: RETEST },
      ORGANIC,
    ])
    expect(resolveRepeat({ over: 'campaigns', organic: true, flightingToday: true }, { todayEt: '2020-01-01' })).toEqual([ORGANIC])
    expect(resolveRepeat({ over: 'campaigns' }, T).some((s) => s.kind === 'organic')).toBe(false)
  })
  it('the CAMPAIGN_RETURNS preset carries it, and a widget selection keeps it exactly once', () => {
    const all = resolveRepeat(CAMPAIGN_RETURNS.repeat, T)
    expect(all.filter((s) => s.kind === 'organic')).toHaveLength(1)
    const narrowed = narrowToCampaigns(all, CAMPAIGN_RETURNS.repeat, [RETEST.id])
    expect(narrowed).toEqual([{ kind: 'campaign', campaign: RETEST }, ORGANIC])
  })
  it('is not a campaign; its arm id and label come from the registry', () => {
    expect(campaignOfScope(ORGANIC)).toBeUndefined()
    expect(armIdOfScope(ORGANIC)).toBe(ORGANIC_ARM_ID)
    expect(scopeField(ORGANIC, 'campaign.id')).toBe(ORGANIC_ARM_ID)
    expect(scopeField(ORGANIC, 'campaign.label')).toBe('Organic (web)')
    expect(noteRawText('label.arm.organic')).toBe('Organic (web)')
    expect(scopeField(ORGANIC, 'campaign.flight')).toBeNull()
    expect(scopeField(ORGANIC, 'campaign.returnTagShared')).toBeNull()
    expect(scopeVars(ORGANIC)).toEqual({ campaign: { id: ORGANIC_ARM_ID, label: 'Organic (web)' } })
    expect(columnDefaultLabel(ORGANIC)).toEqual({ bind: 'campaign.label' })
  })
  it('the nearest arm wins when scopes nest', () => {
    const inCampaign: ScopeInstance = { kind: 'organic', parent: { kind: 'campaign', campaign: RETEST } } as ScopeInstance
    expect(armIdOfScope(inCampaign)).toBe(ORGANIC_ARM_ID)
    expect(campaignOfScope(inCampaign)).toBeUndefined()
  })
  it('resolves a return binding to campaignId organic; a binding that cannot serve it is left out, never requested', () => {
    expect(resolveBinding({ metric: 'campaign.returnD0' }, ORGANIC)?.params).toEqual({ campaignId: ORGANIC_ARM_ID })
    expect(configRuling({ metric: 'campaign.returnD0' }, ORGANIC, TODAY)).toBeNull()
    expect(configRuling({ ratio: 'campaign.returnD1PerD0' }, ORGANIC, TODAY)).toBeNull()
    expect(configRuling({ metric: 'campaign.taggedArrivals' }, ORGANIC, TODAY)).toBe('organic-unsupported')
    expect(configRuling({ ratio: 'campaign.acceptPerAsk' }, ORGANIC, TODAY)).toBe('organic-unsupported')
    expect(unmeasuredByConfig({ metric: 'campaign.taggedArrivals' }, ORGANIC, { whenNotStarted: 'label' }, TODAY)).toBe(true)
    const item: MetricItem = { id: 'a', label: 'A', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }
    expect(buildRequestSpec(item, ORGANIC)).toBeNull()
    // A site-wide binding and a pinned campaign are not the organic arm's to rule on.
    expect(configRuling({ metric: 'bsk.pageviews' }, ORGANIC, TODAY)).toBeNull()
    expect(configRuling({ metric: 'campaign.taggedArrivals', params: { campaignId: RETEST.id } }, ORGANIC, TODAY)).toBeNull()
  })
  it('on a release-awaiting day the organic ruling is unchanged, and a release field still renders from todayEt', () => {
    // configRuling answers a field binding with null before any arm check, so the release-awaiting
    // label (a field, read through scopeField with todayEt) is never ruled out under the organic
    // arm; the organic ruling depends only on the metric/ratio, never on the day.
    const AWAITING = '2026-10-03'
    const waiting = releaseAwaitingFullDay(AWAITING)!
    const subject = releaseSubjectOn(AWAITING)!
    expect(waiting).not.toBeNull()
    expect(configRuling({ metric: 'campaign.returnD0' }, ORGANIC, AWAITING)).toBeNull()
    expect(configRuling({ ratio: 'campaign.returnD1PerD0' }, ORGANIC, AWAITING)).toBeNull()
    expect(configRuling({ metric: 'campaign.taggedArrivals' }, ORGANIC, AWAITING)).toBe('organic-unsupported')
    expect(unmeasuredByConfig({ metric: 'campaign.taggedArrivals' }, ORGANIC, undefined, AWAITING)).toBe(true)
    expect(configRuling({ field: 'release.label' }, ORGANIC, AWAITING)).toBeNull()
    expect(unmeasuredByConfig({ field: 'release.label' }, ORGANIC, undefined, AWAITING)).toBe(false)
    expect(resolveBinding({ field: 'release.label' }, ORGANIC, AWAITING)?.fieldValue).toBe(`${subject.version} (${subject.dateEt}); ${waiting.version} needs a full day`)
  })
  it('every CAMPAIGN_RETURNS binding the organic instance would request passes the server whitelist', () => {
    for (const section of CAMPAIGN_RETURNS.sections) {
      for (const item of section.items) {
        const spec = buildRequestSpec(item, ORGANIC)
        if (!spec) continue
        const b = validateMetricsRequest(JSON.stringify({ v: 1, requests: [{ key: 'k', ...spec }] }))
        expect(b.ok && b.requests[0].ok, item.id).toBe(true)
      }
    }
  })
})

describe('the organic rows stay out of the tagged-only site-wide figures', () => {
  it('the "Return visits (day 1+)" tile counts tagged returns only', () => {
    expect(isReturnD1Plus('/return/sudoku_funnel_retest/d1')).toBe(true)
    expect(isReturnD1Plus('/return/organic/d1')).toBe(false)
    expect(isReturnD1Plus('/return/organic/d2-7')).toBe(false)
    expect(rowMatcher(METRICS.get('bsk.returnsD1plus')!, { params: {}, window: 'todaySoFar' })(row('/return/organic/d1'))).toBe(false)
  })
  it('the routine site-wide first-session arrivals leave organic d0 out', () => {
    const t = tallySiteFirstSession([
      { path: '/return/sudoku_funnel_retest/d0', count: 3 },
      { path: '/return/organic/d0', count: 50 },
    ])
    expect(t.steps.arrivals).toBe(3)
  })
})
