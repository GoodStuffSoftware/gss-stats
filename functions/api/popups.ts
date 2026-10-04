/// <reference types="@cloudflare/workers-types" />
//
// Pop-up funnel dataset — Best Sudoku sign-in prompt / first-50 promo / upsell /
// install / outcome beacons, aggregated into shown/accept/dismiss counts, reason
// breakdowns, US-Eastern day trends and rates. Reads the same D1 `hits` table as
// /api/geo, classifying `path` via ../../src/lib/popupEvents.ts instead of treating it
// as a page view.
//
// ANONYMOUS AGGREGATES ONLY: every response is a count or a rate. This endpoint never
// returns or joins an individual row, and never correlates rows by timestamp, location
// or device — there is no visitor id in `hits` and none is added here. The one D1 query
// below groups by (UTC hour bucket, path) purely so lib/popupEvents can map each bucket
// to its correct America/New_York calendar day (see etDateFromMs) — it is still a
// COUNT(*) GROUP BY, not a row fetch.
//
// POST { dimension, since, until, sites?, popup?, kind?, limit?, excludeOwnVisits?, ownBrowser?, ownOS? }
//   dimension:
//     'kind'           — shown/accept/dismiss counts for `popup` (required)
//     'reason'         — reason/platform breakdown for `popup` + `kind` (default 'shown')
//     'date'           — US-Eastern day trend for `popup` + `kind` (default 'shown')
//     'outcome'        — popup-outcome counts (signed-in/installed/returned/still-playing) for `popup`
//     'installOutcome' — install's real-outcome counts (no popup needed)
// (The rate table ('rates') and sign-in eligibility ('eligible') are metric cards since layout
// version 11 — presets popup-rates and signin-eligibility over POST /api/metrics — and a single rate
// ('rate') is a one-item metric card since layout version 18. Asking for any of them is a 400 naming
// the card, not a silent fallback to 'kind', so a tab loaded before the update shows an error on
// those panels instead of "No data".)

import {
  POPUPS,
  POPUP_OUTCOME_TYPES,
  TRACKING_ACTIVATION_DATE_ET,
  aggregatePopupRows,
  dayCounts,
  installOutcomeGapNote,
  INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
  INSTALL_GAP_OUTCOME_KEY,
  measuredCoarseCount,
  measuredDetailedBreakdown,
  measuredDetailedCount,
  popupIncludeClause,
  type HourPathCount,
} from '../../src/lib/popupEvents'
import { WHEN_RE, SITE_TAG_RE } from '../../src/lib/range'
import { excludeOwnClause } from '../../src/lib/ownExclusion'
import { MAX_SITES, statementTooLarge } from '../../src/lib/queryLimits'
import { refusedPathExcludeClause } from '../../src/lib/splitGuard'

