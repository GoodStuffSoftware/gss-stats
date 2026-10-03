// POST /api/stats range gate: the query that reaches Cloudflare is already within the account's
// limits, the response says when it was cut, and a range Cloudflare still refuses becomes the same
// notice instead of raw JSON. The GraphQL endpoint is a stubbed fetch; nothing leaves the process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from './stats'
import { installCaches, memoryCache, pagesContext, postJson } from '../_lib/testing/hitsDb'

const NOW = Date.parse('2026-10-03T16:00:00Z') // noon EDT

let cache: ReturnType<typeof memoryCache>
let undoCaches: () => void
let queries: string[]
let fetchImpl: (query: string) => { status?: number; body: unknown }

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  cache = memoryCache()
  undoCaches = installCaches(cache)
  queries = []
  fetchImpl = () => ({ body: okPayload() })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const query = JSON.parse(init.body).query as string
      queries.push(query)
      const { status = 200, body } = fetchImpl(query)
      return new Response(JSON.stringify(body), { status })
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  undoCaches()
})

const okPayload = () => ({ data: { viewer: { accounts: [{ s0: [{ count: 7, sum: { visits: 3 }, dimensions: { date: '2026-09-30' } }], s1: [], s2: [] }] } }, errors: null })
const rangeError = (msg: string) => ({ data: null, errors: [{ message: msg, path: ['viewer', 'accounts', 0, 's0'] }] })

async function post(body: Record<string, unknown>) {
  const waited: Promise<unknown>[] = []
  const req = postJson('/api/stats', { site: 'all', dimensions: ['date'], metric: 'pageviews', limit: 50, ...body })
  const res = await onRequestPost(pagesContext(req, { CF_ANALYTICS_TOKEN: 'test-token-not-real', STATS_CONFIG: {} as KVNamespace }, waited))
  await Promise.all(waited)
  return { res, json: (await res.json()) as any }
}
/** The datetime_geq / datetime_leq the first site's subquery was sent with. */
const sentRange = () => {
  const q = queries[0]
  return { geq: q.match(/datetime_geq: "([^"]+)"/)![1], leq: q.match(/datetime_leq: "([^"]+)"/)![1] }
}

