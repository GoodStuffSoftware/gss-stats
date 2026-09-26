// OPTIONAL, READ-ONLY Firestore counts for the ads routine: new prod accounts and first-50
// promo claims in a window, plus the promos/first50 status doc. Enabled only when the CLI is
// given --firebase-sa <path to an existing service-account JSON on this machine>; otherwise
// every figure reads "not read".
//
// COUNTS ONLY: sign-ups and promo claims come from Firestore COUNT aggregation queries, so no
// user document, email or uid ever enters this process. The only two endpoints this module
// can call are a GET of promos/first50 and documents:runAggregationQuery — no write, no
// commit, no batch, and nothing under users/ is ever written (grant-first50.mjs is a WRITE
// tool and is never used). Field types verified against best-sudoku origin/main 2026-09-26:
// users/{uid}.createdAt is a Firestore Timestamp; promo_first50_granted_at is an ISO string;
// promos/first50 is { cap, claimed, closed, updatedAt }.

import fs from 'node:fs'
import { createSign } from 'node:crypto'
import { redact, registerSecret } from './redact'
import type { FetchLike } from './adsApi'

export interface FirebaseCounts {
  projectId: string | null
  /** users with a Timestamp createdAt in [start, end). */
  newAccountsInWindow: number | null
  /** users with any Timestamp createdAt — sanity check that the field exists (≈ total accounts). */
  accountsWithCreatedAt: number | null
  /** users with promo_first50_granted_at (ISO string) in [start, end). */
  promoClaimsInWindow: number | null
  /** users with any promo_first50_granted_at — sanity check against promos/first50.claimed. */
  promoClaimsTotal: number | null
  first50: { cap: number | null; claimed: number | null; closed: boolean | null } | null
  errors: string[]
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

async function accessToken(sa: { client_email: string; private_key: string; token_uri?: string }, fetchImpl: FetchLike): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token'
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud, iat: now, exp: now + 3600 }),
  )}`
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key)
  const res = await fetchImpl(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }).toString(),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`service-account token exchange failed, HTTP ${res.status}`)
  const tok = JSON.parse(body).access_token
  if (!tok) throw new Error('service-account token exchange returned no access_token')
  registerSecret(tok)
  return tok
}

type Value = { timestampValue: string } | { stringValue: string }
export function countQueryBody(field: string, from: Value, to: Value | null): unknown {
  const filters: unknown[] = [{ fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN_OR_EQUAL', value: from } }]
  if (to) filters.push({ fieldFilter: { field: { fieldPath: field }, op: 'LESS_THAN', value: to } })
  return {
    structuredAggregationQuery: {
      structuredQuery: { from: [{ collectionId: 'users' }], where: filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } } },
      aggregations: [{ alias: 'n', count: {} }],
    },
  }
}

export async function readFirebaseCounts(saPath: string, windowStartMs: number, windowEndMs: number, fetchImpl?: FetchLike): Promise<FirebaseCounts> {
  const f: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init))
  const out: FirebaseCounts = {
    projectId: null,
    newAccountsInWindow: null,
    accountsWithCreatedAt: null,
    promoClaimsInWindow: null,
    promoClaimsTotal: null,
    first50: null,
    errors: [],
  }
  let sa: any
  try {
    sa = JSON.parse(fs.readFileSync(saPath, 'utf8'))
  } catch {
    out.errors.push('service-account file unreadable')
    return out
  }
  if (!sa?.private_key || !sa?.client_email || !sa?.project_id) {
    out.errors.push('service-account file is missing project_id/client_email/private_key')
    return out
  }
  registerSecret(sa.private_key)
  out.projectId = String(sa.project_id)
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(out.projectId)}/databases/(default)/documents`
  let token: string
  try {
    token = await accessToken(sa, f)
  } catch (e) {
    out.errors.push(redact(e))
    return out
  } finally {
    sa = null
  }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  const count = async (body: unknown): Promise<number> => {
    const res = await f(`${base}:runAggregationQuery`, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await res.text()
    if (!res.ok) throw new Error(`runAggregationQuery HTTP ${res.status}`)
    const arr = JSON.parse(text)
    const v = (Array.isArray(arr) ? arr : [arr]).find((x: any) => x?.result)?.result?.aggregateFields?.n?.integerValue
    if (v == null) throw new Error('runAggregationQuery returned no count')
    return Number(v)
  }
  const startIso = new Date(windowStartMs).toISOString()
  const endIso = new Date(windowEndMs).toISOString()
  const tries: [keyof FirebaseCounts, unknown][] = [
    ['newAccountsInWindow', countQueryBody('createdAt', { timestampValue: startIso }, { timestampValue: endIso })],
    ['accountsWithCreatedAt', countQueryBody('createdAt', { timestampValue: '1970-01-01T00:00:00Z' }, null)],
    ['promoClaimsInWindow', countQueryBody('promo_first50_granted_at', { stringValue: startIso }, { stringValue: endIso })],
    ['promoClaimsTotal', countQueryBody('promo_first50_granted_at', { stringValue: '' }, null)],
  ]
  for (const [key, body] of tries) {
    try {
      ;(out as any)[key] = await count(body)
    } catch (e) {
      out.errors.push(`${key}: ${redact(e)}`)
    }
  }
  try {
    const res = await f(`${base}/promos/first50`, { method: 'GET', headers })
    const text = await res.text()
    if (!res.ok) throw new Error(`promos/first50 HTTP ${res.status}`)
    const fields = JSON.parse(text).fields ?? {}
    const int = (x: any) => (x?.integerValue != null ? Number(x.integerValue) : x?.doubleValue != null ? Number(x.doubleValue) : null)
    out.first50 = { cap: int(fields.cap), claimed: int(fields.claimed), closed: typeof fields.closed?.booleanValue === 'boolean' ? fields.closed.booleanValue : null }
  } catch (e) {
    out.errors.push(`first50: ${redact(e)}`)
  }
  return out
}
