// gss-live — live-push Worker for the gss-stats dashboard.
//
// One Durable Object (LiveHub, single instance idFromName('hits')) keeps the open dashboard tabs'
// WebSockets (hibernating: no billed duration while idle) and, when told a new beacon row was
// written, sends every socket the EMPTY ping {"t":"changed"} — at most once per fixed 15-minute
// boundary. Two ways in, both Service Bindings only (no public URL):
//  - the default export's fetch: a WebSocket upgrade, bound by gss-stats Pages (functions/api/live.ts);
//  - the Notify entrypoint: RPC from gss-beacon after a non-refused row was written.
//
// Counts-only: the DO stores NO row data, only its alarm; notify() takes no arguments; the only thing
// ever sent is the literal ping. Refused rows never reach this Worker (the beacon filters them).

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'

export interface Env {
  HUB: DurableObjectNamespace<LiveHub>
}

/** The only message the hub ever sends. Carries no row id, count, time or place. */
export const PING = '{"t":"changed"}'
/** Pings are batched to fixed 15-minute boundaries. ET offsets are whole hours, so these are also the ET :00/:15/:30/:45. */
export const BOUNDARY_MS = 900_000
/** Open dashboard tabs allowed at once (gss-stats is a handful of people). */
export const MAX_SOCKETS = 100

/** The next 15-minute boundary, strictly after `now`. */
export function nextBoundary(now: number): number {
  return Math.floor(now / BOUNDARY_MS) * BOUNDARY_MS + BOUNDARY_MS
}

function isUpgrade(request: Request): boolean {
  return request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
}

/** 404 for a non-GET, 426 for a GET that is not a WebSocket upgrade. */
function notUpgradeResponse(request: Request): Response {
  if (request.method !== 'GET') return new Response('Not found', { status: 404 })
  return new Response('Expected a WebSocket upgrade', { status: 426, headers: { Upgrade: 'websocket' } })
}

export class LiveHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Answered by the runtime without waking the object: keeps connections warm for free.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  /**
   * A new non-refused beacon row was written. Takes NO arguments by design (nothing about the row may
   * reach this object). No open tab: nothing to do. Otherwise make sure one alarm is set for the next
   * 15-minute boundary; many notifies inside a boundary collapse into that one alarm.
   */
  async notify(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return
    if ((await this.ctx.storage.getAlarm()) !== null) return
    await this.ctx.storage.setAlarm(nextBoundary(Date.now()))
  }

  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(PING)
      } catch {
        // A dead socket must not stop the others.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (!isUpgrade(request)) return notUpgradeResponse(request)
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response('Too many connections', { status: 503 })
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  // Tabs never send anything meaningful (the keepalive 'ping' is answered by the auto-response).
  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close(1000, 'closed')
    } catch {
      // Already closed.
    }
  }
}

/** RPC entrypoint for gss-beacon (`entrypoint = "Notify"`). Any arguments are ignored. */
export class Notify extends WorkerEntrypoint<Env> {
  async notify(): Promise<void> {
    await this.env.HUB.get(this.env.HUB.idFromName('hits')).notify()
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isUpgrade(request)) return notUpgradeResponse(request)
    return env.HUB.get(env.HUB.idFromName('hits')).fetch(request)
  },
}
