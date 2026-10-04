// ads:play-sync — Google Play's per-day install totals into gss-stats-ads (ads_play_daily,
// migration 0005), for the Play tiles on the Retention page (retention build R-4).
//
//   npm run ads:play-sync -- --play-sa <service-account.json> [--dry-run] [--since YYYY-MM-DD]
//                            [--until YYYY-MM-DD] [--cf-token-file <path>]
//
// A MANUAL, LOCAL command: it needs Mike's Play service-account key (the same read-only key the
// morning read uses) and his Cloudflare token. Nothing in CI or the Worker runs it. Apply
// migration 0005 first (`npm run ads:migrate`); until then this fails, and the card shows
// "no Play figures yet" (the dashboard reads a missing table as empty).
//
// Idempotent (upserts on the Play day; Play re-posts days; a count a re-post leaves blank keeps its
// stored value). --dry-run reads Play, writes nothing and needs no Cloudflare token. Stores whole-app per-day totals only: no country or source split.
// Default start: the Play tracking go-live (2026-09-26). The CSV day is "as reported by Google
// Play": it is not confirmed to be an ET day.

import { parseArgs } from 'node:util'
import { ADS_DB_NAME } from '../../src/lib/adsStore'
import { fail, loadCfToken } from './cli'
import { wranglerAdsDb } from './d1Store'
import { readPlayReports } from './play'
import { cfTokenForSync, runPlaySync } from './playSyncCore'
import { createWranglerRunner } from './wrangler'

const HELP = 'ads:play-sync --play-sa <service-account.json> [--dry-run] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--cf-token-file <path>] [--json-only]'

async function main() {
  const { values: opts } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'play-sa': { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      'cf-token-file': { type: 'string' },
      'json-only': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (opts.help) {
    process.stdout.write(HELP + '\n')
    return
  }
  const saPath = opts['play-sa']
  if (!saPath) throw new Error('--play-sa <service-account.json> is required (the read-only Play key; see scripts/ads-reads/play.ts)')
  const run = createWranglerRunner({ cfToken: cfTokenForSync({ dryRun: !!opts['dry-run'], cfTokenFile: opts['cf-token-file'] }, loadCfToken) })
  const res = await runPlaySync({
    read: (o) => readPlayReports(saPath, o),
    db: wranglerAdsDb(run, ADS_DB_NAME),
    nowMs: Date.now(),
    dryRun: !!opts['dry-run'],
    since: opts.since,
    until: opts.until,
  })
  const { lines, ...rest } = res
  process.stdout.write(opts['json-only'] ? `${JSON.stringify({ tool: 'ads-play-sync', ...rest }, null, 2)}\n` : `${lines.join('\n')}\n`)
  if (!res.ok) process.exitCode = 1
}

main().catch(fail)
