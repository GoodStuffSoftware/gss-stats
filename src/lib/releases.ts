// Release markers for the "Best Sudoku overview" page's timeline + release panel (Part C).
//
// `hits` has NO app-version column (confirmed via `PRAGMA table_info(hits)` — see
// lib/campaigns.ts's header for the same check) — so a release's date can't be DERIVED
// from D1 and has to be entered here by hand. Seeded with what's known from the task brief:
// v1.90.0 ships pop-up tracking, campaign tracking, and the on-device return beacon
// together — the SAME date as lib/popupEvents.ts's TRACKING_ACTIVATION_DATE_ET, so this
// reads that constant rather than duplicating it. It's null (unset) until that release
// actually ships; until then this release has no dated marker (see datedReleases below —
// the overview timeline and release panel simply skip an undated entry rather than
// guessing, or lying with a 0).
import { TRACKING_ACTIVATION_DATE_ET } from './popupEvents'

export interface ReleaseMarker {
  version: string
  dateEt: string | null // ET calendar date (YYYY-MM-DD), or null if not yet known
  note: string
}

export const RELEASES: ReleaseMarker[] = [
  {
    version: 'v1.90.0',
    dateEt: TRACKING_ACTIVATION_DATE_ET,
    note: 'Pop-up tracking, campaign tracking, and the on-device return beacon ship together. Fixes the uncapped-placement bug behind the 2026-09-19 sign-in-prompt spike.',
  },
]

export type DatedRelease = ReleaseMarker & { dateEt: string }

export function datedReleases(): DatedRelease[] {
  return RELEASES.filter((r): r is DatedRelease => r.dateEt !== null)
}

/** The most recent release with a known date, or null if none is dated yet. */
export function latestDatedRelease(): DatedRelease | null {
  const dated = datedReleases()
  if (!dated.length) return null
  return dated.reduce((a, b) => (a.dateEt >= b.dateEt ? a : b))
}