describe('/api/stats — gate before querying', () => {
  it('a range inside the limits is queried exactly as asked, with no notice', async () => {
    const { res, json } = await post({ since: '2026-09-01', until: '2026-09-30' })
    expect(res.status).toBe(200)
    expect(sentRange()).toEqual({ geq: '2026-09-01T00:00:00Z', leq: '2026-10-01T00:00:00Z' })
    expect(json.notice).toBeUndefined()
    expect(json.rows).toHaveLength(1)
  })

  it('a range of exactly 93 days is not cut', async () => {
    const { json } = await post({ since: '2026-07-01T00:00:00Z', until: '2026-10-02T00:00:00Z' }) // 93 d
    expect(sentRange()).toEqual({ geq: '2026-07-01T00:00:00Z', leq: '2026-10-02T00:00:00Z' })
    expect(json.notice).toBeUndefined()
  })

  it('"Jan 1 – Sep" (the reported 38-week range) queries only the most recent allowed window and says so', async () => {
    const { res, json } = await post({ since: '2026-01-01', until: '2026-09-30' })
    expect(res.status).toBe(200)
    // Every subquery carries the cut range, never the 38-week one.
    expect(queries).toHaveLength(1)
    expect(queries[0]).not.toContain('2026-01-01')
    // A date series buckets by UTC day, so the moved start is a UTC midnight: the first bar is whole.
    expect(sentRange()).toEqual({ geq: '2026-06-30T00:00:00.000Z', leq: '2026-10-01T00:00:00.000Z' })
    expect(json.notice).toEqual({
      kind: 'range-clamped',
      source: 'cf-rum',
      reason: 'both',
      dayZone: 'utc',
      requested: { from: '2026-01-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
      served: { from: '2026-06-30T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
      limitDays: 93,
      lookbackDays: 184,
    })
    // The data is still returned. `meta` describes what the data COVERS (chart date axes are built
    // from it), so it holds the served start; the range asked for lives in notice.requested.
    expect(json.rows).toEqual([{ key: { date: '2026-09-30' }, pageviews: 7, visits: 3 }])
    expect(json.meta).toMatchObject({ since: '2026-06-30T00:00:00.000Z', until: '2026-09-30' })
  })

  it('a range that is not cut keeps meta exactly as requested', async () => {
    const { json } = await post({ since: '2026-09-01', until: '2026-09-30' })
    expect(json.meta).toMatchObject({ since: '2026-09-01', until: '2026-09-30' })
  })

  it('a start older than the lookback is moved forward even when the span is short', async () => {
    const { json } = await post({ since: '2026-03-20', until: '2026-04-10' })
    expect(sentRange().geq).toBe('2026-04-03T00:00:00.000Z')
    expect(json.notice).toMatchObject({ reason: 'lookback', served: { from: '2026-04-03T00:00:00.000Z' } })
  })

  it('a range Cloudflare would accept is not cut, even a few hours inside the lookback edge', async () => {
    // Now is Oct 3 16:00Z, so the edge is Apr 2 16:00Z. Apr 2 20:00Z is inside it: sent as asked, no notice.
    const { json } = await post({ since: '2026-04-02T20:00:00.000Z', until: '2026-05-01T04:00:00.000Z' })
    expect(sentRange()).toEqual({ geq: '2026-04-02T20:00:00.000Z', leq: '2026-05-01T04:00:00.000Z' })
    expect(json.notice).toBeUndefined()
    expect(json.meta.since).toBe('2026-04-02T20:00:00.000Z')
  })

  it('a breakdown chart (no date dimension) rounds the moved start to an ET midnight, in ET days', async () => {
    const { json } = await post({ dimensions: ['country'], since: '2026-01-01', until: '2026-09-30' })
    expect(sentRange().geq).toBe('2026-06-30T04:00:00.000Z') // Oct 1 00:00Z - 93 d = Jun 30 00:00Z → that day's ET midnight
    expect(json.notice.dayZone).toBeUndefined()
  })

  it('a range wholly older than the lookback is not queried at all: empty data and a notice', async () => {
    const { res, json } = await post({ since: '2026-01-01', until: '2026-02-28' })
    expect(res.status).toBe(200)
    expect(queries).toHaveLength(0)
    expect(json.rows).toEqual([])
    expect(json.totals).toEqual({ pageviews: 0, visits: 0 })
    expect(json.notice).toMatchObject({ reason: 'outside-lookback', served: null })
  })

  it('ET day boundaries: ET-midnight datetimes (as the dashboard sends them) are measured in elapsed time', async () => {
    // Jun 1 00:00 EDT → Oct 4 00:00 EDT is 125 days. A breakdown chart's served start is an ET midnight.
    const { json } = await post({ dimensions: ['country'], since: '2026-06-01T04:00:00.000Z', until: '2026-10-04T04:00:00.000Z' })
    expect(sentRange()).toEqual({ geq: '2026-07-03T04:00:00.000Z', leq: '2026-10-04T04:00:00.000Z' })
    expect(json.notice).toMatchObject({ reason: 'max-duration' })
  })

  it('a date series gets a UTC-midnight start instead, so its first bar is a whole UTC day', async () => {
    // end - 93 d = Jul 3 04:00Z, mid-bucket for the UTC `date` dimension → the next UTC midnight.
    const { json } = await post({ dimensions: ['date'], since: '2026-06-01T04:00:00.000Z', until: '2026-10-04T04:00:00.000Z' })
    expect(sentRange().geq).toBe('2026-07-04T00:00:00.000Z')
    expect(json.notice).toMatchObject({ reason: 'max-duration', dayZone: 'utc', served: { from: '2026-07-04T00:00:00.000Z' } })
    expect(json.meta.since).toBe('2026-07-04T00:00:00.000Z')
  })

  it('the cut response is cached under the REQUESTED range, so a repeat does not query Cloudflare again', async () => {
    await post({ since: '2026-01-01', until: '2026-09-30' })
    const again = await post({ since: '2026-01-01', until: '2026-09-30' })
    expect(queries).toHaveLength(1)
    expect(again.json.notice).toMatchObject({ reason: 'both' })
  })
})

describe('/api/stats — Cloudflare still refuses the range', () => {
  const tooWide = 'account "a32bba62c77df5e8f6bd33d04478ec34" cannot request a time range wider than 13w2d, but your query time range spans 38w2d15h32m42s924ms'
  const tooOld = 'account "a32bba62c77df5e8f6bd33d04478ec34" cannot request data older than 26w2d, but your query requests data from 28w4d6s ago'

  it.each([
    ['too wide', tooWide],
    ['too old', tooOld],
  ])('"%s" becomes the chart notice (200, no rows), not raw JSON', async (_n, message) => {
    fetchImpl = () => ({ body: rangeError(message) })
    const { res, json } = await post({ since: '2026-09-01', until: '2026-09-30' })
    expect(res.status).toBe(200)
    expect(json.error).toBeUndefined()
    expect(JSON.stringify(json)).not.toContain('a32bba62') // the account id is not echoed back
    expect(json.rows).toEqual([])
    expect(json.notice).toEqual({
      kind: 'range-clamped',
      source: 'cf-rum',
      reason: 'upstream-rejected',
      requested: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
      served: null,
      limitDays: null,
      lookbackDays: null,
    })
  })

  it('is not cached, so a corrected limit takes effect on the next request', async () => {
    fetchImpl = () => ({ body: rangeError(tooWide) })
    await post({ since: '2026-09-01', until: '2026-09-30' })
    expect(cache.keys()).toEqual([])
    fetchImpl = () => ({ body: okPayload() })
    const { json } = await post({ since: '2026-09-01', until: '2026-09-30' })
    expect(json.notice).toBeUndefined()
    expect(json.rows).toHaveLength(1)
  })

  it('does not leak the internal skip-cache marker to the browser', async () => {
    fetchImpl = () => ({ body: rangeError(tooWide) })
    const { res } = await post({ since: '2026-09-01', until: '2026-09-30' })
    expect(res.headers.get('X-Skip-Edge-Cache')).toBeNull()
  })

  it.each([
    ['too wide, as a JSON error body', 400, tooWide, true],
    ['too old, as a JSON error body', 400, tooOld, true],
    ['too wide, as plain text', 422, tooWide, false],
  ])('the same refusal arriving as a non-2xx (%s) becomes the same notice, and is not cached', async (_n, status, message, asJson) => {
    fetchImpl = () => ({ status, body: asJson ? rangeError(message) : message })
    // (a string body is JSON-encoded by the stub; the match is on the message text either way)
    const { res, json } = await post({ since: '2026-09-01', until: '2026-09-30' })
    expect(res.status).toBe(200)
    expect(json.error).toBeUndefined()
    expect(json.rows).toEqual([])
    expect(json.notice).toMatchObject({ reason: 'upstream-rejected', served: null, requested: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' } })
    expect(JSON.stringify(json)).not.toContain('a32bba62')
    expect(res.headers.get('X-Skip-Edge-Cache')).toBeNull()
    expect(cache.keys()).toEqual([])
  })

  it.each([
    ['an unrelated GraphQL error', { status: 200, body: { data: null, errors: [{ message: 'unknown field "bogus"' }] } }, 502, 'graphql error'],
    ['a non-2xx from the API', { status: 500, body: { oops: true } }, 502, 'upstream 500'],
  ])('%s keeps its current behaviour', async (_n, reply, status, error) => {
    fetchImpl = () => reply
    const { res, json } = await post({ since: '2026-09-01', until: '2026-09-30' })
    expect(res.status).toBe(status)
    expect(json.error).toBe(error)
    expect(json.notice).toBeUndefined()
  })
})
