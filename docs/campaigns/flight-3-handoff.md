# Best Sudoku ad flight 3: cold-start handoff

For whoever builds and reads flight 3. This file points to the sources; it does not copy them.

## Status

PROPOSAL awaiting Mike on the BSK Decision Desk
(<https://claude.ai/artifact/VutC3bQKX4jLErr52o3cBv>, cards ads-f3-1..ads-f3-7). Update
2026-10-15: the launch plan is card ads-f3-16 (two arms, Apps and Search, each starting with its
own release landing). Flight 3 is STAGED in gss-stats: its tags, budget, cap and read-plan
settings are in code but not in the registry, and its LEGS rows in the runbook are `staged`.
The read plan, rules, checks and the activation steps are in
[docs/routines/ads-cloud-daily.md](../routines/ads-cloud-daily.md), "Flight 3"; the section
below is the earlier recommendation and is superseded by it where they differ. Nothing is
enabled in Google Ads without Mike's yes.

2026-10-11, Mike's direction: remove the sign-in ask after the tutorial, and tune the sign-in ask
and the app-install popups, so that sign-ins come from players likely to purchase eventually (not
people who want something for nothing). This is precondition P1 and needs a BSK builder.

Decision cards (state 2026-10-11 evening; ads-f3-1 and 2 are in the artifact):

- ads-f3-1: reopened. Recommend $0 until signin-p1 is live; ads-f3-9 is closed and the 10-17 re-read is done.
- ads-f3-2: reopened. The in-app data is real; hold Apps until the mobile tour fix, rather than retire.
- ads-f3-3: open, waiting on keyword data. Price in the ad + buyer-intent exact terms (sudoku app no ads,
  ad free sudoku app, premium sudoku, sudoku pro); no "cheap" terms.
- ads-f3-4: open.
- ads-f3-5: closed (superseded by signin-p1-1).
- ads-f3-6: closed, answered a (keep the 14-day trial). Mike's "is the long trial helping or hurting"
  is carried as an open measure.
- ads-f3-7: open. First-50: keep the engaged bar, reward a founding price instead of 60 free days (recommended).
- ads-f3-8: Basic API access how-to (Cloud Console path, brand verification, review in minutes).
- ads-f3-9: six measurement gaps.
- ads-f3-10: read-only Stripe key.

Sources:

- Full analysis and plan: <https://claude.ai/artifact/5ndcrub2p1EuhY8Gb7UUH7>
- Flight 2 final read: <https://claude.ai/artifact/5ycWhXvNtUtEbfqLFXexF9>
- Flight 1: <https://claude.ai/artifact/MWeDd1o525czFMkNqWzJwL>
- Flight 2 build and rules: best-sudoku repo `docs/marketing/google-ads/HANDOFF-flight-2-api.md`
  (sections 2, 7, 8). The write tool is `flight2-write.mjs` in best-sudoku
  `docs/marketing/google-ads/api/`.

## Data pull 2026-10-11 (evening)

Counts, read-only. Raw pulls live in the analyst session scratchpad only (not committed); report v5
(<https://claude.ai/artifact/5ndcrub2p1EuhY8Gb7UUH7>) has the summary.

- Search: next-day returns 1 of 87 arrivals (Apps 13 of 204, F1 22 of 271, unpaid 4 of 48). 38 of 53
  Search completes came on 10-09. Re-read the 2-to-7-day window on 10-17 and the 8-to-14-day on 10-24.
- The 10-09/10-10 Search jump had no change behind it (change_event shows nothing after the 10-04 00:27
  enable). Rank-lost impression share fell 90% to 45% to 30%; budget-lost rose 0% to 53% to 68%; the
  query 'sudoku' went from 7 to 32 to 27 clicks.
- In-app Display data is real: the tag-strip bug was fixed 2026-09-01 (v1.86.6, best-sudoku
  src/services/analyticsBeacon.ts:196-208). About 30% of clicks never load the page, about 3% lose the
  tag, 66% are counted. The loss is inside the mobile tour (294 starts, 2 completes, 17 skips).
- Money: 0 purchases ever (Stripe 0 charges, 7 expired checkout sessions; Play 3 tester purchases).
  5 trials started, 4 ended, 0 bought, none a real test. First-50 4 of 50.
- Beacon gaps: no trial, paywall, checkout or purchase paths; sign-in outcomes carry no ask reason; the
  30-minute tag (analyticsBeacon.ts:101) misses later visits.

## Flight 2 verdict

- Apps (in-app Display, 24316608605) fail: $69.94, 2 game-complete rows, first move 6.4% of arrivals.
- Search (desktop, 24311309184) wins on the row proxy: $55.90, 53 complete rows (about $1.05
  each vs $34.97), but 57 sign-in asks led to 1 auth success.
- The funnel breaks at the sign-in ask, which fires in the tutorial.

## Recommended flight 3 (if Mike picks option A on ads-f3-1)

Preconditions:

- P1: BSK ships the sign-in ask after the first completed real game, live on prod web, with its
  own counter path.
  - Part of P1 (Mike, 2026-10-11: handle it with the changes, not as a separate task). The agent
    making the P1 sign-in/monetization changes in best-sudoku also corrects two stale texts to
    match what P1 ships: (1) docs/specs/monetization.md says a 30-day trial at $1.50/$12.99, but
    the code has a 14-day trial (functions/src/trial-constants.ts:20) and passes at $1.99/30 days,
    $9.99/180 days and $14.99/365 days (src/composables/useBilling.ts:90-106); verify the real
    amounts in Stripe and Play. (2) functions/src/email/welcomeTemplates.ts:84 says puzzles need no
    pass, but expired users get 1 puzzle a day (src/composables/useAccess.ts). The final trial and
    first-50 terms depend on ads-f3-6 and ads-f3-7.
- P2: gss-stats confirms the post-game ask and its outcome fall inside the 30-minute campaign
  utm tag, or a session-scoped first-party tag lifetime covers them (no visitor id, no device
  signature).
- P3: register the campaign and read plan, deploy, verify the live version.
- P4: Mike approves the create from a dry run; the campaign is created PAUSED.

### Build spec (diff from F2 Search)

- Name "Best Sudoku - Search - Desktop intent - F3 Search"; utm_campaign `sudoku_funnel_f3_search`, medium `cpc`.
- $10/day standard budget; Manual CPC $0.60.
- Same 12 keywords and 10 negatives, plus 4 negatives: nytimes, nyt, easybrain, juego.
- Mobile and tablet -100% hard stops; US+CA Presence; English; 12:00-23:00 ET.
- Fixed window Sunday 00:00 to Saturday 23:59:59 ET; end date set at create and again at enable.
- AI Max off, Search partners off, Display expansion off, auto assets opted out.
- No day-3 bid rule (retired).
- Ad copy and keywords depend on ads-f3-3. If option a: add a price headline ('No ads. Passes from
  $1.99', verify that Play prices match) and the 4 buyer-intent exact terms.

### Read plan (register once approved)

- Cap $70; thresholds 18/35/53/70; ctrFloor 0.01; device anomaly on.
- Primary measure: tagged `/auth/success/<provider>/new` rows (count, capped at Firestore new accounts).
- Validity: at least 20 tagged post-game ask rows.
- Go: 5 or more new accounts within $70. Iterate: 2 to 4. Stop paid acquisition: 0 to 1 with 20 or more asks.
- Traffic-held check: complete rows at $3 or less each and CTR at 1% or more.
- Kill rules only propose; Mike pauses.
- gss-stats edits LANDED in 0.35.0 (tolerant, ahead of the client ship; names still provisional per
  best-sudoku signin-ask-buyer-intent.md section 7.4 @ ffc46239): /signin-prompt/committed-repeat and
  /signin-prompt/committed-challenge are in ASK_PATHS; kill rule 3's first-session mode is retired in
  favour of NOT COMPUTABLE (no-data) when no ask is known; old and new popup-outcome / signin-eligible
  shapes parse together, A/B twins are excluded, new funnel / in-app rows are counted. Read the install-prompt
  effect across all traffic over weeks, not inside the 30-minute tag.

## Where to register

Staged now; the steps to activate (id and dates only) are in
[docs/routines/ads-cloud-daily.md](../routines/ads-cloud-daily.md), "To activate flight 3":

- `src/lib/campaigns.ts`: `STAGED_FLIGHT_3` (done), then a `stagedCampaign(...)` entry in `CAMPAIGNS`.
- `src/lib/adsRules.ts`: `STAGED_FLIGHT_3_PLAN_SETTINGS` (done), then a `stagedReadPlan(...)` entry in `ADS_READ_PLANS`.
- A `staged` row in the Legs table of the runbook (done), flipped to `live` (the daily routine
  runs at 08:37 ET with no end date).

## Hard rules

- Read-only on Google Ads until Mike's go.
- Standing verdicts: Maximize Conversions REJECT; conversion tracking REJECT PERMANENTLY;
  Customer Match REJECT; Optimized targeting REJECT.
- No ad trackers. Counts are beacon ROW counts with no visitor join.
- Mike's household IP is excluded, so no beacon test rows come from his network.
- Do not touch closed campaigns 24215315197, 24234347705, 24279250691.

## Known data gaps

- No reads for 10-07 and 10-08.
- No search-term report after 10-09.
- No per-placement spend.
- The Search volume jump on 10-09 and 10-10 ($20.00 and $20.60 on a $10 budget, 69 of 95
  clicks) is unexplained, and no change is logged.
- Keyword Planner volumes are unavailable through the API: the developer token is Explorer-level
  (403 DEVELOPER_TOKEN_NOT_APPROVED, 2026-10-11). Use the Ads UI Keyword Planner or apply for Basic
  access.
