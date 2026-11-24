// Browser calls behind the Budget Receipts page (plan section 4): connection status, connect, check now,
// disconnect, the review list, dismiss, apply and the per-row receipt links. Every route answers JSON; an error body
// is { error, retryAfterSec? }. A failure is thrown as ReceiptsApiError, whose `message` is short plain English
// (receiptsMessage) and whose `status` / `code` carry the raw answer. Nothing here puts an address, amount,
// merchant or Gmail id in a URL: paths carry opaque ids, a status word and a cursor only.
import { checkSessionExpired, isAuthError, isNetworkError } from '../../session'

/** The consent text version the connect call sends (the server refuses any other). */
export const CONSENT_VERSION = 1

export interface ReceiptsConnection {
  status: string
  lastRunAt: string | null
  lastOkAt: string | null
  lastError: string | null
  consentVersion: number
  /** The connected Gmail address; the server sends it to the person who connected only, and null when it has none. */
  googleEmail?: string | null
}
export interface ReceiptsRun {
  trigger: string
  startedAt: string
  finishedAt: string | null
  listed: number
  fetched: number
  extracted: number
  skipped: number
  matched: number
  autoApplied: number
  errorCode: string | null
}
export interface ReceiptsStatus {
  configured: boolean
  connection: ReceiptsConnection | null
  lastRuns: ReceiptsRun[]
  nextRunAt: string | null
}
export interface ReceiptMatchTxn {
  postedDate: string
  amountCents: number
  merchantName: string | null
  accountLabel: string | null
  categoryId: string | null
  categorySource: string | null
  needsReview: boolean
  updatedAt: string
}
export interface ReceiptMatch {
  /** The server's numeric match id (apply and reject take it as a number). */
  matchId: number
  txnId: string
  /** Matches of one split (several charges of one receipt, or several receipts of one charge) share a key. */
  groupKey: string | null
  rule: string
  shareCents: number | null
  score: number
  status: string
  proposedCategoryId: string | null
  linkedOther: boolean
  categoryProtectedBy: string | null
  txn: ReceiptMatchTxn
}
export interface ReceiptItem {
  seq: number
  description: string
  amountCents: number | null
  quantity: number | null
  categoryHint: string | null
}
export interface ReceiptRow {
  id: string
  emailDate: string | null
  status: string
  kind: string
  merchant: string | null
  paymentVia: string | null
  cardLast4: string | null
  orderRef: string | null
  receiptDate: string | null
  relatedDate: string | null
  currency: string | null
  totalCents: number | null
  taxCents: number | null
  shippingCents: number | null
  /** Sent by the server so a receipt can be opened in Gmail; the review list never shows it as text. */
  gmailMsgId?: string
  items: ReceiptItem[]
  matches: ReceiptMatch[]
}
export interface ReceiptsPage {
  receipts: ReceiptRow[]
  nextCursor: string | null
}
export interface ApplyItem {
  matchId: number
  expectedUpdatedAt: string
  categoryId?: string | null
}
/** Why a linked row kept its category: set by hand ('manual') or by a person's edit ('person_edit'); null when nothing was kept. */
export type CategoryKept = 'manual' | 'person_edit' | null
export type SkipReason = 'not_found' | 'not_suggested' | 'stale' | 'txn_linked' | 'incomplete_group' | 'group_blocked' | 'conflict'
export interface ApplyResponse {
  applied: { matchId: number; txnId: string; categorySet: boolean; categoryKept: CategoryKept; updatedAt: string }[]
  rejected: number[]
  skipped: { matchId: number; reason: SkipReason | string; currentUpdatedAt?: string }[]
}
export interface ReceiptLinkItem {
  description: string
  quantity: number | null
  amountCents: number | null
  categoryId: string | null
  category: string | null
}
export interface ReceiptLink {
  merchant: string | null
  date: string | null
  totalCents: number | null
  taxCents: number | null
  currency: string | null
  orderRef: string | null
  cardLast4: string | null
  items: ReceiptLinkItem[]
  gmailMsgId?: string
}
export type ReceiptsListStatus = 'suggested' | 'unmatched' | 'applied'

