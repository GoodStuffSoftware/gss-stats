// Code-reviewed card presets (ADR 0003 section 1). A widget stores `card: { preset }`, so an
// improvement here reaches every widget that has not been customized. validate.test.ts runs
// validateCard over every one, and presets.parity.test.ts renders each against the bespoke
// Overview body it replaces, over the same SQLite fixture.
//
// Each preset reproduces what the bespoke body shows today (OverviewWidgetBody.vue, views
// 'scorecard' and 'kpis'), with only the documented changes: the ratio rule (a count or a pair
// where a percentage would be invalid), closed campaigns omitting what their flight could not
// measure, and the registry differences D1-D5 (functions/api/metrics.equivalence.test.ts).
//
// Every label is a notes-registry id — the metric's own (`{ metric: true }`) or an explicit
// `{ note }` where the bespoke body used a different name (the funnel pills) — never a literal.
// Caveats a value carries (arrivals floor, install fix, counted-from, still-arriving) and the
// items' own captions use captionMode 'compact': no caption line on the item; the card lists
// them behind its one collapsed "Notes" toggle (MetricCardInstance), the owner's clean look.

import type { CardSpec, Display, MetricItem } from './types'

const COMPACT = { captionMode: 'compact' } as const satisfies Partial<MetricItem>

/** The Overview campaign scorecard: one card per campaign (OverviewWidgetBody 'scorecard'). */
export const CAMPAIGN_SCORECARD: CardSpec = {
  v: 1,
  repeat: { over: 'campaigns' },
  link: 'campaigns-page',
  minWidth: 230,
  title: { bind: 'campaign.label' },
  // "flighting today" while the flight runs today, otherwise the campaign's status.
  badge: { data: { field: 'campaign.statusToday' }, display: { as: 'badge', tones: { 'flighting today': 'live' } } },
  sections: [
    {
      layout: 'rows',
      items: [
        // "2026-09-02 → 2026-09-09 (8d)", or "pending — start date not yet confirmed".
        { id: 'flight', label: { note: 'label.card.flight' }, data: { field: 'campaign.flight' }, display: { as: 'dateRange', days: true }, gating: { whenEmpty: { note: 'flight-pending' } } },
        { id: 'arrivals', label: { metric: true }, data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' }, ...COMPACT },
        { id: 'auth', label: { metric: true }, data: { metric: 'campaign.authSuccess' }, display: { as: 'number' }, ...COMPACT },
        { id: 'installs', label: { metric: true }, data: { metric: 'campaign.installs' }, display: { as: 'number' }, ...COMPACT },
        // "Return rate (d2-7): 12.1% (4/33)" — provisional while d2-7 returns can still arrive.
        { id: 'return', label: { metric: true }, data: { ratio: 'campaign.returnD2to7PerD0' }, display: { as: 'percent', decimals: 1 }, ...COMPACT },
        { id: 'cpa', label: { metric: true }, data: { ratio: 'campaign.costPerArrival' }, display: { as: 'currency' }, ...COMPACT },
      ],
    },
    {
      // The funnel pills, in FUNNEL_STEP_ORDER, with the bespoke body's step names
      // (FUNNEL_STEP_LABEL_IDS). Only accept/ask and install/prompt are valid proportions; every
      // other step is a count, and game-screen views read against arrivals as a pair.
      layout: 'pills',
      items: [
        { id: 'played', label: { note: 'label.campaign.gameViews' }, data: { ratio: 'campaign.gameViewsVsArrivals' }, display: { as: 'counts' }, ...COMPACT },
        { id: 'completed', label: { note: 'label.funnel.completed' }, data: { metric: 'campaign.completions' }, display: { as: 'number' }, ...COMPACT },
        { id: 'ask', label: { note: 'label.funnel.ask' }, data: { metric: 'campaign.asks' }, display: { as: 'number' }, ...COMPACT },
        { id: 'accept', label: { note: 'label.funnel.accept' }, data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'percent', decimals: 1 }, ...COMPACT },
        { id: 'authSuccess', label: { note: 'label.funnel.authSuccess' }, data: { metric: 'campaign.authSuccess' }, display: { as: 'number' }, ...COMPACT },
        { id: 'installPrompt', label: { note: 'label.funnel.installPrompt' }, data: { metric: 'campaign.installPrompts' }, display: { as: 'number' }, ...COMPACT },
        // Denominator: prompts shown from the install fix on (alignDenominator).
        { id: 'install', label: { note: 'label.funnel.install' }, data: { ratio: 'campaign.installPerPrompt' }, display: { as: 'percent', decimals: 1 }, ...COMPACT },
      ],
    },
  ],
}

