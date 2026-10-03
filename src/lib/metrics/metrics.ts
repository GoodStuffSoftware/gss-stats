// The metric catalog (ADR 0003 section 2, "The initial metric catalog"). A metric is a
// reducer over ONE fact's rows (lib/metrics/facts.ts): a row test (path family, visitor, …)
// whose matching rows' counts are summed, plus its unit, its declared subset (ratio validity,
// lib/metrics/ratios.ts), the params and windows it accepts, and its instrumentation rules
// (lib/metrics/instrumentation.ts).
//
// Every row test is an EXISTING classifier — lib/campaigns.ts classifyFunnelPath /
// isInstallPromptInstalled / isRawInstallSignal / isAuthSuccessBase / parseReturnPath,
// lib/popupEvents.ts classifyPopupPath, lib/overview.ts isEventPath / isPopupShown /
// isPopupAccept / isReturnD1Plus — so a metric counts exactly what today's endpoint counts.
// A new metric is a new entry here over an existing fact; a new fact is a code-reviewed SQL
// builder. Labels are notes-registry ids (`label.<id>`, lib/notes.ts).

import {
  CAMPAIGN_SPEND,
  authSuccessRow,
  classifyFunnelPath,
  isAuthSuccessBase,
  isInstallPromptInstalled,
  isRawInstallSignal,
  parseReturnPath,
  type CampaignAttribution,
  type CampaignFlight,
  type FunnelStepKey,
  type ReturnBucket,
} from '../campaigns'
import {
  AUTH_ERROR_REDIRECT_LIVE_AT_ET,
  classifyPopupPath,
  GAME_COMPLETE_LIVE_AT,
  INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
  isAuthErrorPath,
  isAuthRedirectPath,
  isTourExitPath,
  isTutorialCompletePath,
  POPUPS,
  RAW_INSTALL_DEDUPE_LIVE_AT_UTC_MS,
  TOUR_TRACKING_LIVE_AT,
  TRACKING_ACTIVATION_DATE_ET,
  type PopupEvent,
} from '../popupEvents'
import { isEventPath, isPopupAccept, isPopupShown, isReturnD1Plus } from '../overview'
import { resolveCampaignSpend, UPSELL_SIGNEDOUT_FIX_AT, AUTH_NEW_EXISTING_LIVE_AT, type SpendSummary } from '../adsRules'
import { freshnessOf, spendThroughFromRows } from '../adsFreshness'
import type { BeaconRow, FactId, FactRows } from './facts'
import { etMidnightMs, type InstrumentationRule } from './instrumentation'
import type { WindowName } from './types'
import type { Unit } from './units'

/** `country` (a COUNTRY_BUCKETS value) is OPTIONAL wherever a metric declares it: unset, the
 * metric counts every country; set, only that bucket (the campaign fact's `cb` split). */
export type MetricParam = 'campaignId' | 'popup' | 'country'
export const OPTIONAL_PARAMS: ReadonlySet<MetricParam> = new Set(['country'])

/** What a store reducer (MetricDef.store) sees besides the fact's rows. */
export interface StoreEnv {
  nowMs: number
  /** The release windows' size in days (the release metrics), null when there is no window. */
  releaseDays: number | null
}

/** What a reducer knows about the request it is serving. */
export interface MetricCtx {
  params: { campaignId?: string; popup?: string; country?: string }
  campaign?: CampaignFlight
  /** campaignAttributionClause(campaign) — applied in JS when a campaign metric reads a
   * site-wide fact (campaign.taggedArrivals over the KPI fact). */
  attribution?: CampaignAttribution
  window: WindowName
}

