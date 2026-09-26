// backfill — idempotent load of Google Ads daily metrics (and placement-day cost) for every
// configured campaign into gss-stats-ads, checked against the hand-entered figures in
// lib/campaigns.ts (CAMPAIGN_DAILY_SPEND / CAMPAIGN_SPEND).
//
//   npm run ads:backfill -- [--dry-run] [--cf-token-file <path>] [--only <campaignId>] [--no-placements]
//
// READ-ONLY toward Google Ads (GAQL SELECTs). Reading closed campaigns' METRICS is allowed
// (owner, 2026-09-26); nothing here can change any campaign. Every write is an upsert, so a
// rerun converges on the latest API numbers. Closed campaigns are read from flightStart to
// flightEnd + 3 days, so any stray spend after the flight shows up in the check.

import { parseArgs } from 'node:util'
import { compareSpendToConfig, type SpendComparison } from '../../src/lib/adsRules'
import type { PlacementDayRow } from '../../src/lib/adsStore'
import { CAMPAIGN_DAILY_SPEND, CAMPAIGN_SPEND, CAMPAIGNS } from '../../src/lib/campaigns'
import { etDateFromMs } from '../../src/lib/popupEvents'
import { addEtDays } from '../../src/lib/overview'
import { fetchDailySpend, fetchPlacementDaily } from './adsApi'
import { fail, liveAdsClient, loadCfToken } from './cli'
import { createD1Store } from './d1Store'
import { redact } from './redact'
import { createWranglerRunner } from './wrangler'

interface CampaignBackfill {
  campaignId: string
  label: string
  range: { since: string; until: string }
  days: number
  placementRows: number | null
  comparison: SpendComparison | null
  written: { metrics: boolean; placements: boolean }
  errors: string[]
}

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
  const nowMs = Date.now()
  const todayEt = etDateFromMs(nowMs)
  const fetchedAt = new Date(nowMs).toISOString()
  const run = createWranglerRunner({ cfToken: loadCfToken(opts['cf-token-file']) })
  const store = createD1Store({ run, dryRun })
  const { ads, adsInitError } = await liveAdsClient()
  if (!ads) throw new Error(`Google Ads client unavailable: ${adsInitError}`)

  const targets = CAMPAIGNS.filter((c) => c.flightStart != null && (!opts.only || c.id === opts.only))
  if (!targets.length) throw new Error('no campaign matches --only')
  const synced = await store.syncCampaigns(CAMPAIGNS.filter((c) => c.flightStart != null), fetchedAt)

  const results: CampaignBackfill[] = []
  for (const c of targets) {
    const until = c.status === 'closed' ? addEtDays(c.flightEnd, 3) : todayEt
    const range = { since: c.flightStart!, until: until < todayEt ? until : todayEt }
    const r: CampaignBackfill = { campaignId: c.id, label: c.label, range, days: 0, placementRows: null, comparison: null, written: { metrics: false, placements: false }, errors: [] }
    try {
      const days = await fetchDailySpend(ads, c.id, range.since, range.until)
      r.days = Object.keys(days).length
      r.comparison = compareSpendToConfig(c, days, CAMPAIGN_DAILY_SPEND[c.id], CAMPAIGN_SPEND[c.id] ?? null)
      r.written.metrics = await store.putDailyMetrics(c.id, days, fetchedAt)
    } catch (e) {
      r.errors.push(`daily: ${redact(e)}`)
    }
    if (!opts['no-placements']) {
      try {
        const rows: PlacementDayRow[] = await fetchPlacementDaily(ads, c.id, range.since, range.until)
        r.placementRows = rows.length
        r.written.placements = await store.putPlacements(c.id, rows, fetchedAt)
      } catch (e) {
        r.errors.push(`placements: ${redact(e)}`)
      }
    }
    results.push(r)
  }

  const lines = [`Ads backfill into gss-stats-ads, ${fetchedAt}${dryRun ? ' [DRY RUN: nothing written]' : ''}; campaigns table ${synced ? 'synced' : dryRun ? 'not synced (dry run)' : 'NOT synced'}`]
  for (const r of results) {
    const cmp = r.comparison
    lines.push(`- ${r.campaignId} ${r.label} (${r.range.since}..${r.range.until}): ${r.days} day rows, ${r.placementRows ?? '—'} placement-day rows; metrics ${r.written.metrics ? 'written' : 'not written'}, placements ${r.written.placements ? 'written' : 'not written'}`)
    if (cmp) {
      lines.push(`    API total $${cmp.apiTotal.toFixed(2)} vs config ${cmp.configTotal == null ? '(none)' : `$${cmp.configTotal.toFixed(2)}`}${cmp.totalDiff == null ? '' : ` (diff ${cmp.totalDiff >= 0 ? '+' : ''}${cmp.totalDiff.toFixed(2)})`}; config daily lines sum ${cmp.configDailySum == null ? '(none)' : `$${cmp.configDailySum.toFixed(2)}`}`)
      lines.push(cmp.dayDiffs.length ? `    day differences: ${cmp.dayDiffs.map((d) => `${d.date} api ${d.api ?? '—'} vs config ${d.config ?? '—'}`).join('; ')}` : '    every day matches the config lines')
      if (cmp.outsideFlight.length) lines.push(`    spend outside the flight window: ${cmp.outsideFlight.map((d) => `${d.date} $${d.api.toFixed(2)}`).join('; ')}`)
    }
    for (const e of r.errors) lines.push(`    error: ${e}`)
  }
  process.stdout.write(`${lines.join('\n')}\n\n----- JSON -----\n${JSON.stringify({ tool: 'ads-backfill', dryRun, fetchedAt, synced, results }, null, 2)}\n`)
}

main().catch(fail)
