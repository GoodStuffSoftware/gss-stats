// POST /exchange (plan section 3.3): duplicate check, slot reservation, public_token exchange, encrypted store.
// Order matters: the slot row is written BEFORE the exchange call and a timeout leaves it pending (it still counts).
import type { RouteInput } from './index'
import { PlaidError, PlaidTimeoutError, createPlaidClient, type PlaidClient } from './plaid'
import { finishSlot, finishSlotStmt, reserveSlot, slotEnvironment } from './slots'
import { findDuplicate, maskName, maskOnly4, newId, newItemStatements, readKeys, sealToken, type NewAccount } from './store'
import { log } from './log'

export interface BankDeps {
  fetch: typeof fetch
  now: () => Date
}

/** Real dependencies unless a test injects them. The default fetch reads the global lazily. */
export function planDeps(d: Partial<BankDeps>): BankDeps {
  return { fetch: d.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)), now: d.now ?? (() => new Date()) }
}

export function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
const fail = (status: number, code: string): Response => reply(status, { ok: false, code })

/** A Plaid failure as a fixed-code answer; logs the code only. */
export function failFromError(e: unknown, event: string): Response {
  if (e instanceof PlaidTimeoutError) {
    log(`${event}_failed`, {}, 'plaid_timeout')
    return fail(504, 'plaid_timeout')
  }
  if (e instanceof PlaidError) {
    if (e.type === 'CONFIG') {
      log(`${event}_failed`, {}, e.code === 'PLAID_SECRETS_MISSING' ? 'secrets_missing' : 'config_invalid')
      return fail(503, e.code === 'PLAID_SECRETS_MISSING' ? 'secrets_missing' : 'config_invalid')
    }
    const code = `plaid_${e.type.toLowerCase()}`
    log(`${event}_failed`, {}, code)
    return fail(502, code)
  }
  log(`${event}_failed`, {}, 'server_error')
  return fail(500, 'server_error')
}

const INSTITUTION_ID = /^[A-Za-z0-9_]{1,32}$/
const PLAID_ID = /^[A-Za-z0-9_-]{1,64}$/
const TYPES = new Set(['depository', 'credit', 'loan', 'investment'])
const LIMIT = 10_000_000_000

function cents(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const c = Math.round(v * 100)
  return Math.abs(c) <= LIMIT ? c : null
}

interface PlaidAccount {
  account_id?: unknown
  name?: unknown
  mask?: unknown
  type?: unknown
  subtype?: unknown
  balances?: { current?: unknown; available?: unknown; limit?: unknown }
}

/** One /accounts/get account as a row, or null when it has no usable id. Name masked; mask only when 4 digits. */
function toAccount(a: PlaidAccount): NewAccount | null {
  if (typeof a.account_id !== 'string' || !PLAID_ID.test(a.account_id)) return null
  const type = typeof a.type === 'string' && TYPES.has(a.type) ? (a.type as NewAccount['type']) : a.type === 'brokerage' ? 'investment' : 'other'
  const sub = typeof a.subtype === 'string' ? a.subtype.toLowerCase().replace(/[^a-z0-9 _-]/g, '').slice(0, 40) : ''
  const b = a.balances ?? {}
  return {
    plaidAccountId: a.account_id,
    name: maskName(a.name) ?? 'Account',
    mask: maskOnly4(a.mask),
    type,
    subtype: sub === '' ? null : sub,
    balanceCents: cents(b.current),
    availableCents: cents(b.available),
    limitCents: cents(b.limit),
  }
}

/** Best effort: undo an Item we cannot store. The slot stays counted either way. */
async function removeQuietly(plaid: PlaidClient, accessToken: string): Promise<void> {
  try {
    await plaid.post('/item/remove', { access_token: accessToken, reason_code: 'OTHER' })
  } catch {
    log('exchange_remove_failed')
  }
}

