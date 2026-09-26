// postflight-read — the retest's wrap-up and follow-up reads (docs/routines/bsk-retest-postflight.md).
//
//   npm run ads:postflight-read -- --stage wrapup|day15|day30|day60|december [--force]
//                                  [--dry-run] [--cf-token-file <path>] [--firebase-sa <path>]
//                                  [--fixture <file.json> [--now <iso>]] [--json-only]
//
// wrapup = flight end + 7 days; day15/30/60 are counted from the flight end (never the last spend day);
// december = when every d31-60 return window has closed. A stage that is not due yet reports
// its due date and records nothing unless --force. Promo vs non-promo is split from the
// anonymous outcome beacons (and, with --firebase-sa, Firestore window COUNTS). PROPOSES only.

import { POSTFLIGHT_STAGES, type PostflightStage } from '../../src/lib/adsRules'
import { fail, fixtureDeps, liveDeps, loadFixture, parseCli } from './cli'
import { runPostflightRead } from './read'
import { formatPostflightReport, withJson } from './report'

async function main() {
  const opts = parseCli({ stage: { type: 'string' }, force: { type: 'boolean', default: false } })
  if (opts.help) {
    process.stdout.write('postflight-read --stage wrapup|day15|day30|day60|december [--force] [--dry-run] [--cf-token-file <path>] [--firebase-sa <path>] [--fixture <file.json> [--now <iso>]] [--json-only]\n')
    return
  }
  const stage = opts.stage as PostflightStage
  if (!POSTFLIGHT_STAGES.includes(stage)) throw new Error(`--stage must be one of ${POSTFLIGHT_STAGES.join(', ')}`)
  let deps
  if (opts.fixture) {
    const fx = loadFixture(opts.fixture as string)
    if (opts.now) fx.now = opts.now as string
    deps = fixtureDeps(fx, !!opts['dry-run'])
  } else deps = await liveDeps(opts)
  const result = await runPostflightRead(deps, { campaignId: opts.campaign as string, stage, force: !!opts.force })
  process.stdout.write(opts['json-only'] ? JSON.stringify(result, null, 2) + '\n' : withJson(formatPostflightReport(result), result))
}

main().catch(fail)
