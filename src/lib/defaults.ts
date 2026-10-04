import type { DashboardConfig, DashboardPage, GlobalFilters, GroupMeta, LineSeries, Widget } from '../types'
import { relativeRange, SINCE_FIRST_CAMPAIGN, SINCE_FIRST_UNTIL_LAST_CAMPAIGN } from './range'
import { POPUPS, POPUP_RATE_SPECS, NO_OUTCOME_TRACKING_NOTE, SIGNIN_ELIGIBLE_CAVEAT } from './popupEvents'
import { CAMPAIGNS } from './campaigns'
import { BEST_SUDOKU_SITES } from './bestSudokuSites'
import { normCardRef } from './metrics/validate'
import { autoCaveatIds, isNoteIdHideable } from './notes'

export function defaultDateRange(): { since: string; until: string } {
  const until = new Date()
  const since = new Date(until.getTime() - 7 * 86_400_000) // rolling last 7 days (ISO datetimes)
  return { since: since.toISOString(), until: until.toISOString() }
}

export function defaultFilters(): GlobalFilters {
  const { since, until } = defaultDateRange()
  return {
    siteSel: [], // all real sites
    since,
    until,
    rangeRel: '7d', // relative by default → stays "last 7 days" across reloads
    excludeSelfReferrals: true,
    excludeOwnVisits: true,
    ownBrowser: 'Opera',
    ownOS: 'Windows',
  }
}

// Map a legacy { site, host } filter to the new siteSel token list.
export function migrateSiteSel(raw: any): string[] {
  if (Array.isArray(raw?.siteSel)) return raw.siteSel.filter((x: any) => typeof x === 'string')
  const host = typeof raw?.host === 'string' ? raw.host : ''
  const site = typeof raw?.site === 'string' ? raw.site : ''
  if (host) return [host] // a specific subdomain was selected
  if (site && site !== 'all') return [site] // the whole site (domain)
  return [] // 'all' or unset
}

function w(p: Omit<Widget, 'i'>): Widget {
  return { ...p, i: p.id }
}

// Bumped to 16 for chart captions (notes plan, slice 1c): a widget may now carry its own plain-text
// `caption` and a `hiddenCaveats` list (normWidget whitelists and caps both). Legacy `notes` caption
// ids keep rendering and convert to caption text on the chart's next edit (decision D5). A scope's
// caveats now show automatically (lib/notes.ts autoCaveatIds, D2-B), so the one rewrite is
// seedHiddenAutoCaveatsV16: each stored chart hides the hideable automatic caveats it did not show
// before, and looks unchanged. The built-in chart factories apply the same seed (factoryWidgets),
// so a fresh or restored default chart looks as it did too. functions/api/config.ts backs the
// stored layout up to `dashboard:default:backup:v<stored>` on the first v16 save.
// Bumped to 15 for the two default trend charts' ET-day axis (see migrateDateEtTrendsV15): a
// stored "Pageviews over time" / "Visits over time" geo trend that is still exactly the shipped
// default moves from the UTC `date` to the ET-day `dateEt`, so the counts-only split-guard caption
// (lib/splitGuard.ts) goes away. Version-gated, so an owner who later sets a chart back to `date`
// is never reverted. functions/api/config.ts backs the stored layout up to
// `dashboard:default:backup:v<stored>` on the first v15 save (production is stored at v14: `backup:v14`).
// Bumped to 14 for inline sparklines (ADR 0005 slice 2): a metric item may now ask for a daily
// series (`display: { as: 'sparkline', series: 'daily' }`) and draw it. NO stored layout is
// rewritten: no existing layout has a sparkline, so the bump is only the save guard that keeps a
// v13 tab from overwriting a layout it cannot draw (functions/api/config.ts answers it 409 and
// backs the stored layout up to `dashboard:default:backup:v13` on the first v14 save). Page
// navigation holds 13 (migrateNavV13), so this slice is 14. The numbers live in LAYOUT_VERSIONS
// below; every migration step is keyed on an entry there, never on a bare number.
// Bumped to 13 for page navigation (see migrateNavV13): every page gets a `group` (built-ins by id,
// others from a name prefix, else "Mine"), drill pages can carry a `parentId`, pages an `icon`, the
// config an optional `groupMeta` and `groupOrder` (normGroupOrder); the Best Sudoku pages lose their "Best Sudoku · " name prefix (the
// group shows it); the pre-v13 tab order becomes the stored order (no more reorder on load); and
// `activePageId` becomes the landing page for a first-time viewer (★ Overview) — each viewer's own
// current page lives in their browser (lib/viewerPrefs.ts). functions/api/config.ts backs the stored
// layout up to `dashboard:default:backup:v<stored>` on the first v13 save (production is stored at
// v12 when this ships: `backup:v12`); a tab still running v12 code then gets 409 ("This tab is out
// of date, reload") instead of overwriting it.
// (Bumped to 12 for the Overview's small-sample note row (see compactSmallSampleNoteV12): the
// one-line note drops from three grid rows to one and the cards below move up to meet it.)
// (Bumped to 11 for the rest of the panels (ADR 0003 slice 7, see migratePanelsV11): every
// remaining bespoke panel becomes a card preset (the release panel; the campaign funnel, country,
// cost and returns panels; the Pop-ups rate table and sign-in eligibility) or a standard chart
// (arrivals by ET hour, daily arrivals by flight day), swapped in place. functions/api/config.ts
// backs the stored layout up to `dashboard:default:backup:v<stored>` on the first v11 save.)
// (Bumped to 10 for metric cards (ADR 0003 slice 5, see migrateCardsV10): the Overview's bespoke
// 'kpis' and 'scorecard' panels gain `card: { preset }` and render as MetricCard; nothing else
// about them changes.)
// (Bumped to 9 for the Pop-ups page rebuild, the campaign device-mix swap and the Overview
// timeline swap (see normalizeConfig's v9 block): the Pop-ups page's ~25 generated tiles become
// one breakdown bar + a valid-rates table, the bespoke campaigns 'deviceMix' table becomes the
// standard nested doughnut, and the bespoke 'timeline' panel becomes a standard line chart. functions/
// api/config.ts backs the previous stored config up to KV the first time a newer version is
// saved over it. (Bumped to 8 for the completions-breakdown-widget migration (see normalizeConfig's v8 block
// below): adds the mode × difficulty completions widget to "Best Sudoku overview" once, on an
// uncustomized layout only. (Bumped to 7 for the bespoke-page → widget conversion migration —
// see the v7 block: Overview/Campaigns went from `widgets: []` (rendered by the now-retired
// OverviewPage.vue/CampaignComparePage.vue) to real generic widgets.)
export const LAYOUT_VERSIONS = {
  /** The Overview's small-sample note takes one grid row (compactSmallSampleNoteV12). */
  compactNoteRow: 12,
  /** Page navigation: groups, parentId, icons (migrateNavV13). */
  navigation: 13,
  /** Inline sparklines (ADR 0005 slice 2). A guard bump only: no stored layout is rewritten. */
  sparklines: 14,
  /** The default geo trend charts bucket by ET day (migrateDateEtTrendsV15). */
  dateEtTrends: 15,
  /** Plain-text chart captions and per-chart hidden caveats (Widget.caption, Widget.hiddenCaveats).
   * Automatic scope caveats (D2-B): seedHiddenAutoCaveatsV16 keeps each stored chart's look. */
  captions: 16,
} as const
// The newest layout version. A slice that adds an entry moves this to it.
export const CONFIG_VERSION: number = LAYOUT_VERSIONS.captions

// The default "basic charts available out of the box" — a sensible analytics
// starting layout. Users can move/resize/add/remove from here.
export function defaultWidgets(): Widget[] {
  return factoryWidgets([
    w({ id: 'kpi-views', title: 'Pageviews', type: 'stat', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3 }),
    w({ id: 'kpi-visits', title: 'Visits', type: 'stat', dimension: '', metric: 'visits', limit: 1, x: 3, y: 0, w: 3, h: 3 }),
    w({ id: 'trend', title: 'Pageviews over time', type: 'area', dimension: 'date', metric: 'pageviews', limit: 90, x: 6, y: 0, w: 6, h: 8 }),
    w({ id: 'by-host', title: 'Pageviews by site', type: 'bar', dimension: 'requestHost', metric: 'pageviews', limit: 12, x: 0, y: 3, w: 6, h: 8 }),
    w({ id: 'site-device', title: 'Site × device', type: 'nestedDoughnut', dimension: 'requestHost', breakdown: 'deviceType', metric: 'pageviews', limit: 30, x: 0, y: 11, w: 6, h: 8 }),
    w({ id: 'referrers', title: 'Top referrers', type: 'hbar', dimension: 'refererHost', metric: 'pageviews', limit: 10, excludeSelfReferrals: true, x: 6, y: 8, w: 6, h: 8 }),
    w({ id: 'country', title: 'By country', type: 'hbar', dimension: 'countryName', metric: 'pageviews', limit: 10, x: 6, y: 16, w: 6, h: 8 }),
    w({ id: 'pages', title: 'Top pages', type: 'hbar', dimension: 'requestPath', metric: 'pageviews', limit: 10, x: 0, y: 19, w: 6, h: 8 }),
    w({ id: 'device', title: 'Device split', type: 'doughnut', dimension: 'deviceType', metric: 'pageviews', limit: 6, x: 6, y: 24, w: 6, h: 8 }),
    w({ id: 'geo-region', title: 'Visitors by region (beacon)', type: 'hbar', dataset: 'geo', dimension: 'region', metric: 'pageviews', limit: 15, x: 0, y: 27, w: 6, h: 8 }),
    w({ id: 'geo-city', title: 'Top cities (beacon)', type: 'hbar', dataset: 'geo', dimension: 'city', metric: 'pageviews', limit: 15, x: 6, y: 27, w: 6, h: 8 }),
    w({ id: 'geo-visitor', title: 'New vs returning (beacon)', type: 'doughnut', dataset: 'geo', dimension: 'visitor', metric: 'pageviews', limit: 5, x: 0, y: 35, w: 6, h: 8 }),
    w({ id: 'geo-map', title: 'Visitor map (beacon)', type: 'map', dataset: 'geo', dimension: '', metric: 'pageviews', limit: 2000, x: 0, y: 43, w: 12, h: 9 }),
  ])
}

// Navigation groups (layout version 13). Groups are plain strings (DashboardPage.group), so these
// are only the built-ins' groups and the catch-all for everything else; a new product is just a new
// group name. BUILTIN_GROUP files each built-in page BY ID (never by name).
export const GROUP_ALL_SITES = 'All sites'
export const GROUP_BEST_SUDOKU = 'Best Sudoku'
export const GROUP_MINE = 'Mine'
const BUILTIN_GROUP: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    default: GROUP_ALL_SITES,
    beacon: GROUP_ALL_SITES,
    'bsk-overview': GROUP_BEST_SUDOKU,
    'bsk-campaigns': GROUP_BEST_SUDOKU,
    'bsk-popups': GROUP_BEST_SUDOKU,
    'bsk-launch': GROUP_BEST_SUDOKU,
  }),
)
/** The group a built-in page (by id) belongs to; undefined for any other page. */
export function builtinGroup(id: string): string | undefined {
  return Object.hasOwn(BUILTIN_GROUP, id) ? BUILTIN_GROUP[id] : undefined
}

// ★ Overview: the all-sites traffic page, the default page — pinned first, outside the groups,
// and where a first-time viewer lands (defaultConfig's activePageId).
export function defaultPage(): DashboardPage {
  return { id: 'default', name: 'Overview', isDefault: true, group: GROUP_ALL_SITES, filters: defaultFilters(), widgets: defaultWidgets() }
}

