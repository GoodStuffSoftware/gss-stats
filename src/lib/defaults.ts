import type { DashboardConfig, DashboardPage, GlobalFilters, LineSeries, Widget } from '../types'
import { parseDurationMs } from './range'
import { POPUPS, POPUP_RATE_SPECS, NO_OUTCOME_TRACKING_NOTE, SIGNIN_ELIGIBLE_CAVEAT } from './popupEvents'
import { CAMPAIGNS } from './campaigns'
import { BEST_SUDOKU_SITES } from './bestSudokuSites'
import { normCardRef } from './metrics/validate'

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

// Bumped to 10 for metric cards (ADR 0003 slice 5, see migrateCardsV10): the Overview's bespoke
// 'kpis' and 'scorecard' panels gain `card: { preset }` and render as MetricCard; nothing else
// about them changes. functions/api/config.ts backs the stored v9 layout up to
// `dashboard:default:backup:v9` on the first v10 save.
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
export const CONFIG_VERSION = 10

// The default "basic charts available out of the box" — a sensible analytics
// starting layout. Users can move/resize/add/remove from here.
export function defaultWidgets(): Widget[] {
  return [
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
  ]
}

export function defaultPage(): DashboardPage {
  return { id: 'default', name: 'Overview', isDefault: true, filters: defaultFilters(), widgets: defaultWidgets() }
}

// Canonical "Beacon" page — all geo-dataset charts (bot-free region/city/ISP/map).
function gw(p: Omit<Widget, 'i' | 'metric' | 'dataset'>): Widget {
  return { metric: 'pageviews', dataset: 'geo', ...p, i: p.id }
}
export function defaultBeaconWidgets(): Widget[] {
  return [
    gw({ id: 'bcn-views', title: 'Pageviews', type: 'stat', dimension: 'site', limit: 1, x: 0, y: 0, w: 3, h: 3 }),
    gw({ id: 'bcn-visitor', title: 'New vs returning', type: 'doughnut', dimension: 'visitor', limit: 5, x: 0, y: 3, w: 3, h: 6 }),
    gw({ id: 'bcn-trend', title: 'Pageviews over time', type: 'area', dimension: 'date', limit: 90, x: 3, y: 0, w: 9, h: 8 }),
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
  ]
}
export function defaultBeaconPage(): DashboardPage {
  // siteSel [] = all real sites; the multi-select picker narrows it.
  return { id: 'beacon', name: 'Beacon', isDefault: false, filters: defaultFilters(), widgets: defaultBeaconWidgets() }
}

// "Best Sudoku · Traffic" (formerly "Best Sudoku launch") — a beacon page pre-filtered to
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
  return [
    gw({ id: 'bsk-views', title: 'Pageviews', type: 'stat', dimension: 'site', limit: 10, x: 0, y: 0, w: 3, h: 3 }),
    gw({ id: 'bsk-visitor', title: 'New vs returning', type: 'doughnut', dimension: 'visitor', limit: 5, x: 0, y: 3, w: 3, h: 6 }),
    gw({ id: 'bsk-trend', title: 'Visits over time', type: 'area', dimension: 'date', limit: 90, markers: 'releases', x: 3, y: 0, w: 9, h: 8 }),
    gw({ id: 'bsk-ref', title: 'Where they come from (referrers)', type: 'hbar', dimension: 'referrer', limit: 12, x: 0, y: 9, w: 6, h: 8 }),
    gw({ id: 'bsk-refpath', title: 'Which subreddit / section', type: 'hbar', dimension: 'refpath', limit: 12, x: 6, y: 8, w: 6, h: 8 }),
    gw({ id: 'bsk-webapp', title: 'Web vs app', type: 'doughnut', dimension: 'site', limit: 5, x: 0, y: 17, w: 3, h: 7 }),
    gw({ id: 'bsk-device', title: 'Device', type: 'doughnut', dimension: 'device', limit: 6, x: 3, y: 17, w: 3, h: 7 }),
    gw({ id: 'bsk-country', title: 'By country', type: 'hbar', dimension: 'country', limit: 10, x: 6, y: 16, w: 6, h: 8 }),
    gw({ id: 'bsk-region', title: 'By region / state', type: 'hbar', dimension: 'region', limit: 12, x: 0, y: 24, w: 6, h: 8 }),
    gw({ id: 'bsk-city', title: 'Top cities', type: 'hbar', dimension: 'city', limit: 12, x: 6, y: 24, w: 6, h: 8 }),
    gw({ id: 'bsk-path', title: 'Top screens / pages', type: 'hbar', dimension: 'path', limit: 12, x: 0, y: 32, w: 6, h: 8 }),
    gw({ id: 'bsk-map', title: 'Visitor map', type: 'map', dimension: '', limit: 2000, x: 6, y: 32, w: 6, h: 8 }),
  ]
}
// The Best Sudoku beacon site tags (lib/bestSudokuSites.ts, a leaf module), re-exported here.
export { BEST_SUDOKU_SITES }

