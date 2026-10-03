// The metric catalog: every label, unit word and caveat is a notes-registry entry, units key
// off the beacon path families, and each metric counts the paths today's endpoints count.
import { describe, expect, it } from 'vitest'
import { METRIC_DEFS, METRICS, rowMatcher, rulesOf, type MetricCtx } from './metrics'
import { RATIO_DEFS } from './ratios'
import { PATH_FAMILY_UNIT, UNITS, unitLabelId } from './units'
import { NOTES_REGISTRY } from '../notes'
import { PATH_FAMILY_OPTIONS, pathFamilyOf, POPUPS } from '../popupEvents'
import { campaignById, type CampaignFlight } from '../campaigns'
import { AUTH_NEW_EXISTING_LIVE_AT } from '../adsRules'
import type { BeaconRow } from './facts'

const ANDROID = campaignById('24215315197')!
const ctxFor = (params: MetricCtx['params'] = {}, campaign?: CampaignFlight): MetricCtx => ({ params, campaign, window: 'attribution' })
const row = (path: string, visitor = 'returning'): BeaconRow => ({ path, visitor, campaign: '', day: 0, sameTime: false, seg: 0, pf: null, cb: '', uf: null, c: 1 })

describe('labels, unit words and caveats all live in the notes registry', () => {
  it('every metric and ratio label exists and is a label entry', () => {
    for (const d of [...METRIC_DEFS, ...RATIO_DEFS]) {
      expect(NOTES_REGISTRY[d.label]?.kind, d.label).toBe('label')
    }
  })
  it('every unit word (and every metric unitLabel override) exists and is a label entry', () => {
    for (const u of UNITS) expect(NOTES_REGISTRY[unitLabelId(u)]?.kind, u).toBe('label')
    for (const d of METRIC_DEFS) if (d.unitLabel) expect(NOTES_REGISTRY[d.unitLabel]?.kind, d.unitLabel).toBe('label')
  })
  it('every caveat and every instrumentation note id exists', () => {
    const popups = [undefined, ...POPUPS.map((p) => p.id)]
    for (const d of METRIC_DEFS) {
      for (const id of d.caveats ?? []) expect(NOTES_REGISTRY[id], `${d.id} caveat ${id}`).toBeDefined()
      for (const popup of popups) {
        for (const rule of rulesOf(d, ctxFor({ popup, campaignId: ANDROID.id }, ANDROID))) {
          if ('noteId' in rule && rule.noteId) expect(NOTES_REGISTRY[rule.noteId], `${d.id} rule note ${rule.noteId}`).toBeDefined()
        }
      }
    }
    // The generic partial-status note and the status words the engine emits.
    for (const id of ['counted-from', 'still-arriving', 'not-yet-tracking', 'no-campaign-flighting', 'flight-pending', 'too-few-to-report']) {
      expect(NOTES_REGISTRY[id], id).toBeDefined()
    }
  })
})

