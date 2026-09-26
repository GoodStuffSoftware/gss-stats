/// <reference types="@cloudflare/workers-types" />
//
// GET /api/sites — the auto-built site list for the filter picker. Reads distinct
// hosts from BOTH datasets (RUM requestHost via GraphQL ≤90d, beacon site tags via
// D1), then FOLDS aliases into their canonical site: a host that HTTP-redirects
// (3xx Location) or declares <link rel="canonical"> pointing elsewhere has its
// traffic (RUM hosts + beacon tags + counts) merged into the canonical host. Results
// group by registrable domain; dev/preview/infra hosts are dropped. The alias lookup
// is cached in KV (24h) so it isn't an HTTP call on every dashboard load. The `geo` count is
// bounded to a rolling 90-day window (not all-time — see GEO_COUNT_WINDOW_MS below), and the
// whole response is cached via the Cache API for a few minutes (RESPONSE_CACHE_TTL_SECONDS).
//
// Response: { sites: [ { domain, rum, geo, subs: [ { host, hosts, tag, tags, rum, geo } ] } ] }
// `geo`/`rum` are last-90-days counts, not all-time.

import { popupExcludeClause } from '../../src/lib/popupEvents'
import { cachedJson, type CacheLike } from '../_lib/edgeCache'

interface Env {
  CF_ANALYTICS_TOKEN: string
  gss_geo: D1Database
  STATS_CONFIG: KVNamespace
}

// This endpoint's own response cache (distinct from the alias-map KV cache above): the whole
// GET has no request params, so there is exactly one cache entry, keyed by a fixed URL. Short
// TTL — it's a UI convenience list, not a number anyone needs real-time, and correctness only
// requires it to catch up within a few dashboard loads. Cache API, not KV: KV's Free-plan write
// cap is 1,000/day account-wide (shared with the dashboard's own layout-save writes), while the
// Cache API has no write-count cap — see docs/capacity.md.
const RESPONSE_CACHE_KEY = 'https://edge-cache.internal/api/sites'
const RESPONSE_CACHE_TTL_SECONDS = 300 // 5 min

// The site-tag counts badge only needs to reflect recent activity (it's a sort/relevance signal
// in the filter picker, not an all-time total) — bounding it to the same rolling window as the
// RUM query above lets SQLite use idx_hits_ts instead of scanning the whole table on every call,
// and keeps this endpoint bounded as `hits` grows. See docs/capacity.md.
const GEO_COUNT_WINDOW_MS = 90 * 86_400_000

const ACCOUNT_ID = 'a32bba62c77df5e8f6bd33d04478ec34'
const GQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'
const SITE_TAGS = [
  '7dd3bcb059af40f79f8df92d6d0be750', // goodstuff.software (+ starrupture/simpletile)
  '0289e02254fc4db8b73b232c59f8421f', // goodstuffsoftware.com
  'a8baf99f3d294215a92a176e8c56bd15', // bestsudoku.app
]
const CANON_ALIAS: Record<string, string> = { 'star-rupture-planner': 'starrupture' }
const ALIAS_KEY = 'site-alias-map'
const ALIAS_TTL = 86_400_000 // 24h

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const firstLabel = (h: string) => String(h || '').split('.')[0].toLowerCase()
function regDomain(host: string): string {
  const parts = String(host || '').split('.').filter(Boolean)
  return parts.length <= 2 ? host : parts.slice(-2).join('.')
}
const DEV_LABELS = /^(dev\d*|dash|staging|stage|preview|test|testing|qa|uat|beta|sandbox|demo|local(host)?)$/i
const isExcludedHost = (h: string) =>
  /^(stats|beacon)\./i.test(h) || /\.pages\.dev$/i.test(h) || /\.workers\.dev$/i.test(h) || DEV_LABELS.test(firstLabel(h))
