# Best Sudoku ad flight 3: cold-start handoff

For whoever builds and reads flight 3. This file points to the sources; it does not copy them.

## Status

PROPOSAL awaiting Mike on the BSK Decision Desk
(<https://claude.ai/artifact/VutC3bQKX4jLErr52o3cBv>, cards ads-f3-1..ads-f3-7). Nothing is
built. Do not register flight 3 in `src/lib/campaigns.ts` or `src/lib/adsRules.ts` until Mike
approves.

2026-10-11, Mike's direction: remove the sign-in ask after the tutorial, and tune the sign-in ask
and the app-install popups, so that sign-ins come from players likely to purchase eventually (not
people who want something for nothing). This is precondition P1 and needs a BSK builder.

Decision cards ads-f3-1..7 (ads-f3-1 and 2 are in the artifact):

- ads-f3-3: price in the ad + buyer-intent exact terms (sudoku app no ads, ad free sudoku app,
  premium sudoku, sudoku pro); no "cheap" terms.
- ads-f3-5: sign-in ask after game 1 vs game 2.
- ads-f3-6: keep the 14-day trial through flight 3 (recommended).
- ads-f3-7: first-50: keep the engaged bar, reward a founding price instead of 60 free days
  (recommended).

Sources:

- Full analysis and plan: <https://claude.ai/artifact/5ndcrub2p1EuhY8Gb7UUH7>
- Flight 2 final read: <https://claude.ai/artifact/5ycWhXvNtUtEbfqLFXexF9>
- Flight 1: <https://claude.ai/artifact/MWeDd1o525czFMkNqWzJwL>
- Flight 2 build and rules: best-sudoku repo `docs/marketing/google-ads/HANDOFF-flight-2-api.md`
  (sections 2, 7, 8). The write tool is `flight2-write.mjs` in best-sudoku
  `docs/marketing/google-ads/api/`.

## Flight 2 verdict

- Apps (in-app Display, 24316608605) fail: $69.94, 2 game-complete rows, first move 6.4% of arrivals.
- Search (desktop, 24311309184) wins on the row proxy: $55.90, 53 complete rows (about $1.05
  each vs $34.97), but 57 sign-in asks led to 1 auth success.
- The funnel breaks at the sign-in ask, which fires in the tutorial.

## Recommended flight 3 (if Mike picks option A on ads-f3-1)

Preconditions:

- P1: BSK ships the sign-in ask after the first completed real game, live on prod web, with its
  own counter path.
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

## Where to register

- `src/lib/campaigns.ts` entry.
- `src/lib/adsRules.ts` read plan.
- A live row in the Legs table of [docs/routines/ads-cloud-daily.md](../routines/ads-cloud-daily.md)
  (the daily routine runs at 08:37 ET with no end date).

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
