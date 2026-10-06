// GET /api/live: every branch of the upgrade checks, and proof that nothing from the incoming
// request reaches gss-live. (The sign-in gate in front of it is covered in workerd by
// functions/_lib/auth.workerd-harness.ts webSocketUpgradePassesTheGate.)
import { describe, expect, it } from 'vitest'
import { LIVE_UPSTREAM_URL, onRequestGet } from './live'

const ORIGIN = 'https://stats.goodstuff.software'
// Node's Response refuses status 101, so the fake gss-live returns this stand-in, and the tests
// check the handler hands back exactly what the binding returned.
const UPGRADED = { status: 101, webSocket: { socket: true }, upgraded: true } as unknown as Response

function fakeLive(reply: () => Promise<Response> = async () => UPGRADED) {
  const seen: Request[] = []
  return {
    seen,
    binding: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(input instanceof Request && init === undefined ? input : new Request(input, init))
        return reply()
      },
    } as unknown as Fetcher,
  }
}

function call(headers: Record<string, string>, env: { LIVE?: Fetcher }, path = '/api/live') {
  const request = new Request(`${ORIGIN}${path}`, { headers })
  return onRequestGet({ request, env } as any)
}

const upgradeFrom = (origin: string | null, extra: Record<string, string> = {}) => ({
  Upgrade: 'websocket',
  ...(origin === null ? {} : { Origin: origin }),
  ...extra,
})

async function errorOf(res: Response) {
  expect(res.headers.get('Content-Type')).toBe('application/json')
  expect(res.headers.get('Cache-Control')).toBe('no-store')
  return ((await res.json()) as { error: string }).error
}

