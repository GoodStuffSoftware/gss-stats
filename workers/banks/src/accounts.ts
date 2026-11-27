// POST /accounts-refresh (plan 3.3 and 4.5, new-accounts bullet): after NEW_ACCOUNTS_AVAILABLE set `new_accounts = 1` and the owner
// shared more accounts through update-mode Link, one /accounts/get adds the ones not stored yet as `unmapped` rows (name masked, mask
// only when 4 digits). Stored rows are never touched, including ones missing from the answer. The flag clears in the same batch as
// the inserts. Answer: { ok, added }. Logs: counts and codes only.
import { plaidErrorCode } from './sync'
import { PlaidError, createPlaidClient } from './plaid'
import { failFromError, planDeps, reply, toAccount, type BankDeps, type PlaidAccount } from './exchange'
import type { RouteInput } from './index'
import { log } from './log'
import { LIVE_STATUSES, getItem, newId, openAndRefreshToken, readKeys } from './store'

const fail = (status: number, code: string): Response => reply(status, { ok: false, code })
const ITEM_ID = /^i[0-9a-f]{16}$/

export async function handleAccountsRefresh(input: RouteInput, deps: Partial<BankDeps> = {}): Promise<Response> {
  const { env, body, ownerEmail } = input
  const { fetch: doFetch, now } = planDeps(deps)
  const db = env.BUDGET_DB

  const itemId = body.itemId
  if (typeof itemId !== 'string' || !ITEM_ID.test(itemId)) return fail(400, 'bad_request')
  const item = await getItem(db, itemId)
  if (!item) return fail(404, 'item_not_found')
  if (item.owner_email !== ownerEmail) return fail(403, 'not_owner')
  if (!(LIVE_STATUSES as readonly string[]).includes(item.status) || item.environment !== (env.PLAID_ENV ?? '')) return fail(409, 'item_not_active')
  const keys = await readKeys(env)
  if (!keys) return fail(503, 'secrets_missing')

  let token: string
  try {
    token = await openAndRefreshToken(db, item, keys)
  } catch {
    log('accounts_refresh_failed', {}, 'decrypt_failed')
    return fail(500, 'decrypt_failed')
  }

  const at = now().toISOString()
  const plaid = createPlaidClient({ env, fetch: doFetch, now })
  let answer: PlaidAccount[]
  try {
    const res = await plaid.post<{ accounts?: unknown }>('/accounts/get', { access_token: token })
    if (!Array.isArray(res.accounts)) throw new PlaidError('API_ERROR', 'BAD_RESPONSE')
    answer = res.accounts as PlaidAccount[]
  } catch (e) {
    if (e instanceof PlaidError && e.code === 'ITEM_LOGIN_REQUIRED') {
      await db
        .prepare(`UPDATE bank_items SET status = 'needs_reconnect', last_error = ?2, updated_at = ?3 WHERE id = ?1 AND status IN ('active','pending_disconnect')`)
        .bind(itemId, plaidErrorCode('ITEM_LOGIN_REQUIRED'), at)
        .run()
      log('accounts_refresh_failed', {}, 'needs_reconnect')
      return fail(409, 'needs_reconnect')
    }
    return failFromError(e, 'accounts_refresh')
  }

  const stored = await db.prepare('SELECT plaid_account_id FROM bank_accounts WHERE item_id = ?1').bind(itemId).all<{ plaid_account_id: string }>()
  const have = new Set((stored.results ?? []).map((r) => r.plaid_account_id))
  const fresh = answer.map(toAccount).filter((a) => a !== null && !have.has(a.plaidAccountId))
  const seen = new Set<string>()
  const stmts: D1PreparedStatement[] = []
  for (const a of fresh) {
    if (!a || seen.has(a.plaidAccountId)) continue
    seen.add(a.plaidAccountId)
    stmts.push(
      db
        .prepare(
          `INSERT INTO bank_accounts (id, item_id, plaid_account_id, name, mask, type, subtype, sync,
             balance_cents, available_cents, limit_cents, balance_as_of, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'unmapped', ?8, ?9, ?10, ?11, ?11, ?11)
           ON CONFLICT(plaid_account_id) DO NOTHING`,
        )
        .bind(newId('b'), itemId, a.plaidAccountId, a.name, a.mask, a.type, a.subtype, a.balanceCents, a.availableCents, a.limitCents, at),
    )
  }
  stmts.push(db.prepare('UPDATE bank_items SET new_accounts = 0, updated_at = ?2 WHERE id = ?1').bind(itemId, at))
  try {
    await db.batch(stmts)
  } catch {
    log('accounts_refresh_failed', {}, 'store_failed')
    return fail(500, 'store_failed')
  }
  const added = seen.size
  log('accounts_refreshed', { added })
  return reply(200, { ok: true, added })
}