describe('units key off the beacon path families (lib/popupEvents.ts)', () => {
  it('every path family has a unit, and no unit is declared for a family that does not exist', () => {
    const families = PATH_FAMILY_OPTIONS.map((o) => o.value)
    expect(Object.keys(PATH_FAMILY_UNIT).sort()).toEqual([...families].sort())
  })

  // One path each metric counts. A metric's unit is its family's unit unless listed below.
  const SAMPLES: Record<string, { path: string; params?: MetricCtx['params'] }> = {
    'campaign.gameViews': { path: '/game' },
    'campaign.completions': { path: '/game/complete/normal/easy' },
    'campaign.asks': { path: '/signin-prompt/placement' },
    'campaign.accepts': { path: '/signin-prompt/accept' },
    'campaign.signedInAfterAsk': { path: '/popup-outcome/signin-prompt/signed-in' },
    'campaign.installPrompts': { path: '/install/prompt/android' },
    'campaign.installs': { path: '/popup-outcome/install-prompt/installed' },
    'campaign.returnD0': { path: '/return/sudoku_tired_of_ads/d0' },
    'campaign.returnD2to7': { path: '/return/sudoku_tired_of_ads/d2-7' },
    'bsk.pageviews': { path: '/stats' },
    'bsk.completions': { path: '/game/complete/daily/hard' },
    'bsk.popupShown': { path: '/upsell/shown/limit' },
    'bsk.popupAccepts': { path: '/promo-first50/accept' },
    'bsk.installs': { path: '/popup-outcome/install-prompt/installed' },
    'bsk.authErrors': { path: '/auth/error/popup-blocked' },
    'bsk.authRedirects': { path: '/auth/redirect/google' },
    'bsk.tutorialFirstRun': { path: '/game/tutorial-complete/first-run' },
    'bsk.tutorialReplay': { path: '/game/tutorial-complete/replay' },
    'bsk.tourExitPreamble': { path: '/tour/exit-at/preamble' },
    'bsk.tourExitHub': { path: '/tour/exit-at/hub' },
    'bsk.tourExitSection': { path: '/tour/exit-at/section' },
    'bsk.authSuccessNew': { path: '/auth/success/google/new' },
    'bsk.authSuccessExisting': { path: '/auth/success/email/existing' },
    'bsk.authSuccessUnknown': { path: '/auth/success/google/unknown' },
    'popup.shown': { path: '/signin-prompt/streak', params: { popup: 'signin-prompt' } },
    'popup.outcomeReturned': { path: '/popup-outcome/upsell/returned', params: { popup: 'upsell' } },
    'popup.eligibleEarned': { path: '/signin-eligible/earned' },
    // Exceptions — the unit differs from the path family's, on purpose:
    'campaign.authSuccess': { path: '/auth/success/google' }, // a page-family path, but one row per sign-in
    'bsk.authSuccess': { path: '/auth/success/email' }, // same
    'campaign.rawInstallSignals': { path: '/install/pwa-installed' }, // raw signals can double-count one install: rows
    'bsk.rawInstallSignals': { path: '/install/standalone-detected' }, // same
    'bsk.returnsD1plus': { path: '/return/sudoku_tired_of_ads/d1' }, // device × bucket, summed across buckets: rows
  }
  const EXCEPTIONS: Record<string, string> = {
    'campaign.authSuccess': 'signin',
    'bsk.authSuccess': 'signin',
    'bsk.authSuccessNew': 'signin',
    'bsk.authSuccessExisting': 'signin',
    'bsk.authSuccessUnknown': 'signin',
    'campaign.rawInstallSignals': 'row',
    'bsk.rawInstallSignals': 'row',
    'bsk.returnsD1plus': 'row',
  }
  it.each(Object.entries(SAMPLES))('%s counts its sample path, in the unit of that path family (or a listed exception)', (id, { path, params }) => {
    const def = METRICS.get(id)!
    expect(def, id).toBeDefined()
    const ctx = ctxFor({ campaignId: ANDROID.id, ...params }, ANDROID)
    expect(rowMatcher(def, ctx)(row(path)), `${id} should match ${path}`).toBe(true)
    expect(def.unit).toBe(EXCEPTIONS[id] ?? PATH_FAMILY_UNIT[pathFamilyOf(path)])
  })
})