export interface MetricDef {
  id: string
  /** Notes-registry label id (always `label.<id>`). */
  label: string
  /** Notes-registry id of the unit word, when more specific than `unit.<unit>`. */
  unitLabel?: string
  unit: Unit
  /** Each counted thing maps to a DISTINCT counted thing of that metric (ratio validity). */
  subsetOf?: string
  params: MetricParam[]
  /** The fact each allowed window reads. The FIRST key is the default window. */
  windows: Partial<Record<WindowName, FactId>>
  /** Beacon metrics: the path test (memoized per path; also the seenInFlightWindow evidence). */
  path?: (path: string, ctx: MetricCtx) => boolean
  /** Beacon metrics: only rows of this visitor kind ('new' = a device's first-ever beacon). */
  visitor?: 'new'
  /** Beacon metrics: only rows carrying some campaign tag (any tag at all, unattributed). */
  anyTag?: true
  /** Spend metrics: the value from the stored-spend summaries (null = no spend known). */
  spend?: (rows: readonly SpendSummary[], ctx: MetricCtx) => number | null
  /** Any other non-beacon fact (the ads store's freshness reads, the first Best Sudoku hit): the
   * value, and the registry notes that travel with it. */
  store?: (rows: FactRows, ctx: MetricCtx, env: StoreEnv) => { value: number | null; noteIds?: string[] }
  instrumented: readonly InstrumentationRule[] | ((ctx: MetricCtx) => readonly InstrumentationRule[])
  /** Outcome beacons that arrive after the event they describe: [min, max] days. */
  lagDays?: [number, number]
  /** Note ids that travel with every value. */
  caveats?: string[]
}

// ── Memoized classifiers (a fact has few distinct paths and many rows) ───────────────────
function memo<T>(fn: (path: string) => T): (path: string) => T {
  const cache = new Map<string, T>()
  return (path) => {
    if (cache.has(path)) return cache.get(path) as T
    const v = fn(path)
    if (cache.size > 20_000) cache.clear()
    cache.set(path, v)
    return v
  }
}
const stepOf = memo<FunnelStepKey | null>(classifyFunnelPath)
const popupEventOf = memo<PopupEvent | null>(classifyPopupPath)
const returnOf = memo(parseReturnPath)
const step = (k: FunnelStepKey) => (path: string) => stepOf(path) === k

// ── Shared rules ─────────────────────────────────────────────────────────────────────────
const BEACON: InstrumentationRule = { kind: 'beaconMeasurable' }
const SEEN: InstrumentationRule = { kind: 'seenInFlightWindow' }
const TRACKING: InstrumentationRule = { kind: 'liveOnEtDate', dateEt: TRACKING_ACTIVATION_DATE_ET, source: 'TRACKING_ACTIVATION_DATE_ET' }
const TRACKING_VS_FLIGHT: InstrumentationRule = { ...TRACKING, against: 'flight' } as InstrumentationRule
const GAME_COMPLETE: InstrumentationRule = { kind: 'liveAt', atMs: GAME_COMPLETE_LIVE_AT, source: 'GAME_COMPLETE_LIVE_AT' }
const INSTALL_FIX: InstrumentationRule = { kind: 'unmeasuredBefore', atMs: INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS, source: 'INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS', noteId: 'install-fix-note' }
const RAW_DEDUPE: InstrumentationRule = { kind: 'annotateAt', atMs: RAW_INSTALL_DEDUPE_LIVE_AT_UTC_MS, noteId: 'raw-install-dedupe' }
// v1.97.0 (live 2026-10-03T17:03:40Z, lib/popupEvents.ts TOUR_TRACKING_LIVE_AT): the tutorial
// completion split and the tour exit step. Known to the second, so a window reaching back before
// it reads "counted from" rather than a false zero.
const TOUR_TRACKING: InstrumentationRule = { kind: 'liveAt', atMs: TOUR_TRACKING_LIVE_AT, source: 'TOUR_TRACKING_LIVE_AT' }
const AUTH_ERROR_REDIRECT: InstrumentationRule = { kind: 'liveOnEtDate', dateEt: AUTH_ERROR_REDIRECT_LIVE_AT_ET, source: 'AUTH_ERROR_REDIRECT_LIVE_AT_ET' }
// v1.95.5 (live 2026-09-26T19:43:02Z, the same instant as GAME_COMPLETE above): the new/
// existing/unknown split that rides alongside every base /auth/success/<provider> row (lib/
// adsRules.ts AUTH_NEW_EXISTING_LIVE_AT — the canonical source; see that constant's own doc
// comment for why it lives there and not in lib/popupEvents.ts). A custom noteId because the
// go-live is known to the SECOND (not just the ET calendar day AUTH_ERROR_REDIRECT above uses),
// so the note carries the precise ET clock time (lib/notes.ts 'auth-new-existing-note').
const AUTH_NEW_EXISTING: InstrumentationRule = { kind: 'liveAt', atMs: AUTH_NEW_EXISTING_LIVE_AT, source: 'AUTH_NEW_EXISTING_LIVE_AT', noteId: 'auth-new-existing-note' }
/** The signed-out upsell fix as a funnel segment boundary: a pre/post-fix window exists only
 * once it is set and falls inside the campaign's flight (lib/adsRules.ts campaignSegmentMarker). */
