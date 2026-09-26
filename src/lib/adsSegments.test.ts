// Mid-flight instrumentation (owner override of the beacon freeze, 2026-09-26):
// /auth/success/<provider>/new|existing, the signed-out upsell fix as a funnel segment boundary,
// and kill rule 3's ask definition staying exactly as it was.
import { describe, expect, it } from 'vitest'
import {
  ASK_PATHS,
  AUTH_NEW_EXISTING_LIVE_AT,
  authSuccessKind,
  campaignSegmentMarker,
  campaignSignUps,
  decideAt100,
  evaluateKillRules,
  readPlanFor,
  splitAtBoundary,
  summarizeTaggedRows,
  UPSELL_SIGNEDOUT_FIX_AT,
  type StoredSpend,
  type TaggedRow,
} from './adsRules'
import { classifyFunnelPath, computeFunnelCounts } from './campaigns'

const h = (iso: string) => Date.parse(iso)
const row = (hour: string, path: string, count = 1, visitor = 'returning'): TaggedRow => ({ hourStartMs: h(hour), path, visitor, count })

describe('/auth/success: matched on the prefix, so /new and /existing are neither dropped nor double-counted', () => {
  it('classifies the suffixes', () => {
    expect(authSuccessKind('/auth/success/google')).toBe('unsplit')
    expect(authSuccessKind('/auth/success/google/new')).toBe('new')
    expect(authSuccessKind('/auth/success/apple/existing')).toBe('existing')
    expect(authSuccessKind('/auth/success/google/new/')).toBe('new')
    expect(authSuccessKind('/auth/successful')).toBeNull()
    expect(authSuccessKind('/auth/redirect/google')).toBeNull()
  })
  it('tagged sign-in outcomes count every suffixed row exactly once', () => {
    const rows = [
      row('2026-09-29T21:00:00Z', '/auth/success/google', 2),
      row('2026-09-30T21:00:00Z', '/auth/success/google/new', 3),
      row('2026-09-30T21:00:00Z', '/auth/success/apple/existing', 4),
    ]
    const s = summarizeTaggedRows(rows)
    expect(s.authSuccess).toBe(9)
    expect(s.authSuccessSplit).toEqual({ unsplit: 2, new: 3, existing: 4 })
    // the funnel's auth-success step (lib/campaigns.ts classifyFunnelPath, also used by
    // /api/campaigns) uses the same prefix
    expect(classifyFunnelPath('/auth/success/google/new')).toBe('authSuccess')
    expect(classifyFunnelPath('/auth/success/apple/existing')).toBe('authSuccess')
    expect(computeFunnelCounts(rows.map((r) => ({ path: r.path, count: r.count })), 10).authSuccess).toBe(9)
  })
})

describe('sign-ups: "at most N" until the new/existing split is live, then exact from /new', () => {
  const s = (unsplit: number, n: number, existing: number) => ({ authSuccess: unsplit + n + existing, authSuccessSplit: { unsplit, new: n, existing } })
  const LIVE = h('2026-09-29T16:00:00Z')
  it('the instant is not set yet: every behaviour is unchanged', () => {
    expect(AUTH_NEW_EXISTING_LIVE_AT).toBeNull()
    expect(UPSELL_SIGNEDOUT_FIX_AT).toBeNull()
  })
  it('before the split is live, every auth-success row (suffixed or not) feeds the upper bound', () => {
    expect(campaignSignUps(s(2, 3, 4), 5, null)).toMatchObject({ count: 5, exact: false, exactNew: null })
    expect(campaignSignUps(s(2, 3, 4), null, null)).toMatchObject({ count: 9, exact: false })
  })
  it('once live: /new counts exactly, /existing never counts, unsplit rows stay "at most"', () => {
    const mixed = campaignSignUps(s(2, 3, 4), 1, LIVE)
    expect(mixed).toMatchObject({ count: 1 + 3, exact: false, bounded: 1, exactNew: 3 })
    expect(mixed.label).toMatch(/^at most 4 campaign sign-ups: at most 1 before the new\/existing split \(2026-09-29 12:00 ET; tagged auth successes 2; new prod accounts sitewide in the window 1\) \+ exactly 3 after it/)
    const exact = campaignSignUps(s(0, 2, 7), 9, LIVE)
    expect(exact).toMatchObject({ count: 2, exact: true, bounded: 0, exactNew: 2 })
    expect(exact.label).toBe('2 campaign sign-ups (exact: tagged /auth/success/<provider>/new since 2026-09-29 12:00 ET)')
  })
  it('an exact count reads the spec rows plainly; a bound still says "at most"', () => {
    expect(decideAt100({ signUpsAtMost: 2, asks: 9, accepts: 3, exact: true }).reading).not.toMatch(/at most/i)
    expect(decideAt100({ signUpsAtMost: 2, asks: 9, accepts: 3 }).reading).toMatch(/^At most 2/)
    expect(decideAt100({ signUpsAtMost: 1, asks: 9, accepts: 3, exact: true }).row).toBe('one')
  })
})

