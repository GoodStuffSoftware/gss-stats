// OPTIONAL, READ-ONLY Firestore counts for the ads routine: new prod accounts and first-50
// promo claims in a window, the promos/first50 status doc, and (day-15/30/60 stages) the
// flight-window account cohort by access tier and promo marker. Enabled only when the CLI is
// given --firebase-sa <path to an existing service-account JSON on this machine>, or (the cloud
// routine, which has no key file) FIRESTORE_SA_B64 holds that JSON base64-encoded on one line;
// otherwise every figure reads "not read". The env form is decoded in memory only — this module
// signs its own JWT, so no client library needs a key file and nothing is written to disk.
//
// COUNTS ONLY: every user figure comes from a Firestore COUNT aggregation query, so no user
// document, email or uid ever enters this process. fencedFetch() below is the only way a
// request leaves this module, and it allows exactly four calls: the OAuth token exchange, a
// GET of promos/first50, a GET of promos_public/first50 masked to its `open` field, and POST
// documents:runAggregationQuery. No write, commit or batch
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
//
// CLIENT-VISIBLE FIRST-50 (ads-session finding, 2026-09-28): the counter above is NOT what the
// signed-out client gates its offer on. best-sudoku src/services/first50PromoStatus.ts
// isFirst50PromoOpen() reads promos_public/first50 (getDocFromServer) and shows the offer only
// when `open === true`, so a missing doc means HIDDEN. That doc did not exist in prod until
// 2026-09-28T20:11:29Z, while the counter read "open" all along. We read that one doc, only its
// `open` field (plus the document's own updateTime), and report it next to the counter. The
// read is fail-soft: its failure is carried in first50Client.error, never in `errors`, so it
// can never make a read incomplete or change a push (see read.ts `complete` / failedDetails).

import fs from 'node:fs'
import type { CohortTierCounts } from '../../src/lib/adsRules'
import { redact, registerSecret } from '../../src/lib/adsRedact'
import { createTimedFetch, type FetchLike } from '../../src/lib/adsApi'
import { EXTERNAL_TIMEOUT_MS } from './wrangler'
import { DATASTORE_SCOPE, GOOGLE_TOKEN_URL, serviceAccountAccessToken } from './googleSa'

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
  /** What the signed-out client sees (promos_public/first50). Report text only: never feeds a
   * kill rule, the decision table, completeness or a push. Absent on older fixtures. */
  first50Client?: First50ClientState | null
  /** Day-15/30/60 only: the raw COUNT inputs for lib/adsRules.ts deriveCohortTiers. */
  cohortTiers?: CohortTierCounts | null
  errors: string[]
}

export interface First50ClientState {
  /** visible: the doc exists with open === true. hidden: the doc is missing, or open is not
   * true (the client's own rule). unknown: the read failed or never ran. */
  state: 'visible' | 'hidden' | 'unknown'
  /** false = HTTP 404 (no such doc); null when unknown. */
  exists: boolean | null
  /** The raw `open` field when it is a boolean, else null. */
  open: boolean | null
  /** The document's updateTime (ISO), when the doc exists. */
  updateTime: string | null
  /** Short, secret-free reason when state is unknown. */
  error: string | null
}
export const PROMOS_PUBLIC_FIRST50_PATH = 'promos_public/first50'
/** The one URL the client-visible read may GET: that doc, masked to `open`. */
export const promosPublicUrl = (documentsBase: string) => `${documentsBase}/${PROMOS_PUBLIC_FIRST50_PATH}?mask.fieldPaths=open`
export const first50ClientUnknown = (error: string): First50ClientState => ({ state: 'unknown', exists: null, open: null, updateTime: null, error })

/** Parse the promos_public/first50 GET. 404 = missing = hidden (the client treats a missing doc
 * as closed); any other non-2xx throws so the caller records it as unknown. */
export function parseFirst50Client(status: number, ok: boolean, text: string): First50ClientState {
  if (status === 404) return { state: 'hidden', exists: false, open: null, updateTime: null, error: null }
  if (!ok) throw new Error(`${PROMOS_PUBLIC_FIRST50_PATH} HTTP ${status}`)
  const doc = JSON.parse(text)
  const raw = doc?.fields?.open?.booleanValue
  const open = typeof raw === 'boolean' ? raw : null
  const updateTime = typeof doc?.updateTime === 'string' ? doc.updateTime : null
  return { state: open === true ? 'visible' : 'hidden', exists: true, open, updateTime, error: null }
}

/** Where the service-account JSON comes from: a key file path (--firebase-sa), or the JSON text
 * itself, already decoded in memory (FIRESTORE_SA_B64). A bare string is a path. */
export type ServiceAccountSource = string | { json: string }

export const FIRESTORE_SA_ENV = 'FIRESTORE_SA_B64'

/** Decodes FIRESTORE_SA_B64 in memory. Returns null when unset. Never throws: the encoded
 * value, the decoded text and (when it parses) its private_key are registered with redact()
 * first, and a malformed value surfaces later as "FIRESTORE_SA_B64 service account unreadable"
 * (the variable's name, never its content) through the normal Firestore error path. */
export function serviceAccountFromEnv(env: Record<string, string | undefined> = process.env): { json: string } | null {
  const b64 = env[FIRESTORE_SA_ENV]?.trim()
  if (!b64) return null
  registerSecret(b64)
  const json = Buffer.from(b64, 'base64').toString('utf8')
  registerSecret(json)
  try {
    const key = JSON.parse(json)?.private_key
    if (typeof key === 'string') registerSecret(key)
  } catch {
    /* reported as unreadable when used */
  }
  return { json }
}

