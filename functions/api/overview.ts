/// <reference types="@cloudflare/workers-types" />
//
// "Best Sudoku overview" dataset (Part C) — today-at-a-glance KPIs, a daily timeline since
// the first Best Sudoku hit, a campaign scorecard, and a release before/after panel. Reads
// the same D1 `hits` table as /api/geo, /api/popups and /api/campaigns; reuses their
// classification/attribution helpers rather than re-deriving them.
//
// ANONYMOUS AGGREGATES ONLY, no joins — every D1 query below is a GROUP BY producing
// counts, never a raw per-row fetch. Time-window boundaries need sub-hour precision (for
// "the same time of day yesterday"), so the KPI query groups by MINUTE (not hour) — still
// an aggregate bucket, just a finer one than /api/popups' hour buckets.
//
// POST { since?, until? }  — since/until scope ONLY the daily timeline (the "existing range
// control" the brief asks it to zoom/range-select with); the KPI and scorecard sections are
// always computed server-side ("today", "yesterday", "last 7 days" in ET).

import {
  CAMPAIGNS,
  applyExclusions,
  campaignAttributionClause,
  computeFunnelCounts,
  costPer,
  etMidnightUtcMs,
  flightDayIndex,
  funnelStepRates,
  parseReturnPath,
  returnVisitRates,
  CAMPAIGN_SPEND,
} from '../../src/lib/campaigns'
import { classifyPopupPath, computeRate, etDateFromMs, TRACKING_ACTIVATION_DATE_ET, POPUPS } from '../../src/lib/popupEvents'
import {
  addEtDays,
  buildKpiTile,
  campaignsFlightingOn,
  computeDelta,
  last7DatesBefore,
  notYetTrackingTile,
  releaseComparisonWindows,
  returnBeaconLiveToday,
  sameTimeWindowMs,
  siteWindowClause,
} from '../../src/lib/overview'
import { latestDatedRelease } from '../../src/lib/releases'

