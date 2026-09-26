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
  it('the same read again the next morning fires nothing and pushes nothing (fire-once)', async () => {
    const deps = fixtureDeps(base(), false)
    await runMorningRead(deps, opts)
    const again = await runMorningRead({ ...deps, nowMs: deps.nowMs + 60_000 }, opts)
    expect(again.thresholds.crossedNow).toEqual([])
    expect(again.thresholdRead).toBeNull()
    expect(again.notify.push).toBe(false)
    expect(deps.store.written.readings.filter((x) => x.kind === 'daily')).toHaveLength(2) // append-only
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
    expect(r.notify.text).toMatch(/Read problems: beacon\./)
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
    expect(r.notify.text).toMatch(/^BSK retest morning read FAILED: Google Ads spend, campaign status unreadable/)
    expect(r.notify.text).not.toMatch(/Bitwarden|developer-token/) // details stay in the report, never the push
    expect(r.errors.join(' ')).toMatch(/developer-token/)
    expect(formatMorningReport(r)).toMatch(/READ FAILED: Google Ads spend, campaign status/)
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
  it('reaching $100 runs the decision table with "at most N" sign-ups and both inputs', async () => {
    const fx = base()
    ads(fx).daily['2026-09-29'].costMicros = 70_000_000
    fx.store!.consumed = [25, 50, 75]
    const r = await runMorningRead(fixtureDeps(fx, false), opts)
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
    expect(due.notify.text).toMatch(/Read problems: beacon\.$/)
    const early = base()
    early.ads = { error: 'OAuth refresh failed' }
    const r = await runPostflightRead(fixtureDeps(early, false), { campaignId: '24279250691', stage: 'day15', force: false })
    expect(r.due).toBe(false)
    expect(r.notify).toMatchObject({ push: true, text: 'BSK retest day15 read FAILED: Google Ads spend, campaign status unreadable. See the routine output.' })
  })
  it('every post-flight read carries the /auth/success new|existing recommendation and "at most N" sign-ups', async () => {
    const fx = base()
    fx.now = '2026-10-09T13:00:00Z'
    const deps = fixtureDeps(fx, false)
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
    expect(text).toMatch(/ask rate 16\.7% \(5\/30\)/)
    expect(text).toMatch(/d1 too few|d1 10\.3% \(3\/29\)/)
    expect(text).toMatch(/nobody matched/)
  })
})
