// Google Ads API credentials, held in process memory ONLY: never printed, logged, returned in
// the JSON block, passed on a command line, or written to disk. Two sources, in this order:
//  1. Bitwarden Secrets Manager (`bws secret list`) when BWS_ACCESS_TOKEN is set — the local
//     default, unchanged.
//  2. Otherwise plain env vars, for the claude.ai cloud routine, which has no bws. Either
//     ADS_SA_B64 (a read-only service account's JSON key, base64 on one line, signed in with an
//     RS256 JWT for the adwords scope) plus ADS_DEVELOPER_TOKEN, or all four of ADS_CLIENT_ID /
//     ADS_CLIENT_SECRET / ADS_REFRESH_TOKEN / ADS_DEVELOPER_TOKEN (the gss-stats-sync Worker's
//     binding names, workers/sync/wrangler.toml). ADS_SA_B64 wins when it is set.
// Either way every value is registered with redact(), and errors name variables, never values.
//
// `bws secret list` prints every secret the machine account can see, so its stdout is parsed
// here and dropped — only the four keys below are kept, and each is registered with
// redact() so it is masked if it ever shows up in an error string.

import { execFile } from 'node:child_process'
import { registerSecret, redactedFirstLine } from '../../src/lib/adsRedact'
import { EXTERNAL_TIMEOUT_MS, TIMED_OUT_TEXT } from './wrangler'
import type { AdsAuth, AdsCredentials, AdsTokenAuth } from '../../src/lib/adsApi'
import { ADWORDS_SCOPE, serviceAccountAccessToken, type ServiceAccountKey } from './googleSa'

export type { AdsCredentials }

export const BWS_KEYS: Record<keyof AdsCredentials, string> = {
  clientId: 'google-ads-api-rep-client-id',
  clientSecret: 'google-ads-api-rep-client-secret',
  refreshToken: 'google-ads-api-rep-refresh-token',
  developerToken: 'google-ads-api-rep-developer-token',
}

/** Env var per field: the sync Worker's secrets_store_secrets binding names, one to one. */
export const ENV_KEYS: Record<keyof AdsCredentials, string> = {
  clientId: 'ADS_CLIENT_ID',
  clientSecret: 'ADS_CLIENT_SECRET',
  refreshToken: 'ADS_REFRESH_TOKEN',
  developerToken: 'ADS_DEVELOPER_TOKEN',
}

type Env = Record<string, string | undefined>

/** Reads the four Ads fields from env vars. Pure (no registration), for tests. `missing` holds
 * variable NAMES only. A blank or whitespace-only value counts as missing. */
export function adsCredentialsFromEnv(env: Env): { creds: AdsCredentials | null; missing: string[] } {
  const missing = Object.values(ENV_KEYS).filter((name) => !env[name]?.trim())
  if (missing.length) return { creds: null, missing }
  const creds = Object.fromEntries(Object.entries(ENV_KEYS).map(([field, name]) => [field, env[name]!.trim()])) as unknown as AdsCredentials
  return { creds, missing: [] }
}

/** The error when neither source is usable: variable NAMES only. */
export function missingAdsCredentialsMessage(missingEnv: readonly string[]): string {
  return `no Google Ads credentials: set BWS_ACCESS_TOKEN (Bitwarden Secrets Manager), or ${ADS_SA_ENV} and ${ENV_KEYS.developerToken}, or all of ${Object.values(ENV_KEYS).join(', ')} (missing: ${missingEnv.join(', ')})`
}

/** The service-account alternative to the refresh-token env set. */
export const ADS_SA_ENV = 'ADS_SA_B64'
/** The env NAMES the service-account path needs, in report order. */
export const SA_ENV_NAMES = [ADS_SA_ENV, ENV_KEYS.developerToken] as const

/** Decodes ADS_SA_B64 in memory and registers the encoded value, the decoded JSON and its
 * private_key with redact() BEFORE anything else touches them. Errors name the variable only. */
export function adsServiceAccountFromEnv(env: Env): ServiceAccountKey {
  const b64 = env[ADS_SA_ENV]?.trim()
  if (!b64) throw new Error(`${ADS_SA_ENV} is not set`)
  registerSecret(b64)
  const json = Buffer.from(b64, 'base64').toString('utf8')
  registerSecret(json)
  let sa: any
  try {
    sa = JSON.parse(json)
  } catch {
    throw new Error(`${ADS_SA_ENV} service account unreadable`)
  }
  if (typeof sa?.private_key === 'string') registerSecret(sa.private_key)
  if (typeof sa?.private_key !== 'string' || typeof sa?.client_email !== 'string' || !sa.private_key || !sa.client_email) {
    throw new Error(`${ADS_SA_ENV} service account unreadable (missing client_email/private_key)`)
  }
  return { client_email: sa.client_email, private_key: sa.private_key }
}

/** The service-account sign-in for the Ads client. Pure apart from registering secrets. */
export function adsServiceAccountAuth(env: Env): AdsTokenAuth {
  const developerToken = env[ENV_KEYS.developerToken]?.trim()
  if (!developerToken) throw new Error(missingAdsCredentialsMessage([ENV_KEYS.developerToken]))
  registerSecret(developerToken)
  const sa = adsServiceAccountFromEnv(env)
  return { developerToken, accessToken: (fetchImpl) => serviceAccountAccessToken(sa, ADWORDS_SCOPE, fetchImpl) }
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

export type BwsRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

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

/** Which source loadAdsAuth() will use for this env (no I/O): bws, the service account
 * (env-sa), the refresh-token env set (env), or none. */
export function adsCredentialSource(env: Env = process.env): 'bws' | 'env-sa' | 'env' | null {
  if (env.BWS_ACCESS_TOKEN) return 'bws'
  if (env[ADS_SA_ENV]?.trim()) return 'env-sa'
  return adsCredentialsFromEnv(env).creds ? 'env' : null
}

/** What the reads use: bws (local default), else ADS_SA_B64 + ADS_DEVELOPER_TOKEN, else the
 * refresh-token env set. Every value is registered with redact() before any use. */
export async function loadAdsAuth(opts: { env?: Env; runBws?: BwsRunner } = {}): Promise<AdsAuth> {
  const env = opts.env ?? process.env
  if (!env.BWS_ACCESS_TOKEN && env[ADS_SA_ENV]?.trim()) {
    if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
      process.stderr.write('note: GOOGLE_ADS_LOGIN_CUSTOMER_ID is set in the environment and is ignored (no login-customer-id header is ever sent)\n')
    }
    return adsServiceAccountAuth(env)
  }
  return loadAdsCredentials(opts)
}

/** The refresh-token credentials only (bws or the ADS_* env set); worker-secrets uses this.
 * `opts` is for tests only: the env to read and a stand-in for the bws binary. */
export async function loadAdsCredentials(opts: { env?: Env; runBws?: BwsRunner } = {}): Promise<AdsCredentials> {
  const env = opts.env ?? process.env
  if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    // Never used: the routine queries customer 8726535246 directly, with no manager header.
    process.stderr.write('note: GOOGLE_ADS_LOGIN_CUSTOMER_ID is set in the environment and is ignored (no login-customer-id header is ever sent)\n')
  }
  if (!env.BWS_ACCESS_TOKEN) {
    const { creds, missing } = adsCredentialsFromEnv(env)
    if (!creds) throw new Error(missingAdsCredentialsMessage(missing))
    for (const v of Object.values(creds)) registerSecret(v)
    return creds
  }
  const res = await (opts.runBws ?? runBws)(['secret', 'list', '--output', 'json', '--color', 'no'])
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