describe('kill rule 3: the ask definition is unchanged by the new instrumentation', () => {
  it('asks are exactly the sign-in placement/streak prompts and the first-50 offer shown', () => {
    expect([...ASK_PATHS]).toEqual(['/signin-prompt/placement', '/signin-prompt/streak', '/promo-first50/shown'])
    const s = summarizeTaggedRows([
      row('2026-09-29T21:00:00Z', '/upsell/shown/game-limit', 5),
      row('2026-09-29T21:00:00Z', '/auth/success/google/new', 2),
      row('2026-09-29T21:00:00Z', '/game/complete', 3),
      row('2026-09-29T21:00:00Z', '/signin-prompt/placement', 1),
    ])
    expect(s.asks.total).toBe(1)
    const { plan } = readPlanFor('24279250691')
    const k = evaluateKillRules({ plan, cumulativeSpend: 60, campaignState: { status: 'ENABLED', servingStatus: 'SERVING' }, delivery: { impressions: 10000, clicks: 50 }, placements: null, beacon: { asks: s.asks.total, taggedArrivals: 40 } })
    expect(k.rules.find((r) => r.id === 'funnel-reach')!.status).toBe('clear')
  })
})

describe('the signed-out upsell fix as a funnel segment boundary (spec section 14a)', () => {
  const FIX = h('2026-09-29T18:26:00Z') // 14:26 ET
  const rows = [
    row('2026-09-28T21:00:00Z', '/signin-prompt/placement', 3),
    row('2026-09-28T21:00:00Z', '/upsell/shown/game-limit', 2),
    row('2026-09-28T21:00:00Z', '/auth/success/google', 1),
    row('2026-09-29T18:00:00Z', '/upsell/shown/game-limit', 4), // the hour containing the fix: post-fix
    row('2026-09-29T18:00:00Z', '/upsell/accept/game-limit', 1),
    row('2026-09-30T21:00:00Z', '/promo-first50/shown', 2),
    row('2026-09-30T21:00:00Z', '/signin-prompt/accept', 1),
    row('2026-09-30T21:00:00Z', '/auth/success/google', 1),
  ]
  const stored: StoredSpend = {
    v: 1,
    campaignId: '24279250691',
    source: 'google-ads-api',
    apiVersion: '',
    customerId: '',
    fetchedAt: 'x',
    closedThroughEt: '2026-09-30',
    days: { '2026-09-27': { costMicros: 13_000_000, impressions: 1, clicks: 0 }, '2026-09-28': { costMicros: 12_000_000, impressions: 1, clicks: 0 }, '2026-09-29': { costMicros: 11_000_000, impressions: 1, clicks: 0 }, '2026-09-30': { costMicros: 10_000_000, impressions: 1, clicks: 0 } },
  }
  const base = { rows, stored, throughEt: '2026-09-30', startMs: h('2026-09-26T16:00:00Z'), endMs: h('2026-10-01T04:00:00Z'), windowNewAccounts: 5, authLiveAtMs: null }
  it('reports pre-fix and post-fix spend, asks, accepts and sign-ups separately; the fix day apart', () => {
    const seg = splitAtBoundary({ ...base, boundaryMs: FIX })!
    expect(seg.boundaryLabel).toBe('2026-09-29 14:26 ET')
    expect(seg.boundaryDay).toBe('2026-09-29')
    expect(seg.pre).toMatchObject({ spend: 25, spendDays: 2, asks: 3, accepts: 0, authSuccess: 1, upsell: { shown: 2, accept: 0, dismiss: 0 } })
    expect(seg.post).toMatchObject({ spend: 10, spendDays: 1, asks: 2, accepts: 1, authSuccess: 1, upsell: { shown: 4, accept: 1, dismiss: 0 } })
    expect(seg.pre.signUps.count).toBe(1)
    expect(seg.post.signUps.count).toBe(1)
    expect(seg.boundaryDaySpend).toBe(11)
    expect(seg.note).toMatch(/two separate short tests/)
  })
  it('no boundary when unset or outside the read window', () => {
    expect(splitAtBoundary({ ...base })).toBeNull() // UPSELL_SIGNEDOUT_FIX_AT is null
    expect(splitAtBoundary({ ...base, boundaryMs: h('2026-10-05T12:00:00Z') })).toBeNull()
  })
  it('the campaign charts get the marker and the tagged upsell breakdown by segment', () => {
    const m = campaignSegmentMarker({ flightStart: '2026-09-26', flightEnd: '2026-10-02' }, rows, FIX)!
    expect(m).toMatchObject({ boundaryDate: '2026-09-29', upsell: { pre: { shown: 2, accept: 0 }, post: { shown: 4, accept: 1 } } })
    expect(campaignSegmentMarker({ flightStart: '2026-09-02', flightEnd: '2026-09-09' }, rows, FIX)).toBeNull()
    expect(campaignSegmentMarker({ flightStart: '2026-09-26', flightEnd: '2026-10-02' }, rows)).toBeNull() // unset
  })
})
