/// <reference types="@cloudflare/workers-types" />
//
// Server-side analytics proxy. Holds the Cloudflare API token (CF_ANALYTICS_TOKEN
// secret) and queries the GraphQL Analytics API for bot-free RUM pageviews. The
// browser calls THIS endpoint; the token never reaches client-side code.
//
// POST body: {
//   site: 'goodstuff.software' | 'goodstuffsoftware.com' | 'bestsudoku.app' | 'all',
//   host?: string,                 // optional requestHost filter (a subdomain)
//   since: 'YYYY-MM-DD', until: 'YYYY-MM-DD',
//   dimensions: string[],          // 0-2 of the whitelist below
//   metric: 'pageviews' | 'visits',
//   limit: number,
//   excludeSelfReferrals?: boolean // drop empty + own-host referrers
// }

interface Env {
  CF_ANALYTICS_TOKEN: string
  STATS_CONFIG: KVNamespace
}

const ACCOUNT_ID = 'a32bba62c77df5e8f6bd33d04478ec34'
const GQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'

const SITE_TAGS: Record<string, string> = {
  'goodstuff.software': '7dd3bcb059af40f79f8df92d6d0be750',
  'goodstuffsoftware.com': '0289e02254fc4db8b73b232c59f8421f',
  'bestsudoku.app': 'a8baf99f3d294215a92a176e8c56bd15',
}

// Hosts that count as "us" — dropped from referrer charts when excludeSelfReferrals.
const OWN_HOSTS = new Set([
  'goodstuff.software',
  'www.goodstuff.software',
  'starrupture.goodstuff.software',
  'simpletile.goodstuff.software',
  'stats.goodstuff.software',
  'goodstuffsoftware.com',
  'www.goodstuffsoftware.com',
  'bestsudoku.app',
  'www.bestsudoku.app',
  'design-preview.goodstuffsoftware.pages.dev',
])

// Only these RUM dimensions may be requested (prevents invalid/injected fields).
const DIM_WHITELIST = new Set([
  'requestHost',
  'requestPath',
  'deviceType',
  'countryName',
  'refererHost',
  'userAgentBrowser',
  'userAgentOS',
  'date',
])

// Sanitize a user-agent value used in a server-side exclusion filter.
function safeUA(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z0-9 ._-]{1,40}$/.test(v) ? v : ''
}

interface ReqBody {
  site?: string
  host?: string
  hosts?: unknown // allow-list of real requestHosts (excludes dev/preview by omission)
  constraints?: unknown // drill-down field=value filters
  since?: string
  until?: string
  dimensions?: unknown
  metric?: string
  limit?: unknown
  excludeSelfReferrals?: boolean
  excludeOwnVisits?: boolean
  ownBrowser?: string
  ownOS?: string
}

