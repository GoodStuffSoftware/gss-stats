// ads:cloud-check — preflight for running the ads reads from plain env vars (the claude.ai cloud
// routine). One line per dependency: each required env var NAME as present|missing, then
// ok|fail: <error class> for ONE minimal READ-ONLY probe:
//
//   ads       GAQL `SELECT customer.id FROM customer LIMIT 1` (adsApi.ts createAdsClient)
//   firestore one COUNT aggregation the post-flight read already runs (firebase.ts)
//   d1-ads    `SELECT 1` on gss-stats-ads (d1Store.ts wranglerAdsDb)
//   d1-beacon `SELECT 1` on gss-geo (d1.ts createD1Select)
//
//   npm run ads:cloud-check
//
// It NEVER prints a value, token, id, count or error message: the error class is chosen from a
// fixed list (errorClass below), so nothing a remote service says can reach stdout. Exits 1 if
// any line fails. Writes nothing anywhere.

import { pathToFileURL } from 'node:url'
import { createAdsClient } from '../../src/lib/adsApi'
import { loadCfToken } from './cli'
import { createD1Select, BEACON_DB } from './d1'
import { wranglerAdsDb } from './d1Store'
import { FIRESTORE_SA_ENV, probeFirestoreCount, serviceAccountFromEnv } from './firebase'
import { adsCredentialSource, ENV_KEYS, loadAdsCredentials } from './secrets'
import { createWranglerRunner, EXTERNAL_TIMEOUT_MS } from './wrangler'

type Env = Record<string, string | undefined>

export const CF_ENV = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] as const

export interface CloudCheckProbes {
  ads(): Promise<void>
  firestore(): Promise<void>
  d1Ads(): Promise<void>
  d1Beacon(): Promise<void>
}

export const ERROR_CLASSES = ['missing-env', 'auth', 'timeout', 'network', 'http-4xx', 'http-5xx', 'bad-credential', 'wrangler-missing', 'wrangler-exit', 'bad-response', 'error'] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]

/** Maps any failure to a fixed label. Only the label is ever printed, never the message. */
export function errorClass(e: unknown): ErrorClass {
  const m = e instanceof Error ? e.message : String(e)
  if (/timed out/i.test(m)) return 'timeout'
  if (/OAuth refresh failed|token exchange failed|invalid_grant|UNAUTHENTICATED|PERMISSION_DENIED|HTTP 40[13]\b|Authentication error|\[code: 10000\]/i.test(m)) return 'auth'
  if (/unreadable|missing project_id|no Google Ads credentials|BWS_ACCESS_TOKEN|Bitwarden is missing/i.test(m)) return 'bad-credential'
  if (/HTTP 4\d\d\b/.test(m)) return 'http-4xx'
  if (/HTTP 5\d\d\b/.test(m)) return 'http-5xx'
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(m)) return 'network'
  if (/not installed in this checkout/i.test(m)) return 'wrangler-missing'
  if (/wrangler d1 execute.*failed \(exit/i.test(m)) return 'wrangler-exit'
  if (/not JSON|Unexpected token|returned no|JSON/i.test(m)) return 'bad-response'
  return 'error'
}

interface CheckSpec {
  label: string
  /** Every env var NAME the line reports on. */
  names: readonly string[]
  /** Names that must be present for the probe to run; null = run regardless. */
  required: readonly string[]
  probe: () => Promise<void>
}

function specs(env: Env, probes: CloudCheckProbes): CheckSpec[] {
  const adsNames = Object.values(ENV_KEYS)
  const viaBws = adsCredentialSource(env) === 'bws'
  return [
    // With BWS_ACCESS_TOKEN set the CLI takes the bws path (the local default), so the ADS_*
    // names are reported but not required.
    { label: 'ads', names: viaBws ? [...adsNames, 'BWS_ACCESS_TOKEN'] : adsNames, required: viaBws ? ['BWS_ACCESS_TOKEN'] : adsNames, probe: probes.ads },
    { label: 'firestore', names: [FIRESTORE_SA_ENV], required: [FIRESTORE_SA_ENV], probe: probes.firestore },
    { label: 'd1-ads', names: CF_ENV, required: CF_ENV, probe: probes.d1Ads },
    { label: 'd1-beacon', names: CF_ENV, required: CF_ENV, probe: probes.d1Beacon },
  ]
}

const present = (env: Env, name: string) => !!env[name]?.trim()

/** Runs every probe (sequentially) and returns the printable lines. Pure apart from the probes. */
export async function runCloudCheck(env: Env, probes: CloudCheckProbes): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = []
  let ok = true
  for (const s of specs(env, probes)) {
    const vars = s.names.map((n) => `${n}=${present(env, n) ? 'present' : 'missing'}`).join(' ')
    let result: string
    if (s.required.some((n) => !present(env, n))) result = 'fail: missing-env'
    else {
      try {
        await s.probe()
        result = 'ok'
      } catch (e) {
        result = `fail: ${errorClass(e)}`
      }
    }
    if (result !== 'ok') ok = false
    lines.push(`${s.label.padEnd(9)} ${vars} -> ${result}`)
  }
  return { lines, ok }
}

/** The real probes, built from the same constructors the reads use. The Cloudflare token comes
 * from CLOUDFLARE_API_TOKEN through loadCfToken (registered with redact()); wrangler inherits
 * CLOUDFLARE_ACCOUNT_ID from the environment. */
export function liveProbes(): CloudCheckProbes {
  const run = createWranglerRunner({ cfToken: loadCfToken(undefined) })
  return {
    async ads() {
      const client = await createAdsClient(await loadAdsCredentials(), { timeoutMs: EXTERNAL_TIMEOUT_MS })
      await client.search('SELECT customer.id FROM customer LIMIT 1')
    },
    async firestore() {
      const source = serviceAccountFromEnv()
      if (!source) throw new Error(`${FIRESTORE_SA_ENV} unreadable`)
      await probeFirestoreCount(source)
    },
    async d1Ads() {
      await wranglerAdsDb(run).all({ sql: 'SELECT 1', binds: [] })
    },
    async d1Beacon() {
      await createD1Select(run, BEACON_DB)('SELECT 1')
    },
  }
}

async function main() {
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    process.stdout.write('ads:cloud-check — env var presence + one read-only probe each for ads, firestore, d1-ads, d1-beacon. Prints names and ok|fail only.\n')
    return
  }
  const { lines, ok } = await runCloudCheck(process.env, liveProbes())
  process.stdout.write(lines.join('\n') + '\n')
  if (!ok) process.exitCode = 1
}

// Only when run directly (tests import runCloudCheck/errorClass).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Never print the message: it could carry anything a remote service said.
    process.stderr.write('error: ads:cloud-check crashed\n')
    process.exit(1)
  })
}
