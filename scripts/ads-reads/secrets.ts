// Google Ads API credentials from Bitwarden Secrets Manager (`bws secret list`), held in
// process memory ONLY: never printed, logged, returned in the JSON block, passed on a command
// line, or written to disk. `bws` authenticates with BWS_ACCESS_TOKEN from the environment.
//
// `bws secret list` prints every secret the machine account can see, so its stdout is parsed
// here and dropped — only the four keys below are kept, and each is registered with
// redact() so it is masked if it ever shows up in an error string.

import { execFile } from 'node:child_process'
import { registerSecret, redactedFirstLine } from './redact'
import { EXTERNAL_TIMEOUT_MS, TIMED_OUT_TEXT } from './wrangler'

export interface AdsCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
  developerToken: string
}

export const BWS_KEYS: Record<keyof AdsCredentials, string> = {
  clientId: 'google-ads-api-rep-client-id',
  clientSecret: 'google-ads-api-rep-client-secret',
  refreshToken: 'google-ads-api-rep-refresh-token',
  developerToken: 'google-ads-api-rep-developer-token',
}

/** Picks the four Ads keys out of a parsed `bws secret list` array. Pure, for tests. */
export function pickAdsCredentials(list: unknown): { creds: AdsCredentials | null; missing: string[] } {
  const byKey = new Map<string, string>()
  if (Array.isArray(list)) {
    for (const s of list) {
      if (s && typeof s === 'object' && typeof (s as any).key === 'string' && typeof (s as any).value === 'string') {
        byKey.set((s as any).key, (s as any).value)
      }
    }
  }
  const missing = Object.values(BWS_KEYS).filter((k) => !byKey.get(k))
  if (missing.length) return { creds: null, missing }
  const creds = Object.fromEntries(Object.entries(BWS_KEYS).map(([field, key]) => [field, byKey.get(key)!])) as unknown as AdsCredentials
  return { creds, missing: [] }
}

function runBws(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = process.env.BWS_BIN || 'bws'
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: process.env, timeout: EXTERNAL_TIMEOUT_MS }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null
      if (e && e.killed) {
        resolve({ code: 124, stdout: '', stderr: `bws ${TIMED_OUT_TEXT}` })
        return
      }
      const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (e && e.code === 'ENOENT' ? 'bws binary not found on PATH' : '') })
    })
  })
}

export async function loadAdsCredentials(): Promise<AdsCredentials> {
  if (!process.env.BWS_ACCESS_TOKEN) throw new Error('BWS_ACCESS_TOKEN is not set; cannot read the Google Ads credentials from Bitwarden Secrets Manager')
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    // Never used: the routine queries customer 8726535246 directly, with no manager header.
    process.stderr.write('note: GOOGLE_ADS_LOGIN_CUSTOMER_ID is set in the environment and is ignored (no login-customer-id header is ever sent)\n')
  }
  const res = await runBws(['secret', 'list', '--output', 'json', '--color', 'no'])
  if (res.code !== 0) throw new Error(`bws secret list failed (exit ${res.code}): ${redactedFirstLine(res.stderr)}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    throw new Error('bws secret list returned output that is not JSON')
  }
  const { creds, missing } = pickAdsCredentials(parsed)
  parsed = null
  if (!creds) throw new Error(`Bitwarden is missing: ${missing.join(', ')}`)
  for (const v of Object.values(creds)) registerSecret(v)
  return creds
}
