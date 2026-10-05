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
// ever sent is the literal ping. Each socket carries only its accept time (a bare number, used to
// evict the oldest at the cap). Refused rows never reach this Worker (the beacon filters them).

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { MAX_SOCKETS, nextBoundary, PING } from './hub'

export interface Env {
  HUB: DurableObjectNamespace<LiveHub>
}

function isUpgrade(request: Request): boolean {
  return request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
}

/** 404 for a non-GET, 426 for a GET that is not a WebSocket upgrade. */
function notUpgradeResponse(request: Request): Response {
  if (request.method !== 'GET') return new Response('Not found', { status: 404 })
  return new Response('Expected a WebSocket upgrade', { status: 426, headers: { Upgrade: 'websocket' } })
}

/** WebSocket.readyState of an open socket (the constant is not on the Workers runtime's WebSocket). */
const WS_OPEN = 1

/** A socket's accept time (its attachment). Missing or not a finite number counts as the oldest. */
function acceptedAt(ws: WebSocket): number {
  try {
    const at: unknown = ws.deserializeAttachment()
    return typeof at === 'number' && Number.isFinite(at) ? at : -Infinity
  } catch {
    return -Infinity
  }
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
    // At the cap, close the OLDEST open socket to make room, so one leaky tab or script evicts itself
    // instead of locking everyone else out. The evicted client reconnects with backoff. Age comes
    // from each socket's attachment (its accept time, see below), never from the order of
    // getWebSockets(): in workerd that list is newest-first, and its order is not documented anyway.
    // A socket that is already closing still shows up in the list but frees no room, so only OPEN
    // sockets count toward the cap.
    const open = this.ctx.getWebSockets().filter((ws) => ws.readyState === WS_OPEN)
    if (open.length >= MAX_SOCKETS) {
      let oldest = open[0]
      let oldestAt = acceptedAt(oldest)
      for (const ws of open) {
        const at = acceptedAt(ws)
        if (at < oldestAt) {
          oldest = ws
          oldestAt = at
        }
      }
      try {
        oldest.close(1013, 'try again later')
      } catch {
        // Already closing.
      }
    }
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    // The attachment is the socket's accept time (a bare number, no row data and no count). It
    // survives hibernation and is only ever used to pick the oldest socket at the cap.
    server.serializeAttachment(Date.now())
    return new Response(null, { status: 101, webSocket: client })
  }

  // Tabs never send anything meaningful (the keepalive 'ping' is answered by the auto-response).
  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // Close with the received code when it is one that may be sent (1005 and 1006 are reserved for
    // "no status" and "abnormal" and must never go on the wire), else a normal 1000. Other reserved
    // codes (1004, 1015, 5000 ...) make close() throw; retry with a plain 1000 so the server side
    // still closes instead of leaving the peer's socket open.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed')
    } catch {
      try {
        ws.close(1000, 'closed')
      } catch {
        // Already closed (the runtime auto-replies to close on current compatibility dates).
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error')
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
