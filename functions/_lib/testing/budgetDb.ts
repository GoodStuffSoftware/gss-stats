// Tests only: the private Budget database (migrations/gss-budget) in a real SQLite (node:sqlite, D1's
// dialect) behind a D1Database's prepare/bind/all/first/run/batch surface, loaded with SYNTHETIC data
// (src/lib/budget/__fixtures__/synthetic.ts: made-up accounts, merchants and amounts). The route and
// helper tests call the real handlers against it, so every query runs as in production.
//
// Like D1: foreign keys are enforced, `batch()` is ONE transaction (all or nothing), each statement
// answers { results, success, meta: { changes } }. It also keeps the SQL it ran (`statements`) and can
// EXPLAIN a statement, so a test can prove every query shape uses an index.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { planImport } from '../../../src/lib/budget/import'
import { renderPlanSql } from '../../../src/lib/budget/sqlFile'
import { emptyContext, syntheticRequest } from '../../../src/lib/budget/__fixtures__/synthetic'
import type { BudgetEnv } from '../budgetAccess'

type SqlValue = string | number | null

/** The slice of node:sqlite beyond the shared shim (functions/api/node-sqlite.d.ts) used here. */
interface Stmt {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  columns(): unknown[]
}
interface Conn {
  exec(sql: string): void
  prepare(sql: string): Stmt
}

export interface FakeD1Result {
  results: unknown[]
  success: true
  meta: { changes: number; rows_read: number }
}

export interface FakePrepared {
  readonly sql: string
  readonly values: SqlValue[]
  bind(...values: unknown[]): FakePrepared
  all(): Promise<FakeD1Result>
  first(): Promise<unknown | null>
  run(): Promise<FakeD1Result>
  raw(): Promise<unknown[]>
}

export interface FakeBudgetDb {
  /** Cast of this fake for code that wants the Workers type. */
  readonly d1: D1Database
  /** The underlying connection, for direct inspection in a test. */
  readonly sqlite: DatabaseSync
  /** Every SQL text run through prepare, in order (batch members included). */
  readonly statements: string[]
  prepare(sql: string): FakePrepared
  batch(stmts: FakePrepared[]): Promise<FakeD1Result[]>
  /** `EXPLAIN QUERY PLAN` lines (the `detail` column) for one statement. */
  explain(sql: string, values?: unknown[]): string[]
  /** Run SQL directly (setup in a test). */
  exec(sql: string): void
  /** One row or undefined, straight from SQLite. */
  get<T = Record<string, unknown>>(sql: string, ...values: unknown[]): T | undefined
  all<T = Record<string, unknown>>(sql: string, ...values: unknown[]): T[]
  /** Make the next batch() throw once (for the all-or-nothing test). */
  failNextBatch(): void
}

const conn = (db: DatabaseSync): Conn => db as unknown as Conn
const num = (n: number | bigint): number => Number(n)

function wrap(c: Conn, sql: string, values: SqlValue[], log: string[], d1: { failBatch: boolean }): FakePrepared {
  const prepared: FakePrepared = {
    sql,
    values,
    bind: (...v: unknown[]) => wrap(c, sql, v as SqlValue[], log, d1),
    async all() {
      log.push(sql)
      const stmt = c.prepare(sql)
      const results = stmt.all(...values)
      return { results, success: true, meta: { changes: 0, rows_read: results.length } }
    },
    async first() {
      log.push(sql)
      return c.prepare(sql).get(...values) ?? null
    },
    async run() {
      log.push(sql)
      const r = c.prepare(sql).run(...values)
      return { results: [], success: true, meta: { changes: num(r.changes), rows_read: 0 } }
    },
    async raw() {
      log.push(sql)
      return c.prepare(sql).all(...values).map((r) => Object.values(r as Record<string, unknown>))
    },
  }
  return prepared
}

let seedSql: Promise<string> | null = null

/** The synthetic load as literal SQL (the same writes `scripts/budget/build-load-sql.ts` renders). Planned once. */
export function syntheticSeedSql(): Promise<string> {
  seedSql ??= planImport(syntheticRequest('imp-synth-1', true), emptyContext(), 'seed@example.com', '2026-12-05T10:00:00.000Z')
    .then((plan) => renderPlanSql(plan))
  return seedSql
}