/** Plain-English text for every fixed code the receipts routes, the connect callback and the sync runs return. */
const MESSAGES: Record<string, string> = {
  // connect callback (?email=<code>)
  connected: 'Gmail connected. Receipts will be read from now on.',
  denied: 'Gmail was not connected: access was declined on the Google screen.',
  google_error: 'Google reported a problem. Please try connecting again.',
  state_invalid: 'The connect step expired or did not match. Please start again.',
  state_used: 'That connect link was already used. Please start again.',
  not_configured: 'Receipts are not set up yet.',
  invalid_grant: 'Google did not accept the sign-in. Please try connecting again.',
  scope_missing: 'Read-only Gmail access was not granted. Please connect again and allow it.',
  no_refresh_token: 'Google did not give lasting access. Remove this app from your Google account access list, then connect again.',
  token_invalid: 'Google sent back a sign-in that could not be checked. Please try again.',
  not_allowed: 'This Google account is not allowed to connect.',
  exchange_failed: 'The connection could not be finished. Please try again.',
  // route errors
  receipts_not_configured: 'Receipts are not set up yet.',
  consent_required: 'Please read and accept the notice first.',
  receipts_unavailable: 'Receipts are not available right now. Please try again later.',
  receipts_failed: 'The receipt check could not start. Please try again in a few minutes.',
  worker_failed: 'The receipt check could not start. Please try again in a few minutes.',
  rate_limited: 'A check just ran. Please wait a few minutes before checking again.',
  not_connected: 'Gmail is not connected.',
  reconnect_needed: 'Gmail needs to be reconnected first.',
  paused: 'Receipts are paused.',
  // run / connection codes (the sync Worker's `lastError` and a run's `errorCode`)
  needs_reconnect: 'Gmail needs to be reconnected.',
  decrypt_failed: 'Gmail needs to be reconnected.',
  key_invalid: 'Gmail needs to be reconnected.',
  api_rejected: 'Receipts paused: the API rejected the request',
  auth_failed: 'Receipts paused: the API rejected the request',
  api_limited: 'Receipts paused: API limit reached, retrying next hour',
  api_unavailable: 'Receipts paused: the reading service is unavailable, retrying next hour',
  stop_run: 'Receipts paused: the reading service is unavailable, retrying next hour',
  daily_cap: 'Receipts paused: the daily reading limit was reached, resuming tomorrow',
  secrets_missing: 'Receipts are not fully set up on the server, so no check can run yet.',
  not_active: 'No check ran: receipts are paused or Gmail is not connected.',
  match_failed: 'Receipts were read, but matching them to bank rows failed. Retrying next hour.',
  run_failed: 'The last check failed. Retrying next hour.',
  run_invalid: 'The last check failed. Retrying next hour.',
  run_busy: 'A check is already running.',
  network_error: 'Gmail could not be reached. Retrying next hour.',
  client_error: 'Gmail refused a request, which points to a setup problem. Retrying next hour.',
  bad_response: 'Gmail sent back something unexpected. Retrying next hour.',
  extract_invalid: 'One receipt could not be read.',
  // sync route errors
  too_large: 'That request was too large.',
  method_not_allowed: 'That request was not accepted. Reload and try again.',
  server_error: 'The receipt service had a problem. Please try again in a few minutes.',
  unauthorized: 'Your sign-in expired. Sign in again.',
  // generic
  bad_state: 'That receipt cannot be changed that way.',
  conflict: 'A receipt was linked to one of these rows meanwhile. Reload and try again.',
  bad_request: 'That request was not accepted. Reload and try again.',
  not_found: 'That receipt is no longer there.',
  stale: 'That row changed meanwhile. Reload and try again.',
  forbidden: 'Budget access is needed for receipts.',
}

/** A short plain-English message for an error or run code; a generic line for an unknown one. */
export function receiptsMessage(code: string | null | undefined): string {
  if (code && Object.prototype.hasOwnProperty.call(MESSAGES, code)) return MESSAGES[code]
  return 'Something went wrong. Please try again.'
}