const UPSELL_BOUNDARY: InstrumentationRule = { kind: 'boundaryInFlight', atMs: UPSELL_SIGNEDOUT_FIX_AT, source: 'UPSELL_SIGNEDOUT_FIX_AT' }

const CAMPAIGN_WINDOWS = { attribution: 'campaignPathVisitor' } as const
const BSK_WINDOWS = { todaySoFar: 'bskKpiDays', page: 'bskRangePath' } as const
/** The release panel's before/after windows (lib/metrics/facts.ts bskReleaseSides). */
const RELEASE_WINDOWS = { before: 'bskReleaseSides', after: 'bskReleaseSides' } as const
const POPUP_WINDOWS = { page: 'popupRangePath' } as const

/** Campaign metrics over the campaign fact take an optional country bucket (its `cb` split). */
function campaignMetric(def: Omit<MetricDef, 'label' | 'params' | 'windows'> & Partial<Pick<MetricDef, 'windows' | 'params'>>): MetricDef {
  return { label: `label.${def.id}`, params: ['campaignId', 'country'], windows: CAMPAIGN_WINDOWS, ...def }
}
function bskMetric(def: Omit<MetricDef, 'label' | 'params' | 'windows'> & Partial<Pick<MetricDef, 'windows'>>): MetricDef {
  return { label: `label.${def.id}`, params: [], windows: BSK_WINDOWS, ...def }
}
function popupMetric(def: Omit<MetricDef, 'label' | 'windows'>): MetricDef {
  return { label: `label.${def.id}`, windows: POPUP_WINDOWS, ...def }
}

// ── Return buckets (lib/campaigns.ts RETURN_BUCKETS) ────────────────────────────────────
// The lag is the bucket's own window: a d2-7 return cannot fire before day 2 or after day 7.
const RETURN_METRICS: { id: string; bucket: ReturnBucket; lag?: [number, number] }[] = [
  { id: 'campaign.returnD0', bucket: 'd0' },
  { id: 'campaign.returnD1', bucket: 'd1', lag: [1, 1] },
  { id: 'campaign.returnD2to7', bucket: 'd2-7', lag: [2, 7] },
  { id: 'campaign.returnD8to14', bucket: 'd8-14', lag: [8, 14] },
  { id: 'campaign.returnD15to30', bucket: 'd15-30', lag: [15, 30] },
  { id: 'campaign.returnD31to60', bucket: 'd31-60', lag: [31, 60] },
]

// ── Pop-up outcomes (lib/popupEvents.ts POPUP_OUTCOME_TYPES; the app's own windows) ──────
const OUTCOME_METRICS: { id: string; outcome: string; lag: [number, number] }[] = [
  { id: 'popup.outcomeSignedIn', outcome: 'signed-in', lag: [0, 1] },
  { id: 'popup.outcomeInstalled', outcome: 'installed', lag: [0, 7] },
  { id: 'popup.outcomeReturned', outcome: 'returned', lag: [1, 7] },
  { id: 'popup.outcomeStillPlaying', outcome: 'still-playing', lag: [14, 21] },
]
const noOutcomeTracking = (popup: string | undefined) => !!POPUPS.find((p) => p.id === popup)?.noOutcomeTracking

