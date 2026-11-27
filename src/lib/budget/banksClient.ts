// Browser calls behind the Budget Banks page (bank-links plan sections 3.1 and 6): status, link token, exchange, the
// per-account feed switch, Sync now, reconnected, new accounts, unlink and the dropped-row choices. Every route answers
// JSON; an error body is { error }. A failure is thrown as BanksApiError, whose `message` is short plain English
// (banksMessage) and whose `status` / `code` carry the raw answer. Paths carry opaque ids only; nothing here puts a
// bank name, amount or description in a URL, and nothing is logged. Mirrors receiptsClient.ts.
import { checkSessionExpired, isAuthError, isNetworkError } from '../../session'
import { BANKS_CONSENT_VERSION, type BanksStatus } from './types'

/** Plain-English text for every fixed code the banks routes (plan 3.1), the Worker (3.3) and an Item's `lastError` return. */
const MESSAGES: Record<string, string> = {
  // routes and middleware
  banks_not_configured: 'Bank links are not set up here.',
  consent_required: 'Please read and accept the notice first.',
  not_owner: 'Only the person who linked this bank can do that.',
  not_found: 'That is no longer there. Reload and try again.',
  item_not_found: 'That bank link is no longer there. Reload and try again.',
  item_not_active: 'This bank link is not active right now. Reconnect it first, or reload.',
  duplicate_item: 'That bank is already linked. If it stopped working, use Reconnect on it instead.',
  slots_full: 'All 10 bank links are used. More need a paid Plaid plan.',
  store_failed: 'The bank was reached but could not be saved. Please try again in a few minutes.',
  binding_timeout: 'The bank service took too long. Please try again.',
  banks_failed: 'The bank service had a problem. Please try again in a few minutes.',
  kind_mismatch: 'That Budget account type does not fit this bank account.',
  account_taken: 'Another bank account already feeds that Budget account.',
  already_on: 'This account is already syncing. Turn it off first to change it.',
  account_synced: 'This account gets bank transactions. Stop syncing it on the Banks page first.',
  bad_request: 'That request was not accepted. Reload and try again.',
  too_large: 'That request was too large.',
  method_not_allowed: 'That request was not accepted. Reload and try again.',
  forbidden: 'Budget access is needed for bank links.',
  budget_denied: 'Budget access is needed for bank links.',
  unauthorized: 'Your sign-in expired. Sign in again.',
  server_error: 'The bank service had a problem. Please try again in a few minutes.',
  // Worker codes
  not_allowed: 'This account is not allowed to use bank links.',
  bad_signature: 'The bank service could not check that message.',
  key_unavailable: 'The bank service could not check that message. Please try again.',
  secrets_missing: 'Bank links are not fully set up on the server yet.',
  decrypt_failed: 'This bank link needs to be reconnected.',
  plaid_timeout: 'The bank did not answer in time. Please try again.',
  plaid_setup: 'Bank links need a setup fix in the Plaid dashboard. Nothing was linked.',
  plaid_api_error: 'The bank service reported a problem. Please try again in a few minutes.',
  // an Item's lastError (sync and webhook outcomes)
  item_login_required: 'The bank wants you to sign in again. Use Reconnect.',
  needs_reconnect: 'The bank wants you to sign in again. Use Reconnect.',
  too_many_pages: 'The last sync was too big to finish. It retries on its own.',
  sync_mutation: 'The bank changed its data during the last sync. It retries on its own.',
  bad_response: 'The bank sent back something unexpected. It retries on its own.',
}

/** A short plain-English message for an error or Item code; a generic line for an unknown one (a Plaid code is never shown). */
export function banksMessage(code: string | null | undefined): string {
  if (code && Object.prototype.hasOwnProperty.call(MESSAGES, code)) return MESSAGES[code]
  if (code && code.startsWith('plaid_')) return 'The bank reported a problem. It retries on its own.'
  return 'Something went wrong. Please try again.'
}

export class BanksApiError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(status: number, code: string | null) {
    super(banksMessage(code ?? (status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : null)))
    this.name = 'BanksApiError'
    this.status = status
    this.code = code
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const res = await fetch(`/api/budget/banks${path}`, {
      cache: 'no-store',
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new BanksApiError(res.status, typeof body?.error === 'string' ? body.error : null)
    }
    return (await res.json()) as T
  } catch (e) {
    if (isNetworkError(e) || isAuthError(e) || (e instanceof BanksApiError && e.status === 401)) await checkSessionExpired()
    throw e
  }
}

const post = (body?: unknown): RequestInit => ({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const id = (s: string): string => encodeURIComponent(s)

export function fetchBanksStatus(): Promise<BanksStatus> {
  return call<BanksStatus>('/status')
}

/** A Plaid Link token. New link: no options. Update mode (Reconnect): `itemId`; add `accountSelection` for "Share new accounts". */
export function createLinkToken(opts: { itemId?: string; accountSelection?: boolean } = {}): Promise<{ linkToken: string; expiration: string }> {
  return call('/link-token', post({ consent: BANKS_CONSENT_VERSION, ...(opts.itemId ? { itemId: opts.itemId } : {}), ...(opts.accountSelection ? { accountSelection: true } : {}) }))
}

export interface LinkAccount { id: string; name: string; mask: string | null; type: string; subtype: string | null }
export interface LinkResult { publicToken: string; institution: { id: string; name: string }; accounts: LinkAccount[] }

/** Hands Link's public token to the server (it exchanges it; the browser never holds an access token). */
export function exchangeLink(r: LinkResult): Promise<{ itemId: string }> {
  return call('/exchange', post({ consent: BANKS_CONSENT_VERSION, publicToken: r.publicToken, institution: r.institution, accounts: r.accounts }))
}

export interface SetAccountBody {
  sync: 'on' | 'off'
  accountId?: string
  newAccount?: { name: string; kind: string; personId?: string | null }
}
export function setBankAccount(bankAccountId: string, body: SetAccountBody): Promise<{ ok: true; accountId?: string; created?: boolean; syncFrom?: string | null }> {
  return call(`/accounts/${id(bankAccountId)}`, { method: 'PATCH', body: JSON.stringify(body) })
}

/** "Sync now": queues a sync (the cron picks it up within 10 minutes). */
export function requestSync(itemId: string): Promise<{ ok: true }> {
  return call(`/items/${id(itemId)}/sync`, post())
}
/** After an update-mode Link succeeds: the Item is active again. */
export function markReconnected(itemId: string): Promise<{ ok: true }> {
  return call(`/items/${id(itemId)}/reconnected`, post())
}
/** After Link with account selection: reads the Item's accounts again (answer: how many were added). */
export function refreshAccounts(itemId: string): Promise<{ added: number }> {
  return call(`/items/${id(itemId)}/accounts-refresh`, post())
}
export function unlinkItem(itemId: string): Promise<{ ok: true }> {
  return call(`/items/${id(itemId)}/unlink`, post({ confirm: true }))
}
/** A row the bank removed that you had edited: delete it or keep it. */
export function resolveDropped(txnId: string, action: 'delete' | 'keep'): Promise<{ ok: true }> {
  return call(`/dropped/${id(txnId)}`, post({ action }))
}
