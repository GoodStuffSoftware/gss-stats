# Best Sudoku ad flight 3: cold-start handoff

For whoever builds and reads flight 3. This file points to the sources; it does not copy them.

## Status

PROPOSAL awaiting Mike on the BSK Decision Desk
(<https://claude.ai/artifact/VutC3bQKX4jLErr52o3cBv>, cards ads-f3-1..ads-f3-7). Update
2026-10-15: the launch plan is card ads-f3-16 (two arms, Apps and Search, each starting with its
own release landing). In gss-stats each arm is activated by its dates alone: its ids, tags, budget, cap and
read-plan settings are in code, and it joins the registry once `STAGED_FLIGHT_3_DATES` holds its
flight start and end (both arms: 2026-10-17..2026-10-23; Apps started ahead of the Play release). Its LEGS rows in the runbook
are `by-date`.
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

## Revised arms (Mike, 2026-10-15, desk card ads-f3-16): this overrides the build spec below

- **Search is a buyer-intent test.** Keywords: the "no ads" family only (sudoku no ads, sudoku
  without ads, sudoku app no ads, ad free sudoku and the rest), exact + phrase; flight 2's
  free-seeker terms are dropped. Max CPC **$0.99** (a hard ceiling under $1), ALL devices (the
  mobile and tablet hard stops and the gss-stats desktop-only anomaly flag are dropped).
  Negatives: flight 2's 10 plus free, online free, printable and puzzle book. Flight 2's RSA plus a
  price headline. Expected volume is about 15-25 clicks a week, so one week will likely read
  inconclusive (under 20 asks); the rules are unchanged.
- **Apps:** the same 17 placements, max CPC **$0.35**, flight 2 copy plus a price line ("No ads.
  Passes from $1.99").
- **Both arms:** $10/day, $70 cap. Search keeps its one utm tag. Apps runs two display ads,
  hero (`sudoku_funnel_f3_apps_hero`) and features (`sudoku_funnel_f3_apps_feat`), with the bare
  `sudoku_funnel_f3_apps` kept as a catch-all; every rule reads the three tags as one arm's total.
  The reports also print a per-tag split (arrivals, completes, sign-in asks, new accounts, and
  ad-level cost per arrival from the ads' `final_urls`, "—" under 5 arrivals), counts only. Set
  each ad's final URL with its own `utm_campaign` at build; an ad with no usable tag shows as
  "untagged" in the split, never on a tag.
- **Cost per arrival:** the tagged-funnel block of the threshold and post-flight reads prints
  cumulative spend / tagged arrivals with the arm's benchmark beside it (Apps about $0.32-0.34, the
  F1/F2 in-app figure; Search about $0.64, the F2 Search figure); the figure reads "—" under 5 tagged
  arrivals (the small-sample gate).
- **Day 1-2 tracking check:** a read-and-judge line in the runbook ("Flight 3"), never coded; it
  replaces rule 3 for this flight and only proposes a pause.

## Recommended flight 3 (if Mike picks option A on ads-f3-1; superseded where the revised arms above differ)

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

- (Superseded: see the revised arms above for bid, keywords and devices.) Name "Best Sudoku - Search - Desktop intent - F3 Search"; utm_campaign `sudoku_funnel_f3_search`, medium `cpc`.
- $10/day standard budget; Manual CPC $0.99 max (revised; was $0.60).
- Revised: the "no ads" keyword family only, exact + phrase (flight 2's free-seeker terms dropped); flight 2's 10 negatives plus free, online free, printable and puzzle book (the earlier nytimes, nyt, easybrain, juego additions are not in the revised list).
- ALL devices (revised: no mobile or tablet hard stop); US+CA Presence; English; 12:00-24:00 ET (changed from 12:00-23:00 once flight 3 was live).
- Fixed window Sunday 00:00 to Saturday 23:59:59 ET; end date set at create and again at enable.
- AI Max off, Search partners off, Display expansion off, auto assets opted out.
- No day-3 bid rule (retired).
- Revised: flight 2's RSA plus the price headline ('No ads. Passes from $1.99', verify that Play
  prices match); the buyer-intent keywords above replace flight 2's terms.

### Read plan (register once approved)

- Cap $70; thresholds 18/35/53/70; ctrFloor per arm (Apps 0.0015, Search 0.01, as flight 2); the Apps device check stays, and Search (all devices) has no desktop-only anomaly flag.
- Primary measure: tagged `/auth/success/<provider>/new` rows (count, capped at Firestore new accounts).
- Validity: at least 20 tagged post-game ask rows.
- Go: 5 or more new accounts within $70. Iterate: 2 to 4. Stop paid acquisition: 0 to 1 with 20 or more asks.
- Traffic-held check: complete rows at $3 or less each and CTR at or above the arm's flight 2 floor (Apps 0.15%, Search 1.0%).
- Kill rules only propose; Mike pauses.
- gss-stats edits LANDED in 0.35.0 (tolerant, ahead of the client ship; names still provisional per
  best-sudoku signin-ask-buyer-intent.md section 7.4 @ ffc46239): /signin-prompt/committed-repeat and
  /signin-prompt/committed-challenge are in ASK_PATHS; kill rule 3's first-session mode is retired in
  favour of NOT COMPUTABLE (no-data) when no ask is known; old and new popup-outcome / signin-eligible
  shapes parse together, A/B twins are excluded, new funnel / in-app rows are counted. Read the install-prompt
  effect across all traffic over weeks, not inside the 30-minute tag.

## Where to register

Registered by date. The ids are in code already; the only edit is each arm's two dates, with the
manual steps listed in [docs/routines/ads-cloud-daily.md](../routines/ads-cloud-daily.md), "To activate flight 3":

- `src/lib/campaigns.ts`: `STAGED_FLIGHT_3_DATES.<arm>` `flightStart` and `flightEnd` (both arms are
  filled, 2026-10-17..2026-10-23). Filling both registers the arm and its read plan.
- A `by-date` row in the Legs table of the runbook, with the same two dates (a test fails if they
  differ). Its post-flight reads (wrapup on flight end + 7, day15 on flight end + 15) are derived.
- Not driven by a date: the D + 7 07:05 ET final read, the D + 21 and D + 35 purchase reads, and
  enabling the campaign in Google Ads.

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
