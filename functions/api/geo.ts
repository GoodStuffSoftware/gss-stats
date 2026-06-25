/// <reference types="@cloudflare/workers-types" />
//
// Geo dataset — bot-free sub-country geography from the beacon's D1 store
// (request.cf.region/city, written by gss-beacon). Same response shape as
// /api/stats so the dashboard can chart it identically.
//
// POST { dimension, since, until, limit, site? }  (geo is already bot-free; the
// RUM self/referral filters don't apply.)

interface Env {
  gss_geo: D1Database
}

const GEO_DIMS = new Set([
  'country', 'region', 'city', 'postal', 'continent', 'timezone', 'colo', 'org',
  'referrer', 'path', 'site', 'device', 'browser', 'os', 'lang', 'visitor', 'date',
])

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

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: any
  try {
    body = await ctx.request.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }
  if (!ctx.env.gss_geo) return json({ error: 'geo DB not bound' }, 500)

  const dim: string = GEO_DIMS.has(body.dimension) ? body.dimension : 'region'
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 500)
  const today = new Date().toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
  const since = safeDate(body.since, weekAgo)
  const until = safeDate(body.until, today)
  const sinceMs = Date.parse(since)
  const untilMs = isDateOnly(until) ? Date.parse(until) + 86_400_000 : Date.parse(until) // legacy day = inclusive
  // Optional beacon-site filter (e.g. "starrupture"). The RUM site keys don't map
  // here, so only apply it when it's a plain site tag.
  const site = typeof body.site === 'string' && /^[a-z0-9.\-]{1,40}$/i.test(body.site) ? body.site : null

  // Map mode: return one point per distinct lat/lon with a count (for globe/map charts).
  if (dim === 'points' || body.dimension === 'points') {
    const w: string[] = ['ts >= ?', 'ts < ?', "lat <> ''"]
    const b: any[] = [sinceMs, untilMs]
    if (site && site !== 'all') {
      w.push('site = ?')
      b.push(site)
    }
    const sql = `SELECT lat, lon, city, region, country, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY lat, lon ORDER BY c DESC LIMIT ?`
    b.push(Math.min(limit, 2000))
    let r: any
    try {
      r = await ctx.env.gss_geo.prepare(sql).bind(...b).all()
    } catch (e) {
      return json({ error: 'd1 query failed', detail: String(e) }, 500)
    }
    const rows = (r.results ?? []).map((x: any) => ({
      key: {
        lat: String(x.lat ?? ''),
        lon: String(x.lon ?? ''),
        city: String(x.city ?? ''),
        region: String(x.region ?? ''),
        country: String(x.country ?? ''),
      },
      pageviews: Number(x.c) || 0,
      visits: Number(x.c) || 0,
    }))
    const totals = rows.reduce(
      (a: any, x: any) => ({ pageviews: a.pageviews + x.pageviews, visits: a.visits + x.visits }),
      { pageviews: 0, visits: 0 },
    )
    return json({ rows, totals, meta: { site: site ?? 'all', since, until, dimensions: ['points'], metric: 'pageviews', dataset: 'geo' } })
  }

  const col = dim === 'date' ? "date(ts/1000,'unixepoch')" : dim
  const where = ['ts >= ?', 'ts < ?']
  const binds: any[] = [sinceMs, untilMs]
  if (site && site !== 'all') {
    where.push('site = ?')
    binds.push(site)
  }
  // Drop blank values from non-path dimensions for cleaner charts.
  if (dim !== 'path' && dim !== 'date') where.push(`${col} <> ''`)

  const orderBy = dim === 'date' ? `${col} ASC` : 'c DESC'
  const sql = `SELECT ${col} AS k, COUNT(*) AS c FROM hits WHERE ${where.join(' AND ')} GROUP BY k ORDER BY ${orderBy} LIMIT ?`
  binds.push(limit)

  let res: any
  try {
    res = await ctx.env.gss_geo.prepare(sql).bind(...binds).all()
  } catch (e) {
    return json({ error: 'd1 query failed', detail: String(e) }, 500)
  }

  const rows = (res.results ?? []).map((r: any) => ({
    key: { [dim]: String(r.k ?? '') },
    pageviews: Number(r.c) || 0,
    visits: Number(r.c) || 0,
  }))
  const totals = rows.reduce(
    (a: any, r: any) => ({ pageviews: a.pageviews + r.pageviews, visits: a.visits + r.visits }),
    { pageviews: 0, visits: 0 },
  )

  return json({ rows, totals, meta: { site: site ?? 'all', since, until, dimensions: [dim], metric: 'pageviews', dataset: 'geo' } })
}

export const onRequestGet: PagesFunction<Env> = async () =>
  json({ ok: true, hint: 'POST a geo query: { dimension, since, until, limit }' })
