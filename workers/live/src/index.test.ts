// gss-live unit tests (Node, with `cloudflare:workers` aliased to workers/live/test/cloudflare-workers-stub.ts).
// One test per counts-only guarantee in the push build plan: the DO stores only its alarm, pings are
// only {"t":"changed"} at a fixed 15-minute boundary, notify() takes nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { etDateFast, etWallTimeMs } from '../../../src/lib/etTime'
import { BOUNDARY_MS, MAX_SOCKETS, nextBoundary, PING } from './hub'
import worker, * as entry from './index'
import { LiveHub, Notify, type Env } from './index'

class FakeAutoResponsePair {
  constructor(
    public request: string,
    public response: string,
  ) {}
}
class FakeSocket {
  sent: unknown[] = []
  closed: unknown[] | null = null
  throwOnSend = false
  send(m: unknown) {
    if (this.throwOnSend) throw new Error('socket is dead')
    this.sent.push(m)
  }
  close(...args: unknown[]) {
    this.closed = args
  }
}

/** A ctx whose storage can do exactly two things: getAlarm and setAlarm. Anything else throws. */
function makeCtx(sockets: FakeSocket[] = []) {
  let alarm: number | null = null
  const setAlarm = vi.fn(async (t: number) => {
    alarm = t
  })
  const getAlarm = vi.fn(async () => alarm)
  const storage = new Proxy(
    { getAlarm, setAlarm },
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop]
        throw new Error(`LiveHub touched storage.${String(prop)}: it may only hold its alarm`)
      },
    },
  )
  const accepted: FakeSocket[] = []
  const autoResponse = vi.fn()
  const ctx = {
    storage,
    getWebSockets: () => [...sockets, ...accepted],
    acceptWebSocket: (s: FakeSocket) => {
      accepted.push(s)
    },
    setWebSocketAutoResponse: autoResponse,
  }
  return { ctx, setAlarm, getAlarm, accepted, autoResponse, getAlarmValue: () => alarm, clearAlarm: () => (alarm = null) }
}

function makeHub(sockets: FakeSocket[] = []) {
  const c = makeCtx(sockets)
  const hub = new LiveHub(c.ctx as unknown as DurableObjectState, {} as Env)
  return { hub, ...c }
}

const NOW = Date.UTC(2026, 9, 5, 14, 7, 31, 250)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubGlobal('WebSocketRequestResponsePair', FakeAutoResponsePair)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('LiveHub.notify', () => {
  it('takes no arguments and ignores any it is given', async () => {
    const { hub, setAlarm } = makeHub([new FakeSocket()])
    expect(hub.notify.length).toBe(0)
    await (hub.notify as (...a: unknown[]) => Promise<void>)({ id: 7, path: '/secret', count: 3 }, 'x')
    expect(setAlarm).toHaveBeenCalledTimes(1)
    expect(setAlarm).toHaveBeenCalledWith(nextBoundary(NOW))
  })

  it('does nothing when no tab is connected: no alarm, no storage call', async () => {
    const { hub, setAlarm, getAlarm, getAlarmValue } = makeHub([])
    await hub.notify()
    expect(getAlarm).not.toHaveBeenCalled() // the socket check comes first: no storage read at all
    expect(setAlarm).not.toHaveBeenCalled()
    expect(getAlarmValue()).toBeNull()
  })

  it('collapses many notifies into ONE alarm, on a 15-minute boundary', async () => {
    const { hub, setAlarm, getAlarmValue } = makeHub([new FakeSocket()])
    for (let i = 0; i < 25; i++) await hub.notify()
    expect(setAlarm).toHaveBeenCalledTimes(1)
    const t = getAlarmValue()!
    expect(t % 900_000).toBe(0)
    expect(t).toBeGreaterThan(NOW)
    expect(t - NOW).toBeLessThanOrEqual(900_000)
  })

  it('stores nothing but the alarm (any other storage method throws and would fail the test)', async () => {
    const { hub, getAlarmValue } = makeHub([new FakeSocket()])
    await hub.notify()
    await hub.alarm()
    await hub.fetch(new Request('https://gss-live/ws')) // 426, still no storage use
    expect(getAlarmValue()).not.toBeNull()
  })

  it('sets a new alarm after the previous one has fired', async () => {
    const { hub, setAlarm, clearAlarm } = makeHub([new FakeSocket()])
    await hub.notify()
    clearAlarm() // the runtime clears the alarm when it fires
    vi.setSystemTime(NOW + BOUNDARY_MS)
    await hub.notify()
    expect(setAlarm).toHaveBeenCalledTimes(2)
  })
})

