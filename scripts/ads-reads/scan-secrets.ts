// scan-secrets — checks files (logs, CLI output, reports) for any Google Ads credential value or
// the Cloudflare token, WITHOUT printing either: it loads the values into memory (bws, and
// --cf-token-file), then prints only "<file>: clean" or "<file>: CONTAINS <n> secret value(s)".
//
//   npx tsx scripts/ads-reads/scan-secrets.ts [--cf-token-file <path>] <file> [<file> …]

import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { fail, loadCfToken } from './cli'
import { loadAdsCredentials } from './secrets'

async function main() {
  const { values, positionals } = parseArgs({ options: { 'cf-token-file': { type: 'string' } }, allowPositionals: true, strict: true })
  const secrets = [...Object.values(await loadAdsCredentials())]
  const cf = loadCfToken(values['cf-token-file'])
  if (cf) secrets.push(cf)
  let dirty = 0
  for (const f of positionals) {
    const text = fs.readFileSync(f, 'utf8')
    const hits = secrets.filter((s) => s.length >= 6 && text.includes(s)).length
    if (hits) dirty++
    process.stdout.write(`${f}: ${hits ? `CONTAINS ${hits} secret value(s)` : 'clean'}\n`)
  }
  process.stdout.write(`${positionals.length} file(s) scanned against ${secrets.length} secret value(s); ${dirty} dirty\n`)
  if (dirty) process.exitCode = 1
}

main().catch(fail)
