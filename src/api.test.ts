import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAdsReadings, fetchCampaignCompare, fetchOverview, fetchStats } from './api'
import { isAuthError, sessionExpired } from './session'
import type { GlobalFilters, Widget } from './types'

// Every data fetch in api.ts must end in the same expired-session handling: a 401 from
// the auth gate (functions/_lib/auth.ts) raises the re-sign-in banner via the confirming
// probe in session.ts, never just an error message on one card or page.

const filters = { since: '2026-09-01T00:00:00Z', until: '2026-09-25T00:00:00Z' } as GlobalFilters
const popupWidget = { id: 'w', i: 'w', title: 'Pop-ups', type: 'bar', dataset: 'popup', dimension: 'kind', popup: 'signin-prompt' } as unknown as Widget

type Reply = Response | { type: string; status: number } | Error
let calls: { url: string; init?: RequestInit }[] = []

function stubFetch(dataReply: Reply, probeReply: Reply) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const reply = url === '/api/config' && init?.redirect === 'manual' ? probeReply : dataReply
      if (reply instanceof Error) throw reply
      return reply
    }),
  )
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: 'unauthenticated', signIn: '/auth/google/login' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
const probeCalls = () => calls.filter((c) => c.url === '/api/config' && c.init?.redirect === 'manual')

beforeEach(() => {
  sessionExpired.value = false
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bespoke-page and readings-log fetchers raise the re-sign-in banner on an expired session', () => {
  it.each([
    ['overview', () => fetchOverview(filters.since, filters.until), '/api/overview'],
    ['campaigns', () => fetchCampaignCompare('bsk-search'), '/api/campaigns'],
    ['readings', () => fetchAdsReadings('limit=30'), '/api/ads/readings?limit=30'],
  ] as const)('%s: a 401 from the gate probes and sets sessionExpired, then rethrows', async (name, call, url) => {
    stubFetch(unauthorized(), unauthorized())
    await expect(call()).rejects.toThrow(new RegExp(`^${name} 401:`))
    expect(calls[0].url).toBe(url)
    expect(probeCalls()).toHaveLength(1)
    expect(sessionExpired.value).toBe(true)
  })

  it.each([
    ['overview', () => fetchOverview()],
    ['campaigns', () => fetchCampaignCompare('bsk-search')],
    ['readings', () => fetchAdsReadings('limit=30')],
  ] as const)('%s: an expired Access session (network error + opaque redirect) also sets it', async (_name, call) => {
    stubFetch(new TypeError('Failed to fetch'), { type: 'opaqueredirect', status: 0 })
    await expect(call()).rejects.toThrow(TypeError)
    expect(probeCalls()).toHaveLength(1)
    expect(sessionExpired.value).toBe(true)
  })

  it.each([
    ['overview', () => fetchOverview()],
    ['campaigns', () => fetchCampaignCompare('bsk-search')],
    ['readings', () => fetchAdsReadings('limit=30')],
  ] as const)('%s: a server error neither probes nor signs out', async (name, call) => {
    stubFetch(new Response('boom', { status: 500 }), unauthorized())
    await expect(call()).rejects.toThrow(new RegExp(`^${name} 500:`))
    expect(probeCalls()).toHaveLength(0)
    expect(sessionExpired.value).toBe(false)
  })

  it('a 401 that the probe does not confirm leaves the banner off', async () => {
    stubFetch(unauthorized(), new Response('{}', { status: 200 }))
    await expect(fetchOverview()).rejects.toThrow(/^overview 401:/)
    expect(probeCalls()).toHaveLength(1)
    expect(sessionExpired.value).toBe(false)
  })
})

describe('pop-up charts go through ChartCard’s 401 handling', () => {
  it('a 401 from /api/popups surfaces as an error ChartCard treats as an auth error', async () => {
    stubFetch(unauthorized(), unauthorized())
    let err: unknown
    await fetchStats(popupWidget, filters).catch((e) => (err = e))
    expect(calls[0].url).toBe('/api/popups')
    expect(String((err as Error).message)).toMatch(/^popups 401:/)
    expect(isAuthError(err)).toBe(true)
  })
})
