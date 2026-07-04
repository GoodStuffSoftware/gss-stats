/// <reference types="@cloudflare/workers-types" />
//
// GET /api/sites — the auto-built site list for the filter picker. Reads distinct
// hosts from BOTH datasets (RUM requestHost via GraphQL ≤90d, beacon site tags via
// D1) and groups them by registrable domain (the "site"), with each real host a
// selectable subdomain under it. The beacon's short tags (e.g. "starrupture") are
// folded into their matching RUM host ("starrupture.goodstuff.software") so the same
// place appears once. Infra/preview hosts are dropped.
//
// Response: { sites: [ { domain, rum, geo, subs: [ { host, tag, rum, geo } ] } ] }

interface Env {
  CF_ANALYTICS_TOKEN: string
  gss_geo: D1Database
}

const ACCOUNT_ID = 'a32bba62c77df5e8f6bd33d04478ec34'
const GQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'
const SITE_TAGS = [
  '7dd3bcb059af40f79f8df92d6d0be750', // goodstuff.software (+ starrupture/simpletile)
  '0289e02254fc4db8b73b232c59f8421f', // goodstuffsoftware.com
  'a8baf99f3d294215a92a176e8c56bd15', // bestsudoku.app
]

// Non-canonical beacon tags (preview deploys / project slugs) → their real site.
const CANON_ALIAS: Record<string, string> = { 'star-rupture-planner': 'starrupture' }

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const firstLabel = (h: string) => String(h || '').split('.')[0].toLowerCase()
// Registrable domain ≈ last two labels. Fine for .software/.com/.app (single-level
// TLDs); multi-level TLDs like .co.uk would need the Public Suffix List.
function regDomain(host: string): string {
  const parts = String(host || '').split('.').filter(Boolean)
  return parts.length <= 2 ? host : parts.slice(-2).join('.')
}
// Dev/preview subdomain labels (dev, dev01, dash, staging, preview, test, …) — not
// real audience. Matched on the leftmost label of a host.
const DEV_LABELS = /^(dev\d*|dash|staging|stage|preview|test|testing|qa|uat|beta|sandbox|demo|local(host)?)$/i
// A host we never surface: our own infra, CF preview/worker deploys, or a dev subdomain.
const isExcludedHost = (h: string) =>
  /^(stats|beacon)\./i.test(h) ||
  /\.pages\.dev$/i.test(h) ||
  /\.workers\.dev$/i.test(h) ||
  DEV_LABELS.test(firstLabel(h))

interface Sub {
  host: string
  tag: string | null
  rum: number
  geo: number
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const hosts = new Map<string, Sub>() // full host → subdomain entry
  const sub = (host: string): Sub => {
    let e = hosts.get(host)
    if (!e) {
      e = { host, tag: null, rum: 0, geo: 0 }
      hosts.set(host, e)
    }
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
            if (host && !isExcludedHost(host)) sub(host).rum += Number(g.count) || 0
          }
    } catch {
      /* RUM unavailable — beacon-only list */
    }
  }

  // Index RUM hosts by first label so beacon tags can attach to the right host.
  const byLabel = new Map<string, string>()
  for (const host of hosts.keys()) if (!byLabel.has(firstLabel(host))) byLabel.set(firstLabel(host), host)

  // ── Beacon tags (D1) → fold into the matching host ───────────────────────────
  try {
    const r = await ctx.env.gss_geo
      .prepare("SELECT site, COUNT(*) c FROM hits WHERE site <> '' GROUP BY site")
      .all()
    for (const row of (r.results ?? []) as any[]) {
      const tag = CANON_ALIAS[String(row.site)] ?? String(row.site)
      const host = byLabel.get(firstLabel(tag)) ?? tag // fall back to the tag as its own host
      if (isExcludedHost(host)) continue // skip dev/preview beacon tags too
      const e = sub(host)
      e.tag = tag
      e.geo += Number(row.c) || 0
    }
  } catch {
    /* D1 unavailable — RUM-only list */
  }

  // ── Group hosts by registrable domain ────────────────────────────────────────
  const groups = new Map<string, { domain: string; rum: number; geo: number; subs: Sub[] }>()
  for (const s of hosts.values()) {
    const dom = regDomain(s.host)
    let g = groups.get(dom)
    if (!g) groups.set(dom, (g = { domain: dom, rum: 0, geo: 0, subs: [] }))
    g.rum += s.rum
    g.geo += s.geo
    g.subs.push(s)
  }
  const sites = [...groups.values()]
    .map((g) => ({ ...g, subs: g.subs.sort((a, b) => b.rum + b.geo - (a.rum + a.geo)) }))
    .sort((a, b) => b.rum + b.geo - (a.rum + a.geo))

  return json({ sites })
}
