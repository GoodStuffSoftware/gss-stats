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
