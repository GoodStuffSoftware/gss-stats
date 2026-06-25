import type { SiteKey, ChartType, Metric, Dataset } from '../types'

export const DATASETS: { value: Dataset; label: string }[] = [
  { value: 'rum', label: 'RUM — pageviews / visits' },
  { value: 'geo', label: 'Geo beacon — region / city (bot-free)' },
]

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
