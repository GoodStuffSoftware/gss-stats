import { describe, expect, it } from 'vitest'
import {
  FEATURES,
  HEALTH_BASELINE_DAYS,
  HEALTH_CAPTION,
  HEALTH_SILENT_MIN_AVG,
  HEALTH_SILENT_MIN_ACTIVE_DAYS,
  assembleHealth,
  flatSteps,
  formatRatio,
  healthDays,
  ratio,
  statusOf,
  stepMatches,
  type DayCounts,
  type FeatureDef,
} from './featureHealth'
import { etWallTimeMs } from './etTime'

// Made-up data only. "Now" is noon ET on 2026-10-15: the latest complete ET day is 10-14, the day
// before 10-13, the baseline 10-07..10-13, and rows before 10-08 00:00 ET make a feature not new.
const NOW = Date.parse('2026-10-15T16:00:00Z')

const TOY: FeatureDef[] = [
  {
    id: 'toy',
    label: 'Toy',
    blurb: 'A toy feature.',
    steps: [
      { id: 'shown', label: 'Shown', match: { exact: ['/toy/shown'] } },
      { id: 'tap', label: 'Tapped', match: { exact: ['/toy/tap'], prefix: ['/toy/tap/'] }, ratioOf: { per: 'shown' } },
    ],
  },
]

/** One DayCounts row for the toy config: [shown, tap]. */
const day = (d: string, shown: number, tap: number): DayCounts => ({ d, s: [shown, tap] })

describe('the config list', () => {
  it('has unique feature ids, unique step ids per feature, a match on every step and ratios that point at a sibling step', () => {
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length)
    for (const f of FEATURES) {
      const ids = f.steps.map((s) => s.id)
      expect(new Set(ids).size, f.id).toBe(ids.length)
      for (const s of f.steps) {
        expect((s.match.exact?.length ?? 0) + (s.match.prefix?.length ?? 0), `${f.id}.${s.id}`).toBeGreaterThan(0)
        if (s.ratioOf) {
          expect(ids, `${f.id}.${s.id} ratio`).toContain(s.ratioOf.per)
          expect(s.ratioOf.per).not.toBe(s.id)
        }
      }
    }
  })

  it('names the feature families the brief asks for', () => {
    const ids = FEATURES.map((f) => f.id)
    for (const id of ['coach', 'tour', 'signin', 'first50-promo', 'upsell', 'install', 'games']) expect(ids).toContain(id)
    const paths = (id: string) => FEATURES.find((f) => f.id === id)!.steps.flatMap((s) => [...(s.match.exact ?? []), ...(s.match.prefix ?? [])])
    expect(paths('coach')).toEqual(expect.arrayContaining(['/coach/shown/', '/coach/tour-opened', '/coach/dismissed/', '/coach/closed-at/']))
    expect(paths('tour')).toEqual(expect.arrayContaining(['/tour/start', '/tour/complete', '/tour/skip']))
    expect(paths('tour')).not.toContain('/tour/exit-at/') // the same skips again (production D1, 2026-10-15)
    expect(paths('signin')).toEqual(expect.arrayContaining(['/signin-prompt/accept', '/signin-prompt/dismiss', '/auth/success/google/']))
  })

  it('never lists a path that production never receives (/game/tutorial-complete/ was dropped)', () => {
    const all = FEATURES.flatMap((f) => f.steps.flatMap((s) => [...(s.match.exact ?? []), ...(s.match.prefix ?? [])]))
    expect(all.some((p) => p.startsWith('/game/tutorial-complete'))).toBe(false)
  })

  it('uses no wildcard characters in a match (the SQL compares text, it does not LIKE)', () => {
    for (const f of FEATURES) for (const s of f.steps) for (const p of [...(s.match.exact ?? []), ...(s.match.prefix ?? []), ...(s.match.except ?? [])]) expect(p, `${f.id}.${s.id}`).toMatch(/^\/[A-Za-z0-9\-/]*$/)
  })

  it('keeps the steps of one feature disjoint: a path counts toward at most one of them', () => {
    const sample = [
      '/coach/shown/place', '/coach/tour-opened', '/coach/dismissed/hint', '/coach/closed-at/clash',
      '/tour/start', '/tour/complete', '/tour/skip', '/tour/exit-at', '/tour/exit-at/hub',
      '/signin-prompt/tutorial', '/signin-prompt/accept', '/signin-prompt/dismiss', '/auth/success/google/new', '/auth/success/email', '/auth/success/email/existing',
      '/game/start/easy', '/game/complete/normal/hard', '/game/complete/daily/easy', '/game/complete-deferred/normal/easy',
      '/install/prompt/ios', '/install/play', '/install/prompt/have-it', '/install/pwa-installed', '/upsell/shown/cadence', '/welcome-signed-in/leaderboard',
    ]
    for (const f of FEATURES) for (const p of sample) expect(f.steps.filter((s) => stepMatches(s.match, p)).length, `${f.id} ${p}`).toBeLessThanOrEqual(1)
  })

  it('keeps the sign-in "shown" step off the accept and dismiss rows and the auth page views', () => {
    const shown = FEATURES.find((f) => f.id === 'signin')!.steps.find((s) => s.id === 'shown')!.match
    expect(stepMatches(shown, '/signin-prompt/tutorial')).toBe(true)
    expect(stepMatches(shown, '/signin-prompt/accept')).toBe(false)
    expect(stepMatches(shown, '/signin-prompt/dismiss')).toBe(false)
    const signedIn = FEATURES.find((f) => f.id === 'signin')!.steps.find((s) => s.id === 'signed-in')!.match
    expect(stepMatches(signedIn, '/auth/success/google/new')).toBe(true)
    expect(stepMatches(signedIn, '/auth/success/google')).toBe(false) // the base row is a page view
  })

  it('does not count a deferred completion as a completion, nor a path containing a NUL byte', () => {
    const complete = FEATURES.find((f) => f.id === 'games')!.steps.find((s) => s.id === 'complete')!.match
    expect(stepMatches(complete, '/game/complete/normal/easy')).toBe(true)
    expect(stepMatches(complete, '/game/complete-deferred/normal/easy')).toBe(false)
    expect(stepMatches(complete, '/game/complete/normal/easy\u0000x')).toBe(false)
  })

  it('has one feature per difficulty next to the overall games feature', () => {
    expect(FEATURES.map((f) => f.id)).toEqual(expect.arrayContaining(['games', 'games-easy', 'games-medium', 'games-hard', 'games-expert']))
  })
})