interface StatsRow {
  key: Record<string, string>
  pageviews: number
  visits: number
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

// Accept a date (YYYY-MM-DD) or a full ISO datetime; fall back if malformed.
const WHEN_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/
function safeDate(v: unknown, fallback: string): string {
  return typeof v === 'string' && WHEN_RE.test(v) ? v : fallback
}
const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

// until is inclusive — add one day so datetime_leq covers the whole final day.
function nextDay(ymd: string): string {
  const d = new Date(ymd + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}

function weekAgoUTC(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 7)
  return d.toISOString().slice(0, 10)
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
 try {
  let body: ReqBody
  try {
    body = (await ctx.request.json()) as ReqBody
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  // Trim defensively — a secret uploaded via a shell pipe can pick up a trailing
  // newline/CR, which would corrupt the Bearer header (CF GraphQL returns 9106).
  const apiToken = (ctx.env.CF_ANALYTICS_TOKEN ?? '').trim()
  if (!apiToken) {
    return json({ error: 'CF_ANALYTICS_TOKEN not configured' }, 500)
  }

  const site = body.site === 'all' || (body.site && body.site in SITE_TAGS) ? body.site : 'goodstuff.software'
  const dims: string[] = Array.isArray(body.dimensions)
    ? (body.dimensions as unknown[]).filter((d): d is string => typeof d === 'string' && DIM_WHITELIST.has(d)).slice(0, 2)
    : []
  const metric = body.metric === 'visits' ? 'visits' : 'pageviews'
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 500)
  const since = safeDate(body.since, weekAgoUTC())
  const until = safeDate(body.until, todayUTC())
  const host = typeof body.host === 'string' && /^[a-z0-9.\-]+$/i.test(body.host) ? body.host : null
  // Allow-list of real requestHosts. When present, every subquery is restricted to
  // these via requestHost_in — so dev/preview hosts (absent from the list) never
  // count in any chart, not just the picker.
  const hostList: string[] = Array.isArray(body.hosts)
    ? (body.hosts as unknown[]).filter((h): h is string => typeof h === 'string' && /^[a-z0-9.\-]{1,120}$/i.test(h)).slice(0, 100)
    : []
  const excludeSelf = body.excludeSelfReferrals !== false && dims.includes('refererHost')

  // "Hide my own visits": exclude the owner's browser+OS COMBINATION (not all of
  // either). De Morgan: NOT(b AND os) === (b≠ OR os≠).
  const excludeOwn = body.excludeOwnVisits === true
  const ownBrowser = safeUA((body as any).ownBrowser)
  const ownOS = safeUA((body as any).ownOS)
  const excludeOwnClause =
    excludeOwn && ownBrowser && ownOS
      ? `, OR: [{ userAgentBrowser_neq: "${ownBrowser}" }, { userAgentOS_neq: "${ownOS}" }]`
      : ''

  // Always drop internal hosts — the dashboard itself (stats.) and the beacon's
  // landing page (beacon.) get Cloudflare Web Analytics auto-injected zone-wide,
  // so the owner's own admin usage would otherwise inflate every RUM chart.
  const excludeInternalClause =
    ', AND: [{ requestHost_neq: "stats.goodstuff.software" }, { requestHost_neq: "beacon.goodstuff.software" }]'

  // Drill-down constraints — exact field: value on whitelisted RUM dimensions.
  const gqlStr = (v: string) => v.replace(/[\\"]/g, '\\$&')
  const constraintClause = Array.isArray(body.constraints)
    ? (body.constraints as any[])
        .filter((c) => c && DIM_WHITELIST.has(c.field) && c.field !== 'date' && typeof c.value === 'string')
        .map((c) => `, ${c.field}: "${gqlStr(String(c.value))}"`)
        .join('')
    : ''

  // Day values expand to full-day bounds; full ISO datetimes are used as-is.
  const datetimeGeq = isDateOnly(since) ? `${since}T00:00:00Z` : since
  const datetimeLeq = isDateOnly(until) ? `${nextDay(until)}T00:00:00Z` : until

  const tags = site === 'all' ? Object.values(SITE_TAGS) : [SITE_TAGS[site as string]]

  // Build the dimensions sub-selection + ordering.
  const dimSelection = dims.length ? `dimensions { ${dims.join(' ')} }` : ''
  const orderBy = dims.includes('date') ? 'date_ASC' : 'count_DESC'
  // Over-fetch per tag so merge+limit downstream stays accurate.
  const perTagLimit = Math.min(limit * 3, 1000)

  const fields = tags
    .map((tag, i) => {
      const hostClause = hostList.length
        ? `, requestHost_in: [${hostList.map((h) => `"${h}"`).join(', ')}]`
        : host
          ? `, requestHost: "${host}"`
          : ''
      return `s${i}: rumPageloadEventsAdaptiveGroups(
        limit: ${perTagLimit}
        orderBy: [${orderBy}]
        filter: { datetime_geq: "${datetimeGeq}", datetime_leq: "${datetimeLeq}", siteTag: "${tag}"${hostClause}${constraintClause}${excludeOwnClause}${excludeInternalClause} }
      ) { count sum { visits } ${dimSelection} }`
    })
    .join('\n')

  const query = `query {
    viewer {
      accounts(filter: { accountTag: "${ACCOUNT_ID}" }) {
        ${fields}
      }
    }
  }`

  let payload: any
  try {
    const res = await fetch(GQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      // Cap the upstream call. Without this, a stalled GraphQL Analytics API leaves the
      // Function hanging until the platform kills it — surfacing as a Cloudflare HTML 502
      // page instead of a clean error the dashboard can show (and retry past).
      signal: AbortSignal.timeout(20000),
    })
    // A non-2xx from the API is often an HTML error page, which would make res.json()
    // throw an opaque parse error — read it as text and report the status instead.
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200)
      return json({ error: `upstream ${res.status}`, detail: body }, 502)
    }
    payload = await res.json()
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError'
    return json({ error: timedOut ? 'upstream timed out' : 'upstream fetch failed', detail: String(e) }, 502)
  }

  if (payload.errors) {
    return json({ error: 'graphql error', detail: payload.errors }, 502)
  }

  const account = payload?.data?.viewer?.accounts?.[0]
  if (!account) return json({ error: 'no account data', detail: payload }, 502)

  // Merge rows across all queried site tags, summing by the dimension key.
  const merged = new Map<string, StatsRow>()
  for (let i = 0; i < tags.length; i++) {
    const groups: any[] = account[`s${i}`] ?? []
    for (const g of groups) {
      const key: Record<string, string> = {}
      for (const d of dims) key[d] = String(g.dimensions?.[d] ?? '')
      const mapKey = JSON.stringify(key)
      const existing = merged.get(mapKey)
      const pv = Number(g.count) || 0
      const vis = Number(g.sum?.visits) || 0
      if (existing) {
        existing.pageviews += pv
        existing.visits += vis
      } else {
        merged.set(mapKey, { key, pageviews: pv, visits: vis })
      }
    }
  }

  let rows = [...merged.values()]

  // Default filtering: clean external referrer list.
  if (excludeSelf) {
    rows = rows.filter((r) => {
      const ref = r.key.refererHost
      return ref && !OWN_HOSTS.has(ref)
    })
  }

  // Totals reflect the full filtered set (before top-N truncation).
  const totals = rows.reduce(
    (acc, r) => ({ pageviews: acc.pageviews + r.pageviews, visits: acc.visits + r.visits }),
    { pageviews: 0, visits: 0 },
  )

  // Sort + truncate to the requested top-N (date series stays chronological).
  if (dims.includes('date')) {
    rows.sort((a, b) => (a.key.date < b.key.date ? -1 : 1))
  } else {
    const m = metric as 'pageviews' | 'visits'
    rows.sort((a, b) => b[m] - a[m])
  }
  rows = rows.slice(0, limit)

  return json({
    rows,
    totals,
    meta: { site, host, since, until, dimensions: dims, metric },
  })
 } catch (e) {
  // Belt-and-suspenders: any unhandled error becomes a readable JSON 500 instead of a raw
  // Cloudflare HTML 502, so the dashboard shows the real message and we can see what failed.
  return json({ error: 'stats handler error', detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, 500)
 }
}

// Friendly GET for sanity checks / health.
export const onRequestGet: PagesFunction<Env> = async () =>
  json({ ok: true, hint: 'POST a query body to this endpoint.' })
