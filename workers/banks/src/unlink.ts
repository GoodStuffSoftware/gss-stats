// POST /unlink (plan 3.3): owner check, /item/remove at Plaid (reason OTHER, no note), then the wipe shared with a revoked Item
// (webhook.ts wipeItemStatements: status 'removed', no token material, accounts sync off, liabilities deleted). Transactions stay.
// The plaid_slot_log row is never touched (removing an Item does not free a slot). Plaid's ITEM_NOT_FOUND counts as done; any
// other Plaid failure wipes nothing, so the Item can still be removed later. Logs: counts and codes only.
import { PlaidError, createPlaidClient } from './plaid'
import { failFromError, planDeps, reply, type BankDeps } from './exchange'
import type { RouteInput } from './index'
import { log } from './log'
import { LIVE_STATUSES, getItem, openToken, readKeys } from './store'
import { wipeItemStatements } from './webhook'

const fail = (status: number, code: string): Response => reply(status, { ok: false, code })
const ITEM_ID = /^i[0-9a-f]{16}$/

export async function handleUnlink(input: RouteInput, deps: Partial<BankDeps> = {}): Promise<Response> {
  const { env, body, ownerEmail } = input
  const { fetch: doFetch, now } = planDeps(deps)
  const db = env.BUDGET_DB

  const itemId = body.itemId
  if (typeof itemId !== 'string' || !ITEM_ID.test(itemId)) return fail(400, 'bad_request')
  const item = await getItem(db, itemId)
  if (!item) return fail(404, 'item_not_found')
  if (item.owner_email !== ownerEmail) return fail(403, 'not_owner')
  // Already gone (removed here, or revoked at the bank): nothing to call, nothing to wipe again.
  if (item.status === 'removed' || item.status === 'revoked') return reply(200, { ok: true })
  if (!(LIVE_STATUSES as readonly string[]).includes(item.status) || item.environment !== (env.PLAID_ENV ?? '')) return fail(409, 'item_not_active')

  const keys = await readKeys(env)
  if (!keys) return fail(503, 'secrets_missing')
  let token: string
  try {
    token = await openToken(item, keys)
  } catch {
    log('unlink_failed', {}, 'decrypt_failed')
    return fail(500, 'decrypt_failed')
  }

  const plaid = createPlaidClient({ env, fetch: doFetch, now })
  let code = 'removed'
  try {
    await plaid.post('/item/remove', { access_token: token, reason_code: 'OTHER' })
  } catch (e) {
    if (e instanceof PlaidError && e.code === 'ITEM_NOT_FOUND') code = 'already_gone'
    else return failFromError(e, 'unlink')
  }

  try {
    await db.batch(wipeItemStatements(db, itemId, 'removed', now()))
  } catch {
    log('unlink_failed', {}, 'store_failed')
    return fail(500, 'store_failed')
  }
  log('unlink_done', {}, code)
  return reply(200, { ok: true })
}
