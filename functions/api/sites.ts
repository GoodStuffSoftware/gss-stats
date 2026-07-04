/// <reference types="@cloudflare/workers-types" />
//
// GET /api/sites — the auto-built site list for the filter picker. Reads distinct
// hosts from BOTH datasets (RUM requestHost via GraphQL ≤90d, beacon site tags via
// D1), then FOLDS aliases into their canonical site: a host that HTTP-redirects
// (3xx Location) or declares <link rel="canonical"> pointing elsewhere has its
// traffic (RUM hosts + beacon tags + counts) merged into the canonical host. Results
// group by registrable domain; dev/preview/infra hosts are dropped. The alias lookup
// is cached in KV (24h) so it isn't an HTTP call on every dashboard load.
//
// Response: { sites: [ { domain, rum, geo, subs: [ { host, hosts, tag, tags, rum, geo } ] } ] }

interface Env {
  CF_ANALYTICS_TOKEN: string
  gss_geo: D1Database
  STATS_CONFIG: KVNamespace
}

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
    const r = await ctx.env.gss_geo.prepare("SELECT site, COUNT(*) c FROM hits WHERE site <> '' GROUP BY site").all()
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
