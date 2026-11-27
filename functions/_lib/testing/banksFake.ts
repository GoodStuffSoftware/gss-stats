// Tests only: a fake BANKS Service Binding and seeds for the bank-link tables (migration 0005). Every id, token
// stand-in and cursor here is made up. The binding answers only the paths a test registered (`answer`) and THROWS on
// any other, so a route that calls the Worker when it must not (or on a path it should not) fails its test. Nothing
// here talks to Plaid, Cloudflare or a remote D1.

import type { FakeBudgetDb } from './budgetDb'

export interface BanksCall {
  path: string
  body: Record<string, unknown>
}

export interface FakeBanks {
  /** Cast of this fake for `env.BANKS`. */
  readonly binding: Fetcher
  /** Every call that reached the Worker, in order. */
  readonly calls: BanksCall[]
  /** Register the Worker's answer for one path (a JSON body and status; repeated calls answer the same). */
  answer(path: string, status: number, body: Record<string, unknown>): void
  /** The next call to this path never answers (for the timeout case: the route's own timer must fire). */
  hang(path: string): void
  /** The next call to this path throws. */
  fail(path: string): void
}

export function createFakeBanks(): FakeBanks {
  const answers = new Map<string, { status: number; body: Record<string, unknown> }>()
  const hangs = new Set<string>()
  const fails = new Set<string>()
  const calls: BanksCall[] = []
  const fake: FakeBanks = {
    binding: {
      async fetch(input: unknown, init?: RequestInit): Promise<Response> {
        const url = new URL(typeof input === 'string' ? input : (input as Request).url)
        if (url.origin !== 'https://banks.internal') throw new Error(`unexpected BANKS origin ${url.origin}`)
        const path = url.pathname
        calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
        if (hangs.delete(path)) return new Promise<Response>(() => {})
        if (fails.delete(path)) throw new Error('simulated binding failure')
        const a = answers.get(path)
        if (!a) throw new Error(`unexpected BANKS path ${path}`)
        return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
      },
    } as unknown as Fetcher,
    calls,
    answer: (path, status, body) => void answers.set(path, { status, body }),
    hang: (path) => void hangs.add(path),
    fail: (path) => void fails.add(path),
  }
  return fake
}

const T0 = '2026-11-01T00:00:00.000Z'

/** Distinctive stand-ins, so a test can prove none of them reaches a response body. */
export const SECRETS = {
  tokenCt: 'Q0lQSEVSVEVYVEZPUlRFU1RT',
  tokenIv: 'aXZpdml2aXZpaXZp',
  cursor: 'cursor-secret-text-001',
  plaidItem: 'plaid-item-secret-001',
  plaidAccount: 'plaid-acct-secret-001',
} as const

export interface ItemSeed {
  id?: string
  owner?: string
  status?: string
  environment?: string
  institutionName?: string | null
  cursor?: string | null
  newAccounts?: number
  syncRequestedAt?: string | null
  lastError?: string | null
  lastOkAt?: string | null
  plaidItemId?: string
  createdAt?: string
}

/** Inserts one bank_items row (live statuses carry token stand-ins; revoked and removed carry none, as the CHECK requires). */
export function seedBankItem(db: FakeBudgetDb, o: ItemSeed = {}): string {
  const id = o.id ?? 'i000000000000a001'
  const status = o.status ?? 'active'
  const live = status === 'active' || status === 'needs_reconnect' || status === 'pending_disconnect'
  db.sqlite.prepare(
    `INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, institution_name, status, token_ct, token_iv, key_id, sync_cursor,
       new_accounts, sync_requested_at, consent_version, consented_at, last_ok_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    id, o.owner ?? 'owner@example.com', o.environment ?? 'production', o.plaidItemId ?? `${SECRETS.plaidItem}-${id}`,
    o.institutionName === undefined ? 'Pine Ridge Bank' : o.institutionName, status,
    live ? SECRETS.tokenCt : null, live ? SECRETS.tokenIv : null, live ? '0a1b2c3d' : null,
    live ? (o.cursor === undefined ? SECRETS.cursor : o.cursor) : null,
    o.newAccounts ?? 0, o.syncRequestedAt ?? null, T0, o.lastOkAt ?? null, o.lastError ?? null, o.createdAt ?? T0, T0,
  )
  return id
}

export interface BankAccountSeed {
  id?: string
  itemId?: string
  plaidAccountId?: string
  name?: string
  mask?: string | null
  type?: string
  subtype?: string | null
  sync?: string
  accountId?: string | null
  syncFrom?: string | null
  balanceCents?: number | null
}

/** Inserts one bank_accounts row (default: an unmapped depository account on the default Item). */
export function seedBankAccount(db: FakeBudgetDb, o: BankAccountSeed = {}): string {
  const id = o.id ?? 'b000000000000c001'
  db.sqlite.prepare(
    `INSERT INTO bank_accounts (id, item_id, plaid_account_id, name, mask, type, subtype, sync, account_id, sync_from, balance_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, o.itemId ?? 'i000000000000a001', o.plaidAccountId ?? `${SECRETS.plaidAccount}-${id}`, o.name ?? 'Everyday Checking',
    o.mask === undefined ? '0042' : o.mask, o.type ?? 'depository', o.subtype === undefined ? 'checking' : o.subtype,
    o.sync ?? 'unmapped', o.accountId ?? null, o.syncFrom ?? null, o.balanceCents ?? null, T0, T0,
  )
  return id
}

/** Inserts one plaid_slot_log row. */
export function seedSlot(db: FakeBudgetDb, status: 'pending' | 'done' | 'failed' | 'prior', environment: 'production' | 'sandbox' = 'production'): void {
  db.sqlite.prepare(`INSERT INTO plaid_slot_log (environment, status, created_at, created_by) VALUES (?, ?, ?, 'test@example.com')`).run(environment, status, T0)
}

/** Inserts the bank_txns mapping of one Budget row (the row must exist). */
export function seedBankTxn(db: FakeBudgetDb, o: { plaidTxnId: string; txnId: string; bankAccountId?: string; role?: string; state?: string }): void {
  db.sqlite.prepare(
    `INSERT INTO bank_txns (plaid_txn_id, bank_account_id, txn_id, role, state, seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.plaidTxnId, o.bankAccountId ?? 'b000000000000c001', o.txnId, o.role ?? 'inserted', o.state ?? 'live', T0, T0)
}
