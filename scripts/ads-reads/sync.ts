// ads:sync — run ONLY the shared sync (src/lib/adsSync.ts syncAdsData): pull every missing
// closed ET day of Google Ads metrics (and placement-day rows) into gss-stats-ads, re-pull the
// restatement window, write only what changed, and record one ads_sync_runs row.
//
//   npm run ads:sync -- [--dry-run] [--cf-token-file <path>] [--only <campaignId>] [--full]
//                       [--no-placements] [--json-only]
//
// The same function the morning read, the backstop, the post-flight read, the backfill and the
// gss-stats-sync Worker run, so a second run in a row writes no metric row (only its own
// sync-run row). READ-ONLY toward Google Ads (GAQL SELECTs); nothing here changes a campaign.

import { parseArgs } from 'node:util'
import { syncAdsData, syncableCampaigns, syncSummaryLines } from '../../src/lib/adsSync'
import { adsSource, fail, liveAdsClient, loadCfToken } from './cli'
import { createD1Store } from './d1Store'
import { createWranglerRunner } from './wrangler'

const HELP = 'ads:sync [--dry-run] [--cf-token-file <path>] [--only <campaignId>] [--full] [--no-placements] [--json-only]'

async function main() {
  const { values: opts } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'cf-token-file': { type: 'string' },
      only: { type: 'string' },
      full: { type: 'boolean', default: false },
      'no-placements': { type: 'boolean', default: false },
      'json-only': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (opts.help) {
    process.stdout.write(HELP + '\n')
    return
  }
  const dryRun = !!opts['dry-run']
  const campaignIds = opts.only ? [opts.only] : undefined
  syncableCampaigns(campaignIds) // refuses an unknown --only before any credential is loaded
  const run = createWranglerRunner({ cfToken: loadCfToken(opts['cf-token-file']) })
  const store = createD1Store({ run, dryRun })
  const { ads, adsInitError } = await liveAdsClient()
  const result = await syncAdsData(
    { ads: ads ? adsSource(ads) : null, adsInitError, store },
    { campaignIds, now: Date.now(), dryRun, source: 'ads-sync', full: !!opts.full, placements: !opts['no-placements'] },
  )
  // The JSON carries counts and ranges only (no fetched rows).
  const json = { tool: 'ads-sync', ...result, campaigns: result.campaigns.map(({ spend: _s, placements: _p, ...c }) => c) }
  process.stdout.write(opts['json-only'] ? JSON.stringify(json, null, 2) + '\n' : `${syncSummaryLines(result).join('\n')}\n\n----- JSON -----\n${JSON.stringify(json, null, 2)}\n`)
  if (result.status === 'failed') process.exitCode = 1
}

main().catch(fail)