// ── Tagged upsell showings, split at the upsell fix (lib/adsRules.ts summarizeTaggedRows' upsell) ─
const UPSELL_METRICS: { id: string; kind: 'shown' | 'accept' | 'dismiss' }[] = [
  { id: 'campaign.upsellShown', kind: 'shown' },
  { id: 'campaign.upsellAccepts', kind: 'accept' },
  { id: 'campaign.upsellDismisses', kind: 'dismiss' },
]
const UPSELL_WINDOWS = { attribution: 'campaignPathVisitor', upsellPre: 'campaignPathVisitor', upsellPost: 'campaignPathVisitor' } as const

// ── The ads store's freshness (lib/adsStore.ts readFreshness), per campaign ────────────────
/** 'spend-source.<source>': where campaign.spend's figure comes from (lib/adsRules.ts
 * resolveCampaignSpend). The value is a code (1 the Ads API, 0 hand-entered) shown as its label. */
function spendSourceOf(rows: FactRows, ctx: MetricCtx): { value: number | null; noteIds?: string[] } {
  if (rows.kind !== 'spend') return { value: null }
  const r = resolveCampaignSpend(rows.rows.find((x) => x.campaignId === ctx.params.campaignId) ?? null, CAMPAIGN_SPEND[ctx.params.campaignId ?? ''] ?? null)
  if (r.source === 'none') return { value: null }
  return { value: r.source === 'google-ads-api' ? 1 : 0, noteIds: [r.source === 'google-ads-api' ? 'spend-source.ads-api' : 'spend-source.config'] }
}
function spendThroughOf(rows: FactRows, ctx: MetricCtx, env: StoreEnv): { value: number | null; noteIds?: string[] } {
  if (rows.kind !== 'coverage' || !ctx.campaign) return { value: null }
  const c = ctx.campaign
  const through = spendThroughFromRows(c.flightStart, rows.rows.filter((r) => r.campaignId === c.id), c.flightEnd)
  const stale = freshnessOf(c, through, null, env.nowMs).stale
  return { value: through === null ? null : etMidnightMs(through), ...(stale ? { noteIds: ['ads-stale'] } : {}) }
}
function lastSyncOf(rows: FactRows, ctx: MetricCtx): { value: number | null } {
  if (rows.kind !== 'lastSync') return { value: null }
  const iso = rows.rows.find((r) => r.campaignId === ctx.params.campaignId)?.lastSync ?? null
  const ms = iso === null ? NaN : Date.parse(iso)
  return { value: Number.isFinite(ms) ? ms : null }
}