describe('LiveHub.alarm', () => {
  it('sends exactly {"t":"changed"} to every socket, and nothing else', async () => {
    const a = new FakeSocket()
    const b = new FakeSocket()
    const { hub } = makeHub([a, b])
    await hub.alarm()
    expect(PING).toBe('{"t":"changed"}')
    expect(a.sent).toEqual(['{"t":"changed"}'])
    expect(b.sent).toEqual(['{"t":"changed"}'])
  })

  it('a dead socket does not stop the others', async () => {
    const dead = new FakeSocket()
    dead.throwOnSend = true
    const live = new FakeSocket()
    const { hub } = makeHub([dead, live])
    await expect(hub.alarm()).resolves.toBeUndefined()
    expect(live.sent).toEqual([PING])
  })
})

describe('LiveHub.fetch', () => {
  it('registers the keepalive auto-response (ping to pong)', () => {
    const { autoResponse } = makeHub()
    const pair = autoResponse.mock.calls[0][0] as FakeAutoResponsePair
    expect([pair.request, pair.response]).toEqual(['ping', 'pong'])
  })

  it('answers a non-upgrade GET with 426 and a non-GET with 404', async () => {
    const { hub, accepted } = makeHub()
    const r1 = await hub.fetch(new Request('https://gss-live/ws'))
    expect(r1.status).toBe(426)
    const r2 = await hub.fetch(new Request('https://gss-live/ws', { method: 'POST', headers: { Upgrade: 'websocket' } }))
    expect(r2.status).toBe(404)
    expect(accepted).toHaveLength(0)
  })

  /** Stand-ins for WebSocketPair and Response (Node's Response rejects status 101). */
  function stubUpgrade() {
    const client = new FakeSocket()
    const server = new FakeSocket()
    class FakePair {
      0 = client
      1 = server
    }
    class FakeResponse {
      constructor(
        public body: unknown,
        public init: { status: number; webSocket?: unknown },
      ) {}
      get status() {
        return this.init.status
      }
      get webSocket() {
        return this.init.webSocket
      }
    }
    vi.stubGlobal('WebSocketPair', FakePair)
    vi.stubGlobal('Response', FakeResponse)
    return { client, server }
  }
  const upgradeReq = () => new Request('https://gss-live/ws', { headers: { Upgrade: 'websocket' } })

  it('at the 100-socket cap closes the OLDEST socket (1013) and accepts the new one with 101', async () => {
    const full = Array.from({ length: MAX_SOCKETS }, () => new FakeSocket())
    const { client, server } = stubUpgrade()
    const { hub, accepted } = makeHub(full)
    const res = (await hub.fetch(upgradeReq())) as unknown as { status: number; webSocket: unknown }
    expect(res.status).toBe(101)
    expect(res.webSocket).toBe(client)
    expect(accepted).toEqual([server])
    expect(full[0].closed).toEqual([1013, 'try again later'])
    for (const s of full.slice(1)) expect(s.closed).toBeNull()
  })

  it('below the cap closes nobody', async () => {
    const some = Array.from({ length: MAX_SOCKETS - 1 }, () => new FakeSocket())
    stubUpgrade()
    const { hub, accepted } = makeHub(some)
    expect(((await hub.fetch(upgradeReq())) as unknown as { status: number }).status).toBe(101)
    expect(accepted).toHaveLength(1)
    for (const s of some) expect(s.closed).toBeNull()
  })

  it('an oldest socket that throws on close still lets the new one in', async () => {
    const full = Array.from({ length: MAX_SOCKETS }, () => new FakeSocket())
    full[0].close = () => {
      throw new Error('already closed')
    }
    stubUpgrade()
    const { hub, accepted } = makeHub(full)
    expect(((await hub.fetch(upgradeReq())) as unknown as { status: number }).status).toBe(101)
    expect(accepted).toHaveLength(1)
  })

  it('accepts an upgrade through ctx.acceptWebSocket (hibernating, no tags) and returns 101', async () => {
    const { client, server } = stubUpgrade()
    const { hub, accepted, ctx } = makeHub()
    const accept = vi.spyOn(ctx, 'acceptWebSocket')
    const res = (await hub.fetch(new Request('https://gss-live/ws', { headers: { Upgrade: 'WebSocket' } }))) as unknown as {
      status: number
      webSocket: unknown
    }
    expect(res.status).toBe(101)
    expect(res.webSocket).toBe(client)
    expect(accepted).toEqual([server])
    expect(accept.mock.calls[0]).toEqual([server]) // no tags argument: nothing about the socket is stored
  })

  it('ignores incoming messages: never echoes, never closes', async () => {
    const { hub } = makeHub()
    const ws = new FakeSocket()
    await expect((hub.webSocketMessage as (...a: unknown[]) => Promise<void>)(ws, 'anything')).resolves.toBeUndefined()
    expect(ws.sent).toEqual([])
    expect(ws.closed).toBeNull()
  })

  it.each([
    [1000, 1000],
    [1001, 1001],
    [1013, 1013],
    [3000, 3000],
    [1005, 1000], // "no status received": reserved, must never be sent
    [1006, 1000], // "abnormal closure": reserved, must never be sent
  ])('webSocketClose with received code %i closes with %i', async (received, sent) => {
    const { hub } = makeHub()
    const ws = new FakeSocket()
    await hub.webSocketClose(ws as unknown as WebSocket, received)
    expect(ws.closed).toEqual([sent, 'closed'])
  })

  it('webSocketClose and webSocketError survive a socket that is already closed', async () => {
    const { hub } = makeHub()
    const ws = new FakeSocket()
    ws.close = () => {
      throw new Error('already closed')
    }
    await expect(hub.webSocketClose(ws as unknown as WebSocket, 1000)).resolves.toBeUndefined()
    await expect(hub.webSocketError(ws as unknown as WebSocket)).resolves.toBeUndefined()
  })

  it('webSocketError closes the socket with 1011', async () => {
    const { hub } = makeHub()
    const ws = new FakeSocket()
    await hub.webSocketError(ws as unknown as WebSocket)
    expect(ws.closed).toEqual([1011, 'error'])
  })
})

