// READ-ONLY access to the beacon's D1 database (gss-geo, owned by gss-beacon) through
// `wrangler d1 execute gss-geo --remote --json --command "<SELECT>"`. Never --file, never a
// write: assertReadOnlySql() rejects anything that is not a single SELECT/WITH statement
// before wrangler is ever spawned.
//
// `wrangler d1 execute --command` has no bind parameters, so the `?` placeholders the shared
// lib clauses produce (lib/campaigns.ts campaignAttributionClause / applyExclusions, …) are
// inlined here as SQL literals. Every bound value comes from this repo's own config (campaign
// tags, exclusion constants, timestamps) — still escaped properly, and anything that is not a
// finite number or a string is refused.

import { redactedFirstLine } from '../../src/lib/adsRedact'
import { stripSqlLiterals } from '../../src/lib/adsStore'
import type { WranglerRunner } from './wrangler'

export { stripSqlLiterals }

export const BEACON_DB = 'gss-geo'

/** SQL literal for one bound value: integers/finite numbers as-is, strings single-quoted with
 * '' escaping, null as NULL (the ads store's optional columns). */
export function sqlLiteral(v: unknown): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('refusing to inline a non-finite number')
    return String(v)
  }
  if (typeof v === 'string') {
    if (v.includes('\0')) throw new Error('refusing to inline a NUL byte')
    return `'${v.replace(/'/g, "''")}'`
  }
  throw new Error(`refusing to inline a ${v === null ? 'null' : typeof v} bind value`)
}

/** Replaces each `?` outside a quoted literal with the next bind, in order. */
export function inlineBinds(sql: string, binds: readonly unknown[]): string {
  let out = ''
  let bi = 0
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      out += ch
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[++i] // escaped quote inside the literal
        } else quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '?') {
      if (bi >= binds.length) throw new Error('more ? placeholders than bind values')
      out += sqlLiteral(binds[bi++])
      continue
    }
    out += ch
  }
  if (quote) throw new Error('unterminated quoted literal in SQL')
  if (bi !== binds.length) throw new Error(`bind count mismatch: ${binds.length} values for ${bi} placeholders`)
  return out
}

const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|UPSERT|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|TRUNCATE|GRANT|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i

export function assertReadOnlySql(sql: string): void {
  const bare = stripSqlLiterals(sql).trim().replace(/;\s*$/, '')
  if (!/^(SELECT|WITH)\b/i.test(bare)) throw new Error('beacon reads must be a SELECT')
  if (bare.includes(';')) throw new Error('beacon reads must be a single statement')
  if (/--|\/\*/.test(bare)) throw new Error('beacon reads must not contain SQL comments')
  const m = WRITE_KEYWORDS.exec(bare)
  if (m) throw new Error(`beacon reads must not contain ${m[1].toUpperCase()}`)
}

export type D1Select = <T = Record<string, unknown>>(sql: string, binds?: readonly unknown[]) => Promise<T[]>

/** Parses `wrangler d1 execute --json` stdout: `[{"results":[…],"success":true,"meta":{…}}]`. */
export function parseD1Json(stdout: string): Record<string, unknown>[] {
  return parseD1Response(stdout).results
}
/** The same, plus meta.changes (null when wrangler does not report it). */
export function parseD1Response(stdout: string): { results: Record<string, unknown>[]; changes: number | null } {
  const start = stdout.indexOf('[')
  if (start < 0) throw new Error('wrangler returned no JSON')
  const parsed = JSON.parse(stdout.slice(start))
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  if (!first || first.success === false) throw new Error('D1 reported the query as unsuccessful')
  const changes = first.meta && typeof first.meta.changes === 'number' ? first.meta.changes : null
  return { results: Array.isArray(first.results) ? first.results : [], changes }
}

/** SELECT-only access to a D1 database (default: the beacon's gss-geo). */
export function createD1Select(run: WranglerRunner, database: string = BEACON_DB): D1Select {
  return async <T>(sql: string, binds: readonly unknown[] = []): Promise<T[]> => {
    const final = inlineBinds(sql, binds)
    assertReadOnlySql(final)
    const res = await run(['d1', 'execute', database, '--remote', '--json', '--command', final])
    if (res.code !== 0) throw new Error(`wrangler d1 execute failed (exit ${res.code}): ${redactedFirstLine(res.stderr || res.stdout)}`)
    return parseD1Json(res.stdout) as T[]
  }
}