interface Env {
  gss_geo: D1Database
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

// Same beacon site tags lib/defaults.ts's BEST_SUDOKU_SITES uses — duplicated here (a
// Pages Function compiles separately from the app bundle, same reason functions/api/geo.ts
// keeps its own OWN_HOSTS instead of importing from a Vue-side file).
const BEST_SUDOKU_SITES = ['bestsudoku-web', 'bestsudoku', 'bestsudoku-app']

const WHEN_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/
function safeDate(v: unknown, fallback: string): string {
  return typeof v === 'string' && WHEN_RE.test(v) ? v : fallback
}
const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

type Row = { min: number; path: string; visitor: string; campaign: string; c: number }

function isEventPath(path: string): boolean {
  return classifyPopupPath(path) !== null || path.startsWith('/return/')
}
function sumInWindow(rows: Row[], startMs: number, endMs: number, pred: (r: Row) => boolean): number {
  let total = 0
  for (const r of rows) {
    const ms = r.min * 60_000
    if (ms < startMs || ms >= endMs || !pred(r)) continue
    total += r.c
  }
  return total
}
function isReturnD1Plus(path: string): boolean {
  const ev = parseReturnPath(path)
  return !!ev && ev.bucket !== 'd0'
}
function isAuthSuccess(path: string): boolean {
  return path.startsWith('/auth/success/')
}
function isInstallOutcome(path: string): boolean {
  const ev = classifyPopupPath(path)
  return !!ev && ev.family === 'install' && ev.kind === 'outcome'
}
function isPopupShown(path: string): boolean {
  const ev = classifyPopupPath(path)
  return !!ev && ev.kind === 'shown' && POPUPS.some((p) => p.id === ev.family)
}
function isPopupAccept(path: string): boolean {
  const ev = classifyPopupPath(path)
  return !!ev && ev.kind === 'accept' && POPUPS.some((p) => p.id === ev.family)
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: any
  try {
    body = await ctx.request.json()
  } catch {
    body = {}
  }
  if (!ctx.env.gss_geo) return json({ error: 'geo DB not bound' }, 500)
  const db = ctx.env.gss_geo

  const nowMs = Date.now()
  const todayEt = etDateFromMs(nowMs)
  const yesterdayEt = addEtDays(todayEt, -1)
  const last7 = last7DatesBefore(todayEt)
  const earliestKpiDay = last7[last7.length - 1] // 7 days before today
  const kpiRangeStart = etMidnightUtcMs(earliestKpiDay)

  // ── Query 1: today-at-a-glance source rows (minute bucket, path, visitor, campaign) ────
  // siteWindowClause applies exclusions (HIGH review finding, 2026-09-25): Mike's household +
  // lifecycle/email traffic must be filtered here too, the same as the campaign scorecard
  // below — this query feeds every KPI tile. ─────────────────────────────────────────────
  const kpiClause = siteWindowClause(BEST_SUDOKU_SITES, kpiRangeStart, nowMs)
  const sqlKpi = `SELECT CAST(ts / 60000 AS INTEGER) AS min, path, visitor, campaign, COUNT(*) AS c FROM hits WHERE ${kpiClause.sql} GROUP BY min, path, visitor, campaign`

  // ── Query 2: daily timeline since first Best Sudoku hit (or the requested since/until —
  // the "existing range control") — hour bucket is plenty for a DAILY series. Same
  // exclusions requirement as query 1 — this feeds the daily timeline chart. ───────────────
  const since = safeDate(body.since, '2026-01-01') // well before any known Best Sudoku data
  const until = safeDate(body.until, new Date().toISOString())
  const sinceMs = Date.parse(since)
  const untilMs = isDateOnly(until) ? Date.parse(until) + 86_400_000 : Date.parse(until)
  const timelineClause = siteWindowClause(BEST_SUDOKU_SITES, sinceMs, untilMs)
  const sqlTimeline = `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, visitor, campaign, COUNT(*) AS c FROM hits WHERE ${timelineClause.sql} GROUP BY hr, path, visitor, campaign`

  // ── Query 3: first-ever Best Sudoku hit (for the release panel's "before" window cap). ──
  const sqlFirstHit = `SELECT MIN(ts) AS t FROM hits WHERE site IN (${BEST_SUDOKU_SITES.map(() => '?').join(', ')})`
  const bFirstHit = [...BEST_SUDOKU_SITES]

  let rKpi: any, rTimeline: any, rFirstHit: any
  try {
    ;[rKpi, rTimeline, rFirstHit] = await Promise.all([
      db.prepare(sqlKpi).bind(...kpiClause.binds).all(),
      db.prepare(sqlTimeline).bind(...timelineClause.binds).all(),
      db.prepare(sqlFirstHit).bind(...bFirstHit).all(),
    ])
  } catch (e) {
    return json({ error: 'd1 query failed', detail: String(e) }, 500)
  }

  const kpiRows: Row[] = (rKpi.results ?? []).map((x: any) => ({
    min: Number(x.min) || 0,
    path: String(x.path ?? ''),
    visitor: String(x.visitor ?? ''),
    campaign: String(x.campaign ?? ''),
    c: Number(x.c) || 0,
  }))

  // ── 1. TODAY AT A GLANCE ────────────────────────────────────────────────────────────────
  const todayWindow: [number, number] = [etMidnightUtcMs(todayEt), nowMs]
  // DST-safe (HIGH review finding, 2026-09-25): derives each comparison day's end from ITS
  // OWN midnight plus today's wall-clock time, not a millisecond span reused across days —
  // see lib/overview.ts sameTimeWindowMs's doc comment.
  const yesterdayWindow: [number, number] = sameTimeWindowMs(yesterdayEt, nowMs)
  const avg7Windows = last7.map((d): [number, number] => sameTimeWindowMs(d, nowMs))

  function windowed(pred: (r: Row) => boolean): { today: number; yesterday: number; avg7: number } {
    const today = sumInWindow(kpiRows, todayWindow[0], todayWindow[1], pred)
    const yesterday = sumInWindow(kpiRows, yesterdayWindow[0], yesterdayWindow[1], pred)
    const avg7 = avg7Windows.reduce((a, [s, e]) => a + sumInWindow(kpiRows, s, e, pred), 0) / 7
    return { today, yesterday, avg7 }
  }

  const kpis: any[] = []
  {
    const w = windowed((r) => !isEventPath(r.path))
    kpis.push(buildKpiTile('pageviews', 'Page views', w.today, w.yesterday, w.avg7))
  }
  {
    const flighting = campaignsFlightingOn(todayEt)
    if (!flighting.length) {
      kpis.push({ key: 'taggedArrivals', label: 'Tagged arrivals', noCampaignFlighting: true })
    } else {
      for (const c of flighting) {
        const w = windowed((r) => r.visitor === 'new' && c.ucValues.includes(r.campaign))
        kpis.push({ ...buildKpiTile(`arrivals-${c.id}`, `Tagged arrivals — ${c.label}`, w.today, w.yesterday, w.avg7), campaignId: c.id })
      }
    }
  }
  {
    const w = windowed((r) => r.path === '/game')
    kpis.push(buildKpiTile('played', 'Games played', w.today, w.yesterday, w.avg7))
  }
  kpis.push(notYetTrackingTile('completed', 'Games completed')) // no matching path anywhere in D1 — see lib/campaigns.ts
  {
    const shown = windowed((r) => isPopupShown(r.path))
    const accept = windowed((r) => isPopupAccept(r.path))
    kpis.push(buildKpiTile('popupShown', 'Pop-ups shown', shown.today, shown.yesterday, shown.avg7))
    kpis.push(buildKpiTile('popupAccept', 'Pop-ups accepted', accept.today, accept.yesterday, accept.avg7))
    kpis.push({
      key: 'popupTapRate',
      label: 'Pop-up tap rate',
      today: computeRate(accept.today, shown.today), // null ("—"/"too few", never 0%/NaN — see MIN_COHORT
      denominator: shown.today, // lets the UI tell "too few to report" apart from "—"
      numerator: accept.today, // shown next to the rate — see SMALL_SAMPLE_NOTE
      notYetTracking: false,
      isRate: true,
    })
  }
  {
    const w = windowed((r) => isAuthSuccess(r.path))
    kpis.push(buildKpiTile('authSuccess', 'Auth successes', w.today, w.yesterday, w.avg7))
  }
  {
    const w = windowed((r) => isInstallOutcome(r.path))
    kpis.push(buildKpiTile('install', 'Installs', w.today, w.yesterday, w.avg7))
  }
  if (!returnBeaconLiveToday()) {
    kpis.push(notYetTrackingTile('returns', '/return/ d1+ returns'))
  } else {
    const w = windowed((r) => isReturnD1Plus(r.path))
    kpis.push(buildKpiTile('returns', '/return/ d1+ returns', w.today, w.yesterday, w.avg7))
  }

  // ── 2. OVERALL TIMELINE (daily ET series) ───────────────────────────────────────────────
  const timelineRows: Row[] = (rTimeline.results ?? []).map((x: any) => ({
    min: (Number(x.hr) || 0) * 60, // reuse the same `min` field/sumInWindow helper (hr*3600000 === (hr*60)*60000)
    path: String(x.path ?? ''),
    visitor: String(x.visitor ?? ''),
    campaign: String(x.campaign ?? ''),
    c: Number(x.c) || 0,
  }))
  const dailyMap = new Map<string, { pageviews: number; taggedArrivals: number; authSuccess: number; install: number }>()
  for (const r of timelineRows) {
    const ms = r.min * 60_000
    const d = etDateFromMs(ms)
    const bucket = dailyMap.get(d) ?? { pageviews: 0, taggedArrivals: 0, authSuccess: 0, install: 0 }
    if (!isEventPath(r.path)) bucket.pageviews += r.c
    if (r.visitor === 'new' && r.campaign) bucket.taggedArrivals += r.c
    if (isAuthSuccess(r.path)) bucket.authSuccess += r.c
    if (isInstallOutcome(r.path)) bucket.install += r.c
    dailyMap.set(d, bucket)
  }
  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, v]) => ({ date, ...v }))

  // Overlay data for the timeline chart: campaign flights (shaded bands), release markers,
  // and the tracking-activation marker — all config-driven, no extra queries needed.
  const campaignFlights = CAMPAIGNS.map((c) => ({ id: c.id, label: c.label, flightStart: c.flightStart, flightEnd: c.flightEnd, status: c.status }))
  const releaseMarkers = latestDatedRelease() ? [latestDatedRelease()] : [] // see releasePanel below for "no dated release yet"

  // ── 3. CAMPAIGN SCORECARD ───────────────────────────────────────────────────────────────
  const scorecard = await Promise.all(
    CAMPAIGNS.map(async (c) => {
      const attr = campaignAttributionClause(c)
      const w1: string[] = [attr.sql]
      const b1: unknown[] = [...attr.binds]
      applyExclusions(w1, b1)
      const sql1 = `SELECT path, visitor, COUNT(*) AS cnt FROM hits WHERE ${w1.join(' AND ')} GROUP BY path, visitor`

      const w2: string[] = ['site = ?', `(${c.ucValues.map(() => 'path LIKE ?').join(' OR ')})`]
      const b2: unknown[] = ['bestsudoku-web', ...c.ucValues.map((u) => `/return/${u}/%`)]
      applyExclusions(w2, b2)
      const sql2 = `SELECT path, COUNT(*) AS cnt FROM hits WHERE ${w2.join(' AND ')} GROUP BY path`

      const [r1, r2] = await Promise.all([db.prepare(sql1).bind(...b1).all(), db.prepare(sql2).bind(...b2).all()])
      const rows1 = (r1.results ?? []).map((x: any) => ({ path: String(x.path ?? ''), visitor: String(x.visitor ?? ''), c: Number(x.cnt) || 0 }))
      const taggedArrivals = rows1.filter((r) => r.visitor === 'new').reduce((a, r) => a + r.c, 0)
      const counts = computeFunnelCounts(
        rows1.map((r) => ({ path: r.path, count: r.c })),
        taggedArrivals,
      )
      // Simplified vs /api/campaigns.ts: uses the GLOBAL not-instrumented set only (skips the
      // extra per-flight "did this path exist site-wide during the window" query) — a leaner
      // scorecard read; the campaign's own page (/api/campaigns) is the source of truth.
      const rates = funnelStepRates(counts)

      const returnCounts = Object.fromEntries(['d0', 'd1', 'd2-7', 'd8-14', 'd15-30', 'd31-60'].map((b) => [b, 0])) as Record<string, number>
      for (const x of r2.results ?? []) {
        const ev = parseReturnPath(String(x.path ?? ''))
        if (ev && c.ucValues.includes(ev.uc)) returnCounts[ev.bucket] += Number(x.cnt) || 0
      }
      const returnRates = returnVisitRates(returnCounts as any)
      const spend = CAMPAIGN_SPEND[c.id] ?? null
      // flightStart is nullable (a not-yet-confirmed flight, e.g. the retest — see
      // lib/campaigns.ts CAMPAIGNS) — there's no day count to report until it's set.
      const flightDays = c.flightStart == null ? null : Math.round((etMidnightUtcMs(c.flightEnd) - etMidnightUtcMs(c.flightStart)) / 86_400_000) + 1
      const dayIndexToday = flightDayIndex(c, todayEt)

      return {
        id: c.id,
        label: c.label,
        status: c.status,
        flightStart: c.flightStart,
        flightEnd: c.flightEnd,
        flightDays,
        flightingToday: dayIndexToday !== null,
        taggedArrivals,
        funnelRates: rates,
        funnelCounts: counts, // lets the UI tell "too few to report" (MIN_COHORT) apart from "—"
        authSuccess: counts.authSuccess,
        install: counts.install,
        returnRateD2to7: returnRates['d2-7'],
        returnD0: returnCounts.d0, // same reason as funnelCounts, for returnRateD2to7
        returnD2to7: returnCounts['d2-7'], // numerator for returnRateD2to7 — see SMALL_SAMPLE_NOTE
        costPerArrival: costPer(spend, taggedArrivals),
      }
    }),
  )

  // ── 4. RELEASE PANEL ─────────────────────────────────────────────────────────────────────
  const firstHitMs = Number(rFirstHit.results?.[0]?.t) || nowMs
  const firstHitEt = etDateFromMs(firstHitMs)
  const latest = latestDatedRelease()
  let releasePanel: any = null
  if (latest) {
    const windows = releaseComparisonWindows(latest.dateEt, firstHitEt, nowMs)
    if (windows) {
      // siteWindowClause applies exclusions (HIGH review finding, 2026-09-25): a before/after
      // comparison is exactly where uneven household/lifecycle traffic on either side of the
      // release date would bias the delta — same requirement as queries 1/2 above and the
      // scorecard. ────────────────────────────────────────────────────────────────────────
      const releaseWindowQuery = (startMs: number, endMs: number) => {
        const clause = siteWindowClause(BEST_SUDOKU_SITES, startMs, endMs)
        const sql = `SELECT path, visitor, campaign, COUNT(*) AS c FROM hits WHERE ${clause.sql} GROUP BY path, visitor, campaign`
        return db.prepare(sql).bind(...clause.binds).all()
      }
      const [beforeRes, afterRes] = await Promise.all([
        releaseWindowQuery(windows.before[0], windows.before[1]),
        releaseWindowQuery(windows.after[0], windows.after[1]),
      ])
      const summarize = (res: any) => {
        const rows = (res.results ?? []).map((x: any) => ({ path: String(x.path ?? ''), visitor: String(x.visitor ?? ''), campaign: String(x.campaign ?? ''), c: Number(x.c) || 0 }))
        let pageviews = 0, taggedArrivals = 0, authSuccess = 0, install = 0
        for (const r of rows) {
          if (!isEventPath(r.path)) pageviews += r.c
          if (r.visitor === 'new' && r.campaign) taggedArrivals += r.c
          if (isAuthSuccess(r.path)) authSuccess += r.c
          if (isInstallOutcome(r.path)) install += r.c
        }
        return { pageviews, taggedArrivals, authSuccess, install }
      }
      releasePanel = {
        release: latest,
        days: windows.days,
        before: summarize(beforeRes),
        after: summarize(afterRes),
        note: 'before = partially instrumented — auth success, install, and campaign tagging are new paths this release adds; the "before" window predates them.',
      }
    }
  }

  return json({
    generatedAt: new Date().toISOString(),
    todayEt,
    kpis,
    timeline: { daily, campaignFlights, releaseMarkers, trackingActivationDate: TRACKING_ACTIVATION_DATE_ET, since, until },
    scorecard,
    releasePanel,
  })
}

export const onRequestGet: PagesFunction = async () => json({ ok: true, hint: 'POST an overview query: { since?, until? }' })