describe('the catalog', () => {
  it('ids are unique, labels follow label.<id>, subsets point at known metrics', () => {
    expect(new Set(METRIC_DEFS.map((d) => d.id)).size).toBe(METRIC_DEFS.length)
    for (const d of METRIC_DEFS) {
      expect(d.label).toBe(`label.${d.id}`)
      if (d.subsetOf) expect(METRICS.has(d.subsetOf)).toBe(true)
    }
  })
  it('a subset shares its superset\'s unit (a proportion needs both)', () => {
    for (const d of METRIC_DEFS) if (d.subsetOf) expect(d.unit, d.id).toBe(METRICS.get(d.subsetOf)!.unit)
  })
  it('tagged arrivals are visitor=new rows only (the DEFINITION FIX); tagged hits are every row', () => {
    const ctx = ctxFor({ campaignId: ANDROID.id }, ANDROID)
    expect(rowMatcher(METRICS.get('campaign.taggedArrivals')!, ctx)(row('/game', 'new'))).toBe(true)
    expect(rowMatcher(METRICS.get('campaign.taggedArrivals')!, ctx)(row('/game', 'returning'))).toBe(false)
    expect(rowMatcher(METRICS.get('campaign.taggedHits')!, ctx)(row('/anything', 'returning'))).toBe(true)
  })
  it('a return bucket counts only this campaign\'s uc (the path-embedded tag)', () => {
    const d0 = METRICS.get('campaign.returnD0')!
    expect(rowMatcher(d0, ctxFor({ campaignId: ANDROID.id }, ANDROID))(row('/return/sudoku_tired_of_ads/d0'))).toBe(true)
    expect(rowMatcher(d0, ctxFor({ campaignId: ANDROID.id }, ANDROID))(row('/return/sudoku_funnel_retest/d0'))).toBe(false)
  })
  // A stray legacy /game/complete-deferred/ row is a sibling prefix, never a live completion.
  it('live completions never count a legacy deferred row', () => {
    const live = METRICS.get('bsk.completions')!
    const ctx = ctxFor()
    expect(rowMatcher(live, ctx)(row('/game/complete/normal/easy'))).toBe(true)
    expect(rowMatcher(live, ctx)(row('/game/complete-deferred/normal/easy'))).toBe(false)
  })
  // v1.97.0: a tutorial row is never a game completion. Every completions metric anchors on
  // /game/complete/, so none counts a /game/tutorial-complete/ row.
  it('no completions metric counts a tutorial-complete row', () => {
    const ctx = ctxFor()
    for (const id of ['bsk.completions', 'campaign.completions']) {
      const m = METRICS.get(id)!
      for (const p of ['/game/tutorial-complete/first-run', '/game/tutorial-complete/replay']) {
        expect(rowMatcher(m, ctx)(row(p)), `${id} ${p}`).toBe(false)
      }
    }
  })
  it('auth successes count the base row only, never the new/existing status row beside it', () => {
    const auth = METRICS.get('bsk.authSuccess')!
    expect(rowMatcher(auth, ctxFor())(row('/auth/success/google'))).toBe(true)
    expect(rowMatcher(auth, ctxFor())(row('/auth/success/google/new'))).toBe(false)
  })
  // A2 (review round 2026-09-27): the new/existing/unknown split rides alongside the base
  // auth-success row (never in place of it) — mutually exclusive from each other AND from the
  // base bsk.authSuccess metric, gated on its own go-live (AUTH_NEW_EXISTING_LIVE_AT,
  // lib/adsRules.ts), never the base metric's ungated rule.
  it('new/existing/unknown are mutually exclusive, and exclusive of the base auth-success row', () => {
    const newM = METRICS.get('bsk.authSuccessNew')!
    const existingM = METRICS.get('bsk.authSuccessExisting')!
    const unknownM = METRICS.get('bsk.authSuccessUnknown')!
    const base = METRICS.get('bsk.authSuccess')!
    const ctx = ctxFor()
    expect(rowMatcher(newM, ctx)(row('/auth/success/google/new'))).toBe(true)
    expect(rowMatcher(newM, ctx)(row('/auth/success/google/existing'))).toBe(false)
    expect(rowMatcher(newM, ctx)(row('/auth/success/google'))).toBe(false) // the base row itself
    expect(rowMatcher(existingM, ctx)(row('/auth/success/email/existing'))).toBe(true)
    expect(rowMatcher(existingM, ctx)(row('/auth/success/email/new'))).toBe(false)
    expect(rowMatcher(unknownM, ctx)(row('/auth/success/google/unknown'))).toBe(true)
    expect(rowMatcher(unknownM, ctx)(row('/auth/success/google/new'))).toBe(false)
    expect(rowMatcher(base, ctx)(row('/auth/success/google/new'))).toBe(false) // never double-counted
  })
  it('new/existing/unknown are gated on AUTH_NEW_EXISTING_LIVE_AT, never the base metric\'s ungated rule', () => {
    for (const id of ['bsk.authSuccessNew', 'bsk.authSuccessExisting', 'bsk.authSuccessUnknown']) {
      const rules = rulesOf(METRICS.get(id)!, ctxFor())
      expect(rules, id).toEqual([{ kind: 'liveAt', atMs: AUTH_NEW_EXISTING_LIVE_AT, source: 'AUTH_NEW_EXISTING_LIVE_AT', noteId: 'auth-new-existing-note' }])
    }
    expect(rulesOf(METRICS.get('bsk.authSuccess')!, ctxFor())).toEqual([]) // predates the split, stays ungated
  })
  it('first50-congrats has no outcome tracking: its outcome metrics are never live', () => {
    for (const id of ['popup.outcomeSignedIn', 'popup.outcomeInstalled', 'popup.outcomeReturned', 'popup.outcomeStillPlaying']) {
      expect(rulesOf(METRICS.get(id)!, ctxFor({ popup: 'first50-congrats' }))).toEqual([{ kind: 'liveAt', atMs: null, source: 'POPUPS.noOutcomeTracking', reason: 'no-outcome-tracking' }])
    }
  })
})
