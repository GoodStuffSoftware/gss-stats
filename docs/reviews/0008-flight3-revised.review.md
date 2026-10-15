# Review 0008: revised flight 3 and the cost-per-arrival benchmark (feat/flight3-revised, 94e0529)

VERDICT: FIX

Range: origin/main (592ecac, 0.38.1) ..94e0529 (0.38.2), 12 files, one commit. origin/main has not moved (fetched; 94e0529 is a direct child of it). Reviewed in a detached worktree at C:/Users/msant/dev/gss-stats-wt-f3rev-review (own `npm ci`); the writer's tree was not touched except for this file.

## Result of the attack

The revised arms are recorded correctly and the code is sound: no blocker. The fix round is stale text that still describes the old Search arm, one claim in the CHANGELOG and runbook about where the cost line prints that is false, an Apps check that cannot be read from the report as the runbook says, and two tests that would not catch the bugs they name.

Commands run (review worktree at 94e0529):
- `npx vitest run`: 205 files, 3971 tests, all pass. `npm run typecheck`: exit 0. `npm run typecheck:scripts`: exit 0. `npm run build`: exit 0.
- Mutation A: remove `{ allDevices: allDevicesOf(r.campaign.id) }` from the `diagnosticsLines` call (report.ts:237). All 381 ads-reads tests still pass. The glue that turns the flag off for F3 Search is untested (SHOULD-5).
- Mutation B: replace the cost computation (read.ts:450) with `cumulativeSpend / (taggedArrivals || 1)`, which prints the whole spend as the cost per arrival when there are zero arrivals. All 381 pass. The zero-arrival test is circular (SHOULD-6).
- Mutation C: divide by `taggedHits` instead of `taggedArrivals`. The new `cumulative spend / tagged arrivals` test fails, as it should. Numerator and denominator are pinned.
- Throwaway probe (deleted; worktree clean) through `runMorningRead` + `formatMorningReport` on the threshold-50 fixture with the tagged `visitor='new'` count forced to 0, 1, 4 and 5 (spend $50.10): 0 gives `cost per tagged arrival — (...)`, 1 gives `—`, 4 gives `—`, 5 gives `$10.02`. No NaN, Infinity or $0.00 at zero. The 1-4 case is `—` too, which the runbook does not say (SHOULD-3).

Checks against the REVISED plan (plan file REVISED block and §5), all matching unless a finding says otherwise:
- Keywords: "no ads" family only, exact + phrase, F2 free-seeker terms dropped (campaigns.ts:136 notes). Max CPC $0.99 as a hard ceiling under $1, no day-3 raise. ALL devices, no mobile/tablet hard stop. Negatives F2's 10 plus free, online free, printable, puzzle book. F2's RSA plus a price headline. Apps: 17 placements, $0.35 max, copy plus "No ads. Passes from $1.99". Both arms $10/day, $70 cap, utm tags unchanged. All correct in the staged notes, the runbook table and the handoff's "Revised arms" block.
- Volume note (15-25 clicks a week, one week likely inconclusive, under 20 asks, rules unchanged): present in the notes, the runbook and the handoff.
- Day 1-2 check, runbook:167-182: Search "10 or more tagged complete rows over days 1-2 but 0 tagged sign-in ask rows (committed-repeat, committed-challenge or placement) -> propose pausing Search and check the live bundle"; Apps "30 or more tagged arrivals ... 0 tagged /coach/shown/place -> propose pausing Apps and check the live bundle"; thresholds are minimums, "too few rows"; replaces rule 3 which reads NOT COMPUTABLE after v1.99.0; does not touch rule 3's code; read-and-judge, never coded. The thresholds and the rule 3 statement match plan §5 word for word in substance.
- Flight 2 Search is unchanged: `allDevicesOf('24311309184')` is false, its plan has no `allDevices`, and `diagnosticsLines(base, 'search')` still prints the desktop-only ANOMALY (the existing searchChannel tests pass untouched).
- Staged rows stay inert: the diff touches only `STAGED_FLIGHT_3` data, `STAGED_FLIGHT_3_PLAN_SETTINGS` (one new optional field), the optional `allDevices` plan field and `allDevicesOf`, which reads `ADS_READ_PLANS` only (so a staged arm is `false`). `CAMPAIGNS`, `ADS_READ_PLANS`, the LEGS rows (`staged`, `<...>` placeholders) and the activation steps are untouched. The existing flight3Staged inertness and runbook-table tests pass.
- Division: `costPer(cumulativeSpend, summary.taggedArrivals)` is spend / tagged arrivals, null (`—`) when spend is unset or arrivals are under `MIN_COHORT` (5). Observation, not a regression and not in this diff: the numerator is closed-day spend through yesterday ET and the denominator counts tagged arrivals up to read time, so the figure is slightly low on any read that includes a partial day. The label ("cumulative spend / tagged arrivals") is accurate.
- Version and changelog: 0.38.2 in package.json, package-lock.json (both fields) and CHANGELOG, dated 2026-10-15. Patch is right per the brief: the cost line already existed and only gained text; no new report line. The commit carries the bump and promotion itself, the same shape as 0.38.1 (ac66ccc).

