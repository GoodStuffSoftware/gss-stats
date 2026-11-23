/// <reference types="@cloudflare/workers-types" />
//
// GET and PUT /api/budget/prefs: the signed-in login's Budget choices, small JSON blocks per login so they follow the person
// across devices (docs/adr/0007-budget-section.md). The scoped middleware has already refused anyone off the budget list
// (403) and anyone signed out (401).
//
//   - `txnView`: the Transactions toolbar (search, filters, sort), stored in the STATS_CONFIG KV under
//     `budget:prefs:<sha-256 hex of the lower-cased login>`.
//   - `view`: where the person left the section (the tab: Spending, Debts or Both, drill path, range, person, page; lib/budget/savedView.ts),
//     under `budget:prefs-view:<same hash>`. A key of its own, so the two blocks are written independently (no read-modify-write
//     race when both save as the page closes) and neither can squeeze the other under the cap.
//     The address is never in a key and nothing the client sends picks the key. The dashboard layout key is never read or written.
//   - PUT carries `txnView`, `view` or both, validates strictly (known fields only, `parseTxnViewPrefs(raw, true)`,
//     `parseSavedView(raw, true)`) and caps the body at 4 KB (combined; the client sends one block per PUT, so each block
//     has the whole cap): 400 on anything else, 413 on an oversize body. Both blocks are validated before either is written;
//     a KV error between the two writes can leave the first written (a PUT with both blocks is not atomic).
//     GET answers `{ txnView?, view?, viewLegacy? }` (`{}` when nothing is saved; `viewLegacy` only for an old 0.82.0 block).
//   - No database access: the budget database is not touched.

import { isLegacyOpenView, parseSavedView } from '../../../src/lib/budget/savedView'
import { parseTxnViewPrefs, TXN_PREFS_MAX_BYTES } from '../../../src/lib/budget/txnView'
import { BUDGET_DENIED } from '../../_lib/auth'
import { budgetJson, type BudgetData, type BudgetEnv } from '../../_lib/budgetAccess'

export const PREFS_KEY_PREFIX = 'budget:prefs:'
export const VIEW_KEY_PREFIX = 'budget:prefs-view:'
export const PREFS_MAX_BYTES = TXN_PREFS_MAX_BYTES

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The KV key for one login's toolbar block. */
export async function prefsKey(email: string): Promise<string> {
  return PREFS_KEY_PREFIX + (await sha256Hex(email.trim().toLowerCase()))
}

/** The KV key for one login's saved view block. */
export async function viewKey(email: string): Promise<string> {
  return VIEW_KEY_PREFIX + (await sha256Hex(email.trim().toLowerCase()))
}

function readSaved(text: string | null, field: 'txnView' | 'view'): unknown {
  if (!text) return null
  try {
    const raw = (JSON.parse(text) as Record<string, unknown> | null)?.[field]
    return field === 'view' ? parseSavedView(raw) : parseTxnViewPrefs(raw)
  } catch {
    return null
  }
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
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return budgetJson(400, { error: 'bad_request' })
    const body = raw as { txnView?: unknown; view?: unknown }
    const keys = Object.keys(body)
    if (keys.length === 0 || keys.some((k) => k !== 'txnView' && k !== 'view')) return budgetJson(400, { error: 'bad_request' })
    const txnView = 'txnView' in body ? parseTxnViewPrefs(body.txnView, true) : undefined
    const view = 'view' in body ? parseSavedView(body.view, true) : undefined
    if (txnView === null || view === null) return budgetJson(400, { error: 'bad_request' })
    if (txnView) await kv.put(await prefsKey(email), JSON.stringify({ txnView }))
    if (view) await kv.put(await viewKey(email), JSON.stringify({ view }))
    return budgetJson(200, { ok: true })
  }

  const [savedTxn, savedView] = await Promise.all([kv.get(await prefsKey(email)), kv.get(await viewKey(email))])
  const txnView = readSaved(savedTxn, 'txnView')
  const view = readSaved(savedView, 'view')
  // `viewLegacy`: the stored block is a 0.82.0 one that hid nothing (its `hidden` key is gone from `view`), so the browser
  // can map an old "Side by side" choice to the Both tab.
  let viewLegacy = false
  try {
    viewLegacy = !!view && !!savedView && isLegacyOpenView((JSON.parse(savedView) as { view?: unknown } | null)?.view)
  } catch {
    viewLegacy = false
  }
  return budgetJson(200, { ...(txnView ? { txnView } : {}), ...(view ? { view } : {}), ...(viewLegacy ? { viewLegacy: true } : {}) })
}