// Canonical "Beacon" page — all geo-dataset charts (bot-free region/city/ISP/map).
function gw(p: Omit<Widget, 'i' | 'metric' | 'dataset'>): Widget {
  return { metric: 'pageviews', dataset: 'geo', ...p, i: p.id }
}
export function defaultBeaconWidgets(): Widget[] {
  return factoryWidgets([
    gw({ id: 'bcn-views', title: 'Pageviews', type: 'stat', dimension: 'site', limit: 1, x: 0, y: 0, w: 3, h: 3 }),
    gw({ id: 'bcn-visitor', title: 'New vs returning', type: 'doughnut', dimension: 'visitor', limit: 5, x: 0, y: 3, w: 3, h: 6 }),
    gw({ id: 'bcn-trend', title: 'Pageviews over time', type: 'area', dimension: 'dateEt', limit: 90, x: 3, y: 0, w: 9, h: 8 }),
    gw({ id: 'bcn-site', title: 'Pageviews by site', type: 'bar', dimension: 'site', limit: 12, x: 0, y: 9, w: 6, h: 8 }),
    gw({ id: 'bcn-device', title: 'Device split', type: 'doughnut', dimension: 'device', limit: 6, x: 6, y: 8, w: 6, h: 8 }),
    gw({ id: 'bcn-sitedevice', title: 'Site × device', type: 'nestedDoughnut', dimension: 'site', breakdown: 'device', limit: 30, x: 0, y: 50, w: 7, h: 9 }),
    gw({ id: 'bcn-region', title: 'Visitors by region', type: 'hbar', dimension: 'region', limit: 15, x: 0, y: 17, w: 6, h: 8 }),
    gw({ id: 'bcn-city', title: 'Top cities', type: 'hbar', dimension: 'city', limit: 15, x: 6, y: 16, w: 6, h: 8 }),
    gw({ id: 'bcn-country', title: 'By country', type: 'hbar', dimension: 'country', limit: 10, x: 0, y: 25, w: 6, h: 8 }),
    gw({ id: 'bcn-isp', title: 'By ISP / network', type: 'hbar', dimension: 'org', limit: 12, x: 6, y: 24, w: 6, h: 8 }),
    gw({ id: 'bcn-ref', title: 'Top referrers', type: 'hbar', dimension: 'referrer', limit: 10, x: 0, y: 33, w: 6, h: 8 }),
    gw({ id: 'bcn-pages', title: 'Top pages', type: 'hbar', dimension: 'path', limit: 10, x: 6, y: 32, w: 6, h: 8 }),
    gw({ id: 'bcn-map', title: 'Visitor map', type: 'map', dimension: '', limit: 2000, x: 0, y: 41, w: 12, h: 9 }),
  ])
}
export function defaultBeaconPage(): DashboardPage {
  // siteSel [] = all real sites; the multi-select picker narrows it.
  return { id: 'beacon', name: 'Beacon', isDefault: false, group: GROUP_ALL_SITES, filters: defaultFilters(), widgets: defaultBeaconWidgets() }
}

// Best Sudoku "Traffic" (formerly "Best Sudoku launch") — a beacon page pre-filtered to
// the Best Sudoku traffic (web + app). Refined 2026-09-26 now that the Overview, Campaigns,
// and Pop-ups pages exist (see App.vue's former isBespokePage / OverviewPage.vue /
// CampaignComparePage.vue history): every chart here is something those three pages don't
// already cover — per-site/geo/referrer/device detail on ALL Best Sudoku traffic, not just
// tagged campaign arrivals. Removed vs the pre-refinement set:
//  - 'Campaign (utm_campaign)' and 'Campaign source / medium' hbars — shallow, ungated raw
//    beacon-tag counts across ALL traffic. The Campaigns page now covers this properly, per
//    FLIGHT, with MIN_COHORT gating, funnel context, and real attribution (lib/campaigns.ts)
//    — keeping the raw version here would just be a worse duplicate.
// Kept because nothing else shows it: per-site pageviews/new-vs-returning/web-vs-app split,
// device split, full geo breakdown (country/region/city/map — Campaigns' "country" view is
// tagged-arrivals-only, narrower), referrers + subreddit, and top pages/screens.
// The trend chart now carries release markers (lib/releases.ts) via widget.markers —
// 'releases', the same overlay the Overview timeline uses (see lib/charts.ts
// releaseMarkersPlugin) — so a traffic bump/dip can be read against what shipped.
// Event paths (pop-up/return beacons — see lib/popupEvents.ts isPopupEventPath) are excluded
// from every one of these queries at the API layer (functions/api/geo.ts's
// popupExcludeClause, applied to all three of its query shapes), so they never inflate
// pageviews/visits or leak into 'Top screens / pages' here — verified, not changed.
export function defaultBestSudokuLaunchWidgets(): Widget[] {
  return factoryWidgets([
    gw({ id: 'bsk-views', title: 'Pageviews', type: 'stat', dimension: 'site', limit: 10, x: 0, y: 0, w: 3, h: 3 }),
    gw({ id: 'bsk-visitor', title: 'New vs returning', type: 'doughnut', dimension: 'visitor', limit: 5, x: 0, y: 3, w: 3, h: 6 }),
    gw({ id: 'bsk-trend', title: 'Visits over time', type: 'area', dimension: 'dateEt', limit: 90, markers: 'releases', x: 3, y: 0, w: 9, h: 8 }),
    gw({ id: 'bsk-ref', title: 'Where they come from (referrers)', type: 'hbar', dimension: 'referrer', limit: 12, x: 0, y: 9, w: 6, h: 8 }),
    gw({ id: 'bsk-refpath', title: 'Which subreddit / section', type: 'hbar', dimension: 'refpath', limit: 12, x: 6, y: 8, w: 6, h: 8 }),
    gw({ id: 'bsk-webapp', title: 'Web vs app', type: 'doughnut', dimension: 'site', limit: 5, x: 0, y: 17, w: 3, h: 7 }),
    gw({ id: 'bsk-device', title: 'Device', type: 'doughnut', dimension: 'device', limit: 6, x: 3, y: 17, w: 3, h: 7 }),
    gw({ id: 'bsk-country', title: 'By country', type: 'hbar', dimension: 'country', limit: 10, x: 6, y: 16, w: 6, h: 8 }),
    gw({ id: 'bsk-region', title: 'By region / state', type: 'hbar', dimension: 'region', limit: 12, x: 0, y: 24, w: 6, h: 8 }),
    gw({ id: 'bsk-city', title: 'Top cities', type: 'hbar', dimension: 'city', limit: 12, x: 6, y: 24, w: 6, h: 8 }),
    gw({ id: 'bsk-path', title: 'Top screens / pages', type: 'hbar', dimension: 'path', limit: 12, x: 0, y: 32, w: 6, h: 8 }),
    gw({ id: 'bsk-map', title: 'Visitor map', type: 'map', dimension: '', limit: 2000, x: 6, y: 32, w: 6, h: 8 }),
  ])
}
// The Best Sudoku beacon site tags (lib/bestSudokuSites.ts, a leaf module), re-exported here.
export { BEST_SUDOKU_SITES }

export function defaultBestSudokuLaunchPage(): DashboardPage {
  return {
    id: 'bsk-launch',
    name: 'Traffic',
    isDefault: false,
    group: GROUP_BEST_SUDOKU,
    // Its charts are all beacon (geo) charts, which would resolve to the map pin Beacon shows too
    // (lib/icons.ts resolveIcon), so this one built-in carries an explicit icon.
    icon: 'trending-up',
    filters: { ...defaultFilters(), siteSel: [...BEST_SUDOKU_SITES] },
    widgets: defaultBestSudokuLaunchWidgets(),
  }
}

// "Best Sudoku · Pop-ups" (rebuilt in CONFIG_VERSION 9, owner 2026-09-27: "Couldn't we show
// all the popups in a bar chart"). Three widgets, all generic and editable:
//  1. ONE breakdown bar over the ordinary filtered geo query: every pop-up on the axis
//     (popupFamily), and shown, taps, dismissals and each outcome as the series (popupOutcome;
//     the shown row counts as outcome 'shown'). Measured rows only (see lib/popupEvents.ts
//     popupDimSqlCase).
//  2. A rate table with the VALID ratios only (lib/popupEvents.ts POPUP_RATE_TABLE_KEYS): each
//     pop-up's taps over its showings, and install over post-fix install prompts, each with its
//     n/d and "too few to report" under MIN_COHORT.
//  3. Sign-in eligibility (earned / capped / unearned), KEPT because the bar chart can't show it:
//     /signin-eligible isn't a pop-up but the sign-in prompt's denominator, with its own caveat
//     (rows are deferred at least 30 minutes after the finish).
// Dropped: the per-pop-up shown/accepted/dismissed bars, tap-rate tiles and outcome-rate tiles
// (all in 1 and 2 now; outcome-over-shown rates are lagged cohorts, so counts only), the reason
// and platform breakdowns and the two per-day trends (addable from the chart editor: dataset
// 'Pop-up tracking'), and the install real-outcomes table (its three raw signals are series of
// the bar chart). The page-level notes (App.vue) still carry the deferral and small-sample caveats.
export function defaultBestSudokuPopupsWidgets(): Widget[] {
  return factoryWidgets([
    w({
      id: 'pu-bars',
      title: 'Pop-ups: shown, taps and outcomes',
      type: 'breakdownBar',
      dataset: 'geo',
      dimension: 'popupFamily',
      breakdown: 'popupOutcome',
      barMode: 'grouped',
      metric: 'pageviews',
      limit: 100,
      notes: ['popup-bars-measured'],
      x: 0,
      y: 0,
      w: 12,
      h: 11,
    }),
    w({ id: 'pu-rates', title: 'Rates (valid ratios only)', type: 'rateTable', dataset: 'popup', dimension: '', card: { preset: 'popup-rates' }, metric: 'pageviews', limit: 1, notes: ['min-cohort-caveat'], x: 0, y: 11, w: 8, h: 7 }),
    w({ id: 'pu-eligible-bd', title: 'Sign-in eligibility', type: 'bar', dataset: 'popup', dimension: 'eligible', card: { preset: 'signin-eligibility' }, metric: 'pageviews', limit: 3, notes: ['signin-eligible-caveat'], x: 8, y: 11, w: 4, h: 7 }),
  ])
}

// Every widget id a pre-v9 Pop-ups generator ever produced, by PATTERN (from the full git
// history of this file, v0.3.0 on): `pu-<popup>-kind|tap|reason|trend`, `pu-rate-<spec key>`
// (every rate tile, including specs later removed, e.g. v0.3.0's
// `pu-rate-first50-congrats:outcome:returned`), plus the fixed `pu-eligible-rate` and
// `pu-install-outcomes`. The v9 migration removes all of these from a saved Pop-ups page, except
// 'pu-eligible-bd' (kept, see above). Owner-made widgets never match (their ids are random).
const POPUPS_PRE_V9_ID_PATTERNS = [/^pu-rate-/, /^pu-.+-(kind|tap|reason|trend)$/, /^pu-eligible-rate$/, /^pu-install-outcomes$/]
export function isPrePopupsV9GeneratedId(id: string): boolean {
  return POPUPS_PRE_V9_ID_PATTERNS.some((re) => re.test(id))
}
// Today's generator ids (for tests / fixtures) — every one matches the patterns above.
export function popupsPageV8FactoryIds(): string[] {
  const ids: string[] = []
  for (const p of POPUPS) {
    ids.push(`pu-${p.id}-kind`, `pu-${p.id}-tap`)
    if (p.hasReasonBreakdown) ids.push(`pu-${p.id}-reason`)
    if (p.id === 'signin-prompt' || p.id === 'upsell') ids.push(`pu-${p.id}-trend`)
  }
  ids.push('pu-eligible-bd', 'pu-eligible-rate', 'pu-install-outcomes')
  for (const spec of POPUP_RATE_SPECS.filter((s) => s.kind === 'outcome')) ids.push(`pu-rate-${spec.key}`)
  return ids
}
const POPUPS_V9_KEPT_IDS = new Set(['pu-eligible-bd'])
const POPUPS_V8_ELIGIBILITY_TITLE = 'Sign-in eligibility — earned / capped / unearned'

/** v9: rebuild a saved Pop-ups page. Removes the pre-v9 generated tiles (by id, the owner's
 * request: the page "makes no sense") and adds the new bar chart + rate table on top. The kept
 * eligibility bar (if the owner still has it) takes its new slot beside the rate table, with its
 * title/captions untouched; every other widget (anything the owner added) keeps its size, x and
 * relative order, moved down below the new block. Idempotent: a second run finds no v8 tile to
 * remove and both new widgets already present, and returns the page unchanged. */
