// Mid-flight instrumentation (owner override of the beacon freeze, 2026-09-26):
// /auth/success/<provider>/<new|existing|unknown> (sent ALONGSIDE the base row), the signed-out
// upsell fix as a funnel segment boundary, and kill rule 3's ask definition staying as it was.
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
import { AUTH_SUCCESS_PATHS, AUTH_SUCCESS_PROVIDERS, AUTH_SUCCESS_STATUSES, classifyFunnelPath, computeFunnelCounts, isAuthSuccessBase, isAuthSuccessPath } from './campaigns'

const h = (iso: string) => Date.parse(iso)
const row = (hour: string, path: string, count = 1, visitor = 'returning'): TaggedRow => ({ hourStartMs: h(hour), path, visitor, count })

describe('/auth/success: one sign-in = one BASE row; the status row rides alongside and is never a second sign-in', () => {
  it('classifies the exact shapes: base, and the three statuses; anything else is nothing', () => {
    expect(authSuccessKind('/auth/success/google')).toBe('base')
    expect(authSuccessKind('/auth/success/email')).toBe('base')
    expect(authSuccessKind('/auth/success/google/new')).toBe('new')
    expect(authSuccessKind('/auth/success/email/existing')).toBe('existing')
    expect(authSuccessKind('/auth/success/google/unknown')).toBe('unknown')
    expect(AUTH_SUCCESS_PROVIDERS).toEqual(['google', 'email'])
    expect(AUTH_SUCCESS_STATUSES).toEqual(['new', 'existing', 'unknown'])
    for (const p of ['/auth/success/google/new/', '/auth/success/google/other', '/auth/success/google/new/x', '/auth/success/', '/auth/successful', '/auth/redirect/google']) expect(authSuccessKind(p)).toBeNull()
    // providers are exactly google and email, for the base row and the status row alike
    for (const p of ['/auth/success/apple', '/auth/success/apple/new', '/auth/success/Google']) expect(authSuccessKind(p)).toBeNull()
  })
  it('ONE matcher: v0.6.1 isAuthSuccessPath is the same function, over the same paths as the providers', () => {
    expect(isAuthSuccessPath).toBe(isAuthSuccessBase)
    expect([...AUTH_SUCCESS_PATHS]).toEqual(AUTH_SUCCESS_PROVIDERS.map((p) => `/auth/success/${p}`))
  })
  it('a sign-in that sends both its base row and its /new row counts ONCE as auth success, and once as new', () => {
    const rows = [row('2026-09-30T21:00:00Z', '/auth/success/google', 1), row('2026-09-30T21:00:00Z', '/auth/success/google/new', 1)]
    const s = summarizeTaggedRows(rows)
    expect(s.authSuccess).toBe(1)
    expect(s.authSuccessSplit).toEqual({ new: 1, existing: 0, unknown: 0, unsplit: 0 })
    // the funnel's auth-success step (lib/campaigns.ts, also /api/campaigns and /api/overview)
    expect(classifyFunnelPath('/auth/success/google')).toBe('authSuccess')
    expect(classifyFunnelPath('/auth/success/google/new')).toBeNull()
    expect(isAuthSuccessBase('/auth/success/email/existing')).toBe(false)
    expect(computeFunnelCounts(rows.map((r) => ({ path: r.path, count: r.count })), 10).authSuccess).toBe(1)
    // the sign-up bound: 1 new account sitewide, before and after the split goes live
    expect(campaignSignUps(s, 1, null)).toMatchObject({ count: 1, exact: false })
    expect(campaignSignUps(s, 1, h('2026-09-29T16:00:00Z'))).toMatchObject({ count: 1, exact: true, exactNew: 1 })
  })
  it('a mixed window: base rows with and without status rows are each one sign-in', () => {
    const rows = [
      row('2026-09-29T21:00:00Z', '/auth/success/google', 2), // before the release: no status rows
      row('2026-09-30T21:00:00Z', '/auth/success/google', 3), // after: each with its status row
      row('2026-09-30T21:00:00Z', '/auth/success/google/new', 1),
      row('2026-09-30T21:00:00Z', '/auth/success/email', 1),
      row('2026-09-30T21:00:00Z', '/auth/success/email/existing', 1),
      row('2026-09-30T21:00:00Z', '/auth/success/google/unknown', 1),
      row('2026-09-30T21:00:00Z', '/auth/success/email/existing', 1),
    ]
    const s = summarizeTaggedRows(rows)
    expect(s.authSuccess).toBe(6)
    expect(s.authSuccessSplit).toEqual({ new: 1, existing: 2, unknown: 1, unsplit: 2 })
  })
})

