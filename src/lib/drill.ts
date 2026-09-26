import type { Dataset } from '../types'

// Maps a dataset-neutral drill key to each dataset's native field. `null` = the
// dimension doesn't exist (or its values aren't compatible) in that dataset, so a
// drill on it simply doesn't constrain that dataset. Country is RUM-only because RUM
// stores the country NAME while the beacon stores the ISO code — filtering across
// them would silently match nothing.
export const DRILL_FIELDS: Record<string, { rum: string | null; geo: string | null }> = {
  device: { rum: 'deviceType', geo: 'device' },
  referrer: { rum: 'refererHost', geo: 'referrer' },
  refpath: { rum: null, geo: 'refpath' }, // referrer path (e.g. /r/sudoku) — beacon-only
  campaign: { rum: null, geo: 'campaign' }, // utm_campaign (e.g. r/sudoku) — beacon-only
  source: { rum: null, geo: 'source' }, // utm_source — beacon-only
  medium: { rum: null, geo: 'medium' }, // utm_medium — beacon-only
  path: { rum: 'requestPath', geo: 'path' },
  os: { rum: 'userAgentOS', geo: 'os' },
  browser: { rum: 'userAgentBrowser', geo: 'browser' },
  country: { rum: 'countryName', geo: null },
  region: { rum: null, geo: 'region' },
  city: { rum: null, geo: 'city' },
  postal: { rum: null, geo: 'postal' },
  continent: { rum: null, geo: 'continent' },
  timezone: { rum: null, geo: 'timezone' },
  colo: { rum: null, geo: 'colo' },
  org: { rum: null, geo: 'org' },
  lang: { rum: null, geo: 'lang' },
  visitor: { rum: null, geo: 'visitor' },
  screenw: { rum: null, geo: 'screenw' }, // exact viewport width (px) — beacon-only, raw column
  // screenwBucket / pathFamily are derived (CASE-expression) dimensions, not real columns —
  // but functions/api/geo.ts's DERIVED_FILTER_EXPR wraps the SAME whitelisted CASE expression
  // in a bound-parameter equality, so a click still turns their label into a real filter, same
  // as any other dimension here. Only 'date' stays out of this map — a date click becomes a
  // day RANGE client-side (App.openFilteredPage), never an equality constraint.
  screenwBucket: { rum: null, geo: 'screenwBucket' },
  pathFamily: { rum: null, geo: 'pathFamily' },
}

// Site dimensions are handled by the site multi-select (siteSel), not generic drill.
const SITE_DIMS = new Set(['site', 'requestHost'])
export function isSiteDim(field: string): boolean {
  return SITE_DIMS.has(field)
}

// A chart's native dimension → the semantic drill key (or null if not drillable).
export function semanticKey(field: string, dataset: Dataset): string | null {
  const ds = dataset === 'geo' ? 'geo' : 'rum'
  for (const [key, map] of Object.entries(DRILL_FIELDS)) if (map[ds] === field) return key
  return null
}

// A semantic drill key → the native field to filter on for a given dataset (or null).
export function nativeField(key: string, dataset: Dataset): string | null {
  const ds = dataset === 'geo' ? 'geo' : 'rum'
  return DRILL_FIELDS[key]?.[ds] ?? null
}

// Whether opening a filtered page from this drill should carry `includeEventBeacons: true`
// forward onto the new page (GlobalFilters.includeEventBeacons, App.vue openFilteredPage).
// Only geo's 'pathFamily' dimension can select an EVENT value at all — every other
// dimension's values are ordinary page-view attributes, never event-specific — and 'page' is
// the one pathFamily value that ISN'T an event, so a drill onto it doesn't need this. Without
// it, drilling into e.g. 'install' would land on a page whose OTHER widgets (any that don't
// set their own includeEventBeacons) apply the standing event-beacon exclusion AND the new
// pathFamily='install' constraint together — which can never match a single row, since an
// install-family row is by definition excluded by that same standing filter, so those widgets
// would render silently empty instead of showing the same drilled-into data.
export function drillNeedsEventBeacons(dimension: string, dataset: Dataset, value: string): boolean {
  return dataset === 'geo' && dimension === 'pathFamily' && value !== 'page'
}
