# Review 0006: coach-strip counting (feat/coach-counting, d4f1e0db)

VERDICT: FIX

Range: origin/main (2b9cdc49) ..d4f1e0db. Reviewed in a detached worktree (C:/Users/msant/dev/gss-stats-wt-coach-review, no commits, junction to node_modules removed afterwards).

## Result of the attack

The code is correct. The 16 paths count as events, never as page views, in the JS classifier and in the SQL, and the two refused families do not leak through any hour, place or device split. The fix round is for the cross-repo mirror, stale user-visible wording, unexecuted SQL coverage and README drift. Nothing found is a behavior bug in this repo.

Commands run (review worktree at d4f1e0db):
- `npm test`: 204 files, 3947 tests, all pass.
- `npm run typecheck` (vue-tsc): exit 0. `npm run typecheck:scripts`: exit 0. `npm run build`: exit 0.
- Throwaway probe `functions/api/zzProbeCoach.test.ts` (real node:sqlite behind the real `/api/geo` handler; deleted, not committed), 8/8 pass:
  - All 16 paths: `isPopupEventPath`, `isEventPath`, `pathFamilyOf` = `coach`, `classifyPopupPath` = null; in SQL `popupExcludeClause` drops them, `popupIncludeClause` picks them up, `pathFamilySqlCase` = `coach`. `/coaching`, `/coach-tips`, `/coachx` stay page views.
  - Default geo path chart: no `/coach/*` row, `totals.pageviews` unchanged. With `includeEventBeacons`: all 16 appear, family `coach` = 32 rows for 2 rows per path.
  - Every refused trigger (points mode; all 17 `SPLIT_REFUSED_DIMS` as the single dim; ring with a refused dim in either order; drills on region, hourEt, device) with event beacons on: all 10 `/coach/dismissed/<tip>` and `/coach/closed-at/<tip>` rows are gone, the 5 `shown` rows and `tour-opened` stay. `dateEt`, `site`, `path`, `pathFamily` keep all 16 as ET-day totals.
  - Hour-differencing attempts fail: `hourEt` with `pathFamily=coach` returns only shown/tour-opened rows; `hourEt` with `path=/coach/dismissed/place` or `/COACH/Closed-At/place` returns 0.
  - `meta`: event rows excluded gives `liveSafe: true`; with event beacons on it is not `true`; a sub-day window with a `path=/coach/dismissed/place` drill sets `refusedWholeDays: true`, a `path=/coach/shown/place` drill does not.

## Findings

### SHOULD-1 The beacon mirror is not updated, and the parity test cannot catch it

- Where: gss-beacon `functions/_lib/refused.ts` and `test/refused.test.ts` (only on `origin/feat/live-notify` @0f0046e, not on beacon `main` @1cbf64c); this repo `src/lib/splitGuard.beaconParity.test.ts:1-3` and `:8-23`; README live-updates privacy bullet (`README.md:1430`).
- Repro: `git -C C:/Users/msant/dev/gss-beacon show origin/feat/live-notify:functions/_lib/refused.ts` lists 9 patterns; `SPLIT_REFUSED_PATH_PATTERNS` here now has 11. The beacon's `isSplitRefusedPath('/coach/closed-at/hint')` is false, so once live-notify lands a coach dismiss or close row would trigger and shift a live "changed" ping. README says a refused row "never triggers or shifts a ping".
- Why the test does not catch it: each repo pins its own copy of the literal. This commit changed the stats literal only, so both suites pass while the lists differ. The header "Change the list in both repos, or a test fails" is untrue for a one-sided change.
- No live leak today: beacon `main` has no `refused.ts`, and README makes the beacon deploy the last step. It becomes a leak when live-notify merges.
- Fix: carry the two patterns plus the matcher cases (`/coach/dismissed/place`, `/coach/closed-at/clash`, `/COACH/Closed-At/hint` refused; `/coach/shown/place`, `/coach/tour-opened`, bare `/coach/dismissed`, `/coach/closed-at` not) to gss-beacon `functions/_lib/refused.ts` and `test/refused.test.ts` before or with the live-notify merge. Hand that to the beacon owner; record it as a gate on the live-notify landing. Add `coach-strip dismiss and close` to the README:1430 list.

