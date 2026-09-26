// End-to-end orchestration against the recorded fixture (fixtures/threshold-50.json, synthetic
// numbers): what fires, what is written, what is pushed — with no network.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead, runPostflightRead, type MorningOptions } from './read'
import { formatMorningReport, formatPostflightReport, withJson } from './report'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import { AUTH_SUCCESS_SPLIT_RECOMMENDATION } from '../../src/lib/adsRules'
import { syncAdsData } from '../../src/lib/adsSync'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = (): Fixture => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8'))
const opts: MorningOptions = { campaignId: '24279250691', releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 }
const ads = (fx: Fixture) => fx.ads as Extract<Fixture['ads'], { status: unknown }>

describe('morning-read: the $50 threshold read', () => {
  it('fires $50 once (not $25 again), runs the full read, proposes CONTINUE, pushes and copies to the bus', async () => {
    const deps = fixtureDeps(base(), false)
    const r = await runMorningRead(deps, opts)
    expect(r.spend.cumulative.cost).toBe(50.1)
    expect(r.spend.throughEt).toBe('2026-09-29')
    expect(r.thresholds.crossedNow).toEqual([50])
    expect(r.thresholdRead!.complete).toBe(true)
    expect(r.thresholdRead!.kill.proposal).toBe('CONTINUE')
    expect(r.notify).toMatchObject({ push: true, busCopy: true })
    expect(r.notify.text!.length).toBeLessThan(200)
    // written: one daily line + one threshold record, and $50 is now consumed
    expect(deps.store.written.readings.map((x) => x.kind)).toEqual(['daily', 'threshold'])
    expect(await deps.store.getConsumedThresholds('24279250691')).toEqual([25, 50])
  })
  it('the same read again the same morning fires nothing, pushes nothing and stores no second daily line (fire-once, de-duped)', async () => {
    const deps = fixtureDeps(base(), false)
    await runMorningRead(deps, opts)
    const again = await runMorningRead({ ...deps, nowMs: deps.nowMs + 60_000 }, opts)
    expect(again.thresholds.crossedNow).toEqual([])
    expect(again.thresholdRead).toBeNull()
    expect(again.notify.push).toBe(false)
    expect(deps.store.written.readings.filter((x) => x.kind === 'daily')).toHaveLength(1) // one line per ET day
    expect(again.dedup.skipped.map((s) => s.entryKind)).toEqual(['morning'])
    expect(again.spend.sync).toMatchObject({ daysChanged: 0, placementRowsChanged: 0 }) // the sync is a no-op too
  })
  it('the next morning appends its own daily line', async () => {
    const deps = fixtureDeps(base(), false)
    await runMorningRead(deps, opts)
    await runMorningRead({ ...deps, nowMs: deps.nowMs + 86_400_000 }, opts)
    expect(deps.store.written.readings.filter((x) => x.kind === 'daily').map((x) => x.etDate)).toEqual(['2026-09-30', '2026-10-01'])
  })
  it('--dry-run reads everything and writes nothing, so the threshold stays unconsumed', async () => {
    const deps = fixtureDeps(base(), true)
    const r = await runMorningRead(deps, opts)
    expect(r.thresholdRead).not.toBeNull()
    expect(r.store).toMatchObject({ dryRun: true, spendWritten: false, readingsWritten: false })
    expect(deps.store.written.readings).toEqual([])
    expect(await deps.store.getConsumedThresholds('24279250691')).toEqual([25])
    expect(formatMorningReport(r)).toMatch(/DRY RUN/)
  })
  it('an incomplete read (beacon down) is logged but does not consume the threshold; rules needing it read no-data', async () => {
    const fx = base()
    fx.beacon = { error: 'wrangler unavailable' }
    const deps = fixtureDeps(fx, false)
    const r = await runMorningRead(deps, opts)
    expect(r.thresholdRead!.complete).toBe(false)
    expect(r.thresholdRead!.kill.rules.find((x) => x.id === 'funnel-reach')!.status).toBe('no-data')
    expect(await deps.store.getConsumedThresholds('24279250691')).toEqual([25])
    expect(r.notify.text).toMatch(/incomplete/)
    expect(r.notify.text).toContain('Read problems: beacon (wrangler unavailable).')
    expect(r.failures).toContain('beacon') // L6: a threshold read's own failures are listed
  })
  it('a CTR under 0.15% at $50 proposes a pause', async () => {
    const fx = base()
    for (const d of Object.values(ads(fx).daily)) d.clicks = 0
    const r = await runMorningRead(fixtureDeps(fx, false), opts)
    expect(r.thresholdRead!.kill.tripped).toEqual(['ctr'])
    expect(r.notify.text).toMatch(/PROPOSE PAUSE \(ctr\)/)
  })
  it('zero asks from tagged arrivals at $50 proposes a pause (asks = placement + streak + promo shown)', async () => {
    const fx = base()
    const b = fx.beacon as Extract<Fixture['beacon'], { tagged: unknown }>
    b.tagged = b.tagged.filter((t) => !['/signin-prompt/placement', '/promo-first50/shown'].includes(t.path))
    const r = await runMorningRead(fixtureDeps(fx, false), opts)
    expect(r.thresholdRead!.kill.tripped).toContain('funnel-reach')
  })
  it('an Ads API failure evaluates nothing and fires nothing, but PUSHES a short failure notice with no error detail', async () => {
    const fx = base()
    fx.ads = { error: 'Bitwarden is missing: google-ads-api-rep-developer-token' }
    const r = await runMorningRead(fixtureDeps(fx, false), opts)
    expect(r.spend.ok).toBe(false)
    expect(r.thresholds.crossedNow).toEqual([])
    expect(r.failures).toEqual(['Google Ads spend', 'campaign status'])
    expect(r.notify).toMatchObject({ push: true, busCopy: false })
    // L9: a useful one-line reason per failure, redacted, no paths, no secrets
    expect(r.notify.text).toBe(
      'BSK retest morning read FAILED: Google Ads spend (Bitwarden is missing: google-ads-api-rep-developer-token); campaign status (Bitwarden is missing: google-ads-api-rep-developer-token). Thresholds and the $100 cap were not fully checked.',
    )
    expect(r.failureDetails).toHaveLength(2)
    expect(r.errors.join(' ')).toMatch(/developer-token/)
    expect(formatMorningReport(r)).toContain('READ FAILED: Google Ads spend (Bitwarden is missing: google-ads-api-rep-developer-token); campaign status')
  })
  it('a beacon failure on a quiet day also pushes', async () => {
    const fx = base()
    fx.store!.consumed = [25, 50]
    fx.beacon = { error: 'wrangler unavailable' }
    const r = await runMorningRead(fixtureDeps(fx, false), opts)
    expect(r.failures).toEqual(['beacon'])
    expect(r.notify.push).toBe(true)
  })
})

