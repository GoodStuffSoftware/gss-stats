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
  etMidnightUtcMs,
  etTimeUtcMs,
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
import { etDateFromMs, excludeInstallGapUnmeasured, installOutcomeGapNote, TRACKING_ACTIVATION_DATE_ET, INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS, rowIsPostInstallFix } from '../../src/lib/popupEvents'
import { campaignSegmentMarker, resolveCampaignSpend, UPSELL_SIGNEDOUT_FIX_AT } from '../../src/lib/adsRules'
import { readFreshness, readSpendSummaries } from '../../src/lib/adsStore'
import { freshnessOf } from '../../src/lib/adsFreshness'
import { isRawInstallSignal, RAW_INSTALL_SIGNALS_LABEL } from '../../src/lib/campaigns'
import { notInstrumentedFunnelSteps } from '../_lib/campaignInstrumentation'

interface Env {
  gss_geo: D1Database
  /** gss-stats' own ads store (docs/adr/0001-ads-read-store.md). Optional: when absent or
   * empty, spend falls back to lib/campaigns.ts CAMPAIGN_SPEND. */
  gss_stats_ads?: D1Database
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
  excludeInstallGapUnmeasured(w1, b1) // pre-fix install-gap rows are unmeasured, not zero
  // `uf` (only while UPSELL_SIGNEDOUT_FIX_AT is set): the row is at or after the signed-out
  // upsell fix, so the segment breakdown below splits exactly at the instant. Every other use
  // of these rows sums `c`, so the extra grouping changes nothing else.
  const upsellFixAt = UPSELL_SIGNEDOUT_FIX_AT
  const sql1 =
    upsellFixAt == null
      ? `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, country, visitor, COUNT(*) AS c FROM hits WHERE ${w1.join(' AND ')} GROUP BY hr, path, country, visitor`
      : `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, country, visitor, (ts >= ?) AS uf, COUNT(*) AS c FROM hits WHERE ${w1.join(' AND ')} GROUP BY hr, path, country, visitor, uf`
  if (upsellFixAt != null) b1.unshift(upsellFixAt)

  // ── Query 2: device mix (os / browser / screen width) within the flight window. ─────────
  const w2: string[] = [attr.sql]
  const b2: unknown[] = [...attr.binds]
  applyExclusions(w2, b2)
  const sql2 = `SELECT os, browser, screenw, COUNT(*) AS c FROM hits WHERE ${w2.join(' AND ')} GROUP BY os, browser, screenw`

  // ── Query 3: which funnel-step paths existed AT ALL (any campaign, any un-tagged hit)
  // site-wide during this flight's SERVING window — decides "not instrumented" vs a real 0.
  // Factored into functions/_lib/campaignInstrumentation.ts (notInstrumentedFunnelSteps) so
  // the overview scorecard can reuse the exact same per-flight derivation instead of a
  // simplified default — see that module for the full behavior (including the `flightStart
  // === null` pending-flight case). ─────────────────────────────────────────────────────────
  const notInstrumentedPromise = notInstrumentedFunnelSteps(db, campaign)

  // ── Query 4: on-device return beacon (/return/<uc>/<bucket>) — path-embedded uc, see
  // lib/campaigns.ts parseReturnPath; site-wide + NOT date-windowed (a d31-60 return can
  // fire long after the flight itself ended — windowing it away would defeat the point). ──
  const w4: string[] = ['site = ?', `(${campaign.ucValues.map(() => 'path LIKE ?').join(' OR ')})`]
  const b4: unknown[] = [BSK_SITE, ...campaign.ucValues.map((u) => `/return/${u}/%`)]
  applyExclusions(w4, b4)
  const sql4 = `SELECT path, COUNT(*) AS c FROM hits WHERE ${w4.join(' AND ')} GROUP BY path`

  let r1: any, r2: any, notInstrumented: FunnelStepKey[], r4: any
  try {
    ;[r1, r2, notInstrumented, r4] = await Promise.all([
      db.prepare(sql1).bind(...b1).all(),
      db.prepare(sql2).bind(...b2).all(),
      notInstrumentedPromise,
      db.prepare(sql4).bind(...b4).all(),
    ])
  } catch (e) {
    return json({ error: 'd1 query failed', detail: String(e) }, 500)
  }

