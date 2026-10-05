// Shared "hide my own visits" / "hide self-referrals" clause-builders for the beacon's D1
// (`hits`). Extracted from functions/api/geo.ts (which used to define these as request-scoped
// closures) so every beacon-backed reader — functions/api/popups.ts and the metrics facts
// (lib/metrics/facts.ts) as well as geo.ts — uses the EXACT same semantics instead of
// re-implementing the same De Morgan logic. Pure refactor: geo.ts's behavior is unchanged.

import { sqlLit } from './popupEvents'

// Hosts that count as "us" for excludeSelfReferrals — same list functions/api/stats.ts (RUM)
// uses for its OWN_HOSTS, so every dataset agrees on what a self-referral is.
export const OWN_HOSTS = [
  'goodstuff.software',
  'www.goodstuff.software',
  'starrupture.goodstuff.software',
  'simpletile.goodstuff.software',
  'stats.goodstuff.software',
  'goodstuffsoftware.com',
  'www.goodstuffsoftware.com',
  'bestsudoku.app',
  'www.bestsudoku.app',
  'design-preview.goodstuffsoftware.pages.dev',
]

// Sanitize a user-agent value used in a server-side exclusion filter.
export function safeUA(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z0-9 ._-]{1,40}$/.test(v) ? v : ''
}

// "Hide my own visits" — excludes the owner's browser+OS COMBINATION, not all of either.
// De Morgan: NOT(browser=own AND os=own) === (browser<>own OR os<>own). Case-insensitive
// (beacon-collected UA strings don't necessarily share RUM's casing). Only applies when BOTH
// values are present — an empty ownBrowser/ownOS must not exclude everything.
export function excludeOwnClause(w: string[], b: unknown[], excludeOwn: boolean, ownBrowserRaw: unknown, ownOSRaw: unknown): void {
  const ownBrowser = safeUA(ownBrowserRaw)
  const ownOS = safeUA(ownOSRaw)
  if (excludeOwn && ownBrowser && ownOS) {
    w.push(`NOT (LOWER(browser) = LOWER(?) AND LOWER(os) = LOWER(?))`)
    b.push(ownBrowser, ownOS)
  }
}

// "Hide self-referrals" — on by default, but only actually filters a query that groups by
// 'referrer' (so a region/city/etc. chart is never silently zeroed by a referrer-only
// exclusion). Also drops blank/direct rows when active.
//
// The host list is inlined as checked SQL literals (sqlLit refuses anything outside a plain
// hostname alphabet, never a quote), so this clause binds NOTHING: ten bound parameters here were
// a tenth of D1's 100-per-query cap on the referrer chart (functions/api/bindHeadroom.test.ts).
// `_b` stays so every caller's (activeDims, w, b) shape is unchanged.
export function selfReferralClause(activeDims: string[], w: string[], _b: unknown[], excludeSelf: boolean): void {
  if (!excludeSelf || !activeDims.includes('referrer')) return
  w.push(`referrer <> ''`)
  w.push(`referrer NOT IN (${OWN_HOSTS.map(sqlLit).join(', ')})`)
}
