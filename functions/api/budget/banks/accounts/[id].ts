/// <reference types="@cloudflare/workers-types" />
//
// PATCH /api/budget/banks/accounts/:id: set up or stop the feed for one bank account (plan 3.1). Owner of the account's Item only.
// Body (at most 2 KB) `{ sync: 'on' | 'off', accountId?, newAccount?: { name, kind, personId } }`.
//   on:  exactly one of `accountId` (an existing Budget account) or `newAccount` (made here). The kind must fit the bank's account
//        type (depository: checking or savings; credit: card or line_of_credit; loan: loan), else 400 kind_mismatch. A Budget
//        account that already has another bank feed on is 409 account_taken. `sync_from` is the day after the newest row the
//        Budget account already has (NULL when it has none), so the statement load and the bank never both write a day. The Item's
//        cursor is reset (the next run is a `resync`: mapped rows are skipped by Plaid id) and a sync is requested.
//   off: the feed stops; every row stays.
// D1 only. One batch, so the account, the mapping and the cursor reset land together or not at all.

import type { AccountKind } from '../../../../../src/lib/budget/types'
import { budgetJson } from '../../../../_lib/budgetAccess'
import { BudgetHttpError, badRequest, defineRoute, isAccountId, notFound, readJsonObject } from '../../../../_lib/budgetDb'
import { BANK_ACCOUNT_ID_RE, LIVE_ITEM_STATUSES, itemNotActive, requireBanks } from '../../../../_lib/banks'

export const MAX_BODY_ACCOUNT = 2048
const PERSON_RE = /^[a-z0-9]{1,24}$/

// The reads and the mapping update, named so a test can EXPLAIN them (every one is index-backed).
export const TARGET_SQL = `SELECT a.type, a.sync, a.item_id, a.mask, i.owner_email, i.status FROM bank_accounts a JOIN bank_items i ON i.id = a.item_id WHERE a.id = ?`
export const TAKEN_SQL = "SELECT 1 AS x FROM bank_accounts WHERE account_id = ? AND sync = 'on' AND id <> ?"
export const MAP_SQL = `UPDATE bank_accounts SET account_id = ?1, sync = 'on', updated_at = ?2,
           sync_from = (SELECT date(MAX(posted_date), '+1 day') FROM transactions WHERE account_id = ?1) WHERE id = ?3`

/** Budget account kinds a Plaid account type may feed. */
const FITS: Record<string, readonly AccountKind[]> = { depository: ['checking', 'savings'], credit: ['card', 'line_of_credit'], loan: ['loan'] }
const DEBT_KINDS: readonly string[] = ['card', 'line_of_credit', 'loan']
/** Cards count in spending; a line of credit or loan only shows under debts (the convention of the synthetic and real accounts). */
const IN_SPENDING_KINDS: readonly string[] = ['checking', 'savings', 'card']

const mismatch = (): BudgetHttpError => new BudgetHttpError(400, 'kind_mismatch', 'That account type does not fit this bank account.')
const fits = (type: string, kind: string): boolean => (FITS[type] ?? []).includes(kind as AccountKind)

interface Target {
  type: string
  sync: string
  itemId: string
  owner: string
  status: string
  mask: string | null
}

