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
  it('reaching $100 runs the decision table with bounded sign-ups', async () => {
    const fx = base()
    ads(fx).daily['2026-09-29'].costMicros = 70_000_000
    fx.store!.consumed = [25, 50, 75]
    const r = await runMorningRead(fixtureDeps(fx, false), opts)
    expect(r.thresholds.crossedNow).toEqual([100])
    expect(r.thresholdRead!.kill.tripped).toContain('hard-cap')
    expect(r.thresholdRead!.decision).toMatchObject({ signUps: 1, row: 'one' })
    expect(r.thresholdRead!.decision!.basis).toMatch(/min\(1 tagged auth successes, 1 new prod accounts/)
  })
  it('release health is never evaluated at 08:00 ET', async () => {
    const r = await runMorningRead(fixtureDeps(base(), true), opts)
    expect(r.releaseHealth.evaluated).toBe(false)
    expect(r.releaseHealth.reason).toMatch(/quiet window/)
  })
  it('the evening backstop evaluates on a day that served ads, never alerting on the install known gap', async () => {
    const fx = base()
    fx.now = '2026-09-30T03:30:00Z' // 23:30 ET on 09-29
    ads(fx).daily['2026-09-29'].costMicros = 13_400_000
    const r = await runMorningRead(fixtureDeps(fx, false), { ...opts, healthOnly: true })
    expect(r.mode).toBe('health-only')
    expect(r.releaseHealth.evaluated).toBe(true)
    const install = r.releaseHealth.results!.find((x) => x.id === 'install-prompt→install-outcome')!
    expect(install.status).toBe('known-gap')
    expect(r.notify.push).toBe(false)
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
    expect(r.dueEt).toBe('2026-10-06') // last spend day in the fixture is 2026-09-29
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
