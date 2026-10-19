// A Play-direct arm read end to end: a made-up arm (own id and tag, kind 'play-direct', a four-day window)
// is registered at runtime and read from the recorded retest fixture with the retest's id and tag swapped,
// the pattern of campaignRegistry.test.ts. One morning read (the rule 5 install-referrer check and the
// labelled Play lines) and one post-flight read. Play is faked; no network, no credentials, nothing real.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ADS_READ_PLANS, STAGED_FLIGHT_3_PLAN_SETTINGS, buildReadPlan, type ReadingRecord } from '../../src/lib/adsRules'
import { CAMPAIGNS, STAGED_FLIGHT_3, buildStagedCampaign } from '../../src/lib/campaigns'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import { hideLiveFlight3 } from '../../src/testing/stagedFlight3'
import { fixtureDeps, type Fixture } from './cli'
import type { PlayReportsSection } from './play'
import { PLAY_BASELINE_NET_DEVICE_NOTE } from './playDirect'
import { runMorningRead, runPostflightRead, type MorningOptions } from './read'
import { formatMorningReport, formatPostflightReport } from './report'

const here = path.dirname(fileURLToPath(import.meta.url))
const RETEST = '24279250691'
const RETEST_UC = 'sudoku_funnel_retest'
const PLAY_ID = '99900000013'
const PLAY_UC = 'made_up_f3_play'
const TWIN_UC = 'sudoku_tired_of_ads_play'
const raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
/** The recorded fixture for the made-up arm; `noD0` drops its tagged /return/<uc>/d0 rows (the broken install-referrer case). */
function fixtureFor(noD0 = false): Fixture {
  const fx: Fixture = JSON.parse(raw.split(RETEST).join(PLAY_ID).split(RETEST_UC).join(PLAY_UC))
  if (noD0 && fx.beacon && !('error' in fx.beacon)) fx.beacon.returns = fx.beacon.returns.filter((r) => !r.path.endsWith('/d0'))
  return fx
}
const opts: MorningOptions = { campaignId: PLAY_ID, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 }

// The fixture's flight days (2026-09-26 .. 10-02, seven days) fit a Play-direct arm that allows 4-7 serving days.
const arm = buildStagedCampaign(
  'appsPlay',
  { ...STAGED_FLIGHT_3.apps, ucValues: [PLAY_UC], kind: 'play-direct', servingDays: { min: 4, max: 7 }, hardCapUsd: 100 },
  { id: PLAY_ID, flightStart: '2026-09-26', flightEnd: '2026-10-02' },
)

let restoreFlight3: () => void
beforeEach(() => {
  restoreFlight3 = hideLiveFlight3()
  CAMPAIGNS.push({ ...arm, status: 'active' })
  ADS_READ_PLANS[PLAY_ID] = buildReadPlan(PLAY_ID, {
    ...STAGED_FLIGHT_3_PLAN_SETTINGS.apps,
    thresholds: [25, 50, 75, 100],
    killRulesFrom: 50,
    morningReadFirstEt: '2026-09-27',
    morningReadLastEt: '2026-10-03',
  })
})
afterEach(() => {
  const i = CAMPAIGNS.findIndex((c) => c.id === PLAY_ID)
  if (i >= 0) CAMPAIGNS.splice(i, 1)
  delete ADS_READ_PLANS[PLAY_ID]
  restoreFlight3()
})

const section = (through: string, listing: { visitors: number; acquisitions: number } | null, uc = PLAY_UC): PlayReportsSection => ({
  ok: true,
  error: null,
  bucket: 'pubsite_prod_test',
  installsThrough: through,
  storePerformanceThrough: through,
  installsLagDays: 15,
  storePerformanceLagDays: 15,
  installsByDay: [],
  acquisitionByCountry: [],
  acquisitionBySource: [],
  acquisitionByUtmCampaign: listing ? [{ utmCampaign: uc, ...listing, firstDate: '2026-09-26', lastDate: '2026-09-30' }] : [],
  retentionNote: 'retention note',
  householdNote: 'household note',
  checkpoints: [],
  errors: [],
})
/** A fake Play source: the arm's own window (since 2026-09-26) gets `own`; the closed twin's window (since 2026-09-09) gets the Sept-file twin row. */
function withPlay(fx: Fixture, own: PlayReportsSection, dryRun = true) {
  const seen: { since: string; until: string }[] = []
  const deps = {
    ...fixtureDeps(fx, dryRun),
    playReports: {
      read: async (o: { since: string; until: string; flightStart: string; cumulativeSpend: number }) => {
        seen.push({ since: o.since, until: o.until })
        return o.since === '2026-09-09' ? section('2026-09-19', { visitors: 120, acquisitions: 2 }, TWIN_UC) : own
      },
    },
  }
  return { deps, seen }
}