describe('sign-ups: "at most N" until the new/existing split is live, then exact from /new', () => {
  // A window of sign-ins: `noStatus` without a status row, then n new / e existing / u unknown,
  // each of those with its base row too (they ride alongside).
  const s = (noStatus: number, n: number, e: number, u = 0) => {
    const base = noStatus + n + e + u
    return { authSuccess: base, authSuccessSplit: { new: n, existing: e, unknown: u, unsplit: noStatus } }
  }
  const LIVE = h('2026-09-29T16:00:00Z')
  it('the new/existing split is live since v1.95.5 (one definition); the upsell fix instant is not set yet', () => {
    expect(AUTH_NEW_EXISTING_LIVE_AT).toBe(Date.parse('2026-09-26T19:43:02Z'))
    expect(UPSELL_SIGNEDOUT_FIX_AT).toBeNull()
  })
  it('before the split is live, every sign-in (base rows only) feeds the upper bound', () => {
    expect(campaignSignUps(s(2, 3, 4), 5, null)).toMatchObject({ count: 5, exact: false, exactNew: null })
    expect(campaignSignUps(s(2, 3, 4), null, null)).toMatchObject({ count: 9, exact: false })
  })
  it('once live: /new counts exactly, /existing never counts, the rest stays "at most" within the accounts /new has not claimed', () => {
    // count = min(noStatus + unknown, max(0, windowNew − exactNew)) + exactNew, exactNew capped at windowNew
    const mixed = campaignSignUps(s(2, 3, 4), 10, LIVE)
    expect(mixed).toMatchObject({ count: 2 + 3, exact: false, bounded: 2, exactNew: 3, newCapped: false })
    expect(mixed.label).toMatch(
      /^at most 5 campaign sign-ups: at most 2 of the 2 sign-ins that may be new \(2 without a new\/existing answer — before 2026-09-29 12:00 ET or an old client — and 0 unknown; new prod accounts sitewide in the window 10, less the 3 counted as new\) \+ exactly 3 new/,
    )
    expect(campaignSignUps(s(5, 3, 0), 4, LIVE)).toMatchObject({ count: 1 + 3, bounded: 1, exactNew: 3 }) // only 4 − 3 = 1 account left
    const exact = campaignSignUps(s(0, 2, 7), 9, LIVE)
    expect(exact).toMatchObject({ count: 2, exact: true, bounded: 0, exactNew: 2 })
    expect(exact.label).toBe('2 campaign sign-ups (exact: tagged /auth/success/<provider>/new since 2026-09-29 12:00 ET)')
  })
  it('unknown (isNewUser unavailable) is possibly new: it joins the "at most" part, never the exact part', () => {
    const u = campaignSignUps(s(0, 1, 0, 2), 10, LIVE)
    expect(u).toMatchObject({ count: 2 + 1, exact: false, bounded: 2, exactNew: 1 })
    expect(campaignSignUps(s(0, 1, 0, 2), 2, LIVE)).toMatchObject({ count: 1 + 1, bounded: 1, exactNew: 1 })
  })
  it("the reviewer's probe: 1 sign-in without a status, 1 /new, 1 new account sitewide → 1, not 2", () => {
    expect(campaignSignUps(s(1, 1, 0), 1, LIVE)).toMatchObject({ count: 1, exact: false, bounded: 0, exactNew: 1 })
  })
  it("/new rows beyond the window's new accounts (a repeated beacon) are capped, and the count is then an upper bound", () => {
    const capped = campaignSignUps(s(0, 3, 0), 2, LIVE)
    expect(capped).toMatchObject({ count: 2, exact: false, exactNew: 2, newCapped: true })
    expect(capped.label).toBe('at most 2 campaign sign-ups (tagged /auth/success/<provider>/new rows 3, capped at the 2 new prod accounts sitewide in the window)')
    // without the window count nothing can cap it: the /new rows stand, still exact
    expect(campaignSignUps(s(0, 3, 0), null, LIVE)).toMatchObject({ count: 3, exact: true })
  })
  it('an exact count reads the spec rows plainly; a bound still says "at most"', () => {
    expect(decideAt100({ signUpsAtMost: 2, asks: 9, accepts: 3, exact: true }).reading).not.toMatch(/at most/i)
    expect(decideAt100({ signUpsAtMost: 2, asks: 9, accepts: 3 }).reading).toMatch(/^At most 2/)
    expect(decideAt100({ signUpsAtMost: 1, asks: 9, accepts: 3, exact: true }).row).toBe('one')
  })
})

describe('kill rule 3: the ask definition is unchanged by the new instrumentation', () => {
  it('asks are exactly the sign-in placement/streak/tutorial prompts and the first-50 offer shown', () => {
    expect([...ASK_PATHS]).toEqual(['/signin-prompt/placement', '/signin-prompt/streak', '/signin-prompt/tutorial', '/promo-first50/shown'])
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
  it('the split is exact at the instant when the query flags rows (SQL ts >= fix), not by hour bucket', () => {
    // Same hour as the fix: 3 upsells before 14:26 ET, 4 after, as the beacon query's `uf` splits them.
    const flagged = [
      { ...row('2026-09-29T18:00:00Z', '/upsell/shown/game-limit', 3), postUpsellFix: false },
      { ...row('2026-09-29T18:00:00Z', '/upsell/shown/game-limit', 4), postUpsellFix: true },
      { ...row('2026-09-29T18:00:00Z', '/upsell/accept/game-limit', 1), postUpsellFix: true },
    ]
    const seg = splitAtBoundary({ ...base, rows: flagged, boundaryMs: FIX })!
    expect(seg.pre.upsell).toMatchObject({ shown: 3, accept: 0 })
    expect(seg.post.upsell).toMatchObject({ shown: 4, accept: 1 })
    const m = campaignSegmentMarker({ flightStart: '2026-09-26', flightEnd: '2026-10-02' }, flagged, FIX)!
    expect(m.upsell).toMatchObject({ pre: { shown: 3 }, post: { shown: 4, accept: 1 } })
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
