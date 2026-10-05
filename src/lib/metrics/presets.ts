// Code-reviewed card presets (ADR 0003 section 1). A widget stores `card: { preset }`, so an
// improvement here reaches every widget that has not been customized. validate.test.ts runs
// validateCard over every one, and presets.parity.test.ts / slice7.parity.test.ts compare each
// with the retired bespoke panel it replaced (a golden of its rendering on the same fixture).
//
// Each preset reproduces what the retired panel showed, with only the documented changes: the ratio rule (a count or a pair
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
/** An upcoming flight's funnel steps: kept, reading "not started" (compact captions). */
const NOT_STARTED_LABEL = { ...COMPACT, gating: { whenNotStarted: 'label' } } as const satisfies Partial<MetricItem>

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
        // The new/existing/unknown split (A2, review round 2026-09-27): 'new' is the exact
        // sign-up count the current ad flight is judged on. Gated on the 19:43:02Z go-live
        // (lib/metrics/metrics.ts AUTH_NEW_EXISTING) — a range reaching back before it reads
        // "counted from 2026-09-26 15:43 ET" instead of a false zero. Counts only, next to the
        // base Auth successes tile above.
        { id: 'authSuccessNew', label: { metric: true }, data: { metric: 'bsk.authSuccessNew', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'authSuccessExisting', label: { metric: true }, data: { metric: 'bsk.authSuccessExisting', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'authSuccessUnknown', label: { metric: true }, data: { metric: 'bsk.authSuccessUnknown', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'authErrors', label: { metric: true }, data: { metric: 'bsk.authErrors', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'authRedirects', label: { metric: true }, data: { metric: 'bsk.authRedirects', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'tutorialFirstRun', label: { metric: true }, data: { metric: 'bsk.tutorialFirstRun', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'tutorialReplay', label: { metric: true }, data: { metric: 'bsk.tutorialReplay', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'tourExitPreamble', label: { metric: true }, data: { metric: 'bsk.tourExitPreamble', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'tourExitHub', label: { metric: true }, data: { metric: 'bsk.tourExitHub', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'tourExitSection', label: { metric: true }, data: { metric: 'bsk.tourExitSection', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'install', label: { metric: true }, data: { metric: 'bsk.installs', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'installRaw', label: { metric: true }, data: { metric: 'bsk.rawInstallSignals', window: 'todaySoFar' }, display: TODAY, caption: { note: 'raw-install-double-count' }, ...COMPACT },
        { id: 'returns', label: { metric: true }, data: { metric: 'bsk.returnsD1plus', window: 'todaySoFar' }, display: TODAY, caption: { note: 'returns-d1plus-caveat' }, ...COMPACT },
      ],
    },
  ],
}

/** The release panel (OverviewWidgetBody 'releasePanel'): the compared release, how many
 * days each side covers, and a table of the four counts with Before and After as its columns.
 * Each window is `days` whole ET days: Before ends at the release date's ET midnight, After
 * starts the ET midnight after the release date (the release day itself is in neither side),
 * bounded by the first Best Sudoku hit and by today (lib/overview.ts releaseComparisonWindows). A count the
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
        // Counts, not rates — signed-in/returned/still-playing are lagged cohorts (see this
        // file's header comment on the rate-validity rule), so unlike 'installed' above they
        // never get a percentage here; the per-outcome breakdown already lives in the 'pu-bars'
        // breakdown chart (popupFamily x popupOutcome), but that chart draws nothing when a
        // combination has zero rows — indistinguishable from "not wired up" (A2's hard
        // requirement). These three rows give every pop-up an explicit-zero, gated exactly like
        // every other counted tile on this page (whenUnmeasured reads "counted from", never a
        // blank or a hidden row) — added 2026-09-27, review round for PR #21.
        {
          id: 'signedIn',
          label: { note: 'label.card.popupOutcomeSignedIn', vars: { popup: 'popup.label' } },
          data: { metric: 'popup.outcomeSignedIn', window: 'page' },
          display: { as: 'number' },
          repeat: { over: 'popups' },
          ...COMPACT,
        },
        {
          id: 'returned',
          label: { note: 'label.card.popupOutcomeReturned', vars: { popup: 'popup.label' } },
          data: { metric: 'popup.outcomeReturned', window: 'page' },
          display: { as: 'number' },
          repeat: { over: 'popups' },
          ...COMPACT,
        },
        {
          id: 'stillPlaying',
          label: { note: 'label.card.popupOutcomeStillPlaying', vars: { popup: 'popup.label' } },
          data: { metric: 'popup.outcomeStillPlaying', window: 'page' },
          display: { as: 'number' },
          repeat: { over: 'popups' },
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
 * its live count; an upcoming one (no start date yet, or before its start) shows Arrivals 0 and
 * every other step "not started" (whenNotStarted), as the old panel did. Last, the signed-out upsell fix as a funnel segment boundary: tagged upsell
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
        { id: 'hits', label: { metric: true }, data: { ratio: 'campaign.taggedHitsVsArrivals' }, display: { as: 'counts' }, ...NOT_STARTED_LABEL },
        { id: 'raw', label: { metric: true }, data: { metric: 'campaign.rawInstallSignals' }, display: { as: 'number' }, ...NOT_STARTED_LABEL },
      ],
    },
    {
      layout: 'bars',
      items: [
        { id: 'arrivals', label: { note: 'label.funnel.arrivals' }, data: { metric: 'campaign.taggedArrivals' }, display: { as: 'bar' }, ...COMPACT, gating: { whenNotStarted: 'zero' } },
        { id: 'played', label: { note: 'label.campaign.gameViews' }, data: { metric: 'campaign.gameViews' }, display: { as: 'bar' }, ...NOT_STARTED_LABEL },
        { id: 'completed', label: { note: 'label.funnel.completed' }, data: { metric: 'campaign.completions' }, display: { as: 'bar' }, ...NOT_STARTED_LABEL },
        { id: 'ask', label: { note: 'label.funnel.ask' }, data: { metric: 'campaign.asks' }, display: { as: 'bar' }, ...NOT_STARTED_LABEL },
        { id: 'accept', label: { note: 'label.funnel.accept' }, data: { metric: 'campaign.accepts' }, display: { as: 'bar' }, ...NOT_STARTED_LABEL },
        { id: 'authSuccess', label: { note: 'label.funnel.authSuccess' }, data: { metric: 'campaign.authSuccess' }, display: { as: 'bar' }, ...NOT_STARTED_LABEL },
        { id: 'installPrompt', label: { note: 'label.funnel.installPrompt' }, data: { metric: 'campaign.installPrompts' }, display: { as: 'bar' }, ...NOT_STARTED_LABEL },
        { id: 'install', label: { note: 'label.funnel.install' }, data: { metric: 'campaign.installs' }, display: { as: 'bar' }, ...NOT_STARTED_LABEL },
      ],
    },
    {
      layout: 'pills',
      items: [
        { id: 'acceptRate', label: { note: 'label.card.acceptOfAsks' }, data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'percent', decimals: 1 }, ...NOT_STARTED_LABEL },
        { id: 'installRate', label: { note: 'label.card.installOfPrompts' }, data: { ratio: 'campaign.installPerPrompt' }, display: { as: 'percent', decimals: 1 }, ...NOT_STARTED_LABEL },
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
 * could not measure (every cell gated out drops the row); an upcoming one shows every cell "not
 * started" (whenNotStarted). Completed games are not a row: the counts-only rule
 * (lib/splitGuard.ts) never splits a completion by place, and the caption says the country
 * columns leave out return and completion rows. */
export const CAMPAIGN_COUNTRY: CardSpec = {
  v: 1,
  repeat: { over: 'campaigns', tracked: true },
  minWidth: 230,
  title: { bind: 'campaign.label' },
  captions: ['country-split-excludes-refused'],
  sections: [
    {
      layout: 'table',
      columns: { over: 'countries' },
      rowsLabel: { note: 'label.card.step' },
      items: [
        { id: 'arrivals', label: { note: 'label.funnel.arrivals' }, data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' }, ...NOT_STARTED_LABEL },
        { id: 'played', label: { note: 'label.campaign.gameViews' }, data: { metric: 'campaign.gameViews' }, display: { as: 'number' }, ...NOT_STARTED_LABEL },
        { id: 'ask', label: { note: 'label.funnel.ask' }, data: { metric: 'campaign.asks' }, display: { as: 'number' }, ...NOT_STARTED_LABEL },
        { id: 'accept', label: { note: 'label.funnel.accept' }, data: { metric: 'campaign.accepts' }, display: { as: 'number' }, ...NOT_STARTED_LABEL },
        { id: 'authSuccess', label: { note: 'label.funnel.authSuccess' }, data: { metric: 'campaign.authSuccess' }, display: { as: 'number' }, ...NOT_STARTED_LABEL },
        { id: 'installPrompt', label: { note: 'label.funnel.installPrompt' }, data: { metric: 'campaign.installPrompts' }, display: { as: 'number' }, ...NOT_STARTED_LABEL },
        { id: 'install', label: { note: 'label.funnel.install' }, data: { metric: 'campaign.installs' }, display: { as: 'number' }, ...NOT_STARTED_LABEL },
      ],
    },
  ],
}

/** Return visits (CampaignsWidgetBody 'returns'): one card per beacon-tracked campaign with return
 * beacons, its first tagged loads (d0) and the return rate of each later window (dN over d0, the
 * device-deduplicated beacon's own buckets) as bars side by side, d1 to d31-60, each with its
 * (n/d): the old curve. A flight that ended before the return beacon existed (closed, unmeasured)
 * and a campaign with no return beacons yet (d0 = 0) are left out; with none left, one line says
 * so. A lagged rate is provisional ("still arriving", in the card's Notes). After the campaigns
 * comes the web-only organic baseline ("Organic (web)": untagged fresh installs on the web site),
 * hidden the same way until its first d0 row arrives. */
const RETURN_BUCKETS_ITEMS: { id: string; ratio: string }[] = [
  { id: 'd1', ratio: 'campaign.returnD1PerD0' },
  { id: 'd2-7', ratio: 'campaign.returnD2to7PerD0' },
  { id: 'd8-14', ratio: 'campaign.returnD8to14PerD0' },
  { id: 'd15-30', ratio: 'campaign.returnD15to30PerD0' },
  { id: 'd31-60', ratio: 'campaign.returnD31to60PerD0' },
]
export const CAMPAIGN_RETURNS: CardSpec = {
  v: 1,
  repeat: { over: 'campaigns', tracked: true, organic: true, empty: { label: '', text: { note: 'no-return-visits-yet' } } },
  minWidth: 230,
  title: { bind: 'campaign.label' },
  sections: [
    {
      layout: 'rows',
      items: [
        { id: 'shared', label: { note: 'label.card.returnTag' }, data: { field: 'campaign.returnTagShared' }, display: { as: 'text' }, gating: { whenEmpty: 'omit' } },
        { id: 'd0', label: { metric: true }, data: { metric: 'campaign.returnD0' }, display: { as: 'number' }, gating: { whenZero: 'omit' }, ...COMPACT },
      ],
    },
    {
      layout: 'columns',
      items: RETURN_BUCKETS_ITEMS.map(({ id, ratio }) => ({
        id,
        label: { note: `label.card.return.${id}` },
        data: { ratio },
        display: { as: 'bar' as const },
        gating: { whenEmpty: 'omit' as const },
        ...COMPACT,
      })),
    },
  ],
}

/** The retention verdict (retention spec section 4): one table row per beacon-tracked campaign arm,
 * then the web-only organic baseline. Each row: the verdict, the days 2-7 return rate (R2-7) with its
 * 90% Wilson bounds and (n/d), its first tagged loads (d0), and games completed per arrival (E1).
 * The organic row has no verdict and no E1 (bindings that don't serve it are left out of its
 * instance); its rate is its matured cohort, the baseline the bar is set from. Counts only: no
 * hour, place or device split, and the R2-7 figures and the verdict carry the disjoint-groups and
 * lower-bound caveats (behind each cell's Notes). Offered in the picker only, never a default. */
export const RETENTION_VERDICT: CardSpec = {
  v: 1,
  minWidth: 230,
  sections: [
    {
      layout: 'table',
      repeat: { over: 'campaigns', tracked: true, organic: true, empty: { label: '', text: { note: 'no-return-visits-yet' } } },
      items: [
        { id: 'arm', label: { note: 'label.card.arm' }, data: { field: 'campaign.label' }, display: { as: 'text' } },
        { id: 'verdict', label: { metric: true }, data: { metric: 'campaign.retentionVerdict' }, display: { as: 'status' }, ...COMPACT },
        { id: 'rate', label: { metric: true }, data: { metric: 'campaign.returnD2to7Rate' }, display: { as: 'percent', decimals: 1 }, ...COMPACT },
        { id: 'lower', label: { metric: true }, data: { metric: 'campaign.returnD2to7Lower' }, display: { as: 'percent', decimals: 1 }, ...COMPACT },
        { id: 'upper', label: { metric: true }, data: { metric: 'campaign.returnD2to7Upper' }, display: { as: 'percent', decimals: 1 }, ...COMPACT },
        { id: 'd0', label: { note: 'label.card.arrivals-d0' }, data: { metric: 'campaign.returnD0' }, display: { as: 'number' }, ...COMPACT },
        { id: 'engagement', label: { metric: true }, data: { ratio: 'campaign.engagementPerArrival' }, display: { as: 'number' }, ...COMPACT },
      ],
    },
  ],
}

/** Engagement per arrival (E1): one card per beacon-tracked campaign, completed games over first
 * tagged loads, with the two counts it is made of. A plain number that can exceed 1 (it counts
 * games, not devices), never a percentage. Counts only; picker only, never a default. */
export const CAMPAIGN_ENGAGEMENT: CardSpec = {
  v: 1,
  repeat: { over: 'campaigns', tracked: true, empty: { label: '', text: { note: 'no-return-visits-yet' } } },
  minWidth: 230,
  title: { bind: 'campaign.label' },
  sections: [
    {
      layout: 'rows',
      items: [
        { id: 'engagement', label: { metric: true }, data: { ratio: 'campaign.engagementPerArrival' }, display: { as: 'number' }, ...COMPACT },
        { id: 'completions', label: { metric: true }, data: { metric: 'campaign.completions' }, display: { as: 'number' }, ...COMPACT },
        { id: 'd0', label: { metric: true }, data: { metric: 'campaign.returnD0' }, display: { as: 'number' }, ...COMPACT },
      ],
    },
  ],
}

/** The ads-read routine's readings log (the bespoke Ads readings widget, ADR 0005 slice 3): one
 * card per campaign that has something to show (a stored reading, Ads-API spend or an active
 * flight; a widget's campaign selection names its own), each with its spend and where it came
 * from, how fresh the stored data is, the thresholds it fired and the readings table — newest
 * first, at most 30 by default (RepeatSpec.limit, 500 at most). Its action syncs spend now and
 * reloads the card. The notices carry the store's warnings, the small-numbers note and sync
 * alerts. Not compact captions: a card's notes are built once, before the readings arrive.
 *
 * PRIVACY ("counts only. Never tie beacon rows to a device, time or place", read as rows only):
 * a reading is a stored aggregate with its own read time. The table binds ONLY the five
 * allow-listed counts (types.ts READING_COUNT_FIELDS) and the derived sign-ups; no return,
 * game-start, tutorial or tour total, and no hour, place or device split. */
export const ADS_READINGS_LOG: CardSpec = {
  v: 1,
  repeat: { over: 'campaigns', withActivity: true, empty: { label: '', text: { note: 'no-ads-campaign' } } },
  minWidth: 520,
  title: { bind: 'campaign.label' },
  actions: ['ads-refresh'],
  notices: 'ads-readings',
  sections: [
    {
      layout: 'rows',
      items: [
        { id: 'spend', label: { metric: true }, data: { metric: 'campaign.spend' }, display: { as: 'currency' } },
        { id: 'source', label: { metric: true }, data: { metric: 'campaign.spendSource' }, display: { as: 'status' } },
        { id: 'fresh', label: { note: 'label.card.freshness' }, data: { field: 'campaign.freshness' }, display: { as: 'text' }, gating: { whenEmpty: 'omit' } },
      ],
    },
    {
      layout: 'pills',
      items: [{ id: 'fired', label: { note: 'label.card.firedThresholds' }, data: { field: 'campaign.thresholds' }, display: { as: 'text' }, gating: { whenEmpty: 'omit' } }],
    },
    {
      layout: 'table',
      repeat: { over: 'readings', limit: 30, empty: { label: '', text: { note: 'no-readings-yet' } } },
      items: [
        { id: 'read', label: { note: 'label.reading.read' }, data: { field: 'reading.readAt' }, display: { as: 'datetime-et' } },
        { id: 'kind', label: { note: 'label.reading.kind' }, data: { field: 'reading.kind' }, display: { as: 'text' } },
        { id: 'spend', label: { note: 'label.campaign.spend' }, data: { field: 'reading.spend' }, display: { as: 'currency' } },
        { id: 'rules', label: { note: 'label.reading.rules' }, data: { field: 'reading.rules' }, display: { as: 'text' } },
        { id: 'proposal', label: { note: 'label.reading.proposal' }, data: { field: 'reading.proposal' }, display: { as: 'text' } },
        { id: 'arrivals', label: { note: 'label.funnel.arrivals' }, data: { field: 'reading.count.arrivals' }, display: { as: 'number' } },
        { id: 'asks', label: { note: 'label.reading.asks' }, data: { field: 'reading.count.asks' }, display: { as: 'number' } },
        { id: 'accepts', label: { note: 'label.reading.accepts' }, data: { field: 'reading.count.accepts' }, display: { as: 'number' } },
        { id: 'auth', label: { note: 'label.reading.auth' }, data: { field: 'reading.count.auth' }, display: { as: 'number' } },
        { id: 'signUps', label: { note: 'label.reading.signUps' }, hint: { note: 'label.reading.signUpsHint' }, data: { field: 'reading.count.signUps' }, display: { as: 'text' } },
      ],
    },
  ],
}

/** Google Play's own install totals (retention build R-4): device installs and uninstalls over the
 * page's date range, the latest active device installs in it, and how far Play's data runs. Whole-app
 * counts by PLAY day (as Google reports them, not confirmed ET days), synced by `npm run
 * ads:play-sync` into the ads store; the page's date range applies, its sites and own-visits
 * filters do not. No ratio (installs and uninstalls are different things, and active is a stock);
 * no retention (Play's bulk reports have none). Each tile reads "no Play figures stored yet" until
 * the first sync, and the card never errors when the table is missing. Counts only. */
export const PLAY_INSTALLS: CardSpec = {
  v: 1,
  minWidth: 230,
  sections: [
    {
      layout: 'tiles',
      items: [
        { id: 'installs', label: { metric: true }, data: { metric: 'play.deviceInstalls', window: 'page' }, display: { as: 'number' }, gating: { whenEmpty: { note: 'play-not-synced-yet' } }, ...COMPACT },
        { id: 'uninstalls', label: { metric: true }, data: { metric: 'play.deviceUninstalls', window: 'page' }, display: { as: 'number' }, gating: { whenEmpty: { note: 'play-not-synced-yet' } }, ...COMPACT },
        { id: 'active', label: { metric: true }, data: { metric: 'play.activeDeviceInstalls', window: 'page' }, display: { as: 'number' }, gating: { whenEmpty: { note: 'play-not-synced-yet' } }, caption: { note: 'play-active-is-stock' }, captionMode: 'compact' },
        { id: 'through', label: { metric: true }, data: { metric: 'play.dataThrough', window: 'page' }, display: { as: 'date' }, gating: { whenEmpty: { note: 'play-not-synced-yet' } }, ...COMPACT },
      ],
    },
  ],
  captions: ['play-days', 'play-household', 'play-no-retention'],
}

/** Carry-over completions (retention spec S1): game completions per ET day with no campaign tag
 * (mostly returning players; the tag lasts 30 minutes, so some are ad-acquired), beside the site-wide total over the page's range.
 * Whole-ET-day counts only: no hour, place or device split, no clock time, no visitor grouping. The
 * card's caption says it is a weak signal. */
export const CARRY_OVER_COMPLETIONS: CardSpec = {
  v: 1,
  minWidth: 230,
  sections: [
    {
      layout: 'tiles',
      items: [
        { id: 'sitewide', label: { metric: true }, data: { metric: 'bsk.completions', window: 'page' }, display: { as: 'number' }, ...COMPACT },
        { id: 'carry', label: { metric: true }, data: { metric: 'bsk.carryOverCompletions', window: 'page' }, display: { as: 'sparkline', series: 'daily' }, ...COMPACT },
      ],
    },
  ],
  captions: ['carry-over-weak-signal'],
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
    'campaign-returns': CAMPAIGN_RETURNS,
    'retention-verdict': RETENTION_VERDICT,
    'campaign-engagement': CAMPAIGN_ENGAGEMENT,
    'ads-readings-log': ADS_READINGS_LOG,
    'play-installs': PLAY_INSTALLS,
    'carry-over-completions': CARRY_OVER_COMPLETIONS,
  }),
)

/** The preset with this id, or undefined — own properties only (a saved `card.preset` is
 * data from KV, so it can be any string). */
export function presetById(id: unknown): CardSpec | undefined {
  return typeof id === 'string' && Object.hasOwn(PRESETS, id) ? PRESETS[id] : undefined
}
