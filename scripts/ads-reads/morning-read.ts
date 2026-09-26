// morning-read — the daily ads read for the US+CA web retest (docs/routines/bsk-retest-morning-read.md).
//
//   npm run ads:morning-read -- [--dry-run] [--cf-token-file <path>] [--firebase-sa <path>]
//                               [--release-health auto|skip] [--release-health-only]
//                               [--health-min-parent N] [--health-parent-age-hours N]
//                               [--fixture <file.json> [--now <iso>]] [--json-only]
//
// Fetches yesterday's and cumulative spend from the Google Ads API → stores it in gss-stats-ads
// → detects newly crossed thresholds ($25/$50/$75/$100, each fires once) → on a crossing runs
// the full read and the kill rules → always appends a daily reading line → release health
// (never between 01:00 and 12:00 ET). Prints a short report, then a JSON block. PROPOSES only.

import { MIN_COHORT } from '../../src/lib/popupEvents'
import { fail, fixtureDeps, liveDeps, loadFixture, parseCli } from './cli'
import { runMorningRead } from './read'
import { formatMorningReport, withJson } from './report'

const HELP = `morning-read [--dry-run] [--cf-token-file <path>] [--firebase-sa <path>] [--release-health auto|skip] [--release-health-only] [--health-min-parent N] [--health-parent-age-hours N] [--fixture <file.json> [--now <iso>]] [--json-only]`

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

  let deps
  if (opts.fixture) {
    const fx = loadFixture(opts.fixture as string)
    if (opts.now) fx.now = opts.now as string
    deps = fixtureDeps(fx, !!opts['dry-run'])
  } else deps = await liveDeps(opts)

  const result = await runMorningRead(deps, {
    campaignId: opts.campaign as string,
    releaseHealth: rh,
    healthOnly: !!opts['release-health-only'],
    healthMinParent: minParent,
    healthParentAgeHours: ageHours,
  })
  process.stdout.write(opts['json-only'] ? JSON.stringify(result, null, 2) + '\n' : withJson(formatMorningReport(result), result))
}

main().catch(fail)