interface Env {
  gss_geo: D1Database
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

function safeDate(v: unknown, fallback: string): string {
  return typeof v === 'string' && WHEN_RE.test(v) ? v : fallback
}
const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

const POPUP_DIMS = new Set(['kind', 'reason', 'date', 'outcome', 'installOutcome'])
const POPUP_IDS = new Set(POPUPS.map((p) => p.id))
/** Dimensions retired in layout version 11 ('rates', 'eligible') and 18 ('rate'), with the card that replaced each. */
export const RETIRED_POPUP_DIMS: Record<string, string> = { rates: 'Pop-up rates', eligible: 'Sign-in eligibility', rate: 'Pop-up rate' }

type Row = { key: Record<string, string>; pageviews: number; visits: number }
const countedTotals = (rows: Row[]) => {
  const total = rows.reduce((a, r) => a + r.pageviews, 0)
  return { pageviews: total, visits: total }
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: any
  try {
    body = await ctx.request.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  if (!ctx.env.gss_geo) return json({ error: 'geo DB not bound' }, 500)

  if (typeof body.dimension === 'string' && Object.hasOwn(RETIRED_POPUP_DIMS, body.dimension)) {
    const card = RETIRED_POPUP_DIMS[body.dimension]
    return json({ error: `The "${body.dimension}" pop-up dimension was retired; it is the "${card}" card now. Reload the page to update this dashboard.`, retired: body.dimension }, 400)
  }
  const dim: string = POPUP_DIMS.has(body.dimension) ? body.dimension : 'kind'
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 500)
  const today = new Date().toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
  const since = safeDate(body.since, weekAgo)
  const until = safeDate(body.until, today)
  const sinceMs = Date.parse(since)
  const untilMs = isDateOnly(until) ? Date.parse(until) + 86_400_000 : Date.parse(until)

  const rawSites: unknown[] = Array.isArray(body.sites) ? body.sites : body.site != null ? [body.site] : []
  // Same cap functions/api/geo.ts enforces (src/lib/queryLimits.ts MAX_SITES) — a clear 400
  // BEFORE building the query, not a raw D1 error after `site IN (...)` grows past its bind
  // budget. This endpoint had no cap at all until the 2026-09-27 D1 bind-ceiling review round:
  // an oversized `sites` array here fell through to the generic try/catch below as a 500,
  // never naming what to change. See that commit's message for the full finding.
  if (rawSites.length > MAX_SITES) return json({ error: `too many sites (at most ${MAX_SITES})` }, 400)
  const sites = rawSites.filter((s): s is string => typeof s === 'string' && s !== 'all' && SITE_TAG_RE.test(s))

  const popup = typeof body.popup === 'string' && POPUP_IDS.has(body.popup) ? body.popup : ''
  const kind = typeof body.kind === 'string' && /^[a-z0-9-]{1,30}$/i.test(body.kind) ? body.kind : ''

  // One aggregate query fetches every popup-event row in range, grouped by UTC hour
  // bucket + path (see file header — this stays an aggregate, never a row fetch).
  const w: string[] = ['ts >= ?', 'ts < ?']
  const b: any[] = [sinceMs, untilMs]
  if (sites.length) {
    w.push(`site IN (${sites.map(() => '?').join(', ')})`)
    b.push(...sites)
  }
  // "Hide my own visits" — the same browser+OS exclusion /api/geo applies, so the pop-up bar
  // chart (geo), the rate table and the eligibility counts (both here) always agree.
  excludeOwnClause(w, b, body.excludeOwnVisits === true, body.ownBrowser, body.ownOS)
  const inc = popupIncludeClause()
  w.push(inc.sql)
  b.push(...inc.binds)
  // Counts-only rule (src/lib/splitGuard.ts): this query buckets by UTC hour, so the rows the rule
  // protects (returns, game starts and completions, tutorial completions, tour exits) stay out of
  // it. None is a pop-up event (lib/popupEvents.ts classifyPopupPath), so no count changes.
  refusedPathExcludeClause(w, b)

  // `pf` splits each hour bucket row-exactly at the install fix instant (lib/popupEvents.ts
  // INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS), so pre-fix gap rows stay unmeasured without
  // dropping post-fix rows that share their hour.
  const fixAt = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS
  const pfSql = fixAt === null ? '0' : '(ts >= ?)'
  const sql = `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, ${pfSql} AS pf, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY hr, path, pf`
  const allBinds = [...(fixAt === null ? [] : [fixAt]), ...b]
  // Same D1-bound-parameter guard functions/api/geo.ts applies (src/lib/queryLimits.ts) — a
  // clear 400 naming what to change, never a raw D1 error surfacing as the generic 500 below.
  const tooLarge = statementTooLarge(sql, allBinds.length)
  if (tooLarge) return tooLarge
  let res: any
  try {
    res = await ctx.env.gss_geo.prepare(sql).bind(...allBinds).all()
  } catch (e) {
    return json({ error: 'd1 query failed', detail: String(e) }, 500)
  }
  const rows: HourPathCount[] = (res.results ?? []).map((r: any) => ({
    hourStartMs: Number(r.hr) * 3_600_000,
    path: String(r.path ?? ''),
    count: Number(r.c) || 0,
    postInstallFix: Number(r.pf) === 1,
  }))
  const range = { startMs: sinceMs, endMs: untilMs }
  const agg = aggregatePopupRows(rows)
  // While TRACKING_ACTIVATION_DATE_ET is null, tracking hasn't shipped yet: every count
  // dimension below (except 'date', which plots full history with a marker) reads the
  // activation-gated `measured*` helpers, so they're empty and the frontend shows "not
  // yet active" instead of a real-looking (but pre-release) chart — see
  // lib/popupEvents.ts TRACKING_ACTIVATION_DATE_ET / isPreActivation.
  const meta = {
    since,
    until,
    sites: sites.length ? sites.join(',') : 'all',
    dimensions: [dim],
    metric: 'pageviews' as const,
    dataset: 'popup' as const,
    activationDate: TRACKING_ACTIVATION_DATE_ET,
    activationPending: TRACKING_ACTIVATION_DATE_ET === null,
    // Rows under /popup-outcome/ with an unrecognized <popup> name (e.g. first50-congrats,
    // which has no outcome tracking by product decision, or a genuinely unknown wire name)
    // — never silently dropped, only surfaced when present. See lib/popupEvents.ts
    // PopupAggregate.unexpectedOutcomeRows.
    ...(agg.unexpectedOutcomeRows ? { unexpectedOutcomeRows: agg.unexpectedOutcomeRows } : {}),
  }

  // ── Install's real-outcome counts (pwa-installed / standalone-detected / play-detected)
  // — activation-gated ────────────────────────────────────────────────────────────────
  if (dim === 'installOutcome') {
    const rowsOut: Row[] = ['pwa-installed', 'standalone-detected', 'play-detected'].map((k) => {
      const c = measuredDetailedCount(agg, 'install', 'outcome', k)
      return { key: { installOutcome: k }, pageviews: c, visits: c }
    })
    const gapNote = installOutcomeGapNote(range)
    return json({ rows: rowsOut, totals: countedTotals(rowsOut), ...(gapNote ? { note: `${INSTALL_GAP_OUTCOME_KEY}: ${gapNote}` } : {}), meta })
  }

  // Everything else needs a known popup family.
  if (!popup) return json({ rows: [], totals: { pageviews: 0, visits: 0 }, meta })

  // 'kind' (shown/accept/dismiss) is the summary count widget for a popup — activation-gated.
  if (dim === 'kind') {
    const rowsOut: Row[] = ['shown', 'accept', 'dismiss'].map((k) => {
      const c = measuredCoarseCount(agg, popup, k)
      return { key: { kind: k }, pageviews: c, visits: c }
    })
    return json({ rows: rowsOut, totals: countedTotals(rowsOut), meta })
  }

  // 'outcome' — activation-gated. Reads the shared POPUP_OUTCOME_TYPES list (not a
  // hardcoded copy) so a new outcome type (e.g. 'still-playing') never has to be added in
  // two places again.
  if (dim === 'outcome') {
    const family = `popup-outcome:${popup}`
    const rowsOut: Row[] = POPUP_OUTCOME_TYPES.map((o) => {
      const c = measuredCoarseCount(agg, family, o)
      return { key: { outcome: o }, pageviews: c, visits: c }
    })
    const note = popup === 'install' && installOutcomeGapNote(range) ? { note: `installed: ${installOutcomeGapNote(range)}` } : {}
    return json({ rows: rowsOut, totals: countedTotals(rowsOut), ...note, meta })
  }

  // 'reason' — activation-gated.
  if (dim === 'reason') {
    const k = kind || 'shown'
    const rowsOut: Row[] = measuredDetailedBreakdown(agg, popup, k)
      .map(([reason, c]) => ({ key: { reason }, pageviews: c, visits: c }))
      .sort((a, b) => b.pageviews - a.pageviews)
      .slice(0, limit)
    return json({ rows: rowsOut, totals: countedTotals(rowsOut), meta })
  }

  // dim === 'date' — US-Eastern-bucketed trend for `popup` + `kind` (default 'shown').
  // INTENTIONALLY stays full-history (dayCounts, not activation-gated): the trend chart
  // plots every day and marks/de-emphasizes the pre-activation portion itself (see
  // lib/charts.ts activationMarkerIndex), so blanking it here would just hide the
  // "before" half of the very picture that marker draws.
  const k = kind || 'shown'
  const rowsOut: Row[] = dayCounts(agg, popup, k)
    .map(([date, c]) => ({ key: { date }, pageviews: c, visits: c }))
    .sort((a, b) => (a.key.date < b.key.date ? -1 : a.key.date > b.key.date ? 1 : 0))
  return json({ rows: rowsOut, totals: countedTotals(rowsOut), meta })
}

export const onRequestGet: PagesFunction = async () =>
  json({ ok: true, hint: 'POST a popup query: { dimension, popup, since, until }' })