describe('a Play-direct arm, morning read', () => {
  it('the arm is read as play-direct from the registry, not from its id', () => {
    expect(arm.kind).toBe('play-direct')
    expect(CAMPAIGNS.find((c) => c.id === PLAY_ID)!.kind).toBe('play-direct')
  })

  it('tagged first opens pass the tracking check; the Play lines are PARTIAL with the baseline beside them', async () => {
    const { deps, seen } = withPlay(fixtureFor(), section('2026-09-30', { visitors: 60, acquisitions: 4 }))
    const r = await runMorningRead(deps, opts)
    const report = formatMorningReport(r)
    // rule 5: 140 closed-day clicks, 29 tagged /return/<uc>/d0 rows
    expect(r.flight3!.readouts.find((x) => x.n === 5)).toMatchObject({ verdict: 'PASS' })
    expect(report).toContain('140 clicks, 29 tagged /return/<uc>/d0 rows')
    expect(report).toContain(`Tagged first opens (/return/<uc>/d0 rows for ${PLAY_UC}): 29 from 140 clicks`)
    // the labelled install line: horizon 09-30 is short of flight end + 7 (10-09)
    expect(report).toContain(`Play Console installs (store listing acquisitions for utm_campaign ${PLAY_UC}, as Play prints them): 4 acquisitions of 60 listing visitors; PARTIAL`)
    expect(report).toContain('needs 2026-10-09')
    expect(report).not.toContain('INSTALL VERDICT')
    expect(report).toContain('they differ from device installs')
    // the baseline: data first, the quoted hand-derived note apart, the stored twin spend
    expect(report).toContain('2 acquisitions / 120 listing visitors (UTM file)')
    expect(report).toContain(PLAY_BASELINE_NET_DEVICE_NOTE)
    expect(report).toContain('$75.17 spent')
    expect(report).not.toContain('76.25')
    // the arm's own window and the twin's own window were both read
    expect(seen.map((s) => s.since).sort()).toEqual(['2026-09-09', '2026-09-26'])
    expect(r.playDirect).toMatchObject({ campaignId: PLAY_ID, clicks: 140, d0Rows: 29 })
  })

  it('30+ clicks with no tagged d0 row print a WATCH line and never a pause proposal', async () => {
    const { deps } = withPlay(fixtureFor(true), section('2026-09-30', null))
    const r = await runMorningRead(deps, opts)
    const rule5 = r.flight3!.readouts.find((x) => x.n === 5)!
    expect(rule5.verdict).toBe('WATCH')
    expect(rule5.number).toContain('Watch: 140 clicks, 0 tagged first opens. The app side is proven')
    expect(r.flight3!.tripped).not.toContain(5)
    const report = formatMorningReport(r)
    expect(report).toContain('Watch: 140 clicks, 0 tagged first opens.')
    expect(report).toContain('At this size, 0 opens can also be chance.')
    expect(report).toContain('→ WATCH')
    expect(report).not.toContain('install-referrer path looks broken')
    // no Play row yet and the horizon is short of the flight end: the exact not-landed text
    expect(report).toContain('not landed yet (lags 6-14 days)')
  })

  it('a web arm is untouched: no Play-direct block on the retest-shaped read of a web campaign', async () => {
    const i = CAMPAIGNS.findIndex((c) => c.id === PLAY_ID)
    CAMPAIGNS[i] = { ...CAMPAIGNS[i], kind: 'web' }
    const r = await runMorningRead(fixtureDeps(fixtureFor(), true), opts)
    expect(r.playDirect).toBeUndefined()
    expect(formatMorningReport(r)).not.toContain('Play-direct arm (the ads open the Play listing')
  })
})

