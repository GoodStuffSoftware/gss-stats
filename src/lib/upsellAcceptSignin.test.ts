// The paywall's guest pass tap (best-sudoku 1.104.0): `/upsell/accept-signin/<reason>`, its own kind. A guest's tap
// sends ONLY this row (never `/upsell/accept/<reason>` too), so per render
//   shown = accept + accept-signin + dismiss + abandoned.
// `accept` and every accept metric stay the signed-in tap only; only the tap-RATE numerators count every tap.
import { describe, expect, it } from 'vitest'
import {
  aggregatePopupRows,
  classifyPopupPath,
  measuredCoarseCount,
  popupFamilyOf,
  popupOutcomeOf,
  POPUP_OUTCOME_LABELS,
  POPUP_OUTCOME_ORDER,
  UPSELL_KINDS,
  UPSELL_REASONS,
} from './popupEvents'
import { isPopupAccept, isPopupTap } from './overview'
import { summarizeSiteEvents, summarizeTaggedRows } from './adsRules'
import { FEATURES, stepMatches } from './featureHealth'
import { isSplitRefusedPath } from './splitGuard'
import { METRICS } from './metrics/metrics'
import { RATIOS } from './metrics/ratios'
import { POPUP_KIND_OPTIONS } from './catalog'

const T = Date.parse('2026-10-20T15:00:00Z') // after the tracking activation, on the hour
const rowsOf = (spec: Record<string, number>) => Object.entries(spec).map(([path, count]) => ({ hourStartMs: T, path, count }))
const taggedOf = (spec: Record<string, number>) => Object.entries(spec).map(([path, count]) => ({ hourStartMs: T, path, visitor: 'returning', count }))

describe('classifier', () => {
  it('lists accept-signin as an upsell kind', () => {
    expect(UPSELL_KINDS).toEqual(['shown', 'accept', 'accept-signin', 'dismiss'])
  })
  it('classifies /upsell/accept-signin/<reason> for every reason, and an unknown reason as other', () => {
    for (const r of UPSELL_REASONS) expect(classifyPopupPath(`/upsell/accept-signin/${r}`)).toEqual({ family: 'upsell', kind: 'accept-signin', extra: r })
    expect(classifyPopupPath('/upsell/accept-signin/some-future-reason')).toEqual({ family: 'upsell', kind: 'accept-signin', extra: 'other' })
  })
  it('needs a reason, like every upsell kind', () => {
    expect(classifyPopupPath('/upsell/accept-signin')).toBeNull()
    expect(classifyPopupPath('/upsell/accept-signin/')).toBeNull()
  })
  it('is not the accept kind: the two paths classify apart', () => {
    expect(classifyPopupPath('/upsell/accept/limit')!.kind).toBe('accept')
    expect(classifyPopupPath('/upsell/accept-signin/limit')!.kind).toBe('accept-signin')
  })
  it('the pop-ups chart dimension: family upsell, outcome accept-signin, ordered after accept, labelled', () => {
    expect(popupFamilyOf('/upsell/accept-signin/cadence', T)).toBe('upsell')
    expect(popupOutcomeOf('/upsell/accept-signin/cadence', T)).toBe('accept-signin')
    expect(POPUP_OUTCOME_ORDER.indexOf('accept-signin')).toBe(POPUP_OUTCOME_ORDER.indexOf('accept') + 1)
    expect(POPUP_OUTCOME_LABELS['accept-signin']).toBe('Pass tapped, sign-in first')
    expect(POPUP_KIND_OPTIONS.some((o) => o.value === 'accept-signin' && o.label === 'Pass tapped, sign-in first')).toBe(true)
  })
  it('is not a refused (counts-only) path: it splits like the other upsell rows', () => {
    expect(isSplitRefusedPath('/upsell/accept-signin/limit')).toBe(false)
    expect(isSplitRefusedPath('/upsell/accept/limit')).toBe(false)
  })
})

describe('the identity shown = accept + accept-signin + dismiss + abandoned', () => {
  // Ten renders: each sends one shown, then at most one answer. The rest are abandoned (no answer beacon).
  const spec = {
    '/upsell/shown/cadence': 6,
    '/upsell/shown/limit': 4,
    '/upsell/accept/cadence': 2,
    '/upsell/accept-signin/cadence': 1,
    '/upsell/accept-signin/limit': 2,
    '/upsell/dismiss/limit': 1,
  }
  it('holds on the pop-ups aggregate: abandoned is the unanswered rest, and accept counts only signed-in taps', () => {
    const agg = aggregatePopupRows(rowsOf(spec))
    const get = (k: string) => measuredCoarseCount(agg, 'upsell', k)
    expect(get('shown')).toBe(10)
    expect(get('accept')).toBe(2)
    expect(get('accept-signin')).toBe(3)
    expect(get('dismiss')).toBe(1)
    const abandoned = get('shown') - (get('accept') + get('accept-signin') + get('dismiss'))
    expect(abandoned).toBe(4)
    expect(get('shown')).toBe(get('accept') + get('accept-signin') + get('dismiss') + abandoned)
  })
  it('holds on the tagged and site-wide ads summaries', () => {
    const tagged = summarizeTaggedRows(taggedOf(spec))
    expect(tagged.upsell).toEqual({ shown: 10, accept: 2, acceptSignin: 3, dismiss: 1 })
    const site = summarizeSiteEvents(rowsOf(spec), T - 24 * 3_600_000)
    expect(site.upsell).toEqual({ shown: 10, accept: 2, acceptSignin: 3, dismiss: 1 })
    for (const u of [tagged.upsell, site.upsell]) expect(u.shown - (u.accept + u.acceptSignin + u.dismiss)).toBe(4)
  })
  it('adding accept-signin rows changes no existing figure', () => {
    const without = Object.fromEntries(Object.entries(spec).filter(([p]) => !p.includes('accept-signin')))
    const base = summarizeTaggedRows(taggedOf(without))
    const withSignin = summarizeTaggedRows(taggedOf(spec))
    expect(base.upsell.acceptSignin).toBe(0)
    expect({ ...withSignin.upsell, acceptSignin: 0 }).toEqual(base.upsell)
    expect(withSignin.accepts).toEqual(base.accepts)
    expect(withSignin.funnel).toEqual(base.funnel)
    expect(withSignin.asks).toEqual(base.asks)
  })
  it('no abandoned figure is a registered metric: the identity is a fixture, not a readout', () => {
    expect([...METRICS.keys()].some((id) => /abandon/i.test(id))).toBe(false)
  })
})

