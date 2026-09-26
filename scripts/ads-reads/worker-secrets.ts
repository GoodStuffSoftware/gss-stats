// ads:worker-secrets — copy the four Google Ads API credentials from Bitwarden Secrets Manager
// (the source of truth) into Cloudflare Secrets Store, where the gss-stats-sync Worker reads
// them through its secrets_store_secrets bindings (workers/sync/wrangler.toml).
//
//   npm run ads:worker-secrets -- --cf-token-file <path> [--dry-run]
//
// The values go bws → this process's memory → Cloudflare, and nowhere else: never printed,
// logged, written to disk or put on a command line.
//  - A secret that does not exist yet is CREATED by piping the value into
//    `wrangler secrets-store secret create … --remote` on stdin.
//  - One that exists is UPDATED (rotation) with the same Secrets Store API call wrangler makes,
//    from memory: `wrangler secrets-store secret update` cannot read a value from stdin
//    non-interactively (it asks a confirm that defaults to "no"), and `--value` would put the
//    secret on the command line.
// Output is one line per secret name: created / updated / unchanged-in-dry-run. Rerunning is
// safe (it re-sets the same values). Rotation: rotate in Bitwarden first, then run this; the
// Worker reads the new value on its next invocation (no redeploy).

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { redact, registerSecret } from '../../src/lib/adsRedact'
import type { AdsCredentials } from '../../src/lib/adsApi'
import { fail, loadCfToken } from './cli'
import { BWS_KEYS, loadAdsCredentials } from './secrets'
import { repoRoot } from './wrangler'

export const CF_ACCOUNT_ID = 'a32bba62c77df5e8f6bd33d04478ec34'
export const SECRETS_STORE_ID = 'deb0011dfe80443091c08d92874ddf06'
const API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/secrets_store/stores/${SECRETS_STORE_ID}/secrets`

async function api(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const j = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { code: number; message: string }[]; result?: unknown }
  if (!res.ok || j.success === false) throw new Error(`Secrets Store API ${method} failed: HTTP ${res.status} ${redact((j.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; '))}`)
  return j.result
}

/** Pipes `value` into `wrangler secrets-store secret create` on stdin. */
function createWithWrangler(name: string, value: string, token: string): Promise<{ code: number; message: string }> {
  const root = repoRoot()
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`${root}/node_modules/wrangler/bin/wrangler.js`, 'secrets-store', 'secret', 'create', SECRETS_STORE_ID, '--name', name, '--scopes', 'workers', '--comment', 'from Bitwarden via npm run ads:worker-secrets', '--remote'],
      { cwd: root, env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => {
      const line = out.split(/\r?\n/).find((l) => /Created secret|ERROR|error/i.test(l)) ?? ''
      resolve({ code: code ?? 1, message: redact(line.trim()).slice(0, 200) })
    })
    child.stdin.end(value)
  })
}

async function main() {
  const { values: opts } = parseArgs({ options: { 'cf-token-file': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } }, strict: true })
  const token = loadCfToken(opts['cf-token-file'])
  if (!token) throw new Error('needs a Cloudflare API token (--cf-token-file or CLOUDFLARE_API_TOKEN) with Secrets Store Edit')
  const creds = await loadAdsCredentials() // bws, in memory, each value registered with redact()
  const list = (await api(token, 'GET', '?per_page=100')) as { id: string; name: string }[]
  const existing = new Map(list.map((s) => [s.name, s.id]))
  const lines: string[] = []
  for (const [field, name] of Object.entries(BWS_KEYS) as [keyof AdsCredentials, string][]) {
    const value = creds[field]
    registerSecret(value)
    const id = existing.get(name)
    if (opts['dry-run']) {
      lines.push(`${name}: would be ${id ? 'updated' : 'created'} (dry run)`)
      continue
    }
    if (id) {
      await api(token, 'PATCH', `/${id}`, { value })
      lines.push(`${name}: updated`)
    } else {
      const r = await createWithWrangler(name, value, token)
      if (r.code !== 0) throw new Error(`creating ${name} failed (exit ${r.code}): ${r.message}`)
      lines.push(`${name}: created`)
    }
  }
  const after = (await api(token, 'GET', '?per_page=100')) as { name: string; scopes?: string[] }[]
  for (const name of Object.values(BWS_KEYS)) {
    const s = after.find((x) => x.name === name)
    lines.push(`  check ${name}: ${s ? `present, scopes ${(s.scopes ?? []).join(',') || '—'}` : 'MISSING'}`)
  }
  // Lines hold names and statuses only (a wrangler message is redacted where it is read);
  // belt and braces: refuse to print if a value somehow got in.
  const out = lines.join('\n')
  if (Object.values(creds).some((v) => out.includes(v))) throw new Error('refusing to print: output would contain a secret value')
  process.stdout.write(out + '\n')
}

main().catch(fail)
