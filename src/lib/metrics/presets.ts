// Code-reviewed card presets (ADR 0003 section 1). A widget stores `card: { preset }`, so an
// improvement here reaches every widget that has not been customized. These are the ADR's
// two worked examples; slice 5 wires them to widgets (normCardRef, the v8 migration) and checks
// them for parity with the bespoke bodies. validate.test.ts runs validateCard over every one.

import type { CardSpec, Display } from './types'

/** The Overview campaign scorecard: one card per campaign. */
export const CAMPAIGN_SCORECARD: CardSpec = {
  v: 1,
  repeat: { over: 'campaigns' },
  link: 'campaigns-page',
  minWidth: 230,
  title: { bind: 'campaign.label' },
  badge: { data: { field: 'campaign.statusToday' }, display: { as: 'badge', tones: { 'flighting today': 'live' } } },
  sections: [
    {
      layout: 'rows',
      items: [
        { id: 'flight', label: 'Flight', data: { field: 'campaign.flight' }, display: { as: 'dateRange', days: true }, gating: { whenEmpty: { note: 'flight-pending' } } },
        { id: 'arrivals', label: { metric: true }, data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } },
        { id: 'auth', label: { metric: true }, data: { metric: 'campaign.authSuccess' }, display: { as: 'number' } },
        { id: 'installs', label: { metric: true }, data: { metric: 'campaign.installs' }, display: { as: 'number' } },
        { id: 'return', label: { metric: true }, data: { ratio: 'campaign.returnD2to7PerD0' }, display: { as: 'percent', decimals: 1 } },
        { id: 'cpa', label: { metric: true }, data: { ratio: 'campaign.costPerArrival' }, display: { as: 'currency' } },
      ],
    },
    {
      layout: 'pills',
      items: [
        { id: 'played', label: { note: 'label.campaign.gameViews' }, data: { ratio: 'campaign.gameViewsVsArrivals' }, display: { as: 'counts' } },
        { id: 'completed', label: { metric: true }, data: { metric: 'campaign.completions' }, display: { as: 'number' } },
        { id: 'asks', label: { metric: true }, data: { metric: 'campaign.asks' }, display: { as: 'number' } },
        { id: 'accept', label: { metric: true }, data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'percent', decimals: 1 } },
        { id: 'signedIn', label: { metric: true }, data: { ratio: 'campaign.signedInPerAsk' }, display: { as: 'percent', decimals: 1 } },
        { id: 'prompts', label: { metric: true }, data: { metric: 'campaign.installPrompts' }, display: { as: 'number' } },
        { id: 'install', label: { metric: true }, data: { ratio: 'campaign.installPerPrompt' }, display: { as: 'percent', decimals: 1 } },
      ],
    },
  ],
}

const TODAY: Display = { as: 'number', deltas: ['yesterday', 'avg7'] }

/** "Today at a glance": one tiles section; the arrivals tile repeats per flighting campaign. */
export const BSK_KPIS: CardSpec = {
  v: 1,
  sections: [
    {
      layout: 'tiles',
      items: [
        { id: 'pv', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: TODAY },
        {
          id: 'arrivals',
          label: 'Tagged arrivals — {campaign.label}',
          data: { metric: 'campaign.taggedArrivals', window: 'todaySoFar' },
          display: TODAY,
          repeat: { over: 'campaigns', flightingToday: true, empty: { label: { note: 'label.campaign.taggedArrivals' }, text: { note: 'no-campaign-flighting' } } },
          caption: { note: 'arrivals-caveat' },
        },
        { id: 'gameViews', label: { metric: true }, data: { metric: 'bsk.gameViews', window: 'todaySoFar' }, display: TODAY },
        { id: 'completed', label: { metric: true }, data: { metric: 'bsk.completions', window: 'todaySoFar' }, display: TODAY },
        { id: 'popupShown', label: { metric: true }, data: { metric: 'bsk.popupShown', window: 'todaySoFar' }, display: TODAY },
        { id: 'popupAccept', label: { metric: true }, data: { metric: 'bsk.popupAccepts', window: 'todaySoFar' }, display: TODAY },
        { id: 'tap', label: { metric: true }, data: { ratio: 'bsk.popupTapRate', window: 'todaySoFar' }, display: { as: 'percent', decimals: 1 } },
        { id: 'auth', label: { metric: true }, data: { metric: 'bsk.authSuccess', window: 'todaySoFar' }, display: TODAY },
        { id: 'install', label: { metric: true }, data: { metric: 'bsk.installs', window: 'todaySoFar' }, display: TODAY },
        { id: 'installRaw', label: { metric: true }, data: { metric: 'bsk.rawInstallSignals', window: 'todaySoFar' }, display: TODAY },
        { id: 'returns', label: { metric: true }, data: { metric: 'bsk.returnsD1plus', window: 'todaySoFar' }, display: TODAY },
      ],
    },
  ],
}

export const PRESETS: Readonly<Record<string, CardSpec>> = {
  'campaign-scorecard': CAMPAIGN_SCORECARD,
  'bsk-kpis': BSK_KPIS,
}