## Findings

### BLOCKING

None.

### SHOULD-FIX

#### SHOULD-1 The handoff's build spec and read plan still say $0.60, mobile/tablet hard stops, the old negatives and "device anomaly on"

`docs/campaigns/flight-3-handoff.md`:
- :110 "Manual CPC $0.60."
- :111 "Same 12 keywords and 10 negatives, plus 4 negatives: nytimes, nyt, easybrain, juego." (REVISED: F2's 10 plus free, online free, printable, puzzle book; and the 12 keywords are replaced by the no-ads family.)
- :112 "Mobile and tablet -100% hard stops".
- :116 "If option a: add a price headline ... and the 4 buyer-intent exact terms."
- :121 "device anomaly on" in the Read plan (the F3 Search plan sets `allDevices`; no anomaly).
- Only the :109 bullet carries "(Superseded: ...)". The "Build spec" heading at :107 and the four bullets under it do not, so a build agent reading :110-:112 gets the old Search arm. The "Recommended flight 3" heading was edited to say "superseded where the revised arms above differ", which is the only guard.
- Repro: `grep -n '0\.60\|-100%\|device anomaly on\|nytimes' docs/campaigns/flight-3-handoff.md`.
- Fix: rewrite or strike :110-:112, :116 and :121 (cheapest: mark the whole "Build spec" and "Read plan" blocks superseded in their own headings and drop the lines that contradict the revised block, or replace them with the revised values).

#### SHOULD-2 "In every ads read" is false: the cost line prints only on a threshold-crossing read and on post-flight stages

- The line sits in `fullReadLines` (report.ts:129). In the morning read `fullRead` runs only `if (crossedNow.length)` (read.ts:993), so `thresholdRead` is null on every other day (the existing test 'the same read again the same morning fires nothing' asserts `thresholdRead` is null). With the 18/35/53/70 ladder at $10/day that is about four reads in the week plus the post-flight stages. The daily "Tagged so far:" line (report.ts:213) carries no cost.
- Claims that are wrong as written: CHANGELOG.md:13 ("The tagged-funnel line in every ads read"), flight-3-handoff.md:82 ("every tagged read prints"), runbook:161 (presented as a per-arm daily quote with no mention of when it prints).
- The brief asked for "a cost-per-arrival line per arm" in the readout; on a non-threshold day the daily analyst has no cost line to quote against the $0.32 benchmark.
- Repro: run `runMorningRead` twice on the threshold-50 fixture; the second run's `formatMorningReport` has no `cost per tagged arrival` line.
- Fix, either: print cost per arrival and the benchmark on the morning "Tagged so far" line too (generic, with a test; `costPer(spend.cumulative.cost, tagged.cumulative.taggedArrivals)` is already in scope), or reword the CHANGELOG, handoff and runbook to "on every threshold read and every post-flight read".

#### SHOULD-3 The runbook says the cost line is "—" only with no arrivals; it is "—" under 5 arrivals

- runbook:161-163: "`—` while there are no arrivals". `costPer` goes through `computeRate`, which returns null under `MIN_COHORT` = 5 (popupEvents.ts:616). The probe above: 1 and 4 arrivals print `—`, 5 prints `$10.02`.
- This is the common case for the Search arm at 15-25 clicks a week, including the first threshold read: an analyst following the doc would read "—" as "no arrivals" when there are some. The new test titles also say "zero".
- Fix: write "— while there are fewer than 5 tagged arrivals (the MIN_COHORT gate)" in the runbook; add a 1-4 arrival assertion to the test (SHOULD-6).

#### SHOULD-4 The Apps day 1-2 check needs a count the report never prints, and the runbook says it does

- runbook:178-182 keeps "/coach/* rows are printed (the coach counting change is on main since 0.37.0)". 0.37.0 is the dashboard's popup-event counting. The ads report does not print tagged `/coach/shown/place`: `summarizeTaggedRows`, `P1BeaconCounts`/`p1Line`, `FIRST_SESSION_STEPS` (adsRules.ts:918) and everything under scripts/ads-reads (non-test) have no coach counter; the only "coach" text in the report is the beacon-countries caption (report.ts:349).
- With the runbook's own fallback ("a /coach/* row that the report does not print is 'not readable'; never infer it"), the Apps check as written can never produce a pause proposal; it always reads "not readable". The Search check is readable (tagged asks are printed by path; "game complete" is in the first-session block).
- Repro: `grep -rn coach scripts/ads-reads src/lib/adsRules.ts | grep -v test` returns only report.ts:349.
- Fix, either: state where the tagged `/coach/shown/place` count is read (and by whom) and drop the false "are printed" sentence; or add a counts-only tagged `/coach/shown/place` figure to the report (`taggedRowsQuery` already returns the rows, hour-bucketed; `/coach/shown` is a refused-split path so only the whole-flight and ET-day counts are allowed). The brief says the check itself must not be coded; a printed count is not a rule. The lead should decide, since the plan table (§4) lists "gss-stats counts /coach/*" as a gate for the Apps first-run read.

#### SHOULD-5 The `allDevices` wiring in `formatMorningReport` is untested

- Mutation A: delete `{ allDevices: allDevicesOf(r.campaign.id) }` at report.ts:237 and all 381 ads-reads tests pass. The new tests call `diagnosticsLines(..., { allDevices: true })` directly and `allDevicesOf(id)` directly, but nothing runs a registered F3 Search arm with MOBILE/TABLET spend through the report. If the glue is lost, F3 Search silently gets the desktop-only ANOMALY back.
- Fix: in flight3Staged.test.ts, register the staged search arm, run `formatMorningReport` on a result with `diagnostics.devices` containing MOBILE spend, and assert no `ANOMALY`/`desktop-only`; assert the same fixture on flight 2 Search (24311309184) still prints the flag.

#### SHOULD-6 The zero-arrival test is circular

- read.test.ts:169-177 sets `summary.taggedArrivals = 0` and then assigns `costPerArrival = costPer(spend, 0)` itself, so it tests `costPer` and `money`, not `fullRead`. Mutation B (divide by `taggedArrivals || 1`) passes all tests.
- Fix: build the fixture with no `visitor: 'new'` tagged rows (the probe did this by remapping `fx.beacon.tagged`), run the read, and assert the printed line for 0, 4 and 5 arrivals.

#### SHOULD-7 "Re-runs flight 2's exact setup ... so the read isolates the release" is no longer true

- runbook:114-115, campaigns.ts:95-96 and adsRules.ts:245-246 ("so the read isolates the release"). The Search arm now changes keywords, bid and devices and both arms add a price line, so an F3-versus-F2 difference is not attributable to the release alone. The plan §1 sentence ("Change only the product") is overridden by the REVISED block, and the analyst follows this runbook when reading results.
- Fix: say F3 reuses F2's setup apart from the revised Search arm and the price line, and that the F2 comparison is therefore not a clean release read. (The adsRules.ts :245 use is about the ladder, floors and cap; it is only wrong as a general claim, so a light edit.)

### NIT

- NIT-1 Descriptive labels still say "desktop intent": `src/lib/campaigns.ts:129` (`label: 'Flight 3 — search, desktop intent'`) and runbook:74 (LEGS name "F3 search (desktop intent)"). The campaign name in plan §2 ("... Desktop intent - F3 Search") was not changed by the REVISED block, so the Google Ads name may stay; the gss-stats label shown on the dashboard once registered should not claim desktop. Ask the ads agent whether the campaign is renamed.
- NIT-2 Comments at report.ts:308 and :328 still say "a desktop-only search arm" / "A search arm is desktop-only" without the `allDevices` exception that the code now has.
- NIT-3 README.md:1100-1101 lists the plan fields for "Adding a new campaign" and omits `allDevices`; it is documented only in the device paragraph at :1188-1192, where the inserted sentence also leaves "Never a pass, never a trip." running on a long line.
- NIT-4 CHANGELOG order: a `### Changed` section precedes `### Added`; the repo's other releases list Added first. The first bullet is two sentences plus the volume note; trim to one sentence.
- NIT-5 Informational, no change needed: at 15-25 clicks a week the Search check's "10 or more tagged complete rows over days 1-2" will rarely be met, so it will usually read "too few rows". That is the plan's design (thresholds are minimums), worth one line when the lead briefs the analyst.

## Disposition (writer, fix round)

All seven should-fix items fixed in the post-review commit: handoff build spec updated to the revised values (1); "every ads read" corrected to the threshold and post-flight tagged-funnel block (2); the 5-arrival small-sample gate documented, with tests at 0, 3 and 5 arrivals through the real divide (3, 6); the runbook now says the ads report does not print tagged `/coach/shown/place` and the Apps check is "not readable" (no pause proposed) when the routine cannot read it (4); a morning-report test pins the `allDevices` wiring both ways (5); "exact setup / isolates the release" wording corrected (7). Nits: code comments and README plan-field list updated; the "Desktop intent" Google Ads campaign name and LEGS label are kept on purpose (the campaign name is fixed in Google Ads and a test pins the label). Disputed: none. Open for the lead: a counts-only printed tagged coach figure in the ads report would need code, which the brief ruled out for the check itself.
