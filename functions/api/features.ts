/// <reference types="@cloudflare/workers-types" />
//
// "Feature health" dataset: for each configured feature (src/lib/featureHealth.ts FEATURES), is it
// firing and are people moving through it. Per feature and per step: the counts for the latest
// complete ET day, the day before it and the selected range, the plain step-to-step ratios of
// those counts, and a status (OK / New / Went silent).
//
// Reads the same D1 `hits` table as /api/geo and /api/completions (already bot-free: humans only),
// with the same standing filters as the other cards: sites, "hide my own visits" and, when the
// widget asks for it (the Overview does), the known test and household traffic exclusions.
// Web and app are combined: no step reads the site.
//
// COUNTS ONLY (src/lib/splitGuard.ts). Two aggregate statements and nothing else:
//   1. one row per ET DAY, one SUM(CASE ...) column per configured step;
//   2. one total row: per feature, the count of rows before the new-days cutoff (a COUNT, never
//      MIN(ts) or MAX(ts)).
// There is no hour, place, device or visitor dimension anywhere, and every window bound is an ET
// midnight (refusedRowWindow snaps the request's range; the baseline and "today" bounds are ET
// midnights by construction), so the refused paths in the config (/tour/skip, /game/start/…,
// /coach/shown/…) are only ever read as per-ET-day totals, which the rule allows. The step columns
// carry the paths as checked literals, never binds.
//
// POST { since, until, sites?, excludeOwnVisits?, ownBrowser?, ownOS?, excludeKnownTraffic? }

import { buildCacheKeyUrl, cachedJson, type CacheLike } from '../_lib/edgeCache'
import { WHEN_RE, SITE_TAG_RE } from '../../src/lib/range'
import { refusedRowWindow, REFUSED_WINDOW_KEY } from '../../src/lib/splitGuard'
import { MAX_SITES, statementTooLarge } from '../../src/lib/queryLimits'
import { applyExclusions } from '../../src/lib/campaigns'
import { excludeOwnClause } from '../../src/lib/ownExclusion'
import { addDays, etDateFast, etWallTimeMs } from '../../src/lib/etTime'
import { FEATURES, assembleHealth, flatSteps, healthDays, type DayCounts } from '../../src/lib/featureHealth'
import { anyStepWhere, beforeCutoffSql, dailyStepsSql } from '../../src/lib/featureHealthSql'

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

/** The longest range charted: a longer one is cut to its newest days (a "since forever" range). */
const MAX_RANGE_DAYS = 731
/** A response is reused for at most this long, so the status never trails an ET midnight or a
 * fresh batch of rows by much (the cache key also carries today's ET date). */
