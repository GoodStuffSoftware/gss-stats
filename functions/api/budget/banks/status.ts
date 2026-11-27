/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/banks/status: what the Banks page shows (BanksStatus). D1 only: it answers 200 even when the BANKS
// binding is absent (`configured: false`, no link button), so the page can say so calmly. Four narrow reads, each an
// indexed lookup: the slot count, the live Items, their accounts (one json_each list), and the dropped rows (max 200).
// Accounts are masked to the last 4 (the stored `mask` is already only 4 digits). No Plaid id, token or cursor, and no
// owner address, leaves this route; `mine` says whether the Item is the caller's.

import type { BankAccountSync, BankItemStatus, BankItemView, BanksStatus, BankDroppedRow } from '../../../../src/lib/budget/types'
import { PLAID_SLOT_LIMIT } from '../../../../src/lib/budget/types'
import { budgetJson } from '../../../_lib/budgetAccess'
import { defineRoute } from '../../../_lib/budgetDb'

export const MAX_DROPPED = 200

/** Slots Plaid counts: production attempts that are pending, done or made by hand. Failed and sandbox rows do not count. */
export const SLOTS_USED_SQL = "SELECT count(*) AS n FROM plaid_slot_log WHERE environment = 'production' AND status IN ('pending','done','prior')"
/** Items the page lists (everything but removed); the status index serves it. */
export const ITEMS_SQL = `SELECT id, owner_email, institution_name, status, new_accounts, last_ok_at, last_error, sync_requested_at, created_at
  FROM bank_items WHERE status IN ('active','needs_reconnect','pending_disconnect','revoked') ORDER BY created_at, id`
export const ACCOUNTS_SQL = `SELECT id, item_id, name, mask, type, subtype, sync, account_id, sync_from, balance_cents, available_cents, limit_cents, balance_as_of
  FROM bank_accounts WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY item_id, created_at, id`
/** Rows Plaid removed that a person had edited: they wait for Delete or Keep. The partial index idx_bank_txn_dropped serves the filter. */
export const DROPPED_SQL = `SELECT t.id AS txn_id, t.posted_date, t.amount_cents, t.description, t.account_id
  FROM bank_txns b JOIN transactions t ON t.id = b.txn_id
  WHERE b.state = 'dropped' ORDER BY t.posted_date DESC, t.id LIMIT ${MAX_DROPPED}`

type Row = Record<string, unknown>
const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const centsOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export const onRequest = defineRoute({
  GET: async (ctx) => {
    const db = ctx.env.BUDGET_DB!
    const email = ctx.data.budgetEmail!.trim().toLowerCase()
    const configured = typeof ctx.env.BANKS?.fetch === 'function'

    const used = Number((await db.prepare(SLOTS_USED_SQL).first<{ n: number }>())?.n ?? 0)
    const left = Math.max(0, PLAID_SLOT_LIMIT - used)

    const itemRows = (await db.prepare(ITEMS_SQL).all<Row>()).results
    const byItem = new Map<string, BankItemView>()
    for (const r of itemRows) {
      byItem.set(String(r.id), {
        id: String(r.id), institutionName: textOrNull(r.institution_name), status: String(r.status) as BankItemStatus,
        mine: String(r.owner_email) === email, newAccounts: Number(r.new_accounts) === 1, lastOkAt: textOrNull(r.last_ok_at),
        lastError: textOrNull(r.last_error), syncRequested: r.sync_requested_at !== null && r.sync_requested_at !== undefined, accounts: [],
      })
    }
    if (byItem.size > 0) {
      const accounts = (await db.prepare(ACCOUNTS_SQL).bind(JSON.stringify([...byItem.keys()])).all<Row>()).results
      for (const a of accounts) {
        byItem.get(String(a.item_id))?.accounts.push({
          id: String(a.id), name: String(a.name), mask: textOrNull(a.mask), type: String(a.type), subtype: textOrNull(a.subtype),
          sync: String(a.sync) as BankAccountSync, accountId: textOrNull(a.account_id), syncFrom: textOrNull(a.sync_from),
          balanceCents: centsOrNull(a.balance_cents), availableCents: centsOrNull(a.available_cents), limitCents: centsOrNull(a.limit_cents),
          balanceAsOf: textOrNull(a.balance_as_of),
        })
      }
    }
    const dropped: BankDroppedRow[] = (await db.prepare(DROPPED_SQL).all<Row>()).results.map((r) => ({
      txnId: String(r.txn_id), postedDate: String(r.posted_date), amountCents: Number(r.amount_cents), description: String(r.description), accountId: String(r.account_id),
    }))

    const body: BanksStatus = { configured, linkEnabled: configured && left > 0, slots: { used, limit: PLAID_SLOT_LIMIT, left }, items: [...byItem.values()], dropped }
    return budgetJson(200, body)
  },
})
