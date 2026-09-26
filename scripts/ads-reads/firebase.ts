// OPTIONAL, READ-ONLY Firestore counts for the ads routine: new prod accounts and first-50
// promo claims in a window, the promos/first50 status doc, and (day-15/30/60 stages) the
// flight-window account cohort by access tier and promo marker. Enabled only when the CLI is
// given --firebase-sa <path to an existing service-account JSON on this machine>; otherwise
// every figure reads "not read".
//
// COUNTS ONLY: every user figure comes from a Firestore COUNT aggregation query, so no user
// document, email or uid ever enters this process. fencedFetch() below is the only way a
// request leaves this module, and it allows exactly three calls: the OAuth token exchange, a
// GET of promos/first50, and POST documents:runAggregationQuery. No write, commit or batch
// endpoint is reachable, nothing under users/ is ever written, and grant-first50.mjs (a WRITE
// tool) is never used.
//
// WORTH KNOWING (checked read-only 2026-09-26 with `gcloud projects get-iam-policy`): the
// prod key on this machine, firebase-adminsdk-fbsvc@best-sudoku-prod, is NOT read-only (it
// holds roles/editor and firebase.sdkAdminServiceAgent, among others). The fence and the
// datastore-only OAuth scope limit what THIS code can do with it; a dedicated key with only
// roles/datastore.viewer would limit what the key can do. That is an owner step.
//
// Field types (best-sudoku origin/main, 2026-09-26): users/{uid}.createdAt is a Firestore
// Timestamp; promo_first50_granted_at, trial_ends_at and access_expires_at are ISO strings
// (access_expires_at may also be the sentinel 'lifetime'); promos/first50 is
// { cap, claimed, closed, updatedAt }.

import fs from 'node:fs'
import { createSign } from 'node:crypto'
import type { CohortTierCounts } from '../../src/lib/adsRules'
import { redact, registerSecret } from './redact'
import { timedFetch, type FetchLike } from './adsApi'

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
  /** Day-15/30/60 only: the raw COUNT inputs for lib/adsRules.ts deriveCohortTiers. */
  cohortTiers?: CohortTierCounts | null
  errors: string[]
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** The only three requests this module may make. Anything else throws before it is sent. */
export function fencedFetch(f: FetchLike, documentsBase: string): FetchLike {
  return (url, init) => {
    const ok =
      (init.method === 'POST' && url === TOKEN_URL) ||
      (init.method === 'GET' && url === `${documentsBase}/promos/first50`) ||
      (init.method === 'POST' && url === `${documentsBase}:runAggregationQuery`)
    if (!ok) throw new Error(`firebase.ts refused a ${init.method} to a non-allowlisted URL`)
    return f(url, init)
  }
}

async function accessToken(sa: { client_email: string; private_key: string }, fetchImpl: FetchLike): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  )}`
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key)
  const res = await fetchImpl(TOKEN_URL, {
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
type Op = 'GREATER_THAN_OR_EQUAL' | 'GREATER_THAN' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL'
export interface CountFilter {
  field: string
  op: Op
  value: Value
}
/** A COUNT over users/ with ANDed field filters. */
export function countWhereBody(filters: readonly CountFilter[]): unknown {
  const ff = filters.map((x) => ({ fieldFilter: { field: { fieldPath: x.field }, op: x.op, value: x.value } }))
  return {
    structuredAggregationQuery: {
      structuredQuery: { from: [{ collectionId: 'users' }], where: ff.length === 1 ? ff[0] : { compositeFilter: { op: 'AND', filters: ff } } },
      aggregations: [{ alias: 'n', count: {} }],
    },
  }
}
/** Back-compat helper: one field, [from, to). */
export function countQueryBody(field: string, from: Value, to: Value | null): unknown {
  return countWhereBody([{ field, op: 'GREATER_THAN_OR_EQUAL', value: from }, ...(to ? [{ field, op: 'LESS_THAN' as const, value: to }] : [])])
}

/** The COUNT queries behind the day-15/30/60 cohort breakdown (see adsRules deriveCohortTiers).
 * Every one is scoped to users created inside the flight window. Paid includes 'lifetime'
 * (the sentinel sorts after any ISO date); 'access past' excludes it.
 *
 * INDEXES (probed read-only 2026-09-26: best-sudoku has no firestore.indexes.json and prod
 * answered FAILED_PRECONDITION): every query below except 'total' filters a range on
 * createdAt plus another field, which Firestore only serves from a composite index on users —
 * (createdAt, access_expires_at), (createdAt, trial_ends_at),
 * (createdAt, trial_ends_at, access_expires_at) and (createdAt, promo_first50_granted_at).
 * None is created here (owner step, in best-sudoku's project). Until they exist the stage
 * reports "tier split unavailable: index missing" and keeps the plain window count. */
export function cohortTierQueries(startIso: string, endIso: string, nowIso: string): [keyof CohortTierCounts, CountFilter[]][] {
  const inWindow: CountFilter[] = [
    { field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: startIso } },
    { field: 'createdAt', op: 'LESS_THAN', value: { timestampValue: endIso } },
  ]
  const paid: CountFilter = { field: 'access_expires_at', op: 'GREATER_THAN', value: { stringValue: nowIso } }
  const accessPast: CountFilter = { field: 'access_expires_at', op: 'LESS_THAN_OR_EQUAL', value: { stringValue: nowIso } }
  const trialPast: CountFilter = { field: 'trial_ends_at', op: 'LESS_THAN_OR_EQUAL', value: { stringValue: nowIso } }
  const promoSet: CountFilter = { field: 'promo_first50_granted_at', op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '' } }
  return [
    ['total', inWindow],
    ['paid', [...inWindow, paid]],
    ['accessPast', [...inWindow, accessPast]],
    ['trialPast', [...inWindow, trialPast]],
    ['trialPastAndPaid', [...inWindow, trialPast, paid]],
    ['trialPastAndAccessPast', [...inWindow, trialPast, accessPast]],
    ['promoSet', [...inWindow, promoSet]],
  ]
}

export async function readFirebaseCounts(
  saPath: string,
  windowStartMs: number,
  windowEndMs: number,
  opts: { fetchImpl?: FetchLike; cohortTiersAtMs?: number | null } = {},
): Promise<FirebaseCounts> {
  const raw: FetchLike = opts.fetchImpl ?? timedFetch
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
  const f = fencedFetch(raw, base)
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
    if (!res.ok) {
      // FAILED_PRECONDITION = the query needs a composite index that does not exist. Say so
      // (without the console link, which carries project detail) rather than a bare 400.
      const needsIndex = res.status === 400 && /FAILED_PRECONDITION|requires an index/i.test(text)
      throw new Error(needsIndex ? 'needs a Firestore composite index (not created; owner step)' : `runAggregationQuery HTTP ${res.status}`)
    }
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
  if (opts.cohortTiersAtMs != null) {
    const nowIso = new Date(opts.cohortTiersAtMs).toISOString()
    const tiers: Partial<CohortTierCounts> = {}
    let failed: string | null = null
    for (const [key, filters] of cohortTierQueries(startIso, endIso, nowIso)) {
      try {
        tiers[key] = await count(countWhereBody(filters))
      } catch (e) {
        failed = `cohort ${key}: ${redact(e)}`
        break
      }
    }
    if (failed) {
      out.cohortTiers = null
      out.errors.push(failed)
    } else out.cohortTiers = tiers as CohortTierCounts
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