export function migratePopupsPageV9(page: DashboardPage): DashboardPage {
  const survivors = page.widgets.filter((wd) => POPUPS_V9_KEPT_IDS.has(wd.id) || !isPrePopupsV9GeneratedId(wd.id))
  const defaults = defaultBestSudokuPopupsWidgets()
  const fresh = defaults.filter((wd) => !POPUPS_V9_KEPT_IDS.has(wd.id) && !survivors.some((k) => k.id === wd.id))
  if (survivors.length === page.widgets.length && fresh.length === 0) return page
  const slot = (id: string) => defaults.find((d) => d.id === id)!
  const keptFactory = survivors
    .filter((wd) => POPUPS_V9_KEPT_IDS.has(wd.id))
    .map((wd) => ({
      ...wd,
      // The old generated title truncated in its narrower slot; a title the owner edited stays.
      title: wd.title === POPUPS_V8_ELIGIBILITY_TITLE ? slot(wd.id).title : wd.title,
      x: slot(wd.id).x,
      y: slot(wd.id).y,
      w: slot(wd.id).w,
      h: slot(wd.id).h,
    }))
  const own = survivors.filter((wd) => !POPUPS_V9_KEPT_IDS.has(wd.id))
  const blockH = [...fresh, ...keptFactory].reduce((m, wd) => Math.max(m, wd.y + wd.h), 0)
  const minOwnY = own.reduce((m, wd) => Math.min(m, wd.y), Infinity)
  const shifted = own.map((wd) => ({ ...wd, y: blockH + (wd.y - (Number.isFinite(minOwnY) ? minOwnY : 0)) }))
  return { ...page, widgets: [...fresh, ...keptFactory, ...shifted] }
}

// The OLD generated titles baked SIGNIN_ELIGIBLE_CAVEAT/NO_OUTCOME_TRACKING_NOTE directly
// into the string (pre notes-registry). Titles are plain names now; the caveats are default
// CAPTIONS (widget.notes) instead — see migratePopupCaveatTitles below for the one-time,
// exact-string-matched migration of anyone's already-saved config.
const POPUP_KIND_TITLE_OLD_SUFFIX = ` (${NO_OUTCOME_TRACKING_NOTE})`
const SIGNIN_ELIGIBLE_TITLE_OLD_SUFFIX = ` (${SIGNIN_ELIGIBLE_CAVEAT})`

interface PopupTitleMigration {
  id: string
  oldTitle: string
  newTitle: string
  noteId: string
}
function popupTitleMigrations(): PopupTitleMigration[] {
  const migrations: PopupTitleMigration[] = []
  for (const p of POPUPS) {
    if (p.noOutcomeTracking) {
      migrations.push({
        id: `pu-${p.id}-kind`,
        oldTitle: `${p.label} — shown / accepted / dismissed${POPUP_KIND_TITLE_OLD_SUFFIX}`,
        newTitle: `${p.label} — shown / accepted / dismissed`,
        noteId: 'no-outcome-tracking',
      })
    }
  }
  migrations.push(
    {
      id: 'pu-eligible-bd',
      oldTitle: `Sign-in eligibility — earned / capped / unearned${SIGNIN_ELIGIBLE_TITLE_OLD_SUFFIX}`,
      newTitle: 'Sign-in eligibility',
      noteId: 'signin-eligible-caveat',
    },
    {
      id: 'pu-eligible-rate',
      oldTitle: `Sign-in eligibility rate${SIGNIN_ELIGIBLE_TITLE_OLD_SUFFIX}`,
      newTitle: 'Sign-in eligibility rate',
      noteId: 'signin-eligible-caveat',
    },
  )
  return migrations
}

/** Non-destructive, idempotent, runs on every load (not version-gated): moves SIGNIN_ELIGIBLE_CAVEAT/NO_OUTCOME_TRACKING_NOTE text that used to be baked
 * into these generated pop-up widget TITLES into a default CAPTION (widget.notes) instead,
 * restoring the plain name. Matched by widget id AND an EXACT old-title string — a title the
 * user has since edited, even by one character, no longer matches and is left completely
 * untouched. Idempotent because the new title never matches `oldTitle` on a second run. */
export function migratePopupCaveatTitles(pages: DashboardPage[]): DashboardPage[] {
  const migrations = popupTitleMigrations()
  let anyPageChanged = false
  const next = pages.map((p) => {
    let pageChanged = false
    const widgets = p.widgets.map((w) => {
      const m = migrations.find((m) => m.id === w.id && w.title === m.oldTitle)
      if (!m) return w
      pageChanged = true
      const notes = w.notes ?? []
      return { ...w, title: m.newTitle, notes: notes.includes(m.noteId) ? notes : [...notes, m.noteId] }
    })
    if (!pageChanged) return p
    anyPageChanged = true
    return { ...p, widgets }
  })
  return anyPageChanged ? next : pages
}

export function defaultBestSudokuPopupsPage(): DashboardPage {
  return {
    id: 'bsk-popups',
    name: 'Pop-ups',
    isDefault: false,
    group: GROUP_BEST_SUDOKU,
    filters: { ...defaultFilters(), siteSel: [...BEST_SUDOKU_SITES] },
    widgets: defaultBestSudokuPopupsWidgets(),
  }
}
// Built-in page detection is BY ID ONLY (layout version 13): no name fallback, so renaming a page can
// never change how it behaves (its notes, its filter bar, what "restore default charts" restores).
export function isBestSudokuPopupsPage(p: Pick<DashboardPage, 'id'>): boolean {
  return p.id === 'bsk-popups'
}

// "Best Sudoku campaigns" widgets — every panel of the former bespoke
// CampaignComparePage.vue as its own movable/resizable/editable widget: metric cards (dataset
// 'campaigns', `view` naming the panel, `card` its preset) and standard geo charts. campaignIds
// left undefined = every campaign the card repeats over (MetricCard campaignIds), same as the
// page's original always-every-campaign behavior.
export function defaultCampaignsWidgets(): Widget[] {
  return factoryWidgets([
    w({ id: 'cw-funnel', title: 'Funnel per campaign', type: 'table', dataset: 'campaigns', view: 'funnel', card: { preset: 'campaign-funnel' }, dimension: '', metric: 'pageviews', limit: 1, notes: ['arrivals-caveat', 'min-cohort-caveat'], x: 0, y: 0, w: 12, h: 14 }),
    hourOfDayWidget({ x: 0, y: 14, w: 12, h: 8 }),
    w({ id: 'cw-country', title: 'Arrivals & funnel by country', type: 'table', dataset: 'campaigns', view: 'country', card: { preset: 'campaign-country' }, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 22, w: 12, h: 10 }),
    flightDayWidget({ x: 0, y: 32, w: 12, h: 10 }),
    w({ id: 'cw-cost', title: 'Cost per arrival / auth success', type: 'table', dataset: 'campaigns', view: 'cost', card: { preset: 'campaign-cost' }, dimension: '', metric: 'pageviews', limit: 1, notes: ['arrivals-caveat', 'spend-source'], x: 0, y: 42, w: 12, h: 9 }),
    deviceMixWidget({ x: 0, y: 51, w: 12, h: 12 }),
    w({ id: 'cw-returns', title: 'Return visits', type: 'table', dataset: 'campaigns', view: 'returns', card: { preset: 'campaign-returns' }, dimension: '', metric: 'pageviews', limit: 1, notes: ['play-tracking-status', 'return-rate-caption'], x: 0, y: 63, w: 12, h: 11 }),
    w({
      id: 'cw-note-attrib',
      title: 'Attribution note',
      type: 'note',
      dimension: '',
      metric: 'pageviews',
      limit: 1,
      longText: true,
      noteId: 'campaigns-attribution-scope',
      x: 0,
      y: 74,
      w: 9,
      h: 4,
    }),
    w({
      id: 'cw-note-smallsample',
      title: 'Small sample',
      type: 'note',
      dimension: '',
      metric: 'pageviews',
      limit: 1,
      noteId: 'small-sample',
      x: 9,
      y: 74,
      w: 3,
      h: 4,
    }),
  ])
}
// Campaign device mix (CONFIG_VERSION 9, owner 2026-09-27: "you recreated the device mix chart
// when we already have been using nested pie charts for that"): the SAME nested doughnut the
// GSS pages use for site × device, here campaign flight → device → OS over the ordinary geo
// query. 'campaignFlight' attributes rows exactly as the campaigns endpoint does
// (campaignAttributionClause + EXCLUSIONS), and includeEventBeacons keeps its population the
// old table's: every tagged hit, event beacons included. The per-chart filter spans a rolling
// year (the Campaigns page hides the global filter bar; attribution itself bounds each flight
// from below), with the usual "hide my visits" toggle on.
export const DEVICE_MIX_TITLE = 'Device mix by campaign (share of tagged hits)'
function deviceMixFilters(): GlobalFilters {
  return normFilters({ ...defaultFilters(), siteSel: [], rangeRel: '12mo' })
}
export function deviceMixWidget(geom: { x: number; y: number; w: number; h: number }, id = 'cw-devicemix', title = DEVICE_MIX_TITLE): Widget {
  return {
    id,
    i: id,
    title,
    type: 'nestedDoughnut',
    dataset: 'geo',
    dimension: 'campaignFlight',
    breakdown: 'device',
    rings: ['os'],
    metric: 'pageviews',
    limit: 30,
    includeEventBeacons: true,
    filters: deviceMixFilters(),
    notes: ['device-mix-population'],
    ...geom,
  }
}
// Campaign arrivals charts (CONFIG_VERSION 11, ADR 0003 slice 7): the bespoke hour-of-day and
// flight-day panels as STANDARD geo charts. Both count tagged arrivals exactly as /api/campaigns
// did: the 'arrival' = tagged filter (a device's first-ever beacon, attributed by
// campaignAttributionClause with the same EXCLUSIONS, pre-fix install-gap rows left out), one
// series per beacon-tracked campaign flight ('campaignFlight', lib/charts.ts
// campaignFlightDomain: a campaign with no arrivals yet — including one with no start date yet —
// at 0), since the first campaign's start (a range that grows, so no flight's early days ever
// drop off, and every arrival the funnel card counts is on the charts), and without "hide my
// visits", which the campaigns endpoint never applied.
// The two charts differ only in where the range ENDS (v0.12.1): the hour-of-day chart stays
// open-ended (until = now, so it always includes today's arrivals). The flight-day chart instead
// ends at "until last campaign ends" (lib/range.ts) — a fixed instant, ET midnight of the day
// after the latest flight's end, once every flight is over — so its range (and cache key) stops
// changing on every load once there's nothing left to grow; it still ends at now while any
// flight is open-ended or still running.
function campaignArrivalsFilters(rangeRel: string = SINCE_FIRST_CAMPAIGN): GlobalFilters {
  return normFilters({ ...defaultFilters(), siteSel: [], rangeRel, excludeOwnVisits: false, drill: [{ key: 'arrival', value: 'tagged', label: 'Tagged' }] })
}
/** Arrivals by ET hour of day: bars per hour 0:00-23:00, one per campaign (grouped). */
export function hourOfDayWidget(geom: { x: number; y: number; w: number; h: number }, id = 'cw-hour', title = 'Arrivals by ET hour of day'): Widget {
  return { id, i: id, title, type: 'breakdownBar', dataset: 'geo', dimension: 'hourEt', breakdown: 'campaignFlight', metric: 'pageviews', limit: 500, includeEventBeacons: true, filters: campaignArrivalsFilters(), notes: ['arrivals-caveat'], ...geom }
}
/** Daily arrivals by flight day: a line per campaign over its flight days (day 1 = its first ET
 * day), with each campaign's running total dashed on a right-hand axis. */
