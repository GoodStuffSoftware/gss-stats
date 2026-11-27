// gss-budget-banks: the cron and the Service Binding entry (no public URL, no route). Every request is treated as
// untrusted anyway: a fixed route table, fixed-code answers, no echo of input, no stack or message text in a response.
// Plan: bank links sections 1, 3.3 and 5; ADR 0009. Every route is built.
import { allowedEmails, type Env } from './env'
import { log } from './log'
import { handleLinkToken } from './linkToken'
import { handleExchange } from './exchange'
import { handleWebhook } from './webhook'
import { syncTick } from './apply'
import { reconnectCheck } from './reconnectCheck'
import { handleUnlink } from './unlink'
import { handleAccountsRefresh } from './accounts'
import { liabilitiesTick } from './liabilities'
import { createPlaidClient } from './plaid'
import { planDeps, type BankDeps } from './exchange'
import { readKeys } from './store'

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
  /** The body exactly as received (the webhook hashes these bytes; no decode and re-encode). */
  bytes?: Uint8Array<ArrayBuffer>
  body: Record<string, unknown>
  ownerEmail: string
}
type Handler = (input: RouteInput) => Promise<Response>
interface Route {
  /** 'owner': JSON body with an allowlisted ownerEmail. 'raw': the body is taken as is (the webhook verifies a JWT). */
  auth: 'owner' | 'raw'
  handler: Handler
}

/**
 * Keep a run going if the caller goes away: a cancelled caller must not cut the exchange between Plaid making the Item and the
 * encrypted token being stored (the token would be lost and the Item could never be removed). The same hold covers unlink and
 * accounts-refresh, so a Pages timeout cannot leave a half-done change: each is safe to run again (unlink on a removed Item
 * answers ok; accounts-refresh adds only accounts it does not have). waitUntil gives the run up to 30 s after the caller
 * disconnects (Cloudflare Context docs). The caller still gets the answer when it stays.
 */
function untilDone(ctx: ExecutionContext, run: Promise<Response>): Promise<Response> {
  ctx.waitUntil?.(run.then(() => undefined, () => undefined))
  return run
}

// ---- ROUTE TABLE: one line per route, exact path match, POST only. Add a route here and nowhere else. ----
export const ROUTES: Readonly<Record<string, Route>> = {
  '/link-token': { auth: 'owner', handler: (i) => handleLinkToken(i) },
  '/exchange': { auth: 'owner', handler: (i) => untilDone(i.ctx, handleExchange(i)) },
  '/unlink': { auth: 'owner', handler: (i) => untilDone(i.ctx, handleUnlink(i)) },
  '/accounts-refresh': { auth: 'owner', handler: (i) => untilDone(i.ctx, handleAccountsRefresh(i)) },
  '/webhook': { auth: 'raw', handler: (i) => handleWebhook(i) },
}
// ---- END ROUTE TABLE ----

/** Read the body up to the cap; null when it is larger. */
async function readCapped(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) return null
  return bytes
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
    const bytes = await readCapped(request)
    if (bytes === null) return fail(413, 'too_large')
    const raw = new TextDecoder().decode(bytes)
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
    return await route.handler({ request, env, ctx, raw, bytes, body, ownerEmail })
  } catch {
    log('route_failed')
    return fail(500, 'server_error')
  }
}

/** The cron (every ten minutes): sync the due Items, then the daily reconnect check, then liabilities and balances (plan 4.5). Plaid is reached only through `deps.fetch`. */
export async function handleScheduled(env: Env, deps: Partial<BankDeps> = {}): Promise<void> {
  const d = planDeps(deps)
  log('scheduled_start')
  const keys = await readKeys(env)
  if (!keys) {
    log('scheduled_skip', {}, 'keys_missing')
    return
  }
  try {
    await syncTick(env, d.fetch, keys, d.now)
  } catch {
    log('scheduled_failed', {}, 'sync_tick')
  }
  try {
    await reconnectCheck(env.BUDGET_DB, env, createPlaidClient({ env, fetch: d.fetch, now: d.now }), keys, d.now())
  } catch {
    log('scheduled_failed', {}, 'reconnect_check')
  }
  try {
    await liabilitiesTick(env.BUDGET_DB, env, createPlaidClient({ env, fetch: d.fetch, now: d.now }), keys, d.now())
  } catch {
    log('scheduled_failed', {}, 'liabilities')
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => handleFetch(request, env, ctx),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext): void => {
    ctx.waitUntil(handleScheduled(env))
  },
}