export async function handleExchange(input: RouteInput, deps: Partial<BankDeps> = {}): Promise<Response> {
  const { env, body, ownerEmail } = input
  const { fetch: doFetch, now } = planDeps(deps)
  const db = env.BUDGET_DB

  const consent = body.consentVersion
  const publicToken = body.publicToken
  const inst = body.institution as { id?: unknown; name?: unknown } | null | undefined
  const given = body.accounts
  if (typeof consent !== 'number' || !Number.isInteger(consent) || consent < 1) return fail(400, 'bad_request')
  if (typeof publicToken !== 'string' || publicToken.length < 1 || publicToken.length > 512) return fail(400, 'bad_request')
  if (!inst || typeof inst !== 'object' || (inst.id !== undefined && inst.id !== null && (typeof inst.id !== 'string' || !INSTITUTION_ID.test(inst.id)))) return fail(400, 'bad_request')
  if (!Array.isArray(given) || given.length > 100) return fail(400, 'bad_request')
  const institutionId = typeof inst.id === 'string' ? inst.id : null
  const institutionName = maskName(inst.name)

  const keys = await readKeys(env)
  if (!keys) return fail(503, 'secrets_missing')
  const environment = slotEnvironment(env)

  // 1. Duplicate: same institution, same mask and name as a live item's account (Plaid [P9]). No exchange, no slot.
  if (institutionId) {
    const wanted = given.map((g) => {
      const o = (g && typeof g === 'object' ? g : {}) as { mask?: unknown; name?: unknown }
      return { mask: maskOnly4(o.mask) ?? '', name: maskName(o.name) ?? '' }
    })
    if (await findDuplicate(db, environment, institutionId, wanted)) {
      log('exchange_refused', {}, 'duplicate_item')
      return fail(409, 'duplicate_item')
    }
  }

  // 2. Slot row, one atomic conditional INSERT.
  const slotId = await reserveSlot(db, env, ownerEmail, institutionId, now())
  if (slotId === null) {
    log('exchange_refused', {}, 'slots_full')
    return fail(409, 'slots_full')
  }

  const plaid = createPlaidClient({ env, fetch: doFetch, now })

  // 3. Exchange. A Plaid answer with an error closes the row as failed; no answer (timeout, network) leaves it pending.
  let accessToken: string
  let plaidItemId: string
  try {
    const ex = await plaid.post<{ access_token?: unknown; item_id?: unknown }>('/item/public_token/exchange', { public_token: publicToken })
    if (typeof ex.access_token !== 'string' || ex.access_token === '' || typeof ex.item_id !== 'string' || !PLAID_ID.test(ex.item_id)) {
      throw new PlaidError('API_ERROR', 'BAD_RESPONSE')
    }
    accessToken = ex.access_token
    plaidItemId = ex.item_id
  } catch (e) {
    const answered = e instanceof PlaidError && e.type !== 'NETWORK'
    if (answered) {
      try {
        await finishSlot(db, slotId, 'failed', null, now())
      } catch {
        log('exchange_slot_update_failed')
      }
    }
    return failFromError(e, 'exchange')
  }

  // From here the Item exists at Plaid and holds a slot: a failure removes it again but the slot stays counted.
  const abandon = async (): Promise<Response> => {
    await removeQuietly(plaid, accessToken)
    try {
      await finishSlot(db, slotId, 'done', plaidItemId, now())
    } catch {
      log('exchange_slot_update_failed')
    }
    log('exchange_failed', {}, 'store_failed')
    return fail(500, 'store_failed')
  }

  // 4. Accounts, seal, one batch (item, accounts, slot row done), tried twice.
  let accounts: NewAccount[]
  try {
    const res = await plaid.post<{ accounts?: PlaidAccount[] }>('/accounts/get', { access_token: accessToken })
    accounts = (Array.isArray(res.accounts) ? res.accounts : []).map(toAccount).filter((a): a is NewAccount => a !== null)
  } catch {
    return abandon()
  }
  const itemId = newId('i')
  const asOf = now().toISOString()
  try {
    const enc = await sealToken(accessToken, itemId, keys)
    const item = { id: itemId, ownerEmail, environment, plaidItemId, institutionId, institutionName, consentVersion: consent, enc }
    let stored = false
    for (let attempt = 0; attempt < 2 && !stored; attempt++) {
      try {
        await db.batch([...newItemStatements(db, item, accounts, asOf), finishSlotStmt(db, slotId, 'done', plaidItemId, now())])
        stored = true
      } catch {
        log('exchange_batch_failed', { attempt: attempt + 1 })
      }
    }
    if (!stored) return abandon()
  } catch {
    return abandon()
  }

  log('exchange_done', { accounts: accounts.length })
  return reply(200, { ok: true, itemId, accounts: accounts.length })
}