describe('morning-read: review lows', () => {
  it('L6: a Firestore failure at the $100 read makes it incomplete (not consumed) and is listed in failures', async () => {
    const fx = base()
    ads(fx).daily['2026-09-29'].costMicros = 70_000_000
    fx.store!.consumed = [25, 50, 75]
    fx.firebase = { ...(fx.firebase as any), newAccountsInWindow: null, errors: ['newAccountsInWindow: runAggregationQuery HTTP 503'] }
    const deps = fixtureDeps(fx, false)
    const r = await runMorningRead(deps, opts)
    expect(r.thresholdRead!.complete).toBe(false)
    expect(r.failures).toContain('Firestore counts')
    expect(r.notify.text).toContain('Firestore counts (newAccountsInWindow: runAggregationQuery HTTP 503)')
    expect(await deps.store.getConsumedThresholds('24279250691')).toEqual([25, 50, 75]) // $100 retried next run
  })
  it('L2: a borderline placement share is flagged in the push and the report', async () => {
    const fx = base()
    // off-list placement raised so the outside share lands at 5.00 / 53.50 = ~9.3% (clear, but borderline)
    const pl = ads(fx).placements.find((p) => p.placement === 'mobileapp::2-com.example.puzzle')!
    pl.costMicros = 5_000_000
    const r = await runMorningRead(fixtureDeps(fx, true), opts)
    expect(r.thresholdRead!.placements!.outsideShare).toBeGreaterThanOrEqual(0.09)
    expect(r.notify.text).toMatch(/Placement share \d+\.\d% is borderline, check the placement view\./)
    expect(formatMorningReport(r)).toMatch(/\(borderline, check the placement view\)/)
  })
  it('L11: the report (the bus copy) names off-list placements by package id, never the display name', async () => {
    const r = await runMorningRead(fixtureDeps(base(), true), opts)
    const text = formatMorningReport(r)
    expect(text).toContain('off-list: com.example.puzzle $1.20')
    expect(text).not.toContain('Some Other Puzzle App')
  })
})

describe('morning-read: a scheduled read that never ran', () => {
  it('the next read notes the missing ET dates (report, record, and any push), without pushing on its own', async () => {
    const fx = base()
    fx.store!.consumed = [25, 50]
    fx.store!.readings = fx.store!.readings!.filter((x) => x.etDate !== '2026-09-28' && x.etDate !== '2026-09-29')
    const deps = fixtureDeps(fx, false)
    const r = await runMorningRead(deps, opts)
    expect(r.missedReads).toEqual(['2026-09-28', '2026-09-29'])
    expect(r.notify.push).toBe(false)
    expect(formatMorningReport(r)).toMatch(/Previous scheduled read missing: 2026-09-28, 2026-09-29/)
    expect(deps.store.written.readings[0].notes.join(' ')).toMatch(/previous scheduled read missing: 2026-09-28, 2026-09-29/)
  })
  it('a push that happens anyway carries the note', async () => {
    const fx = base()
    fx.store!.readings = fx.store!.readings!.filter((x) => x.etDate !== '2026-09-29')
    const r = await runMorningRead(fixtureDeps(fx, false), opts)
    expect(r.notify.text).toMatch(/Previous scheduled read missing: 2026-09-29\.$/)
  })
  it('nothing is missing when every day has its line', async () => {
    const r = await runMorningRead(fixtureDeps(base(), true), opts)
    expect(r.missedReads).toEqual([])
  })
})