export function flightDayWidget(geom: { x: number; y: number; w: number; h: number }, id = 'cw-flightday', title = 'Daily arrivals by flight day'): Widget {
  return { id, i: id, title, type: 'line', dataset: 'geo', dimension: 'flightDay', breakdown: 'campaignFlight', cumulative: true, metric: 'pageviews', limit: 500, includeEventBeacons: true, filters: campaignArrivalsFilters(SINCE_FIRST_UNTIL_LAST_CAMPAIGN), notes: ['arrivals-caveat', 'flight-day-caption'], ...geom }
}
const CAMPAIGN_CHART_FOR_VIEW: Readonly<Record<string, typeof hourOfDayWidget>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, typeof hourOfDayWidget>, { hourOfDay: hourOfDayWidget, flightDay: flightDayWidget }),
)
/** One bespoke campaign chart panel as its standard chart: same id, grid position, size, title,
 * captions and default mark. A panel scoped to ONE campaign keeps that scope as a campaignFlight
 * filter; one scoped to several (not all) shows every flight (each is its own series). */
function campaignChartFromBespoke(wd: Widget, make: typeof hourOfDayWidget): Widget {
  const next = make({ x: wd.x, y: wd.y, w: wd.w, h: wd.h }, wd.id, wd.title)
  next.isDefault = wd.isDefault
  if (wd.notes) next.notes = [...wd.notes]
  const ids = (wd.campaignIds ?? []).filter((id) => CAMPAIGNS.some((c) => c.id === id))
  if (ids.length === 1) {
    const c = CAMPAIGNS.find((x) => x.id === ids[0])!
    next.filters = { ...next.filters!, drill: [...(next.filters!.drill ?? []), { key: 'campaignFlight', value: c.id, label: c.label }] }
  }
  return next
}

/** A saved widget that is the retired bespoke device-mix table (any page, any id). */
export function isBespokeDeviceMix(wd: Widget): boolean {
  return wd.dataset === 'campaigns' && wd.view === 'deviceMix'
}
/** The nested doughnut that replaces one bespoke device-mix table: same id, grid position, size,
 * default mark and captions (the owner's own notes, plus the tagged-hits population note), the
 * owner's title if they renamed it, and — when the table was scoped to ONE campaign — that
 * campaign as a campaignFlight filter on the chart. A table scoped to several (but not all)
 * campaigns can't be expressed as one equality filter, so it shows every flight (each is its own
 * inner ring anyway). */
function deviceMixFromBespoke(wd: Widget): Widget {
  const next = deviceMixWidget({ x: wd.x, y: wd.y, w: wd.w, h: wd.h }, wd.id, wd.title === 'Device mix' ? DEVICE_MIX_TITLE : wd.title)
  next.isDefault = wd.isDefault
  if (wd.notes) next.notes = wd.notes.includes('device-mix-population') ? [...wd.notes] : [...wd.notes, 'device-mix-population']
  const ids = (wd.campaignIds ?? []).filter((id) => CAMPAIGNS.some((c) => c.id === id))
  if (ids.length === 1) {
    const c = CAMPAIGNS.find((x) => x.id === ids[0])!
    next.filters = { ...next.filters!, drill: [{ key: 'campaignFlight', value: c.id, label: c.label }] }
  }
  return next
}
/** v9: swap every bespoke device-mix table for the nested doughnut in place (deviceMixFromBespoke).
 * Idempotent (nothing left to swap on a second run). */
export function migrateDeviceMixV9(page: DashboardPage): DashboardPage {
  if (!page.widgets.some(isBespokeDeviceMix)) return page
  return {
    ...page,
    widgets: page.widgets.map((wd) =>
      isBespokeDeviceMix(wd) ? deviceMixFromBespoke(wd) : wd,
    ),
  }
}

// Another bespoke-turned-widget page (see components/CampaignComparePage.vue — kept for
// reference / git history only, no longer mounted by App.vue). Second in the Best Sudoku group.
export function defaultCampaignComparePage(): DashboardPage {
  return { id: 'bsk-campaigns', name: 'Campaigns', isDefault: false, group: GROUP_BEST_SUDOKU, filters: defaultFilters(), widgets: defaultCampaignsWidgets() }
}
/** By id only (see isBestSudokuPopupsPage). */
export function isCampaignComparePage(p: Pick<DashboardPage, 'id'>): boolean {
  return p.id === 'bsk-campaigns'
}

// The Best Sudoku retention page (R-3): the shipped retention presets placed as cards. It is a
// TEMPLATE only (lib/wizards.ts PAGE_TEMPLATES): not in defaultConfig() and not touched by
// normalizeConfig, so no layout version covers it and no stored layout is rewritten. It exists on a
// layout only once someone creates it (+ New > Page > Start from), as an ordinary page of ordinary
// card widgets. Counts only: no chart, no hour, place or device split, no clock time.
export function defaultRetentionWidgets(): Widget[] {
  const card = (id: string, title: string, preset: string, geom: { x: number; y: number; w: number; h: number }, notes?: string[], view?: string): Widget =>
    w({ id, title, type: 'table', dataset: 'campaigns', ...(view ? { view } : {}), card: { preset }, dimension: '', metric: 'pageviews', limit: 1, ...(notes ? { notes } : {}), ...geom })
  return [
    w({ id: 'rt-note-scope', title: 'Scope note', type: 'note', dimension: '', metric: 'pageviews', limit: 1, longText: true, noteId: 'retention-page-scope', x: 0, y: 0, w: 9, h: 3 }),
    w({ id: 'rt-note-smallsample', title: 'Small sample', type: 'note', dimension: '', metric: 'pageviews', limit: 1, noteId: 'small-sample', x: 9, y: 0, w: 3, h: 3 }),
    card('rt-verdict', 'Retention verdict', 'retention-verdict', { x: 0, y: 3, w: 12, h: 13 }),
    card('rt-returns', 'Return visits', 'campaign-returns', { x: 0, y: 16, w: 7, h: 11 }, ['play-tracking-status', 'return-rate-caption'], 'returns'),
    card('rt-engagement', 'Engagement per arrival', 'campaign-engagement', { x: 7, y: 16, w: 5, h: 11 }),
  ]
}
export function defaultRetentionPage(): DashboardPage {
  return { id: 'bsk-retention', name: 'Retention', isDefault: false, group: GROUP_BEST_SUDOKU, filters: defaultFilters(), widgets: defaultRetentionWidgets() }
}
/** By id only (see isBestSudokuPopupsPage). A page created from the template has a fresh id. */
export function isRetentionPage(p: Pick<DashboardPage, 'id'>): boolean {
  return p.id === 'bsk-retention'
}

// "Best Sudoku overview" (Part C) widgets — every panel of the former bespoke
// OverviewPage.vue as its own movable/resizable/editable widget: metric cards (dataset
// 'overview', `view` naming the panel) and the standard timeline chart. One widget per panel,
// reproducing the page's original top-to-bottom arrangement.
// Completions breakdown (mode × difficulty) — a plain GENERIC dataset widget (dataset
// 'completions', dimension/breakdown), not a bespoke 'overview' panel — see
// functions/api/completions.ts + lib/catalog.ts COMPLETIONS_DIMENSIONS. Factored into its own
// builder so both defaultOverviewWidgets() (fresh configs) and the v8 migration below (existing
// saved configs) build the EXACT same widget. `y` defaults to the v12 layout (row 44); the v8
// migration passes the pre-v12 row 46, which the v12 migration then moves up with the rest.
function completionsWidget(y = 44): Widget {
  return w({
    id: 'ow-completions',
    title: 'Completions by mode × difficulty',
    type: 'stackedBar',
    dataset: 'completions',
    dimension: 'mode',
    breakdown: 'difficulty',
    metric: 'pageviews',
    limit: 20,
    x: 0,
    y,
    w: 12,
    h: 10,
  })
}
// The exact id set defaultOverviewWidgets() produced before the completions widget existed —
// used by the v8 migration (overviewPageIsUncustomized) to tell an untouched factory layout
// apart from one the owner has already added/removed charts on.
const OVERVIEW_DEFAULT_WIDGET_IDS_V7 = ['ow-note-smallsample', 'ow-kpis', 'ow-timeline', 'ow-scorecard', 'ow-release']
/** True when a page's widget ids are EXACTLY the pre-completions factory Overview set (any
 * order — resizing/moving is normal use, not "customisation") — i.e. the owner hasn't added,
 * removed, or lost any of the default charts. Position/size changes don't disqualify it. */
export function overviewPageIsUncustomized(p: DashboardPage): boolean {
  const ids = new Set(p.widgets.map((w) => w.id))
  return ids.size === OVERVIEW_DEFAULT_WIDGET_IDS_V7.length && OVERVIEW_DEFAULT_WIDGET_IDS_V7.every((id) => ids.has(id))
}
// "Overall timeline" (CONFIG_VERSION 9, owner 2026-09-27: "it's still a line chart"): the
// STANDARD line chart, not a bespoke panel. Five series over the beacon's date axis, each a date
// query narrowed by one filter (Widget.series): page views and tagged arrivals on the left axis;
// sign-ins, installs and raw install signals on the right. Release and go-live markers and the
// campaign-flight bands are its overlay options (lib/timelineOverlay.ts), all editable in the
// normal chart editor. Colors match the former panel's.
export const TIMELINE_SERIES: LineSeries[] = [
  { label: 'Page views', axis: 'left', style: 'solid', color: 0 },
  { label: 'Tagged arrivals', filter: [{ field: 'arrival', value: 'tagged' }], axis: 'left', style: 'solid', color: 1 },
  { label: 'Auth successes', filter: [{ field: 'keyEvent', value: 'auth-success' }], axis: 'right', style: 'dashed', color: 3 },
  { label: 'Installs', filter: [{ field: 'keyEvent', value: 'install' }], axis: 'right', style: 'dashed', color: 4 },
  { label: 'Raw install signals (can double-count)', filter: [{ field: 'keyEvent', value: 'raw-install-signal' }], axis: 'right', style: 'dotted', color: 7 },
]
export function timelineWidget(geom: { x: number; y: number; w: number; h: number }, id = 'ow-timeline', title = 'Overall timeline'): Widget {
  return {
    id,
    i: id,
    title,
    type: 'line',
    dataset: 'geo',
    // US-Eastern days, the same days its flight bands and go-live markers are dated in.
    dimension: 'dateEt',
    metric: 'pageviews',
    // The server keeps the newest `limit` days (500 is its cap); a longer range starts the axis
    // at the oldest day it returned rather than zero-filling unknown days.
    limit: 500,
    markers: 'releases',
    goLiveMarkers: true,
    flightBands: true,
    excludeKnownTraffic: true,
    // Best Sudoku sites for this chart only (the "Site override"), so the page's own site pick —
    // and every other chart on the page — stays exactly as the owner set it.
    siteSel: [...BEST_SUDOKU_SITES],
    series: TIMELINE_SERIES.map((x) => ({ ...x, filter: x.filter?.map((f) => ({ ...f })) })),
    axisTitles: { left: 'page views / arrivals', right: 'auth / installs' },
    notes: ['overview-timeline-caption'],
    ...geom,
  }
}
/** A saved widget that is the retired bespoke Overview timeline panel. */
export function isBespokeTimeline(wd: Widget): boolean {
  return wd.dataset === 'overview' && wd.view === 'timeline'
}
/** v9: swap every bespoke timeline panel for the standard line chart, in place: same id, grid
 * position, size, title, captions and default mark. Idempotent. */
export function migrateTimelineV9(page: DashboardPage): DashboardPage {
  if (!page.widgets.some(isBespokeTimeline)) return page
  return {
    ...page,
    widgets: page.widgets.map((wd) =>
      isBespokeTimeline(wd)
        ? { ...timelineWidget({ x: wd.x, y: wd.y, w: wd.w, h: wd.h }, wd.id, wd.title), ...(wd.notes ? { notes: wd.notes } : {}), isDefault: wd.isDefault }
        : wd,
    ),
  }
}

