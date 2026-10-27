// The paywall's guest pass tap, `/upsell/accept-signin/<reason>` (best-sudoku 1.104.0), on a real SQLite engine:
//   - /api/popups lists it as a 'kind' row for the upsell only;
//   - the accept counts stay signed-in only; the two tap RATES (popup.tapRate, bsk.popupTapRate) count every tap;
//   - with no accept-signin rows (every day before the release) both rates equal what accepts alone would give.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost as popupsPost } from './popups'
import { onRequestPost as metricsPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1, type HitRow } from '../_lib/testing/hitsDb'
import { etWallTimeMs } from '../../src/lib/etTime'
import type { MetricsResponseBody } from '../../src/lib/metrics/types'

const DAY = etWallTimeMs('2026-10-07')
const H = (h: number) => DAY + h * 3_600_000 + 30 * 60_000
const SITE = 'bestsudoku-web'
const geoCols = { country: 'US', region: 'VA', city: 'Reston', device: 'mobile', browser: 'Chrome', os: 'Android', lang: 'en' }
const row = (path: string, n: number): HitRow & { n: number } => ({ ts: H(10), site: SITE, path, n, ...geoCols })

/** Twelve upsell renders: 2 signed-in taps, 3 guest pass taps, 1 dismiss, 6 unanswered. Plus a sign-in prompt shown 5, accepted 2. */
const BEFORE: (HitRow & { n: number })[] = [
  row('/upsell/shown/limit', 12),
  row('/upsell/accept/limit', 2),
  row('/upsell/dismiss/limit', 1),
  row('/signin-prompt/placement', 5),
  row('/signin-prompt/accept', 2),
]
const GUEST_TAPS = [row('/upsell/accept-signin/limit', 3)]

const day = { since: '2026-10-07', until: '2026-10-07' }
let undoCaches: () => void
const open = (rows: (HitRow & { n: number })[]) => {
  const d = openHitsDb()
  insertHits(d, rows)
  return d
}
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-12T12:00:00Z'), toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
})
afterEach(() => {
  undoCaches()
  vi.useRealTimers()
})

async function kindRows(d: DatabaseSync, popup: string) {
  const d1 = { prepare: (sql: string) => ({ bind: (...binds: unknown[]) => ({ all: async () => ({ results: d.prepare(sql).all(...(binds as any[])) }) }) }) }
  const res = await popupsPost({ request: { json: async () => ({ dimension: 'kind', popup, ...day }) }, env: { gss_geo: d1 } } as any)
  const body = (await res.json()) as { rows: { key: { kind: string }; pageviews: number }[] }
  return Object.fromEntries(body.rows.map((r) => [r.key.kind, r.pageviews]))
}
async function metrics(d: DatabaseSync, requests: Record<string, unknown>[]) {
  const waited: Promise<unknown>[] = []
  const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, context: day, requests }), { gss_geo: sqliteD1(d) }, waited) as any)
  await Promise.all(waited)
  if (res.status !== 200) throw new Error(await res.text())
  return ((await res.json()) as MetricsResponseBody).results as Record<string, any>
}
const ASK = [
  { key: 'shown', metric: 'popup.shown', params: { popup: 'upsell' }, window: 'page' },
  { key: 'accepts', metric: 'popup.accepts', params: { popup: 'upsell' }, window: 'page' },
  { key: 'signins', metric: 'popup.acceptSignins', params: { popup: 'upsell' }, window: 'page' },
  { key: 'taps', metric: 'popup.taps', params: { popup: 'upsell' }, window: 'page' },
  { key: 'rate', ratio: 'popup.tapRate', params: { popup: 'upsell' }, window: 'page' },
  { key: 'sp_rate', ratio: 'popup.tapRate', params: { popup: 'signin-prompt' }, window: 'page' },
  { key: 'bsk_accepts', metric: 'bsk.popupAccepts', window: 'page' },
  { key: 'bsk_rate', ratio: 'bsk.popupTapRate', window: 'page' },
]

describe('/api/popups kind rows', () => {
  it('lists accept-signin for the upsell only, and keeps accept the signed-in tap alone', async () => {
    const d = open([...BEFORE, ...GUEST_TAPS])
    try {
      expect(await kindRows(d, 'upsell')).toEqual({ shown: 12, accept: 2, 'accept-signin': 3, dismiss: 1 })
      expect(Object.keys(await kindRows(d, 'signin-prompt'))).toEqual(['shown', 'accept', 'dismiss'])
    } finally {
      d.close()
    }
  })
})

describe('the tap rates count every pass tap; the accepted counts do not', () => {
  it('with guest taps: accepts 2, pass-tapped 3, taps 5; upsell rate 5/12; the Overview rate counts them too; other pop-ups unchanged', async () => {
    const d = open([...BEFORE, ...GUEST_TAPS])
    try {
      const r = await metrics(d, ASK)
      expect(r.shown.value).toBe(12)
      expect(r.accepts.value).toBe(2)
      expect(r.signins.value).toBe(3)
      expect(r.taps.value).toBe(5)
      expect(r.rate).toMatchObject({ status: 'ok', numerator: 5, denominator: 12 })
      expect(r.sp_rate).toMatchObject({ status: 'ok', numerator: 2, denominator: 5 })
      expect(r.bsk_accepts.value).toBe(4) // upsell 2 + sign-in prompt 2: signed-in taps only
      expect(r.bsk_rate).toMatchObject({ numerator: 7, denominator: 17 }) // every tap over every shown
    } finally {
      d.close()
    }
  })
  it('with no accept-signin rows (every date before the release) the rates are exactly what accepts alone give', async () => {
    const d = open(BEFORE)
    try {
      const r = await metrics(d, ASK)
      expect(r.signins.value).toBe(0)
      expect(r.taps.value).toBe(r.accepts.value)
      expect(r.rate).toMatchObject({ status: 'ok', numerator: 2, denominator: 12 })
      expect(r.bsk_rate).toMatchObject({ numerator: 4, denominator: 17 })
      expect(r.bsk_rate.numerator).toBe(r.bsk_accepts.value)
    } finally {
      d.close()
    }
  })
})