const CACHE_TTL_SECONDS = 300

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: any
  try {
    body = await ctx.request.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  if (!ctx.env.gss_geo) return json({ error: 'geo DB not bound' }, 500)

  const nowMs = Date.now()
  const todayIso = new Date(nowMs).toISOString().slice(0, 10)
  const weekAgoIso = new Date(nowMs - 6 * 86_400_000).toISOString().slice(0, 10)
  const since = safeDate(body.since, weekAgoIso)
  const until = safeDate(body.until, todayIso)
  const sinceMs = Date.parse(since)
  const untilMs = isDateOnly(until) ? Date.parse(until) + 86_400_000 : Date.parse(until)

  const rawSites: unknown[] = Array.isArray(body.sites) ? body.sites : body.site != null ? [body.site] : []
  if (rawSites.length > MAX_SITES) return json({ error: `too many sites (at most ${MAX_SITES})` }, 400)
  const sites = rawSites.filter((s): s is string => typeof s === 'string' && s !== 'all' && SITE_TAG_RE.test(s))
  const excludeOwn = body.excludeOwnVisits === true
  const excludeKnownTraffic = body.excludeKnownTraffic === true

  // The window, in whole ET days (R-1d): the selected range snapped to ET midnights, widened to also
  // cover the baseline days and today, both ET midnights by construction.
  const hd = healthDays(nowMs)
  let [rangeFromMs, rangeToMs] = refusedRowWindow(sinceMs, untilMs)
  const hasRange = Number.isFinite(rangeFromMs) && Number.isFinite(rangeToMs) && rangeFromMs < rangeToMs
  let rangeFrom = ''
  let rangeTo = ''
  if (hasRange) {
    rangeTo = etDateFast(rangeToMs)
    const oldest = addDays(rangeTo, -MAX_RANGE_DAYS)
    rangeFrom = etDateFast(rangeFromMs) < oldest ? oldest : etDateFast(rangeFromMs)
    rangeFromMs = etWallTimeMs(rangeFrom)
  }
  const fromMs = hasRange ? Math.min(rangeFromMs, hd.baselineStartMs) : hd.baselineStartMs
  const toMs = hasRange ? Math.max(rangeToMs, hd.tomorrowMs) : hd.tomorrowMs

  const cacheKeyUrl = buildCacheKeyUrl('/api/features', {
    since,
    until,
    sites: [...sites].sort(),
    excludeOwn,
    ownBrowser: excludeOwn ? String(body.ownBrowser ?? '') : '',
    ownOS: excludeOwn ? String(body.ownOS ?? '') : '',
    excludeKnownTraffic,
    today: hd.today,
    window: REFUSED_WINDOW_KEY,
  })
  const cache = (caches as unknown as { default: CacheLike }).default
  return cachedJson(cache, cacheKeyUrl, CACHE_TTL_SECONDS, ctx.waitUntil.bind(ctx), compute)

  async function compute(): Promise<Response> {
    // The shared row filters, after the window and the path term, in the order the binds follow.
    const filterTerms = (w: string[], b: unknown[]) => {
      if (sites.length) {
        w.push(`site IN (${sites.map(() => '?').join(', ')})`)
        b.push(...sites)
      }
      if (excludeKnownTraffic) applyExclusions(w, b)
      excludeOwnClause(w, b, excludeOwn, body.ownBrowser, body.ownOS)
    }

    const w1: string[] = ['ts >= ?', 'ts < ?', anyStepWhere()]
    const b1: unknown[] = [fromMs, toMs]
    filterTerms(w1, b1)
    const daily = dailyStepsSql(w1)
    const tooLarge1 = statementTooLarge(daily, b1.length)
    if (tooLarge1) return tooLarge1

    const w2: string[] = ['ts < ?', anyStepWhere()]
    const b2: unknown[] = [hd.newCutoffMs]
    filterTerms(w2, b2)
    const before = beforeCutoffSql(w2)
    const tooLarge2 = statementTooLarge(before, b2.length)
    if (tooLarge2) return tooLarge2

    let dayRes: any
    let beforeRes: any
    try {
      dayRes = await ctx.env.gss_geo.prepare(daily).bind(...b1).all()
      beforeRes = await ctx.env.gss_geo.prepare(before).bind(...b2).all()
    } catch (e) {
      return json({ error: 'd1 query failed', detail: String(e) }, 500)
    }

    const stepCount = flatSteps().length
    const rows: DayCounts[] = (dayRes.results ?? []).map((r: any) => ({
      d: String(r.d),
      s: Array.from({ length: stepCount }, (_, i) => Number(r[`s${i}`]) || 0),
    }))
    const beforeRow = (beforeRes.results ?? [])[0] ?? {}
    const beforeCounts = FEATURES.map((_, i) => Number(beforeRow[`f${i}`]) || 0)

    const model = assembleHealth({ rows, before: beforeCounts, nowMs, rangeFrom: rangeFrom || hd.today, rangeTo: rangeTo || hd.today })
    return json({
      ...model,
      meta: { since, until, rangeFrom, rangeTo, sites: sites.length ? sites.join(',') : 'all', today: hd.today },
    })
  }
}

export const onRequestGet: PagesFunction = async () =>
  json({ ok: true, hint: 'POST a feature-health query: { since, until, sites?, excludeOwnVisits?, excludeKnownTraffic? }' })
