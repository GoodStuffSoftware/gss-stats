// The web-only organic baseline arm (lib/campaigns.ts ORGANIC_ARM_ID) across the metrics layer:
// which bindings serve it, how a campaigns repeat carries it, and what the server accepts.
import { describe, expect, it } from 'vitest'
import { CAMPAIGNS, campaignById, ORGANIC_ARM_ID } from '../campaigns'
import { noteRawText } from '../notes'
import { itemViewModel } from './render'
import { METRICS, rowMatcher, rulesOf, type MetricCtx } from './metrics'
import { measuredInterval } from './instrumentation'
import { ORGANIC_TRACKING_LIVE_AT, TOUR_TRACKING_LIVE_AT } from '../popupEvents'
import { RATIOS, ratioSupportsOrganic } from './ratios'
import { CAMPAIGN_RETURNS, CAMPAIGN_SCORECARD } from './presets'
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
/** R2-7 serves the organic arm over its matured cohort only (the verdict's baseline). */
const R27_METRICS = ['campaign.returnD2to7Rate', 'campaign.returnD2to7Lower', 'campaign.returnD2to7Upper']

describe('which bindings serve the organic arm', () => {
  it('exactly the return metrics and R2-7', () => {
    expect([...METRICS.values()].filter((d) => d.organic).map((d) => d.id).sort()).toEqual([...RETURN_METRICS, ...R27_METRICS].sort())
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

describe('v1.98.0 go-live: the organic gate and the tour note', () => {
  const GO = ORGANIC_TRACKING_LIVE_AT
  const rulesFor = (id: string, campaignId: string) => rulesOf(METRICS.get(id)!, ctx(campaignId))
  const organicD0 = () => rulesFor('campaign.returnD0', ORGANIC_ARM_ID)

  it('the organic arm is a binary switch: not yet tracking before go-live, measured after, never partial', () => {
    // The organic arm has no attribution start, so its window is [now, now].
    expect(measuredInterval({ rules: organicD0(), window: [GO - 1000, GO - 1000] })).toMatchObject({ status: 'unmeasured', reason: 'not-live' })
    expect(measuredInterval({ rules: organicD0(), window: [GO + 1000, GO + 1000] })).toMatchObject({ status: 'measured' })
  })

  it('a campaign arm is not gated by the organic go-live', () => {
    const rules = rulesFor('campaign.returnD0', RETEST.id)
    expect(rules.some((r) => r.kind === 'liveAt' && r.atMs === GO)).toBe(false)
  })

  const TOUR = ['bsk.tourExitPreamble', 'bsk.tourExitHub', 'bsk.tourExitSection']
  const noteIds = (id: string, window: [number, number]) => measuredInterval({ rules: rulesOf(METRICS.get(id)!, ctx(ORGANIC_ARM_ID)), window })
  it.each(TOUR)('%s: the note rides a window straddling go-live, not one wholly before or after, and never changes the value status', (id) => {
    const straddle = noteIds(id, [GO - 3600_000, GO + 3600_000])
    expect(straddle.noteIds).toContain('tour-ends-on-game-start')
    const before = noteIds(id, [TOUR_TRACKING_LIVE_AT + 1000, GO - 1000])
    const after = noteIds(id, [GO + 1000, GO + 3600_000])
    expect(before.noteIds).not.toContain('tour-ends-on-game-start')
    expect(after.noteIds).not.toContain('tour-ends-on-game-start')
    expect(straddle.status).toBe(after.status)
  })

  it('the tour note states the verified fact and no clock time', () => {
    const t = noteRawText('tour-ends-on-game-start')
    expect(t).toContain('v1.98.0 (Oct 3)')
    expect(t).toContain('starting a real game during the first-run tour ends it as a skip')
    expect(t).not.toMatch(/\d{1,2}:\d{2}|[AP]M/)
  })
})

describe('Google-reported installs (campaign.adsInstalls) on a scorecard', () => {
  const withAction = CAMPAIGNS.find((c) => c.installActionId)!
  const spendOnlyNoAction = CAMPAIGNS.find((c) => c.measurement === 'spend-only' && !c.installActionId)!
  const scope = (campaign: typeof withAction): ScopeInstance => ({ kind: 'campaign', campaign }) as unknown as ScopeInstance
  it('is asked only of a campaign that names an install action', () => {
    expect(configRuling({ metric: 'campaign.adsInstalls' }, scope(withAction), TODAY)).toBeNull()
    expect(configRuling({ ratio: 'campaign.costPerAdsInstall' }, scope(withAction), TODAY)).toBeNull()
    expect(configRuling({ metric: 'campaign.adsInstalls' }, scope(spendOnlyNoAction), TODAY)).toBe('no-install-action')
    expect(configRuling({ ratio: 'campaign.costPerAdsInstall' }, scope(spendOnlyNoAction), TODAY)).toBe('no-install-action')
    expect(unmeasuredByConfig({ metric: 'campaign.adsInstalls' }, scope(spendOnlyNoAction), undefined, TODAY)).toBe(true)
  })
})

describe('the Campaign scorecard preset carries the Google-reported install rows', () => {
  it('lists installs and cost per install, each omitted when empty', () => {
    const items = CAMPAIGN_SCORECARD.sections.flatMap((s) => s.items)
    const ads = items.find((i) => i.id === 'adsInstalls')!
    const cpai = items.find((i) => i.id === 'cpai')!
    expect(ads.data).toEqual({ metric: 'campaign.adsInstalls' })
    expect(cpai.data).toEqual({ ratio: 'campaign.costPerAdsInstall' })
    expect(ads.gating?.whenEmpty).toBe('omit')
    expect(cpai.gating?.whenEmpty).toBe('omit')
  })

  it('adds Spend and Clicks (Google Ads) rows, only for a spend-only campaign (no site numbers)', () => {
    const items = CAMPAIGN_SCORECARD.sections.flatMap((s) => s.items)
    const spend = items.find((i) => i.id === 'adsSpend')!
    const clicks = items.find((i) => i.id === 'adsClicks')!
    expect(spend.data).toEqual({ metric: 'campaign.spend' })
    expect(clicks.data).toEqual({ metric: 'campaign.clicks' })
    expect(spend.gating?.forSpendOnly).toBe(true)
    expect(clicks.gating?.forSpendOnly).toBe(true)
    expect(noteRawText('label.campaign.adsSpend')).toBe('Spend (Google Ads)')
    expect(noteRawText('label.campaign.adsClicks')).toBe('Clicks (Google Ads)')
    const scope = (campaign: (typeof CAMPAIGNS)[number]): ScopeInstance => ({ kind: 'campaign', campaign }) as unknown as ScopeInstance
    const spendOnly = CAMPAIGNS.filter((c) => c.measurement === 'spend-only')
    const withSite = CAMPAIGNS.filter((c) => c.measurement !== 'spend-only')
    // Play-direct (no install action) and Flight 4 (with one) both show them; every campaign with site numbers omits them.
    expect(spendOnly.map((c) => c.id)).toEqual(expect.arrayContaining(['24234347705', '24392866056']))
    for (const it of [spend, clicks]) {
      for (const c of spendOnly) expect(unmeasuredByConfig(it.data, scope(c), it.gating, TODAY), `${c.id} ${it.id}`).toBe(false)
      for (const c of withSite) {
        expect(unmeasuredByConfig(it.data, scope(c), it.gating, TODAY), `${c.id} ${it.id}`).toBe(true)
        expect(buildRequestSpec(it, scope(c), TODAY)).toBeNull()
      }
    }
    for (const c of spendOnly) expect(buildRequestSpec(spend, scope(c), TODAY)).toMatchObject({ metric: 'campaign.spend', params: { campaignId: c.id } })
  })

  it('a spend-only card with Ads rows shows Spend and Clicks; with none, Spend reads one plain line and Clicks is left out', () => {
    const playDirect = campaignById('24234347705')!
    const sc: ScopeInstance = { kind: 'campaign', campaign: playDirect }
    const items = CAMPAIGN_SCORECARD.sections.flatMap((s) => s.items)
    const spend = items.find((i) => i.id === 'adsSpend')!
    const clicks = items.find((i) => i.id === 'adsClicks')!
    const o = { todayEt: TODAY }
    const sv = itemViewModel(spend, { status: 'ok', value: 75.17 }, sc, o)
    expect(sv).toMatchObject({ visible: true, primary: '$75.17' })
    expect(itemViewModel(clicks, { status: 'ok', value: 381 }, sc, o)).toMatchObject({ visible: true, primary: '381' })
    const none = itemViewModel(spend, { status: 'no-data', value: null }, sc, o)
    expect(none).toMatchObject({ visible: true, primary: 'no Google Ads data stored for this campaign' })
    expect(itemViewModel(clicks, { status: 'no-data', value: null }, sc, o).visible).toBe(false)
    // The cost-of-site rows stay out of a spend-only card whatever the data.
    for (const id of ['arrivals', 'auth', 'installs', 'return', 'cpa', 'adsInstalls', 'cpai']) {
      const it = items.find((i) => i.id === id)!
      expect(unmeasuredByConfig(it.data, sc, it.gating, TODAY), id).toBe(true)
    }
  })

  it('a campaign with site numbers is unchanged: no Spend or Clicks row, as before', () => {
    const web = campaignById('24279250691')!
    const sc: ScopeInstance = { kind: 'campaign', campaign: web }
    const items = CAMPAIGN_SCORECARD.sections.flatMap((s) => s.items)
    for (const id of ['adsSpend', 'adsClicks']) expect(itemViewModel(items.find((i) => i.id === id)!, { status: 'ok', value: 5 }, sc, { todayEt: TODAY }).visible).toBe(false)
  })
})

describe('the Campaign scorecard F4 card reads the tagged rows beside the Google Ads rows', () => {
  const F4 = '24392866056'
  const PLAY_DIRECT = '24234347705'
  const WEB = '24279250691'
  const items = CAMPAIGN_SCORECARD.sections.flatMap((s) => s.items)
  const sc = (id: string): ScopeInstance => ({ kind: 'campaign', campaign: campaignById(id)! }) as unknown as ScopeInstance
  const omitted = (id: string, itemId: string) => {
    const it = items.find((i) => i.id === itemId)!
    return unmeasuredByConfig(it.data, sc(id), it.gating, TODAY)
  }
  // The chips the brief names, then the rows Google reports.
  const CHIPS = ['arrivals', 'played', 'completed', 'ask', 'accept', 'authSuccess', 'installPrompt', 'return']
  const GOOGLE = ['adsInstalls', 'cpai', 'adsSpend', 'adsClicks']

  it('shows every tagged chip and every Google Ads row', () => {
    for (const id of [...CHIPS, ...GOOGLE]) {
      expect(omitted(F4, id), id).toBe(false)
      const it = items.find((i) => i.id === id)!
      expect(buildRequestSpec(it, sc(F4), TODAY), id).not.toBeNull()
    }
  })

  it("leaves out the three web-install rows, which would read beside Google's own install count", () => {
    for (const id of ['installs', 'cpa', 'install']) {
      expect(omitted(F4, id), id).toBe(true)
      expect(buildRequestSpec(items.find((i) => i.id === id)!, sc(F4), TODAY), id).toBeNull()
    }
  })

  it('captions the chips with when tagged counts start, and no other card has a caption', () => {
    const pills = CAMPAIGN_SCORECARD.sections.find((s) => s.layout === 'pills')!
    expect(pills.title).toEqual({ bind: 'campaign.taggedNote' })
    expect(scopeField(sc(F4), 'campaign.taggedNote', TODAY)).toBe('Tagged counts start at the app release; installs before it are unlabelled.')
    for (const c of CAMPAIGNS.filter((x) => x.id !== F4)) expect(scopeField(sc(c.id), 'campaign.taggedNote', TODAY), c.id).toBeNull()
  })

  it('Play-direct (tired of ads) is unchanged: no site chips, and the Ads rows still show', () => {
    for (const id of [...CHIPS, 'installs', 'cpa', 'install', 'adsInstalls', 'cpai']) expect(omitted(PLAY_DIRECT, id), id).toBe(true)
    for (const id of ['adsSpend', 'adsClicks']) expect(omitted(PLAY_DIRECT, id), id).toBe(false)
  })

  it('a web campaign is unchanged: its install rows stay and the Ads rows stay out', () => {
    for (const id of ['arrivals', 'installs', 'cpa', 'install', 'return']) expect(omitted(WEB, id), id).toBe(false)
    for (const id of ['adsSpend', 'adsClicks']) expect(omitted(WEB, id), id).toBe(true)
  })

  it('validate rejects a notForInstallAction that is not true', () => {
    const card = JSON.parse(JSON.stringify(CAMPAIGN_SCORECARD)) as CardSpec
    expect(validateCard(card)).toEqual([])
    const it = card.sections[0].items.find((i) => i.id === 'cpa')!
    ;(it.gating as { notForInstallAction?: unknown }).notForInstallAction = false
    expect(validateCard(card).join(' ')).toMatch(/notForInstallAction must be true/)
  })
})