describe('GET /api/live', () => {
  it('426 without Upgrade: websocket, and gss-live is never called', async () => {
    const cases: Record<string, string>[] = [{ Origin: ORIGIN }, { Origin: ORIGIN, Upgrade: 'h2c' }, { Origin: ORIGIN, Upgrade: '' }]
    for (const headers of cases) {
      const live = fakeLive()
      const res = await call(headers, { LIVE: live.binding })
      expect(res.status).toBe(426)
      expect(res.headers.get('Upgrade')).toBe('websocket')
      expect(await errorOf(res)).toBe('websocket upgrade required')
      expect(live.seen).toHaveLength(0)
    }
  })

  it('accepts the Upgrade value case-insensitively', async () => {
    const live = fakeLive()
    expect(await call({ Upgrade: 'WebSocket', Origin: ORIGIN }, { LIVE: live.binding })).toBe(UPGRADED)
  })

  it.each([
    ['a missing Origin', null],
    ['a foreign site', 'https://evil.example'],
    ['a same-site sibling', 'https://beacon.goodstuff.software'],
    ['the same host over http', 'http://stats.goodstuff.software'],
    ['the same host on another port', 'https://stats.goodstuff.software:8443'],
    ['the literal "null" origin', 'null'],
  ])('403 for %s, and gss-live is never called', async (_label, origin) => {
    const live = fakeLive()
    const res = await call(upgradeFrom(origin), { LIVE: live.binding })
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe('cross-origin websocket refused')
    expect(live.seen).toHaveLength(0)
  })

  it('compares Origin with the request’s own origin (local dev on loopback)', async () => {
    const live = fakeLive()
    const request = new Request('http://localhost:8788/api/live', { headers: upgradeFrom('http://localhost:8788') })
    expect(await onRequestGet({ request, env: { LIVE: live.binding } } as any)).toBe(UPGRADED)
    const refused = new Request('http://localhost:8788/api/live', { headers: upgradeFrom('http://localhost:5173') })
    expect((await onRequestGet({ request: refused, env: { LIVE: live.binding } } as any)).status).toBe(403)
  })

  it('503 when the LIVE binding is absent', async () => {
    const res = await call(upgradeFrom(ORIGIN), {})
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe('live updates unavailable')
  })

  it('503 when the binding throws (gss-live not reachable), never an uncaught error', async () => {
    const live = fakeLive(async () => {
      throw new Error('no such service')
    })
    const res = await call(upgradeFrom(ORIGIN), { LIVE: live.binding })
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe('live updates unavailable')
  })

  it('a same-origin upgrade returns exactly what gss-live returned', async () => {
    const live = fakeLive()
    expect(await call(upgradeFrom(ORIGIN), { LIVE: live.binding })).toBe(UPGRADED)
    expect(live.seen).toHaveLength(1)
  })

  it.each([
    ['its own 503 (socket cap)', () => new Response('Too many connections', { status: 503, headers: { 'X-Detail': 'secret' } })],
    ['a 404', () => new Response('Not found', { status: 404 })],
    ['a 426', () => new Response('Expected a WebSocket upgrade', { status: 426, headers: { Upgrade: 'websocket' } })],
    ['a 500 with a stack-like body', () => new Response('TypeError: at index.ts:42', { status: 500 })],
    ['a 200 that is not an upgrade', () => new Response('hub', { status: 200 })],
    ['a 101 without a socket', () => ({ status: 101, webSocket: null }) as unknown as Response],
  ])('maps %s from gss-live to a bare 503 with no detail', async (_label, make) => {
    const live = fakeLive(async () => make())
    const res = await call(upgradeFrom(ORIGIN), { LIVE: live.binding })
    expect(res.status).toBe(503)
    expect(res.headers.get('X-Detail')).toBeNull()
    expect(res.headers.get('Upgrade')).toBeNull()
    expect(await errorOf(res)).toBe('live updates unavailable')
  })

  it('cancels the unused upstream body of a non-101 answer and returns the bare 503', async () => {
    let cancelled = 0
    const upstream = new Response('Too many connections', { status: 503 })
    Object.defineProperty(upstream, 'body', {
      value: { cancel: async () => void cancelled++ },
    })
    const res = await call(upgradeFrom(ORIGIN), { LIVE: fakeLive(async () => upstream).binding })
    expect(res.status).toBe(503)
    expect(cancelled).toBe(1)
    expect(await errorOf(res)).toBe('live updates unavailable')
  })

  it('still returns the bare 503 when cancelling the upstream body throws', async () => {
    const upstream = new Response('x', { status: 500 })
    Object.defineProperty(upstream, 'body', {
      value: { cancel: async () => { throw new Error('already released') } },
    })
    const res = await call(upgradeFrom(ORIGIN), { LIVE: fakeLive(async () => upstream).binding })
    expect(res.status).toBe(503)
    expect(await errorOf(res)).toBe('live updates unavailable')
  })

  it('does not wait on a cancel that never settles: the bare 503 comes back anyway', async () => {
    const upstream = new Response('x', { status: 500 })
    Object.defineProperty(upstream, 'body', { value: { cancel: () => new Promise<void>(() => {}) } })
    const res = await Promise.race([
      call(upgradeFrom(ORIGIN), { LIVE: fakeLive(async () => upstream).binding }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ])
    expect(res).not.toBeNull()
    expect(res!.status).toBe(503)
    expect(await errorOf(res!)).toBe('live updates unavailable')
  })

  it('forwards nothing from the incoming request: only GET + Upgrade: websocket to the fixed URL', async () => {
    const live = fakeLive()
    const res = await call(
      upgradeFrom(ORIGIN, {
        Cookie: '__Host-gss_session=secret-session; other=1',
        Authorization: 'Bearer secret-token',
        'Cf-Access-Jwt-Assertion': 'secret-jwt',
        'Cf-Connecting-Ip': '203.0.113.7',
        'X-Forwarded-For': '203.0.113.7',
        'User-Agent': 'Mozilla/5.0 test',
        'Accept-Language': 'en-US',
        Referer: `${ORIGIN}/dash`,
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Protocol': 'evil',
        'X-Anything': 'x',
      }),
      { LIVE: live.binding },
      '/api/live?token=abc&since=1',
    )
    expect(res).toBe(UPGRADED)
    expect(live.seen).toHaveLength(1)
    const sent = live.seen[0]
    expect(sent.url).toBe(LIVE_UPSTREAM_URL)
    expect(sent.url).toBe('https://gss-live/ws')
    expect(sent.method).toBe('GET')
    expect(sent.body).toBeNull()
    expect([...sent.headers]).toEqual([['upgrade', 'websocket']])
  })
})
