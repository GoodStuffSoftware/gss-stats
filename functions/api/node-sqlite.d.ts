// Minimal ambient shape for the tiny slice of node:sqlite that geo.mergedSql.test.ts uses. The
// root tsconfig scopes `types` to `@cloudflare/workers-types` only (functions/ code models the
// Workers runtime, not Node), so @types/node's own (much fuller) `node:sqlite` declarations
// aren't auto-included for files under functions/ — this local shim is enough for that one test
// and doesn't pull in Node globals (process, Buffer, …) the way referencing all of @types/node
// would.
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(location: string)
    exec(sql: string): void
    prepare(sql: string): {
      run(...params: unknown[]): unknown
      get(...params: unknown[]): unknown
      all(...params: unknown[]): unknown[]
    }
    close(): void
  }
}
