// gss-budget-banks: the cron and the Service Binding entry (no public URL, no route). Every request is treated as
// untrusted anyway: a fixed route table, fixed-code answers, no echo of input, no stack or message text in a response.
// Plan: bank links sections 1, 3.3 and 5; ADR 0009. Legs 3 to 7 replace the 501 handlers.
import { allowedEmails, type Env } from './env'
import { log } from './log'
import { handleLinkToken } from './linkToken'
import { handleExchange } from './exchange'

export type { Env } from './env'

const MAX_BODY_BYTES = 16 * 1024
const EMAIL_MAX = 254

export function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
const fail = (status: number, code: string): Response => jsonResponse(status, { ok: false, code })

/** What a handler gets: the raw body text and, for an owner route, the parsed body and the allowlisted owner. */
export interface RouteInput {
  request: Request
  env: Env
  ctx: ExecutionContext
  raw: string
  body: Record<string, unknown>
  ownerEmail: string
}
type Handler = (input: RouteInput) => Promise<Response>
interface Route {
  /** 'owner': JSON body with an allowlisted ownerEmail. 'raw': the body is taken as is (the webhook verifies a JWT). */
  auth: 'owner' | 'raw'
  handler: Handler
}

const notBuilt: Handler = async () => fail(501, 'not_built')

// ---- ROUTE TABLE: one line per route, exact path match, POST only. Add a route here and nowhere else. ----
export const ROUTES: Readonly<Record<string, Route>> = {
  '/link-token': { auth: 'owner', handler: (i) => handleLinkToken(i) },
  '/exchange': { auth: 'owner', handler: (i) => handleExchange(i) },
  '/unlink': { auth: 'owner', handler: notBuilt },
  '/accounts-refresh': { auth: 'owner', handler: notBuilt },
  '/webhook': { auth: 'raw', handler: notBuilt },
}
// ---- END ROUTE TABLE ----

/** Read the body up to the cap; null when it is larger. */
async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) return null
  return new TextDecoder().decode(bytes)
}

export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let path: string
  try {
    path = new URL(request.url).pathname
  } catch {
    return fail(404, 'not_found')
  }
  if (!Object.prototype.hasOwnProperty.call(ROUTES, path) || request.method !== 'POST') return fail(404, 'not_found')
  const route = ROUTES[path]
  try {
    const raw = await readCapped(request)
    if (raw === null) return fail(413, 'too_large')
    let body: Record<string, unknown> = {}
    let ownerEmail = ''
    if (route.auth === 'owner') {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(400, 'bad_request')
        body = parsed as Record<string, unknown>
      } catch {
        return fail(400, 'bad_request')
      }
      const email = body.ownerEmail
      if (typeof email !== 'string' || email.length < 3 || email.length > EMAIL_MAX) return fail(400, 'bad_request')
      const allowed = await allowedEmails(env)
      if (allowed === null) return fail(503, 'secrets_missing')
      ownerEmail = email.trim().toLowerCase()
      if (!allowed.has(ownerEmail)) return fail(403, 'not_allowed')
    }
    return await route.handler({ request, env, ctx, raw, body, ownerEmail })
  } catch {
    log('route_failed')
    return fail(500, 'server_error')
  }
}

/** The cron (every ten minutes). Leg 5 onward: sync, the daily reconnect check, liabilities. */
export async function handleScheduled(_env: Env): Promise<void> {
  log('scheduled_start')
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => handleFetch(request, env, ctx),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext): void => {
    ctx.waitUntil(handleScheduled(env))
  },
}
