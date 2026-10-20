// The Bitwarden Secrets Manager access token, in memory only. Sources, in order:
//  1. BWS_ACCESS_TOKEN, when set and non-empty (CI, one-off shells).
//  2. The file named by BWS_TOKEN_FILE, default ~/.bws-token, trimmed (the local default since
//     the token left the persistent User env var).
// Whichever is used is registered for redaction. The token is never printed or written, and it
// reaches the bws child only through that child's env (bwsChildEnv), never this process's env.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerSecret } from '../../src/lib/adsRedact'

type Env = Record<string, string | undefined>

export function bwsTokenFilePath(env: Env = process.env): string {
  // An injected env without BWS_TOKEN_FILE still honours the process-level override (tests rely on it).
  return env.BWS_TOKEN_FILE || process.env.BWS_TOKEN_FILE || path.join(os.homedir(), '.bws-token')
}

/** The token from env or file, or '' when neither has one. Registers a found token for redaction. */
export function findBwsToken(env: Env = process.env, opts: { useFile?: boolean } = {}): string {
  let token = (env.BWS_ACCESS_TOKEN ?? '').trim()
  if (!token && opts.useFile !== false) {
    try {
      token = fs.readFileSync(bwsTokenFilePath(env), 'utf8').trim()
    } catch {
      token = ''
    }
  }
  if (token) registerSecret(token)
  return token
}

/** Like findBwsToken, but throws a clear error (no value) naming both sources when neither has one. */
export function resolveBwsToken(env: Env = process.env): string {
  const token = findBwsToken(env)
  if (!token) {
    throw new Error(`No bws access token: BWS_ACCESS_TOKEN is not set (or empty) and the token file ${bwsTokenFilePath(env)} is missing, unreadable or empty.`)
  }
  return token
}

/** The env for a bws child: this process's env plus the token, in memory only. */
export function bwsChildEnv(token: string, base: Env = process.env): NodeJS.ProcessEnv {
  return token ? { ...base, BWS_ACCESS_TOKEN: token } : { ...base }
}
