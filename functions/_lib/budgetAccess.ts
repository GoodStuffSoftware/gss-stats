/// <reference types="@cloudflare/workers-types" />
//
// The Budget section's second auth layer (docs/adr/0007-budget-section.md). The root gate
// (functions/_lib/auth.ts) already refuses an account that is not on BUDGET_ALLOWED_EMAILS; this
// module re-checks it from the request itself, for functions/api/budget/_middleware.ts, so a mistake
// in either layer (a path spelling the gate misses, a Pages routing change, a gate refactor) does not
// open the data. Both layers deny by default: an empty or missing list admits nobody, every method
// (GET, HEAD and OPTIONS included) needs the list, and there is no budget route that skips it.
//
// Budget code never goes through the shared edge cache: every response here is `private, no-store`
// and `Vary: Cookie` (functions/api/budget/noEdgeCache.test.ts fails the build if a budget file
// imports the cache).

import {
  BUDGET_DENIED,
  budgetAllowed,
  devBypassEmail,
  parseAllowedEmails,
  readAuthConfig,
  readSession,
  type AuthEnv,
} from './auth'

/** The bindings the budget Functions read: the auth settings plus the budget database. */
export interface BudgetEnv extends AuthEnv {
  BUDGET_DB?: D1Database
  /** The gss-budget-banks Worker (bank links). Absent in the dev preview, and locally without the Worker. */
  BANKS?: Fetcher
}

/** What the scoped middleware leaves in `context.data` for every budget route. */
export interface BudgetData extends Record<string, unknown> {
  budgetEmail?: string
}

export type BudgetAccessResult = { ok: true; email: string } | { ok: false; response: Response }

/** A JSON response that is never stored or shared (see header). */
export function budgetJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return noStore(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }))
}

/** Copy of `res` with `Cache-Control: private, no-store` and `Vary: Cookie` (merged into any Vary). */
export function noStore(res: Response): Response {
  const out = new Response(res.body, res)
  out.headers.set('Cache-Control', 'private, no-store')
  const vary = (out.headers.get('Vary') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!vary.some((v) => v === '*' || v.toLowerCase() === 'cookie')) vary.push('Cookie')
  out.headers.set('Vary', vary.join(', '))
  return out
}

let warnedEmptyList = false

/** Who is asking, and are they on the budget list? Order: empty list (403), dev bypass (loopback and
 *  the flag only; must be listed), sign-in configuration (503), session (401), list (403), database
 *  binding (503). The database check comes last so an unlisted caller learns nothing about setup. */
export async function authorizeBudget(request: Request, env: BudgetEnv, nowMs: number = Date.now()): Promise<BudgetAccessResult> {
  const denied = (): BudgetAccessResult => ({ ok: false, response: budgetJson(403, BUDGET_DENIED) })

  if (parseAllowedEmails(env.BUDGET_ALLOWED_EMAILS).length === 0) {
    if (!warnedEmptyList) {
      warnedEmptyList = true
      console.error('budget: BUDGET_ALLOWED_EMAILS is empty or not set; refusing every budget request')
    }
    return denied()
  }

  const url = new URL(request.url)
  let email: string
  const dev = devBypassEmail(env, url)
  if (dev) {
    if (!budgetAllowed(dev, env)) return denied()
    email = dev
  } else {
    const resolved = readAuthConfig(env)
    if (!resolved.ok) {
      return { ok: false, response: budgetJson(503, { error: 'auth_not_configured', problems: resolved.problems }) }
    }
    const session = await readSession(request, resolved.config, nowMs, env.STATS_CONFIG)
    if (!session) return { ok: false, response: budgetJson(401, { error: 'unauthenticated' }) }
    if (!budgetAllowed(session.email, env)) return denied()
    email = session.email.toLowerCase()
  }

  if (!env.BUDGET_DB) {
    console.error('budget: the BUDGET_DB binding is missing')
    return { ok: false, response: budgetJson(503, { error: 'budget_db_missing', message: 'The Budget database is not connected.' }) }
  }
  return { ok: true, email }
}
