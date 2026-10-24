// POST /api/metrics for the sign-in eligibility split: earned by reason, and the finishes outside the rate
// (below-floor, not-now, stopped). A fresh hits table, so every count here is a row this file inserted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import { ELIGIBLE_EARNED_REASON_METRICS, ELIGIBLE_OTHER_METRICS } from '../../src/lib/metrics/metrics'
import type { MetricFactsEnv } from '../_lib/metricFacts'

const NOW = Date.parse('2026-09-26T21:00:00Z')
const AT = Date.parse('2026-09-26T14:04:00Z')
const WEB = 'bestsudoku-web'

let db: ReturnType<typeof openHitsDb>
let undoCaches: () => void
beforeEach(() => {
  db = openHitsDb()
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
})
afterEach(() => {
  vi.useRealTimers()
  undoCaches()
})

async function readAll() {
  const requests = [...ELIGIBLE_EARNED_REASON_METRICS, ...ELIGIBLE_OTHER_METRICS, { id: 'popup.eligibleEarned' }, { id: 'popup.eligibleCapped' }, { id: 'popup.eligibleUnearned' }].map((m) => ({ key: m.id.toLowerCase(), metric: m.id, window: 'page' }))
  const waited: Promise<unknown>[] = []
  const req = postJson('/api/metrics', { v: 1, context: { since: '2026-09-26', until: '2026-09-26' }, requests })
  const res = await onRequestPost(pagesContext(req, { gss_geo: sqliteD1(db) } as unknown as MetricFactsEnv, waited))
  await Promise.all(waited)
  return (await res.json()) as { results: Record<string, { status: string; value?: number }> }
}
const value = (r: Awaited<ReturnType<typeof readAll>>, id: string) => r.results[id.toLowerCase()]?.value

describe('/api/metrics eligibility split', () => {
  it('counts each earned row under its own reason, and the reasons add up to the earned count', async () => {
    insertHits(db, [
      { site: WEB, ts: AT, path: '/signin-eligible/earned/placement', n: 3 },
      { site: WEB, ts: AT, path: '/signin-eligible/earned/committed-repeat', n: 2 },
      { site: WEB, ts: AT, path: '/signin-eligible/earned/committed-challenge', n: 1 },
      { site: WEB, ts: AT, path: '/signin-eligible/earned/first50', n: 4 },
      { site: WEB, ts: AT, path: '/signin-eligible/earned/first-finish', n: 8 },
      { site: WEB, ts: AT, path: '/signin-eligible/earned', n: 5 }, // before the reason segment
      { site: WEB, ts: AT, path: '/signin-eligible/earned/brand-new-reason', n: 2 },
      { site: WEB, ts: AT, path: '/signin-eligible/capped', n: 6 },
      { site: WEB, ts: AT, path: '/signin-eligible/unearned', n: 7 },
    ])
    const r = await readAll()
    expect(value(r, 'popup.eligibleEarnedPlacement')).toBe(3)
    expect(value(r, 'popup.eligibleEarnedCommittedRepeat')).toBe(2)
    expect(value(r, 'popup.eligibleEarnedCommittedChallenge')).toBe(1)
    expect(value(r, 'popup.eligibleEarnedFirst50')).toBe(4)
    expect(value(r, 'popup.eligibleEarnedFirstFinish')).toBe(8)
    expect(value(r, 'popup.eligibleEarnedLegacy')).toBe(5)
    expect(value(r, 'popup.eligibleEarnedOther')).toBe(2)
    const sum = ELIGIBLE_EARNED_REASON_METRICS.reduce((a, m) => a + (value(r, m.id) ?? 0), 0)
    expect(sum).toBe(25)
    expect(value(r, 'popup.eligibleEarned')).toBe(25)
    expect(value(r, 'popup.eligibleCapped')).toBe(6)
    expect(value(r, 'popup.eligibleUnearned')).toBe(7)
  })

  it('below-floor, not-now and stopped are counted on their own and stay out of earned, capped and unearned', async () => {
    insertHits(db, [
      { site: WEB, ts: AT, path: '/signin-eligible/below-floor', n: 3 },
      { site: WEB, ts: AT, path: '/signin-eligible/not-now', n: 2 },
      { site: WEB, ts: AT, path: '/signin-eligible/stopped', n: 1 },
      { site: WEB, ts: AT, path: '/signin-eligible/earned/placement', n: 1 },
    ])
    const r = await readAll()
    expect(value(r, 'popup.eligibleBelowFloor')).toBe(3)
    expect(value(r, 'popup.eligibleNotNow')).toBe(2)
    expect(value(r, 'popup.eligibleStopped')).toBe(1)
    expect(value(r, 'popup.eligibleEarned')).toBe(1)
    expect(value(r, 'popup.eligibleCapped')).toBe(0)
    expect(value(r, 'popup.eligibleUnearned')).toBe(0)
  })

  it('an empty range answers 0 for every one of them, never an error', async () => {
    const r = await readAll()
    for (const m of [...ELIGIBLE_EARNED_REASON_METRICS, ...ELIGIBLE_OTHER_METRICS]) {
      expect(r.results[m.id.toLowerCase()]?.status, m.id).not.toBe('error')
      expect(value(r, m.id) ?? 0, m.id).toBe(0)
    }
  })
})