describe('a Play-direct arm, daily read: tagged-row rules are WATCH lines and never a pause or a push', () => {
  // A daily read, not a threshold read: no spend threshold of the plan is reachable.
  const dailyPlan = (hardCapUsd?: number) => {
    if (hardCapUsd != null) CAMPAIGNS.find((c) => c.id === PLAY_ID)!.hardCapUsd = hardCapUsd
    ADS_READ_PLANS[PLAY_ID] = buildReadPlan(PLAY_ID, {
      ...STAGED_FLIGHT_3_PLAN_SETTINGS.apps,
      thresholds: [500],
      killRulesFrom: 50,
      morningReadFirstEt: '2026-09-27',
      morningReadLastEt: '2026-10-03',
    })
  }
  const ASK_ROW = /^\/(signin-prompt|promo-first50)\//
  /** Zero tagged and zero site-wide sign-in asks (rule 3 would trip on a web arm), and the tagged d0 rows kept or dropped. */
  function zeroAsksFixture(noD0: boolean): Fixture {
    const fx = fixtureFor(noD0)
    if (fx.beacon && !('error' in fx.beacon)) {
      fx.beacon.tagged = fx.beacon.tagged.filter((r) => !ASK_ROW.test(r.path))
      fx.beacon.siteEvents = fx.beacon.siteEvents.filter((r) => !ASK_ROW.test(r.path))
    }
    return fx
  }
  const rule = (r: Awaited<ReturnType<typeof runMorningRead>>, n: number) => r.flight3!.readouts.find((x) => x.n === n)!

  it('rules 3, 5 and 6 fire together (no tagged first opens): WATCH lines, no PROPOSE PAUSE, Push: no, the cost line says no first opens yet', async () => {
    dailyPlan()
    const { deps } = withPlay(zeroAsksFixture(true), section('2026-09-30', null))
    const r = await runMorningRead(deps, opts)
    expect([3, 5, 6].map((n) => rule(r, n).verdict)).toEqual(['WATCH', 'WATCH', 'WATCH'])
    expect(r.flight3!.readouts.some((x) => x.verdict === 'PROPOSE PAUSE')).toBe(false)
    expect(r.flight3!.proposal).toBe('CONTINUE')
    expect(r.flight3!.tripped).toEqual([])
    expect(r.notify.push).toBe(false)
    const report = formatMorningReport(r)
    expect(report).not.toContain('PROPOSE PAUSE')
    expect(report).toContain('Push: no (')
    expect(report).toContain('WATCH · cost per tagged first open: no tagged first opens yet')
    expect(report).not.toMatch(/Infinity|NaN/)
  })

  it('rules 3, 6 and 7 fire together (tagged first opens present, few first moves): WATCH lines, Push: no, a cost per tagged first open is printed', async () => {
    dailyPlan()
    const fx = zeroAsksFixture(false)
    // low first-move share: 29 d0 rows, first-move rows dropped from the site-wide first-session tally
    const { deps } = withPlay(fx, section('2026-09-30', { visitors: 60, acquisitions: 4 }))
    const r = await runMorningRead(deps, opts)
    expect([3, 6].map((n) => rule(r, n).verdict)).toEqual(['WATCH', 'WATCH'])
    expect(rule(r, 7).verdict).not.toBe('PROPOSE PAUSE')
    expect(r.flight3!.readouts.some((x) => x.verdict === 'PROPOSE PAUSE')).toBe(false)
    expect(r.flight3!.proposal).toBe('CONTINUE')
    expect(r.notify.push).toBe(false)
    const report = formatMorningReport(r)
    expect(report).toContain('Push: no (')
    // closed-day spend $50.10 / 29 tagged first opens
    expect(report).toContain('WATCH · cost per tagged first open: $1.73 ($50.10 closed-day spend / 29 tagged first opens)')
    expect(report).toContain("the September twin's ~$9.50 per net install")
    expect(report).toContain('hand-derived in the September review')
    expect(report).toContain('the 11-21 d35 read is the install verdict')
  })

  it('a threshold read stores rule 3 as watch with no proposal, and its push is the threshold alone (no kill-rule trip)', async () => {
    // the beforeEach plan: spend thresholds 25 / 50 / 75 / 100, so the $50.10 read is a threshold read
    const { deps } = withPlay(zeroAsksFixture(true), section('2026-09-30', null), false)
    const append = vi.spyOn(deps.store, 'appendReadings')
    const r = await runMorningRead(deps, opts)
    const written = append.mock.calls.flatMap((c) => c[0] as ReadingRecord[])
    const threshold = written.find((x) => x.kind === 'threshold')!
    expect(threshold.rules!.find((x) => x.id === 'funnel-reach')!.status).toBe('watch')
    expect(threshold.proposal).toBe('CONTINUE')
    expect(r.notify.reason).toBe('threshold read at $50')
    expect(r.notify.text).not.toContain('PROPOSE PAUSE')
    expect(formatMorningReport(r)).not.toContain('PROPOSE PAUSE')
  })

  it('rule 4 still proposes a pause on a Play-direct arm, and the push says so', async () => {
    dailyPlan(49.14)
    const { deps } = withPlay(zeroAsksFixture(true), section('2026-09-30', null))
    const r = await runMorningRead(deps, opts)
    expect(rule(r, 4).verdict).toBe('PROPOSE PAUSE')
    expect(r.flight3!.proposal).toBe('PROPOSE PAUSE')
    expect(r.notify.push).toBe(true)
    expect(formatMorningReport(r)).toContain('PROPOSE PAUSE')
  })

  it('rule 2 (CTR under 0.15%) still proposes a pause on a Play-direct arm', async () => {
    dailyPlan()
    const fx = zeroAsksFixture(true)
    for (const d of Object.values(fx.ads!.daily)) d.impressions *= 20 // 140 clicks / ~356k impressions = 0.039%
    const { deps } = withPlay(fx, section('2026-09-30', null))
    const r = await runMorningRead(deps, opts)
    expect(rule(r, 2).verdict).toBe('PROPOSE PAUSE')
    expect(r.flight3!.tripped).toContain(2)
    expect(r.flight3!.proposal).toBe('PROPOSE PAUSE')
    expect(r.notify.push).toBe(true)
    expect(formatMorningReport(r)).toContain('PROPOSE PAUSE')
  })
})