export const onRequest = defineRoute({
  PATCH: async (ctx) => {
    requireBanks(ctx.env)
    const db = ctx.env.BUDGET_DB!
    const id = String(ctx.params.id ?? '')
    const email = ctx.data.budgetEmail!.trim().toLowerCase()
    const body = await readJsonObject(ctx.request, MAX_BODY_ACCOUNT)
    const sync = body.sync
    if (sync !== 'on' && sync !== 'off') throw badRequest("sync: expected 'on' or 'off'")
    if (!BANK_ACCOUNT_ID_RE.test(id)) throw notFound()

    const row = await db.prepare(TARGET_SQL).bind(id).first<{ type: string; sync: string; item_id: string; mask: string | null; owner_email: string; status: string }>()
    if (!row) throw notFound()
    const t: Target = { type: row.type, sync: row.sync, itemId: row.item_id, owner: row.owner_email, status: row.status, mask: row.mask }
    if (t.owner !== email) throw new BudgetHttpError(403, 'not_owner', 'Only the person who linked this bank can do that.')
    const now = new Date().toISOString()

    if (sync === 'off') {
      await db.prepare("UPDATE bank_accounts SET sync = 'off', updated_at = ? WHERE id = ?").bind(now, id).run()
      return budgetJson(200, { ok: true })
    }

    if (!(LIVE_ITEM_STATUSES as readonly string[]).includes(t.status)) throw itemNotActive()
    if (t.sync === 'on') throw new BudgetHttpError(409, 'already_on', 'This account is already syncing. Turn it off first to change it.')
    const hasExisting = body.accountId !== undefined
    const hasNew = body.newAccount !== undefined
    if (hasExisting === hasNew) throw badRequest('send exactly one of accountId or newAccount')

    const stmts: D1PreparedStatement[] = []
    let accountId: string
    let isNew = false
    if (hasExisting) {
      if (!isAccountId(body.accountId)) throw badRequest('accountId: not an account id')
      accountId = body.accountId
      const acct = await db.prepare('SELECT kind FROM accounts WHERE id = ? AND archived = 0').bind(accountId).first<{ kind: string }>()
      if (!acct) throw notFound('accountId: no such account')
      if (!fits(t.type, acct.kind)) throw mismatch()
      const taken = await db.prepare(TAKEN_SQL).bind(accountId, id).first()
      if (taken) throw new BudgetHttpError(409, 'account_taken', 'Another bank account already feeds that account.')
    } else {
      const na = body.newAccount
      if (typeof na !== 'object' || na === null || Array.isArray(na)) throw badRequest('newAccount: expected an object')
      const { name, kind, personId } = na as Record<string, unknown>
      if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 40 || name.includes('\u0000')) throw badRequest('newAccount.name: 1 to 40 characters')
      if (typeof kind !== 'string') throw badRequest('newAccount.kind: required')
      if (!fits(t.type, kind)) throw mismatch()
      if (personId !== undefined && personId !== null) {
        if (typeof personId !== 'string' || !PERSON_RE.test(personId)) throw badRequest('newAccount.personId: not a person id')
        if (!(await db.prepare('SELECT 1 AS x FROM people WHERE id = ?').bind(personId).first())) throw badRequest('newAccount.personId: no such person')
      }
      isNew = true
      accountId = `bk-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
      stmts.push(
        db.prepare(
          `INSERT INTO accounts (id, label, kind, person_id, last4, is_debt, in_spending, sort)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (SELECT COALESCE(MAX(sort), 0) + 10 FROM accounts))`,
        ).bind(accountId, name.trim(), kind, typeof personId === 'string' ? personId : null, t.mask, DEBT_KINDS.includes(kind) ? 1 : 0, IN_SPENDING_KINDS.includes(kind) ? 1 : 0),
      )
    }

    // sync_from: the day after the newest row the Budget account holds (NULL for none; idx_txn_account serves MAX).
    stmts.push(
      db.prepare(MAP_SQL).bind(accountId, now, id),
      db.prepare("UPDATE bank_items SET sync_cursor = NULL, sync_requested_at = ?1, updated_at = ?1 WHERE id = ?2 AND status IN ('active','needs_reconnect','pending_disconnect')").bind(now, t.itemId),
    )
    try {
      await db.batch(stmts)
    } catch (err) {
      if (/UNIQUE|constraint/i.test(String((err as Error)?.message))) throw new BudgetHttpError(409, 'account_taken', 'Another bank account already feeds that account.')
      throw err
    }
    const synced = await db.prepare('SELECT sync_from FROM bank_accounts WHERE id = ?').bind(id).first<{ sync_from: string | null }>()
    return budgetJson(200, { ok: true, accountId, created: isNew, syncFrom: synced?.sync_from ?? null })
  },
})