describe('module exports (workerd treats every named export of index.ts as an entrypoint)', () => {
  it('index.ts exports only LiveHub, Notify and the default handler', () => {
    expect(Object.keys(entry).sort()).toEqual(['LiveHub', 'Notify', 'default'])
  })
})

describe('Notify entrypoint and default fetch', () => {
  function makeEnv() {
    const hubNotify = vi.fn(async (...args: unknown[]) => void args)
    const hubFetch = vi.fn(async (_r: Request) => new Response('hub', { status: 200 }))
    const idFromName = vi.fn((_n: string) => 'hits-id')
    const get = vi.fn((_id: unknown) => ({ notify: hubNotify, fetch: hubFetch }))
    const env = { HUB: { idFromName, get } } as unknown as Env
    return { env, hubNotify, hubFetch, idFromName, get }
  }

  it('Notify.notify calls the single "hits" hub with no arguments, whatever it was given', async () => {
    const { env, hubNotify, idFromName, get } = makeEnv()
    const n = new Notify({} as unknown as ExecutionContext, env)
    expect(n.notify.length).toBe(0)
    await (n.notify as (...a: unknown[]) => Promise<void>)({ path: '/x', id: 1 }, 42)
    expect(idFromName).toHaveBeenCalledWith('hits')
    expect(get).toHaveBeenCalledWith('hits-id')
    expect(hubNotify).toHaveBeenCalledTimes(1)
    expect(hubNotify.mock.calls[0]).toEqual([])
  })

  it('default fetch forwards a WebSocket upgrade to the hub', async () => {
    const { env, hubFetch } = makeEnv()
    const req = new Request('https://gss-live/ws', { headers: { Upgrade: 'websocket' } })
    const res = await worker.fetch(req, env)
    expect(res.status).toBe(200)
    expect(hubFetch).toHaveBeenCalledWith(req)
  })

  it('default fetch rejects everything else without touching the hub', async () => {
    const { env, get } = makeEnv()
    expect((await worker.fetch(new Request('https://gss-live/'), env)).status).toBe(426)
    expect((await worker.fetch(new Request('https://gss-live/', { method: 'POST', headers: { Upgrade: 'websocket' } }), env)).status).toBe(404)
    expect(get).not.toHaveBeenCalled()
  })
})