/** Run codes that mean the Gmail connection must be made again (the Reconnect button shows for these). */
export const RECONNECT_CODES: ReadonlySet<string> = new Set(['needs_reconnect', 'decrypt_failed', 'key_invalid'])

/**
 * Plain words for a code that came from a run or the connection (`lastError`, a run's `errorCode`). Two codes read
 * differently there than as a route or connect answer: `not_allowed` (the mailbox left the allow list) and `rate_limited`
 * (Gmail's own limit).
 */
export function receiptsRunMessage(code: string | null | undefined): string {
  if (code === 'not_allowed') return 'Receipts paused: this Google account is no longer allowed to use receipts.'
  if (code === 'rate_limited') return 'Gmail asked us to slow down. Retrying next hour.'
  return receiptsMessage(code)
}

export class ReceiptsApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly retryAfterSec: number | null
  constructor(status: number, code: string | null, retryAfterSec: number | null = null) {
    super(receiptsMessage(code ?? (status === 403 ? 'forbidden' : status === 404 ? 'not_found' : null)))
    this.name = 'ReceiptsApiError'
    this.status = status
    this.code = code
    this.retryAfterSec = retryAfterSec
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const res = await fetch(`/api/budget/email${path}`, {
      cache: 'no-store',
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; retryAfterSec?: number } | null
      throw new ReceiptsApiError(res.status, typeof body?.error === 'string' ? body.error : null, typeof body?.retryAfterSec === 'number' ? body.retryAfterSec : null)
    }
    return (await res.json()) as T
  } catch (e) {
    if (isNetworkError(e) || isAuthError(e) || (e instanceof ReceiptsApiError && e.status === 401)) await checkSessionExpired()
    throw e
  }
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) }) satisfies RequestInit

export function fetchReceiptsStatus(): Promise<ReceiptsStatus> {
  return call<ReceiptsStatus>('/status')
}

/** Starts the Google consent step; the caller sends the browser to the returned `url`. */
export function startReceiptsConnect(): Promise<{ url: string }> {
  return call<{ url: string }>('/connect', post({ consent: CONSENT_VERSION }))
}

/** "Check now". 429 `rate_limited` (retryAfterSec), 503 `receipts_unavailable`, 502 `receipts_failed`. */
export function syncReceiptsNow(): Promise<{ ok: true }> {
  return call<{ ok: true }>('/sync', { method: 'POST' })
}

/** Stops reading the mailbox. `purge: false` keeps the extracted receipts, `true` deletes them. */
export function disconnectReceipts(purge = false): Promise<{ ok: true; revoked: boolean; purged: boolean }> {
  return call('/disconnect', post({ purge }))
}

/** One page of the review list (stage 13). `cursor` is the opaque `nextCursor` of the page before. */
export function fetchReceipts(opts: { status?: ReceiptsListStatus; cursor?: string | null } = {}): Promise<ReceiptsPage> {
  const p = new URLSearchParams()
  if (opts.status) p.set('status', opts.status)
  if (opts.cursor) p.set('cursor', opts.cursor)
  const q = p.toString()
  return call<ReceiptsPage>(`/receipts${q ? `?${q}` : ''}`)
}

/** Dismiss (`true`) or restore (`false`) one receipt. `id` is the opaque receipt id. */
export function dismissReceipt(id: string, dismissed = true): Promise<{ id: string; status: string }> {
  return call(`/receipts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ dismissed }) })
}

/** Apply up to 50 chosen matches and/or reject others, in one batch. */
export function applyReceipts(items: ApplyItem[], reject: number[] = []): Promise<ApplyResponse> {
  return call<ApplyResponse>('/apply', post({ items, ...(reject.length ? { reject } : {}) }))
}

/** The applied receipt for each of up to 200 visible transaction ids: `{ [txnId]: ReceiptLink }`. */
export async function fetchReceiptLinks(txnIds: string[]): Promise<Record<string, ReceiptLink>> {
  const r = await call<{ links: Record<string, ReceiptLink> }>('/links', post({ txnIds }))
  return r.links
}