describe('ratio', () => {
  it('is a plain division, and null for a zero denominator', () => {
    expect(ratio(3, 4)).toBe(0.75)
    expect(ratio(5, 2)).toBe(2.5) // can exceed 1: not a rate
    expect(ratio(0, 7)).toBe(0)
    expect(ratio(3, 0)).toBeNull()
    expect(ratio(0, 0)).toBeNull()
  })
  it('renders null as an em dash and a value with two decimals', () => {
    expect(formatRatio(null)).toBe('—')
    expect(formatRatio(0.5)).toBe('0.50')
    expect(formatRatio(0)).toBe('0.00')
  })
  it('says in its caption that the figures are not per-person conversion rates', () => {
    expect(HEALTH_CAPTION).toMatch(/not per-person conversion rates/)
    expect(HEALTH_CAPTION).toMatch(/never joined into a path/)
    expect(HEALTH_CAPTION).toMatch(/once per device/)
  })
})

describe('statusOf', () => {
  const steady = [5, 5, 5, 5, 5, 5, 5] // exactly the threshold
  it('has the threshold as a named constant at 5 rows a day over 7 days', () => {
    expect(HEALTH_SILENT_MIN_AVG).toBe(5)
    expect(HEALTH_BASELINE_DAYS).toBe(7)
    expect(HEALTH_SILENT_MIN_ACTIVE_DAYS).toBe(6)
  })
  it('a bursty feature on a quiet day is OK: 7.9 a day in bursts with 3 empty days (Games, hard, 10-14)', () => {
    expect(statusOf({ latest: 0, baseline: [20, 15, 20, 0, 0, 0, 0], before: 100 })).toBe('ok')
    expect(statusOf({ latest: 0, baseline: [30, 25, 0, 0, 0, 0, 0], before: 100 })).toBe('ok')
  })
  it('a steady feature that drops to zero still flags, even at 6 of 7 active days', () => {
    expect(statusOf({ latest: 0, baseline: [9, 8, 7, 9, 10, 8, 9], before: 100 })).toBe('silent')
    expect(statusOf({ latest: 0, baseline: [0, 12, 9, 10, 8, 9, 7], before: 100 })).toBe('silent') // two days into an outage
    expect(statusOf({ latest: 0, baseline: [0, 0, 9, 10, 8, 9, 7], before: 100 })).toBe('ok') // 5 of 7 active: bursty reading
  })
  it('went silent: the baseline averaged the threshold or more and the latest day is zero', () => {
    expect(statusOf({ latest: 0, baseline: steady, before: 100 })).toBe('silent')
    expect(statusOf({ latest: 0, baseline: [30, 1, 1, 1, 1, 1, 0], before: 100 })).toBe('silent') // 35 / 7 = 5, 6 active
  })
  it('a quiet feature that is zero today stays OK (average below the threshold)', () => {
    expect(statusOf({ latest: 0, baseline: [4, 5, 5, 5, 5, 5, 5], before: 100 })).toBe('ok') // 34 / 7 < 5
    expect(statusOf({ latest: 0, baseline: [1, 0, 2, 0, 0, 1, 0], before: 100 })).toBe('ok')
    expect(statusOf({ latest: 0, baseline: [0, 0, 0, 0, 0, 0, 0], before: 100 })).toBe('ok')
  })
  it('a busy feature that fired on the latest day is OK', () => {
    expect(statusOf({ latest: 1, baseline: [50, 50, 50, 50, 50, 50, 50], before: 100 })).toBe('ok')
  })
  it('new: no rows before the cutoff', () => {
    expect(statusOf({ latest: 3, baseline: [0, 0, 0, 0, 0, 2, 2], before: 0 })).toBe('new')
    expect(statusOf({ latest: 0, baseline: [0, 0, 0, 0, 0, 0, 0], before: 0 })).toBe('new') // no rows at all
  })
  it('silent beats new', () => {
    expect(statusOf({ latest: 0, baseline: [1, 9, 9, 9, 9, 9, 9], before: 0 })).toBe('silent')
  })
})