function migrationSql(): string {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations', 'gss-budget')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

export interface CreateOptions {
  /** Load the synthetic seed (default true). false = migrated, empty tables (categories seeded by the migration). */
  seed?: boolean
}

/** A fresh in-memory budget database, migrated and (by default) loaded with the synthetic seed. */
export async function createBudgetDb(opts: CreateOptions = {}): Promise<FakeBudgetDb> {
  const sqlite = new DatabaseSync(':memory:')
  const c = conn(sqlite)
  c.exec('PRAGMA foreign_keys = ON')
  c.exec(migrationSql())
  if (opts.seed !== false) c.exec(await syntheticSeedSql())

  const statements: string[] = []
  const flags = { failBatch: false }
  const fake: FakeBudgetDb = {
    d1: undefined as unknown as D1Database,
    sqlite,
    statements,
    prepare: (sql) => wrap(c, sql, [], statements, flags),
    async batch(stmts) {
      if (flags.failBatch) {
        flags.failBatch = false
        throw new Error('D1_ERROR: simulated batch failure')
      }
      const out: FakeD1Result[] = []
      c.exec('BEGIN')
      try {
        for (const s of stmts) {
          statements.push(s.sql)
          const stmt = c.prepare(s.sql)
          if (stmt.columns().length > 0) {
            const results = stmt.all(...s.values)
            out.push({ results, success: true, meta: { changes: 0, rows_read: results.length } })
          } else {
            const r = stmt.run(...s.values)
            out.push({ results: [], success: true, meta: { changes: num(r.changes), rows_read: 0 } })
          }
        }
        c.exec('COMMIT')
      } catch (err) {
        c.exec('ROLLBACK')
        throw err
      }
      return out
    },
    explain(sql, values = []) {
      return c.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(values as SqlValue[])).map((r) => String((r as { detail: string }).detail))
    },
    exec: (sql) => c.exec(sql),
    get: <T>(sql: string, ...values: unknown[]) => c.prepare(sql).get(...(values as SqlValue[])) as T | undefined,
    all: <T>(sql: string, ...values: unknown[]) => c.prepare(sql).all(...(values as SqlValue[])) as T[],
    failNextBatch() {
      flags.failBatch = true
    },
  }
  ;(fake as { d1: D1Database }).d1 = fake as unknown as D1Database
  return fake
}

let nextTestId = 1

/** A deterministic 32-hex transaction id for hand-made test rows. */
export function testTxnId(n: number = nextTestId++): string {
  return n.toString(16).padStart(32, '0')
}

export interface TxnSeed {
  id?: string
  account_id?: string
  posted_date?: string
  amount_cents?: number
  description?: string
  merchant_key?: string
  merchant_name?: string
  store_no?: string | null
  kind?: string
  kind_source?: string
  category_id?: string | null
  category_source?: string
  rule_id?: string | null
  needs_review?: number
  review_reason?: string | null
  updated_at?: string
}

/** Inserts one made-up transaction (defaults: a $5.00 spend at "Test Shop" on the checking account). Returns its id. */
export function insertTxn(db: FakeBudgetDb, t: TxnSeed = {}): string {
  const id = t.id ?? testTxnId()
  db.sqlite.prepare(
    `INSERT INTO transactions (id, account_id, import_id, posted_date, amount_cents, description, merchant_key, merchant_name, store_no, kind, kind_source,
       category_id, category_source, rule_id, confidence, needs_review, review_reason, updated_at, updated_by)
     VALUES (?, ?, 'imp-synth-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 50, ?, ?, ?, 'seed@example.com')`,
  ).run(
    id, t.account_id ?? 'chk-a', t.posted_date ?? '2026-11-15', t.amount_cents ?? -500, t.description ?? 'TEST SHOP', t.merchant_key ?? 'test-shop',
    t.merchant_name ?? 'Test Shop', t.store_no ?? null, t.kind ?? 'spend', t.kind_source ?? 'auto', t.category_id ?? null, t.category_source ?? 'none',
    t.rule_id ?? null, t.needs_review ?? 0, t.review_reason ?? null, t.updated_at ?? '2026-12-05T10:00:00.000Z',
  )
  return id
}

/** Adds a second household member with their own checking account (the synthetic seed has only person A). */
export function addPersonB(db: FakeBudgetDb): void {
  db.exec(`INSERT INTO accounts (id, label, kind, person_id, last4, sort) VALUES ('chk-b', 'Checking B', 'checking', 'pb', '0008', 9)`)
}

/** The identity the scoped middleware leaves in `context.data` (the routes read only this). */
export const TEST_EMAIL = 'user-a@example.com'

/** Env for a budget route test (the auth settings are not needed: routes trust `data.budgetEmail`). */
export function budgetEnv(db: FakeBudgetDb): BudgetEnv {
  return { BUDGET_DB: db.d1 } as BudgetEnv
}

export interface CallOptions {
  method?: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  /** Raw body text (overrides `body`), e.g. invalid JSON or an oversize string. */
  rawBody?: string
  params?: Record<string, string>
  /** `data.budgetEmail`; pass null to leave it unset (a route must then answer 403). */
  email?: string | null
}

/** Calls a route handler the way Pages does: request, env, params and the middleware's `data`. */
export function callRoute(
  handler: (ctx: never) => Promise<Response> | Response,
  db: FakeBudgetDb,
  path: string,
  o: CallOptions = {},
): Promise<Response> {
  const url = new URL(`https://stats.goodstuff.software${path}`)
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
  const method = o.method ?? 'GET'
  const init: RequestInit = { method, headers: {} }
  const text = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body))
  if (text !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = text
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  const data: Record<string, unknown> = {}
  if (o.email !== null) data.budgetEmail = o.email ?? TEST_EMAIL
  const ctx = { request: new Request(url, init), env: budgetEnv(db), params: o.params ?? {}, data, waitUntil: () => {}, next: async () => new Response('next') }
  return Promise.resolve(handler(ctx as never))
}

/** Parsed JSON body of a response. */
export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T
}