describe('the metrics: accept stays signed-in only, the tap rates count every tap', () => {
  const ctx = (popup: string) => ({ params: { popup } }) as never
  const pathOf = (id: string) => METRICS.get(id)!.path as unknown as (p: string, c: never) => boolean
  const PATHS = [
    '/upsell/shown/limit', '/upsell/accept/limit', '/upsell/dismiss/limit',
    '/signin-prompt/placement', '/signin-prompt/accept', '/signin-prompt/dismiss', '/promo-first50/accept',
    '/first50-congrats/ack', '/install/pwa-accept', '/popup-outcome/upsell/limit/signed-in', '/', '/game',
  ]
  it('isPopupAccept is false on accept-signin; isPopupTap is true on it', () => {
    expect(isPopupAccept('/upsell/accept-signin/limit')).toBe(false)
    expect(isPopupTap('/upsell/accept-signin/limit')).toBe(true)
    expect(isPopupTap('/upsell/accept/limit')).toBe(true)
    expect(isPopupTap('/upsell/dismiss/limit')).toBe(false)
  })
  it('before the release (no accept-signin rows) every tap predicate equals its accept predicate, row for row: historical rates are unchanged', () => {
    for (const p of PATHS) {
      expect(isPopupTap(p), p).toBe(isPopupAccept(p))
      for (const popup of ['upsell', 'signin-prompt', 'promo-first50', 'install', 'first50-congrats']) {
        expect(pathOf('popup.taps')(p, ctx(popup)), `${popup} ${p}`).toBe(pathOf('popup.accepts')(p, ctx(popup)))
        expect(pathOf('popup.acceptSignins')(p, ctx(popup)), `${popup} ${p}`).toBe(false)
      }
    }
  })
  it('popup.accepts and bsk.popupAccepts do not count accept-signin; popup.acceptSignins counts only it', () => {
    const p = '/upsell/accept-signin/limit'
    expect(pathOf('popup.accepts')(p, ctx('upsell'))).toBe(false)
    expect(pathOf('popup.taps')(p, ctx('upsell'))).toBe(true)
    expect(pathOf('popup.acceptSignins')(p, ctx('upsell'))).toBe(true)
    expect(pathOf('popup.acceptSignins')('/upsell/accept/limit', ctx('upsell'))).toBe(false)
    expect(pathOf('popup.acceptSignins')(p, ctx('signin-prompt'))).toBe(false)
    expect(pathOf('bsk.popupAccepts')(p, ctx('upsell'))).toBe(false)
    expect(pathOf('bsk.popupTaps')(p, ctx('upsell'))).toBe(true)
  })
  it('the tap-rate numerators are the all-taps metrics; the accept metrics are untouched', () => {
    expect(RATIOS.get('popup.tapRate')!.num).toBe('popup.taps')
    expect(RATIOS.get('bsk.popupTapRate')!.num).toBe('bsk.popupTaps')
    expect(METRICS.get('popup.accepts')!.subsetOf).toBe('popup.shown')
    expect(METRICS.get('popup.taps')!.subsetOf).toBe('popup.shown')
    expect(METRICS.get('popup.acceptSignins')!.subsetOf).toBe('popup.shown')
    expect(METRICS.get('campaign.upsellAcceptSignins')!.subsetOf).toBe('campaign.upsellShown')
  })
})

describe('Feature health', () => {
  const upsell = FEATURES.find((f) => f.id === 'upsell')!
  const step = (id: string) => upsell.steps.find((s) => s.id === id)!
  it('has an accept-signin step that matches only its own rows, so Accepted is unchanged', () => {
    expect(stepMatches(step('accept-signin').match, '/upsell/accept-signin/limit')).toBe(true)
    expect(stepMatches(step('accept').match, '/upsell/accept-signin/limit')).toBe(false)
    expect(stepMatches(step('accept').match, '/upsell/accept/limit')).toBe(true)
    expect(stepMatches(step('accept-signin').match, '/upsell/accept/limit')).toBe(false)
    expect(step('accept-signin').ratioOf).toEqual({ per: 'shown' })
  })
})