### SHOULD-2 Refused-kind wording is stale in user-visible text

- `src/lib/splitGuard.ts:203-205` `REFUSED_WHOLE_DAYS_CAPTION` ("Any return, game-start, completion, tutorial-completion, tour-skip or tour-exit rows here are counted over whole ET days.") is the caption for `meta.refusedWholeDays`. Its own doc comment says it "names every refused kind". It is quoted at `README.md:763`.
- `src/lib/notes.ts:399` (country-column note, "Counts only: the country columns leave out return, game-start, completion, tutorial-completion, tour-skip and tour-exit rows ...").
- `scripts/ads-reads/report.ts:346` (report line "...return, completion, game-start, tour-skip and tour-exit rows left out").
- Repro: `/api/geo` with `dimension: dateEt`, `includeEventBeacons: true`, `constraints: [{field:'path', value:'/coach/dismissed/place'}]`, `since: 2026-10-01T10:00:00Z`, `until: 2026-10-01T18:00:00Z` returns `meta.refusedWholeDays: true`, and the chart caption then names no coach rows. `SPLIT_GUARD_CAPTION` was updated (splitGuard.ts:152-153) but its sibling was not, so the two captions disagree.
- Also stale, comments only: `splitGuard.ts:5` and `:97-99`, `functions/api/geo.ts:370`, `functions/api/popups.ts:124`, `scripts/ads-reads/beacon.ts:45`, `src/types.ts:297-300`.
- Fix: add "coach-strip dismiss and close" to those strings (check tests that pin the note and report text, then update them) and the comments.

### SHOULD-3 No test executes the new patterns on real SQLite

- The new `popupEvents.test.ts` SQL assertions (`:1010-1012`) are `toContain` substring checks. The refused side adds the literal list (`splitGuard.beaconParity.test.ts`, `geo.splitGuard.test.ts:115-123`, `bindParity.test.ts:266`), the exact-SQL string (`geo.splitGuard.test.ts:130-135`) and matcher cases.
- Not extended with coach rows: the seeded `REFUSED` / `ORDINARY` arrays in `functions/api/geo.splitGuard.test.ts:59-83` (which drive "in SQL, matches every refused row and no ordinary row", "isSplitRefusedPath agrees with the SQL LIKE row for row" and every trigger test), `functions/api/bindParity.test.ts:31-32` (`REFUSED`; only `ORDINARY` got coach paths), `geo.nulPath.test.ts`, `metrics.splitGuard.test.ts`, `popups.splitGuard.test.ts`, `scripts/ads-reads/beacon.splitGuard.test.ts`.
- Effect: the brief asked for tests of the JS classifier and the SQL, and "no hour, place or device splits". My probe shows the behavior is right, but nothing in the suite would fail if JS and SQL drifted for `/coach/*` (for example a LIKE case or wildcard slip), and nothing runs a coach row through an hour/place/device split.
- Fix: add the 10 refused coach paths to `REFUSED` and `/coach/shown/place`, `/coach/tour-opened`, `/coach/dismissed`, `/coach/closed-at` to `ORDINARY` in `geo.splitGuard.test.ts`, and to `REFUSED` in `bindParity.test.ts`. Add one real-SQLite test that runs the 16 paths through `popupExcludeClause`, `popupIncludeClause` and `pathFamilySqlCase` against the JS twins (copy the differential in my probe).

### SHOULD-4 README enumerations missing coach (CLAUDE.md: README in the same commit)

- `README.md:683-690`: the "Paths under ..." list of pop-up/event prefixes has no `/coach`, and `/api/popups` "never counts" list at `:693-696` does not name `/coach/…`.
- `README.md:796-800`: the `pathFamily` value list ends `... game-start / funnel / ab-ask-order` with no `coach` (it also already lacks `game-complete-deferred`, pre-existing).
- `README.md:763`: quotes the stale whole-days caption (SHOULD-2).
- `README.md:1430`: live-updates refused list (SHOULD-1).

### NIT-1 Prefix is `/coach`, brief said `/coach/`

