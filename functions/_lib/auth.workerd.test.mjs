// Runs auth.workerd-harness.ts INSIDE workerd (the Workers runtime), not Node, as part of
// `npm test`. Node's fetch accepts RequestInit values that workerd rejects, so a Node-only
// suite once passed a `redirect: 'error'` that made every production sign-in fail.
//
// How: transpile auth.ts and the harness (type stripping only), write a workerd config
// with a mock Google as the harness Worker's globalOutbound (no network), run
// `workerd test`, and require a PASS for every harness test. The config uses
// wrangler.toml's compatibility date and flags. Plain .mjs because the repo's tsconfig
// has no Node types.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import workerd from 'workerd'

// The package's default export is the binary path (CJS interop may wrap it once).
const WORKERD_BIN = typeof workerd === 'string' ? workerd : workerd.default
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

// Every named export of auth.workerd-harness.ts. A harness test missing from this list
// fails the "exactly these tests ran" check below, so none is silently skipped.
const HARNESS_TESTS = [
  'tokenRequestInitIsValidInWorkerd',
  'callbackSignsInWithTheRuntimeFetch',
  'callbackRefusesATokenEndpointRedirect',
  'callbackTurnsAGoogleRejectionInto502',
]

// Stands in for every host the harness fetches. The token endpoint replies with the
// {status, headers, body} encoded in the authorization code, plus X-Mock-Saw (what
// arrived on the wire). Any other URL replies with the JSON in its ?reply= parameter:
// that is the target of the harness's redirect scenario.
const GOOGLE_MOCK = `
function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return new TextDecoder().decode(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0)))
}
export default {
  async fetch(request) {
    const url = new URL(request.url)
    let reply
    if (url.href === 'https://oauth2.googleapis.com/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text())
      reply = JSON.parse(fromB64url(form.get('code') ?? ''))
      const saw = [request.method, request.headers.get('Content-Type'), form.get('grant_type'), form.get('client_id')]
      reply.headers = { ...reply.headers, 'X-Mock-Saw': saw.join(' ') }
    } else if (url.searchParams.has('reply')) {
      reply = JSON.parse(url.searchParams.get('reply'))
    } else {
      reply = { status: 599, body: 'mock: unexpected ' + request.method + ' ' + url.href }
    }
    return new Response(reply.body ?? null, { status: reply.status, headers: reply.headers })
  },
}
`

/** compatibility_date and compatibility_flags from wrangler.toml (the deployed runtime settings). */
function wranglerCompat() {
  const toml = readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8')
  const date = toml.match(/^\s*compatibility_date\s*=\s*"([^"]+)"/m)?.[1]
  if (!date) throw new Error('wrangler.toml has no compatibility_date')
  const flagsRaw = toml.match(/^\s*compatibility_flags\s*=\s*\[([^\]]*)\]/m)?.[1] ?? ''
  const flags = [...flagsRaw.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  return { date, flags }
}

function transpile(file) {
  const source = readFileSync(path.join(HERE, file), 'utf8')
  return ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
}

function capnp({ date, flags }) {
  const compat = `compatibilityDate = "${date}",\n  compatibilityFlags = [${flags.map((f) => JSON.stringify(f)).join(', ')}],`
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "harness", worker = .harness),
    (name = "google", worker = .google),
  ],
);

const harness :Workerd.Worker = (
  modules = [
    (name = "harness.js", esModule = embed "harness.js"),
    (name = "auth", esModule = embed "auth.js"),
  ],
  ${compat}
  globalOutbound = "google",
);

const google :Workerd.Worker = (
  modules = [(name = "google.js", esModule = embed "google.js")],
  ${compat}
);
`
}

describe('auth gate inside workerd (the Workers runtime)', () => {
  let dir
  let run

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gss-auth-workerd-'))
    writeFileSync(path.join(dir, 'auth.js'), transpile('auth.ts'))
    writeFileSync(path.join(dir, 'harness.js'), transpile('auth.workerd-harness.ts'))
    writeFileSync(path.join(dir, 'google.js'), GOOGLE_MOCK)
    writeFileSync(path.join(dir, 'config.capnp'), capnp(wranglerCompat()))
    const r = spawnSync(WORKERD_BIN, ['test', 'config.capnp'], { cwd: dir, encoding: 'utf8', timeout: 60_000 })
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\nspawn error: ${r.error.message}` : ''}`
    run = {
      status: r.status,
      output,
      passed: [...output.matchAll(/\[ PASS \] harness:(\w+)/g)].map((m) => m[1]),
      ran: [...output.matchAll(/\[ TEST \] harness:(\w+)/g)].map((m) => m[1]),
    }
  }, 90_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it.each(HARNESS_TESTS)('%s passes in workerd', (name) => {
    expect(run.passed, `workerd output:\n${run.output}`).toContain(name)
  })

  it('ran exactly the listed harness tests, and workerd exited 0', () => {
    expect([...run.ran].sort(), `workerd output:\n${run.output}`).toEqual([...HARNESS_TESTS].sort())
    expect(run.status, `workerd output:\n${run.output}`).toBe(0)
  })
})
