// Tests only: the beacon's `hits` table in a real SQLite (node:sqlite — D1's dialect), behind a
// D1 binding's prepare/bind/all surface, plus an in-memory Cache API. Lets a test call a Pages
// Function's real handler (functions/api/*.ts onRequestPost) end to end: the handler builds its
// SQL exactly as in production and SQLite runs it, so nothing about the query is mocked.
// Same approach as functions/api/geo.mergedSql.test.ts, shared so the /api/overview,
// /api/campaigns and /api/metrics tests read one fixture.

import { DatabaseSync } from 'node:sqlite'
import type { CacheLike } from '../edgeCache'

/** Every `hits` column (docs/capacity.md §4), in the production order. */
export const HITS_COLUMNS = [
  'ts', 'site', 'path', 'referrer', 'country', 'region', 'city', 'postal', 'continent', 'timezone', 'lat', 'lon',
  'colo', 'org', 'device', 'browser', 'os', 'lang', 'screenw', 'visitor', 'refpath', 'source', 'medium', 'campaign',
] as const
export type HitsColumn = (typeof HITS_COLUMNS)[number]
export type HitRow = Partial<Record<HitsColumn, string | number>> & { ts: number }

export function openHitsDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const cols = HITS_COLUMNS.map((c) => `${c} ${c === 'ts' || c === 'screenw' ? 'INTEGER' : 'TEXT'} DEFAULT ${c === 'ts' || c === 'screenw' ? 0 : c === 'visitor' ? "'new'" : "''"}`)
  db.exec(`CREATE TABLE hits (id INTEGER PRIMARY KEY AUTOINCREMENT, ${cols.join(', ')})`)
  db.exec('CREATE INDEX idx_hits_ts ON hits (ts)')
  db.exec('CREATE INDEX idx_hits_site_ts ON hits (site, ts)')
  return db
}

/** Inserts `n` copies (default 1) of each row. Unset columns take the production defaults. */
export function insertHits(db: DatabaseSync, rows: (HitRow & { n?: number })[]): void {
  for (const r of rows) {
    const cols = HITS_COLUMNS.filter((c) => r[c] !== undefined)
    const stmt = db.prepare(`INSERT INTO hits (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    for (let i = 0; i < (r.n ?? 1); i++) stmt.run(...cols.map((c) => r[c]))
  }
}

/** A D1Database's read surface over node:sqlite. `statements` counts every prepared query run. */
export function sqliteD1(db: DatabaseSync): D1Database & { statements: string[] } {
  const statements: string[] = []
  const binding = {
    statements,
    prepare(sql: string) {
      const bound = (values: unknown[]) => ({
        async all() {
          statements.push(sql)
          return { results: db.prepare(sql).all(...values), success: true, meta: {} }
        },
        async first() {
          statements.push(sql)
          return db.prepare(sql).get(...values) ?? null
        },
      })
      return { ...bound([]), bind: (...values: unknown[]) => bound(values) }
    },
  }
  return binding as unknown as D1Database & { statements: string[] }
}

/** An in-memory Cache API (match/put) keyed by URL — honours nothing but presence. */
export function memoryCache(): CacheLike & { keys(): string[]; clear(): void } {
  const store = new Map<string, string>()
  return {
    async match(req: Request) {
      const body = store.get(req.url)
      return body === undefined ? undefined : new Response(body, { headers: { 'Content-Type': 'application/json' } })
    },
    async put(req: Request, res: Response) {
      store.set(req.url, await res.text())
    },
    keys: () => [...store.keys()],
    clear: () => store.clear(),
  }
}

/** Installs `cache` as `caches.default` (what functions/_lib code reads); returns an undo. */
export function installCaches(cache: CacheLike): () => void {
  const g = globalThis as unknown as { caches?: unknown }
  const prev = g.caches
  g.caches = { default: cache }
  return () => {
    g.caches = prev
  }
}

/** The minimal EventContext a Pages Function handler reads (request, env, waitUntil). */
export function pagesContext<E>(request: Request, env: E, waited: Promise<unknown>[] = []): EventContext<E, string, Record<string, unknown>> {
  return {
    request,
    env,
    waitUntil: (p: Promise<unknown>) => void waited.push(p),
    passThroughOnException: () => {},
    next: async () => new Response('next'),
    params: {},
    data: {},
    functionPath: '',
  } as unknown as EventContext<E, string, Record<string, unknown>>
}

export function postJson(path: string, body: unknown): Request {
  return new Request(`https://stats.goodstuff.software${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
