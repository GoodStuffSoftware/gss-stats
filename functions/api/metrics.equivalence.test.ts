// EQUIVALENCE (ADR 0003 slice 3): the same node:sqlite `hits` fixture gives the same counts
// through POST /api/metrics as through /api/campaigns and /api/popups — every
// handler runs its own SQL against one real SQLite database. Where the registry deliberately
// differs, the test asserts the difference itself, so it is documented and cannot drift:
//
//   D1  Install-rate denominator: the registry counts prompts shown at/after the install fix
//       row-exactly (the fact's `pf` split, as /api/popups does); /api/overview and
//       /api/campaigns bucket by hour, so a prompt in the fix's own hour but after it is
//       left out of theirs.
//   D2  seenInFlightWindow applies to CLOSED flights only: /api/campaigns also marks an ACTIVE
//       flight's not-yet-seen steps "not instrumented" (rate null); the registry keeps them live.
//   D3  The overview scorecard shows a return rate and counts for a flight that ended before
//       the return beacon existed; the registry (like /api/campaigns' returnVisits
//       .notInstrumented) returns `unmeasured`.
//   D4  A spend-only campaign: the endpoints return zero counts and a null cost; the registry
//       returns `unmeasured` (reason spend-only) for every beacon metric. Spend itself matches.
//   D5  Closed-campaign steps the endpoints list in notInstrumented still carry a count there;
//       the registry returns `unmeasured` instead of a number.
//   D6  A bare YYYY-MM-DD page range is an ET day for the registry (review #13), like every other
//       day on the dashboard; /api/popups (and /api/geo) still read it as a UTC day. The
//       dashboard's range control always sends datetimes, which both read identically.
// (The /api/overview KPI and scorecard comparisons retired with those sections in CONFIG_VERSION
// 10; the cards that replaced them are pinned against a golden of the retired bespoke body in
// src/components/metrics/presets.parity.test.ts, which lists D1, D3, D4 and D5 there.)
//
// /api/campaigns' side is read through `campaignsGolden`: the live handler while it exists, checked
// against __fixtures__/campaigns.golden.json (SLICE7_CAPTURE=1 rewrites it), then — once the
// endpoint retires with slice 7 — that stored response, captured from it on this fixture.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost as campaignsPost } from './campaigns'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import CAMPAIGNS_GOLDEN_FILE from './__fixtures__/campaigns.golden.json'
import { onRequestPost as popupsPost } from './popups'
import { onRequestPost as metricsPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import { bskFixture, FIXTURE_NOW } from '../_lib/testing/bskFixture'
import { CAMPAIGNS, type FunnelStepKey } from '../../src/lib/campaigns'
import type { MetricRequest, MetricValue, MetricsResponseBody } from '../../src/lib/metrics/types'

const ANDROID = '24215315197'
const PLAY = '24234347705'
const RETEST = '24279250691'
let db: ReturnType<typeof openHitsDb>
let undoCaches: () => void

const GOLDEN_PATH = resolve(process.cwd(), 'functions/api/__fixtures__/campaigns.golden.json')
const CAPTURE = process.env.SLICE7_CAPTURE === '1'
const GOLDEN: Record<string, unknown> = { ...(CAMPAIGNS_GOLDEN_FILE as Record<string, unknown>) }
const captured: Record<string, unknown> = {}
/** /api/campaigns' response for one campaign on the fixture (its `meta` left out). */
async function campaignsGolden(id: string): Promise<any> {
  const { meta: _meta, ...live } = await call(campaignsPost, '/api/campaigns', { campaignId: id })
  const value = JSON.parse(JSON.stringify(live))
  if (CAPTURE) captured[id] = value
  else expect(value, `live /api/campaigns ≡ golden ${id}`).toEqual(GOLDEN[id])
  return value
}
afterAll(() => {
  if (CAPTURE) writeFileSync(GOLDEN_PATH, JSON.stringify({ ...GOLDEN, ...captured }, null, 2) + '\n')
})

beforeAll(() => {
  db = openHitsDb()
  insertHits(db, bskFixture())
})
beforeEach(() => {
  vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
})
afterEach(() => {
  vi.useRealTimers()
  undoCaches()
})

async function call(handler: (ctx: any) => Response | Promise<Response>, path: string, body: unknown): Promise<any> {
  const waited: Promise<unknown>[] = []
  const res = await handler(pagesContext(postJson(path, body), { gss_geo: sqliteD1(db) }, waited))
  await Promise.all(waited)
  expect(res.status, `${path} ${await res.clone().text()}`).toBe(200)
  return res.json()
}
async function metrics(requests: MetricRequest[], context?: Record<string, unknown>): Promise<Record<string, MetricValue>> {
  const body = (await call(metricsPost, '/api/metrics', { v: 1, ...(context ? { context } : {}), requests })) as MetricsResponseBody
  return body.results
}

const STEP_METRIC: Record<Exclude<FunnelStepKey, 'arrivals'>, string> = {
  played: 'campaign.gameViews',
  completed: 'campaign.completions',
  ask: 'campaign.asks',
  accept: 'campaign.accepts',
  authSuccess: 'campaign.authSuccess',
  installPrompt: 'campaign.installPrompts',
  install: 'campaign.installs',
}
const STEPS = Object.keys(STEP_METRIC) as (keyof typeof STEP_METRIC)[]

describe('/api/metrics ≡ /api/campaigns', () => {
  it.each(CAMPAIGNS.filter((c) => c.measurement !== 'spend-only').map((c) => [c.label, c.id] as const))('%s: counts, rates, returns, costs', async (_label, id) => {
    const cmp = await campaignsGolden(id)
    const p = { campaignId: id }
    const r = await metrics([
      { key: 'hits', metric: 'campaign.taggedHits', params: p },
      { key: 'arrivals', metric: 'campaign.taggedArrivals', params: p },
      { key: 'raw', metric: 'campaign.rawInstallSignals', params: p },
      { key: 'spend', metric: 'campaign.spend', params: p },
      { key: 'accept', ratio: 'campaign.acceptPerAsk', params: p },
      { key: 'cpa', ratio: 'campaign.costPerArrival', params: p },
      { key: 'cps', ratio: 'campaign.costPerSignin', params: p },
      { key: 'pair', ratio: 'campaign.gameViewsVsArrivals', params: p },
      ...STEPS.map((s) => ({ key: `s.${s.toLowerCase()}`, metric: STEP_METRIC[s], params: p })),
      ...(['D0', 'D1', 'D2to7', 'D8to14', 'D15to30', 'D31to60'] as const).map((b) => ({ key: `r${b.toLowerCase()}`, metric: `campaign.return${b}`, params: p })),
      ...(['D1', 'D2to7', 'D8to14', 'D15to30', 'D31to60'] as const).map((b) => ({ key: `rr${b.toLowerCase()}`, ratio: `campaign.return${b}PerD0`, params: p })),
    ])
    const campaign = CAMPAIGNS.find((c) => c.id === id)!
    expect(r.hits.value).toBe(cmp.taggedHits)
    expect(r.arrivals.value).toBe(cmp.funnel.counts.arrivals)
    expect(r.raw.value).toBe(cmp.rawInstallSignals.count)
    expect(r.spend.value ?? null).toBe(cmp.spend)
    expect(r.pair).toMatchObject({ numerator: r['s.played'].status === 'unmeasured' ? expect.any(Number) : cmp.funnel.counts.played, denominator: cmp.funnel.counts.arrivals })
    for (const s of STEPS) {
      const got = r[`s.${s.toLowerCase()}`]
      if (cmp.funnel.notInstrumented.includes(s)) {
        // D2: an active flight's not-yet-seen step stays live in the registry.
        if (campaign.status === 'closed') expect(got.status, `${s}: D5`).toBe('unmeasured')
        else expect(got, `${s}: D2`).toMatchObject({ status: expect.stringMatching(/^(ok|partial)$/), value: cmp.funnel.counts[s] })
      } else {
        expect(got.value, s).toBe(cmp.funnel.counts[s])
      }
    }
    if (!cmp.funnel.notInstrumented.includes('accept')) expect(r.accept.value ?? null).toBe(cmp.funnel.rates.accept)
    expect(r.cpa.value ?? null).toBe(cmp.costPerArrival)
    if (!cmp.funnel.notInstrumented.includes('authSuccess')) expect(r.cps.value ?? null).toBe(cmp.costPerAuthSuccess)
    if (cmp.returnVisits.notInstrumented) {
      for (const k of ['rd0', 'rd1', 'rd2to7', 'rrd2to7']) expect(r[k].status, k).toBe('unmeasured')
    } else {
      const counts = cmp.returnVisits.counts
      expect([r.rd0, r.rd1, r.rd2to7, r.rd8to14, r.rd15to30, r.rd31to60].map((v) => v.value)).toEqual([counts.d0, counts.d1, counts['d2-7'], counts['d8-14'], counts['d15-30'], counts['d31-60']])
      const rates = cmp.returnVisits.rates
      expect([r.rrd1, r.rrd2to7, r.rrd8to14, r.rrd15to30, r.rrd31to60].map((v) => v.value ?? null)).toEqual([rates.d1, rates['d2-7'], rates['d8-14'], rates['d15-30'], rates['d31-60']])
    }
  })

  it('D2: the retest has no sign-in accept yet; /api/campaigns says "not instrumented", the registry says 0 of 6', async () => {
    const cmp = await campaignsGolden(RETEST)
    const { accept } = await metrics([{ key: 'accept', ratio: 'campaign.acceptPerAsk', params: { campaignId: RETEST } }])
    expect(cmp.funnel.notInstrumented).toContain('accept')
    expect(cmp.funnel.rates.accept).toBeNull()
    expect(accept).toMatchObject({ status: 'ok', value: 0, numerator: 0, denominator: 6 })
  })

  it('D1: the install rate — same numerator, row-exact denominator', async () => {
    const cmp = await campaignsGolden(RETEST)
    const { rate } = await metrics([{ key: 'rate', ratio: 'campaign.installPerPrompt', params: { campaignId: RETEST } }])
    expect(cmp.funnel.installPromptPostFixCount).toBe(4)
    expect(rate).toMatchObject({ numerator: cmp.funnel.counts.install, denominator: 9 })
  })

  it('D4: the spend-only campaign — spend matches, every beacon metric is unmeasured', async () => {
    const cmp = await campaignsGolden(PLAY)
    const p = { campaignId: PLAY }
    const r = await metrics([
      { key: 'spend', metric: 'campaign.spend', params: p },
      { key: 'arrivals', metric: 'campaign.taggedArrivals', params: p },
      { key: 'cpa', ratio: 'campaign.costPerArrival', params: p },
    ])
    expect(r.spend.value).toBe(cmp.spend)
    expect(cmp.funnel.counts.arrivals).toBe(0)
    expect(cmp.costPerArrival).toBeNull()
    expect(r.arrivals).toEqual({ status: 'unmeasured', reason: 'spend-only' })
    expect(r.cpa).toEqual({ status: 'unmeasured', reason: 'spend-only' })
  })
})

describe('/api/metrics ≡ /api/popups rates', () => {
  const context = { since: '2026-09-20', until: '2026-09-26', sites: ['bestsudoku-web'] }
  it.each([
    ['upsell:tap', { ratio: 'popup.tapRate', params: { popup: 'upsell' } }],
    ['upsell:outcome:returned', { ratio: 'popup.returnedRate', params: { popup: 'upsell' } }],
    ['install:outcome:installed', { ratio: 'popup.installedRate', params: { popup: 'install' } }],
    ['signin-prompt:tap', { ratio: 'popup.tapRate', params: { popup: 'signin-prompt' } }],
    ['signin-eligible:rate', { ratio: 'popup.eligibility' }],
  ] as const)('%s', async (rateKey, req) => {
    const pop = await call(popupsPost, '/api/popups', { dimension: 'rate', rateKey, ...context })
    const { x } = await metrics([{ key: 'x', ...req }], context)
    expect(x.numerator).toBe(pop.numerator)
    expect(x.denominator).toBe(pop.denominator)
    expect(x.value ?? null).toBe(pop.rate)
    expect(pop.denominator).toBeGreaterThan(0)
  })
})

describe('D6: a bare-date page range is an ET day for the registry, a UTC day for /api/popups', () => {
  it('an evening-ET event (after midnight UTC) counts in its ET day; with datetimes both agree', async () => {
    const own = openHitsDb()
    const at = (iso: string, path: string, n: number) => ({ ts: Date.parse(iso), site: 'bestsudoku-web', path, n })
    insertHits(own, [
      at('2026-09-26T15:00:00Z', '/upsell/shown/limit', 6),
      at('2026-09-27T02:00:00Z', '/upsell/shown/limit', 4), // 22:00 ET on 2026-09-26
      at('2026-09-27T02:05:00Z', '/upsell/accept/limit', 2),
    ])
    const post = async (handler: (ctx: any) => Response | Promise<Response>, path: string, body: unknown) => (await handler(pagesContext(postJson(path, body), { gss_geo: sqliteD1(own) }))).json() as Promise<any>
    const bare = { since: '2026-09-26', until: '2026-09-26' }
    const m = (await post(metricsPost, '/api/metrics', { v: 1, context: bare, requests: [{ key: 'x', ratio: 'popup.tapRate', params: { popup: 'upsell' } }] })).results.x
    const p = await post(popupsPost, '/api/popups', { dimension: 'rate', rateKey: 'upsell:tap', ...bare })
    expect(m).toMatchObject({ numerator: 2, denominator: 10 }) // the ET day holds all of it
    expect(p).toMatchObject({ numerator: 0, denominator: 6 }) // the UTC day ends at 20:00 ET
    const iso = { since: '2026-09-26T04:00:00Z', until: '2026-09-27T04:00:00Z' }
    const m2 = (await post(metricsPost, '/api/metrics', { v: 1, context: iso, requests: [{ key: 'x', ratio: 'popup.tapRate', params: { popup: 'upsell' } }] })).results.x
    const p2 = await post(popupsPost, '/api/popups', { dimension: 'rate', rateKey: 'upsell:tap', ...iso })
    expect([m2.numerator, m2.denominator]).toEqual([p2.numerator, p2.denominator])
  })
})