const TODAY: Display = { as: 'number', deltas: ['yesterday', 'avg7'] }

/** "Today at a glance" (OverviewWidgetBody 'kpis'): one tiles section, today so far with
 * deltas vs yesterday and vs the 7-day average ("new today" when both predate a go-live). The
 * arrivals tile repeats per campaign flighting today, with a placeholder tile when none is. */
export const BSK_KPIS: CardSpec = {
  v: 1,
  showUpdated: 'header',
  sections: [
    {
      layout: 'tiles',
      items: [
        { id: 'pageviews', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        {
          id: 'arrivals',
          label: { note: 'label.card.taggedArrivalsFor', vars: { campaign: 'campaign.label' } },
          data: { metric: 'campaign.taggedArrivals', window: 'todaySoFar' },
          display: TODAY,
          repeat: { over: 'campaigns', flightingToday: true, empty: { label: { note: 'label.campaign.taggedArrivals' }, text: { note: 'no-campaign-flighting' } } },
          ...COMPACT,
        },
        { id: 'played', label: { metric: true }, data: { metric: 'bsk.gameViews', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'completed', label: { metric: true }, data: { metric: 'bsk.completions', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'popupShown', label: { metric: true }, data: { metric: 'bsk.popupShown', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'popupAccept', label: { metric: true }, data: { metric: 'bsk.popupAccepts', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'popupTapRate', label: { metric: true }, data: { ratio: 'bsk.popupTapRate', window: 'todaySoFar' }, display: { as: 'percent', decimals: 1 }, ...COMPACT },
        { id: 'authSuccess', label: { metric: true }, data: { metric: 'bsk.authSuccess', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'install', label: { metric: true }, data: { metric: 'bsk.installs', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'installRaw', label: { metric: true }, data: { metric: 'bsk.rawInstallSignals', window: 'todaySoFar' }, display: TODAY, caption: { note: 'raw-install-double-count' }, ...COMPACT },
        { id: 'returns', label: { metric: true }, data: { metric: 'bsk.returnsD1plus', window: 'todaySoFar' }, display: TODAY, caption: { note: 'returns-d1plus-caveat' }, ...COMPACT },
      ],
    },
  ],
}

/** The release panel (OverviewWidgetBody 'releasePanel'): the latest dated release, how many
 * days each side covers, and a table of the four counts with Before and After as its columns.
 * Each window is `days` whole days on its side of the release's ET midnight, bounded by the
 * first Best Sudoku hit and by today (lib/overview.ts releaseComparisonWindows). A count the
 * window could not measure (installs before the install fix) says so instead of reading 0. */
export const RELEASE_BEFORE_AFTER: CardSpec = {
  v: 1,
  sections: [
    {
      layout: 'rows',
      items: [
        { id: 'release', label: { note: 'label.card.release' }, data: { field: 'release.label' }, display: { as: 'text' }, gating: { whenEmpty: { note: 'release-none' } } },
        { id: 'days', label: { metric: true }, data: { metric: 'release.windowDays', window: 'after' }, display: { as: 'number' }, gating: { whenUnmeasured: 'label' }, ...COMPACT },
      ],
    },
    {
      layout: 'table',
      columns: { over: 'windows', ids: ['before', 'after'] },
      items: [
        { id: 'pageviews', label: { metric: true }, data: { metric: 'bsk.pageviews', window: { scope: 'window' } }, display: { as: 'number' }, gating: { whenUnmeasured: 'label' }, ...COMPACT },
        { id: 'arrivals', label: { metric: true }, data: { metric: 'bsk.taggedArrivals', window: { scope: 'window' } }, display: { as: 'number' }, gating: { whenUnmeasured: 'label' }, ...COMPACT },
        { id: 'auth', label: { metric: true }, data: { metric: 'bsk.authSuccess', window: { scope: 'window' } }, display: { as: 'number' }, gating: { whenUnmeasured: 'label' }, ...COMPACT },
        { id: 'installs', label: { metric: true }, data: { metric: 'bsk.installs', window: { scope: 'window' } }, display: { as: 'number' }, gating: { whenUnmeasured: 'label' }, ...COMPACT },
      ],
    },
  ],
  captions: ['release-before-partial'],
}

/** The Pop-ups page's rate table (type 'rateTable'): the VALID pop-up rates only (lib/popupEvents.ts
 * POPUP_RATE_TABLE_KEYS) — each pop-up's taps over its showings, and the install prompt's
 * "installed" outcome over the prompts shown from the install fix on — each with its (n/d) and
 * "too few to report" under MIN_COHORT. Over the page's date range, sites and own-visit filter. */
export const POPUP_RATES: CardSpec = {
  v: 1,
  sections: [
    {
      layout: 'rows',
      items: [
        {
          id: 'tap',
          label: { note: 'label.card.popupTapRate', vars: { popup: 'popup.label' } },
          data: { ratio: 'popup.tapRate', window: 'page' },
          display: { as: 'percent', decimals: 1 },
          repeat: { over: 'popups' },
          ...COMPACT,
        },
        {
          id: 'installed',
          label: { note: 'label.card.installedRateFromFix' },
          data: { ratio: 'popup.installedRate', params: { popup: 'install' }, window: 'page' },
          display: { as: 'percent', decimals: 1 },
          ...COMPACT,
        },
      ],
    },
  ],
}

/** Sign-in eligibility (the Pop-ups page's 'eligible' chart): signed-out finishes that earned a
 * sign-in ask, hit the cap, or did not earn one, as bars, and the eligibility rate (earned over
 * all three, a partition). Its caveat (rows arrive at least 30 minutes after the finish) is the
 * widget's own caption, as before. */
export const SIGNIN_ELIGIBILITY: CardSpec = {
  v: 1,
  sections: [
    {
      layout: 'bars',
      items: [
        { id: 'earned', label: { note: 'label.card.eligible.earned' }, data: { metric: 'popup.eligibleEarned', window: 'page' }, display: { as: 'bar' }, ...COMPACT },
        { id: 'capped', label: { note: 'label.card.eligible.capped' }, data: { metric: 'popup.eligibleCapped', window: 'page' }, display: { as: 'bar' }, ...COMPACT },
        { id: 'unearned', label: { note: 'label.card.eligible.unearned' }, data: { metric: 'popup.eligibleUnearned', window: 'page' }, display: { as: 'bar' }, ...COMPACT },
      ],
    },
    {
      layout: 'rows',
      items: [{ id: 'rate', label: { metric: true }, data: { ratio: 'popup.eligibility', window: 'page' }, display: { as: 'percent', decimals: 1 }, ...COMPACT }],
    },
  ],
}

/** Cost per arrival / auth success (CampaignsWidgetBody 'cost'): one card per campaign, spend-only
 * ones included (their spend is real; the section title says why nothing else is measured), with
 * the ads store's figures — spend, where it came from, how far it is stored and when it last
 * synced (a "stale" line while a closed day is missing) — and the two costs. The card's action
 * asks the ads sync for fresh spend and reloads the card once one ran. */
export const CAMPAIGN_COST: CardSpec = {
  v: 1,
  repeat: { over: 'campaigns' },
  minWidth: 230,
  title: { bind: 'campaign.label' },
  actions: ['ads-refresh'],
  sections: [
    {
      layout: 'rows',
      title: { bind: 'campaign.measurabilityNote' },
      items: [
        { id: 'spend', label: { metric: true }, data: { metric: 'campaign.spend' }, display: { as: 'currency' }, ...COMPACT },
        { id: 'source', label: { metric: true }, data: { metric: 'campaign.spendSource' }, display: { as: 'status' }, ...COMPACT },
        // Inline on purpose: "stale — sync pending" stays visible under the date, as it was.
        { id: 'through', label: { metric: true }, data: { metric: 'campaign.spendThrough' }, display: { as: 'date' }, gating: { whenEmpty: { note: 'no-spend-day-yet' } }, captionMode: 'inline' },
        { id: 'synced', label: { metric: true }, data: { metric: 'campaign.lastSync' }, display: { as: 'ago' }, gating: { whenEmpty: { note: 'not-synced-yet' } }, ...COMPACT },
        { id: 'cpa', label: { note: 'label.card.perArrival' }, data: { ratio: 'campaign.costPerArrival' }, display: { as: 'currency' }, ...COMPACT },
        { id: 'cps', label: { note: 'label.card.perAuthSuccess' }, data: { ratio: 'campaign.costPerSignin' }, display: { as: 'currency' }, ...COMPACT },
      ],
    },
  ],
}

/** The funnel per campaign (CampaignsWidgetBody 'funnel'): one card per beacon-tracked campaign,
 * its tagged hits read against its arrivals (counts, never a rate), the raw install signals, every
 * funnel step as a bar (counts: most step-over-step "rates" mix units), and the two proportions
 * the rate rule allows — accept over asks, and install over the prompts shown from the install fix
 * on. A closed flight omits what it could not measure; an active one keeps a not-yet-seen step at
 * its live count. Last, the signed-out upsell fix as a funnel segment boundary: tagged upsell
 * shown/accepted/dismissed before and after it, which appears only once lib/adsRules.ts
 * UPSELL_SIGNEDOUT_FIX_AT is set and falls in the campaign's flight (the boundaryInFlight rule). */
export const CAMPAIGN_FUNNEL: CardSpec = {
  v: 1,
  repeat: { over: 'campaigns', tracked: true },
  minWidth: 230,
  title: { bind: 'campaign.label' },
  badge: { data: { field: 'campaign.status' }, display: { as: 'badge' } },
  sections: [
    {
      layout: 'rows',
      items: [
        { id: 'hits', label: { metric: true }, data: { ratio: 'campaign.taggedHitsVsArrivals' }, display: { as: 'counts' }, ...COMPACT },
        { id: 'raw', label: { metric: true }, data: { metric: 'campaign.rawInstallSignals' }, display: { as: 'number' }, ...COMPACT },
      ],
    },
    {
      layout: 'bars',
      items: [
        { id: 'arrivals', label: { note: 'label.funnel.arrivals' }, data: { metric: 'campaign.taggedArrivals' }, display: { as: 'bar' }, ...COMPACT },
        { id: 'played', label: { note: 'label.campaign.gameViews' }, data: { metric: 'campaign.gameViews' }, display: { as: 'bar' }, ...COMPACT },
        { id: 'completed', label: { note: 'label.funnel.completed' }, data: { metric: 'campaign.completions' }, display: { as: 'bar' }, ...COMPACT },
        { id: 'ask', label: { note: 'label.funnel.ask' }, data: { metric: 'campaign.asks' }, display: { as: 'bar' }, ...COMPACT },
        { id: 'accept', label: { note: 'label.funnel.accept' }, data: { metric: 'campaign.accepts' }, display: { as: 'bar' }, ...COMPACT },
        { id: 'authSuccess', label: { note: 'label.funnel.authSuccess' }, data: { metric: 'campaign.authSuccess' }, display: { as: 'bar' }, ...COMPACT },
        { id: 'installPrompt', label: { note: 'label.funnel.installPrompt' }, data: { metric: 'campaign.installPrompts' }, display: { as: 'bar' }, ...COMPACT },
        { id: 'install', label: { note: 'label.funnel.install' }, data: { metric: 'campaign.installs' }, display: { as: 'bar' }, ...COMPACT },
      ],
    },
    {
      layout: 'pills',
      items: [
        { id: 'acceptRate', label: { note: 'label.card.acceptOfAsks' }, data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'percent', decimals: 1 }, ...COMPACT },
        { id: 'installRate', label: { note: 'label.card.installOfPrompts' }, data: { ratio: 'campaign.installPerPrompt' }, display: { as: 'percent', decimals: 1 }, ...COMPACT },
      ],
    },
    {
      layout: 'table',
      title: { note: 'label.card.upsellSegment', vars: { at: 'campaign.upsellFixAt', day: 'campaign.upsellFixFlightDay' } },
      repeat: { over: 'windows', ids: ['upsellPre', 'upsellPost'] },
      items: [
        { id: 'side', label: { note: 'label.card.taggedUpsell' }, data: { field: 'window.label' }, display: { as: 'text' } },
        { id: 'shown', label: { note: 'label.card.shown' }, data: { metric: 'campaign.upsellShown', window: { scope: 'window' } }, display: { as: 'number' }, gating: { whenUnmeasured: 'omit' }, ...COMPACT },
        { id: 'accepted', label: { note: 'label.card.accepted' }, data: { metric: 'campaign.upsellAccepts', window: { scope: 'window' } }, display: { as: 'number' }, gating: { whenUnmeasured: 'omit' }, ...COMPACT },
        { id: 'dismissed', label: { note: 'label.card.dismissed' }, data: { metric: 'campaign.upsellDismisses', window: { scope: 'window' } }, display: { as: 'number' }, gating: { whenUnmeasured: 'omit' }, ...COMPACT },
      ],
    },
  ],
}

/** Arrivals and funnel by country (CampaignsWidgetBody 'country'): one card per beacon-tracked
 * campaign, a table with its funnel steps as rows and US / CA / Other as columns — every cell a
 * campaign metric split by the campaign fact's country bucket. A closed flight omits a step it
 * could not measure (every cell gated out drops the row). */
export const CAMPAIGN_COUNTRY: CardSpec = {
  v: 1,
  repeat: { over: 'campaigns', tracked: true },
  minWidth: 230,
  title: { bind: 'campaign.label' },
  sections: [
    {
      layout: 'table',
      columns: { over: 'countries' },
      rowsLabel: { note: 'label.card.step' },
      items: [
        { id: 'arrivals', label: { note: 'label.funnel.arrivals' }, data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' }, ...COMPACT },
        { id: 'played', label: { note: 'label.campaign.gameViews' }, data: { metric: 'campaign.gameViews' }, display: { as: 'number' }, ...COMPACT },
        { id: 'completed', label: { note: 'label.funnel.completed' }, data: { metric: 'campaign.completions' }, display: { as: 'number' }, ...COMPACT },
        { id: 'ask', label: { note: 'label.funnel.ask' }, data: { metric: 'campaign.asks' }, display: { as: 'number' }, ...COMPACT },
        { id: 'accept', label: { note: 'label.funnel.accept' }, data: { metric: 'campaign.accepts' }, display: { as: 'number' }, ...COMPACT },
        { id: 'authSuccess', label: { note: 'label.funnel.authSuccess' }, data: { metric: 'campaign.authSuccess' }, display: { as: 'number' }, ...COMPACT },
        { id: 'installPrompt', label: { note: 'label.funnel.installPrompt' }, data: { metric: 'campaign.installPrompts' }, display: { as: 'number' }, ...COMPACT },
        { id: 'install', label: { note: 'label.funnel.install' }, data: { metric: 'campaign.installs' }, display: { as: 'number' }, ...COMPACT },
      ],
    },
  ],
}

/** Every preset by id. A null prototype, so an id such as 'constructor' or 'toString' is
 * simply not a preset — read through presetById, never a bare bracket lookup. */
export const PRESETS: Readonly<Record<string, CardSpec>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, CardSpec>, {
    'campaign-scorecard': CAMPAIGN_SCORECARD,
    'bsk-kpis': BSK_KPIS,
    'release-before-after': RELEASE_BEFORE_AFTER,
    'popup-rates': POPUP_RATES,
    'signin-eligibility': SIGNIN_ELIGIBILITY,
    'campaign-cost': CAMPAIGN_COST,
    'campaign-funnel': CAMPAIGN_FUNNEL,
    'campaign-country': CAMPAIGN_COUNTRY,
  }),
)

/** The preset with this id, or undefined — own properties only (a saved `card.preset` is
 * data from KV, so it can be any string). */
export function presetById(id: unknown): CardSpec | undefined {
  return typeof id === 'string' && Object.hasOwn(PRESETS, id) ? PRESETS[id] : undefined
}
