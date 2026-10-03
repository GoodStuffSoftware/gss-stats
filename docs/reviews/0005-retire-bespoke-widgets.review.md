# Review: ADR 0005 (retire bespoke widgets)

- **Reviewed:** `docs/adr/0005-retire-bespoke-widgets.md` at commit `057a50d`, against `origin/main`.
- **Reviewer:** an adversarial reviewer at opus/high (writer: opus/high). One review, one fix round.
- **Date:** 2026-10-03

## Verdict (verbatim)

> VERDICT: APPROVE WITH FIXES — the inventory, the decision (b) tile list and the slice 1 design all check out; five gaps (stale-tab saves, the "inputs match" claim, the card's extra caveat, the zero-denominator display, and the stat tile's states) need wording or tests before slices 4 and 5 are built.

## Findings (verbatim)

1. **SHOULD-FIX: with no version bump, an open old-build tab is never refused.**
   - **Refutes:** "Saved layouts and rollback" (ADR L235-256). It treats rollback as the only risk and the manual KV copy as the only fix.
   - **Evidence:**
     - `functions/api/config.ts` L75-77: `incomingVersion < storedVersion` gets 409 "stale". The check is version-only, so two v12 builds always pass it.
     - `functions/api/config.ts` L78-85: the backup to `dashboard:default:backup:v<stored>` runs only when `incomingVersion > storedVersion`.
     - `src/App.vue` L61: `const [stored] = await Promise.all([loadConfig(), loadSites()])`. The layout is read once, on mount.
   - **Consequence:** a tab opened before a slice deploys keeps its old layout in memory. Its next save overwrites every edit made through the new build: card specs, `fit`, converted tiles. It gets no 409 and leaves no backup.
     - This last-writer-wins behaviour exists today. The plan's choice is new: it gives up the one guard (bump, 409, auto backup) that would cover it during this rollout.
     - An old-build tab that mounts after a new-build save also hits the `{spec}` to `{ preset: 'invalid-card' }` loss (`src/lib/metrics/validate.ts` L247), not only a rollback.
   - **Fix:** name the stale-tab case in that section. Then either:
     - bump CONFIG_VERSION on the slices that add a stored-spec capability (slices 2-4), which brings back the 409 and the auto backup; or
     - accept the risk in so many words and log it in the decision log.

   Slice 1's rollback note ("An older build drops `fit`…") should also say that a stale tab drops `fit`, not only a rollback.

2. **SHOULD-FIX: the rate tile's inputs do not fully match.**
   - **Refutes:** ADR L207-211, "`metricsContextFor` carries the same three, so the inputs match. One difference: the card clamps…"
   - **Evidence:** there are three more differences.
     - **Bare-date day boundaries.**
       - `functions/api/popups.ts` L94-97, `untilMs = isDateOnly(until) ? Date.parse(until)+86_400_000 : …`, reads a bare date as a UTC day.
       - `src/lib/metrics/facts.ts` L169-171 (`etMidnightMs`, `addEtDays(until,1)`) reads it as an ET day.
       - Live filters are ISO instants (`defaultDateRange`, `ymdRangeToISO`), so only legacy bare-date filters diverge.
     - **Single-day bare range.**
       - `src/lib/metrics/pageContext.ts` L41-55 sets the range only when `a < b`.
       - When `since === until` as bare dates, no range is sent, and page-window items fail `'missing-range'` (`validate.ts` L373).
       - The tile still returns a number for the same input.
     - **"Hide my visits" can be dropped.**
       - `pageContext.ts` L58-63 sends the own-visit fields only if `safeUA(v) === v` for both the browser and the OS. Otherwise the card silently counts the user's own visits.
       - `/api/popups` gets the raw fields from `src/api.ts` L36-61.
   - **Fix:** list all three next to the clamp, and add parity-test cases for a bare-date range, `since === until`, and a browser string that `safeUA` rewrites.

3. **SHOULD-FIX: a converted tile loses its per-chart filter button.**
   - **Refutes:** the same "inputs match" bullet, and the Missing list (ADR L201-202), which names only the mapping and the editor change.
   - **Evidence:** `src/components/ChartCard.vue` L466 shows the filter button only when `!isBespokeBody`, and L32-34 counts any widget with a `card` as bespoke.
     - The card still honours a stored override, via `effectiveFilters = widget.filters ?? props.filters` (L248, used at L40-44).
     - Once the rate tile renders as a card, though, an existing override can no longer be seen, edited or cleared from its header.
   - **Fix:** add this to slice 4's Missing list. Either keep the filter button for mapped rate tiles or drop `widget.filters` during the mapping, and state which.

