// Tests only: a small but realistic Best Sudoku `hits` history for the equivalence tests
// (functions/api/metrics.equivalence.test.ts) — the three configured campaigns, untagged site
// traffic over the KPI's 8 ET days, return beacons, pop-ups, installs across the install fix,
// completions after their go-live, excluded household/lifecycle rows, and another site. Every
// row is synthetic.

import type { HitRow } from './hitsDb'

/** 17:00 ET on 2026-09-26: after the install fix (12:26 ET) and the game-complete go-live
 * (15:43 ET), on the retest's first day (attribution from 12:00 ET). */
export const FIXTURE_NOW = Date.parse('2026-09-26T21:00:00Z')

const ANDROID = 'sudoku_tired_of_ads'
const RETEST = 'sudoku_funnel_retest'
const WEB = 'bestsudoku-web'
type Seed = HitRow & { n?: number }
const at = (iso: string) => Date.parse(iso)

function androidLaunch(): Seed[] {
  const tag = { site: WEB, campaign: ANDROID }
  return [
    { ...tag, ts: at('2026-09-03T15:00:00Z'), path: '/game', visitor: 'new', country: 'US', n: 40 },
    { ...tag, ts: at('2026-09-03T15:20:00Z'), path: '/game', visitor: 'returning', country: 'US', n: 60 },
    { ...tag, ts: at('2026-09-04T13:00:00Z'), path: '/', visitor: 'new', country: 'CA', n: 10 },
    { ...tag, ts: at('2026-09-05T18:00:00Z'), path: '/signin-prompt/placement', visitor: 'returning', n: 12 },
    { ...tag, ts: at('2026-09-05T18:01:00Z'), path: '/signin-prompt/accept', visitor: 'returning', n: 4 },
    { ...tag, ts: at('2026-09-05T18:02:00Z'), path: '/promo-first50/shown', visitor: 'returning', n: 3 },
    { ...tag, ts: at('2026-09-05T18:05:00Z'), path: '/auth/success/google', visitor: 'returning', n: 3 },
    { ...tag, ts: at('2026-09-06T14:00:00Z'), path: '/install/prompt/android', visitor: 'returning', n: 8 },
    // Pre-fix install-gap row: dropped row-exactly by every query that counts installs.
    { ...tag, ts: at('2026-09-06T14:10:00Z'), path: '/install/pwa-installed', visitor: 'returning', n: 1 },
    { ...tag, ts: at('2026-09-06T14:11:00Z'), path: '/install/standalone-detected', visitor: 'returning', n: 1 },
    // The post-flight trickle (attribution has no upper bound), across the install fix
    // (16:26:36Z): 3 prompts in the fix's own hour but after it, 2 in a later hour.
    { ...tag, ts: at('2026-09-26T16:40:00Z'), path: '/install/prompt/android', visitor: 'returning', n: 3 },
    { ...tag, ts: at('2026-09-26T18:10:00Z'), path: '/install/prompt/android', visitor: 'returning', n: 2 },
    { ...tag, ts: at('2026-09-26T16:50:00Z'), path: '/popup-outcome/install-prompt/installed', visitor: 'returning', n: 1 },
    { ...tag, ts: at('2026-09-26T20:00:00Z'), path: '/auth/success/google', visitor: 'returning', n: 2 },
    { ...tag, ts: at('2026-09-26T20:00:00Z'), path: '/auth/success/google/existing', visitor: 'returning', n: 2 },
    // The QA variant tag — not in ucValues, never attributed.
    { site: WEB, campaign: 'sudoku_tired_of_ads_test', ts: at('2026-09-02T16:00:00Z'), path: '/game', visitor: 'new', n: 1 },
    // Excluded everywhere: Mike's household, lifecycle email traffic.
    { ...tag, ts: at('2026-09-03T16:00:00Z'), path: '/game', visitor: 'new', region: 'North Carolina', screenw: 412, n: 5 },
    { ...tag, ts: at('2026-09-03T16:00:00Z'), path: '/game', visitor: 'new', medium: 'lifecycle', n: 4 },
    // On-device return beacons (untagged later sessions; the uc is in the path).
    { site: WEB, ts: at('2026-09-26T15:00:00Z'), path: `/return/${ANDROID}/d0`, visitor: 'returning', n: 20 },
    { site: WEB, ts: at('2026-09-26T15:05:00Z'), path: `/return/${ANDROID}/d1`, visitor: 'returning', n: 5 },
    { site: WEB, ts: at('2026-09-26T15:06:00Z'), path: `/return/${ANDROID}/d2-7`, visitor: 'returning', n: 2 },
  ]
}

