// D1 reads and writes for link and exchange (plan sections 2.1 and 3.3), plus the access-token seal (section 5).
// The plaintext token exists only inside a request; D1 gets ciphertext, iv and key_id. AAD = bank_items.id.
import { maskDigits } from '../../../src/lib/budget/mask'
import { decryptToken, encryptToken, type EncryptedToken } from '../../receipts/src/tokenCrypto'
import { readSecret, type Env } from './env'
import { log } from './log'

export const LIVE_STATUSES = ['active', 'needs_reconnect', 'pending_disconnect'] as const

export interface ItemRow {
  id: string
  owner_email: string
  environment: string
  status: string
  token_ct: string | null
  token_iv: string | null
  key_id: string | null
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** A fresh row id: one prefix letter plus 16 hex (matches the 0005 id CHECKs: 'i' items, 'b' accounts). */
export const newId = (prefix: 'i' | 'b'): string => prefix + hex(crypto.getRandomValues(new Uint8Array(8)))

/** First 16 hex of sha256(email): Plaid's client_user_id, never the email itself. */
export async function clientUserId(email: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))
  return hex(new Uint8Array(d)).slice(0, 16)
}

/** Digits in a name are masked (runs of 5+ become a bullet plus the last four); capped to 80; null if empty. */
export function maskName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = maskDigits(v.replace(/\s+/g, ' ').trim()).slice(0, 80)
  return s === '' ? null : s
}

/** The mask only when it is exactly 4 digits. */
export const maskOnly4 = (v: unknown): string | null => (typeof v === 'string' && /^[0-9]{4}$/.test(v) ? v : null)

export async function getItem(db: D1Database, id: string): Promise<ItemRow | null> {
  return db
    .prepare('SELECT id, owner_email, environment, status, token_ct, token_iv, key_id FROM bank_items WHERE id = ?1')
    .bind(id)
    .first<ItemRow>()
}

export interface Keys {
  current: string
  old: string | null
}

/** The banks token keys, or null when the current one is missing. */
export async function readKeys(env: Env): Promise<Keys | null> {
  const current = await readSecret(env.BANKS_TOKEN_KEY)
  if (current === '') return null
  const old = await readSecret(env.BANKS_TOKEN_KEY_OLD)
  return { current, old: old === '' ? null : old }
}

export const sealToken = (token: string, itemId: string, keys: Keys): Promise<EncryptedToken> =>
  encryptToken(token, itemId, keys.current)

/** Decrypt an item's stored token; throws TokenCryptoError('decrypt_failed') on any wrong key, AAD or tampering. */
export async function openToken(item: ItemRow, keys: Keys): Promise<string> {
  if (!item.token_ct || !item.token_iv || !item.key_id) throw new Error('no_token')
  const r = await decryptToken({ token_ct: item.token_ct, token_iv: item.token_iv, key_id: item.key_id }, item.id, keys)
  return r.plaintext
}

/**
 * openToken for the cron: when the stored token opened only with the OLD key, seal it again with the current key in
 * the same run (leg 5's open item), so a rotation finishes on its own. The write is keyed on the old key_id, so a
 * concurrent re-seal is never overwritten; a failed re-seal is logged and the plaintext is still returned.
 */
export async function openAndRefreshToken(db: D1Database, item: ItemRow, keys: Keys): Promise<string> {
  if (!item.token_ct || !item.token_iv || !item.key_id) throw new Error('no_token')
  const r = await decryptToken({ token_ct: item.token_ct, token_iv: item.token_iv, key_id: item.key_id }, item.id, keys)
  if (r.usedOldKey) {
    try {
      const enc = await sealToken(r.plaintext, item.id, keys)
      await db
        .prepare('UPDATE bank_items SET token_ct = ?2, token_iv = ?3, key_id = ?4 WHERE id = ?1 AND key_id = ?5')
        .bind(item.id, enc.token_ct, enc.token_iv, enc.key_id, item.key_id)
        .run()
      log('token_resealed')
    } catch {
      log('token_reseal_failed')
    }
  }
  return r.plaintext
}

export interface AccountKey {
  mask: string
  name: string
}

/** True when a live item of the same institution already holds an account with the same mask and masked name. */
export async function findDuplicate(db: D1Database, env: string, institutionId: string, wanted: AccountKey[]): Promise<boolean> {
  const keyed = wanted.filter((a) => a.mask && a.name)
  if (keyed.length === 0) return false
  const res = await db
    .prepare(
      `SELECT a.mask AS mask, a.name AS name
         FROM bank_items i JOIN bank_accounts a ON a.item_id = i.id
        WHERE i.status IN ('active','needs_reconnect','pending_disconnect')
          AND i.environment = ?1 AND i.institution_id = ?2 AND a.mask IS NOT NULL`,
    )
    .bind(env, institutionId)
    .all<{ mask: string; name: string }>()
  const have = new Set((res.results ?? []).map((r) => `${r.mask}\u0000${r.name}`))
  return keyed.some((a) => have.has(`${a.mask}\u0000${a.name}`))
}

export interface NewAccount {
  plaidAccountId: string
  name: string
  mask: string | null
  type: 'depository' | 'credit' | 'loan' | 'investment' | 'other'
  subtype: string | null
  balanceCents: number | null
  availableCents: number | null
  limitCents: number | null
}

export interface NewItem {
  id: string
  ownerEmail: string
  environment: 'production' | 'sandbox'
  plaidItemId: string
  institutionId: string | null
  institutionName: string | null
  consentVersion: number
  enc: EncryptedToken
  /** Stored with new_accounts = 1 so /accounts-refresh fills in the accounts later (the first /accounts/get failed). */
  newAccounts?: boolean
}

/** The statements that store one new item and its accounts (run in one batch with the slot update). */
export function newItemStatements(db: D1Database, item: NewItem, accounts: NewAccount[], asOf: string): D1PreparedStatement[] {
  const stmts = [
    db
      .prepare(
        `INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, institution_id, institution_name, status,
           token_ct, token_iv, key_id, consent_version, consented_at, created_at, updated_at, new_accounts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?9, ?10, ?11, ?11, ?11, ?12)`,
      )
      .bind(
        item.id, item.ownerEmail, item.environment, item.plaidItemId, item.institutionId, item.institutionName,
        item.enc.token_ct, item.enc.token_iv, item.enc.key_id, item.consentVersion, asOf, item.newAccounts ? 1 : 0,
      ),
  ]
  for (const a of accounts) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO bank_accounts (id, item_id, plaid_account_id, name, mask, type, subtype, sync,
             balance_cents, available_cents, limit_cents, balance_as_of, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'unmapped', ?8, ?9, ?10, ?11, ?11, ?11)`,
        )
        .bind(newId('b'), item.id, a.plaidAccountId, a.name, a.mask, a.type, a.subtype, a.balanceCents, a.availableCents, a.limitCents, asOf),
    )
  }
  return stmts
}