4. **SHOULD-FIX: the eligibility tile gains a caveat the plan doesn't list.**
   - **Refutes:** ADR L201, "Missing: nothing in the registry under the default". It names still-arriving, on the outcome tiles, as the only visible addition.
   - **Evidence:** `src/lib/metrics/metrics.ts` L389-425. The sign-in eligibility metrics carry `'signin-eligible-caveat'`, which the card will render. Today's tile shows only `data.note`, and only for the install gap (`popups.ts` L175-190).
   - **Fix:** list it under decision (b) display changes, or suppress it for the mapped tile. The parity test should assert whichever is chosen.

5. **SHOULD-FIX: a zero denominator displays differently.**
   - **Refutes:** ADR L200, "The card already shows "(n/d)" and "too few to report"". This implies the display states match.
   - **Evidence:**
     - The tile shows "too few to report" whenever `data.insufficientCohort` is set (`ChartCard.vue` L388-398), and its counts read `` `${numerator ?? 0}/${denominator}` ``, so "0/0".
     - The engine returns `status: d === 0 ? 'no-data' : g.insufficientCohort ? 'too-few' : …` (`src/lib/metrics/engine.ts` L726). So with d = 0 the card shows its no-data state, not "too few", and not "0/0".
   - **Fix:** the parity test should pin d = 0 and d = 1-4 for one key, and decision (b) should say which display wins.

6. **SHOULD-FIX: slice 5 must keep the stat tile's states.**
   - **Refutes:** ADR L229, "The data path is unchanged, so the numbers are identical by construction; a render test pins them."
   - **Evidence:** the states come from `ChartCard.vue`, not from the data.
     - L410-418: `isEmpty` counts the stat tile as empty on `rows.length`. So a stat tile shows "No data in range" when rows are empty even if the totals are nonzero.
     - L425-431: `popupNotYetActive` ("Tracking not yet active") applies to popup-dataset stat tiles.
     - Neither state lives in the data path. A `StatTile` shared with `MetricItem` could lose or change them.
   - **Fix:** list both states in slice 5's risks and add them to its render test.

7. **NIT: the inventory leaves out one blank-render path.**
   - **Evidence:** `src/lib/charts.ts` L817 returns null for `rateTable` (and for stat, table, map and rate), so a `rateTable` with no `card` passes the generic states and draws an empty body.
     - `migratePanelsV11` (`src/lib/defaults.ts` L1008-1012) runs on every load and puts the card back, so this can't happen in practice.
   - **Fix:** one sentence in the inventory saying the migration covers it.

Checked and correct (no finding):
- **Decision (b) tile list:**
  - 22 keys: 5 tap + 16 outcome (4 pop-ups × 4 outcomes) + 1 eligibility (`src/lib/popupEvents.ts` L1016-1028).
  - The lags match: signedIn [0,1], installed [0,7], returned [1,7], stillPlaying [14,21] (`metrics.ts` L165-169).
  - Every ratio exists, and installedRate uses alignDenominator (`src/lib/metrics/ratios.ts` L119-124).
  - The engine already marks provisional results and adds still-arriving (`engine.ts` L643-648 and L731).
- **"Already reusable" claims:** WorldMap, BaseChart, NoteBlock and the generic states are shared bodies dispatched without widget-specific branches.
- **Product rule:** nothing in the plan ties beacon rows to a device, time or place. The engine and sparkline read per-ET-day aggregate counts, the same grain as the date charts.

Inventory: 9 bodies found, 9 listed in the plan. They are card, retired-panel text, ads readings, note, stat, rate, table, map and Chart.js, at `ChartCard.vue` L535-578. The non-card `rateTable` blank path in finding 7 is not a separate body.

Slice 1 design affected: no. Finding 1 changes slice 1's rollback note (stale tabs drop `fit` too), not its design: `fit` added to the `normWidget` whitelist with no version bump still holds, since losing `fit` only resets sizing. It would change only if Mike picks the version-bump fix for finding 1, and even then the bump belongs to the slices that store new spec capabilities (2-4), not to slice 1.

## Fix round (writer's disposition)

All seven findings accepted; none disputed.

| # | Disposition |
|---|---|
| 1 | Took the version-bump fix as the default: slices 2, 3 and 4 each bump `CONFIG_VERSION` with no data migration, to get the 409 stale-tab refusal and the automatic KV backup; slice 1 does not. Decision 2 and "Saved layouts and rollback" rewritten, with the stale tab named as the likelier case and rollback now read-only rather than lossy. `feat/nav` holds v13; whichever lands second renumbers. Slice 1's note now names the stale tab. |
| 2 | The three extra input differences listed beside the clamp; each is a slice 4 parity case. |
| 3 | Added to slice 4's Missing list; default: keep the filter button for mapped rate tiles. |
| 4 | Listed under decision (b) as an all-tiles display difference; default: keep the caveat. |
| 5 | Listed under decision (b); default: the card's `no-data` wins for d = 0, d = 1-4 stays "too few to report"; parity test pins both. |
| 6 | Both states added to slice 5's section and its render test. |
| 7 | One sentence added under the inventory. |
