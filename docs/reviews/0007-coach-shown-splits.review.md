# Review 0007: refuse splits on /coach/shown/% (fix/coach-shown-splits, ac66ccc)

VERDICT: FIX

Range: origin/main (9f58db8, 0.38.0) ..ac66ccc (0.38.1), 18 files, branch is up to date with origin/main. Reviewed in a detached worktree (junction to node_modules, removed afterwards); the reviewed worktree was not touched.

## Result of the attack

The behavior is correct and complete. No `/coach/shown/<tip>` row leaks through any hour, place or device split on any query path. The fix round is three README statements that now contradict the code, plus stale comments.

The pattern list is the single source for every path that matters (`refusedPathMatch`, `refusedPathExcludeClause`, `isSplitRefusedPath`, `SPLIT_GUARD_KEY`, `REFUSED_WINDOW_KEY`, `reachableRefusedPatterns`), so the one-line change reaches all of them; I found no hand-rolled copy of the list in code.

Commands run (review worktree at ac66ccc):
- `npx vitest run`: 205 files, 3966 tests, all pass. `npm run typecheck` (vue-tsc): exit 0. `npm run typecheck:scripts`: exit 0. `npm run build` not run (no .vue or build input changed).
- Mutation: delete only `'/coach/shown/%'` from `SPLIT_REFUSED_PATH_PATTERNS` and rerun everything: 37 tests fail in 9 files (`geo.splitGuard` 11, `facts` 10, `splitGuard.window` 2, `splitGuard.beaconParity` 2, `bindParity` 2, `popupEvents` differential 1, `refusedWindow` 1, `geo.liveSafe` 1, plus my probe). Behavioral tests fail, not only literal pins: the seeded `/coach/shown/place|hint` rows in `geo.splitGuard.test.ts` reappear in points, hourEt, region, device, ring and drill answers; the real-SQLite differential in `popupEvents.test.ts:1020` flips for 5 paths. A slipped pattern cannot pass the suite.
- Throwaway probe `functions/api/zzProbeShown.test.ts` (real node:sqlite behind the real `/api/geo` and `/api/popups` handlers; deleted, not committed). Seed: 5 shown, 5 dismissed, 5 closed-at, 3 tour-opened, 4 odd shapes (`/COACH/SHOWN/place`, `/coach/shown/`, `/coach/shown/place/extra`, `/Coach/Shown/WHEEL`), 1 `/game`, spread over hours, countries, regions, devices. Expectations hard-coded, not derived from the JS matcher. 8 of 9 pass:
  - Every one of the 17 `SPLIT_REFUSED_DIMS` as the single dim, event beacons on: total is exactly the 3 tour-opened + `/game` (4), off: 1. Points mode: 4.
  - Rings with a refused dim in either order, and 3-dim rings: 4. (The one probe failure is my seed: `['pathFamily','site','colo']` returned 0 because `colo` is blank and rings drop blank rows; not a leak.)
  - Drills on hourEt, country, region, device, visitor, screenwBucket, browser, os, city, colo crossed with every non-refused dim: no row keyed by a `/coach/shown|dismissed|closed-at/` path.
  - Differencing: `pathFamily=coach` or a `path=/coach/shown/...` drill (also upper-case, empty tip, extra segment) with hourEt, device, country, screenwBucket, UTC `date`: family gives only the 3 tour-opened rows, every shown path gives 0. `path=/coach/tour-opened` stays splittable (3), as intended.
  - ET-day totals survive: `path` and `dateEt` with event beacons count all 23 coach/control rows.
  - `/api/popups`: the hourly SQL returns no `/coach/shown|dismissed|closed-at` row. Before this change it pulled the shown rows (popupIncludeClause matches `/coach`) and dropped them only in JS; now SQL drops them. Output unchanged.
  - `meta`: a sub-day window with `path=/coach/shown/place` now sets `refusedWholeDays: true` (it was false in 0006); `path=/coach/tour-opened` does not; `hourEt` sets `splitGuard: true`.
