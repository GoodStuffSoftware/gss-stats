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
// lib/charts.ts releaseMarkersPlugin.
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
import { TRACKING_ACTIVATION_DATE_ET, NEW_BEACONS_LIVE_AT_ET, RAW_INSTALL_DEDUPE_LIVE_AT_ET, etDateFromMs } from './popupEvents'

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
  {
    version: 'v1.95.4',
    dateEt: '2026-09-26',
    note: 'Installs made from the install prompt are now counted',
  },
  {
    version: 'v1.95.5',
    dateEt: NEW_BEACONS_LIVE_AT_ET,
    // Not `major`: its go-live marker ("game + auth breakdown live") already labels 2026-09-26,
    // so a second labelled line the same day only crowds the timeline. Shows as a tick.
    note: 'Finished games and new-vs-returning sign-ins now reported',
  },
  {
    version: 'v1.95.6',
    dateEt: RAW_INSTALL_DEDUPE_LIVE_AT_ET,
    note: 'Install total no longer double-counted across open tabs',
  },
  {
    version: 'v1.95.7',
    dateEt: '2026-09-28',
    note: 'Finished dailies no longer revert to unsolved; wrong-puzzle win summary fixed',
  },
  {
    version: 'v1.95.8',
    dateEt: '2026-09-28',
    note: 'Daily challenges now generate themselves; test-build sign-in goes straight in',
  },
  {
    version: 'v1.96.0',
    // Dated per the BSK release owner's 10-03 close-out message (live 22:21 ET on 10-02); the
    // git tag reads 10-03 01:09 ET, but BSK is authoritative for release timing.
    dateEt: '2026-10-02',
    note: 'Tour-first for new players, sign-in invite after the tour, sign-in before install',
    major: true,
  },
  {
    version: 'v1.96.1',
    dateEt: '2026-10-03',
    note: 'Leaderboard sign-in invite from 3 entries; cancelled install no longer hides the suggestion',
  },
  {
    version: 'v1.97.0',
    // Per the BSK release owner's 2026-10-03 message: live on prod web, prod live check passed.
    // Last 1.96.1 seen 17:03:37Z, first 1.97.0 seen 17:03:40Z (13:03:40 ET; popupEvents.ts
    // TOUR_TRACKING_LIVE_AT). A hosting-only local deploy; no backend change since 1.96.1.
    dateEt: '2026-10-03',
    // Not `major`: its go-live marker ("tutorial + tour exit beacons live") already labels
    // 2026-10-03, so a second labelled line the same day only crowds the timeline (as v1.95.5).
    note: 'Tutorial completions split first run vs replay, tour exit step tracked; first-run win offers a real game',
  },
]

export type DatedRelease = ReleaseMarker & { dateEt: string }

export function datedReleases(): DatedRelease[] {
  return RELEASES.filter((r): r is DatedRelease => r.dateEt !== null)
}

const dayAfter = (d: string): string => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/** The newest of a chronologically listed set; on a date tie the later-listed release wins. */
export function newest(list: DatedRelease[]): DatedRelease | null {
  if (!list.length) return null
  return list.reduce((a, b) => (a.dateEt > b.dateEt ? a : b))
}

/** The release the before/after panel compares, given today's ET date: the newest dated release
 * whose first after-day is complete (release date strictly before yesterday), or null if none
 * qualifies. The "after" window starts at the ET midnight following the release date, so the
 * release day itself (often mostly pre-release traffic) is never counted. */
export function releaseSubjectOn(todayEt: string): DatedRelease | null {
  return newest(datedReleases().filter((r) => dayAfter(r.dateEt) < todayEt))
}

/** The newest dated release still waiting for its first full after-day, when it is newer than
 * the subject, else null. */
export function releaseAwaitingFullDay(todayEt: string): DatedRelease | null {
  const waiting = newest(datedReleases().filter((r) => dayAfter(r.dateEt) >= todayEt))
  return waiting && waiting.dateEt > (releaseSubjectOn(todayEt)?.dateEt ?? '') ? waiting : null
}

/** The release the panel compares at `nowMs`: the newest dated release whose first after-day (the
 * ET day after its release date) is complete, or null if none qualifies (the panel then reads "release-pending"). */
export function latestDatedRelease(nowMs: number): DatedRelease | null {
  return releaseSubjectOn(etDateFromMs(nowMs))
}
