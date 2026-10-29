// A fetch stand-in for the App-level tests (App.*.test.ts), which mount the whole app under
// happy-dom. Without it every mounted widget makes a REAL request: relative URLs resolve against
// happy-dom's http://localhost:3000 and die with ECONNREFUSED, and the world map's land data
// goes out to a public CDN. Neither belongs in a unit test, and both burn CPU and sockets that
// make the suite time out when several run at once.
//
// Install it per test, in `beforeEach` (an `afterEach` that calls vi.unstubAllGlobals() removes
// it again):
//
//   beforeEach(() => { stubAppFetch() })
//
// Every endpoint the app can reach on mount answers with a small, valid, EMPTY payload, so a
// widget lands in its "no data" state instead of its "request failed" one. Any other URL
// rejects loudly (and is listed in `unexpected`), so a new, unmocked request cannot slip in
// unnoticed.
import { vi, type Mock } from 'vitest'

type FetchInput = string | URL | Request

export interface AppFetch {
  /** The stub installed as the global `fetch`. */
  fetch: Mock<(input: FetchInput, init?: RequestInit) => Promise<Response>>
  /** URLs requested that this helper has no answer for (each also rejected). */
  unexpected: string[]
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Answer for one request, or undefined when the URL is not one the app is expected to make. */
function answer(path: string, init?: RequestInit): Response | undefined {
  // The metrics runtime (useMetrics): a valid reply with no results leaves every card in its
  // plain "no value" state.
  if (path === '/api/metrics') return json({ v: 1, generatedAt: '1970-01-01T00:00:00Z', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } })
  // Chart data (api.ts fetchStats / fetchSeriesStats): an empty result set.
  if (path === '/api/stats' || path === '/api/geo') {
    const empty = { rows: [], totals: { pageviews: 0, visits: 0 }, meta: { site: 'all', host: null, since: '', until: '', dimensions: [], metric: 'pageviews' } }
    // A featureStep series chart asks for all its series at once (api.ts fetchSeriesStats): one empty answer per series.
    const steps = typeof init?.body === 'string' ? (JSON.parse(init.body) as { stepSeries?: unknown[] }).stepSeries : undefined
    return json(Array.isArray(steps) ? { series: steps.map(() => empty) } : empty)
  }
  // The sites list and the sign-in probes.
  if (path === '/api/sites') return json({ sites: [] })
  if (path === '/auth/me') return json({ email: null }, 401)
  // The world map's land outline: an empty feature list draws just the ocean panel.
  if (path.startsWith('https://cdn.jsdelivr.net/gh/martynafford/natural-earth-geojson/')) return json({ type: 'FeatureCollection', features: [] })
  return undefined
}

export function stubAppFetch(): AppFetch {
  // The App now keeps ?page=<id> in the address bar (page deep links); each test starts from a clean URL,
  // as a fresh browser tab would, so one test's page never leaks into the next one's load.
  globalThis.history?.replaceState(null, '', '/')
  const unexpected: string[] = []
  const fn = vi.fn(async (input: FetchInput, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const res = answer(url, init)
    if (res) return res
    unexpected.push(url)
    throw new Error(`unmocked fetch in an App test: ${url}`)
  })
  vi.stubGlobal('fetch', fn)
  return { fetch: fn, unexpected }
}
