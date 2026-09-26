// Tests only: a real SQLite (node:sqlite) with every gss-stats-ads migration applied in order,
// behind the same AdsDb interface the wrangler-CLI and D1-binding adapters implement — so the
// store's SQL, the UNIQUE de-dup index and the append-only / no-REPLACE triggers are exercised
// for real, not mocked.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AdsDb, SqlStatement } from '../../src/lib/adsStore'
import { repoRoot } from './wrangler'

export const MIGRATIONS_DIR = path.join(repoRoot(), 'migrations', 'gss-stats-ads')

export function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
}

/** A fresh in-memory database with 0001..N applied (foreign keys on, as D1 enforces them). */
export function openMigratedSqlite(upTo?: string): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const f of migrationFiles()) {
    if (upTo && f > upTo) break
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
  }
  return db
}

export interface RecordedWrite {
  sql: string
  changes: number
}
export function sqliteAdsDb(db: DatabaseSync): AdsDb & { writes: RecordedWrite[] } {
  const writes: RecordedWrite[] = []
  const bind = (s: SqlStatement) => s.binds as (string | number | null)[]
  return {
    writes,
    async all(stmt) {
      return db.prepare(stmt.sql).all(...bind(stmt)) as Record<string, unknown>[]
    },
    async run(stmt) {
      const r = db.prepare(stmt.sql).run(...bind(stmt))
      const changes = Number(r.changes)
      writes.push({ sql: stmt.sql, changes })
      return { changes }
    },
  }
}

/** A Cloudflare D1 binding's surface (prepare/bind/all/run) over node:sqlite, so the Worker's
 * d1BindingAdsDb adapter and the dashboard readers run against real migrated SQL in tests. */
export function sqliteD1(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const binds = values as (string | number | null)[]
          return {
            async all() {
              return { results: db.prepare(sql).all(...binds) as unknown[] }
            },
            async run() {
              const r = db.prepare(sql).run(...binds)
              return { meta: { changes: Number(r.changes) } }
            },
          }
        },
      }
    },
  }
}

export function count(db: DatabaseSync, table: string, where = '1 = 1', ...binds: (string | number | null)[]): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...binds) as { n: number }).n)
}