export function defaultBestSudokuLaunchPage(): DashboardPage {
  return {
    id: 'bsk-launch',
    name: 'Best Sudoku · Traffic',
    isDefault: false,
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
  return [
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
    w({ id: 'pu-rates', title: 'Rates (valid ratios only)', type: 'rateTable', dataset: 'popup', dimension: '', metric: 'pageviews', limit: 1, notes: ['min-cohort-caveat'], x: 0, y: 11, w: 8, h: 7 }),
    w({ id: 'pu-eligible-bd', title: 'Sign-in eligibility', type: 'bar', dataset: 'popup', dimension: 'eligible', metric: 'pageviews', limit: 3, notes: ['signin-eligible-caveat'], x: 8, y: 11, w: 4, h: 7 }),
  ]
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

/** Non-destructive, idempotent, runs on every load (like reorderBskGroup — not version-
 * gated): moves SIGNIN_ELIGIBLE_CAVEAT/NO_OUTCOME_TRACKING_NOTE text that used to be baked
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
    name: 'Best Sudoku · Pop-ups',
    isDefault: false,
    filters: { ...defaultFilters(), siteSel: [...BEST_SUDOKU_SITES] },
    widgets: defaultBestSudokuPopupsWidgets(),
  }
}
export function isBestSudokuPopupsPage(p: DashboardPage): boolean {
  return p.id === 'bsk-popups' || p.name.trim().toLowerCase() === 'best sudoku pop-ups' || p.name.trim().toLowerCase() === 'best sudoku · pop-ups'
}

// "Best Sudoku campaigns" widgets — every panel of the former bespoke
// CampaignComparePage.vue as its own movable/resizable/editable widget (dataset
// 'campaigns'; see components/widgets/CampaignsWidgetBody.vue). campaignIds left
// undefined = all CAMPAIGNS, same as the page's original always-every-campaign behavior.
export function defaultCampaignsWidgets(): Widget[] {
  return [
    w({ id: 'cw-funnel', title: 'Funnel per campaign', type: 'table', dataset: 'campaigns', view: 'funnel', dimension: '', metric: 'pageviews', limit: 1, notes: ['arrivals-caveat', 'min-cohort-caveat'], x: 0, y: 0, w: 12, h: 14 }),
    w({ id: 'cw-hour', title: 'Arrivals by ET hour of day', type: 'table', dataset: 'campaigns', view: 'hourOfDay', dimension: '', metric: 'pageviews', limit: 1, notes: ['arrivals-caveat'], x: 0, y: 14, w: 12, h: 8 }),
    w({ id: 'cw-country', title: 'Arrivals & funnel by country', type: 'table', dataset: 'campaigns', view: 'country', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 22, w: 12, h: 10 }),
    w({ id: 'cw-flightday', title: 'Daily arrivals by flight day', type: 'table', dataset: 'campaigns', view: 'flightDay', dimension: '', metric: 'pageviews', limit: 1, notes: ['arrivals-caveat', 'flight-day-caption'], x: 0, y: 32, w: 12, h: 10 }),
    w({ id: 'cw-cost', title: 'Cost per arrival / auth success', type: 'table', dataset: 'campaigns', view: 'cost', dimension: '', metric: 'pageviews', limit: 1, notes: ['arrivals-caveat', 'spend-source'], x: 0, y: 42, w: 12, h: 9 }),
    deviceMixWidget({ x: 0, y: 51, w: 12, h: 12 }),
    w({ id: 'cw-returns', title: 'Return visits', type: 'table', dataset: 'campaigns', view: 'returns', dimension: '', metric: 'pageviews', limit: 1, notes: ['play-tracking-status', 'return-rate-caption'], x: 0, y: 63, w: 12, h: 11 }),
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
  ]
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
// reference / git history only, no longer mounted by App.vue). Second in the Best Sudoku
// group's tab order.
export function defaultCampaignComparePage(): DashboardPage {
  return { id: 'bsk-campaigns', name: 'Best Sudoku · Campaigns', isDefault: false, filters: defaultFilters(), widgets: defaultCampaignsWidgets() }
}
export function isCampaignComparePage(p: DashboardPage): boolean {
  return p.id === 'bsk-campaigns' || p.name.trim().toLowerCase() === 'best sudoku campaigns' || p.name.trim().toLowerCase() === 'best sudoku · campaigns'
}

// "Best Sudoku overview" (Part C) widgets — every panel of the former bespoke
// OverviewPage.vue as its own movable/resizable/editable widget (dataset 'overview'; see
// components/widgets/OverviewWidgetBody.vue). One widget per panel, reproducing the page's
// original top-to-bottom arrangement.
// Completions breakdown (mode × difficulty) — a plain GENERIC dataset widget (dataset
// 'completions', dimension/breakdown), not a bespoke 'overview' panel — see
// functions/api/completions.ts + lib/catalog.ts COMPLETIONS_DIMENSIONS. Factored into its own
// builder so both defaultOverviewWidgets() (fresh configs) and the v8 migration below (existing
// saved configs) build the EXACT same widget.
function completionsWidget(): Widget {
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
    y: 46,
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

// Metric cards (CONFIG_VERSION 10, ADR 0003 slice 5): the Overview panels a card preset now
// renders. The widget keeps its dataset/view (an older build still recognises it) and gains
// `card: { preset }`; ChartCard renders MetricCard whenever `card` is set.
export const CARD_PRESET_FOR_OVERVIEW_VIEW: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, { kpis: 'bsk-kpis', scorecard: 'campaign-scorecard' }),
)
const CARD_PRESETS_FROM_VIEWS = new Set(Object.values(CARD_PRESET_FOR_OVERVIEW_VIEW))
/** A widget that is (or was) one of those panels — matched by what it IS (dataset + view), on
 * any page, never by its title or its page's name. */
export function isCardPanel(wd: Widget): boolean {
  return wd.dataset === 'overview' && typeof wd.view === 'string' && Object.hasOwn(CARD_PRESET_FOR_OVERVIEW_VIEW, wd.view)
}
/** The panel with its card: adds `card: { preset }` when absent and keeps everything else (id,
 * position, size, title, notes, default mark). A card already set — a preset or a customised
 * spec — is left as it is. Returns the same object when nothing changes. */
export function withCardForView(wd: Widget): Widget {
  if (!isCardPanel(wd) || wd.card) return wd
  return { ...wd, card: { preset: CARD_PRESET_FOR_OVERVIEW_VIEW[wd.view!] } }
}
/** For the chart editor's save: a widget edited INTO one of the panels gets its card; one
 * edited away from them (another overview view) loses the preset card that came with the old
 * view, so it renders as what it now is. */
export function syncCardWithView(wd: Widget): Widget {
  if (isCardPanel(wd)) return withCardForView(wd)
  if (wd.dataset === 'overview' && wd.card && 'preset' in wd.card && CARD_PRESETS_FROM_VIEWS.has(wd.card.preset)) {
    const { card: _drop, ...rest } = wd
    return rest as Widget
  }
  return wd
}
/** v10: every panel on the page gets its card (withCardForView). Idempotent, and never adds,
 * removes or moves a widget, so a panel the owner deleted stays deleted. */
export function migrateCardsV10(page: DashboardPage): DashboardPage {
  if (!page.widgets.some((wd) => withCardForView(wd) !== wd)) return page
  return { ...page, widgets: page.widgets.map(withCardForView) }
}

export function defaultOverviewWidgets(): Widget[] {
  return [
    w({ id: 'ow-note-smallsample', title: 'Small sample', type: 'note', dimension: '', metric: 'pageviews', limit: 1, noteId: 'small-sample', x: 0, y: 0, w: 12, h: 3 }),
    w({ id: 'ow-kpis', title: 'Today at a glance', type: 'table', dataset: 'overview', view: 'kpis', card: { preset: 'bsk-kpis' }, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 3, w: 12, h: 8 }),
    timelineWidget({ x: 0, y: 11, w: 12, h: 12 }),
    w({ id: 'ow-scorecard', title: 'Campaign scorecard', type: 'table', dataset: 'overview', view: 'scorecard', card: { preset: 'campaign-scorecard' }, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 23, w: 12, h: 14 }),
    w({ id: 'ow-release', title: 'Release panel', type: 'table', dataset: 'overview', view: 'releasePanel', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 37, w: 12, h: 9 }),
    completionsWidget(),
  ]
}
// Another bespoke-turned-widget page (see components/OverviewPage.vue — kept for reference /
// git history only, no longer mounted by App.vue), always FIRST among the Best Sudoku group:
// "how is the release going, how is each campaign going, and what's happening right now."
// Uses the global filter's date range for its timeline (the "existing range control"), so —
// unlike the campaign-compare page — it keeps its own real `filters`, seeded to span since
// well before any known Best Sudoku data.
export function defaultOverviewPage(): DashboardPage {
  return {
    id: 'bsk-overview',
    name: 'Best Sudoku · Overview',
    isDefault: false,
    filters: { ...defaultFilters(), since: '2026-01-01T00:00:00.000Z', rangeRel: '' },
    widgets: defaultOverviewWidgets(),
  }
}
export function isOverviewPage(p: DashboardPage): boolean {
  return p.id === 'bsk-overview' || p.name.trim().toLowerCase() === 'best sudoku overview' || p.name.trim().toLowerCase() === 'best sudoku · overview'
}

// The GSS pages (id-identified, always first in tab order — see reorderBskGroup) and the
// Best Sudoku group in its required tab order: Overview, Campaigns, Pop-ups, Launch/Traffic.
// reorderBskGroup is idempotent, so running it over an already-correct list is a no-op —
// applied here too rather than hand-ordering, so defaultConfig() can never drift out of sync
// with what normalizeConfig() enforces on every load.
export function defaultConfig(): DashboardConfig {
  return {
    version: CONFIG_VERSION,
    activePageId: 'bsk-overview',
    pages: reorderBskGroup([defaultPage(), defaultBeaconPage(), defaultOverviewPage(), defaultCampaignComparePage(), defaultBestSudokuPopupsPage(), defaultBestSudokuLaunchPage()]),
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

// The launch page, whether it's the auto-added one (id 'bsk-launch') or one the user
// built by duplicating another page and renaming it.
export function isBestSudokuLaunchPage(p: DashboardPage): boolean {
  return (
    p.id === 'bsk-launch' ||
    p.name.trim().toLowerCase() === 'best sudoku launch' ||
    p.name.trim().toLowerCase() === 'best sudoku · traffic' ||
    p.name.trim().toLowerCase() === 'best sudoku traffic'
  )
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
  const rel = typeof merged.rangeRel === 'string' ? merged.rangeRel : ''
  const ms = rel ? parseDurationMs(rel) : null
  if (ms && ms > 0) {
    const until = new Date()
    merged.since = new Date(until.getTime() - ms).toISOString()
    merged.until = until.toISOString()
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
    // Attached captions (lib/notes.ts) — absent stays absent (no scope-default notes get
    // injected for a widget that predates this feature; see ChartCard.vue's own comment).
    notes: Array.isArray(x.notes) ? x.notes.filter((n: any) => typeof n === 'string' && n) : undefined,
    // date-dimension trend charts: release-marker overlay, go-live markers, flight bands.
    markers: x.markers === 'releases' ? 'releases' : undefined,
    goLiveMarkers: x.goLiveMarkers === true || undefined,
    flightBands: x.flightBands === true || undefined,
    // Per-chart site override (Widget.siteSel): site tokens only.
    siteSel: Array.isArray(x.siteSel) ? x.siteSel.filter((t: any) => typeof t === 'string' && /^[a-z0-9.\-]{1,60}$/i.test(t)) : undefined,
    // Series line chart (Widget.series): label + optional field=value filters + axis/style.
    series: normSeries(x.series),
    axisTitles: normAxisTitles(x.axisTitles),
    x: Number(x.x) || 0,
    y: Number(x.y) || 0,
    w: Number(x.w) || 4,
    h: Number(x.h) || 8,
  }
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
  return {
    id: String(p.id ?? cryptoId()),
    name: String(p.name ?? `Page ${i + 1}`),
    isDefault: !!p.isDefault,
    filters: normFilters(p.filters),
    widgets: Array.isArray(p.widgets) ? p.widgets.map(normWidget) : defaultWidgets(),
  }
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
    // v7 migration: convert the bespoke Overview/Campaigns pages to real widgets (see
    // components/widgets/OverviewWidgetBody.vue / CampaignsWidgetBody.vue — the old
    // OverviewPage.vue/CampaignComparePage.vue bespoke renderers are retired). Gated on
    // `widgets.length === 0` rather than only the version number, so it's non-destructive AND
    // idempotent even outside a clean version progression: a page that already has widgets
    // (this migration having already run, or a user who somehow added widgets before this
    // shipped) is left completely alone — never dropped, never re-populated, never duplicated.
    //
    // Decide the page's kind ONCE, by id FIRST: isOverviewPage/isCampaignComparePage also
    // match by NAME as a fallback (for a page that predates the id-based canonical scheme),
    // so a page id'd 'bsk-campaigns' but somehow named "Best Sudoku overview" (stale/manual
    // edit) used to match BOTH predicates — the id branch ran first, got real widgets, then
    // the name-fallback branch's `widgets.length === 0` check was already false, silently
    // skipping it, so a campaigns-id'd page ended up with OVERVIEW widgets. Resolving to a
    // single `kind` per page (id checked before name, mutually exclusive) makes that
    // impossible: a page is converted as exactly one of 'overview' | 'campaigns' | neither.
    for (const p of pages) {
      if (p.widgets.length !== 0) continue
      const kind: 'overview' | 'campaigns' | null =
        p.id === 'bsk-overview'
          ? 'overview'
          : p.id === 'bsk-campaigns'
            ? 'campaigns'
            : isOverviewPage(p)
              ? 'overview'
              : isCampaignComparePage(p)
                ? 'campaigns'
                : null
      if (kind === 'overview') p.widgets = defaultOverviewWidgets()
      else if (kind === 'campaigns') p.widgets = defaultCampaignsWidgets()
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
          p.widgets = [...p.widgets, completionsWidget()]
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
    // v10 (see CONFIG_VERSION), run on every load: the Overview's 'kpis' and 'scorecard' panels
    // render as metric cards (migrateCardsV10). Not version-gated, because their bespoke bodies
    // are retired: a panel added later (the chart editor still offers both views) must get its
    // card too. Idempotent; it only ever adds `card` to those panels.
    for (let i = 0; i < pages.length; i++) pages[i] = migrateCardsV10(pages[i])
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
    // Tab-order reorder + rename (every load, not version-gated — see reorderBskGroup):
    // GSS pages first, then the Best Sudoku group in fixed order (Overview, Campaigns,
    // Pop-ups, Launch/Traffic), then every user-created page in its existing relative
    // order. Pure reordering + a consistent-name rename — never drops, renames, or edits
    // a widget.
    const ordered = reorderBskGroup(withCaptionsMigrated)
    const activePageId = ordered.some((p: DashboardPage) => p.id === raw.activePageId) ? raw.activePageId : ordered[0].id
    return { version: CONFIG_VERSION, activePageId, pages: ordered, syncRange: !!raw.syncRange }
  }
  // v1 — single page; wrap as the default page
  if (raw && typeof raw === 'object' && Array.isArray(raw.widgets)) {
    const page: DashboardPage = {
      id: 'default',
      name: 'Overview',
      isDefault: true,
      filters: normFilters(raw.filters),
      widgets: raw.widgets.map(normWidget),
    }
    return { version: 2, activePageId: 'default', pages: [page] }
  }
  return defaultConfig()
}

// ── Tab order (Part D): GSS tab(s) first, then the Best Sudoku group together, in a fixed
// order, then every user-created page in its existing relative order. Idempotent (running it
// twice — or over an already-correct list, e.g. a fresh defaultConfig()) produces the exact
// same order) and non-destructive: it only ever reorders + renames pages, it never adds,
// drops, or touches a page's widgets/filters. ────────────────────────────────────────────
const GSS_PAGE_IDS = new Set(['default', 'beacon'])
const BSK_PAGE_ORDER = ['bsk-overview', 'bsk-campaigns', 'bsk-popups', 'bsk-launch']
// Old default names this migration will rename FROM, so a page the user deliberately
// renamed to something else entirely is left alone (only its position changes).
const BSK_RENAME: Record<string, { from: string[]; to: string }> = {
  'bsk-overview': { from: ['best sudoku overview', 'best sudoku · overview'], to: 'Best Sudoku · Overview' },
  'bsk-campaigns': { from: ['best sudoku campaigns', 'best sudoku · campaigns'], to: 'Best Sudoku · Campaigns' },
  'bsk-popups': { from: ['best sudoku pop-ups', 'best sudoku · pop-ups'], to: 'Best Sudoku · Pop-ups' },
  'bsk-launch': { from: ['best sudoku launch', 'best sudoku · traffic', 'best sudoku traffic'], to: 'Best Sudoku · Traffic' },
}
function renameBskPage(p: DashboardPage): DashboardPage {
  const r = BSK_RENAME[p.id]
  if (!r) return p
  const cur = p.name.trim().toLowerCase()
  if (cur === r.to.toLowerCase()) return p // already the consistent name — no-op
  if (!r.from.includes(cur)) return p // user renamed it to something else — leave it
  return { ...p, name: r.to }
}
export function reorderBskGroup(pages: DashboardPage[]): DashboardPage[] {
  const renamed = pages.map(renameBskPage)
  const isBsk = (p: DashboardPage) => BSK_PAGE_ORDER.includes(p.id)
  const gss = renamed.filter((p) => GSS_PAGE_IDS.has(p.id))
  const bskFound = new Map(renamed.filter(isBsk).map((p) => [p.id, p]))
  const bsk = BSK_PAGE_ORDER.map((id) => bskFound.get(id)).filter((p): p is DashboardPage => !!p)
  const rest = renamed.filter((p) => !GSS_PAGE_IDS.has(p.id) && !isBsk(p))
  const next = [...gss, ...bsk, ...rest]
  // Idempotency fast-path: if nothing moved or was renamed, return the ORIGINAL array (same
  // page objects) rather than a freshly-built one, so an already-ordered config round-trips
  // with no spurious diff.
  if (next.length === pages.length && next.every((p, i) => p === pages[i])) return pages
  return next
}

export function cryptoId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().slice(0, 8)
  return 'w' + Math.floor(Math.random() * 1e9).toString(36)
}

// Deep-clone a page with fresh ids (for duplication).
export function clonePage(src: DashboardPage, name: string): DashboardPage {
  const id = cryptoId()
  return {
    id,
    name,
    isDefault: false,
    filters: JSON.parse(JSON.stringify(src.filters)),
    widgets: src.widgets.map((wd) => {
      const wid = cryptoId()
      return { ...JSON.parse(JSON.stringify(wd)), id: wid, i: wid }
    }),
  }
}