- `src/lib/popupEvents.ts:111` uses the exact-or-subpath form, so a bare `/coach` is an event (pinned by `popupEvents.test.ts:550`; SQL gets two predicates). Best Sudoku has no `/coach` page route (`best-sudoku-coach-strip/src/router/routes.ts` has `/`, `/onboarding` and a catch-all), and `COACH_BEACON` (`src/services/coach/coachSchedule.ts:381-385`) always appends a tip, so there is no practical effect.
- If you want the brief's literal shape and the `/game/start/` convention, use `'/coach/'` (one `NOT LIKE '/coach/%'` term, no bare `/coach` event). Either is acceptable; the pattern list and tests would not change except the `/coach` entries in the prefix-list test and the label key.

### NIT-2 No dashboard card or catalog metric

- Coach counts are visible only in geo charts ("Include event beacons" with `pathFamily` = `coach` or the `path` dimension). The brief said "wire like tour events": `/tour/start|complete|skip` have no catalog metric either (only `bsk.tourExit*`, `bsk.tutorial*` do), so the commit matches that. If Mike wants the flight-3 shown to dismissed to closed read on Overview, that is a follow-up (new `bsk.coach*` MetricDefs; they would count refused rows, so default `countsRefused`), not a gap in this commit.

## For Mike to decide (not decided here): should `/coach/shown/%` and `/coach/tour-opened` also be refused?

Nothing was changed for these. Evidence both ways from existing rules:
- Leave splittable: the rule refuses return, game-complete, tutorial-complete, game-start, tour skip and tour exit (Mike 2026-10-03, "Usage-only, enforced"; R-1b ruling "existing /tour/* paths stay splittable"). `/tour/start`, `/tour/complete`, `/game/first-move` and `/game/abandon/*` stay splittable. `/coach/shown/<tip>` (a display) and `/coach/tour-opened` (a tap that opens the tour hub) are the closest analogs of `/tour/start`. Best Sudoku's own doc calls `closed-at` "like abandon" (`/game/abandon/*` is splittable), so refusing closed-at and dismissed is already stricter than abandon.
- Refuse: `shown` is once per tip per device, ever (`bsk_settings.coach.shown`), so each row is a "device remembered this" marker, the same reason `/game/tutorial-complete/{first-run,replay}` and the `/return` buckets are refused. An hour split of `shown` rows would give a per-hour first-time-seen read by tip.
- Differencing: `shown` stays hour-splittable while `dismissed` and `closed-at` are day-only. That does not let a reader recover the hour of a dismiss or close (they are only ever counted in whole ET days), so the refused rows themselves do not leak. If Mike rules `shown`/`tour-opened` refused, it is two more patterns plus the same mirror, caption, README and test updates, and the routine's hourly site-event read (`scripts/ads-reads/beacon.ts:48`) and the metrics popup facts then drop them automatically.

## Checked and clean

- `/api/popups` (`functions/api/popups.ts:120-126`), the metrics popup facts (`popupRangePath`, `popupRangeDaily`) and the routine's hourly read now pull `/coach/shown/*` and `/coach/tour-opened` through `popupIncludeClause`, exactly as `/tour/start` already is. They classify to nothing and are ignored; the "none is a pop-up event, so no count changes" comments still hold.
- `bsk.pageviews` (`metrics.ts:510`) uses `isEventPath`, which includes `isPopupEventPath`, so coach rows stay out of page views. Cache keys (`SPLIT_GUARD_KEY`, `REFUSED_WINDOW_KEY`) change with the list, so no stale cached answer is served under the old list.
- `reachableRefusedPatterns` and the pathFamily drill pick up the new patterns automatically (`coach` family sample paths); `liveSafe` stays fail-closed.
- Case: JS `isPopupEventPath` is case-sensitive while SQLite LIKE is ASCII case-insensitive (`/COACH/shown/place` is excluded in SQL, a page view in JS). Pre-existing for every prefix, not introduced here; the refused matcher folds case on both sides.
- Version: `package.json` and `package-lock.json` 0.37.0, CHANGELOG `[0.37.0] — 2026-10-15` with an empty `[Unreleased]`; matches the brief (minor bump 0.36.0 to 0.37.0). `facts.test.ts.snap` changes are the 10 expected SQL strings.
