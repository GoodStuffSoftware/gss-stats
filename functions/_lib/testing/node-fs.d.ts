// Minimal ambient shapes for the slice of node:fs, node:path and node:url that
// auth.viewer.test.ts uses to read the functions/api route files. Same reason as
// functions/api/node-sqlite.d.ts: the root tsconfig scopes `types` to @cloudflare/workers-types,
// so @types/node isn't included for functions/, and this shim adds no Node globals.
declare module 'node:fs' {
  export function readdirSync(path: string): string[]
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function statSync(path: string): { isDirectory(): boolean }
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function relative(from: string, to: string): string
  export function dirname(path: string): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string
}
