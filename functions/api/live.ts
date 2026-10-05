/// <reference types="@cloudflare/workers-types" />
//
// GET /api/live   (WebSocket upgrade)
//
// The dashboard's live-push socket. Behind the same host guard and Google sign-in gate as every
// /api route (functions/_middleware.ts): no session gets the gate's 401 JSON before this runs.
// Here it is only checked that the request really is a same-origin WebSocket upgrade, then the
// upgrade is handed to the gss-live Worker through the Service Binding LIVE (the Worker has no
// public URL). gss-live answers 101 and, at most once per 15-minute boundary, sends the empty
// ping `{"t":"changed"}`; nothing about any beacon row ever travels on this socket.
//
// Nothing from the incoming request is forwarded: a fresh Request carrying only
// `Upgrade: websocket`, so no cookie, auth header, client header, query or IP reaches gss-live.
//
// Never cached: it does not use functions/_lib/edgeCache.ts, a 101 has no body to store, and the
// gate stamps `Cache-Control: private, no-store` on every response that passes it.

interface Env {
  /** Service Binding to the gss-live Worker's default fetch (root wrangler.toml [[services]]). */
  LIVE?: Fetcher
}

/** The only request ever sent to gss-live. */
export const LIVE_UPSTREAM_URL = 'https://gss-live/ws'

const json = (status: number, error: string, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  })

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx
  if ((request.headers.get('Upgrade') ?? '').trim().toLowerCase() !== 'websocket') {
    return json(426, 'websocket upgrade required', { Upgrade: 'websocket' })
  }
  // Cross-site WebSocket hijacking guard: browsers send Origin on every WebSocket handshake and
  // SameSite=Lax does not keep the session cookie off it, so only our own origin may connect.
  // A missing Origin (not a browser) is refused too.
  if (request.headers.get('Origin') !== new URL(request.url).origin) {
    return json(403, 'cross-origin websocket refused')
  }
  if (!env.LIVE) return json(503, 'live updates unavailable')
  try {
    const res = await env.LIVE.fetch(new Request(LIVE_UPSTREAM_URL, { headers: { Upgrade: 'websocket' } }))
    // Only a real upgrade is handed back. Any other gss-live answer (its own refusals, an error
    // page) becomes a bare 503 so no upstream status, header or body detail reaches the client.
    if (res.status === 101 && res.webSocket) return res
    try {
      await res.body?.cancel() // release the unused upstream body
    } catch {
      // Nothing to release.
    }
    return json(503, 'live updates unavailable')
  } catch {
    // e.g. local `wrangler pages dev` with gss-live not running: the dashboard just stays on
    // its other refresh paths.
    return json(503, 'live updates unavailable')
  }
}
