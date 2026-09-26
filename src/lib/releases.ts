// Release markers for the "Best Sudoku overview" page's timeline + release panel (Part C).
//
// `hits` has NO app-version column (confirmed via `PRAGMA table_info(hits)` — see
// lib/campaigns.ts's header for the same check) — so a release's date can't be DERIVED
// from D1 and has to be entered here by hand. v1.95.3 shipped pop-up tracking, campaign
// tracking, and the on-device return beacon together to production WEB 2026-09-26
// (confirmed live 14:31 UTC) — the SAME date as lib/popupEvents.ts's
// TRACKING_ACTIVATION_DATE_ET, so this reads that constant rather than duplicating it.
// The Android/Play build is separate and not live yet — see
// PLAY_TRACKING_ACTIVATION_DATE_ET in popupEvents.ts; it gets its own release entry once
// dated.
import { TRACKING_ACTIVATION_DATE_ET } from './popupEvents'

export interface ReleaseMarker {
  version: string
  dateEt: string | null // ET calendar date (YYYY-MM-DD), or null if not yet known
  note: string
}

export const RELEASES: ReleaseMarker[] = [
  {
    version: 'v1.95.3',
    dateEt: TRACKING_ACTIVATION_DATE_ET,
    note: 'Pop-up + campaign-return tracking live on web',
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