  // ── Funnel + funnel-by-country + hour-of-day + daily arrivals, all from r1 ───────────────
  const rows1: { hr: number; path: string; country: string; visitor: string; c: number; uf?: boolean }[] = (r1.results ?? []).map((x: any) => ({
    hr: Number(x.hr) || 0,
    path: String(x.path ?? ''),
    country: String(x.country ?? ''),
    visitor: String(x.visitor ?? ''),
    c: Number(x.c) || 0,
    ...(x.uf === undefined ? {} : { uf: Number(x.uf) === 1 }),
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

  // ── Per-flight "not instrumented" (query 3, via notInstrumentedFunnelSteps): any funnel-
  // step path with zero site-wide hits during this flight's window couldn't have been seen —
  // not a real 0. ───────────────────────────────────────────────────────────────────────────
  // install/installPrompt's denominator (see lib/campaigns.ts funnelStepRates/
  // VALID_FUNNEL_RATE_STEPS): only prompts shown AT OR AFTER the install-outcome-gap fix — a
  // pre-fix prompt could never have its "installed" outcome recorded at all, so it doesn't
  // belong in the rate's denominator. Computed from rows1 (already hour-bucketed) rather than
  // a new query.
  const installFixAtMs = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS
  const installPromptPostFixCount = rows1.reduce(
    (a, r) => (classifyFunnelPath(r.path) === 'installPrompt' && rowIsPostInstallFix({ hourStartMs: r.hr * 3_600_000, path: r.path, count: r.c }, installFixAtMs) ? a + r.c : a),
    0,
  )
  const rates = funnelStepRates(counts, new Set(notInstrumented), installPromptPostFixCount)

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

  // Spend: the routine's stored Google Ads API figures first (gss-stats-ads), else the
  // hand-entered CAMPAIGN_SPEND — fail soft, see lib/adsStore.ts readSpendSummaries.
  const nowMs = Date.now()
  const [summaries, freshnessAll] = await Promise.all([readSpendSummaries(ctx.env.gss_stats_ads), readFreshness(ctx.env.gss_stats_ads, nowMs, [campaign])])
  const stored = summaries?.get(campaign.id) ?? null
  const resolvedSpend = resolveCampaignSpend(stored, CAMPAIGN_SPEND[campaign.id] ?? null)
  // spendThrough / lastSync / stale (lib/adsFreshness.ts) — read-only, never an Ads API call.
  const freshness = freshnessAll.get(campaign.id) ?? freshnessOf(campaign, null, null, nowMs)
  const spend = resolvedSpend.spend
  // Raw /install/<outcome> beacons — secondary to the deduplicated install step (one install
  // can fire two of them); see lib/campaigns.ts isRawInstallSignal.
  const rawInstallSignals = rows1.filter((r) => isRawInstallSignal(r.path)).reduce((a, r) => a + r.c, 0)

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
    funnel: {
      counts,
      rates,
      notInstrumented,
      // The install/installPrompt rate's real denominator (see lib/campaigns.ts
      // funnelStepRates) — carried alongside `counts.installPrompt` (the WHOLE-window count,
      // still shown as its own plain count) so the UI can display the rate's actual n/d.
      installPromptPostFixCount,
      arrivalsCaveat: ARRIVALS_CAVEAT,
      // Install-fix caveat for THIS campaign's attribution range (none once it is all post-fix).
      installNote:
        installOutcomeGapNote({
          startMs: campaign.flightStart ? (campaign.flightStartTimeEt ? etTimeUtcMs(campaign.flightStart, campaign.flightStartTimeEt) : etMidnightUtcMs(campaign.flightStart)) : 0,
          endMs: Date.now(),
        }) || null,
    },
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
    spendSource: { source: resolvedSpend.source, fetchedAt: resolvedSpend.fetchedAt, lastDate: resolvedSpend.lastDate },
    spendThrough: freshness.spendThrough,
    lastSync: freshness.lastSync,
    stale: freshness.stale,
    // The signed-out upsell fix as a funnel segment boundary (lib/adsRules.ts
    // UPSELL_SIGNEDOUT_FIX_AT; null until set): marker + tagged upsell by segment.
    segments: (() => {
      const m = campaignSegmentMarker(
        campaign,
        rows1.map((r) => ({ hourStartMs: r.hr * 3_600_000, path: r.path, visitor: r.visitor, count: r.c, ...(r.uf === undefined ? {} : { postUpsellFix: r.uf }) })),
      )
      return m ? { ...m, boundaryFlightDay: flightDayIndex(campaign, m.boundaryDate) } : null
    })(),
    rawInstallSignals: { count: rawInstallSignals, label: RAW_INSTALL_SIGNALS_LABEL },
    meta: { generatedAt: new Date().toISOString(), trackingActivationDate: TRACKING_ACTIVATION_DATE_ET },
  }

  return json(response)
}

export const onRequestGet: PagesFunction = async () =>
  json({ ok: true, hint: 'POST a campaign query: { campaignId }', campaigns: CAMPAIGNS.map((c) => ({ id: c.id, label: c.label })) })