// Metric cards (CONFIG_VERSION 10 and 11, ADR 0003 slices 5 and 7): the panels a card preset now
// renders, keyed by what the widget IS (panelKey) — dataset and view for the overview and
// campaigns panels, and for the pop-up dataset its rate table (type 'rateTable') and its
// sign-in eligibility chart (dimension 'eligible', any chart type). The widget keeps its
// dataset/view/type (an older build still recognises it) and gains `card: { preset }`;
// ChartCard renders MetricCard whenever `card` is set.
export const CARD_PRESET_FOR_PANEL: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    'overview:kpis': 'bsk-kpis',
    'overview:scorecard': 'campaign-scorecard',
    'overview:releasePanel': 'release-before-after',
    'popup:rates': 'popup-rates',
    'popup:eligible': 'signin-eligibility',
    'campaigns:cost': 'campaign-cost',
    'campaigns:funnel': 'campaign-funnel',
    'campaigns:country': 'campaign-country',
    'campaigns:returns': 'campaign-returns',
  }),
)
const CARD_PRESETS_FROM_PANELS = new Set(Object.values(CARD_PRESET_FOR_PANEL))
/** What a widget IS, as a CARD_PRESET_FOR_PANEL key: never its title or its page's name. */
export function panelKey(wd: Pick<Widget, 'dataset' | 'view' | 'type' | 'dimension'>): string | null {
  if ((wd.dataset === 'overview' || wd.dataset === 'campaigns') && typeof wd.view === 'string') return `${wd.dataset}:${wd.view}`
  if (wd.dataset === 'popup' && wd.type === 'rateTable') return 'popup:rates'
  if (wd.dataset === 'popup' && wd.dimension === 'eligible' && wd.type !== 'rate') return 'popup:eligible'
  return null
}
/** A widget that is (or was) one of those panels, on any page. */
export function isCardPanel(wd: Widget): boolean {
  const k = panelKey(wd)
  return k !== null && Object.hasOwn(CARD_PRESET_FOR_PANEL, k)
}
/** The panel with its card: adds `card: { preset }` when absent and keeps everything else (id,
 * position, size, title, notes, default mark, campaign selection — which still narrows the
 * card's campaigns: MetricCard `campaignIds`, as it narrowed the old panel's). A card already
 * set — a preset or a customised spec — is left as it is. Returns the same object when nothing
 * changes. */
export function withCardForView(wd: Widget): Widget {
  if (!isCardPanel(wd) || wd.card) return wd
  return { ...wd, card: { preset: CARD_PRESET_FOR_PANEL[panelKey(wd)!] } }
}
/** For the chart editor's save: a widget edited INTO one of the panels gets its card; one
 * edited away from them (another view, dimension or type) loses the preset card that came with
 * the old panel, so it renders as what it now is. */
export function syncCardWithView(wd: Widget): Widget {
  if (isCardPanel(wd)) return withCardForView(wd)
  if ((wd.dataset === 'overview' || wd.dataset === 'campaigns' || wd.dataset === 'popup') && wd.card && 'preset' in wd.card && CARD_PRESETS_FROM_PANELS.has(wd.card.preset)) {
    const { card: _drop, ...rest } = wd
    return rest as Widget
  }
  return wd
}
/** Every card panel on the page gets its card (withCardForView). Idempotent, and never adds,
 * removes or moves a widget, so a panel the owner deleted stays deleted. */
