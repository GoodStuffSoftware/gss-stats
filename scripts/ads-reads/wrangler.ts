// Runs the repo's own wrangler (node_modules/wrangler/bin/wrangler.js) with process.execPath —
// no shell, so SQL and JSON arguments are passed as argv verbatim (no quoting or injection
// surface), and no dependency on npx/PATH on Windows.
//
// The Cloudflare API token, when supplied, goes into the CHILD's environment only. It is read
// from --cf-token-file into memory by the CLI (see cli.ts) and never printed.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export interface WranglerResult {
  code: number
  stdout: string
  stderr: string
}
export type WranglerRunner = (args: string[]) => Promise<WranglerResult>

export function createWranglerRunner(opts: { cfToken?: string | null; root?: string } = {}): WranglerRunner {
  const root = opts.root ?? repoRoot()
  const entry = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  return (args: string[]) =>
    new Promise((resolve) => {
      if (!fs.existsSync(entry)) {
        resolve({ code: 127, stdout: '', stderr: `wrangler not installed at ${entry} (run npm ci)` })
        return
      }
      const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0' }
      if (opts.cfToken) env.CLOUDFLARE_API_TOKEN = opts.cfToken
      const child = spawn(process.execPath, [entry, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('error', (e) => resolve({ code: 1, stdout, stderr: stderr + String(e) }))
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    })
}