describe('healthDays', () => {
  it('puts the latest complete ET day at yesterday and the new-days cutoff at an ET midnight', () => {
    const hd = healthDays(NOW)
    expect([hd.today, hd.latest, hd.prev, hd.baselineStart]).toEqual(['2026-10-15', '2026-10-14', '2026-10-13', '2026-10-07'])
    expect(hd.newCutoffMs).toBe(etWallTimeMs('2026-10-08'))
    expect(hd.baselineStartMs).toBe(etWallTimeMs('2026-10-07'))
    expect(hd.tomorrowMs).toBe(etWallTimeMs('2026-10-16'))
  })
  it('reads the ET date, not the UTC date: 01:00Z on the 16th is still the evening of the 15th in ET', () => {
    expect(healthDays(Date.parse('2026-10-16T01:00:00Z')).today).toBe('2026-10-15')
  })
})

describe('assembleHealth', () => {
  const base = { features: TOY, nowMs: NOW, rangeFrom: '2026-10-10', rangeTo: '2026-10-15' } as const

  it('counts the latest complete day, the day before and the selected range per step', () => {
    const rows = [
      day('2026-10-09', 99, 99), // outside the range: not in the range sum
      day('2026-10-11', 10, 2),
      day('2026-10-13', 20, 4),
      day('2026-10-14', 30, 9),
      day('2026-10-15', 7, 7), // today, after the range
    ]
    const m = assembleHealth({ ...base, rows, before: [50] })
    expect(m.latestDay).toBe('2026-10-14')
    expect(m.prevDay).toBe('2026-10-13')
    expect(m.days).toEqual(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'])
    const [shown, tap] = m.features[0].steps
    expect([shown.latest, shown.prev, shown.range]).toEqual([30, 20, 60])
    expect([tap.latest, tap.prev, tap.range]).toEqual([9, 4, 15])
    expect(shown.perDay).toEqual([0, 10, 0, 20, 30])
    expect(m.features[0]).toMatchObject({ latest: 39, prev: 24, range: 75 })
  })

  it('reports the latest and previous day even when the range ends before them', () => {
    const m = assembleHealth({ ...base, rangeFrom: '2026-10-01', rangeTo: '2026-10-05', rows: [day('2026-10-14', 8, 1), day('2026-10-13', 4, 2), day('2026-10-02', 3, 0)], before: [9] })
    expect(m.features[0].steps[0]).toMatchObject({ latest: 8, prev: 4, range: 3 })
  })

  it('computes plain ratios of counts, labelled as such, with an em-dash path for a zero denominator', () => {
    const m = assembleHealth({ ...base, rows: [day('2026-10-14', 4, 3), day('2026-10-13', 0, 5), day('2026-10-12', 6, 1)], before: [1] })
    const tap = m.features[0].steps[1]
    expect(tap.ratio).toEqual({ label: 'tapped per shown', latest: 0.75, prev: null, range: 0.9 })
    expect(formatRatio(tap.ratio!.prev)).toBe('—')
    expect(m.features[0].steps[0].ratio).toBeUndefined()
  })

  it('a ratio can exceed 1 and an empty range gives null, never NaN or Infinity', () => {
    const m = assembleHealth({ ...base, rows: [day('2026-10-14', 2, 6)], before: [1] })
    expect(m.features[0].steps[1].ratio!.latest).toBe(3)
    const empty = assembleHealth({ ...base, rows: [], before: [0] })
    const r = empty.features[0].steps[1].ratio!
    expect([r.latest, r.prev, r.range]).toEqual([null, null, null])
  })

  it('went silent: averaged 6 a day over the prior 7 days and 0 on the latest day', () => {
    const rows = ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'].map((d) => day(d, 4, 2))
    const m = assembleHealth({ ...base, rows, before: [500] })
    expect(m.features[0].status).toBe('silent')
    expect(m.features[0].statusNote).toMatch(/averaged 6\.0 rows a day/)
  })

  it('the baseline does not include the latest day, nor the day before the baseline starts', () => {
    // 35 rows on 10-06 (before the baseline) and 10-14 (the latest day) do not make a 5-a-day average.
    const rows = [day('2026-10-06', 35, 0), day('2026-10-14', 0, 0)]
    expect(assembleHealth({ ...base, rows, before: [35] }).features[0].status).toBe('ok')
    // 35 rows inside the baseline do.
    const steadyRows = [day('2026-10-07', 30, 0), ...['08', '09', '10', '11', '12'].map((d) => day(`2026-10-${d}`, 1, 0))]
    expect(assembleHealth({ ...base, rows: steadyRows, before: [35] }).features[0].status).toBe('silent')
    // The same 35 rows in one burst (1 active day of 7) are a bursty feature on a quiet day.
    expect(assembleHealth({ ...base, rows: [day('2026-10-07', 35, 0)], before: [35] }).features[0].status).toBe('ok')
  })

  it('a quiet day is not an alarm: 3 a day on average and none yesterday is OK', () => {
    const rows = ['2026-10-07', '2026-10-09', '2026-10-11', '2026-10-13'].map((d) => day(d, 2, 1)).concat([day('2026-10-08', 2, 1), day('2026-10-10', 2, 1), day('2026-10-12', 2, 1)])
    expect(assembleHealth({ ...base, rows, before: [500] }).features[0].status).toBe('ok')
  })

  it('new: nothing before the cutoff, whether or not there are recent rows', () => {
    const fresh = assembleHealth({ ...base, rows: [day('2026-10-13', 2, 0), day('2026-10-14', 3, 1)], before: [0] })
    expect(fresh.features[0].status).toBe('new')
    expect(fresh.features[0].statusNote).toMatch(/no rows before the last 7 days/)
    const never = assembleHealth({ ...base, rows: [], before: [0] })
    expect(never.features[0].status).toBe('new')
    expect(never.features[0].statusNote).toBe('no rows yet')
  })

  it('is OK when it has history and fired on the latest day', () => {
    const m = assembleHealth({ ...base, rows: [day('2026-10-14', 1, 0)], before: [12] })
    expect(m.features[0].status).toBe('ok')
  })

  it('the config list drives the rows: adding a feature adds a row, a step adds a column, nothing else changes', () => {
    const more: FeatureDef[] = [
      ...TOY,
      { id: 'extra', label: 'Extra', blurb: 'One more.', steps: [{ id: 'a', label: 'A', match: { exact: ['/x/a'] } }, { id: 'b', label: 'B', match: { exact: ['/x/b'] }, ratioOf: { per: 'a' } }, { id: 'c', label: 'C', match: { exact: ['/x/c'] }, ratioOf: { per: 'b' } }] },
    ]
    expect(flatSteps(more).map((f) => `${f.feature.id}.${f.step.id}`)).toEqual(['toy.shown', 'toy.tap', 'extra.a', 'extra.b', 'extra.c'])
    const rows: DayCounts[] = [{ d: '2026-10-14', s: [5, 1, 8, 4, 2] }]
    const m = assembleHealth({ features: more, rows, before: [3, 3], nowMs: NOW, rangeFrom: '2026-10-14', rangeTo: '2026-10-15' })
    expect(m.features.map((f) => f.id)).toEqual(['toy', 'extra'])
    expect(m.features[1].steps.map((s) => s.latest)).toEqual([8, 4, 2])
    expect(m.features[1].steps[2].ratio).toMatchObject({ label: 'c per b', latest: 0.5 })
    expect(m.features[0].steps.map((s) => s.latest)).toEqual([5, 1])
  })

  it('the shipped config yields one row per feature, with a column per step', () => {
    const n = flatSteps().length
    const m = assembleHealth({ rows: [{ d: '2026-10-14', s: new Array(n).fill(1) }], before: FEATURES.map(() => 1), nowMs: NOW, rangeFrom: '2026-10-14', rangeTo: '2026-10-15' })
    expect(m.features.map((f) => f.id)).toEqual(FEATURES.map((f) => f.id))
    expect(m.features.map((f) => f.steps.length)).toEqual(FEATURES.map((f) => f.steps.length))
    expect(m.features.every((f) => f.latest === f.steps.length)).toBe(true)
  })
})
