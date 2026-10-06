// Bitwarden Secrets Manager helpers for the cloud-routine keys (cloud-mint.ts, cloud-env.ts).
// Every call runs the bws binary through execFile inside this process (windowsHide, no shell).
// Values are read into memory only: stdout is parsed here and dropped, and nothing a value
// touches is ever printed. Errors carry the redacted first stderr line, never stdout.

import { execFile } from 'node:child_process'
import { redactedFirstLine, registerSecret } from '../../src/lib/adsRedact'
import { EXTERNAL_TIMEOUT_MS, TIMED_OUT_TEXT } from './wrangler'
import type { BwsRunner } from './secrets'

/** The bws project every cloud-routine key lives in. */
export const PROD_PROJECT_NAME = 'prod'
/** The existing naming convention for cloud environment values. */
export const cloudEnvKey = (envVar: string) => `infra--cloud-routine-env--${envVar}`

export function runBwsBinary(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  registerSecret(process.env.BWS_ACCESS_TOKEN)
  const bin = process.env.BWS_BIN || 'bws'
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: process.env, timeout: EXTERNAL_TIMEOUT_MS }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
      if (e && e.killed) return resolve({ code: 124, stdout: '', stderr: `bws ${TIMED_OUT_TEXT}` })
      const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (e && e.code === 'ENOENT' ? 'bws binary not found on PATH' : '') })
    })
  })
}

function parseJsonArray(stdout: string, what: string): any[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`${what} returned output that is not JSON`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${what} did not return a list`)
  return parsed
}

/** The id of the one project named `prod`. Refuses when there is not exactly one. */
export async function prodProjectId(bws: BwsRunner): Promise<string> {
  const res = await bws(['project', 'list', '--output', 'json', '--color', 'no'])
  if (res.code !== 0) throw new Error(`bws project list failed (exit ${res.code}): ${redactedFirstLine(res.stderr)}`)
  const hits = parseJsonArray(res.stdout, 'bws project list').filter((p) => p && p.name === PROD_PROJECT_NAME && typeof p.id === 'string')
  if (hits.length !== 1) throw new Error(`expected exactly one bws project named ${PROD_PROJECT_NAME}, found ${hits.length}`)
  return hits[0].id
}

/** The prod project's secrets as key -> value, in memory. Keys that appear twice are refused
 * (ambiguous), since a wrong pick would hand the routine a stale credential. */
export async function prodSecrets(bws: BwsRunner, projectId: string): Promise<Map<string, string>> {
  const res = await bws(['secret', 'list', '--output', 'json', '--color', 'no', '--', projectId])
  if (res.code !== 0) throw new Error(`bws secret list failed (exit ${res.code}): ${redactedFirstLine(res.stderr)}`)
  const out = new Map<string, string>()
  const dup = new Set<string>()
  for (const s of parseJsonArray(res.stdout, 'bws secret list')) {
    if (!s || typeof s.key !== 'string' || typeof s.value !== 'string') continue
    if (s.projectId !== undefined && s.projectId !== projectId) continue
    if (out.has(s.key)) dup.add(s.key)
    out.set(s.key, s.value)
  }
  if (dup.size) throw new Error(`bws prod has more than one secret named: ${[...dup].join(', ')}`)
  return out
}

/** Creates KEY=VALUE in the prod project. The value goes to bws as an execFile argument from
 * this process (never a shell, stdout or a log); bws prints nothing (--output none). */
export async function createProdSecret(bws: BwsRunner, key: string, value: string, projectId: string): Promise<void> {
  // `--` ends the options, so a value that starts with '-' is never read as a flag.
  const res = await bws(['secret', 'create', '--output', 'none', '--color', 'no', '--', key, value, projectId])
  if (res.code !== 0) throw new Error(`bws secret create ${key} failed (exit ${res.code}): ${redactedFirstLine(res.stderr)}`)
}
