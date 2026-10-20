// The Cloudflare account id for the local CLIs (cloud-mint, cloud-env, worker-secrets). It is env
// data, so it is read at run time and never kept in this public repo (README "Environment data"):
//  1. CLOUDFLARE_ACCOUNT_ID from the environment (wrangler's own variable; the cloud routine's
//     environment sets it),
//  2. else Bitwarden prod, key infra--cloud-routine-env--CLOUDFLARE_ACCOUNT_ID (the same key
//     ads:cloud-env copies into the cloud routine's environment), when BWS_ACCESS_TOKEN is set.
// Errors name the variable and the key, never a value.

import { findBwsToken } from './bwsToken'
import { cloudEnvKey, prodProjectId, prodSecrets, runBwsBinary } from './bwsProd'
import type { BwsRunner } from './secrets'

export const CF_ACCOUNT_ENV = 'CLOUDFLARE_ACCOUNT_ID'
export const CF_ACCOUNT_BWS_KEY = cloudEnvKey(CF_ACCOUNT_ENV)

/** A Cloudflare account id is 32 lowercase hex characters; anything else is refused. */
export function parseCfAccountId(value: string | undefined): string | null {
  const id = (value ?? '').trim().toLowerCase()
  return /^[0-9a-f]{32}$/.test(id) ? id : null
}

type Env = Record<string, string | undefined>

/** The account id from the environment, else from Bitwarden prod. Throws naming the sources. */
export async function resolveCfAccountId(opts: { env?: Env; bws?: BwsRunner } = {}): Promise<string> {
  const env = opts.env ?? process.env
  const raw = env[CF_ACCOUNT_ENV]
  if (raw !== undefined && raw.trim()) {
    const id = parseCfAccountId(raw)
    if (!id) throw new Error(`${CF_ACCOUNT_ENV} is set but is not a 32-hex Cloudflare account id`)
    return id
  }
  if (!opts.bws && !findBwsToken(env)) throw new Error(`no Cloudflare account id: set ${CF_ACCOUNT_ENV}, or BWS_ACCESS_TOKEN (or the file ~/.bws-token) so it is read from bws prod ${CF_ACCOUNT_BWS_KEY}`)
  const bws = opts.bws ?? runBwsBinary
  const secrets = await prodSecrets(bws, await prodProjectId(bws))
  const id = parseCfAccountId(secrets.get(CF_ACCOUNT_BWS_KEY))
  secrets.clear()
  if (!id) throw new Error(`no Cloudflare account id: bws prod ${CF_ACCOUNT_BWS_KEY} is missing or not 32 hex (or set ${CF_ACCOUNT_ENV})`)
  return id
}
