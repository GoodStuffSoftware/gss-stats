// The Plaid API client. Every call goes through the injected fetch (tests stub it). Credentials are added to the
// request body here and nowhere else; no body, header or message text is kept or logged: a failure is a PlaidError
// carrying only Plaid's error_type and error_code (plan sections 1 and 5).
import { readSecret, type Env } from './env'

export const PLAID_BASE: Readonly<Record<string, string>> = {
  production: 'https://production.plaid.com',
  sandbox: 'https://sandbox.plaid.com',
}
export const PLAID_TIMEOUT_MS = 15_000

/** A Plaid error answer. `type` and `code` are Plaid's upper-case error_type / error_code, or a local fixed value. */
export class PlaidError extends Error {
  readonly type: string
  readonly code: string
  readonly status: number
  /** True only when Plaid answered with a JSON error body (so the request was refused, nothing created). Non-JSON or local errors: false. */
  readonly refused: boolean
  constructor(type: string, code: string, status = 0, refused = false) {
    super(`plaid_${type.toLowerCase()}`) // fixed text only, never Plaid's message
    this.name = 'PlaidError'
    this.type = type
    this.code = code
    this.status = status
    this.refused = refused
  }
}

/** The request did not finish within PLAID_TIMEOUT_MS. The outcome at Plaid is unknown. */
export class PlaidTimeoutError extends Error {
  constructor() {
    super('plaid_timeout')
    this.name = 'PlaidTimeoutError'
  }
}

export interface PlaidDeps {
  env: Env
  fetch: typeof fetch
  now: () => Date
}

export interface PlaidClient {
  readonly baseUrl: string
  post<T = Record<string, unknown>>(path: string, body?: Record<string, unknown>): Promise<T>
}

const UPPER = /^[A-Z][A-Z0-9_]{0,63}$/
const cleanCode = (v: unknown, dflt: string): string => (typeof v === 'string' && UPPER.test(v) ? v : dflt)

export function createPlaidClient(deps: PlaidDeps): PlaidClient {
  const { env } = deps
  const baseUrl = PLAID_BASE[env.PLAID_ENV ?? ''] ?? ''
  const doFetch = deps.fetch

  async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    if (!baseUrl) throw new PlaidError('CONFIG', 'PLAID_ENV_INVALID')
    const [clientId, secret] = await Promise.all([readSecret(env.PLAID_CLIENT_ID), readSecret(env.PLAID_SECRET)])
    if (!clientId || !secret) throw new PlaidError('CONFIG', 'PLAID_SECRETS_MISSING')

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, PLAID_TIMEOUT_MS)
    try {
      let res: Response
      try {
        res = await doFetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, client_id: clientId, secret }),
          signal: controller.signal,
        })
      } catch {
        throw timedOut ? new PlaidTimeoutError() : new PlaidError('NETWORK', 'FETCH_FAILED')
      }
      let json: unknown
      try {
        json = await res.json()
      } catch {
        if (timedOut) throw new PlaidTimeoutError()
        if (res.ok) throw new PlaidError('API_ERROR', 'BAD_RESPONSE', res.status)
        throw new PlaidError('API_ERROR', 'UNKNOWN', res.status)
      }
      if (!res.ok) {
        const e = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
        throw new PlaidError(cleanCode(e.error_type, 'API_ERROR'), cleanCode(e.error_code, 'UNKNOWN'), res.status, json !== null && typeof json === 'object')
      }
      return json as T
    } finally {
      clearTimeout(timer)
    }
  }

  return { baseUrl, post }
}
