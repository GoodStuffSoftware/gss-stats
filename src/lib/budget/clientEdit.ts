// Browser calls behind the Budget table (docs/adr/0007-budget-section.md): a page of transactions, the
// PATCH of one row, a new category, and the rule made from an edit. Every route answers JSON; an error body is
// { error, message?, current? }. A failure is thrown as BudgetApiError, whose message reads "budget <status>: ..."
// so the app's 401 handling (session.ts isAuthError) recognises it. A 401 or a network failure runs the
// confirming session probe (the same one src/api.ts runs) before the error is rethrown.
import { checkSessionExpired, isAuthError, isNetworkError } from '../../session'
import type { ApiError, BudgetErrorCode, CategoryCreateRequest, CategoryCreateResponse, RuleFromEdit, RuleResponse, SimilarApply, SimilarApplyResponse, SimilarResponse, Txn, TxnPage, TxnPatch, TxnPatchResponse, TxnQuery } from './types'

export class BudgetApiError extends Error {
  readonly status: number
  readonly code: BudgetErrorCode | null
  /** The row as the server has it now (409 only). */
  readonly current: Txn | null
  constructor(status: number, code: BudgetErrorCode | null, message: string, current: Txn | null = null) {
    super(`budget ${status}: ${message}`)
    this.name = 'BudgetApiError'
    this.status = status
    this.code = code
    this.current = current
  }
}

/** TxnQuery as a query string. Only values that are set go in; `review` is sent as `review=1`. */
export function txnQueryString(q: TxnQuery): string {
  const p = new URLSearchParams()
  p.set('from', q.from)
  p.set('to', q.to)
  p.set('person', q.person)
  p.set('scope', q.scope)
  if (q.category) p.set('category', q.category)
  if (q.merchant) p.set('merchant', q.merchant)
  if (q.account) p.set('account', q.account)
  if (q.review) p.set('review', '1')
  if (q.cursor) p.set('cursor', q.cursor)
  if (q.limit) p.set('limit', String(q.limit))
  return p.toString()
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const res = await fetch(`/api/budget${path}`, {
      cache: 'no-store',
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as Partial<ApiError> | null
      throw new BudgetApiError(res.status, body?.error ?? null, body?.message ?? body?.error ?? res.statusText, body?.current ?? null)
    }
    return (await res.json()) as T
  } catch (e) {
    if (isNetworkError(e) || isAuthError(e)) await checkSessionExpired()
    throw e
  }
}

export function fetchTxnPage(q: TxnQuery): Promise<TxnPage> {
  return call<TxnPage>(`/transactions?${txnQueryString(q)}`)
}

export function patchTxn(id: string, patch: TxnPatch): Promise<TxnPatchResponse> {
  return call<TxnPatchResponse>(`/transactions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

/** POST /categories: make a category (or get the one of that name, any letter case: `created` is false). */
export function createCategory(name: string): Promise<CategoryCreateResponse> {
  return call<CategoryCreateResponse>('/categories', { method: 'POST', body: JSON.stringify({ name } satisfies CategoryCreateRequest) })
}

export function createRule(req: RuleFromEdit): Promise<RuleResponse> {
  return call<RuleResponse>('/rules', { method: 'POST', body: JSON.stringify(req) })
}

/** GET /transactions/similar: only the opaque id goes in the URL (never a merchant, category or search text). */
export function fetchSimilar(id: string): Promise<SimilarResponse> {
  return call<SimilarResponse>(`/transactions/similar?id=${encodeURIComponent(id)}`)
}

export function applySimilar(req: SimilarApply): Promise<SimilarApplyResponse> {
  return call<SimilarApplyResponse>('/transactions/similar', { method: 'POST', body: JSON.stringify(req) })
}