export function migrateCardsV10(page: DashboardPage): DashboardPage {
  if (!page.widgets.some((wd) => withCardForView(wd) !== wd)) return page
  return { ...page, widgets: page.widgets.map(withCardForView) }
}
/** v11 (every load): the chart swaps (swapPanelChart), then every card panel's card. */
export function migratePanelsV11(page: DashboardPage): DashboardPage {
  const swapped = page.widgets.some((wd) => swapPanelChart(wd) !== wd) ? { ...page, widgets: page.widgets.map(swapPanelChart) } : page
  return migrateCardsV10(swapped)
}
// Widget fields that are placement, not content: ignored when asking whether a stored widget is
// still the shipped default.
const TREND_PLACEMENT_KEYS: ReadonlySet<string> = new Set(['id', 'i', 'x', 'y', 'w', 'h', 'moved'])
/** A widget's content as a comparable string: every defined field except placement, key-sorted. */
function trendShape(wd: object): string {
  const entries = Object.entries(wd).filter(([k, v]) => v !== undefined && !TREND_PLACEMENT_KEYS.has(k))
  return JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
/** The shipped (v14) content of the two default trend charts on the UTC `date` axis, FROZEN as
 * literals on purpose: the match test of a version-gated, one-shot migration has to describe what
 * was stored through v14, not what the factories build today. Do not derive these from
 * defaultBeaconWidgets / defaultBestSudokuLaunchWidgets: a later edit of a factory (title, limit,
 * a new default field) would then stop a stored v14 chart from matching, the layout would still be
 * stamped v15, and the chart would never move. defaults.v15.test.ts pins these literals and checks
 * them against the factories, so a factory edit forces a conscious choice. */
export const V14_DATE_TREND_DEFAULTS: readonly Readonly<Record<string, unknown>>[] = Object.freeze([
  // bcn-trend: Beacon "Pageviews over time"
  Object.freeze({ title: 'Pageviews over time', type: 'area', dataset: 'geo', metric: 'pageviews', dimension: 'date', limit: 90 }),
  // bsk-trend: Best Sudoku Traffic "Visits over time"
  Object.freeze({ title: 'Visits over time', type: 'area', dataset: 'geo', metric: 'pageviews', dimension: 'date', limit: 90, markers: 'releases' }),
])
const DATE_TREND_V14_SHAPES: ReadonlySet<string> = new Set(V14_DATE_TREND_DEFAULTS.map(trendShape))
/** v15 (version-gated): the two default geo trend charts, "Pageviews over time" and "Visits over
 * time", move from the UTC `date` axis to the ET-day `dateEt`, so the counts-only split-guard
 * caption goes away (each bucket is a whole ET day, which the rule allows).
 *
 * MATCH RULE: a widget is migrated only when it has `dimension: 'date'` and, ignoring placement
 * (id, i, x, y, w, h, moved) and absent fields, EVERY other field equals the shipped default of
 * `bcn-trend` or `bsk-trend`: geo dataset, area type, pageviews metric, limit 90, that title, and
 * `markers: 'releases'` only on the Visits one. The id is deliberately NOT part of the test: the
 * stored charts carry the known ids (`bcn-trend`, `bsk-trend`, and `trend` in the prod layouts)
 * and also random ones (a restored default gets a fresh id), and since every other field must equal
 * the default, an id adds no information. Any other title, an extra filter, a site override, a
 * series, a caption, a breakdown or any other param leaves the widget untouched. Only `dimension`
 * changes. The same page object when nothing matches. */
export function migrateDateEtTrendsV15(page: DashboardPage): DashboardPage {
  const pristine = (wd: Widget) => wd.dimension === 'date' && DATE_TREND_V14_SHAPES.has(trendShape(wd))
  if (!page.widgets.some(pristine)) return page
  return { ...page, widgets: page.widgets.map((wd) => (pristine(wd) ? { ...wd, dimension: 'dateEt' } : wd)) }
}
/** v12: the Overview's small-sample note shipped as a 12-wide, 3-row grid cell (148px on
 * desktop) holding a single caption line, which read as an empty band under the filter bar.
 * Shrink it to one row and move every widget below it up by the two freed rows. Matches only the
 * untouched factory cell (id, note type, x 0, w 12, h 3), so a note the owner has resized or
 * moved keeps its geometry. The same object when there is nothing to do. */
export function compactSmallSampleNoteV12(page: DashboardPage): DashboardPage {
  const note = page.widgets.find((wd) => wd.id === 'ow-note-smallsample' && wd.type === 'note' && wd.x === 0 && wd.w === 12 && wd.h === 3)
  if (!note) return page
  const freedFrom = note.y + 3
  return {
    ...page,
    widgets: page.widgets.map((wd) => (wd === note ? { ...wd, h: 1 } : wd.y >= freedFrom ? { ...wd, y: wd.y - 2 } : wd)),
  }
}
/** The bespoke panels that became STANDARD charts (not cards), swapped in place: same id, grid
 * position, size, title, captions and default mark (campaignChartFromBespoke). Matched by what
 * the widget is (dataset 'campaigns' and its view), never by name. The same object when it is
 * not one, so a second run changes nothing. */
export function swapPanelChart(wd: Widget): Widget {
  if (wd.dataset !== 'campaigns' || typeof wd.view !== 'string' || !Object.hasOwn(CAMPAIGN_CHART_FOR_VIEW, wd.view)) return wd
  return campaignChartFromBespoke(wd, CAMPAIGN_CHART_FOR_VIEW[wd.view])
}

export function defaultOverviewWidgets(): Widget[] {
  return factoryWidgets([
    // The small-sample note is ONE grid row (h: 1), not three (CONFIG_VERSION 12, see
    // compactSmallSampleNoteV12): a one-line caption in a 148px cell left an empty band between
    // the filter bar and the first card that the pre-v0.6 page never had.
    w({ id: 'ow-note-smallsample', title: 'Small sample', type: 'note', dimension: '', metric: 'pageviews', limit: 1, noteId: 'small-sample', x: 0, y: 0, w: 12, h: 1 }),
    w({ id: 'ow-kpis', title: 'Today at a glance', type: 'table', dataset: 'overview', view: 'kpis', card: { preset: 'bsk-kpis' }, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 1, w: 12, h: 8 }),
    timelineWidget({ x: 0, y: 9, w: 12, h: 12 }),
    w({ id: 'ow-scorecard', title: 'Campaign scorecard', type: 'table', dataset: 'overview', view: 'scorecard', card: { preset: 'campaign-scorecard' }, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 21, w: 12, h: 14 }),
    w({ id: 'ow-release', title: 'Release panel', type: 'table', dataset: 'overview', view: 'releasePanel', card: { preset: 'release-before-after' }, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 35, w: 12, h: 9 }),
    completionsWidget(),
  ])
}
// Another bespoke-turned-widget page (see components/OverviewPage.vue — kept for reference /
// git history only, no longer mounted by App.vue), FIRST in the Best Sudoku group:
// "how is the release going, how is each campaign going, and what's happening right now."
// Uses the global filter's date range for its timeline (the "existing range control"), so —
// unlike the campaign-compare page — it keeps its own real `filters`, seeded to span since
// well before any known Best Sudoku data.
export function defaultOverviewPage(): DashboardPage {
  return {
    id: 'bsk-overview',
    name: 'Overview',
    isDefault: false,
    group: GROUP_BEST_SUDOKU,
    filters: { ...defaultFilters(), since: '2026-01-01T00:00:00.000Z', rangeRel: '' },
    widgets: defaultOverviewWidgets(),
  }
}
/** The Best Sudoku overview page, by id only (see isBestSudokuPopupsPage). */
export function isOverviewPage(p: Pick<DashboardPage, 'id'>): boolean {
  return p.id === 'bsk-overview'
}

// The built-in pages in their order, which is data (layout version 13): ★ Overview (pinned),
// then the "All sites" group (Beacon), then the "Best Sudoku" group (Overview, Campaigns, Pop-ups,
// Traffic). A first-time viewer lands on ★ Overview.
export function defaultConfig(): DashboardConfig {
  return {
    version: CONFIG_VERSION,
    activePageId: 'default',
    pages: [defaultPage(), defaultBeaconPage(), defaultOverviewPage(), defaultCampaignComparePage(), defaultBestSudokuPopupsPage(), defaultBestSudokuLaunchPage()],
  }
}

// A RUM dimension → its beacon (geo) equivalent, so a Cloudflare-RUM chart can be
// re-pointed at the bot-free beacon dataset without losing what it groups by.
const RUM_TO_GEO_DIM: Record<string, string> = {
  requestHost: 'site',
  requestPath: 'path',
  deviceType: 'device',
  countryName: 'country',
  refererHost: 'referrer',
  userAgentBrowser: 'browser',
  userAgentOS: 'os',
  date: 'date',
}

// Re-point one widget at the beacon (geo) dataset. Geo charts are count-based (the metric
// is ignored) and single-dimension except nested/stacked/table; a stat groups by 'site' so
// its total reflects the whole selection, and a map has no dimension.
export function beaconizeWidget(wd: Widget): Widget {
  const mapDim = (d: string | undefined): string => (d ? (RUM_TO_GEO_DIM[d] ?? d) : '')
  const next: Widget = { ...wd, dataset: 'geo', metric: 'pageviews' }
  if (wd.type === 'map') {
    next.dimension = ''
    next.breakdown = undefined
  } else if (wd.type === 'stat') {
    next.dimension = 'site'
    next.breakdown = undefined
    next.limit = Math.max(Number(wd.limit) || 0, 10)
  } else {
    next.dimension = mapDim(wd.dimension) || 'region'
    next.breakdown =
      wd.type === 'nestedDoughnut' || wd.type === 'stackedBar' || wd.type === 'table'
        ? wd.breakdown
          ? mapDim(wd.breakdown)
          : undefined
        : undefined
  }
  return next
}

// The Best Sudoku launch/Traffic page, by id only (see isBestSudokuPopupsPage). A page the owner
// built by duplicating another one and renaming it no longer counts: its behaviour is its own.
export function isBestSudokuLaunchPage(p: Pick<DashboardPage, 'id'>): boolean {
  return p.id === 'bsk-launch'
}

// The right "factory" chart set for a page when restoring defaults. The two canonical
// pages restore their own set; a drill-down or user-made page (no fixed identity) restores
// the set that matches its current data source — so a beacon page comes back with beacon
// charts and a RUM page with RUM charts, instead of everything reverting to RUM Overview.
// (The Best Sudoku launch page is handled separately: it keeps its charts and just
// re-points them at the beacon.)
export function defaultWidgetsForPage(p: DashboardPage): Widget[] {
  if (p.id === 'default') return defaultWidgets()
  if (p.id === 'beacon') return defaultBeaconWidgets()
  if (p.id === 'bsk-popups') return defaultBestSudokuPopupsWidgets()
  if (isOverviewPage(p)) return defaultOverviewWidgets()
  if (isCampaignComparePage(p)) return defaultCampaignsWidgets()
  if (isRetentionPage(p)) return defaultRetentionWidgets()
  if (isBestSudokuLaunchPage(p)) return defaultBestSudokuLaunchWidgets()
  const geoCount = p.widgets.filter((w) => w.dataset === 'geo').length
  return geoCount > p.widgets.length / 2 ? defaultBeaconWidgets() : defaultWidgets()
}

// Normalize a filter object, migrating legacy { site, host } → siteSel tokens.
function normFilters(raw: any): GlobalFilters {
  const base = defaultFilters()
  const merged = { ...base, ...(raw ?? {}), siteSel: migrateSiteSel(raw ?? {}), site: undefined, host: undefined }
  // Relative ranges are stored as a token and recomputed to a fresh now-relative window on
  // load, so "last 7d" always means the last 7 days (not a frozen window). An empty
  // rangeRel means an absolute (calendar) range — keep the stored since/until as-is.
  // A token relativeRange reads: a duration ("7d") or "since first campaign" (lib/range.ts).
  const rel = typeof merged.rangeRel === 'string' ? merged.rangeRel : ''
  const r = rel ? relativeRange(rel) : null
  if (r) {
    merged.since = r.since
    merged.until = r.until
  }
  return merged
}

const KNOWN_DATASETS = new Set(['geo', 'popup', 'overview', 'campaigns', 'ads-readings', 'completions'])
function normWidget(x: any): Widget {
  return {
    id: String(x.id ?? cryptoId()),
    i: String(x.id ?? x.i ?? cryptoId()),
    title: String(x.title ?? 'Untitled'),
    type: x.type ?? 'bar',
    dataset: KNOWN_DATASETS.has(x.dataset) ? x.dataset : undefined,
    dimension: x.dimension ?? '',
    breakdown: x.breakdown || undefined,
    // type 'breakdownBar': grouped (default, stored as absent) or stacked.
    barMode: x.barMode === 'stacked' || x.barMode === 'grouped' ? x.barMode : undefined,
    popup: typeof x.popup === 'string' ? x.popup : undefined,
    popupKind: typeof x.popupKind === 'string' ? x.popupKind : undefined,
    // Nested-doughnut extra rings (beyond dimension+breakdown) — see lib/rings.ts. Absent/
    // invalid on any older saved config, which is exactly the back-compat 2-ring behavior.
    rings: Array.isArray(x.rings) ? x.rings.filter((r: any) => typeof r === 'string' && r) : undefined,
    metric: x.metric === 'visits' ? 'visits' : 'pageviews',
    limit: Number(x.limit) || 50,
    site: x.site,
    host: x.host,
    excludeSelfReferrals: x.excludeSelfReferrals,
    // Per-chart geo-only opt-in (feat/all-beacon-fields) — default/absent stays false (every
    // pre-existing saved chart keeps excluding event-beacon paths exactly as before).
    includeEventBeacons: x.includeEventBeacons === true || undefined,
    excludeKnownTraffic: x.excludeKnownTraffic === true || undefined,
    isDefault: x.isDefault === true || undefined,
    // Per-chart override: back-fill any filter fields added since it was saved.
    filters: x.filters ? normFilters(x.filters) : undefined,
    // dataset 'overview'/'campaigns'/'ads-readings': which panel + which campaign(s).
    view: typeof x.view === 'string' ? x.view : undefined,
    // A metric card (ADR 0003): validated and size-capped here, on every load (normCardRef), so
    // the field whitelist never silently drops it and a bad stored card becomes a placeholder.
    card: normCardRef(x.card),
    campaignIds: Array.isArray(x.campaignIds) ? x.campaignIds.filter((c: any) => typeof c === 'string' && c) : undefined,
    // type 'note': the note body (custom text) and/or a notes-registry id — see
    // lib/notes.ts. Both pass through untouched/absent when unset: an existing note widget
    // saved before the registry shipped keeps rendering its own custom text exactly as
    // before (the migration default for this field is simply "stay absent").
    note: typeof x.note === 'string' ? x.note : undefined,
    noteId: typeof x.noteId === 'string' ? x.noteId : undefined,
    longText: x.longText === true || undefined,
    // Legacy attached captions (lib/notes.ts) — absent stays absent (= none). A scope's caveats
    // show through autoCaveatIds instead, never by filling this in.
    notes: Array.isArray(x.notes) ? x.notes.filter((n: any) => typeof n === 'string' && n) : undefined,
    // date-dimension trend charts: release-marker overlay, go-live markers, flight bands.
    markers: x.markers === 'releases' ? 'releases' : undefined,
    goLiveMarkers: x.goLiveMarkers === true || undefined,
    flightBands: x.flightBands === true || undefined,
    // A line with a breakdown: also each series' running total (dashed, right axis).
    cumulative: x.cumulative === true || undefined,
    // Per-chart site override (Widget.siteSel): site tokens only.
    siteSel: Array.isArray(x.siteSel) ? x.siteSel.filter((t: any) => typeof t === 'string' && /^[a-z0-9.\-]{1,60}$/i.test(t)) : undefined,
    // Series line chart (Widget.series): label + optional field=value filters + axis/style.
    series: normSeries(x.series),
    axisTitles: normAxisTitles(x.axisTitles),
    // Fit-to-content height (lib/fit.ts): only 'content' is meaningful; anything else is absent
    // (the fixed grid height). Optional, so no version bump: an older layout loads unchanged.
    fit: x.fit === 'content' ? 'content' : undefined,
    // Plain-text caption + hidden caveats (layout v16, slice 1c). Spread in only when present, so
    // a widget that never had them gains no new keys.
    ...normCaptionFields(x),
    x: Number(x.x) || 0,
    y: Number(x.y) || 0,
    w: Number(x.w) || 4,
    h: Number(x.h) || 8,
  }
}

/** Longest stored caption (Widget.caption); the editor's text area has the same maxlength. */
export const CAPTION_MAX_CHARS = 2000
/** Most entries in Widget.hiddenCaveats, and the shape of each one. */
export const HIDDEN_CAVEATS_MAX = 32
export const HIDDEN_CAVEAT_ID_RE = /^[a-z0-9-]{1,64}$/

/** Widget.caption and Widget.hiddenCaveats, whitelisted and capped. A longer caption is cut to
 * CAPTION_MAX_CHARS, never dropped; an empty one is absent. hiddenCaveats keeps the first
 * HIDDEN_CAVEATS_MAX distinct well-formed ids; none left = absent. */
function normCaptionFields(x: any): Pick<Widget, 'caption' | 'hiddenCaveats'> {
  const out: Pick<Widget, 'caption' | 'hiddenCaveats'> = {}
  if (typeof x.caption === 'string' && x.caption) out.caption = x.caption.slice(0, CAPTION_MAX_CHARS)
  if (Array.isArray(x.hiddenCaveats)) {
    const ids = [...new Set(x.hiddenCaveats.filter((h: any) => typeof h === 'string' && HIDDEN_CAVEAT_ID_RE.test(h)))] as string[]
    if (ids.length) out.hiddenCaveats = ids.slice(0, HIDDEN_CAVEATS_MAX)
  }
  return out
}

/** Layout v16 migration (decision D2-B, run once on a layout stored before LAYOUT_VERSIONS.captions):
 * a scope's caveats now show automatically (lib/notes.ts autoCaveatIds), so every widget adds to
 * `hiddenCaveats` each HIDEABLE automatic caveat it did not show before (one not in its legacy
 * `notes`, nor a card's own spec captions: autoCaveatIds already leaves those out). The chart then
 * looks as it did. A data-cut caveat (`hideable: false`) is never seeded: a chart that lacked it
 * gains it (D3 wins over "unchanged"). Merged after any ids already there, deduped, capped at
 * HIDDEN_CAVEATS_MAX. Idempotent; a widget with nothing to add is returned as is. */
export function seedHiddenAutoCaveatsV16(p: DashboardPage): DashboardPage {
  const widgets = seedHiddenAutoCaveats(p.widgets)
  return widgets === p.widgets ? p : { ...p, widgets }
}

/** The hideable automatic caveats that existed when layout v16 was cut, FROZEN as literals on
 * purpose (the same pattern as V14_DATE_TREND_DEFAULTS): the seed describes what a chart stored
 * before v16 did not show, which is fixed, not what the registry holds today. Do not derive this
 * from NOTES_REGISTRY: a hideable caveat added to a scope later would then start hidden on every
 * pre-v16 chart (production stays stored at v12 until its first save, so the seed re-runs on every
 * load until then) and on every built-in chart a fresh config or "restore default charts" builds.
 * A caveat added later is meant to show on every chart of its scope. The two gated ids are off
 * today (their tracking dates are set) and are listed because they existed at v16. */
export const V16_SEEDABLE_CAVEATS: ReadonlySet<string> = new Set([
  'play-tracking-status',
  'play-tracking-not-live',
  'tracking-not-yet-active',
  'min-cohort-caveat',
])

/** seedHiddenAutoCaveatsV16's rule over a widget list: the same array when nothing changes. Only
 * ids in V16_SEEDABLE_CAVEATS are ever seeded. */
function seedHiddenAutoCaveats(list: Widget[]): Widget[] {
  let changed = false
  const widgets = list.map((w) => {
    const have = w.hiddenCaveats ?? []
    const add = autoCaveatIds(w).filter((id) => V16_SEEDABLE_CAVEATS.has(id) && isNoteIdHideable(id) && !have.includes(id))
    if (!add.length || have.length >= HIDDEN_CAVEATS_MAX) return w
    changed = true
    return { ...w, hiddenCaveats: [...new Set([...have, ...add])].slice(0, HIDDEN_CAVEATS_MAX) }
  })
  return changed ? widgets : list
}

/** Every built-in chart list (the defaultXWidgets factories) goes through the v16 seed too
 * (decision D2-B, "existing charts look unchanged", covers the built-in defaults): a default
 * chart, in a fresh config, a page normalizeConfig adds (the v7 refill of an empty Overview or
 * Campaigns page included), or one "restore default charts" brings back, shows exactly the caveats
 * it showed before v16 (its legacy `notes`) plus any data-cut one whose condition holds, plus any
 * caveat added after v16 (the seed is frozen to V16_SEEDABLE_CAVEATS). A chart the owner creates
 * later is new and shows its automatic caveats. */
function factoryWidgets(list: Widget[]): Widget[] {
  return seedHiddenAutoCaveats(list)
}

function normSeries(raw: any): LineSeries[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: LineSeries[] = raw
    .filter((s: any) => s && typeof s === 'object')
    .map((s: any, i: number) => {
      const filter = Array.isArray(s.filter)
        ? s.filter.filter((f: any) => f && typeof f.field === 'string' && f.field && typeof f.value === 'string').map((f: any) => ({ field: f.field, value: f.value }))
        : []
      return {
        label: typeof s.label === 'string' && s.label.trim() ? s.label : `Series ${i + 1}`,
        ...(filter.length ? { filter } : {}),
        axis: s.axis === 'right' ? ('right' as const) : ('left' as const),
        style: s.style === 'dashed' || s.style === 'dotted' ? s.style : ('solid' as const),
        ...(Number.isInteger(s.color) && s.color >= 0 ? { color: s.color } : {}),
      }
    })
  return out.length ? out : undefined
}
function normAxisTitles(raw: any): { left?: string; right?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const left = typeof raw.left === 'string' && raw.left ? raw.left : undefined
  const right = typeof raw.right === 'string' && raw.right ? raw.right : undefined
  return left || right ? { left, right } : undefined
}

function normPage(p: any, i: number): DashboardPage {
  const id = String(p.id ?? cryptoId())
  const page: DashboardPage = {
    id,
    name: String(p.name ?? `Page ${i + 1}`),
    isDefault: !!p.isDefault,
    group: cleanGroupName(p.group) || builtinGroup(id) || GROUP_MINE,
    filters: normFilters(p.filters),
    widgets: Array.isArray(p.widgets) ? p.widgets.map(normWidget) : defaultWidgets(),
  }
  // Checked again against the other pages in normDrillLinks (it must name an existing root page).
  if (typeof p.parentId === 'string' && p.parentId) page.parentId = p.parentId
  if (typeof p.icon === 'string' && ICON_KEY_RE.test(p.icon)) page.icon = p.icon
  return page
}

// ── Navigation (layout version 13) ─────────────────────────────────────────────────────────
// Page groups, drill-page parents, page icons and group badges. The shared config only ever holds
// short, validated strings for these (never markup or SVG): lib/icons.ts maps an icon key to a
// component and a group name to its badge.
export const GROUP_NAME_MAX = 60
/** A group name as stored: whitespace collapsed, trimmed, capped; '' when there is none. */
export function cleanGroupName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX).trim() : ''
}
/** The longest page name the rename field and the wizard accept. */
export const PAGE_NAME_MAX = 80
/** A page name as typed in: whitespace collapsed, trimmed, capped; '' when there is none. */
export function cleanPageName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, PAGE_NAME_MAX).trim() : ''
}
// An icon registry key: lowercase letters, digits and dashes. A well-formed key the registry does
// not know is kept (it resolves to the generic page icon, lib/icons.ts), so a key added to the
// registry later still works for a config saved before it.
const ICON_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/** How deep drill pages nest: a top-level page is depth 0, its drill pages 1, theirs 2, … A drill
 * made from a page already this deep attaches to its ancestor one level up (lib/nav.ts
 * drillParentFor), and a stored tree deeper than this is re-attached the same way on load. */
