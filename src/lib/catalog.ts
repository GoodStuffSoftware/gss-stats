import type { SiteKey, ChartType, Metric, Dataset } from '../types'
import { POPUPS, POPUP_RATE_SPECS } from './popupEvents'
import { CAMPAIGNS } from './campaigns'

export const DATASETS: { value: Dataset; label: string }[] = [
  { value: 'rum', label: 'RUM — pageviews / visits' },
  { value: 'geo', label: 'Geo beacon — region / city (bot-free)' },
  { value: 'popup', label: 'Pop-up tracking — sign-in / promo / upsell / install' },
  { value: 'overview', label: 'Best Sudoku overview — KPIs / timeline / scorecard / release panel' },
  { value: 'campaigns', label: 'Best Sudoku campaigns — funnel / hour-of-day / country / …' },
  { value: 'ads-readings', label: 'Best Sudoku ads readings log' },
]

// dataset 'overview' — which panel a widget renders (widget.view).
export const OVERVIEW_VIEWS: { value: string; label: string }[] = [
  { value: 'kpis', label: 'Today at a glance (KPI tiles)' },
  { value: 'timeline', label: 'Overall timeline' },
  { value: 'scorecard', label: 'Campaign scorecard' },
  { value: 'releasePanel', label: 'Release before/after panel' },
]

// dataset 'campaigns' — which panel a widget renders (widget.view).
export const CAMPAIGNS_VIEWS: { value: string; label: string }[] = [
  { value: 'funnel', label: 'Funnel per campaign' },
  { value: 'hourOfDay', label: 'Arrivals by ET hour of day' },
  { value: 'country', label: 'Arrivals & funnel by country' },
  { value: 'flightDay', label: 'Daily arrivals by flight day (+ cumulative)' },
  { value: 'cost', label: 'Cost per arrival / auth success' },
  { value: 'deviceMix', label: 'Device mix' },
  { value: 'returns', label: 'Return visits' },
]

// dataset 'campaigns' / 'ads-readings' — which campaign(s) a widget covers (widget.campaignIds).
// Empty selection = all campaigns, same as the pre-widget bespoke campaigns page.
export const CAMPAIGN_OPTIONS: { value: string; label: string }[] = CAMPAIGNS.map((c) => ({ value: c.id, label: c.label }))

// Pop-up dataset (dataset: 'popup'). Count-based dimensions — each needs `widget.popup`
// (and 'reason'/'date' default `widget.popupKind` to 'shown'); 'eligible' and
// 'installOutcome' are fixed families and ignore `widget.popup`.
export const POPUP_DIMENSIONS: { key: string; label: string }[] = [
  { key: 'kind', label: 'Shown / accepted / dismissed' },
  { key: 'reason', label: 'Reason / platform breakdown' },
  { key: 'date', label: 'Date (trend, US-Eastern days)' },
  { key: 'outcome', label: 'Outcome (signed-in / installed / returned)' },
  { key: 'eligible', label: 'Sign-in eligibility (earned / capped / unearned)' },
  { key: 'installOutcome', label: 'Install real outcomes (pwa / standalone / play)' },
]

// Which pop-up a 'kind'/'reason'/'date'/'outcome' chart is scoped to (widget.popup).
export const POPUP_OPTIONS: { value: string; label: string }[] = POPUPS.map((p) => ({ value: p.id, label: p.label }))

// Funnel stage a 'reason'/'date' chart breaks down or trends (widget.popupKind).
export const POPUP_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: 'shown', label: 'Shown' },
  { value: 'accept', label: 'Accepted' },
  { value: 'dismiss', label: 'Dismissed' },
]

// type: 'rate' widgets — a single computed percentage. `widget.dimension` holds the
// POPUP_RATE_SPECS key directly (see lib/popupEvents.ts); this is its dimension-picker.
export const POPUP_RATE_DIMENSIONS: { key: string; label: string }[] = POPUP_RATE_SPECS.map((s) => ({
  key: s.key,
  label: s.label,
}))

