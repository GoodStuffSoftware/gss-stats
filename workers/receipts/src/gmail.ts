// Gmail REST client for the receipts Worker: fetch only, no SDK, scope gmail.readonly only (plan: sections 2, 5, 9).
// Read-only by construction: the only Gmail calls are GET users/me/messages (list) and GET users/me/messages/{id},
// and the only other call is the OAuth token refresh. There is no modify, send, label or trash method.
// Errors are fixed codes: never a token, address, subject or message content (the response body is never copied
// into an error). Logging is the caller's job and takes the code only.
import type { GmailPart } from './bodyText'

export type GmailErrorCode =
  | 'needs_reconnect' // invalid_grant, or a 401 that survived one refresh, or a missing scope
  | 'rate_limited' // 429 or a Gmail rate-limit 403: stop this run, retry next run
  | 'server_error' // 5xx: stop this run, retry next run
  | 'network_error' // fetch threw: stop this run, retry next run
  | 'client_error' // any other 4xx (bad request, invalid_client): a config problem, not a retry
  | 'bad_response' // 2xx with a body that is not what the API documents

/** Codes after which the run stops and the next hourly run tries again. */
export const RETRY_NEXT_RUN: ReadonlySet<GmailErrorCode> = new Set(['rate_limited', 'server_error', 'network_error'])

export class GmailError extends Error {
  readonly code: GmailErrorCode
  constructor(code: GmailErrorCode) {
    super(code)
    this.name = 'GmailError'
    this.code = code
  }
}

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'
const HEX_ID = /^[0-9a-f]{8,32}$/

export interface GmailMessage {
  /** Gmail's opaque hex message id (re-checked here). */
  id: string
  /** Gmail's receive time, epoch milliseconds. */
  internalDateMs: number
  /** The MIME tree, as returned (format=full), for bodyText. Headers are not read by this client. */
  payload: GmailPart
}

export interface ListResult {
  ids: string[]
  /** True when more pages exist beyond maxPages. */
  more: boolean
  /** Ids Gmail returned that failed the hex/length check: skipped, counted, never used. */
  skipped: number
}

export interface GmailClientOptions {
  clientId: string
  clientSecret: string
  refreshToken: string
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch
}

export interface GmailClient {
  /** Exchange the refresh token for an access token (cached in memory for this client only). */
  refreshAccessToken(): Promise<void>
  /** messages.list, newest first, at most `maxPages` pages of `pageSize` ids. */
  listMessageIds(query: string, opts?: { pageSize?: number; maxPages?: number }): Promise<ListResult>
  /** messages.get with format=full. */
  getMessage(id: string): Promise<GmailMessage>
}

function classify(status: number): GmailErrorCode {
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'client_error'
}

export function createGmailClient(opts: GmailClientOptions): GmailClient {
  const doFetch = opts.fetch ?? fetch
  let accessToken: string | null = null

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, init)
    } catch {
      throw new GmailError('network_error')
    }
  }

  async function refreshAccessToken(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
    })
    const res = await send(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        let err: unknown = null
        try {
          err = ((await res.json()) as { error?: unknown }).error
        } catch {
          /* unreadable body: treated as a plain client error below */
        }
        if (err === 'invalid_grant') throw new GmailError('needs_reconnect')
      }
      throw new GmailError(classify(res.status))
    }
    let token: unknown
    try {
      token = ((await res.json()) as { access_token?: unknown }).access_token
    } catch {
      throw new GmailError('bad_response')
    }
    if (typeof token !== 'string' || token.length < 10 || token.length > 4096) throw new GmailError('bad_response')
    accessToken = token
  }

  /** GET a Gmail URL as JSON. 401: one refresh and one retry, then needs_reconnect. */
  async function getJson(url: string): Promise<unknown> {
    if (!accessToken) await refreshAccessToken()
    for (let attempt = 0; ; attempt++) {
      const res = await send(url, { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } })
      if (res.status === 401) {
        if (attempt === 0) {
          await refreshAccessToken()
          continue
        }
        throw new GmailError('needs_reconnect')
      }
      if (!res.ok) {
        if (res.status === 403) {
          // Gmail answers rate limits with 403 and a reason; anything else on 403 is a scope or access problem.
          let reason: unknown = null
          try {
            const j = (await res.json()) as { error?: { errors?: Array<{ reason?: unknown }>; status?: unknown } }
            reason = j.error?.errors?.[0]?.reason ?? j.error?.status
          } catch {
            /* fall through */
          }
          if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'RESOURCE_EXHAUSTED') {
            throw new GmailError('rate_limited')
          }
          throw new GmailError('needs_reconnect')
        }
        throw new GmailError(classify(res.status))
      }
      try {
        return await res.json()
      } catch {
        throw new GmailError('bad_response')
      }
    }
  }

  async function listMessageIds(query: string, o: { pageSize?: number; maxPages?: number } = {}): Promise<ListResult> {
    const pageSize = Math.max(1, Math.min(o.pageSize ?? 100, 500))
    const maxPages = Math.max(1, Math.min(o.maxPages ?? 2, 10))
    const ids: string[] = []
    let skipped = 0
    let pageToken: string | null = null
    for (let page = 0; page < maxPages; page++) {
      const qs = new URLSearchParams({ q: query, maxResults: String(pageSize), includeSpamTrash: 'false' })
      if (pageToken) qs.set('pageToken', pageToken)
      const j = (await getJson(`${MESSAGES_URL}?${qs.toString()}`)) as {
        messages?: unknown
        nextPageToken?: unknown
      } | null
      if (!j || typeof j !== 'object') throw new GmailError('bad_response')
      if (j.messages !== undefined && !Array.isArray(j.messages)) throw new GmailError('bad_response')
      for (const m of (j.messages as Array<{ id?: unknown }> | undefined) ?? []) {
        if (typeof m?.id === 'string' && HEX_ID.test(m.id)) ids.push(m.id)
        else skipped++
      }
      const next = typeof j.nextPageToken === 'string' && j.nextPageToken.length > 0 && j.nextPageToken.length < 1024 ? j.nextPageToken : null
      if (!next) return { ids, more: false, skipped }
      pageToken = next
    }
    return { ids, more: true, skipped }
  }

  async function getMessage(id: string): Promise<GmailMessage> {
    if (!HEX_ID.test(id)) throw new GmailError('client_error')
    const j = (await getJson(`${MESSAGES_URL}/${id}?format=full`)) as {
      id?: unknown
      internalDate?: unknown
      payload?: unknown
    } | null
    if (!j || typeof j !== 'object' || j.id !== id) throw new GmailError('bad_response')
    const ms = Number(j.internalDate)
    if (!Number.isFinite(ms) || ms <= 0) throw new GmailError('bad_response')
    if (!j.payload || typeof j.payload !== 'object') throw new GmailError('bad_response')
    return { id, internalDateMs: ms, payload: j.payload as GmailPart }
  }

  return { refreshAccessToken, listMessageIds, getMessage }
}

