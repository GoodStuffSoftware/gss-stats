// postflight-read — a registered campaign's wrap-up and follow-up reads (the retest's: docs/routines/bsk-retest-postflight.md).
//
//   npm run ads:postflight-read -- --stage wrapup|day15|day30|day60|december [--campaign <id>] [--force]
//                                  [--dry-run] [--cf-token-file <path>] [--firebase-sa <path>]
//                                  [--as-of <YYYY-MM-DD ET>] [--fixture <file.json> [--now <iso>]] [--json-only]
//
// wrapup = flight end + 7 days; day15/30/60 are counted from the flight end (never the last spend day);
// december = when every d31-60 return window has closed. A stage that is not due yet reports
// its due date and records nothing unless --force. Promo vs non-promo is split from the
// anonymous outcome beacons (and, with --firebase-sa, Firestore window COUNTS). PROPOSES only.
//
// --as-of <YYYY-MM-DD ET> backfills a stage read that did not run on its day: the clock is the end of that ET day,
// so the beacon windows, the matured-arrival cutoff, the Ads spend range and the stored et_date all follow it. The
// date may not be in the future or before the stage is due; read_at stays the real time and the notes name the
// as-of. With --fixture it only sets the fixture clock, like --now.

import { POSTFLIGHT_STAGES, type PostflightStage } from '../../src/lib/adsRules'
import { fail, fixtureDeps, liveDeps, loadFixture, parseCli, resolvePostflightClock } from './cli'
import { runPostflightRead } from './read'
import { formatPostflightReport, jsonOnly, withJson } from './report'

async function main() {
  const opts = parseCli({ stage: { type: 'string' }, force: { type: 'boolean', default: false }, 'as-of': { type: 'string' } })
  if (opts.help) {
    process.stdout.write('postflight-read --stage wrapup|day15|day30|day60|december [--campaign <id>] [--force] [--dry-run] [--cf-token-file <path>] [--firebase-sa <path>] [--as-of <YYYY-MM-DD ET>] [--fixture <file.json> [--now <iso>]] [--json-only]\n')
    return
  }
  const stage = opts.stage as PostflightStage
  if (!POSTFLIGHT_STAGES.includes(stage)) throw new Error(`--stage must be one of ${POSTFLIGHT_STAGES.join(', ')}`)
  const fx = opts.fixture ? loadFixture(opts.fixture as string) : null
  if (fx && opts.now) fx.now = opts.now as string
  const clock = resolvePostflightClock(opts, stage, fx ? Date.parse(fx.now) : Date.now())
  const campaignId = clock.campaignId
  if (fx && clock.asOf) fx.now = new Date(clock.nowMs).toISOString()
  const deps = fx ? fixtureDeps(fx, !!opts['dry-run']) : await liveDeps(opts, clock)
  const result = await runPostflightRead(deps, { campaignId, stage, force: !!opts.force })
  process.stdout.write(opts['json-only'] ? jsonOnly(result) : withJson(formatPostflightReport(result), result))
}

main().catch(fail)
