# Review 0009: report prints tagged coach, complete and ask counts

Branch `feat/report-coach-count`, commit `dfcff4fd10acabda4e9738338a4046cf49363477`
(diff `origin/main..dfcff4fd`, 7 files). Reviewer checkout (detached, no commits):
`C:/Users/msant/dev/gss-stats-wt-coachcount-review`.

VERDICT: FIX

One should-fix (runbook wording about which report holds the days 1-2 total), two nits. No blocker.
The counts themselves are right, the split guard is neither hit nor bypassed, and a zero prints 0.
The review ran partially (see "Not completed").

## Findings

### Should-fix

1. **Runbook says the cumulative figure is the days 1-2 total "on days 1-2"; the report does not print
   that on Day 2.** `docs/routines/ads-cloud-daily.md` (Flight 3, "Day 1-2 tracking check", the sentence
   "The first figure of each pair is cumulative since the arm's start; on days 1-2 that is the days 1-2
   total.").
   The runbook's own Part A rule says Day N counts from the flight start as Day 1, and the read window is
   D+1..D+7, so the first read is the Day 2 morning read (08:37 ET). Both arms have
   `flightStartTimeEt: '12:00'` (`src/lib/campaigns.ts` STAGED_FLIGHT_3) and an ad schedule of
   12:00-23:00 ET, so:
   - Day 2 report: cumulative = Day 1 (12:00-24:00) plus Day 2 up to 08:37; the bracket (yesterday) = Day 1.
     This is NOT the days 1-2 total.
   - Day 3 report: cumulative = days 1-2 plus Day 3 up to 08:37 (before serving starts, so close to the
     days 1-2 total); the bracket = Day 2. This is the first report that holds days 1-2.
   - Day 4 and later: cumulative runs past days 1-2, and only the bracket (one day) is a single-day figure.
   Repro: read `attributionStartMs` (campaignAttributionClause: `campaign IN (ucs) AND ts >= start`, no
   upper bound) against read.ts:974-981 (`cumulative` = `summarizeTaggedRows(rows)` with no window,
   `yesterday` = `[yStart, yEnd)`).
   Effect: the routine can judge "days 1-2" on a Day 2 report (one half day) or on a Day 5 report
   (cumulative past day 2), and the sentence tells it that is fine. The direction of error is safe for the
   zero conditions (cumulative can only be larger than days 1-2, so a printed 0 is a true 0 for days 1-2),
   but the thresholds (10 complete rows, 30 arrivals) are met sooner than the text implies.
   Fix (docs only, one line): say which report judges the check. For example: "Judge on the Day 3 report
   (cumulative is then days 1-2 plus the Day 3 hours before 08:37 ET; the Day 2 report holds Day 1 only, and
   the bracket is one day). A printed 0 in cumulative is a 0 for days 1-2. After Day 3 do not re-judge."
   Optionally reword "(N)" as "yesterday's ET day" so it is not read as a days 1-2 figure.

### Nits

2. **Comment now sits above the wrong statement.** `scripts/ads-reads/report.ts:133-136` ("Not a rate
   (review finding, 2026-09-26) ... acceptRate IS a real rate") described the `asks · arrivals; accept
   rate` push. The new `out.push(trackingCheckCounts(...))` at line 137 was inserted between the comment
   and its push (now line 139). Move the new push above the comment or below the push it belongs to.

3. **Two different ask totals on one line.** The daily "Tagged so far" line prints `N asks` (all six
   ASK_PATHS, including streak, tutorial and promo) and, at its end, `sign-in ask rows (placement,
   committed-repeat, committed-challenge) N`. The runbook explains the second one ("leaves streak,
   tutorial and promo asks out"), so this is only a reading hazard, not a bug. No change needed unless a
   routine misreads; a line-order tweak (tracking-check counts first) would not help either.

## What was checked and held

1. **Tagged count per arm.**
   - Campaign tag: `taggedRowsQuery` -> `campaignAttributionClause` (`campaign IN (ucValues) AND ts >=
     attribution start`, noon ET start for both F3 arms), then `applyExclusions` (household, Reston
     verification, lifecycle email). The new fields read the same `rows`, so they cannot disagree with
     the existing tagged arrivals, asks and accepts.
   - AB twin rows: `summarizeTaggedRows` skips `isAbTwinPath` before any total, so `flight3Asks` and
     `coachShownPlace` exclude them. `completeRows` comes from `computeFunnelCounts`, which gets the twin
     rows too, but `classifyFunnelPath('/ab/ask-order/...')` never returns `completed` (`startsWith
     '/game/complete/'`), so no leak.
   - Exact path match: `r.path === '/coach/shown/place'` and a three-path `includes`, with a test for
     `/coach/shown/place/extra`, `/COACH/Shown/Place`, `/ab/ask-order/x/coach/shown/place`,
     `/coach/shown/wheel`. Complete rows = `/game/complete/` prefix only (`/game/complete-deferred/` is a
     different prefix, not counted).
   - Yesterday window: `[etMidnightUtcMs(yesterdayEt), etMidnightUtcMs(todayEt))` over UTC-hour buckets;
     ET midnight always falls on a UTC hour boundary, so the cut is row-exact (the fixture test pins 7 (2)
     / 5 (1) / 7 (3)).
   - Ask rows: placement + committed-repeat + committed-challenge only; streak (6) excluded in the test;
     matches the runbook's "exactly those three paths".
2. **Split guard** (`src/lib/splitGuard.ts`). No new SQL, no new query: the change reads rows that
   `taggedRowsQuery` already fetches (it is not path-restricted and already carries `/game/complete/` and
   `/coach/*` rows by UTC hour, documented in its header; the writer extended that header). The new numbers
   are printed only as a cumulative total and yesterday's ET-day total; no hour, place or device appears
   (the regex test on the line is weak but the code path has no such column). `/coach/shown/%` is not
   queried by an hour/place/device group, so the guard is neither hit nor bypassed. The cumulative figure
   includes the open ET day, which the guard header already accepts ("Today's refused totals stay live",
   ruling 2026-10-03). The new counts are not added to the stored `ReadingRecord.counts`. Good.
3. **Routine readability.** Part A relays `/tmp/am/ID.report.txt` (text before `----- JSON -----`); the
   "Tagged so far" line carries arrivals (floor), asks, and now the tracking-check counts, so:
   - Search: tagged complete rows and tagged ask rows are both on the line (cumulative and yesterday).
   - Apps: tagged arrivals (already on the line) and `/coach/shown/place` rows.
   - "Tagged: NOT READ": the line reads exactly `Tagged: NOT READ (<error>)` when the tagged read fails,
     with no counts; the runbook text matches that string and says never to infer a count.
   The runbook's quoted line format matches the code string character for character
   (`tracking-check counts (tagged ET-day totals; yesterday in brackets): complete rows N (N), sign-in ask
   rows (placement, committed-repeat, committed-challenge) N (N), /coach/shown/place rows N (N)`), and the
   tagged-funnel block prints the same three counts without brackets, as the runbook says.
4. **Zero prints 0.** `n(x)` returns the dash only for null/undefined; `taggedCounts` always sets all three
   fields (summary defaults are 0), and the tests assert `complete rows 0 (0)`, `/coach/shown/place rows
   0 (0)` and no dash in the block. A tagged read failure uses the NOT READ line, never a dash for a count.

## Commands run

In `C:/Users/msant/dev/gss-stats-wt-coachcount-review` (detached at dfcff4fd, `npm ci` done):

- `npx vitest run scripts/ads-reads src/lib/adsRules.test.ts`: 19 files, 487 tests, all pass.
- `npm run typecheck:scripts`: clean (both tsconfigs).
- Full `npx vitest run`: 206 files, 3979 tests, all pass. `npm run typecheck` (vue-tsc): exit 0.
  `npm run build`: exit 0.

## Not completed

- No end-to-end run of `taggedRowsQuery` through an in-memory SQLite `hits` table with `/coach/shown/place`
  rows (the existing `beacon.splitGuard.test.ts` shows the pattern). The SQL is unchanged by this commit,
  so this is a confidence check, not a suspected gap.