export const MAX_DRILL_DEPTH = 8

/** Every load: a drill page's `parentId` must name an existing page other than itself (its
 * IMMEDIATE parent — a drill from a drill page nests under that drill page), the chain of parents
 * must end at a top-level page without looping, and the default page is never a drill page. A
 * missing parent, a self-link or a link that closes a loop is dropped (leaving an ordinary page); a
 * page nested deeper than MAX_DRILL_DEPTH is re-attached to its ancestor at depth
 * MAX_DRILL_DEPTH - 1. Every drill page sits in its top-level page's group. Mutates the (freshly
 * normalised) pages in place. */
export function normDrillLinks(pages: DashboardPage[]): void {
  const byId = new Map(pages.map((p) => [p.id, p] as const))
  // 1) links to nothing, to itself, from the default page, or closing a loop: dropped
  for (const p of pages) {
    if (!p.parentId) continue
    const parent = byId.get(p.parentId)
    if (!parent || parent === p || p.isDefault) {
      delete p.parentId
      continue
    }
    const seen = new Set([p.id])
    let cur: DashboardPage | undefined = parent
    while (cur) {
      if (seen.has(cur.id)) {
        delete p.parentId
        break
      }
      seen.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
  }
  // 2) the ancestors, nearest first (no loops are left)
  const chain = (p: DashboardPage): DashboardPage[] => {
    const out: DashboardPage[] = []
    let cur = p.parentId ? byId.get(p.parentId) : undefined
    while (cur) {
      out.push(cur)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return out
  }
  // 3) too deep: re-attached to the ancestor at depth MAX_DRILL_DEPTH - 1 (only ever lowers depths)
  for (const p of pages) {
    const up = chain(p)
    if (up.length > MAX_DRILL_DEPTH) p.parentId = up[up.length - MAX_DRILL_DEPTH].id
  }
  // 4) a drill page is in its top-level page's group
  for (const p of pages) {
    const up = chain(p)
    if (up.length) p.group = up[up.length - 1].group
  }
}

/** A page name that starts with a known group's name files under that group (layout version 13):
 * "Best Sudoku · Retention" → group "Best Sudoku", name "Retention" (the " · " prefix is dropped,
 * the group segment shows it); "Best Sudoku launch copy" → group "Best Sudoku", name unchanged. The
 * group name must be followed by " · ", another separator, a space or the end (so "Minesweeper" is
 * not "Mine"). Case-insensitive; the longest matching group wins. null = no group prefix. */
export function groupFromName(name: string, groups: readonly string[]): { group: string; name: string } | null {
  const trimmed = name.trim()
  const lower = trimmed.toLowerCase()
  for (const g of [...groups].sort((a, b) => b.length - a.length)) {
    if (!g || !lower.startsWith(g.toLowerCase())) continue
    const rest = trimmed.slice(g.length)
    if (rest === '') return { group: g, name: trimmed }
    const dot = /^\s*·\s*/.exec(rest)
    if (dot) return { group: g, name: rest.slice(dot[0].length).trim() || trimmed }
    if (/^[\s\-–—:/|]/.test(rest)) return { group: g, name: trimmed }
  }
  return null
}

// The pre-v13 tab order (the retired reorderBskGroup, run on every load up to layout version 12):
// the GSS pages first, then the Best Sudoku group in a fixed order, then every other page in its
// existing relative order. The v13 migration applies it ONCE, so the order each viewer saw before
// becomes the stored order; after that the order is data (group order, then array order), never
// re-sorted.
const PRE_V13_GSS_IDS = new Set(['default', 'beacon'])
const PRE_V13_BSK_ORDER = ['bsk-overview', 'bsk-campaigns', 'bsk-popups', 'bsk-launch']
function preV13TabOrder(pages: DashboardPage[]): DashboardPage[] {
  const bskFound = new Map(pages.filter((p) => PRE_V13_BSK_ORDER.includes(p.id)).map((p) => [p.id, p] as const))
  const bsk = PRE_V13_BSK_ORDER.map((id) => bskFound.get(id)).filter((p): p is DashboardPage => !!p)
  const gss = pages.filter((p) => PRE_V13_GSS_IDS.has(p.id))
  const rest = pages.filter((p) => !PRE_V13_GSS_IDS.has(p.id) && !PRE_V13_BSK_ORDER.includes(p.id))
  return [...gss, ...bsk, ...rest]
}
// The Best Sudoku built-ins' known default names (every name a build has given them) → their v13
// name. A built-in the owner renamed to anything else keeps that name (a "Best Sudoku · " prefix is
// still dropped).
const V13_BSK_NAME: Readonly<Record<string, { from: readonly string[]; to: string }>> = Object.freeze({
  'bsk-overview': { from: ['best sudoku overview', 'best sudoku · overview'], to: 'Overview' },
  'bsk-campaigns': { from: ['best sudoku campaigns', 'best sudoku · campaigns'], to: 'Campaigns' },
  'bsk-popups': { from: ['best sudoku pop-ups', 'best sudoku · pop-ups'], to: 'Pop-ups' },
  'bsk-launch': { from: ['best sudoku launch', 'best sudoku · traffic', 'best sudoku traffic'], to: 'Traffic' },
})

/** v13 (once, version-gated): page navigation.
 *  - The pre-v13 tab order becomes the stored order (preV13TabOrder), so nothing moves.
 *  - Built-ins get their group by id (BUILTIN_GROUP): ★ Overview and Beacon "All sites" (★ Overview
 *    is shown pinned first, outside the groups), the four Best Sudoku pages "Best Sudoku", named
 *    Overview, Campaigns, Pop-ups and Traffic.
 *  - Every other page files under the group its name starts with (groupFromName, the " · " prefix
 *    dropped), else "Mine". Existing drill pages are NOT linked to a parent: nothing stored says
 *    which page they came from (their widgets have fresh ids), so they stay ordinary pages in their
 *    group; only drills made from now on are nested.
 *  - Traffic (bsk-launch) gets `icon: "trending-up"`, the one explicit built-in icon (its beacon
 *    charts would otherwise resolve to Beacon's map pin); every other icon stays automatic.
 * Never adds, drops or edits a page's widgets or filters. Returns new page objects. */
export function migrateNavV13(pages: DashboardPage[]): DashboardPage[] {
  const nameGroups = [GROUP_ALL_SITES, GROUP_BEST_SUDOKU, GROUP_MINE]
  return preV13TabOrder(pages).map((p) => {
    const bg = builtinGroup(p.id)
    if (bg) {
      const known = Object.hasOwn(V13_BSK_NAME, p.id) ? V13_BSK_NAME[p.id] : undefined
      let name = p.name
      if (known && known.from.includes(name.trim().toLowerCase())) name = known.to
      else {
        const m = groupFromName(name, [bg])
        if (m) name = m.name
      }
      const next: DashboardPage = { ...p, group: bg, name }
      if (p.id === 'bsk-launch' && !next.icon) next.icon = 'trending-up'
      return next
    }
    const m = groupFromName(p.name, nameGroups)
    return { ...p, group: m?.group ?? GROUP_MINE, name: m?.name ?? p.name }
  })
}

// groupMeta (layout version 13): per-group badge overrides, validated on every load because they
// are rendered as a colour and an image source. A colour is a palette slot ("g0"…"g6") or a hex
// colour; a logo is an https: URL, a same-origin path, or a base64 image data URL.
const GROUP_COLOR_RE = /^(?:g[0-6]|#[0-9a-f]{3}|#[0-9a-f]{6})$/i
const GROUP_LOGO_RE = /^(?:https:\/\/[^\s"'<>()\\]{1,2000}|\/(?!\/)[^\s"'<>()\\]{0,2000}|data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]{1,40000})$/
const GROUP_META_MAX = 50
export function normGroupMeta(raw: unknown): Record<string, GroupMeta> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: [string, GroupMeta][] = []
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (out.length >= GROUP_META_MAX) break
    const group = cleanGroupName(k)
    if (!group || group === '__proto__' || !v || typeof v !== 'object') continue
    const m: GroupMeta = {}
    const { color, logo } = v as { color?: unknown; logo?: unknown }
    if (typeof color === 'string' && GROUP_COLOR_RE.test(color)) m.color = color
    if (typeof logo === 'string' && GROUP_LOGO_RE.test(logo)) m.logo = logo
    if (m.color || m.logo) out.push([group, m])
  }
  return out.length ? Object.fromEntries(out) : undefined
}

// groupOrder (layout version 13, additive): the drawer's group order, including groups that have
// no page yet. Stored only when it says more than the pages do (see normGroupOrder).
const GROUP_ORDER_MAX = 50
/** The groups the pages file under, in the order they first appear: every top-level page's group
 * except ★ Overview's (the default page is shown pinned, outside the groups). */
export function pageGroupsOf(pages: readonly DashboardPage[]): string[] {
  const ids = new Set(pages.map((p) => p.id))
  const out: string[] = []
  for (const p of pages) {
    if (p.isDefault || (p.parentId && p.parentId !== p.id && ids.has(p.parentId))) continue
    if (!out.includes(p.group)) out.push(p.group)
  }
  return out
}
/** Every group, in display order: `order` first, then the pages' groups it misses (pageGroupsOf). */
export function unionGroupOrder(order: readonly string[], pages: readonly DashboardPage[]): string[] {
  const out = [...order]
  for (const g of pageGroupsOf(pages)) if (!out.includes(g)) out.push(g)
  return out
}
/** Every load: the stored list sanitised (strings only, cleaned like a group name, no repeats, at
 * most GROUP_ORDER_MAX kept), then every group the pages use that it misses appended in the order
 * they first appear; groups with no page stay listed. undefined when the result is exactly the
 * order the pages give on their own (nothing worth storing). */
export function normGroupOrder(raw: unknown, pages: readonly DashboardPage[]): string[] | undefined {
  const listed: string[] = []
  if (Array.isArray(raw)) {
    for (const x of raw.slice(0, GROUP_ORDER_MAX * 4)) {
      if (listed.length >= GROUP_ORDER_MAX) break
      const g = cleanGroupName(x)
      if (g && !listed.includes(g)) listed.push(g)
    }
  }
  const all = unionGroupOrder(listed, pages)
  const derived = pageGroupsOf(pages)
  return all.length === derived.length && all.every((g, i) => g === derived[i]) ? undefined : all
}

// Normalize a loaded config. Handles v2 (pages), migrates v1 (single page), and
// falls back to factory defaults for anything unrecognized.
export function normalizeConfig(raw: any): DashboardConfig {
  // v2/v3 — already a pages config
  if (raw && typeof raw === 'object' && Array.isArray(raw.pages) && raw.pages.length) {
    const pages = raw.pages.map(normPage)
    if (!pages.some((p: DashboardPage) => p.isDefault)) pages[0].isDefault = true
    // v3 migration: add the "Best Sudoku launch" page ONCE. Gated on version, so if it's
    // later deleted it won't keep coming back.
    if ((Number(raw.version) || 0) < 3 && !pages.some((p: DashboardPage) => p.id === 'bsk-launch')) {
      pages.push(defaultBestSudokuLaunchPage())
    }
    // v4 migration: make the "Best Sudoku launch" page fully beacon-backed. It was often
    // built by duplicating the RUM "Overview" page, so half its charts queried Cloudflare
    // RUM — which has next to no Best Sudoku data (the site is behind Access; the beacon is
    // the real source) — and rendered empty. Re-point every chart at the beacon and filter
    // to the Best Sudoku beacon tags. Runs once (version-gated), so later edits survive.
    if ((Number(raw.version) || 0) < 4) {
      for (const p of pages) {
        if (!isBestSudokuLaunchPage(p)) continue
        p.widgets = p.widgets.map(beaconizeWidget)
        p.filters.siteSel = [...BEST_SUDOKU_SITES]
      }
    }
    // v5 migration: add the "Best Sudoku campaigns" page ONCE. Also backfills "Best Sudoku
    // pop-ups" for anyone who saved a config before it existed — the v4 bump above never
    // itself migrated existing saved configs to add that page, so an already-live dashboard
    // would otherwise never pick it up either. Both gated on version, so a later delete of
    // either page won't keep bringing it back.
    if ((Number(raw.version) || 0) < 5) {
      if (!pages.some((p: DashboardPage) => isBestSudokuPopupsPage(p))) pages.push(defaultBestSudokuPopupsPage())
      if (!pages.some((p: DashboardPage) => isCampaignComparePage(p))) pages.push(defaultCampaignComparePage())
    }
    // v6 migration: add "Best Sudoku overview" ONCE, and put it FIRST — the brief's own
    // requirement, so it reads as the landing page even for an existing saved config.
    if ((Number(raw.version) || 0) < 6 && !pages.some((p: DashboardPage) => isOverviewPage(p))) {
      pages.unshift(defaultOverviewPage())
    }
    // v7 migration: convert the bespoke Overview/Campaigns pages to real widgets (the old
    // OverviewPage.vue/CampaignComparePage.vue renderers are retired; the panel widgets it adds
    // become metric cards and standard charts in the later steps, up to v11). Gated on
    // `widgets.length === 0` rather than only the version number, so it's non-destructive AND
    // idempotent even outside a clean version progression: a page that already has widgets
    // (this migration having already run, or a user who somehow added widgets before this
    // shipped) is left completely alone — never dropped, never re-populated, never duplicated.
    //
    // The page's kind is decided by id alone (since layout version 13 there is no name fallback),
    // so a page is converted as exactly one of 'overview' | 'campaigns' | neither, whatever its name.
    for (const p of pages) {
      if (p.widgets.length !== 0) continue
      if (isOverviewPage(p)) p.widgets = defaultOverviewWidgets()
      else if (isCampaignComparePage(p)) p.widgets = defaultCampaignsWidgets()
    }
    // v8 migration: add the completions breakdown widget (mode × difficulty) to "Best Sudoku
    // overview" ONCE — but ONLY onto a page whose widget set still matches the exact factory
    // v7 output (overviewPageIsUncustomized): a page the owner has already added, removed, or
    // is missing a default chart on keeps its own curation untouched, per the brief's "don't
    // disturb saved layouts" rule. (A brand-new config never hits this branch at all —
    // defaultOverviewWidgets() already includes the completions widget, and the v7 block above
    // populates from it directly when widgets.length === 0.)
    if ((Number(raw.version) || 0) < 8) {
      for (const p of pages) {
        if (isOverviewPage(p) && overviewPageIsUncustomized(p) && !p.widgets.some((w: Widget) => w.dataset === 'completions')) {
          p.widgets = [...p.widgets, completionsWidget(46)]
        }
      }
    }
    // v9 migration (see CONFIG_VERSION): rebuild the Pop-ups page (migratePopupsPageV9) and swap
    // every bespoke campaign device-mix table for the standard nested doughnut
    // (migrateDeviceMixV9). Version-gated, so a later edit is never undone; every other page
    // and widget is left exactly as saved.
    if ((Number(raw.version) || 0) < 9) {
      for (let i = 0; i < pages.length; i++) {
        let p: DashboardPage = pages[i]
        if (isBestSudokuPopupsPage(p)) p = migratePopupsPageV9(p)
        p = migrateDeviceMixV9(p)
        // Page filters are never touched: the swapped timeline carries its own Best Sudoku site
        // override (Widget.siteSel), whatever page it sits on.
        p = migrateTimelineV9(p)
        pages[i] = p
      }
    }
    // v12 migration (see CONFIG_VERSION): the Overview's small-sample note takes one grid row,
    // not three (compactSmallSampleNoteV12). Version-gated, so a later resize is never undone.
    if ((Number(raw.version) || 0) < LAYOUT_VERSIONS.compactNoteRow) {
      for (let i = 0; i < pages.length; i++) pages[i] = compactSmallSampleNoteV12(pages[i])
    }
    // v10 and v11 (see CONFIG_VERSION), run on every load: every former bespoke panel renders as
    // a metric card or a standard chart (migratePanelsV11). Not version-gated, because the bespoke
    // bodies are retired: a panel a stale tab or an older build saves later must be swapped too.
    // Idempotent; it swaps panels in place and never adds, removes or moves a widget.
    for (let i = 0; i < pages.length; i++) pages[i] = migratePanelsV11(pages[i])
    // Self-heal (every load, not version-gated): the canonical pages — Overview, Beacon, and
    // the Best Sudoku launch page — must NEVER carry a persistent page-level drill. Drilling
    // always spawns a NEW page, so a drill sitting on one of these is always erroneous (e.g.
    // a config written straight to KV by an external tool). Left in place it silently filters
    // the whole page down to a value it has no data for, so the page renders empty. Strip it.
    for (const p of pages) {
      const canonical = p.id === 'default' || p.id === 'beacon' || isBestSudokuLaunchPage(p)
      if (canonical && p.filters.drill?.length) p.filters.drill = []
    }
    // Pop-up widget title/caption migration (every load, not version-gated — see
    // migratePopupCaveatTitles): restores the plain generated title on any pop-up widget
    // whose title is STILL EXACTLY the old "name + caveat" string, moving the caveat to a
    // default caption instead. A title the user has since edited never matches, so it's
    // left untouched.
    const withCaptionsMigrated = migratePopupCaveatTitles(pages)
    // v13 migration (see CONFIG_VERSION and migrateNavV13): groups, the Best Sudoku short names,
    // the pre-v13 tab order as the stored order, Traffic's icon. Version-gated, so a later rename,
    // move or reorder is never undone. The order is data from here on: no reorder runs on load.
    const version = Number(raw.version) || 0
    const navigated = version < LAYOUT_VERSIONS.navigation ? migrateNavV13(withCaptionsMigrated) : withCaptionsMigrated
    // v15 migration (see CONFIG_VERSION and migrateDateEtTrendsV15): version-gated, so a chart the
    // owner later sets back to the UTC `date` axis is never moved again.
    const etDays = version < LAYOUT_VERSIONS.dateEtTrends ? navigated.map(migrateDateEtTrendsV15) : navigated
    // v16 migration (see CONFIG_VERSION and seedHiddenAutoCaveatsV16): automatic scope caveats
    // start hidden where a chart did not show them. Version-gated, so a caveat the owner later
    // shows again is never re-hidden. Only the ids frozen in V16_SEEDABLE_CAVEATS are seeded, so a
    // caveat added to the registry later shows on every chart of its scope, even before the first
    // v16 save.
    const ordered = version < LAYOUT_VERSIONS.captions ? etDays.map(seedHiddenAutoCaveatsV16) : etDays
    // Every load: drill links must name an existing root page (normDrillLinks).
    normDrillLinks(ordered)
    // `activePageId` is the landing page for a first-time viewer (each viewer's current page lives
    // in their browser since v13 — lib/viewerPrefs.ts): ★ Overview after the v13 migration, and
    // whenever the stored one no longer exists.
    const pinnedId = (ordered.find((p: DashboardPage) => p.isDefault) ?? ordered[0]).id
    const wanted = version < LAYOUT_VERSIONS.navigation ? pinnedId : raw.activePageId
    const activePageId = ordered.some((p: DashboardPage) => p.id === wanted) ? wanted : pinnedId
    const groupMeta = normGroupMeta(raw.groupMeta)
    const groupOrder = normGroupOrder(raw.groupOrder, ordered)
    return { version: CONFIG_VERSION, activePageId, pages: ordered, syncRange: !!raw.syncRange, ...(groupMeta ? { groupMeta } : {}), ...(groupOrder ? { groupOrder } : {}) }
  }
  // v1 — single page; wrap as the default page
  if (raw && typeof raw === 'object' && Array.isArray(raw.widgets)) {
    const page: DashboardPage = {
      id: 'default',
      name: 'Overview',
      isDefault: true,
      group: GROUP_ALL_SITES,
      filters: normFilters(raw.filters),
      widgets: raw.widgets.map(normWidget),
    }
    return { version: 2, activePageId: 'default', pages: [page] }
  }
  return defaultConfig()
}

export function cryptoId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().slice(0, 8)
  return 'w' + Math.floor(Math.random() * 1e9).toString(36)
}

// Deep-clone a page with fresh ids (for duplication). The copy keeps the source's group and icon,
// and a copy of a drill page stays a drill page of the same parent (its parentId); callers that make
// a new ROOT page (+ Page) or a new drill (App.vue openFilteredPage) set parentId/icon themselves.
export function clonePage(src: DashboardPage, name: string): DashboardPage {
  const id = cryptoId()
  const copy: DashboardPage = {
    id,
    name,
    isDefault: false,
    group: src.group,
    filters: JSON.parse(JSON.stringify(src.filters)),
    widgets: src.widgets.map((wd) => {
      const wid = cryptoId()
      return { ...JSON.parse(JSON.stringify(wd)), id: wid, i: wid }
    }),
  }
  if (src.parentId) copy.parentId = src.parentId
  if (src.icon) copy.icon = src.icon
  return copy
}
