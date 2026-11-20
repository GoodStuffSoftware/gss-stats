// Read client for the Budget section: GET /api/budget/* and the one manual-balance PUT
// (docs/adr/0007-budget-section.md). The server is the only access check (every route answers
// 401/403 to anyone not allowed); this module only reports what it said.
//
//   - probeAccess() asks GET /api/budget/access ONCE per page load (the answer is memoized: no retry,
//     no poll) and is shared by the nav link and the section. Nothing else in the section fetches until
//     it has said 'ok'.
//   - A 401 on any call raises the site's existing sign-in banner (session.ts checkSessionExpired).
//   - Edit controls do not follow the site's view-only flag; `access.state === 'ok'` is what makes the
//     section editable (a listed viewer has full Budget rights; the server still checks every write).
import { checkSessionExpired } from '../../session'
import type {
  AccessResponse, ApiError, BudgetErrorCode, DebtDetail, DebtsResponse, ManualBalance, MetaResponse, PersonFilter,
  SummaryQuery, SummaryResponse,
} from './types'

export class BudgetApiError extends Error {
  readonly status: number
  readonly code: BudgetErrorCode | null
  constructor(status: number, code: BudgetErrorCode | null, message?: string) {
    super(message || `budget ${status}${code ? `: ${code}` : ''}`)
    this.name = 'BudgetApiError'
    this.status = status
    this.code = code
  }
}

export type AccessResult =
  | { state: 'ok'; email: string }
  | { state: 'denied' } // 403: not on the Budget list
  | { state: 'expired' } // 401: the sign-in session lapsed (the site banner is raised)
  | { state: 'error' } // network failure, 5xx, unreadable answer: treated as "no access" (never retried here)

let probe: Promise<AccessResult> | null = null

/** GET /api/budget/access, once per page load. Never throws. */
export function probeAccess(): Promise<AccessResult> {
  if (!probe) probe = runProbe()
  return probe
}
/** Forget the memoized answer (tests, and the section's user-initiated "Retry"). */
export function resetAccessProbe(): void {
  probe = null
}
async function runProbe(): Promise<AccessResult> {
  try {
    const res = await fetch('/api/budget/access', { cache: 'no-store' })
    if (res.status === 401) {
      void checkSessionExpired()
      return { state: 'expired' }
    }
    if (res.status === 403) return { state: 'denied' }
    if (!res.ok) return { state: 'error' }
    const body = (await res.json()) as Partial<AccessResponse>
    return body?.ok === true ? { state: 'ok', email: typeof body.email === 'string' ? body.email : '' } : { state: 'error' }
  } catch {
    return { state: 'error' }
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: 'no-store', ...init })
  if (res.status === 401) void checkSessionExpired()
  if (!res.ok) {
    let err: Partial<ApiError> = {}
    try {
      err = (await res.json()) as Partial<ApiError>
    } catch {
      // no JSON body
    }
    throw new BudgetApiError(res.status, err.error ?? null, err.message)
  }
  return (await res.json()) as T
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export function fetchMeta(): Promise<MetaResponse> {
  return request<MetaResponse>('/api/budget/meta')
}

export function fetchSummary(q: SummaryQuery): Promise<SummaryResponse> {
  return request<SummaryResponse>(
    `/api/budget/summary${qs({ from: q.from, to: q.to, person: q.person, category: q.category, merchant: q.merchant, account: q.account, groupBy: q.groupBy })}`,
  )
}

export function fetchDebts(person: PersonFilter): Promise<DebtsResponse> {
  return request<DebtsResponse>(`/api/budget/debts${qs({ person })}`)
}

export function fetchDebtDetail(accountId: string): Promise<DebtDetail> {
  return request<DebtDetail>(`/api/budget/debts/${encodeURIComponent(accountId)}`)
}

/** PUT /api/budget/debts/:id/balance (a typed balance for a payment-only debt, or an override). */
export async function putManualBalance(accountId: string, body: ManualBalance): Promise<void> {
  await request<{ ok: true }>(`/api/budget/debts/${encodeURIComponent(accountId)}/balance`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
