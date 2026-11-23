/// <reference types="@cloudflare/workers-types" />
//
// GET and PUT /api/budget/prefs: the signed-in login's Transactions-toolbar choices (search, filters, sort), one small JSON
// blob per login so they follow the person across devices (docs/adr/0007-budget-section.md). The scoped middleware has
// already refused anyone off the budget list (403) and anyone signed out (401).
//
//   - Stored in the STATS_CONFIG KV under `budget:prefs:<sha-256 hex of the lower-cased login>`. The address is never in
//     the key and nothing the client sends picks the key. The dashboard layout key is never read or written.
//   - PUT validates strictly (known fields only, `parseTxnViewPrefs(raw, true)`) and caps the body at 4 KB: 400 on anything
//     else, 413 on an oversize body. GET answers `{ txnView }` or `{}` when nothing is saved.
//   - No database access: the budget database is not touched.

import { parseTxnViewPrefs } from '../../../src/lib/budget/txnView'
import { BUDGET_DENIED } from '../../_lib/auth'
import { budgetJson, type BudgetData, type BudgetEnv } from '../../_lib/budgetAccess'

export const PREFS_KEY_PREFIX = 'budget:prefs:'
export const PREFS_MAX_BYTES = 4096

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The KV key for one login. */
export async function prefsKey(email: string): Promise<string> {
  return PREFS_KEY_PREFIX + (await sha256Hex(email.trim().toLowerCase()))
}

export const onRequest: PagesFunction<BudgetEnv, any, BudgetData> = async (ctx) => {
  const email = ctx.data.budgetEmail
  if (!email) return budgetJson(403, BUDGET_DENIED)
  const method = ctx.request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'PUT') {
    return budgetJson(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD, PUT' })
  }
  const kv = ctx.env.STATS_CONFIG as KVNamespace | undefined
  if (!kv || typeof (kv as { put?: unknown }).put !== 'function') return budgetJson(503, { error: 'prefs_store_missing' })
  const key = await prefsKey(email)

  if (method === 'PUT') {
    const declared = Number(ctx.request.headers.get('Content-Length') ?? 0)
    if (declared > PREFS_MAX_BYTES) return budgetJson(413, { error: 'too_large' })
    const text = await ctx.request.text()
    if (new TextEncoder().encode(text).length > PREFS_MAX_BYTES) return budgetJson(413, { error: 'too_large' })
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return budgetJson(400, { error: 'bad_request' })
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => k !== 'txnView')) {
      return budgetJson(400, { error: 'bad_request' })
    }
    const txnView = parseTxnViewPrefs((raw as { txnView?: unknown }).txnView, true)
    if (!txnView) return budgetJson(400, { error: 'bad_request' })
    await kv.put(key, JSON.stringify({ txnView }))
    return budgetJson(200, { ok: true })
  }

  const saved = await kv.get(key)
  if (!saved) return budgetJson(200, {})
  try {
    const txnView = parseTxnViewPrefs((JSON.parse(saved) as { txnView?: unknown })?.txnView)
    return budgetJson(200, txnView ? { txnView } : {})
  } catch {
    return budgetJson(200, {})
  }
}
