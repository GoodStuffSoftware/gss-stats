// Compares RANGE_LIMITS (functions/_lib/rangeGate.ts) with what Cloudflare's GraphQL Analytics
// API reports for this account, and exits 1 on any difference. Run it when the Cloudflare plan
// changes, or if charts start showing "Cloudflare analytics could not serve this range":
//
//   npm run limits:check
//
// The token and the account id are read from CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID, or from the
// gitignored .dev.vars (see README "Local development"). Neither is in this repo or ever printed;
// the token is only sent to Cloudflare's API.
import { existsSync, readFileSync } from 'node:fs'
import { RANGE_LIMITS } from '../functions/_lib/rangeGate'
import { cfAccountId } from '../functions/_lib/cfAccount'

function readVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name]!.trim()
  if (!existsSync('.dev.vars')) return undefined
  return readFileSync('.dev.vars', 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
}

const token = readVar('CF_ANALYTICS_TOKEN')
if (!token) {
  console.error('No CF_ANALYTICS_TOKEN in the environment or .dev.vars.')
  process.exit(2)
}
// The same secret functions/api/stats.ts reads (functions/_lib/cfAccount.ts).
const ACCOUNT_ID = cfAccountId({ CF_ACCOUNT_ID: readVar('CF_ACCOUNT_ID') })
if (!ACCOUNT_ID) {
  console.error('No CF_ACCOUNT_ID (32 hex) in the environment or .dev.vars.')
  process.exit(2)
}

let mismatches = 0
for (const [source, limit] of Object.entries(RANGE_LIMITS)) {
  const query = `query { viewer { accounts(filter:{accountTag:"${ACCOUNT_ID}"}) { settings { ${limit.dataset} { maxDuration notOlderThan } } } } }`
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = (await res.json()) as any
  const s = body?.data?.viewer?.accounts?.[0]?.settings?.[limit.dataset]
  if (!s) {
    console.error(`${source}: could not read settings.${limit.dataset} (HTTP ${res.status}).`)
    mismatches++
    continue
  }
  const live = { maxDurationDays: s.maxDuration / 86_400, notOlderThanDays: s.notOlderThan / 86_400 }
  for (const key of ['maxDurationDays', 'notOlderThanDays'] as const) {
    const ok = live[key] === limit[key]
    if (!ok) mismatches++
    console.log(`${ok ? 'ok      ' : 'MISMATCH'} ${source} ${key}: declared ${limit[key]}, Cloudflare says ${live[key]}`)
  }
}
process.exit(mismatches ? 1 : 0)
