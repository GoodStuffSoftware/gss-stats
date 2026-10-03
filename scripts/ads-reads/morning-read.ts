// morning-read — the daily ads read for a registered campaign (the US+CA web retest: docs/routines/bsk-retest-morning-read.md).
//
//   npm run ads:morning-read -- [--campaign <id>] [--dry-run] [--cf-token-file <path>] [--firebase-sa <path>]
//                               [--release-health auto|skip] [--release-health-only]
//                               [--health-min-parent N] [--health-parent-age-hours N]
//                               [--fixture <file.json> [--now <iso>]] [--json-only]
//
// Fetches yesterday's and cumulative spend from the Google Ads API → stores it in gss-stats-ads
// → detects newly crossed thresholds ($25/$50/$75/$100, each fires once) → on a crossing runs
// the full read and the kill rules → always appends a daily reading line → release health
// (evaluated every run; no time-of-day gate — the retired 23:15 ET backstop entry is folded
// into this single daily read as of 2026-09-27). Prints a short report, then a JSON block.
// PROPOSES only.

import { MIN_COHORT } from '../../src/lib/popupEvents'
import { fail, fixtureDeps, liveDeps, loadFixture, parseCli, resolveCampaignId } from './cli'
import { runMorningRead } from './read'
import { formatMorningReport, withJson } from './report'

const HELP = `morning-read [--campaign <id>] [--dry-run] [--cf-token-file <path>] [--firebase-sa <path>] [--release-health auto|skip] [--release-health-only] [--health-min-parent N] [--health-parent-age-hours N] [--fixture <file.json> [--now <iso>]] [--json-only]`

async function main() {
  const opts = parseCli({
    'release-health': { type: 'string', default: 'auto' },
    'release-health-only': { type: 'boolean', default: false },
    'health-min-parent': { type: 'string', default: String(MIN_COHORT) },
    'health-parent-age-hours': { type: 'string', default: '24' },
  })
  if (opts.help) {
    process.stdout.write(HELP + '\n')
    return
  }
  const rh = opts['release-health']
  if (rh !== 'auto' && rh !== 'skip') throw new Error('--release-health must be auto or skip')
  const minParent = Number(opts['health-min-parent'])
  const ageHours = Number(opts['health-parent-age-hours'])
  if (!Number.isInteger(minParent) || minParent < 1) throw new Error('--health-min-parent must be a positive integer')
  if (!Number.isFinite(ageHours) || ageHours < 0) throw new Error('--health-parent-age-hours must be >= 0')

  const fx = opts.fixture ? loadFixture(opts.fixture as string) : null
  if (fx && opts.now) fx.now = opts.now as string
  const campaignId = resolveCampaignId(opts, 'morning', fx ? Date.parse(fx.now) : Date.now())
  const deps = fx ? fixtureDeps(fx, !!opts['dry-run']) : await liveDeps(opts)

  const result = await runMorningRead(deps, {
    campaignId,
    releaseHealth: rh,
    healthOnly: !!opts['release-health-only'],
    healthMinParent: minParent,
    healthParentAgeHours: ageHours,
  })
  process.stdout.write(opts['json-only'] ? JSON.stringify(result, null, 2) + '\n' : withJson(formatMorningReport(result), result))
}

main().catch(fail)
