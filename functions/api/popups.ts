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
// POST { dimension, since, until, sites?, popup?, kind?, rateKey?, limit? }
//   dimension:
//     'kind'           — shown/accept/dismiss counts for `popup` (required)
//     'reason'         — reason/platform breakdown for `popup` + `kind` (default 'shown')
//     'date'           — US-Eastern day trend for `popup` + `kind` (default 'shown')
//     'outcome'        — popup-outcome counts (signed-in/installed/returned/still-playing) for `popup`
//     'eligible'       — sign-in-eligible earned/capped/unearned counts (no popup needed)
//     'installOutcome' — install's real-outcome counts (no popup needed)
//     'rate'           — one computed rate, selected by `rateKey` (see POPUP_RATE_SPECS)

import {
  POPUPS,
  POPUP_OUTCOME_TYPES,
  POPUP_RATE_SPECS,
  TRACKING_ACTIVATION_DATE_ET,
  aggregatePopupRows,
  computePopupRate,
  dayCounts,
  measuredCoarseCount,
  measuredDetailedBreakdown,
  measuredDetailedCount,
  popupIncludeClause,
  type HourPathCount,
} from '../../src/lib/popupEvents'

interface Env {
  gss_geo: D1Database
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const WHEN_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/
function safeDate(v: unknown, fallback: string): string {
  return typeof v === 'string' && WHEN_RE.test(v) ? v : fallback
}
const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

const POPUP_DIMS = new Set(['kind', 'reason', 'date', 'outcome', 'eligible', 'installOutcome', 'rate'])
const POPUP_IDS = new Set(POPUPS.map((p) => p.id))

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

  const dim: string = POPUP_DIMS.has(body.dimension) ? body.dimension : 'kind'
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 500)
  const today = new Date().toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
  const since = safeDate(body.since, weekAgo)
  const until = safeDate(body.until, today)
  const sinceMs = Date.parse(since)
  const untilMs = isDateOnly(until) ? Date.parse(until) + 86_400_000 : Date.parse(until)

  const rawSites: unknown[] = Array.isArray(body.sites) ? body.sites : body.site != null ? [body.site] : []
  const sites = rawSites.filter((s): s is string => typeof s === 'string' && s !== 'all' && /^[a-z0-9.\-]{1,40}$/i.test(s))

  const popup = typeof body.popup === 'string' && POPUP_IDS.has(body.popup) ? body.popup : ''
  const kind = typeof body.kind === 'string' && /^[a-z0-9-]{1,30}$/i.test(body.kind) ? body.kind : ''
  const rateKey = typeof body.rateKey === 'string' ? body.rateKey : ''

  // One aggregate query fetches every popup-event row in range, grouped by UTC hour
  // bucket + path (see file header — this stays an aggregate, never a row fetch).
  const w: string[] = ['ts >= ?', 'ts < ?']
  const b: any[] = [sinceMs, untilMs]
  if (sites.length) {
    w.push(`site IN (${sites.map(() => '?').join(', ')})`)
    b.push(...sites)
  }
  const inc = popupIncludeClause()
  w.push(inc.sql)
  b.push(...inc.binds)

  const sql = `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY hr, path`
  let res: any
  try {
    res = await ctx.env.gss_geo.prepare(sql).bind(...b).all()
  } catch (e) {
    return json({ error: 'd1 query failed', detail: String(e) }, 500)
  }
  const rows: HourPathCount[] = (res.results ?? []).map((r: any) => ({
    hourStartMs: Number(r.hr) * 3_600_000,
    path: String(r.path ?? ''),
    count: Number(r.c) || 0,
  }))
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
  }

  // ── Rate mode: one computed number, or "insufficient" for a too-small cohort (MIN_COHORT
  // — see lib/popupEvents.ts gateRate), or null for a genuine zero denominator ────────────
  if (dim === 'rate') {
    const spec = POPUP_RATE_SPECS.find((s) => s.key === rateKey)
    const gated = spec ? computePopupRate(agg, spec) : { value: null, insufficientCohort: false }
    return json({ rows: [], totals: { pageviews: 0, visits: 0 }, rate: gated.value, insufficientCohort: gated.insufficientCohort, meta })
  }

  // ── Sign-in eligibility breakdown (earned / capped / unearned) — activation-gated ──
  if (dim === 'eligible') {
    const rowsOut: Row[] = ['earned', 'capped', 'unearned'].map((k) => {
      const c = measuredCoarseCount(agg, 'signin-eligible', k)
      return { key: { eligible: k }, pageviews: c, visits: c }
    })
    return json({ rows: rowsOut, totals: countedTotals(rowsOut), meta })
  }

  // ── Install's real-outcome counts (pwa-installed / standalone-detected / play-detected)
  // — activation-gated ────────────────────────────────────────────────────────────────
  if (dim === 'installOutcome') {
    const rowsOut: Row[] = ['pwa-installed', 'standalone-detected', 'play-detected'].map((k) => {
      const c = measuredDetailedCount(agg, 'install', 'outcome', k)
      return { key: { installOutcome: k }, pageviews: c, visits: c }
    })
    return json({ rows: rowsOut, totals: countedTotals(rowsOut), meta })
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
    return json({ rows: rowsOut, totals: countedTotals(rowsOut), meta })
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