describe('morning-read: quiet days, the hard cap and release health', () => {
  it('a quiet day appends a daily line and pushes nothing', async () => {
    const fx = base()
    fx.store!.consumed = [25, 50]
    const deps = fixtureDeps(fx, false)
    const r = await runMorningRead(deps, opts)
    expect(r.notify.push).toBe(false)
    expect(deps.store.written.readings.map((x) => x.kind)).toEqual(['daily'])
    expect(deps.store.written.readings[0].counts.taggedArrivals).toBe(30)
  })
  it('over the cap with the campaign still ENABLED is a kill-rule trip on every read; PAUSED is the intended state', async () => {
    const fx = base()
    ads(fx).daily['2026-09-29'].costMicros = 70_000_000
    fx.store!.consumed = [25, 50, 75, 100]
    const enabled = await runMorningRead(fixtureDeps(fx, false), opts)
    expect(enabled.hardCapDaily!.status).toBe('trip')
    expect(enabled.notify).toMatchObject({ push: true, busCopy: false })
    ads(fx).status.status = 'PAUSED'
    const paused = await runMorningRead(fixtureDeps(fx, false), opts)
    expect(paused.hardCapDaily!.status).toBe('clear')
    expect(paused.notify.push).toBe(false)
  })
  it('after the end date (ENABLED/ENDED) the cap reads "ended": no trip, no pause proposal, no push', async () => {
    const fx = base()
    ads(fx).daily['2026-09-29'].costMicros = 70_000_000
    fx.store!.consumed = [25, 50, 75, 100]
    ads(fx).status.servingStatus = 'ENDED'
    const deps = fixtureDeps(fx, false)
    const r = await runMorningRead(deps, opts)
    expect(r.hardCapDaily!.status).toBe('clear')
    expect(r.hardCapDaily!.detail).toMatch(/campaign ended \(ENABLED\/ENDED\), nothing to pause/)
    expect(r.notify.push).toBe(false)
    expect(deps.store.written.readings[0].proposal).toBeNull()
    expect(deps.store.written.readings[0].notes[0]).toBe('no pause proposed: campaign ended (ENABLED/ENDED)')
  })
  it('a threshold read on an ended campaign reports trips but proposes no pause', async () => {
    const fx = base()
    ads(fx).daily['2026-09-29'].costMicros = 70_000_000
    fx.store!.consumed = [25, 50, 75]
    ads(fx).status.servingStatus = 'ENDED'
    const deps = fixtureDeps(fx, false)
    const r = await runMorningRead(deps, opts)
    expect(r.thresholdRead!.kill.tripped).toContain('hard-cap')
    expect(r.thresholdRead!.kill.proposal).toBeNull()
    expect(r.notify.text).not.toMatch(/PROPOSE PAUSE/)
    expect(r.notify.text).toMatch(/campaign ended, no pause proposed/)
    expect(formatMorningReport(r)).toMatch(/Proposal: none: campaign ended, nothing to pause/)
    const rec = deps.store.written.readings.find((x) => x.kind === 'threshold')!
    expect(rec.proposal).toBeNull()
    expect(rec.notes[0]).toMatch(/^no pause proposed: campaign ended/)
  })
  it('reaching $100 runs the decision table with "at most N" sign-ups and both inputs (a flight before the new/existing split went live)', async () => {
    const fx = base()
    ads(fx).daily['2026-09-29'].costMicros = 70_000_000
    fx.store!.consumed = [25, 50, 75]
    const r = await runMorningRead({ ...fixtureDeps(fx, false), boundaries: { authNewExistingLiveAtMs: null } }, opts)
    expect(r.thresholds.crossedNow).toEqual([100])
    expect(r.thresholdRead!.kill.tripped).toContain('hard-cap')
    expect(r.thresholdRead!.kill.proposal).toBe('PROPOSE PAUSE')
    expect(r.thresholdRead!.decision).toMatchObject({ signUpsAtMost: 1, taggedAuthSuccess: 1, windowNewAccounts: 1, row: 'one' })
    expect(r.thresholdRead!.decision!.label).toBe('at most 1 campaign sign-up (tagged auth successes 1; new prod accounts sitewide in the window 1)')
    expect(r.notify.text).toMatch(/at most 1 campaign sign-ups \(upper bound\)/)
    expect(formatMorningReport(r)).toMatch(/at most 1 campaign sign-up \(tagged auth successes 1; new prod accounts sitewide in the window 1\)/)
    expect(r.notify.text).not.toMatch(/verified/i)
  })
  it('release health is never evaluated at 08:00 ET', async () => {
    const r = await runMorningRead(fixtureDeps(base(), true), opts)
    expect(r.releaseHealth.evaluated).toBe(false)
    expect(r.releaseHealth.reason).toMatch(/quiet window/)
  })
  it('the evening backstop evaluates on a day that served ads; 2 post-fix install accepts are only a watch', async () => {
    const fx = base()
    fx.now = '2026-09-30T03:30:00Z' // 23:30 ET on 09-29
    ads(fx).daily['2026-09-29'].costMicros = 13_400_000
    const r = await runMorningRead(fixtureDeps(fx, false), { ...opts, healthOnly: true })
    expect(r.mode).toBe('health-only')
    expect(r.releaseHealth.evaluated).toBe(true)
    const install = r.releaseHealth.results!.find((x) => x.id === 'install-accept→installed')!
    expect(install).toMatchObject({ status: 'watch', parent: 2, children: 0 })
    expect(r.notify.push).toBe(false)
  })
  it('the backstop RAISES install accepts >= MIN_COHORT after the fix with no installed outcome', async () => {
    const fx = base()
    fx.now = '2026-09-30T03:30:00Z'
    const b = fx.beacon as Extract<Fixture['beacon'], { siteEvents: unknown }>
    b.siteEvents = b.siteEvents.map((x) => (x.path === '/install/pwa-accept' ? { ...x, count: 6 } : x))
    const r = await runMorningRead(fixtureDeps(fx, false), { ...opts, healthOnly: true })
    expect(r.releaseHealth.results!.find((x) => x.id === 'install-accept→installed')!.status).toBe('alert')
    expect(r.notify.push).toBe(true)
    expect(r.notify.text).toMatch(/release-health ALERT: install-prompt accepts \(\/install\/pwa-accept, after the fix, ≥24h old\) 6, \/popup-outcome\/install-prompt\/installed \(after the fix\) 0\./)
  })
  it('the backstop PUSHES on a real alert (parent >= MIN_COHORT, outcome window elapsed, child zero) and never on a watch', async () => {
    const fx = base()
    fx.now = '2026-09-30T03:30:00Z'
    const b = fx.beacon as Extract<Fixture['beacon'], { siteEvents: unknown }>
    // drop the sign-in prompt's outcome: 9 matured shown, 0 outcomes -> alert
    b.siteEvents = b.siteEvents.filter((x) => x.path !== '/popup-outcome/signin-prompt/signed-in')
    const alert = await runMorningRead(fixtureDeps(fx, false), { ...opts, healthOnly: true })
    expect(alert.releaseHealth.alerts).toBe(1)
    expect(alert.notify).toMatchObject({ push: true, busCopy: false })
    expect(alert.notify.text).toMatch(/^BSK retest release-health ALERT: sign-in prompt shown \(≥24h old\) 9, \/popup-outcome\/signin-prompt\/\* 0\.$/)
    // only 3 shown -> watch -> no push
    b.siteEvents = b.siteEvents.map((x) => (x.path === '/signin-prompt/placement' ? { ...x, count: 3 } : x))
    const watch = await runMorningRead(fixtureDeps(fx, false), { ...opts, healthOnly: true })
    expect(watch.releaseHealth.results!.find((x) => x.id === 'signin-prompt→outcomes')!.status).toBe('watch')
    expect(watch.notify.push).toBe(false)
  })
  it('a shown event younger than the outcome window is not an alert parent', async () => {
    const fx = base()
    fx.now = '2026-09-28T03:30:00Z' // 23:30 ET on 09-27; the 18:00Z shown rows on 09-27 are < 24h old
    const b = fx.beacon as Extract<Fixture['beacon'], { siteEvents: unknown }>
    b.siteEvents = b.siteEvents.filter((x) => !x.path.startsWith('/popup-outcome/'))
    ads(fx).daily['2026-09-27'].costMicros = 13_200_000
    const r = await runMorningRead(fixtureDeps(fx, false), { ...opts, healthOnly: true })
    expect(r.releaseHealth.alerts).toBe(0)
    expect(r.notify.push).toBe(false)
  })
  it('the backstop does not evaluate on a day with no ads served', async () => {
    const fx = base()
    fx.now = '2026-09-30T03:30:00Z'
    ads(fx).daily['2026-09-29'].costMicros = 0
    const r = await runMorningRead(fixtureDeps(fx, true), { ...opts, healthOnly: true })
    expect(r.releaseHealth).toMatchObject({ evaluated: false, reason: 'not evaluated: no ads served today' })
  })
})