/** Reads and parses the service account, registering its private_key. Errors never carry the
 * file's or variable's content. */
function loadServiceAccount(source: ServiceAccountSource): { sa: any; error: string | null } {
  let sa: any
  try {
    sa = JSON.parse(typeof source === 'string' ? fs.readFileSync(source, 'utf8') : source.json)
  } catch {
    return { sa: null, error: typeof source === 'string' ? 'service-account file unreadable' : `${FIRESTORE_SA_ENV} service account unreadable` }
  }
  if (!sa?.private_key || !sa?.client_email || !sa?.project_id) {
    return { sa: null, error: `${typeof source === 'string' ? 'service-account file' : FIRESTORE_SA_ENV + ' service account'} is missing project_id/client_email/private_key` }
  }
  registerSecret(sa.private_key)
  return { sa, error: null }
}

const TOKEN_URL = GOOGLE_TOKEN_URL

/** The only four requests this module may make. Anything else throws before it is sent. */
export function fencedFetch(f: FetchLike, documentsBase: string): FetchLike {
  return (url, init) => {
    const ok =
      (init.method === 'POST' && url === TOKEN_URL) ||
      (init.method === 'GET' && url === `${documentsBase}/promos/first50`) ||
      (init.method === 'GET' && url === promosPublicUrl(documentsBase)) ||
      (init.method === 'POST' && url === `${documentsBase}:runAggregationQuery`)
    if (!ok) throw new Error(`firebase.ts refused a ${init.method} to a non-allowlisted URL`)
    return f(url, init)
  }
}

/** The datastore-scoped token, through the shared signer (googleSa.ts). */
const accessToken = (sa: { client_email: string; private_key: string }, fetchImpl: FetchLike): Promise<string> => serviceAccountAccessToken(sa, DATASTORE_SCOPE, fetchImpl)

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

/** One line, no URL, capped: a reason fit for a report line. */
export function shortReason(msg: string): string {
  const line = String(msg).split('\n')[0].replace(/https?:\/\/\S+/g, '<url>').trim()
  return (line.length > 80 ? `${line.slice(0, 77)}...` : line) || 'unknown error'
}

export async function readFirebaseCounts(
  saSource: ServiceAccountSource,
  windowStartMs: number,
  windowEndMs: number,
  opts: { fetchImpl?: FetchLike; cohortTiersAtMs?: number | null } = {},
): Promise<FirebaseCounts> {
  const raw: FetchLike = opts.fetchImpl ?? createTimedFetch(EXTERNAL_TIMEOUT_MS)
  const out: FirebaseCounts = {
    projectId: null,
    newAccountsInWindow: null,
    accountsWithCreatedAt: null,
    promoClaimsInWindow: null,
    promoClaimsTotal: null,
    first50: null,
    first50Client: first50ClientUnknown('not read'),
    errors: [],
  }
  const loaded = loadServiceAccount(saSource)
  if (loaded.error) {
    out.errors.push(loaded.error)
    return out
  }
  let sa: any = loaded.sa
  out.projectId = String(sa.project_id)
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(out.projectId)}/databases/(default)/documents`
  const f = fencedFetch(raw, base)
  let token: string
  try {
    token = await accessToken(sa, f)
  } catch (e) {
    out.errors.push(redact(e))
    out.first50Client = first50ClientUnknown('Firestore sign-in failed')
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
  // Fail-soft by construction: a throw or a timeout here becomes state 'unknown' with a short
  // redacted reason, and is deliberately NOT pushed to out.errors (which feed completeness and
  // the failure push in read.ts).
  try {
    const res = await f(promosPublicUrl(base), { method: 'GET', headers })
    out.first50Client = parseFirst50Client(res.status, res.ok, await res.text())
  } catch (e) {
    out.first50Client = first50ClientUnknown(shortReason(redact(e)))
  }
  return out
}

/** ads:cloud-check's Firestore probe: sign in and run ONE COUNT aggregation the post-flight read
 * already runs (users with any createdAt). Resolves with nothing — the count is never returned
 * or printed; throws on any failure. Same fence as readFirebaseCounts. */
export async function probeFirestoreCount(saSource: ServiceAccountSource, opts: { fetchImpl?: FetchLike } = {}): Promise<void> {
  const loaded = loadServiceAccount(saSource)
  if (loaded.error) throw new Error(loaded.error)
  let sa: any = loaded.sa
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(String(sa.project_id))}/databases/(default)/documents`
  const f = fencedFetch(opts.fetchImpl ?? createTimedFetch(EXTERNAL_TIMEOUT_MS), base)
  let token: string
  try {
    token = await accessToken(sa, f)
  } finally {
    sa = null
  }
  const res = await f(`${base}:runAggregationQuery`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(countQueryBody('createdAt', { timestampValue: '1970-01-01T00:00:00Z' }, null)),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`runAggregationQuery HTTP ${res.status}`)
  const arr = JSON.parse(text)
  const v = (Array.isArray(arr) ? arr : [arr]).find((x: any) => x?.result)?.result?.aggregateFields?.n?.integerValue
  if (v == null) throw new Error('runAggregationQuery returned no count')
}
