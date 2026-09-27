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
// items' own captions use captionMode 'compact': a notes toggle next to the label, collapsed by
// default, so the cards keep their compact look.

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
  showUpdated: true,
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
        { id: 'installRaw', label: { metric: true }, data: { metric: 'bsk.rawInstallSignals', window: 'todaySoFar' }, display: TODAY, ...COMPACT },
        { id: 'returns', label: { metric: true }, data: { metric: 'bsk.returnsD1plus', window: 'todaySoFar' }, display: TODAY, caption: { note: 'returns-d1plus-caveat' }, ...COMPACT },
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
  }),
)

/** The preset with this id, or undefined — own properties only (a saved `card.preset` is
 * data from KV, so it can be any string). */
export function presetById(id: unknown): CardSpec | undefined {
  return typeof id === 'string' && Object.hasOwn(PRESETS, id) ? PRESETS[id] : undefined
}
