// Deterministic transaction ids. The id is the dedupe key: INSERT ... ON CONFLICT(id) DO NOTHING makes a
// re-import a no-op and can never overwrite an edited row. Web Crypto only (Workers, browsers, Node).
import type { Cents, IsoDate } from './types'

/** Bump when the key recipe changes: old ids then no longer match and a re-import would duplicate. */
export const DEDUPE_VERSION = 'v1'

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  let out = ''
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, '0')
  return out
}

export interface DedupeInput {
  accountId: string
  postedDate: IsoDate
  amountCents: Cents
  /** normalizeDescription(...).clean */
  clean: string
  /** 0-based index among identical (date, cents, clean) rows of one statement. */
  occurrence: number
  bankRef?: string | null
}

/**
 * First 32 hex of sha256. With a bank reference the key is `v1|acct|ref:<ref>` (the same transaction
 * keeps its id even if the description is reworded); without one it is `v1|acct|date|cents|clean|occ`.
 */
export async function dedupeKey(i: DedupeInput): Promise<string> {
  const ref = i.bankRef?.trim()
  const basis = ref
    ? `${DEDUPE_VERSION}|${i.accountId}|ref:${ref}`
    : `${DEDUPE_VERSION}|${i.accountId}|${i.postedDate}|${i.amountCents}|${i.clean}|${i.occurrence}`
  return (await sha256Hex(basis)).slice(0, 32)
}

/**
 * For each row (in the order given) its 0-based index among earlier rows with the same date, amount and
 * description. Same-day repeats (two identical coffees) therefore get distinct ids, and the set of ids
 * does not depend on the order the rows arrive in.
 */
export function occurrences(rows: ReadonlyArray<{ postedDate: IsoDate; amountCents: Cents; clean: string }>): number[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const k = `${r.postedDate}|${r.amountCents}|${r.clean}`
    const n = seen.get(k) ?? 0
    seen.set(k, n + 1)
    return n
  })
}
