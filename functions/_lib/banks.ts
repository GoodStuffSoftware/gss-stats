/// <reference types="@cloudflare/workers-types" />
//
// Shared helpers for the bank-link routes under functions/api/budget/banks/ (plan section 3.1, ADR 0009).
// Pages holds no Plaid secret: every Plaid call goes through the BANKS Service Binding (the gss-budget-banks Worker)
// with a hard time limit. A Worker failure reaches the browser as its fixed code only; nothing here logs more than a
// route name and a code.

import { BudgetHttpError, type Ctx } from './budgetDb'
import { BANKS_TIMEOUT_MS } from './banksBinding'
import { bindingFetch } from './gmailConnect'

export { BANKS_TIMEOUT_MS }

const BANKS_ORIGIN = 'https://banks.internal'
/** A bank_items.id: 'i' plus 16 hex. */
const ITEM_ID_RE = /^i[0-9a-f]{16}$/
/** A bank_accounts.id: 'b' plus 16 hex. */
export const BANK_ACCOUNT_ID_RE = /^b[0-9a-f]{16}$/
/** Statuses where the Item still holds a token, so a sync or a reconnect can act on it. */
export const LIVE_ITEM_STATUSES = ['active', 'needs_reconnect', 'pending_disconnect'] as const
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/

export const isItemId = (v: unknown): v is string => typeof v === 'string' && ITEM_ID_RE.test(v)

/** The BANKS binding, or 503 `banks_not_configured` (dev preview, and local without the Worker). */
export function requireBanks(env: Ctx['env']): Fetcher {
  const b = env.BANKS
  if (typeof b?.fetch !== 'function') throw new BudgetHttpError(503, 'banks_not_configured', 'Bank links are not set up on this site.')
  return b
}

/**
 * POST a JSON body to a Worker path and return its parsed 2xx answer. A Worker error becomes a BudgetHttpError with
 * the Worker's status and its fixed code (a 4xx or 5xx only; anything else is 502). A timeout is 504 `binding_timeout`,
 * a throw is 502 `banks_failed`.
 */
export async function callBanks(env: Ctx['env'], path: string, body: Record<string, unknown>, ms: number): Promise<Record<string, unknown>> {
  const binding = requireBanks(env)
  let res: Response
  try {
    res = await bindingFetch(binding, `${BANKS_ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, ms)
  } catch (err) {
    const timedOut = (err as Error)?.message === 'binding_timeout'
    console.error(`banks: ${path} ${timedOut ? 'timed out' : 'failed'}`)
    throw new BudgetHttpError(timedOut ? 504 : 502, timedOut ? 'binding_timeout' : 'banks_failed')
  }
  let parsed: Record<string, unknown> = {}
  try {
    const v: unknown = await res.json()
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) parsed = v as Record<string, unknown>
  } catch {
    parsed = {}
  }
  if (res.status >= 200 && res.status < 300) return parsed
  const raw = parsed.code ?? parsed.error
  const code = typeof raw === 'string' && CODE_RE.test(raw) ? raw : 'banks_failed'
  const status = res.status >= 400 && res.status <= 599 ? res.status : 502
  console.error(`banks: ${path} answered ${status} ${code}`)
  throw new BudgetHttpError(status, code)
}

export interface ItemOwner {
  ownerEmail: string
  status: string
}

export const ITEM_OWNER_SQL = 'SELECT owner_email, status FROM bank_items WHERE id = ?'

/** One primary-key lookup: who owns the Item and its status, or null when there is no such Item (or the id is malformed). */
export async function itemOwner(db: D1Database, id: string): Promise<ItemOwner | null> {
  if (!isItemId(id)) return null
  const row = await db.prepare(ITEM_OWNER_SQL).bind(id).first<{ owner_email: string; status: string }>()
  return row ? { ownerEmail: row.owner_email, status: row.status } : null
}

/** The Item for an owner-only action: 404 `item_not_found` when missing, 403 `not_owner` for the other person. */
export async function requireOwnItem(db: D1Database, id: string, email: string): Promise<ItemOwner> {
  const item = await itemOwner(db, id)
  if (!item) throw new BudgetHttpError(404, 'item_not_found')
  if (item.ownerEmail !== email.trim().toLowerCase()) throw new BudgetHttpError(403, 'not_owner', 'Only the person who linked this bank can do that.')
  return item
}

export const itemNotActive = (): BudgetHttpError => new BudgetHttpError(409, 'item_not_active', 'This bank link is not active.')