- Other readers: `functions/api/geo.ts` (breakdown, ring and points branches all take `refusedPathExcludeClause`/`refusedWindowClause`), `completions.ts` (refusedWindow key), metrics facts (`t` and `cb` flags via `refusedPathMatch`; snapshot diff is only the new LIKE term), `scripts/ads-reads/beacon.ts` `siteEventsQuery` and `taggedCountryQuery` (`refusedPathExcludeClause`; their tests iterate the pattern list). `taggedRowsQuery` (beacon.ts:28) returns (UTC hour, path, visitor) for campaign-tagged rows without the guard, so shown rows reach the routine by hour exactly like `/return/` and completion rows; this is the documented standing (beacon.ts:20-26, hour only cuts at ET day, flight boundary or maturity instant) and the only hour consumers are `adsRules.ts:736,857,887` windows, so it is consistent, not a new leak.
- Cache keys: `SPLIT_GUARD_KEY` and `REFUSED_WINDOW_KEY` (hash of the list) change, so no pre-change answer is served; metric fact keys hash the SQL text, which now carries the new LIKE term. Captions: `SPLIT_GUARD_CAPTION`, `REFUSED_WHOLE_DAYS_CAPTION`, `notes.ts:399` and `report.ts:346` all name "shown" and their tests were updated.
- Beacon mirror: `git -C gss-beacon show 6ad3b65:functions/_lib/refused.ts` lists the same 12 patterns in the same order with the same matcher; its `test/refused.test.ts` refuses `/coach/shown/x` and allows bare `/coach/shown` and `/coach/tour-opened`, the same cases `splitGuard.beaconParity.test.ts` pins. 6ad3b65 is only on `origin/feat/live-notify`, not on beacon main, so there is no live leak today; it lands with live-notify. The "once per tip per device" rationale is true in Best Sudoku (`coachSchedule.ts` persists `shown`, `useCoachStrip.ts:259` skips a tip already shown).

## Findings

### BLOCKING

None.

### SHOULD-FIX

#### SHOULD-1 Three README statements still describe `/coach/shown` as splittable or omit it

CLAUDE.md: README in the same commit as the behavior change. The commit updated README lines 703, 763 and 1439 but missed three spots in the same rule's text:
- `README.md:722`: "`/coach/shown/…` and `/coach/tour-opened` stay splittable like `/tour/start`." This is now false, and it is the exact behavior this commit reverses. Fix: "`/coach/tour-opened` stays splittable like `/tour/start`; `/coach/shown/…` is counts only like the dismiss and close rows."
- `README.md:710`: the list of paths the guard leaves out entirely ends "`/tour/exit-at/…`, `/coach/dismissed/…` and `/coach/closed-at/…`"; add `/coach/shown/…`.
- `README.md:207`: "coach-strip dismisses and closes: no hour, place or device split" in the caption-token paragraph; add "shown,".
- Repro: `grep -n "stay splittable\|dismisses and closes" README.md`.

### NIT

- NIT-1 `src/lib/popupEvents.ts:110`: "`closed-at` and `dismissed` are count-only (splitGuard.ts)." Now `shown` is too. Say "`shown`, `closed-at` and `dismissed` are count-only; only `tour-opened` can be split."
- NIT-2 Comments that list the refused kinds and still omit every coach kind (stale since 0.38.0, one more reason now): `src/lib/splitGuard.ts:4-6` (header) and `:97-100` (the doc comment on the pattern list, which also says what the rule protects), `functions/api/popups.ts:123-125`, `scripts/ads-reads/beacon.ts:44-46`, `src/lib/metrics/metrics.ts:110-112`. Add "coach-strip shown, dismiss and close rows" so a reader of the list sees all twelve patterns accounted for.
- NIT-3 The commit history carries `d426587 ... (WIP)` before `ac66ccc`; fine if the merge squashes or the subject does not matter on main.
