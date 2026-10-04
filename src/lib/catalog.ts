import type { SiteKey, ChartType, Metric, Dataset } from '../types'
import { POPUPS, POPUP_RATE_SPECS } from './popupEvents'
import { CAMPAIGNS } from './campaigns'

// `creatable: false` keeps a dataset out of "Add chart" → Data source while its label stays here for
// the widgets that still carry it: the overview and campaigns panels are metric-card presets now, so
// they are added from Metric card → preset (lib/defaults.ts CARD_PRESET_FOR_PANEL), not as a dataset.
export const DATASETS: { value: Dataset; label: string; creatable?: boolean }[] = [
  { value: 'rum', label: 'RUM — pageviews / visits' },
  { value: 'geo', label: 'Geo beacon — region / city (bot-free)' },
  { value: 'popup', label: 'Pop-up tracking — sign-in / promo / upsell / install' },
  { value: 'overview', label: 'Best Sudoku overview cards — KPIs / scorecard / release panel', creatable: false },
  { value: 'campaigns', label: 'Best Sudoku campaign cards — funnel / country / cost / returns', creatable: false },
  { value: 'ads-readings', label: 'Best Sudoku ads readings log' },
  { value: 'completions', label: 'Best Sudoku completions — mode × difficulty' },
]

// dataset 'completions' — the only two dimensions a completed-game beacon carries.
export const COMPLETIONS_DIMENSIONS: { key: string; label: string }[] = [
  { key: 'mode', label: 'Mode (normal / daily)' },
  { key: 'difficulty', label: 'Difficulty' },
]

// dataset 'overview' — which panel a widget renders (widget.view).
export const OVERVIEW_VIEWS: { value: string; label: string }[] = [
  { value: 'kpis', label: 'Today at a glance (KPI tiles)' },
  { value: 'scorecard', label: 'Campaign scorecard' },
  { value: 'releasePanel', label: 'Release before/after panel' },
]

// dataset 'campaigns' — which panel a widget renders (widget.view). Each is a metric card
// (lib/defaults.ts CARD_PRESET_FOR_PANEL); arrivals by ET hour and by flight day are standard
// geo charts since layout version 11 (hourEt / flightDay × campaignFlight), not views.
export const CAMPAIGNS_VIEWS: { value: string; label: string }[] = [
  { value: 'funnel', label: 'Funnel per campaign' },
  { value: 'country', label: 'Arrivals & funnel by country' },
  { value: 'cost', label: 'Cost per arrival / auth success' },
  { value: 'returns', label: 'Return visits' },
]

// dataset 'campaigns' / 'ads-readings' — which campaign(s) a widget covers (widget.campaignIds).
// Empty selection = all campaigns, same as the pre-widget bespoke campaigns page.
export const CAMPAIGN_OPTIONS: { value: string; label: string }[] = CAMPAIGNS.map((c) => ({ value: c.id, label: c.label }))

// Pop-up dataset (dataset: 'popup'). Count-based dimensions — each needs `widget.popup`
// (and 'reason'/'date' default `widget.popupKind` to 'shown'); 'installOutcome' is a fixed
// family and ignores `widget.popup`. (Sign-in eligibility is a metric card since layout
// version 11: preset signin-eligibility.)
export const POPUP_DIMENSIONS: { key: string; label: string }[] = [
  { key: 'kind', label: 'Shown / accepted / dismissed' },
  { key: 'reason', label: 'Reason / platform breakdown' },
  { key: 'date', label: 'Date (trend, US-Eastern days)' },
  { key: 'outcome', label: 'Outcome (signed-in / installed / returned)' },
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
  { key: 'screenw', label: 'Screen width (px, exact)' },
  { key: 'screenwBucket', label: 'Screen width (bucketed)' },
  { key: 'pathFamily', label: 'Path family (page vs. event beacons)' },
  // Event dims: a chart grouping by one counts only those event rows (no opt-in needed).
  { key: 'popupFamily', label: 'Pop-up (measured)' },
  { key: 'popupOutcome', label: 'Pop-up outcome (shown / tapped / dismissed / outcomes)' },
  { key: 'gameMode', label: 'Completed game: mode' },
  { key: 'gameDifficulty', label: 'Completed game: difficulty' },
  { key: 'campaignFlight', label: 'Campaign flight (attributed)' },
  { key: 'arrival', label: 'Arrival (first visit): tagged / untagged' },
  { key: 'keyEvent', label: 'Key event (sign-in / install / raw install / completion)' },
  { key: 'hourEt', label: 'Hour of day (ET)' },
  { key: 'flightDay', label: 'Campaign flight day (day 1 = first day)' },
  { key: 'date', label: 'Date (trend)' },
  { key: 'dateEt', label: 'Date (trend, ET)' },
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
  { value: 'breakdownBar', label: 'Breakdown bar (axis × series, grouped or stacked)', needsDimension: true, allowsBreakdown: true },
  { value: 'line', label: 'Line (a breakdown draws one line per value)', needsDimension: true, allowsBreakdown: true },
  { value: 'area', label: 'Area', needsDimension: true, allowsBreakdown: false },
  { value: 'doughnut', label: 'Doughnut', needsDimension: true, allowsBreakdown: false },
  { value: 'nestedDoughnut', label: 'Nested doughnut (ring × ring)', needsDimension: true, allowsBreakdown: true },
  { value: 'pie', label: 'Pie', needsDimension: true, allowsBreakdown: false },
  { value: 'map', label: 'World map (geo points · beacon only)', needsDimension: false, allowsBreakdown: false },
  { value: 'table', label: 'Table', needsDimension: true, allowsBreakdown: true },
  { value: 'rate', label: 'Rate (% tile · pop-up dataset only)', needsDimension: true, allowsBreakdown: false },
  { value: 'note', label: 'Note (static text tile)', needsDimension: false, allowsBreakdown: false },
]

// type 'breakdownBar': how one axis value's series sit (Widget.barMode).
export const BAR_MODES: { value: 'grouped' | 'stacked'; label: string }[] = [
  { value: 'grouped', label: 'Grouped (side by side)' },
  { value: 'stacked', label: 'Stacked' },
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
