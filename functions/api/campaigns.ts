/// <reference types="@cloudflare/workers-types" />
//
// "Best Sudoku campaigns" dataset — compares the three Google Ads campaigns configured in
// ../../src/lib/campaigns.ts against the beacon's D1 (`hits`). Reads the same table as
// /api/geo and /api/popups; classifies `path` the same way /api/popups does (via
// ../../src/lib/popupEvents.ts's classifyPopupPath, reused by lib/campaigns.ts's
// classifyFunnelPath) instead of treating every row as a page view.
//
// ANONYMOUS AGGREGATES ONLY: every response is a count, a rate, or a bucketed breakdown —
// this endpoint never returns or joins an individual row. Attribution is uc-only (a row's
// own `campaign` column, see lib/campaigns.ts campaignAttributionClause) — nothing here
// correlates DIFFERENT rows by location/device/timestamp.
//
// POST { campaignId }  — one of lib/campaigns.ts CAMPAIGNS' ids.

import {
  ARRIVALS_CAVEAT,
  CAMPAIGNS,
  FUNNEL_STEP_ORDER,
  applyExclusions,
  campaignAttributionClause,
  campaignById,
  classifyFunnelPath,
  computeFunnelCounts,
  costPer,
  countryBucket,
  etHourFromMs,
  etFlightRangeMs,
  flightDayIndex,
  funnelStepRates,
  parseReturnPath,
  returnBeaconNotInstrumented,
  returnVisitRates,
  screenWidthBucket,
  sharesReturnTagWith,
  CAMPAIGN_SPEND,
  RETURN_BUCKETS,
  type FunnelPathCount,
  type FunnelStepKey,
} from '../../src/lib/campaigns'
import { etDateFromMs, TRACKING_ACTIVATION_DATE_ET } from '../../src/lib/popupEvents'

