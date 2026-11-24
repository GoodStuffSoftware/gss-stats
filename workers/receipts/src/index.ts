// gss-budget-receipts: the cron (hourly) and the Service Binding entry (no public URL, no route). Every request is treated as
// untrusted anyway: a fixed route table, fixed-code answers, no echo of input, no stack or message text in a response.
// Plan: email receipts sections 1, 5 and 9; ADR 0008.
import { loadActiveConnectionIds, loadConnection } from './store'
import { MANUAL_BUDGET_MS, allowedEmails, jsonResponse, runConnection, runIsOpen, type Env } from './run'
import { log } from './log'

export type { Env } from './run'
type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>

const fail = (status: number, code: string): Response => jsonResponse(status, { ok: false, code })
const MAX_BODY_CHARS = 2048
const CONNECTION_ID = /^c[0-9a-f]{16}$/

/** POST /sync {connectionId, runId, email}: check, answer 202 at once, then fill run row `runId` in waitUntil. */
export const handleSync: Handler = async (request, env, ctx) => {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed')
  let body: { connectionId?: unknown; runId?: unknown; email?: unknown }
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_CHARS) return fail(413, 'too_large')
    body = JSON.parse(text)
  } catch {
    return fail(400, 'bad_request')
  }
  const { connectionId, runId, email } = body ?? {}
  if (typeof connectionId !== 'string' || !CONNECTION_ID.test(connectionId) || typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId < 1
    || typeof email !== 'string' || email.length < 3 || email.length > 254) return fail(400, 'bad_request')
  try {
    const allowed = await allowedEmails(env)
    if (allowed === null) return fail(503, 'secrets_missing')
    const owner = email.trim().toLowerCase()
    const conn = await loadConnection(env.BUDGET_DB, connectionId)
    // One answer for an unknown connection, another person's connection and an address off the list.
    if (!conn || conn.ownerEmail !== owner || !allowed.has(owner)) return fail(403, 'forbidden')
    if (conn.status !== 'active') return fail(409, 'not_active')
    if (!(await runIsOpen(env.BUDGET_DB, runId, connectionId))) return fail(409, 'run_invalid')
  } catch {
    return fail(500, 'server_error')
  }
  ctx.waitUntil(runConnection(env, connectionId, runId, 'manual', { budgetMs: MANUAL_BUDGET_MS }))
  return jsonResponse(202, { ok: true })
}

// ---- ROUTE TABLE: one line per route, exact path match. Add a route here and nowhere else. ----
export const ROUTES: Readonly<Record<string, Handler>> = {
  '/sync': handleSync,
}
// ---- END ROUTE TABLE ----

export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let path: string
  try {
    path = new URL(request.url).pathname
  } catch {
    return fail(404, 'not_found')
  }
  if (!Object.prototype.hasOwnProperty.call(ROUTES, path)) return fail(404, 'not_found')
  try {
    return await ROUTES[path](request, env, ctx)
  } catch {
    log('route_failed')
    return fail(500, 'server_error')
  }
}

/** The hourly cron: one run per active connection, one after another; one failure never blocks the other. */
export async function handleScheduled(env: Env): Promise<void> {
  const ids = await loadActiveConnectionIds(env.BUDGET_DB)
  log('scheduled_start', { connections: ids.length })
  for (const id of ids) {
    try {
      await runConnection(env, id, null, 'cron')
    } catch {
      log('connection_failed')
    }
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => handleFetch(request, env, ctx),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext): void => {
    ctx.waitUntil(handleScheduled(env))
  },
}