export const METRIC_DEFS: MetricDef[] = [
  // ── Campaign (one campaignPathVisitor statement per campaign) ────────────────────────────
  campaignMetric({ id: 'campaign.taggedHits', unit: 'row', unitLabel: 'unit.hits', instrumented: [BEACON] }),
  campaignMetric({
    id: 'campaign.taggedArrivals',
    unit: 'device',
    unitLabel: 'unit.arrivals',
    visitor: 'new',
    // 'todaySoFar' reads the KPI fact through campaignAttributionClause's rule, so the KPI tile and
    // the campaign card count the same rows — as long as a campaign's tagged rows are all on the
    // Best Sudoku sites, which the KPI fact filters on and the campaign fact does not (review #2:
    // production had none elsewhere on 2026-09-27; see the ADR's implementation notes).
    windows: { attribution: 'campaignPathVisitor', todaySoFar: 'bskKpiDays' },
    instrumented: [BEACON],
    caveats: ['arrivals-caveat'],
  }),
  campaignMetric({ id: 'campaign.gameViews', unit: 'pageview', path: step('played'), instrumented: [BEACON, SEEN] }),
  campaignMetric({ id: 'campaign.completions', unit: 'completion', path: step('completed'), instrumented: [BEACON, { ...GAME_COMPLETE, against: 'flight' } as InstrumentationRule, SEEN] }),
  campaignMetric({ id: 'campaign.asks', unit: 'showing', path: step('ask'), instrumented: [BEACON, SEEN] }),
  campaignMetric({ id: 'campaign.accepts', unit: 'showing', subsetOf: 'campaign.asks', path: step('accept'), instrumented: [BEACON, SEEN] }),
  campaignMetric({
    id: 'campaign.signedInAfterAsk',
    unit: 'showing',
    subsetOf: 'campaign.asks',
    path: (p) => {
      const ev = popupEventOf(p)
      return !!ev && (ev.family === 'popup-outcome:signin-prompt' || ev.family === 'popup-outcome:promo-first50') && ev.kind === 'signed-in'
    },
    instrumented: [BEACON, TRACKING, SEEN],
    lagDays: [0, 1],
  }),
  campaignMetric({ id: 'campaign.authSuccess', unit: 'signin', path: step('authSuccess'), instrumented: [BEACON, SEEN] }),
  campaignMetric({ id: 'campaign.installPrompts', unit: 'showing', path: step('installPrompt'), instrumented: [BEACON, SEEN] }),
  campaignMetric({ id: 'campaign.installs', unit: 'showing', subsetOf: 'campaign.installPrompts', path: step('install'), instrumented: [BEACON, INSTALL_FIX, SEEN], lagDays: [0, 7] }),
  campaignMetric({ id: 'campaign.rawInstallSignals', unit: 'row', path: isRawInstallSignal, instrumented: [BEACON, RAW_DEDUPE], caveats: ['raw-install-dedupe'] }),
  ...RETURN_METRICS.map(({ id, bucket, lag }) =>
    campaignMetric({
      id,
      unit: 'device',
      ...(bucket === 'd0' ? {} : { subsetOf: 'campaign.returnD0', lagDays: lag }),
      params: ['campaignId'],
      windows: { attribution: 'campaignReturns' },
      path: (p, ctx) => {
        const ev = returnOf(p)
        return !!ev && ev.bucket === bucket && !!ctx.campaign?.ucValues.includes(ev.uc)
      },
      instrumented: [BEACON, TRACKING_VS_FLIGHT],
    }),
  ),
  ...UPSELL_METRICS.map(({ id, kind }) =>
    campaignMetric({
      id,
      unit: 'showing',
      ...(kind === 'shown' ? {} : { subsetOf: 'campaign.upsellShown' }),
      windows: UPSELL_WINDOWS,
      path: (p) => {
        const ev = popupEventOf(p)
        return !!ev && ev.family === 'upsell' && ev.kind === kind
      },
      instrumented: (ctx) => (ctx.window === 'upsellPre' || ctx.window === 'upsellPost' ? [BEACON, UPSELL_BOUNDARY] : [BEACON]),
    }),
  ),
  campaignMetric({
    id: 'campaign.spendSource',
    unit: 'code',
    params: ['campaignId'],
    windows: { attribution: 'adsSpend' },
    store: spendSourceOf,
    instrumented: [],
  }),
  campaignMetric({
    id: 'campaign.spendThrough',
    unit: 'instant',
    params: ['campaignId'],
    windows: { attribution: 'adsCoverage' },
    store: spendThroughOf,
    instrumented: [],
  }),
  campaignMetric({
    id: 'campaign.lastSync',
    unit: 'instant',
    params: ['campaignId'],
    windows: { attribution: 'adsLastSync' },
    store: lastSyncOf,
    instrumented: [],
  }),
  campaignMetric({
    id: 'campaign.spend',
    unit: 'usd',
    params: ['campaignId'],
    windows: { attribution: 'adsSpend' },
    // Stored Google Ads spend first, else the hand-entered CAMPAIGN_SPEND (lib/adsRules.ts).
    spend: (rows, ctx) => resolveCampaignSpend(rows.find((r) => r.campaignId === ctx.params.campaignId) ?? null, CAMPAIGN_SPEND[ctx.params.campaignId ?? ''] ?? null).spend,
    instrumented: [],
  }),

  // ── Best Sudoku site-wide (bskKpiDays for today so far; bskRangePath for a page range) ──
  bskMetric({ id: 'bsk.pageviews', unit: 'pageview', path: (p) => !isEventPath(p), windows: { ...BSK_WINDOWS, ...RELEASE_WINDOWS }, instrumented: [] }),
  // Any tagged first-ever beacon, whatever its campaign (the release panel's "Tagged arrivals":
  // no attribution window, unlike campaign.taggedArrivals).
  bskMetric({ id: 'bsk.taggedArrivals', unit: 'device', unitLabel: 'unit.arrivals', visitor: 'new', anyTag: true, windows: { page: 'bskRangePath', ...RELEASE_WINDOWS }, instrumented: [], caveats: ['arrivals-caveat'] }),
  // How many days each release window covers (the latest dated release, bounded by the first
  // Best Sudoku hit and by today: lib/overview.ts releaseComparisonWindows).
  {
    id: 'release.windowDays',
    label: 'label.release.windowDays',
    unit: 'day',
    params: [],
    windows: { before: 'bskFirstHit', after: 'bskFirstHit' },
    store: (_rows, _ctx, env) => ({ value: env.releaseDays }),
    instrumented: [],
  },
  bskMetric({ id: 'bsk.gameViews', unit: 'pageview', path: step('played'), instrumented: [] }),
  bskMetric({ id: 'bsk.completions', unit: 'completion', path: step('completed'), instrumented: [GAME_COMPLETE] }),
  bskMetric({ id: 'bsk.popupShown', unit: 'showing', path: isPopupShown, instrumented: [TRACKING] }),
  bskMetric({ id: 'bsk.popupAccepts', unit: 'showing', subsetOf: 'bsk.popupShown', path: isPopupAccept, instrumented: [TRACKING] }),
  bskMetric({ id: 'bsk.authSuccess', unit: 'signin', path: isAuthSuccessBase, windows: { ...BSK_WINDOWS, ...RELEASE_WINDOWS }, instrumented: [] }),
  // The new/existing/unknown split (A2, review round 2026-09-27): the exact sign-up count the
  // current ad flight is judged on ('new'), plus existing sign-ins and the small unknown/old-
  // client remainder. Gated on AUTH_NEW_EXISTING (the 19:43:02Z go-live) so a range reaching
  // back before it reads "counted from 2026-09-26 15:43 ET" instead of a false zero — the base
  // bsk.authSuccess metric above predates this split and stays ungated (it counts every sign-in
  // regardless of whether the status row rode alongside it).
  bskMetric({ id: 'bsk.authSuccessNew', unit: 'signin', path: (p) => authSuccessRow(p) === 'new', windows: { ...BSK_WINDOWS, ...RELEASE_WINDOWS }, instrumented: [AUTH_NEW_EXISTING] }),
  bskMetric({ id: 'bsk.authSuccessExisting', unit: 'signin', path: (p) => authSuccessRow(p) === 'existing', windows: { ...BSK_WINDOWS, ...RELEASE_WINDOWS }, instrumented: [AUTH_NEW_EXISTING] }),
  bskMetric({ id: 'bsk.authSuccessUnknown', unit: 'signin', path: (p) => authSuccessRow(p) === 'unknown', windows: { ...BSK_WINDOWS, ...RELEASE_WINDOWS }, instrumented: [AUTH_NEW_EXISTING] }),
  // v1.89.0 (live 2026-09-22): sign-in FAILURES (/auth/error/<slug>, any slug) and the
  // popup-to-redirect fallback (/auth/redirect/<provider>) — see lib/popupEvents.ts
  // AUTH_ERROR_REDIRECT_LIVE_AT_ET. Gated (unlike bsk.authSuccess above, which predates this
  // convention) so a window reaching back before go-live reads "counted from" rather than a
  // misleading full-history zero.
  bskMetric({ id: 'bsk.authErrors', unit: 'row', path: isAuthErrorPath, windows: { ...BSK_WINDOWS, ...RELEASE_WINDOWS }, instrumented: [AUTH_ERROR_REDIRECT] }),
  bskMetric({ id: 'bsk.authRedirects', unit: 'row', path: isAuthRedirectPath, windows: { ...BSK_WINDOWS, ...RELEASE_WINDOWS }, instrumented: [AUTH_ERROR_REDIRECT] }),
  // v1.97.0: tutorial completions split by run kind, and tour exits by step. Counts only; the
  // tutorial rows are NOT real game completions (bsk.completions never counts them).
  bskMetric({ id: 'bsk.tutorialFirstRun', unit: 'row', path: (p) => isTutorialCompletePath(p, 'first-run'), instrumented: [TOUR_TRACKING] }),
  bskMetric({ id: 'bsk.tutorialReplay', unit: 'row', path: (p) => isTutorialCompletePath(p, 'replay'), instrumented: [TOUR_TRACKING] }),
  bskMetric({ id: 'bsk.tourExitPreamble', unit: 'row', path: (p) => isTourExitPath(p, 'preamble'), instrumented: [TOUR_TRACKING] }),
  bskMetric({ id: 'bsk.tourExitHub', unit: 'row', path: (p) => isTourExitPath(p, 'hub'), instrumented: [TOUR_TRACKING] }),
  bskMetric({ id: 'bsk.tourExitSection', unit: 'row', path: (p) => isTourExitPath(p, 'section'), instrumented: [TOUR_TRACKING] }),
  bskMetric({ id: 'bsk.installs', unit: 'showing', path: isInstallPromptInstalled, windows: { ...BSK_WINDOWS, ...RELEASE_WINDOWS }, instrumented: [INSTALL_FIX], lagDays: [0, 7] }),
  bskMetric({ id: 'bsk.rawInstallSignals', unit: 'row', path: isRawInstallSignal, instrumented: [RAW_DEDUPE], caveats: ['raw-install-dedupe'] }),
  bskMetric({ id: 'bsk.returnsD1plus', unit: 'row', path: isReturnD1Plus, instrumented: [TRACKING] }),

  // ── Pop-ups (popupRangePath over the page range, activation-gated like /api/popups) ────────
  popupMetric({
    id: 'popup.shown',
    unit: 'showing',
    params: ['popup'],
    path: (p, ctx) => {
      const ev = popupEventOf(p)
      return !!ev && ev.family === ctx.params.popup && ev.kind === 'shown'
    },
    instrumented: [TRACKING],
  }),
  popupMetric({
    id: 'popup.accepts',
    unit: 'showing',
    subsetOf: 'popup.shown',
    params: ['popup'],
    path: (p, ctx) => {
      const ev = popupEventOf(p)
      return !!ev && ev.family === ctx.params.popup && ev.kind === 'accept'
    },
    instrumented: [TRACKING],
  }),
  ...OUTCOME_METRICS.map(({ id, outcome, lag }) =>
    popupMetric({
      id,
      unit: 'showing',
      subsetOf: 'popup.shown',
      params: ['popup'],
      path: (p, ctx) => {
        const ev = popupEventOf(p)
        return !!ev && ev.family === `popup-outcome:${ctx.params.popup}` && ev.kind === outcome
      },
      instrumented: (ctx) =>
        noOutcomeTracking(ctx.params.popup)
          ? [{ kind: 'liveAt', atMs: null, source: 'POPUPS.noOutcomeTracking', reason: 'no-outcome-tracking' }]
          : // The install prompt's "installed" outcome: pre-fix rows are unmeasured (dropped
            // row-exactly, as /api/popups does), so it is counted from the install fix on.
            ctx.params.popup === 'install' && outcome === 'installed'
            ? [TRACKING, INSTALL_FIX]
            : [TRACKING],
      lagDays: lag,
    }),
  ),
  popupMetric({
    id: 'popup.eligibleEarned',
    unit: 'finish',
    subsetOf: 'popup.eligibleFinishes',
    params: [],
    path: (p) => {
      const ev = popupEventOf(p)
      return !!ev && ev.family === 'signin-eligible' && ev.kind === 'earned'
    },
    instrumented: [TRACKING],
    caveats: ['signin-eligible-caveat'],
  }),
  ...(['capped', 'unearned'] as const).map((k) =>
    popupMetric({
      id: k === 'capped' ? 'popup.eligibleCapped' : 'popup.eligibleUnearned',
      unit: 'finish',
      subsetOf: 'popup.eligibleFinishes',
      params: [],
      path: (p) => {
        const ev = popupEventOf(p)
        return !!ev && ev.family === 'signin-eligible' && ev.kind === k
      },
      instrumented: [TRACKING],
      caveats: ['signin-eligible-caveat'],
    }),
  ),
  popupMetric({
    id: 'popup.eligibleFinishes',
    unit: 'finish',
    params: [],
    path: (p) => {
      const ev = popupEventOf(p)
      return !!ev && ev.family === 'signin-eligible' && (ev.kind === 'earned' || ev.kind === 'capped' || ev.kind === 'unearned')
    },
    instrumented: [TRACKING],
    caveats: ['signin-eligible-caveat'],
  }),
]