function hostOf(u: string): string {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

// Detect whether `host` is an alias — a 3xx redirect target, or a rel="canonical"
// pointing at a different host. Returns the canonical host, or null.
async function detectCanonical(host: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${host}/`, {
      redirect: 'manual',
      headers: { 'user-agent': 'gss-stats-alias-check' },
      signal: AbortSignal.timeout(5000), // don't let a slow/hung host stall the sites list
    })
    if (res.status >= 300 && res.status < 400) {
      const c = hostOf(res.headers.get('location') ?? '')
      return c && c !== host ? c : null
    }
    if (res.status === 200) {
      const html = (await res.text()).slice(0, 30_000)
      const tag = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)
      const href = tag && tag[0].match(/href=["']([^"']+)["']/i)
      if (href) {
        const c = hostOf(href[1])
        return c && c !== host ? c : null
      }
    }
  } catch {
    /* host unreachable — treat as not an alias */
  }
  return null
}

// aliasMap[aliasHost] = canonicalHost. Cached in KV (24h); refreshed in the
// background when stale so a normal request never blocks on the HTTP probes.
async function getAliasMap(env: Env, hosts: string[], waitUntil: (p: Promise<unknown>) => void): Promise<Record<string, string>> {
  let cached: { map: Record<string, string>; ts: number } | null = null
  try {
    const raw = await env.STATS_CONFIG.get(ALIAS_KEY)
    if (raw) cached = JSON.parse(raw)
  } catch {
    /* ignore */
  }
  const compute = async (): Promise<Record<string, string>> => {
    const map: Record<string, string> = {}
    await Promise.all(
      hosts.map(async (h) => {
        const c = await detectCanonical(h)
        if (c) map[h] = c
      }),
    )
    try {
      await env.STATS_CONFIG.put(ALIAS_KEY, JSON.stringify({ map, ts: Date.now() }))
    } catch {
      /* ignore */
    }
    return map
  }
  if (!cached) return compute() // first ever — compute inline (one-time slow load)
  if (Date.now() - cached.ts > ALIAS_TTL) waitUntil(compute()) // stale — refresh in background
  return cached.map
}

interface Raw {
  rum: number
  geo: number
  tags: Set<string>
}
interface Sub {
  host: string
  hosts: Set<string>
  tag: string | null
  tags: Set<string>
  rum: number
  geo: number
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const cache = (caches as unknown as { default: CacheLike }).default
  return cachedJson(cache, RESPONSE_CACHE_KEY, RESPONSE_CACHE_TTL_SECONDS, ctx.waitUntil.bind(ctx), () => computeSitesResponse(ctx))
}

async function computeSitesResponse(ctx: Parameters<PagesFunction<Env>>[0]): Promise<Response> {
  const raw = new Map<string, Raw>() // host → raw counts before folding
  const get = (host: string): Raw => {
    let e = raw.get(host)
    if (!e) raw.set(host, (e = { rum: 0, geo: 0, tags: new Set() }))
    return e
  }

  // ── RUM requestHosts (GraphQL, rolling 90d) ──────────────────────────────────
  const token = (ctx.env.CF_ANALYTICS_TOKEN ?? '').trim()
  if (token) {
    const until = new Date().toISOString()
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const fields = SITE_TAGS.map(
      (t, i) =>
        `s${i}: rumPageloadEventsAdaptiveGroups(limit: 200, filter: { datetime_geq: "${since}", datetime_leq: "${until}", siteTag: "${t}" }) { count dimensions { requestHost } }`,
    ).join('\n')
    const query = `query { viewer { accounts(filter: { accountTag: "${ACCOUNT_ID}" }) { ${fields} } } }`
    try {
      const res = await fetch(GQL_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const payload: any = await res.json()
      const acct = payload?.data?.viewer?.accounts?.[0]
      if (acct)
        for (let i = 0; i < SITE_TAGS.length; i++)
          for (const g of (acct[`s${i}`] ?? []) as any[]) {
            const host = String(g.dimensions?.requestHost ?? '')
            if (host && !isExcludedHost(host)) get(host).rum += Number(g.count) || 0
          }
    } catch {
      /* RUM unavailable */
    }
  }

  // Index RUM hosts by first label so beacon tags can attach to the right host.
  const byLabel = new Map<string, string>()
  for (const host of raw.keys()) if (!byLabel.has(firstLabel(host))) byLabel.set(firstLabel(host), host)

  // ── Beacon tags (D1) → attach to the matching host ───────────────────────────
  try {
    // Popup/event-beacon rows (sign-in prompt, upsell, install, …) aren't screen
    // views — exclude them so this count matches what the dashboard shows elsewhere.
    // Bounded to a rolling window (see GEO_COUNT_WINDOW_MS above) so this is a SEARCH on
    // idx_hits_ts instead of a full-table SCAN — this used to read every row in `hits` on
    // every single dashboard load regardless of date range (docs/capacity.md §4).
    const w = ["site <> ''", 'ts >= ?']
    const b: unknown[] = [Date.now() - GEO_COUNT_WINDOW_MS]
    popupExcludeClause(w, b)
    const r = await ctx.env.gss_geo.prepare(`SELECT site, COUNT(*) c FROM hits WHERE ${w.join(' AND ')} GROUP BY site`).bind(...b).all()
    for (const row of (r.results ?? []) as any[]) {
      const tag = CANON_ALIAS[String(row.site)] ?? String(row.site)
      const host = byLabel.get(firstLabel(tag)) ?? tag
      if (isExcludedHost(host)) continue
      const e = get(host)
      e.tags.add(tag)
      e.geo += Number(row.c) || 0
    }
  } catch {
    /* D1 unavailable */
  }

  // ── Fold aliases into their canonical host ───────────────────────────────────
  const aliasMap = await getAliasMap(ctx.env, [...raw.keys()], ctx.waitUntil.bind(ctx))
  const canon = (h: string): string => {
    let x = h
    const seen = new Set<string>()
    while (aliasMap[x] && !seen.has(x) && !isExcludedHost(aliasMap[x])) {
      seen.add(x)
      x = aliasMap[x]
    }
    return x
  }
  const subs = new Map<string, Sub>() // canonical host → folded sub
  for (const [host, v] of raw) {
    const c = canon(host)
    let s = subs.get(c)
    if (!s) subs.set(c, (s = { host: c, hosts: new Set(), tag: null, tags: new Set(), rum: 0, geo: 0 }))
    s.hosts.add(host)
    v.tags.forEach((t) => s!.tags.add(t))
    s.rum += v.rum
    s.geo += v.geo
  }

  // ── Group by registrable domain of the canonical host ────────────────────────
  const groups = new Map<string, { domain: string; rum: number; geo: number; subs: Sub[] }>()
  for (const s of subs.values()) {
    s.tag = [...s.tags][0] ?? null
    const dom = regDomain(s.host)
    let g = groups.get(dom)
    if (!g) groups.set(dom, (g = { domain: dom, rum: 0, geo: 0, subs: [] }))
    g.rum += s.rum
    g.geo += s.geo
    g.subs.push(s)
  }

  const sites = [...groups.values()]
    .map((g) => ({
      domain: g.domain,
      rum: g.rum,
      geo: g.geo,
      subs: g.subs
        .map((s) => ({ host: s.host, hosts: [...s.hosts], tag: s.tag, tags: [...s.tags], rum: s.rum, geo: s.geo }))
        .sort((a, b) => b.rum + b.geo - (a.rum + a.geo)),
    }))
    .sort((a, b) => b.rum + b.geo - (a.rum + a.geo))

  return json({ sites })
}