describe('postflight-read', () => {
  it('reports "not due" and records nothing before spend end + 7', async () => {
    const deps = fixtureDeps(base(), false)
    const r = await runPostflightRead(deps, { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(r.due).toBe(false)
    expect(r.dueEt).toBe('2026-10-09') // flight end 2026-10-02 + 7, whatever the last spend day
    expect(r.notify.push).toBe(false)
    expect(r.read).toBeNull()
    expect(deps.store.written.readings).toEqual([])
  })
  it('when due: full read, decision table, promo vs non-promo split, one post-flight record, push + bus', async () => {
    const fx = base()
    fx.now = '2026-10-09T13:00:00Z'
    const deps = fixtureDeps(fx, false)
    const r = await runPostflightRead(deps, { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(r.due).toBe(true)
    expect(r.read!.decision).not.toBeNull()
    expect(r.promoSplit.beacon!.promoShown).toBe(6)
    expect(r.promoSplit.beacon!.promo.returned).toBe(2)
    expect(r.promoSplit.accounts).toEqual({ newInWindow: 1, promoClaimsInWindow: 1, nonPromoInWindow: 0 })
    expect(r.read!.returns!.web['d31-60']).toBe(0)
    expect(deps.store.written.readings.map((x) => [x.kind, x.stage])).toEqual([['postflight', 'wrapup']])
    expect(r.notify).toMatchObject({ push: true, busCopy: true })
    expect(r.failures).toEqual([])
    expect(formatPostflightReport(r)).toMatch(/Promo vs non-promo/)
  })
  it('a failed read is named in the post-flight push; a failed read before the due date still pushes', async () => {
    const fx = base()
    fx.now = '2026-10-09T13:00:00Z'
    fx.beacon = { error: 'wrangler unavailable' }
    const due = await runPostflightRead(fixtureDeps(fx, false), { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(due.notify.text).toMatch(/Read problems: beacon \(wrangler unavailable\)\.$/)
    const early = base()
    early.ads = { error: 'OAuth refresh failed' }
    const r = await runPostflightRead(fixtureDeps(early, false), { campaignId: '24279250691', stage: 'day15', force: false })
    expect(r.due).toBe(false)
    expect(r.notify).toMatchObject({ push: true, text: 'BSK retest day15 read FAILED: Google Ads spend (OAuth refresh failed); campaign status (OAuth refresh failed).' })
  })
  it('before the new/existing split went live, a post-flight read carries its recommendation and "at most N" sign-ups', async () => {
    const fx = base()
    fx.now = '2026-10-09T13:00:00Z'
    const deps = { ...fixtureDeps(fx, false), boundaries: { authNewExistingLiveAtMs: null } }
    const r = await runPostflightRead(deps, { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(r.recommendations).toEqual([AUTH_SUCCESS_SPLIT_RECOMMENDATION])
    const text = formatPostflightReport(r)
    expect(text).toContain('add /auth/success/<provider>/new|existing via additionalUserInfo.isNewUser (frozen until 10-02)')
    expect(text).toMatch(/at most 1 campaign sign-up \(tagged auth successes 1; new prod accounts sitewide in the window 1\)/)
    expect(r.notify.text).toMatch(/at most 1 campaign sign-ups \(upper bound\)/)
    expect(deps.store.written.readings[0].notes).toContain(AUTH_SUCCESS_SPLIT_RECOMMENDATION)
    expect(r.cohort).toBeNull() // the wrap-up does not read the tier split
    expect(r.cohortNote).toBeNull()
  })
  it('with the split live (v1.95.5, the default now) the recommendation is gone', async () => {
    const fx = base()
    fx.now = '2026-10-09T13:00:00Z'
    const r = await runPostflightRead(fixtureDeps(fx, false), { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(r.recommendations).toEqual([])
    expect(formatPostflightReport(r)).not.toContain('frozen until 10-02')
  })
  it('M1: continued spend on a still-serving campaign pushes PROPOSE PAUSE even before the stage is due, and never moves the wrap-up', async () => {
    const fx = base()
    fx.now = '2026-10-05T13:00:00Z'
    ads(fx).daily['2026-10-03'] = { costMicros: 9_000_000, impressions: 100, clicks: 1 }
    ads(fx).daily['2026-10-04'] = { costMicros: 9_000_000, impressions: 100, clicks: 1 }
    const deps = fixtureDeps(fx, false)
    const r = await runPostflightRead(deps, { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(r.due).toBe(false)
    expect(r.dueEt).toBe('2026-10-09')
    expect(r.postFlightSpend).toMatchObject({ status: 'trip', value: 18 })
    expect(r.notify).toMatchObject({ push: true, busCopy: false })
    expect(r.notify.text).toMatch(/^BSK retest after the flight: \$18\.00 spent after 2026-10-02; campaign reads ENABLED\/SERVING.*PROPOSE PAUSE\.$/)
    expect(deps.store.written.readings).toEqual([]) // the stage itself still waits for its date
  })
  it('M1: the $100 cap is re-checked post-flight and pushes for a campaign still serving', async () => {
    const fx = base()
    fx.now = '2026-10-05T13:00:00Z'
    ads(fx).daily['2026-09-29'].costMicros = 70_000_000
    const r = await runPostflightRead(fixtureDeps(fx, true), { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(r.hardCap).toMatchObject({ status: 'trip' })
    expect(r.notify.text).toMatch(/at or over the cap.*PROPOSE PAUSE\.$/)
    ads(fx).status.servingStatus = 'ENDED'
    const ended = await runPostflightRead(fixtureDeps(fx, true), { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(ended.hardCap).toMatchObject({ status: 'clear' })
    expect(ended.notify.push).toBe(false)
  })
  it('after-flight spend on an ENDED campaign is reported, never a pause proposal; a still-serving one is', async () => {
    const fx = base()
    fx.now = '2026-10-11T13:00:00Z'
    ads(fx).daily['2026-10-03'] = { costMicros: 2_000_000, impressions: 100, clicks: 1 }
    ads(fx).status.servingStatus = 'ENDED'
    const ended = await runPostflightRead(fixtureDeps(fx, false), { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(ended.postFlightSpend).toMatchObject({ status: 'clear' })
    expect(ended.postFlightSpend!.detail).toMatch(/campaign ended \(ENABLED\/ENDED\), nothing to pause/)
    expect(ended.notify.text).not.toMatch(/PROPOSE PAUSE/)
    ads(fx).status.servingStatus = 'SERVING'
    const serving = await runPostflightRead(fixtureDeps(fx, false), { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(serving.postFlightSpend).toMatchObject({ status: 'trip' })
    expect(serving.notify.text).toMatch(/PROPOSE PAUSE \(spend after 2026-10-02\)/)
  })
})

describe('postflight-read: day-15/30/60 cohort by tier (Firestore COUNTs, sitewide)', () => {
  const tiers = { total: 6, paid: 1, accessPast: 0, trialPast: 3, trialPastAndPaid: 0, trialPastAndAccessPast: 0, promoSet: 2 }
  it('day15 reads the tier split, gates rates by MIN_COHORT, labels it sitewide, and stores the counts', async () => {
    const fx = base()
    fx.now = '2026-10-17T13:00:00Z'
    fx.firebase = { ...(fx.firebase as any), cohortTiers: tiers }
    const deps = fixtureDeps(fx, false)
    const r = await runPostflightRead(deps, { campaignId: '24279250691', stage: 'day15', force: false })
    expect(r.due).toBe(true)
    expect(r.cohort).toMatchObject({ label: 'sitewide, not campaign-attributed', total: 6, paid: 1, expired: 3, trialActive: 2, promoSet: 2, promoUnset: 4, consistent: true })
    expect(r.cohort!.rates.paid.value).toBeCloseTo(1 / 6)
    expect(formatPostflightReport(r)).toMatch(/Cohort \(accounts created in the flight window; sitewide, not campaign-attributed\): 6 total; paid 16\.7% \(1\/6\)/)
    expect(deps.store.written.readings[0].counts).toMatchObject({ cohortTotal: 6, cohortPaid: 1, cohortExpired: 3, cohortTrialActive: 2, cohortPromoSet: 2, cohortPromoUnset: 4 })
  })
  it('a cohort under MIN_COHORT shows counts, not percentages', async () => {
    const fx = base()
    fx.now = '2026-11-01T13:00:00Z'
    fx.firebase = { ...(fx.firebase as any), cohortTiers: { ...tiers, total: 3, trialPast: 1, promoSet: 1 } }
    const r = await runPostflightRead(fixtureDeps(fx, true), { campaignId: '24279250691', stage: 'day30', force: false })
    expect(formatPostflightReport(r)).toMatch(/paid too few \(1\/3\)/)
  })
  it('a missing composite index degrades to "tier split unavailable: index missing" and keeps the plain window count', async () => {
    const fx = base()
    fx.now = '2026-12-01T14:00:00Z'
    fx.firebase = { ...(fx.firebase as any), cohortTiers: null, errors: ['cohort paid: needs a Firestore composite index (not created; owner step)'] }
    const r = await runPostflightRead(fixtureDeps(fx, true), { campaignId: '24279250691', stage: 'day60', force: false })
    expect(r.cohort).toBeNull()
    expect(r.cohortNote).toBe('tier split unavailable: index missing')
    expect(r.failures).toEqual([]) // a known degrade, not a failed read: no "Read problems" push text
    expect(r.notify.text).not.toMatch(/Read problems/)
    expect(formatPostflightReport(r)).toMatch(/Cohort by tier: tier split unavailable: index missing \(plain window count: 1 new accounts, sitewide\)/)
  })
  it('the wrap-up and december stages never ask for the tier split', async () => {
    const fx = base()
    fx.now = '2026-12-03T14:00:00Z'
    fx.firebase = { ...(fx.firebase as any), cohortTiers: tiers }
    const r = await runPostflightRead(fixtureDeps(fx, true), { campaignId: '24279250691', stage: 'december', force: false })
    expect(r.cohort).toBeNull()
    expect(r.read!.firebase!.cohortTiers).toBeUndefined()
  })
})

describe('reports', () => {
  it('the JSON block carries the same numbers and no credential-shaped string', async () => {
    const r = await runMorningRead(fixtureDeps(base(), true), opts)
    const out = withJson(formatMorningReport(r), r)
    const json = JSON.parse(out.split('----- JSON -----')[1])
    expect(json.spend.cumulative.cost).toBe(50.1)
    expect(out).not.toMatch(/ya29\.|BEGIN [A-Z ]*PRIVATE KEY|developer-token"\s*:/)
  })
  it('every rate in the text shows its counts; sign-ups appear only as counts', async () => {
    const r = await runMorningRead(fixtureDeps(base(), true), opts)
    const text = formatMorningReport(r)
    expect(text).toMatch(/d1 too few|d1 10\.3% \(3\/29\)/)
    expect(text).toMatch(/nobody matched/)
  })
  // Review finding, 2026-09-26: asks/taggedArrivals mixed an event-row count against a
  // first-beacon-only count with no shared visitor id — not a real rate. It's a count pair now.
  it('asks show as a count pair ("N asks · M arrivals"), never a percentage', async () => {
    const r = await runMorningRead(fixtureDeps(base(), true), opts)
    const text = formatMorningReport(r)
    expect(text).toMatch(/5 asks · 30 arrivals/)
    expect(text).not.toMatch(/ask rate/)
  })
})

describe('mid-flight instrumentation: the upsell-fix segment boundary and exact sign-ups', () => {
  const FIX = Date.parse('2026-09-29T18:26:00Z') // 14:26 ET on 09-29
  const at100 = () => {
    const fx = base()
    ads(fx).daily['2026-09-29'].costMicros = 70_000_000
    fx.store!.consumed = [25, 50, 75]
    return fx
  }
  it('the $100 read reports pre-fix and post-fix spend, asks, accepts and sign-ups separately', async () => {
    const deps = { ...fixtureDeps(at100(), false), boundaries: { upsellFixAtMs: FIX } }
    const r = await runMorningRead(deps, opts)
    const seg = r.thresholdRead!.segments!
    expect(seg.boundaryLabel).toBe('2026-09-29 14:26 ET')
    expect(seg.pre.asks + seg.post.asks).toBe(r.thresholdRead!.tagged!.summary.asks.total)
    expect(seg.pre.asks).toBe(3) // /signin-prompt/placement on 09-28
    expect(seg.post.asks).toBe(2) // /promo-first50/shown on 09-29 21:00Z, after the fix
    expect(seg.post.accepts).toBe(1)
    expect(seg.boundaryDay).toBe('2026-09-29')
    const text = formatMorningReport(r)
    expect(text).toMatch(/Segments at the signed-out upsell fix \(2026-09-29 14:26 ET\) — two separate short tests \(spec section 14a\):/)
    expect(text).toMatch(/ {2}pre-fix: spend \$\d+\.\d\d over \d+ closed day\(s\); .*asks 3, accepts 0/)
    expect(text).toMatch(/ {2}post-fix: .*asks 2, accepts 1/)
    expect(text).toMatch(/fix day 2026-09-29: spend \$70\.00 \(straddles the fix/)
    expect(r.notify.text).toMatch(/split at the upsell fix: pre-fix 3 asks\/0 sign-ups, post-fix 2 asks\/1 sign-ups/)
    const rec = deps.store.written.readings.find((x) => x.kind === 'threshold')!
    expect(rec.counts).toMatchObject({ preFixAsks: 3, postFixAsks: 2, postFixAccepts: 1, fixDaySpend: 70 })
  })
  it('the post-flight wrap-up reports the segments too', async () => {
    const fx = base()
    fx.now = '2026-10-09T13:00:00Z'
    const r = await runPostflightRead({ ...fixtureDeps(fx, false), boundaries: { upsellFixAtMs: FIX } }, { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(r.read!.segments).not.toBeNull()
    expect(formatPostflightReport(r)).toMatch(/Segments at the signed-out upsell fix/)
    expect(r.notify.text).toMatch(/split at the upsell fix \(see report\)/)
  })
  it('without a boundary (the instant is still null) nothing changes', async () => {
    const r = await runMorningRead(fixtureDeps(at100(), false), opts)
    expect(r.thresholdRead!.segments).toBeNull()
    expect(formatMorningReport(r)).not.toMatch(/Segments at/)
  })
  it('once /new|existing is live, a tagged /new sign-up is counted exactly', async () => {
    const fx = at100()
    const b = fx.beacon as Extract<Fixture['beacon'], { tagged: unknown }>
    // The new client sends the status row ALONGSIDE the base row: one sign-in, two rows.
    const base = b.tagged.find((t) => t.path === '/auth/success/google')!
    b.tagged = [...b.tagged, { ...base, path: '/auth/success/google/new' }]
    const r = await runMorningRead({ ...fixtureDeps(fx, false), boundaries: { authNewExistingLiveAtMs: Date.parse('2026-09-28T16:00:00Z') } }, opts)
    expect(r.thresholdRead!.decision).toMatchObject({ signUpsAtMost: 1, signUpsExact: true, signUpsExactNew: 1, row: 'one' })
    expect(r.notify.text).toMatch(/1 campaign sign-up \(exact\), row one/)
    expect(formatMorningReport(r)).toMatch(/1 campaign sign-up \(exact: tagged \/auth\/success\/<provider>\/new since 2026-09-28 12:00 ET\)/)
  })
})

describe('same-day reruns: one reading per entry, no repeated push (owner, 2026-09-26)', () => {
  const hour = 3_600_000
  it('an incomplete threshold read rerun the same morning is not stored or pushed as a threshold again; the failure still pushes', async () => {
    const fx = base()
    fx.beacon = { error: 'wrangler unavailable' }
    const deps = fixtureDeps(fx, false)
    const first = await runMorningRead(deps, opts)
    expect(first.notify).toMatchObject({ push: true, busCopy: true })
    const again = await runMorningRead({ ...deps, nowMs: deps.nowMs + hour }, opts)
    expect(again.thresholdRead!.complete).toBe(false)
    expect(again.dedup.skipped.map((s) => s.entryKind)).toEqual(['morning+incomplete', 'threshold-50+incomplete'])
    expect(deps.store.written.readings.map((x) => x.entryKind)).toEqual(['morning+incomplete', 'threshold-50+incomplete'])
    expect(again.notify.busCopy).toBe(false) // the threshold read was already copied
    expect(again.notify.text).toMatch(/^BSK retest morning read FAILED: beacon \(wrangler unavailable\)/)
    expect(again.notify.text).not.toMatch(/\$50 read/)
  })
  it('a complete retry of an incomplete threshold read the same day IS new: stored, pushed, and it consumes the threshold', async () => {
    const fx = base()
    fx.beacon = { error: 'wrangler unavailable' }
    const deps = fixtureDeps(fx, false)
    await runMorningRead(deps, opts)
    const healthy = fixtureDeps(base(), false)
    const retry = await runMorningRead({ ...deps, beacon: healthy.beacon, beaconInitError: null, nowMs: deps.nowMs + hour }, opts)
    expect(retry.thresholdRead!.complete).toBe(true)
    expect(retry.notify).toMatchObject({ push: true, busCopy: true })
    expect(retry.notify.text).toMatch(/^BSK retest \$50 read:/)
    expect(deps.store.written.readings.map((x) => x.entryKind)).toEqual(['morning+incomplete', 'threshold-50+incomplete', 'morning', 'threshold-50'])
    expect(await deps.store.getConsumedThresholds('24279250691')).toEqual([25, 50])
  })
  it('the hard-cap trip is pushed once per day, not on every rerun', async () => {
    const fx = base()
    ads(fx).daily['2026-09-29'].costMicros = 70_000_000
    fx.store!.consumed = [25, 50, 75, 100]
    const deps = fixtureDeps(fx, false)
    const first = await runMorningRead(deps, opts)
    expect(first.notify.text).toMatch(/PROPOSE PAUSE/)
    const again = await runMorningRead({ ...deps, nowMs: deps.nowMs + hour }, opts)
    expect(again.hardCapDaily!.status).toBe('trip')
    expect(again.notify.push).toBe(false)
    expect(again.notify.reason).toMatch(/already recorded and pushed today \(morning\+pause\)/)
  })
  it('the backstop does not re-push the same alert on a rerun the same night', async () => {
    const fx = base()
    fx.now = '2026-09-30T03:30:00Z'
    const b = fx.beacon as Extract<Fixture['beacon'], { siteEvents: unknown }>
    b.siteEvents = b.siteEvents.filter((x) => x.path !== '/popup-outcome/signin-prompt/signed-in')
    const deps = fixtureDeps(fx, false)
    const first = await runMorningRead(deps, { ...opts, healthOnly: true })
    expect(first.notify.push).toBe(true)
    const again = await runMorningRead({ ...deps, nowMs: deps.nowMs + 20 * 60_000 }, { ...opts, healthOnly: true })
    expect(again.releaseHealth.alerts).toBe(1)
    expect(again.notify.push).toBe(false)
    expect(deps.store.written.readings.map((x) => x.entryKind)).toEqual(['backstop+alert-signin-prompt-outcomes'])
  })
  it('a post-flight stage rerun the same day is not stored, pushed or copied again', async () => {
    const fx = base()
    fx.now = '2026-10-09T13:00:00Z'
    const deps = fixtureDeps(fx, false)
    const first = await runPostflightRead(deps, { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(first.notify).toMatchObject({ push: true, busCopy: true })
    const again = await runPostflightRead({ ...deps, nowMs: deps.nowMs + hour }, { campaignId: '24279250691', stage: 'wrapup', force: true })
    expect(again.notify).toMatchObject({ push: false, busCopy: false })
    expect(again.dedup.skipped.map((s) => s.entryKind)).toEqual(['postflight-wrapup'])
    expect(deps.store.written.readings).toHaveLength(1)
  })
  it('the morning read syncs first through the shared sync: a second read an hour later re-pulls only the last 3 days (review M1) and changes nothing', async () => {
    const deps = fixtureDeps(base(), false)
    const first = await runMorningRead(deps, opts)
    expect(first.spend.sync).toMatchObject({ fetched: { since: '2026-09-26', until: '2026-09-29' }, daysChanged: 4 })
    const again = await runMorningRead({ ...deps, nowMs: deps.nowMs + hour }, opts)
    expect(again.spend.sync).toMatchObject({ fetched: { since: '2026-09-27', until: '2026-09-29' }, daysChanged: 0, placementRowsChanged: 0 })
    expect(again.spend.todayPartial).toEqual(first.spend.todayPartial)
    expect(again.spend.cumulative.cost).toBe(first.spend.cumulative.cost)
    // and so does every later read
    const later = await runMorningRead({ ...deps, nowMs: deps.nowMs + 7 * hour }, opts)
    expect(later.spend.sync).toMatchObject({ fetched: { since: '2026-09-27', until: '2026-09-29' }, daysChanged: 0 })
    expect(deps.store.dailyRows('24279250691').map((r) => r.date)).toEqual(['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']) // never today's open day
    expect(deps.store.written.syncRuns.map((r) => r.source)).toEqual(['morning-read', 'morning-read', 'morning-read'])
  })
})

describe('review M1 (2026-09-26): the reads re-pull the restatement window every time', () => {
  // The Worker's 00:05 and 01:05 ET runs failed; its 03:05 ET run stored yesterday (09-29) at $5
  // as a closed day, before Google added the rest of the day's cost. The 08:05 ET read must
  // re-pull, not trust a 5-hour-old pull because the Worker's 6 h cadence says it is recent.
  const workerPulledEarly = async (fx: Fixture) => {
    const deps = fixtureDeps(fx, false)
    const truth = { ...ads(fx).daily['2026-09-29'] }
    ads(fx).daily['2026-09-29'] = { costMicros: 5_000_000, impressions: 1900, clicks: 15 }
    const worker = await syncAdsData({ ads: deps.ads, store: deps.store }, { campaignIds: ['24279250691'], now: Date.parse('2026-09-30T07:05:00Z'), dryRun: false, source: 'worker-cron' })
    expect(worker.campaigns[0]).toMatchObject({ pulled: true, spendThrough: '2026-09-29' }) // closed: pulled after 03:00 ET
    ads(fx).daily['2026-09-29'] = truth // Google's late data lands
    return deps
  }
  it('the morning read reports the true $13.40 for yesterday, not the $5 the Worker stored at 03:05 ET', async () => {
    const deps = await workerPulledEarly(base())
    const r = await runMorningRead(deps, opts)
    expect(r.spend.yesterday).toMatchObject({ date: '2026-09-29', cost: 13.4 })
    expect(r.spend.restated).toEqual([{ date: '2026-09-29', before: 5, after: 13.4 }])
    expect(r.spend.cumulative.cost).toBe(50.1)
    expect(deps.store.dailyRows('24279250691').find((x) => x.date === '2026-09-29')!.costMicros).toBe(13_400_000)
  })
  it('the backstop and the post-flight read re-pull it too', async () => {
    const fx = base()
    const deps = await workerPulledEarly(fx)
    const backstop = await runMorningRead({ ...deps, nowMs: Date.parse('2026-09-30T13:05:00Z') }, { ...opts, healthOnly: true })
    expect(backstop.spend.yesterday).toMatchObject({ date: '2026-09-29', cost: 13.4 })
    const fx2 = base()
    const deps2 = await workerPulledEarly(fx2)
    const post = await runPostflightRead({ ...deps2, nowMs: Date.parse('2026-09-30T12:05:00Z') }, { campaignId: '24279250691', stage: 'wrapup', force: false })
    expect(post.spend.restated).toEqual([{ date: '2026-09-29', before: 5, after: 13.4 }])
  })
})

describe('review I2 (2026-09-26): the reads report a sync run that was killed', () => {
  it('a Worker claim with no finished run shows as a SYNC ALERT line in the morning report and its JSON', async () => {
    const deps = fixtureDeps(base(), false)
    expect(await deps.store.claimSync('worker-cron', Date.parse('2026-09-30T04:05:00Z'), 600_000)).toBe(true)
    const r = await runMorningRead(deps, opts)
    expect(r.spend.syncAlerts).toEqual([expect.stringMatching(/^The worker-cron sync started Sep 30 00:05 ET never finished/)])
    expect(formatMorningReport(r)).toMatch(/^  SYNC ALERT: The worker-cron sync started Sep 30 00:05 ET never finished/m)
    const quiet = await runMorningRead(fixtureDeps(base(), false), opts)
    expect(quiet.spend.syncAlerts).toEqual([])
    expect(formatMorningReport(quiet)).not.toMatch(/SYNC ALERT/)
  })
})