export const METRICS: ReadonlyMap<string, MetricDef> = (() => {
  const m = new Map<string, MetricDef>()
  for (const d of METRIC_DEFS) {
    if (m.has(d.id)) throw new Error(`duplicate metric id ${d.id}`)
    if (d.label !== `label.${d.id}`) throw new Error(`metric ${d.id}: label must be label.${d.id}`)
    if (!Object.keys(d.windows).length) throw new Error(`metric ${d.id}: no windows`)
    if (!d.path && !d.visitor && !d.spend && !d.store && Object.values(d.windows).some((f) => f === 'adsSpend')) throw new Error(`metric ${d.id}: a spend fact needs spend() or store()`)
    if (!d.store && Object.values(d.windows).some((f) => f === 'adsCoverage' || f === 'adsLastSync' || f === 'bskFirstHit')) throw new Error(`metric ${d.id}: a store fact needs store()`)
    // The engine buckets the KPI fact's rows into ET days once per batch (lib/metrics/engine.ts),
    // which holds only while that fact serves exactly the today-so-far window and nothing else.
    for (const [w, f] of Object.entries(d.windows)) {
      if ((w === 'todaySoFar') !== (f === 'bskKpiDays')) throw new Error(`metric ${d.id}: todaySoFar must read bskKpiDays, and only it`)
    }
    m.set(d.id, d)
  }
  for (const d of METRIC_DEFS) if (d.subsetOf && !m.has(d.subsetOf)) throw new Error(`metric ${d.id}: subsetOf unknown metric ${d.subsetOf}`)
  return m
})()

