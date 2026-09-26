// Release markers for the "Best Sudoku overview" page's timeline + release panel (Part C)
// and the "Best Sudoku · Traffic" launch page's own trend chart (widget.markers ===
// 'releases' — see lib/charts.ts releaseMarkersPlugin).
//
// `hits` has NO app-version column (confirmed via `PRAGMA table_info(hits)` — see
// lib/campaigns.ts's header for the same check) — so a release's date can't be DERIVED
// from D1 and has to be entered here by hand. v1.95.3 shipped pop-up tracking, campaign
// tracking, and the on-device return beacon together to production WEB 2026-09-26
// (confirmed live 14:31 UTC) — the SAME date as lib/popupEvents.ts's
// TRACKING_ACTIVATION_DATE_ET, so this reads that constant rather than duplicating it.
//
// SOURCING (2026-09-26 review, read-only against C:\Users\msant\dev\best-sudoku — no
// checkout/commit there): dates + notes are drawn from that repo's CHANGELOG.md (Keep a
// Changelog format, "documents what shipped per version" per its own header), cross-checked
// against `git for-each-ref refs/tags` creatordates, which agree closely for this window.
//
// SCOPE — why this starts at v1.86.4, not v0.1.0: best-sudoku has 220+ tags going back to
// April 2026, almost all pre-dating any real web traffic (the stats/beacon system itself,
// and the whole "Best Sudoku launch" concept, only exist for the run-up to the Sept 2026 web
// release). Charting the full 220-tag history would bury the handful of markers that matter
// to a TRAFFIC dashboard in noise no one asked for. v1.86.4 is the earliest tag whose CHANGELOG
// entry sits in the same continuous release cadence as v1.95.3 (the "Release cadence (Mike,
// 2026-09-10)" process in that repo's DEPLOY.md) with no ambiguity about it being an internal
// dev-branch checkpoint rather than a shipped version.
//
// PRODUCTION vs STAGING — how each entry below was verified: `main`-merge tag SUBJECTS say so
// explicitly for v1.86.4 and v1.87.0 ("merge(...->main): promote vX.Y.Z to production" — see
// `git for-each-ref`). Every other tag in this list follows the SAME documented convention
// (DEPLOY.md §2: "no git tag yet — we tag later, after deploy verifies", i.e. a tag is only
// created once a production deploy is confirmed) and sits in the unbroken vX.Y.Z sequence
// between v1.86.4 and v1.95.3, so it's treated as production too. `major` marks a release
// with a real user-facing Added/Changed section (shown as a labeled line in the timeline);
// everything else renders as an unlabeled tick (hover for its version) — see
// lib/charts.ts releaseMarkersPlugin / components/widgets/OverviewWidgetBody.vue's overlay.
//
// OPEN QUESTIONS (not included above — verify before extending this list backward):
//  - v1.86.0–v1.86.3 (2026-08-25 to 2026-08-29): each has its own CHANGELOG entry, but no
//    tag subject confirms a production promotion the way v1.86.4's does, and they precede
//    the first "promote to production" language in this repo's tags — could be same-day
//    staging iterations folded into the v1.86.4 promotion, or could be their own releases.
//  - v1.87.1 (tagged 2026-09-03, confirmed via git tag) has NO CHANGELOG.md entry at all —
//    status/content unverified; omitted rather than guessed.
//  - v1.86.4–v1.86.6 are primarily Android/Play-track changes (marked below); v1.86.6's own
//    note says it carries no user-facing change and is "the first Play build to include the
//    v1.86.5 fix" — included for release-cadence continuity, not as a web-traffic event.
//  - v1.90.0–v1.94.x were bumped in CHANGELOG/package.json history but never reached a
//    `vX.Y.Z` production tag before v1.95.3 shipped — presumed superseded/folded into
//    v1.95.3's promotion, not separate releases; omitted.
import { TRACKING_ACTIVATION_DATE_ET } from './popupEvents'

export interface ReleaseMarker {
  version: string
  dateEt: string | null // ET calendar date (YYYY-MM-DD), or null if not yet known
  note: string
  // Gets a full labeled marker on the timeline. Unset/false = an unlabeled tick (still
  // present, just not competing for label space) — keeps a long release history legible.
  major?: boolean
}

export const RELEASES: ReleaseMarker[] = [
  {
    version: 'v1.86.4',
    dateEt: '2026-08-31',
    note: 'Android: in-app purchase progress shown + auto-closing upgrade screen',
    major: true,
  },
  {
    version: 'v1.86.5',
    dateEt: '2026-09-01',
    note: 'Android: purchase confirmation dismiss fixed (tap anywhere)',
  },
  {
    version: 'v1.86.6',
    dateEt: '2026-09-01',
    note: 'No user-facing change — internal campaign-attribution plumbing; first Play build with the v1.86.5 fix',
  },
  {
    version: 'v1.87.0',
    dateEt: '2026-09-01',
    note: 'Web: Android visitors see a dismissible Google Play banner',
    major: true,
  },
  {
    version: 'v1.87.2',
    dateEt: '2026-09-07',
    note: 'Launch promo now requires a real sign-in to claim a spot',
  },
  {
    version: 'v1.87.3',
    dateEt: '2026-09-08',
    note: 'No user-facing change — internal crash reporting from signed-out visitors',
  },
  {
    version: 'v1.87.4',
    dateEt: '2026-09-09',
    note: 'Launch promo now claimed by finishing a game, not just signing in',
    major: true,
  },
  {
    version: 'v1.88.0',
    dateEt: '2026-09-09',
    note: 'New sign-in prompt after a game (leaderboard placement or 3rd game of the day)',
    major: true,
  },
  {
    version: 'v1.88.1',
    dateEt: '2026-09-19',
    note: 'Launch-promo email de-duplicated; sign-in prompt no longer eats puzzle time',
  },
  {
    version: 'v1.88.2',
    dateEt: '2026-09-19',
    note: 'Failed Google sign-in now tells the player why, instead of resetting silently',
  },
  {
    version: 'v1.89.0',
    dateEt: '2026-09-22',
    note: 'Sign-in page rewritten; stuck cloud-sync accounts recovered; tour crash fixed',
    major: true,
  },
  {
    version: 'v1.95.3',
    dateEt: TRACKING_ACTIVATION_DATE_ET,
    note: 'Pop-up + campaign-return tracking live on web',
    major: true,
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
