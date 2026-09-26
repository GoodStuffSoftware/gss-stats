// backfill — a FULL re-pull of Google Ads daily metrics (and placement-day cost) for every
// configured campaign into gss-stats-ads, through the shared sync (src/lib/adsSync.ts
// syncAdsData with `full`), then checked against the hand-entered figures in lib/campaigns.ts
// (CAMPAIGN_DAILY_SPEND / CAMPAIGN_SPEND).
//
//   npm run ads:backfill -- [--dry-run] [--cf-token-file <path>] [--only <campaignId>] [--no-placements]
//
// READ-ONLY toward Google Ads (GAQL SELECTs). Reading closed campaigns' METRICS is allowed
// (owner, 2026-09-26); nothing here can change any campaign. The sync writes only rows that
// changed, so a rerun converges on the latest API numbers and is otherwise a no-op. Closed
// campaigns are read from flightStart to flightEnd + 3 days, so any stray spend after the
// flight shows up in the check.

import { parseArgs } from 'node:util'
import { compareSpendToConfig, type SpendComparison } from '../../src/lib/adsRules'
import { CAMPAIGN_DAILY_SPEND, CAMPAIGN_SPEND, campaignById } from '../../src/lib/campaigns'
import { syncAdsData, syncableCampaigns, syncSummaryLines } from '../../src/lib/adsSync'
import { adsSource, fail, liveAdsClient, loadCfToken } from './cli'
import { createD1Store } from './d1Store'
import { createWranglerRunner } from './wrangler'

async function main() {
  const { values: opts } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'cf-token-file': { type: 'string' },
      only: { type: 'string' },
      'no-placements': { type: 'boolean', default: false },
    },
    strict: true,
  })
  const dryRun = !!opts['dry-run']
  const campaignIds = opts.only ? [opts.only] : undefined
  if (!syncableCampaigns(campaignIds).length) throw new Error('no campaign matches --only')
  const run = createWranglerRunner({ cfToken: loadCfToken(opts['cf-token-file']) })
  const store = createD1Store({ run, dryRun })
  const { ads, adsInitError } = await liveAdsClient()
  if (!ads) throw new Error(`Google Ads client unavailable: ${adsInitError}`)

  const sync = await syncAdsData(
    { ads: adsSource(ads), store },
    { campaignIds, now: Date.now(), dryRun, source: 'backfill', full: true, placements: !opts['no-placements'] },
  )
  const results = sync.campaigns.map((r) => {
    const c = campaignById(r.campaignId)!
    const comparison: SpendComparison | null = r.spend ? compareSpendToConfig(c, r.spend.days, CAMPAIGN_DAILY_SPEND[c.id], CAMPAIGN_SPEND[c.id] ?? null) : null
    const { spend: _s, placements: _p, ...rest } = r
    return { ...rest, comparison }
  })

  const lines = [`Ads backfill into gss-stats-ads (full re-pull through the shared sync)`, ...syncSummaryLines(sync)]
  for (const r of results) {
    const cmp = r.comparison
    if (!cmp) continue
    lines.push(`- ${r.campaignId} ${r.label}:`)
    lines.push(`    API total $${cmp.apiTotal.toFixed(2)} vs config ${cmp.configTotal == null ? '(none)' : `$${cmp.configTotal.toFixed(2)}`}${cmp.totalDiff == null ? '' : ` (diff ${cmp.totalDiff >= 0 ? '+' : ''}${cmp.totalDiff.toFixed(2)})`}; config daily lines sum ${cmp.configDailySum == null ? '(none)' : `$${cmp.configDailySum.toFixed(2)}`}`)
    lines.push(cmp.dayDiffs.length ? `    day differences: ${cmp.dayDiffs.map((d) => `${d.date} api ${d.api ?? '—'} vs config ${d.config ?? '—'}`).join('; ')}` : '    every day matches the config lines')
    if (cmp.outsideFlight.length) lines.push(`    spend outside the flight window: ${cmp.outsideFlight.map((d) => `${d.date} $${d.api.toFixed(2)}`).join('; ')}`)
  }
  const { campaigns: _c, ...syncMeta } = sync
  process.stdout.write(`${lines.join('\n')}\n\n----- JSON -----\n${JSON.stringify({ tool: 'ads-backfill', ...syncMeta, results }, null, 2)}\n`)
  if (sync.status === 'failed') process.exitCode = 1
}

main().catch(fail)