const windowsMemo = new WeakMap<MetricDef, WindowName[]>()
/** The windows a metric accepts; the first is its default. */
export function metricWindows(def: MetricDef): WindowName[] {
  let w = windowsMemo.get(def)
  if (!w) windowsMemo.set(def, (w = Object.keys(def.windows) as WindowName[]))
  return w
}
export function rulesOf(def: MetricDef, ctx: MetricCtx): readonly InstrumentationRule[] {
  return typeof def.instrumented === 'function' ? def.instrumented(ctx) : def.instrumented
}
/** The metric's row test over a beacon row (path + visitor; attribution is the engine's job). */
export function rowMatcher(def: MetricDef, ctx: MetricCtx): (r: BeaconRow) => boolean {
  const pathTest = def.path
  const visitor = def.visitor
  if (def.anyTag) {
    const inner = rowMatcher({ ...def, anyTag: undefined }, ctx)
    return (r) => r.campaign !== '' && inner(r)
  }
  if (!pathTest) return visitor ? (r) => r.visitor === visitor : () => true
  const byPath = new Map<string, boolean>()
  const test = (p: string) => {
    let v = byPath.get(p)
    if (v === undefined) byPath.set(p, (v = pathTest(p, ctx)))
    return v
  }
  return visitor ? (r) => r.visitor === visitor && test(r.path) : (r) => test(r.path)
}