describe('a Play-direct arm, post-flight read', () => {
  const post = (fx: Fixture, own: PlayReportsSection) => {
    const { deps } = withPlay(fx, own)
    return runPostflightRead(deps, { campaignId: PLAY_ID, stage: 'wrapup', force: true })
  }

  it('prints PARTIAL while Play runs less than a week past the flight end', async () => {
    const r = await post(fixtureFor(), section('2026-10-04', { visitors: 70, acquisitions: 5 }))
    const report = formatPostflightReport(r)
    expect(report).toContain(`Play Console installs (store listing acquisitions for utm_campaign ${PLAY_UC}, as Play prints them): 5 acquisitions of 70 listing visitors; PARTIAL`)
    expect(report).toContain('2 acquisitions / 120 listing visitors (UTM file)')
    expect(report).toContain(PLAY_BASELINE_NET_DEVICE_NOTE)
  })

  it('prints INSTALL VERDICT once the listing data reaches flight end + 7 days', async () => {
    const r = await post(fixtureFor(), section('2026-10-09', { visitors: 70, acquisitions: 5 }))
    const report = formatPostflightReport(r)
    expect(report).toContain('5 acquisitions of 70 listing visitors; INSTALL VERDICT')
    expect(report).not.toContain('PARTIAL:')
    expect(r.playDirect!.installs.label).toBe('INSTALL VERDICT')
  })

  it('prints "not landed yet (lags 6-14 days)" when Play has no row for the tag yet', async () => {
    const r = await post(fixtureFor(), section('2026-09-30', null))
    expect(formatPostflightReport(r)).toContain('not landed yet (lags 6-14 days)')
  })
})