// ---------- query builder ----------

export interface ReceiptQueries {
  from: string[]
  subject: string[]
  excludeFrom: string[]
}

/** Row shape of the receipt_queries table (only active rows are passed in). */
export function groupQueries(rows: Array<{ kind: string; value: string }>): ReceiptQueries {
  const q: ReceiptQueries = { from: [], subject: [], excludeFrom: [] }
  for (const r of rows) {
    if (r.kind === 'from') q.from.push(r.value)
    else if (r.kind === 'subject') q.subject.push(r.value)
    else if (r.kind === 'exclude_from') q.excludeFrom.push(r.value)
  }
  return q
}

// Values are data: anything that could change the query's structure is dropped, never escaped.
const SAFE_VALUE = /^[^\s(){}"\\\x00-\x1f\x7f][^(){}"\\\x00-\x1f\x7f]{0,99}$/
const SAFE_FROM = /^[A-Za-z0-9@._+*-]{1,100}$/

/** Gmail search string. `afterEpochSec` is the lower bound (watermark minus overlap, or now minus the backfill). */
export function buildReceiptQuery(q: ReceiptQueries, afterEpochSec: number, beforeEpochSec?: number): string {
  if (!Number.isFinite(afterEpochSec) || afterEpochSec <= 0) throw new GmailError('client_error')
  if (beforeEpochSec !== undefined && (!Number.isFinite(beforeEpochSec) || beforeEpochSec <= afterEpochSec)) throw new GmailError('client_error')
  const from = q.from.filter((v) => SAFE_FROM.test(v)).map((v) => `from:${v}`)
  const subject = q.subject.filter((v) => SAFE_VALUE.test(v)).map((v) => `"${v}"`)
  const exclude = q.excludeFrom.filter((v) => SAFE_FROM.test(v)).map((v) => `from:${v}`)
  const parts: string[] = [`after:${Math.floor(afterEpochSec)}`]
  if (beforeEpochSec !== undefined) parts.push(`before:${Math.floor(beforeEpochSec)}`)
  const matchers: string[] = []
  if (from.length) matchers.push(`{${from.join(' ')}}`)
  if (subject.length) matchers.push(`subject:(${subject.join(' OR ')})`)
  if (matchers.length === 0) throw new GmailError('client_error')
  parts.push(matchers.length > 1 ? `(${matchers.join(' OR ')})` : matchers[0])
  if (exclude.length) parts.push(`-{${exclude.join(' ')}}`)
  parts.push('-in:spam', '-in:trash', '-in:drafts')
  return parts.join(' ')
}

const DAY_S = 86_400
/** Lower bound for the `after:` term: watermark minus 2 days; on the first run, now minus the backfill days. */
export function afterBound(watermarkMs: number | null, nowMs: number, backfillDays: number): number {
  if (watermarkMs && watermarkMs > 0) return Math.floor(watermarkMs / 1000) - 2 * DAY_S
  return Math.floor(nowMs / 1000) - Math.max(1, Math.floor(backfillDays)) * DAY_S
}
