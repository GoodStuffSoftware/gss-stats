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
  'referrer', 'refpath', 'path', 'site', 'device', 'browser', 'os', 'lang', 'visitor', 'date',
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
  // Beacon-site filter — a list of site tags (e.g. ["starrupture","simpletile",
  // "goodstuff"]) mapped from the Site/Subdomain selectors, or a single legacy
  // `site`. Empty / "all" = no filter.
  const rawSites: unknown[] = Array.isArray(body.sites) ? body.sites : body.site != null ? [body.site] : []
  const sites = rawSites.filter(
    (s): s is string => typeof s === 'string' && s !== 'all' && /^[a-z0-9.\-]{1,40}$/i.test(s),
  )
  const siteClause = (w: string[], b: any[]) => {
    if (sites.length) {
      w.push(`site IN (${sites.map(() => '?').join(', ')})`)
      b.push(...sites)
    }
  }
  // Drill-down constraints — exact field = value on a whitelisted, real column
  // ('date' is derived from ts, not a column, so it's excluded).
  const constraints: { field: string; value: string }[] = Array.isArray(body.constraints)
    ? (body.constraints as any[])
        .filter((c) => c && GEO_DIMS.has(c.field) && c.field !== 'date' && typeof c.value === 'string')
        .map((c) => ({ field: String(c.field), value: String(c.value) }))
    : []
  const drillClause = (w: string[], b: any[]) => {
    for (const c of constraints) {
      // "(direct)" / "(none)" are the labels we show for blank values → match empty.
      if (c.value === '(direct)' || c.value === '(none)') {
        w.push(`${c.field} = ''`)
      } else {
        w.push(`${c.field} = ?`)
        b.push(c.value)
      }
    }
  }

  // Map mode: return one point per distinct lat/lon with a count (for globe/map charts).
  if (dim === 'points' || body.dimension === 'points') {
    const w: string[] = ['ts >= ?', 'ts < ?', "lat <> ''"]
    const b: any[] = [sinceMs, untilMs]
    siteClause(w, b)
    drillClause(w, b)
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
    return json({ rows, totals, meta: { site: sites.length ? sites.join(',') : 'all', since, until, dimensions: ['points'], metric: 'pageviews', dataset: 'geo' } })
  }

  // Two-dimension breakdown (nested doughnut / stacked bar on geo data).
  const breakdown =
    typeof body.breakdown === 'string' && GEO_DIMS.has(body.breakdown) && body.breakdown !== dim && body.breakdown !== 'date'
      ? body.breakdown
      : null
  if (breakdown && dim !== 'date') {
    const w: string[] = ['ts >= ?', 'ts < ?', `${dim} <> ''`, `${breakdown} <> ''`]
    const b: any[] = [sinceMs, untilMs]
    siteClause(w, b)
    drillClause(w, b)
    const whereSql = w.join(' AND ')
    const sql = `SELECT ${dim} AS k1, ${breakdown} AS k2, COUNT(*) AS c FROM hits WHERE ${whereSql} GROUP BY k1, k2 ORDER BY c DESC LIMIT ?`
    let r: any
    let totalRes: any
    try {
      totalRes = await ctx.env.gss_geo.prepare(`SELECT COUNT(*) AS c FROM hits WHERE ${whereSql}`).bind(...b).all()
      r = await ctx.env.gss_geo.prepare(sql).bind(...b, Math.min(limit * 4, 1000)).all()
    } catch (e) {
      return json({ error: 'd1 query failed', detail: String(e) }, 500)
    }
    const rows = (r.results ?? []).map((x: any) => ({
      key: { [dim]: String(x.k1 ?? ''), [breakdown]: String(x.k2 ?? '') },
      pageviews: Number(x.c) || 0,
      visits: Number(x.c) || 0,
    }))
    const total = Number(totalRes.results?.[0]?.c) || 0
    const totals = { pageviews: total, visits: total }
    return json({ rows, totals, meta: { site: sites.length ? sites.join(',') : 'all', since, until, dimensions: [dim, breakdown], metric: 'pageviews', dataset: 'geo' } })
  }

  // Bucket blank values under a label ("(direct)" for referrers, "(none)" otherwise)
  // instead of dropping the row. Every visit is then counted in every chart — a visit
  // that appears on the map also appears (as "(direct)"/"(none)") in the referrer,
  // subreddit, etc. charts. Dropping blanks made attribute charts look empty while the
  // location charts stayed full for the very same visits.
  const emptyLabel = dim === 'referrer' ? '(direct)' : '(none)'
  const col =
    dim === 'date'
      ? "date(ts/1000,'unixepoch')"
      : `CASE WHEN ${dim} = '' THEN '${emptyLabel}' ELSE ${dim} END`
  const where = ['ts >= ?', 'ts < ?']
  const binds: any[] = [sinceMs, untilMs]
  siteClause(where, binds)
  drillClause(where, binds)

  const whereSql = where.join(' AND ')
  const orderBy = dim === 'date' ? 'k ASC' : 'c DESC'
  const sql = `SELECT ${col} AS k, COUNT(*) AS c FROM hits WHERE ${whereSql} GROUP BY k ORDER BY ${orderBy} LIMIT ?`

  let res: any
  let totalRes: any
  try {
    // Grand total over the WHOLE filtered set — computed before the GROUP BY + top-N
    // truncation so a stat (or any chart) reports the real count, not just the sum of the
    // returned rows. Mirrors the RUM endpoint, whose totals also precede its top-N cut.
    totalRes = await ctx.env.gss_geo.prepare(`SELECT COUNT(*) AS c FROM hits WHERE ${whereSql}`).bind(...binds).all()
    res = await ctx.env.gss_geo.prepare(sql).bind(...binds, limit).all()
  } catch (e) {
    return json({ error: 'd1 query failed', detail: String(e) }, 500)
  }

  const rows = (res.results ?? []).map((r: any) => ({
    key: { [dim]: String(r.k ?? '') },
    pageviews: Number(r.c) || 0,
    visits: Number(r.c) || 0,
  }))
  const total = Number(totalRes.results?.[0]?.c) || 0
  const totals = { pageviews: total, visits: total }

  return json({ rows, totals, meta: { site: sites.length ? sites.join(',') : 'all', since, until, dimensions: [dim], metric: 'pageviews', dataset: 'geo' } })
}

export const onRequestGet: PagesFunction<Env> = async () =>
  json({ ok: true, hint: 'POST a geo query: { dimension, since, until, limit }' })