// Geo-beacon dimensions (D1-backed). Single dimension per chart; metric is count.
export const GEO_DIMENSIONS: { key: string; label: string }[] = [
  { key: 'region', label: 'Region / state' },
  { key: 'city', label: 'City' },
  { key: 'postal', label: 'Postal / ZIP' },
  { key: 'country', label: 'Country' },
  { key: 'continent', label: 'Continent' },
  { key: 'timezone', label: 'Timezone' },
  { key: 'colo', label: 'Cloudflare PoP' },
  { key: 'org', label: 'ISP / network' },
  { key: 'referrer', label: 'Referrer' },
  { key: 'refpath', label: 'Referrer path (e.g. subreddit)' },
  { key: 'campaign', label: 'Campaign (utm_campaign)' },
  { key: 'source', label: 'Source (utm)' },
  { key: 'medium', label: 'Medium (utm)' },
  { key: 'site', label: 'Site' },
  { key: 'path', label: 'Page path' },
  { key: 'device', label: 'Device' },
  { key: 'browser', label: 'Browser' },
  { key: 'os', label: 'Operating system' },
  { key: 'lang', label: 'Language' },
  { key: 'visitor', label: 'New vs returning' },
  { key: 'date', label: 'Date (trend)' },
]

// Client-side mirror of the server's site registry (the Function has its own copy
// since Pages functions compile separately from the app bundle).
export interface SiteDef {
  key: Exclude<SiteKey, 'all'>
  label: string
  hosts: string[] // selectable requestHost filters within this site ('' = all)
}

export const SITES: SiteDef[] = [
  {
    key: 'goodstuff.software',
    label: 'goodstuff.software',
    hosts: ['starrupture.goodstuff.software', 'simpletile.goodstuff.software', 'goodstuff.software'],
  },
  { key: 'goodstuffsoftware.com', label: 'goodstuffsoftware.com', hosts: [] },
  { key: 'bestsudoku.app', label: 'bestsudoku.app', hosts: [] },
]

export const SITE_OPTIONS: { value: SiteKey; label: string }[] = [
  { value: 'goodstuff.software', label: 'goodstuff.software (Star Rupture + Simple Tile)' },
  { value: 'goodstuffsoftware.com', label: 'goodstuffsoftware.com' },
  { value: 'bestsudoku.app', label: 'bestsudoku.app' },
  { value: 'all', label: 'All sites (merged)' },
]

export interface DimensionDef {
  key: string
  label: string
}

export const DIMENSIONS: DimensionDef[] = [
  { key: 'requestHost', label: 'Site / host' },
  { key: 'requestPath', label: 'Page path' },
  { key: 'deviceType', label: 'Device' },
  { key: 'countryName', label: 'Country' },
  { key: 'refererHost', label: 'Referrer' },
  { key: 'userAgentBrowser', label: 'Browser' },
  { key: 'userAgentOS', label: 'Operating system' },
  { key: 'date', label: 'Date (trend)' },
]

export const CHART_TYPES: { value: ChartType; label: string; needsDimension: boolean; allowsBreakdown: boolean }[] = [
  { value: 'stat', label: 'Stat (big number)', needsDimension: false, allowsBreakdown: false },
  { value: 'bar', label: 'Bar (vertical)', needsDimension: true, allowsBreakdown: false },
  { value: 'hbar', label: 'Bar (horizontal)', needsDimension: true, allowsBreakdown: false },
  { value: 'stackedBar', label: 'Stacked bar', needsDimension: true, allowsBreakdown: true },
  { value: 'line', label: 'Line', needsDimension: true, allowsBreakdown: false },
  { value: 'area', label: 'Area', needsDimension: true, allowsBreakdown: false },
  { value: 'doughnut', label: 'Doughnut', needsDimension: true, allowsBreakdown: false },
  { value: 'nestedDoughnut', label: 'Nested doughnut (ring × ring)', needsDimension: true, allowsBreakdown: true },
  { value: 'pie', label: 'Pie', needsDimension: true, allowsBreakdown: false },
  { value: 'map', label: 'World map (geo points · beacon only)', needsDimension: false, allowsBreakdown: false },
  { value: 'table', label: 'Table', needsDimension: true, allowsBreakdown: true },
  { value: 'rate', label: 'Rate (% tile · pop-up dataset only)', needsDimension: true, allowsBreakdown: false },
  { value: 'note', label: 'Note (static text tile)', needsDimension: false, allowsBreakdown: false },
]

export const METRICS: { value: Metric; label: string }[] = [
  { value: 'pageviews', label: 'Pageviews' },
  { value: 'visits', label: 'Visits' },
]

// Friendly labels for ISO country codes RUM returns (top ones; falls back to code).
export const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  JP: 'Japan',
  BR: 'Brazil',
  IN: 'India',
  PH: 'Philippines',
  AR: 'Argentina',
  NL: 'Netherlands',
  SE: 'Sweden',
  ES: 'Spain',
  IT: 'Italy',
  MX: 'Mexico',
  PL: 'Poland',
  RU: 'Russia',
  KR: 'South Korea',
  CN: 'China',
}
