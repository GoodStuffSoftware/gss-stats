/// <reference types="@cloudflare/workers-types" />
//
// "Best Sudoku completions" dataset — /game/complete/<mode>/<difficulty> beacons, broken down
// by mode × difficulty. One row = one distinct completed game: replays of the same puzzle
// aren't recounted, since that dedup happens app-side before the beacon ever fires (see
// lib/campaigns.ts GAME_COMPLETE_PREFIX's own doc comment) — a plain COUNT(*) here is already
// "distinct games completed".
//
// A thin sibling to /api/popups.ts, not folded into it: a completed game is deliberately NOT a
// "popup" family (lib/popupEvents.ts's classifyPopupPath excludes /game/complete/ on purpose —
// keep that exclusion exactly as it is; see lib/campaigns.ts classifyFunnelPath's own comment).
// Live from GAME_COMPLETE_LIVE_AT (v1.95.5, 2026-09-26T19:43:02Z) — no rows exist before then,
// which just reads as an empty chart; nothing here needs to gate on it specially.
//
// Reads the same D1 `hits` table as /api/geo and /api/popups. Feeds the SAME generic
// dimension/breakdown widget pipeline those two use (StatsResponse: rows keyed by
// {[dimension]: value, ...}), so this widget is configurable/movable exactly like any other
// chart — see lib/catalog.ts COMPLETIONS_DIMENSIONS and src/api.ts's 'completions' branch.
//
// ANONYMOUS AGGREGATES ONLY — one COUNT(*) GROUP BY path, classified in JS; never a row fetch.
//
// POST { dimension?: 'mode'|'difficulty', breakdown?: 'mode'|'difficulty', since, until, sites?, limit? }

import { parseGameCompletePath } from '../../src/lib/campaigns'
import { buildCacheKeyUrl, cachedJson, ttlSecondsFor, type CacheLike } from '../_lib/edgeCache'
import { WHEN_RE, SITE_TAG_RE } from '../../src/lib/range'

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

const DIMS = new Set(['mode', 'difficulty'])
// A row whose path has the right prefix but not exactly two more segments (a corrupted/future
// beacon shape) still counts toward the total, bucketed here — never silently dropped, so this
// breakdown's total can't quietly disagree with the funnel's prefix-matched "completed" count
// (see lib/campaigns.ts classifyFunnelPath / GAME_COMPLETE_PREFIX).
const OTHER_BUCKET = '(other)'

type Row = { key: Record<string, string>; pageviews: number; visits: number }

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: any
  try {
    body = await ctx.request.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  if (!ctx.env.gss_geo) return json({ error: 'geo DB not bound' }, 500)

  const dimension = DIMS.has(body.dimension) ? body.dimension : 'mode'
  const breakdown = DIMS.has(body.breakdown) && body.breakdown !== dimension ? body.breakdown : undefined
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 500)
  const today = new Date().toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
  const since = safeDate(body.since, weekAgo)
  const until = safeDate(body.until, today)
  const sinceMs = Date.parse(since)
  const untilMs = isDateOnly(until) ? Date.parse(until) + 86_400_000 : Date.parse(until)

  const rawSites: unknown[] = Array.isArray(body.sites) ? body.sites : body.site != null ? [body.site] : []
  const sites = rawSites.filter((s): s is string => typeof s === 'string' && s !== 'all' && SITE_TAG_RE.test(s))

  // Same per-colo edge cache as /api/geo.ts — everything that changes the SQL (and therefore
  // the response) goes into the key; `sites` is sorted for the key only (order never changes
  // the result). ttlSecondsFor gives a closed [since, until) range (ends before today ET) a
  // long TTL and a still-live range a short one; cachedJson never stores a non-ok response, so
  // a D1 failure below is never cached.
  const cacheKeyUrl = buildCacheKeyUrl('/api/completions', {
    dimension,
    breakdown: breakdown ?? '',
    since,
    until,
    limit,
    sites: [...sites].sort(),
  })
  const ttl = ttlSecondsFor(until, new Date())
  const cache = (caches as unknown as { default: CacheLike }).default

  return cachedJson(cache, cacheKeyUrl, ttl, ctx.waitUntil.bind(ctx), computeCompletionsResponse)

  async function computeCompletionsResponse(): Promise<Response> {
  const w: string[] = ['ts >= ?', 'ts < ?', `path LIKE '/game/complete/%'`]
  const b: unknown[] = [sinceMs, untilMs]
  if (sites.length) {
    w.push(`site IN (${sites.map(() => '?').join(', ')})`)
    b.push(...sites)
  }
  const sql = `SELECT path, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY path`
  let res: any
  try {
    res = await ctx.env.gss_geo.prepare(sql).bind(...b).all()
  } catch (e) {
    return json({ error: 'd1 query failed', detail: String(e) }, 500)
  }

  const cell = new Map<string, number>() // `${dimValue}||${breakdownValue}` -> count
  for (const x of res.results ?? []) {
    const c = Number(x.c) || 0
    if (!c) continue
    const parsed = parseGameCompletePath(String(x.path ?? ''))
    const mode = parsed?.mode ?? OTHER_BUCKET
    const difficulty = parsed?.difficulty ?? OTHER_BUCKET
    const dimValue = dimension === 'mode' ? mode : difficulty
    const bdValue = breakdown ? (breakdown === 'mode' ? mode : difficulty) : ''
    const key = `${dimValue}||${bdValue}`
    cell.set(key, (cell.get(key) ?? 0) + c)
  }

  const allRows: Row[] = [...cell.entries()].map(([key, c]) => {
    const [dimValue, bdValue] = key.split('||')
    return { key: breakdown ? { [dimension]: dimValue, [breakdown]: bdValue } : { [dimension]: dimValue }, pageviews: c, visits: c }
  })
  // Totals reflect the full filtered set, before the top-N truncation below — same convention
  // as /api/stats.ts and /api/geo.ts.
  const totals = allRows.reduce((acc, r) => ({ pageviews: acc.pageviews + r.pageviews, visits: acc.visits + r.visits }), { pageviews: 0, visits: 0 })
  const rows = allRows.sort((a, b) => b.pageviews - a.pageviews).slice(0, limit)

  return json({
    rows,
    totals,
    meta: { since, until, sites: sites.length ? sites.join(',') : 'all', dimensions: [dimension, ...(breakdown ? [breakdown] : [])], metric: 'pageviews' as const },
  })
  }
}

export const onRequestGet: PagesFunction = async () =>
  json({ ok: true, hint: 'POST a completions query: { dimension?, breakdown?, since, until }' })