function retest(): Seed[] {
  const tag = { site: WEB, campaign: RETEST }
  return [
    // Pre-launch QA: 2026-09-23 and today before 12:00 ET — never attributed.
    { ...tag, ts: at('2026-09-23T14:00:00Z'), path: '/game', visitor: 'new', n: 9 },
    { ...tag, ts: at('2026-09-26T15:30:00Z'), path: '/game', visitor: 'new', n: 3 },
    { ...tag, ts: at('2026-09-26T17:00:00Z'), path: '/game', visitor: 'new', country: 'US', n: 7 },
    { ...tag, ts: at('2026-09-26T17:05:00Z'), path: '/game', visitor: 'returning', country: 'US', n: 14 },
    { ...tag, ts: at('2026-09-26T20:00:00Z'), path: '/game/complete/normal/easy', visitor: 'returning', n: 3 },
    { ...tag, ts: at('2026-09-26T18:00:00Z'), path: '/signin-prompt/streak', visitor: 'returning', n: 6 },
    // No sign-in accept for the retest, and none site-wide today: the retired /api/campaigns
    // called 'accept' not instrumented for this ACTIVE flight; the registry keeps it live (0).
    { ...tag, ts: at('2026-09-26T20:30:00Z'), path: '/popup-outcome/signin-prompt/signed-in', visitor: 'returning', n: 1 },
    { ...tag, ts: at('2026-09-26T16:30:00Z'), path: '/install/prompt/ios', visitor: 'returning', n: 5 },
    { ...tag, ts: at('2026-09-26T18:00:00Z'), path: '/install/prompt/ios', visitor: 'returning', n: 4 },
    { ...tag, ts: at('2026-09-26T18:30:00Z'), path: '/popup-outcome/install-prompt/installed', visitor: 'returning', n: 2 },
    { ...tag, ts: at('2026-09-26T19:50:00Z'), path: '/auth/success/email', visitor: 'returning', n: 2 },
    { ...tag, ts: at('2026-09-26T19:50:00Z'), path: '/auth/success/email/existing', visitor: 'returning', n: 2 },
    { site: WEB, ts: at('2026-09-26T17:30:00Z'), path: `/return/${RETEST}/d0`, visitor: 'returning', n: 6 },
  ]
}

/** Untagged Best Sudoku traffic over the KPI's 8 ET days, at 14:00Z (inside every "same time
 * of day" window at 17:00 ET) and 22:00Z (outside them). */
function siteTraffic(): Seed[] {
  const out: Seed[] = []
  for (let d = 18; d <= 26; d++) {
    const day = `2026-09-${d}`
    out.push({ site: WEB, ts: at(`${day}T14:00:00Z`), path: '/', visitor: 'returning', n: 10 + d })
    out.push({ site: WEB, ts: at(`${day}T14:05:00Z`), path: '/game', visitor: 'returning', n: d - 10 })
    out.push({ site: 'bestsudoku-app', ts: at(`${day}T14:10:00Z`), path: '/stats', visitor: 'new', n: 3 })
    out.push({ site: 'bestsudoku', ts: at(`${day}T14:15:00Z`), path: '/', visitor: 'new', n: 1 })
    if (d < 26) out.push({ site: WEB, ts: at(`${day}T22:00:00Z`), path: '/', visitor: 'returning', n: 50 })
    out.push({ site: WEB, ts: at(`${day}T14:20:00Z`), path: '/auth/success/google', visitor: 'returning', n: d % 3 })
  }
  // Pop-ups: a pre-activation reproduction on 09-24 (inside the 7-day average), then today.
  out.push({ site: WEB, ts: at('2026-09-24T14:00:00Z'), path: '/upsell/shown/limit', visitor: 'returning', n: 22 })
  out.push({ site: WEB, ts: at('2026-09-26T14:00:00Z'), path: '/upsell/shown/limit', visitor: 'returning', n: 11 })
  out.push({ site: WEB, ts: at('2026-09-26T14:02:00Z'), path: '/upsell/accept/limit', visitor: 'returning', n: 4 })
  out.push({ site: WEB, ts: at('2026-09-26T14:03:00Z'), path: '/popup-outcome/upsell/returned', visitor: 'returning', n: 1 })
  out.push({ site: WEB, ts: at('2026-09-26T14:04:00Z'), path: '/signin-eligible/earned', visitor: 'returning', n: 4 })
  out.push({ site: WEB, ts: at('2026-09-26T14:04:00Z'), path: '/signin-eligible/capped', visitor: 'returning', n: 2 })
  out.push({ site: WEB, ts: at('2026-09-26T14:04:00Z'), path: '/signin-eligible/unearned', visitor: 'returning', n: 1 })
  // Installs today, across the fix; a pre-fix gap row the SQL drops.
  out.push({ site: WEB, ts: at('2026-09-26T13:00:00Z'), path: '/install/prompt/android', visitor: 'returning', n: 4 })
  out.push({ site: WEB, ts: at('2026-09-26T13:05:00Z'), path: '/popup-outcome/install-prompt/installed', visitor: 'returning', n: 2 })
  out.push({ site: WEB, ts: at('2026-09-26T19:00:00Z'), path: '/install/prompt/desktop', visitor: 'returning', n: 6 })
  out.push({ site: WEB, ts: at('2026-09-26T19:05:00Z'), path: '/popup-outcome/install-prompt/installed', visitor: 'returning', n: 3 })
  out.push({ site: WEB, ts: at('2026-09-26T19:06:00Z'), path: '/install/play', visitor: 'returning', n: 1 })
  out.push({ site: WEB, ts: at('2026-09-26T19:07:00Z'), path: '/install/pwa-installed', visitor: 'returning', n: 2 })
  // Completions (live from 19:43:02Z) and return beacons today.
  out.push({ site: WEB, ts: at('2026-09-26T19:45:00Z'), path: '/game/complete/daily/hard', visitor: 'returning', n: 5 })
  out.push({ site: WEB, ts: at('2026-09-26T15:10:00Z'), path: '/return/beta_v2_tier1en/d1', visitor: 'returning', n: 2 })
  // Another site: never in a Best Sudoku figure.
  out.push({ site: 'goodstuff', ts: at('2026-09-26T14:00:00Z'), path: '/', visitor: 'new', n: 30 })
  return out
}

export function bskFixture(): Seed[] {
  return [...androidLaunch(), ...retest(), ...siteTraffic()]
}