interface Env {
  gss_geo: D1Database
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const CAMPAIGN_IDS = new Set(CAMPAIGNS.map((c) => c.id))
const BSK_SITE = 'bestsudoku-web' // return beacon is "on-device, web only" — see the task brief

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: any
  try {
    body = await ctx.request.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  if (!ctx.env.gss_geo) return json({ error: 'geo DB not bound' }, 500)

  const campaignId = typeof body.campaignId === 'string' ? body.campaignId : ''
  if (!CAMPAIGN_IDS.has(campaignId)) return json({ error: 'unknown campaignId' }, 400)
  const campaign = campaignById(campaignId)!
  const db = ctx.env.gss_geo

  // ── Query 1: (hour bucket, path, country, visitor) counts within the flight window —
  // covers the funnel, funnel-by-country, hour-of-day, and daily-arrivals charts from ONE
  // query. `visitor` is the DEFINITION FIX (2026-09-25): a tagged row is a "tagged hit"
  // (the campaign tag rides every beacon for its 30-min TTL — many hits per click); a
  // "tagged arrival" is specifically visitor='new' — the device's first-ever beacon. See
  // lib/campaigns.ts's ARRIVALS_CAVEAT comment for the full definition. ───────────────────
  const attr = campaignAttributionClause(campaign)
  const w1: string[] = [attr.sql]
  const b1: unknown[] = [...attr.binds]
  applyExclusions(w1, b1)
  const sql1 = `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, country, visitor, COUNT(*) AS c FROM hits WHERE ${w1.join(' AND ')} GROUP BY hr, path, country, visitor`

  // ── Query 2: device mix (os / browser / screen width) within the flight window. ─────────
  const w2: string[] = [attr.sql]
  const b2: unknown[] = [...attr.binds]
  applyExclusions(w2, b2)
  const sql2 = `SELECT os, browser, screenw, COUNT(*) AS c FROM hits WHERE ${w2.join(' AND ')} GROUP BY os, browser, screenw`

  // ── Query 3: which funnel-step paths existed AT ALL (any campaign, any un-tagged hit)
  // site-wide during this flight's SERVING window — decides "not instrumented" vs a real 0.
  // Computed independently from campaign.flightStart/flightEnd (the display/serving dates),
  // NOT from the attribution clause's binds (which has no upper bound — see
  // campaignAttributionClause). `flightStart === null` (a pending flight, e.g. the retest
  // before its start is confirmed): there's no window to check yet, so this query is skipped
  // entirely and every non-globally-not-instrumented step is correctly left "not
  // instrumented" below (seenSteps stays empty). ───────────────────────────────────────────
  const flightRange = campaign.flightStart ? etFlightRangeMs(campaign.flightStart, campaign.flightEnd) : null
  const sql3Promise: Promise<any> = flightRange
    ? db
        .prepare(`SELECT path, COUNT(*) AS c FROM hits WHERE site = ? AND ts >= ? AND ts < ? GROUP BY path`)
        .bind(BSK_SITE, flightRange[0], flightRange[1])
        .all()
    : Promise.resolve({ results: [] })

  // ── Query 4: on-device return beacon (/return/<uc>/<bucket>) — path-embedded uc, see
  // lib/campaigns.ts parseReturnPath; site-wide + NOT date-windowed (a d31-60 return can
  // fire long after the flight itself ended — windowing it away would defeat the point). ──
  const w4: string[] = ['site = ?', `(${campaign.ucValues.map(() => 'path LIKE ?').join(' OR ')})`]
  const b4: unknown[] = [BSK_SITE, ...campaign.ucValues.map((u) => `/return/${u}/%`)]
  applyExclusions(w4, b4)
  const sql4 = `SELECT path, COUNT(*) AS c FROM hits WHERE ${w4.join(' AND ')} GROUP BY path`

  let r1: any, r2: any, r3: any, r4: any
  try {
    ;[r1, r2, r3, r4] = await Promise.all([
      db.prepare(sql1).bind(...b1).all(),
      db.prepare(sql2).bind(...b2).all(),
      sql3Promise,
      db.prepare(sql4).bind(...b4).all(),
    ])
  } catch (e) {
    return json({ error: 'd1 query failed', detail: String(e) }, 500)
  }

  // ── Funnel + funnel-by-country + hour-of-day + daily arrivals, all from r1 ───────────────
  const rows1: { hr: number; path: string; country: string; visitor: string; c: number }[] = (r1.results ?? []).map((x: any) => ({
    hr: Number(x.hr) || 0,
    path: String(x.path ?? ''),
    country: String(x.country ?? ''),
    visitor: String(x.visitor ?? ''),
    c: Number(x.c) || 0,
  }))
  const taggedHits = rows1.reduce((a, r) => a + r.c, 0) // EVERY tagged row — NOT arrivals, see above
  const arrivalRows = rows1.filter((r) => r.visitor === 'new')
  const taggedArrivals = arrivalRows.reduce((a, r) => a + r.c, 0)

  const funnelInput: FunnelPathCount[] = rows1.map((r) => ({ path: r.path, count: r.c })) // any visitor — later funnel steps are event rows within the session, not first-beacon-only
  const counts = computeFunnelCounts(funnelInput, taggedArrivals)

  const byBucket: Record<'US' | 'CA' | 'other', FunnelPathCount[]> = { US: [], CA: [], other: [] }
  const arrivalsByBucket: Record<'US' | 'CA' | 'other', number> = { US: 0, CA: 0, other: 0 }
  for (const r of rows1) byBucket[countryBucket(r.country)].push({ path: r.path, count: r.c })
  for (const r of arrivalRows) arrivalsByBucket[countryBucket(r.country)] += r.c
  const funnelByCountry = {
    US: computeFunnelCounts(byBucket.US, arrivalsByBucket.US),
    CA: computeFunnelCounts(byBucket.CA, arrivalsByBucket.CA),
    other: computeFunnelCounts(byBucket.other, arrivalsByBucket.other),
  }

  const hourOfDayEt = new Array(24).fill(0)
  const dailyMap = new Map<string, number>()
  for (const r of arrivalRows) {
    const ms = r.hr * 3_600_000
    hourOfDayEt[etHourFromMs(ms)] += r.c // tagged ARRIVALS by hour (visitor='new' only)
    const d = etDateFromMs(ms)
    dailyMap.set(d, (dailyMap.get(d) ?? 0) + r.c)
  }
  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, arrivals]) => ({ date, day: flightDayIndex(campaign, date) ?? 0, arrivals }))

  // ── Per-flight "not instrumented" (query 3): any funnel-step path with zero site-wide
  // hits during this flight's window couldn't have been seen — not a real 0. ──────────────
  const seenSteps = new Set<FunnelStepKey>()
  for (const x of r3.results ?? []) {
    const step = classifyFunnelPath(String(x.path ?? ''))
    if (step && (Number(x.c) || 0) > 0) seenSteps.add(step)
  }
  const notInstrumented = FUNNEL_STEP_ORDER.filter((k) => k !== 'arrivals' && !seenSteps.has(k))
  const rates = funnelStepRates(counts, new Set(notInstrumented))

  // ── Device mix (query 2) ─────────────────────────────────────────────────────────────
  const os: Record<string, number> = {}
  const browser: Record<string, number> = {}
  const screen: Record<string, number> = {}
  for (const x of r2.results ?? []) {
    const c = Number(x.c) || 0
    const o = String(x.os ?? '') || '(unknown)'
    const br = String(x.browser ?? '') || '(unknown)'
    const sb = screenWidthBucket(Number(x.screenw) || 0)
    os[o] = (os[o] ?? 0) + c
    browser[br] = (browser[br] ?? 0) + c
    screen[sb] = (screen[sb] ?? 0) + c
  }

  // ── Return visits (query 4) ──────────────────────────────────────────────────────────
  const returnCounts = Object.fromEntries(RETURN_BUCKETS.map((b) => [b, 0])) as Record<(typeof RETURN_BUCKETS)[number], number>
  for (const x of r4.results ?? []) {
    const ev = parseReturnPath(String(x.path ?? ''))
    if (ev && campaign.ucValues.includes(ev.uc)) returnCounts[ev.bucket] += Number(x.c) || 0
  }
  const returnRates = returnVisitRates(returnCounts)
  const sharedWith = sharesReturnTagWith(campaign)

  const spend = CAMPAIGN_SPEND[campaign.id] ?? null

  const response = {
    campaign: {
      id: campaign.id,
      label: campaign.label,
      status: campaign.status,
      flightStart: campaign.flightStart,
      flightEnd: campaign.flightEnd,
      ucValues: campaign.ucValues,
      notes: campaign.notes,
      measurement: campaign.measurement ?? null,
      measurabilityNote: campaign.measurabilityNote ?? null,
    },
    funnel: { counts, rates, notInstrumented, arrivalsCaveat: ARRIVALS_CAVEAT },
    taggedHits, // labeled separately from arrivals — see ARRIVALS_CAVEAT / the DEFINITION FIX comment above
    funnelByCountry,
    hourOfDayEt,
    daily,
    deviceMix: { os, browser, screen },
    returnVisits: {
      counts: returnCounts,
      rates: returnRates,
      notInstrumented: returnBeaconNotInstrumented(campaign),
      sharedWithCampaignId: sharedWith?.id ?? null,
    },
    costPerArrival: costPer(spend, counts.arrivals),
    costPerAuthSuccess: costPer(spend, counts.authSuccess),
    spend,
    meta: { generatedAt: new Date().toISOString(), trackingActivationDate: TRACKING_ACTIVATION_DATE_ET },
  }

  return json(response)
}

export const onRequestGet: PagesFunction = async () =>
  json({ ok: true, hint: 'POST a campaign query: { campaignId }', campaigns: CAMPAIGNS.map((c) => ({ id: c.id, label: c.label })) })
