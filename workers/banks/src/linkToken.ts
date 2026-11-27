// POST /link-token (plan section 3.3). New link: refuses 409 slots_full in production at 10 used, then
// /link/token/create. Update mode (itemId): the owner's item, its decrypted access token, no products.
//
// Liabilities: `required_if_supported_products: ['liabilities']`. Per https://plaid.com/docs/api/link/ , institutions
// that lack the product still appear in Link, and it is billed only where the chosen institution and account type
// support it (optional_products is best-effort but without that billing note; `products` would hide banks without it).
// `update.account_selection_enabled` (boolean, nested under `update`) turns on update mode with Account Select; update
// mode sends the item's access_token and no `products`.
import type { RouteInput } from './index'
import { LIVE_STATUSES, clientUserId, getItem, openToken, readKeys } from './store'
import { PlaidError, createPlaidClient, type PlaidClient } from './plaid'
import { failFromError, planDeps, reply as jsonResponse, type BankDeps } from './exchange'
import { SLOT_LIMIT, slotEnvironment, slotsUsed } from './slots'
import { log } from './log'

/** Plaid refused the link token request itself (a 4xx JSON answer of type INVALID_REQUEST or INVALID_INPUT, such as an unregistered redirect URI): our setup, not the bank. */
export function isSetupRefusal(e: unknown): boolean {
  return e instanceof PlaidError && e.refused && e.status >= 400 && e.status < 500 && (e.type === 'INVALID_REQUEST' || e.type === 'INVALID_INPUT')
}

const ITEM_ID = /^i[0-9a-f]{16}$/

export async function handleLinkToken(input: RouteInput, deps: Partial<BankDeps> = {}): Promise<Response> {
  const { env, body, ownerEmail } = input
  const { fetch: doFetch, now } = planDeps(deps)
  const consent = body.consentVersion
  if (typeof consent !== 'number' || !Number.isInteger(consent) || consent < 1) return jsonResponse(400, { ok: false, code: 'bad_request' })
  const itemId = body.itemId
  if (itemId !== undefined && (typeof itemId !== 'string' || !ITEM_ID.test(itemId))) return jsonResponse(400, { ok: false, code: 'bad_request' })
  const accountSelection = body.accountSelection
  if (accountSelection !== undefined && typeof accountSelection !== 'boolean') return jsonResponse(400, { ok: false, code: 'bad_request' })

  const common: Record<string, unknown> = {
    client_name: 'GSS Budget',
    country_codes: ['US'],
    language: 'en',
    user: { client_user_id: await clientUserId(ownerEmail) },
  }
  if (env.PLAID_WEBHOOK_URL) common.webhook = env.PLAID_WEBHOOK_URL
  if (env.PLAID_REDIRECT_URI) common.redirect_uri = env.PLAID_REDIRECT_URI

  let request: Record<string, unknown>
  if (itemId === undefined) {
    if (slotEnvironment(env) === 'production' && (await slotsUsed(env.BUDGET_DB)) >= SLOT_LIMIT) {
      log('link_refused', {}, 'slots_full')
      return jsonResponse(409, { ok: false, code: 'slots_full' })
    }
    request = {
      ...common,
      products: ['transactions'],
      required_if_supported_products: ['liabilities'],
      transactions: { days_requested: 730 },
    }
  } else {
    const item = await getItem(env.BUDGET_DB, itemId)
    if (!item || item.owner_email !== ownerEmail) return jsonResponse(404, { ok: false, code: 'item_not_found' })
    if (item.environment !== slotEnvironment(env)) return jsonResponse(409, { ok: false, code: 'item_not_active' })
    if (!(LIVE_STATUSES as readonly string[]).includes(item.status)) return jsonResponse(409, { ok: false, code: 'item_not_active' })
    const keys = await readKeys(env)
    if (!keys) return jsonResponse(503, { ok: false, code: 'secrets_missing' })
    let token: string
    try {
      token = await openToken(item, keys)
    } catch {
      log('link_failed', {}, 'decrypt_failed')
      return jsonResponse(500, { ok: false, code: 'decrypt_failed' })
    }
    request = { ...common, access_token: token }
    if (accountSelection === true) request.update = { account_selection_enabled: true }
  }

  const plaid: PlaidClient = createPlaidClient({ env, fetch: doFetch, now })
  try {
    const res = await plaid.post<{ link_token?: unknown; expiration?: unknown }>('/link/token/create', request)
    if (typeof res.link_token !== 'string' || res.link_token === '') return jsonResponse(502, { ok: false, code: 'plaid_api_error' })
    log('link_token_created', { update: itemId === undefined ? 0 : 1 })
    return jsonResponse(200, { ok: true, linkToken: res.link_token, expiration: typeof res.expiration === 'string' ? res.expiration : null })
  } catch (e) {
    // Update mode: a refusal means this Item's link is bad (INVALID_ACCESS_TOKEN and the like), not our setup. It stays plaid_<type>, the bank-side/relink path.
    if (itemId === undefined && isSetupRefusal(e)) {
      log('link_failed', {}, 'plaid_setup')
      return jsonResponse(502, { ok: false, code: 'plaid_setup' })
    }
    return failFromError(e, 'link')
  }
}