describe('15-minute boundary = ET wall-clock :00/:15/:30/:45', () => {
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const etHms = (ms: number) => {
    const p = Object.fromEntries(etParts.formatToParts(ms).map((x) => [x.type, x.value]))
    return { hh: p.hour, mm: Number(p.minute), ss: Number(p.second) }
  }

  it('is strictly after now and at most 15 minutes ahead', () => {
    expect(nextBoundary(NOW)).toBeGreaterThan(NOW)
    expect(nextBoundary(0)).toBe(900_000)
    expect(nextBoundary(899_999)).toBe(900_000)
    expect(nextBoundary(900_000)).toBe(1_800_000) // exactly on a boundary: the NEXT one
  })

  // 2026 DST: spring forward Sun Mar 8 (02:00 EST -> 03:00 EDT), fall back Sun Nov 1 (02:00 EDT -> 01:00 EST).
  for (const [label, startDate] of [
    ['spring forward (Mar 8 2026)', '2026-03-07'],
    ['fall back (Nov 1 2026)', '2026-10-31'],
  ] as const) {
    it(`lands on ET :00/:15/:30/:45 every time across ${label}`, () => {
      const start = etWallTimeMs(startDate, '00:00')
      const end = start + 4 * 86_400_000
      for (let now = start; now < end; now += 7 * 60_000 + 13_000) {
        const b = nextBoundary(now)
        expect(b % 900_000).toBe(0)
        expect(b).toBeGreaterThan(now)
        expect(b - now).toBeLessThanOrEqual(900_000)
        const { hh, mm, ss } = etHms(b)
        expect([0, 15, 30, 45]).toContain(mm)
        expect(ss).toBe(0)
        // The repo's ET helper agrees about which instant that wall-clock time is (the repeated
        // fall-back hour, 01:xx, is ambiguous by wall time alone, so it is skipped here).
        const wall = `${hh}:${String(mm).padStart(2, '0')}`
        const date = etDateFast(b)
        if (!(startDate === '2026-10-31' && date === '2026-11-01' && hh === '01')) {
          expect(etWallTimeMs(date, wall)).toBe(b)
        }
      }
    })
  }

  it('hops the missing spring-forward hour: 01:50 EST goes straight to 03:00 EDT', () => {
    expect(nextBoundary(etWallTimeMs('2026-03-08', '01:50'))).toBe(etWallTimeMs('2026-03-08', '03:00'))
    expect(nextBoundary(etWallTimeMs('2026-03-08', '03:01'))).toBe(etWallTimeMs('2026-03-08', '03:15'))
  })

  it('keeps 15-minute spacing through the repeated fall-back hour', () => {
    const base = Date.UTC(2026, 10, 1, 4, 50) // 00:50 EDT
    let t = nextBoundary(base)
    const seen: string[] = []
    for (let i = 0; i < 12; i++) {
      const { hh, mm } = etHms(t)
      seen.push(`${hh}:${String(mm).padStart(2, '0')}`)
      const n = nextBoundary(t)
      expect(n - t).toBe(900_000)
      t = n
    }
    // 01:00 EDT ... 01:45 EDT, 01:00 EST ... 01:45 EST, then 02:00 EST
    expect(seen.slice(0, 8)).toEqual(['01:00', '01:15', '01:30', '01:45', '01:00', '01:15', '01:30', '01:45'])
    expect(seen[8]).toBe('02:00')
  })
})
