# gss-stats

Bot-free traffic dashboard for **Good Stuff Software**. A custom UI on top of
Cloudflare's **RUM** (Real User Monitoring) data — the same human-only dataset that
powers Web Analytics — plus a companion **geo beacon** for the sub-country geography
RUM doesn't provide, rendered as a movable/composable dashboard you control.

🔒 Live at **https://stats.goodstuff.software** — behind Cloudflare Access (owner-only).

The API token stays server-side (in a Pages Function); it never reaches the browser.

## Quick start

```powershell
npm install
# one-time: create the local secret from your Cloudflare analytics token
"CF_ANALYTICS_TOKEN=<your-token>" | Out-File .dev.vars -Encoding ascii -NoNewline

npm run preview     # build + wrangler pages dev (Functions + KV + D1 simulated) on :8788
# or
npm run dev         # Vite only (UI iteration; /api/* not served)

npm test            # vitest — pure-logic unit tests (day bucketing, rate math, campaign attribution, …)
npm run typecheck   # tsc --noEmit over src/**/*.ts + functions/**/*.ts (not .vue — no vue-tsc yet)
```

`.dev.vars` is gitignored. See [`.dev.vars.example`](.dev.vars.example).

## Stack

| Layer | Choice |
|---|---|
| UI | Vue 3 + Vite |
| Charts | Chart.js + custom plugins |
| Layout | grid-layout-plus (movable/resizable widgets) |
| Backend | Cloudflare Pages Functions (`functions/api/*.ts`) |
| RUM data | Cloudflare GraphQL Analytics API (`rumPageloadEventsAdaptiveGroups`) |
| Geo data | Cloudflare D1 (shared with [gss-beacon](https://github.com/GoodStuffSoftware/gss-beacon)) |
| Config store | Cloudflare KV (`STATS_CONFIG`) |
| Ads store | Cloudflare D1 `gss-stats-ads` (gss-stats' own: Google Ads spend, readings log, threshold state) |
| Auth | Cloudflare Access (Zero Trust), owner-only |

## Features

- **"Best Sudoku overview"** — the landing page: today-at-a-glance KPI tiles (vs the same
  time yesterday and the 7-day average), a daily timeline since the first hit overlaid with
  campaign flights / release / tracking-activation markers, a campaign scorecard, and a
  release before/after panel. See
  [`src/lib/overview.ts`](src/lib/overview.ts) and
  [`src/lib/releases.ts`](src/lib/releases.ts) (hand-entered release dates — `hits` has no
  app-version column).
- **Movable / composable charts** — drag the header, resize from the corner; add /
  edit / duplicate / delete charts of any type: stat, bar, horizontal bar, stacked
  bar, line, area, doughnut, nested doughnut, pie, table, and a geo point map.
- **Durable, multi-page dashboards** — layout + chart definitions persist in KV (not
  `localStorage`), so they follow you across devices. Duplicate / rename / delete
  pages; a protected default page with "restore default charts"; per-page filters and
  per-chart filter overrides.
- **Auto-built site filter** — a single multi-select of your sites and subdomains,
  built live from the data. It merges each site's RUM host and beacon tag into one
  entry, groups subdomains under their site, folds **alias hosts** (an HTTP redirect
  or a `rel="canonical"` pointing elsewhere) into their canonical site, and excludes
  dev/preview hosts from both the picker and the numbers.
- **Click-to-drill-down** — click any chart value to open a new page filtered to it
  (device, referrer, location, browser, …), titled by the value; drill-downs stack.
- **Exclusions** (global across pages) — hide self-referrals, hide your own visits by
  browser+OS, and an **"exclude this device"** opt-out that works on every site (see
  [gss-beacon](https://github.com/GoodStuffSoftware/gss-beacon)).
- **Smart date range** — type spans like `7d` / `24h` / `2w` / `last 3d`, or pick
  exact dates.
- **Geo beacon dataset** — region / city / ISP / new-vs-returning and a visitor map,
  from the beacon (RUM geography is country-only).
- **Pop-up tracking** — a dedicated Best Sudoku page for the sign-in prompt, first-50 promo,
  upsell and install pop-ups: shown/accepted/dismissed counts, tap rates, outcome rates,
  the sign-in eligibility rate and install's real-outcome counts, bucketed by US-Eastern day.
  See [`src/lib/popupEvents.ts`](src/lib/popupEvents.ts) for the one place every pop-up path
  pattern is defined, matching the Best Sudoku team's final beacon path list (2026-09-25):
  - Upsell reasons are exactly `cadence` / `limit` / `daily-locked` / `upgrade-tap`; any
    other reason (e.g. the retired `settings-upgrade`) is counted under "other", never
    dropped.
  - Outcome types are `signed-in` / `installed` / `returned` / `still-playing` (new — days
    14-21 after shown), one MIN_COHORT-gated rate per pop-up × outcome.
  - `/popup-outcome/<popup>/…`'s wire vocabulary is `signin-prompt` / `promo-first50` /
    `upsell` / `install-prompt` — `install-prompt` maps to the `install` family internally
    (`POPUP_OUTCOME_NAME_TO_FAMILY`).
  - `first50-congrats` has no outcome beacon at all — its charts carry a one-time "no
    outcome tracking" note instead of an outcome-rate row or a "not instrumented"
    placeholder.
  - `/signin-eligible` (the sign-in denominator) is deferred at least 30 minutes after the
    finish, so its row time is not the finish time — every chart of it carries that caveat,
    and it's never used to bucket by hour of day (see `SIGNIN_ELIGIBLE_CAVEAT`). The pop-ups
    page also carries a standing note (`POPUP_PAGE_NOTE`): "Outcomes and return visits may
    arrive up to 30 minutes late; a small number are lost." (after a sign-in the app holds
    outcome, eligibility and return beacons for 30 minutes and sends them on a later
    navigation).
  - **Known gap, install outcomes:** prompt-driven installs don't record an install outcome
    yet (fix pending in Best Sudoku). While `INSTALL_ACCEPT_OUTCOME_FIXED_ET` is unset, the
    install-prompt "installed" rate, the `pwa-installed` count and the campaign funnel's
    Install step carry a "known gap" label; set it to the fix's ET release date to clear it.

  A configurable **tracking activation date** (`TRACKING_ACTIVATION_DATE_ET`, set to
  2026-09-26 — v1.95.3's confirmed production WEB release, 14:31 UTC) keeps pre-release
  data from reading as a baseline: every rate and every pop-up count widget (other than the
  trend line, which plots full history with a "tracking starts" marker) is gated to that
  date, so a real pre-release denominator (e.g. the 2026-09-19 uncapped-placement-bug
  reproduction) can only ever render "—", never a misleading 0%.

  A **separate Play/Android tracking config** (`PLAY_TRACKING_ACTIVATION_DATE_ET`, in the
  same file) tracks the Android build independently — it's on its own, later release
  schedule. v1.95.3 was *submitted* to the Play production track 2026-09-26, but a
  submission is a review-then-staged-rollout process, not a single ship date, so this
  constant is treated as a RAMP rather than a hard step: it draws its own chart marker
  ("Play: submitted 26 Sep, reaching devices from review onward") and a rollout caveat next
  to any bestsudoku-app `/return` or Play-referrer figure, but — unlike the web date — it
  never grays out or "unmeasures" days after it, since a low count right after submission
  is the expected shape of a staged rollout, not a tracking gap.

  Because production has only 14 registered users (2026-09-26), every rate-bearing page
  (pop-ups, campaigns, overview) also carries a standing **small-sample note** ("Very small
  numbers: rates are anecdotal. Always read the counts.") and every computed rate shows its
  underlying numerator/denominator next to the percentage — MIN_COHORT (5) still blocks any
  rate computed from too small a denominator outright; the note covers everything above
  that floor, which is still a small population.
- **Campaign comparison** — a bespoke "Best Sudoku campaigns" page (not the generic
  chart-grid model) compares the three Google Ads campaigns configured in
  [`src/lib/campaigns.ts`](src/lib/campaigns.ts): a funnel per campaign, arrivals by ET
  hour of day, arrivals/funnel by country, daily + cumulative arrivals aligned by flight
  day, cost per arrival/auth success (spend read from the Google Ads API figures the ads
  routine stores, falling back to the hand-entered `CAMPAIGN_SPEND`), device mix, an
  on-device return-visit retention curve, and the ads routine's **readings log**. The
  funnel's Install step counts `/popup-outcome/install-prompt/installed` (once per showing);
  raw `/install/*` outcome beacons, which can double-count one install, are shown only as a
  secondary "raw install signals" line. Attribution is by the beacon's own
  campaign tag only, with no date-based split — one swappable function decides row
  membership, and known verification/household traffic is excluded server-side. One
  campaign (Play-direct) sends its ads straight to the Play Store and so has no beacon rows
  at all; it's shown spend-only rather than an empty funnel.
- **Locked down** — Cloudflare Access gates the dashboard; an expired session shows a
  one-tap re-sign-in banner instead of a wall of errors.
- Light / dark theme matching the Good Stuff Software brand.

## Architecture

```
Browser (Vue 3 + Chart.js + grid-layout-plus)
   │  POST /api/stats   POST /api/geo   GET /api/sites   GET/PUT /api/config
   ▼
Cloudflare Pages Functions  (functions/api/*.ts)
   │  - hold CF_ANALYTICS_TOKEN (secret) — never sent to the browser
   │  - /api/stats  → RUM GraphQL (server-side), requestHost allow-list
   │  - /api/geo    → reads the beacon's D1 (bot-free sub-country geo)
   │  - /api/popups → pop-up funnel counts/rates from the same D1 (sign-in, upsell, install, …)
   │  - /api/campaigns → Google Ads campaign comparison from the same D1 (funnel, hour-of-day,
   │                      country, daily/cumulative, device mix, return visits)
   │  - /api/overview → today-at-a-glance KPIs, daily timeline, campaign scorecard, release panel
   │  - /api/ads/readings → the ads routine's readings log + stored spend (D1 gss-stats-ads)
   │  - /api/sites  → auto-builds the merged site list (RUM + beacon, aliases folded)
   │  - /api/config → dashboard layout in KV
   ▼
Cloudflare GraphQL Analytics API  ·  D1 (gss-geo, read-only)  ·  D1 (gss-stats-ads)  ·  KV (STATS_CONFIG)
```

- **Two datasets, one dashboard.** RUM (sampled, human-only) and the beacon (every
  real load, sub-country geo) are charted side by side; they're independent and never
  summed.
- **Dev/preview never counts.** Every query filters to an allow-list of *real* hosts
  (via RUM `requestHost_in`), so `dev*` / `staging` / `*.pages.dev` traffic is out of
  the numbers, not just hidden from the picker.

## Data & dimensions

RUM whitelisted dimensions (server-side): `requestHost`, `requestPath`, `deviceType`,
`countryName`, `refererHost`, `userAgentBrowser`, `userAgentOS`, `date`. **RUM
geography is country-only** — sub-country region/city comes from the beacon.

**Pop-up event beacons never count as page views.** Paths under `/signin-prompt`,
`/signin-eligible`, `/promo-first50`, `/first50-congrats`, `/upsell`, `/install`,
`/popup-outcome` and `/return` are pop-up interaction events, not screens — `/api/geo` and
`/api/sites` exclude all 8 prefixes from every pageview/visit total and the top-pages
breakdown (see [`src/lib/popupEvents.ts`](src/lib/popupEvents.ts) `POPUP_EVENT_PREFIXES`);
`/api/popups` is where they're counted.

**Campaign attribution is uc-only.** A row belongs to a Google Ads campaign only by its own
`campaign` column value (D1's actual column name for what the ad tags as `utm_campaign`) —
never by matching location/device/timestamp across different rows. See
[`src/lib/campaigns.ts`](src/lib/campaigns.ts) `campaignAttributionClause` — the one
function that decides row membership — plus its `EXCLUSIONS` (known verification and
household traffic) and `classifyFunnelPath` (which paths count as which funnel step).

**"Hide my own visits"** excludes the owner's browser+OS *combination* server-side
(De Morgan `OR: [browser_neq, os_neq]`, so e.g. Chrome/Windows isn't dropped). RUM
exposes no client IP or visitor ID, so a UA combo is the only self-exclusion proxy on
that dataset; the beacon adds a precise per-device/per-network opt-out.

## Ads-read routines (Best Sudoku)

Node tooling in [`scripts/ads-reads/`](scripts/ads-reads/) that the scheduled routines in
[`docs/routines/`](docs/routines/) run from this checkout. It **proposes only** — it can't
change a campaign (the Google Ads client can only run GAQL `SELECT`s). The rules, thresholds,
exclusions, MIN_COHORT and ET-day logic are the same `src/lib` code the dashboard uses
([`src/lib/adsRules.ts`](src/lib/adsRules.ts) on top of `campaigns.ts` / `popupEvents.ts`), so
the routine and the dashboard can't disagree.

```powershell
npm run ads:morning-read -- --dry-run --cf-token-file <path-to-cf-token>   # daily read; no writes
npm run ads:postflight-read -- --stage wrapup --dry-run --cf-token-file <path>
npm run ads:backfill -- --dry-run --cf-token-file <path>                   # idempotent spend backfill
npm run ads:morning-read -- --fixture <file.json> --now <iso>              # offline, recorded data
npm run typecheck:scripts
```

- **Spend** comes from the Google Ads REST API only (customer 8726535246, no manager
  header). Credentials are read from Bitwarden Secrets Manager with `bws` (needs
  `BWS_ACCESS_TOKEN`) into process memory and are never printed, logged or written.
- **Beacon reads** use `wrangler d1 execute gss-geo --remote --json --command`: single
  `SELECT`s only, enforced before wrangler runs.
- **Store:** gss-stats' own D1 database `gss-stats-ads` (spend per day, placement-day cost,
  an append-only readings log and fire-once threshold state). Why and how:
  [docs/adr/0001-ads-read-store.md](docs/adr/0001-ads-read-store.md). Schema:
  [`migrations/gss-stats-ads/`](migrations/gss-stats-ads/) (`npm run ads:migrate`).
- **morning-read** stores yesterday's and cumulative spend, fires each $25/$50/$75/$100 read
  once (full read + kill rules), always appends a daily line, checks the hard cap on every
  read, and notes any earlier scheduled read that never ran. The release-health check (a
  missing child of a non-zero parent) never runs between 01:00 and 12:00 ET, so the 08:00
  run skips it and a 23:15 ET `--release-health-only` backstop covers it on days that served
  ads. Pushes go out only on a threshold read, a kill-rule trip, a failed read, or a real
  release-health alert (parent at least MIN_COHORT, outcome window elapsed, child zero).
- **postflight-read** covers the wrap-up (spend end + 7 days) and the day-15/30/60 and
  December follow-ups, split promo vs non-promo, with the d31-60 return buckets.
- `--firebase-sa <service-account.json>` adds read-only Firestore COUNT queries (new
  accounts and first-50 claims in the flight window, plus `promos/first50` status).

## Docs

| Area | Entry point |
|---|---|
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Contributing / conventions | [CLAUDE.md](CLAUDE.md) |
| Ads store decision | [docs/adr/0001-ads-read-store.md](docs/adr/0001-ads-read-store.md) |
| Ads routine prompts | [docs/routines/](docs/routines/) |
| Geo beacon (companion) | [GoodStuffSoftware/gss-beacon](https://github.com/GoodStuffSoftware/gss-beacon) |

## Deploy

**On merge to `main`** — GitHub Actions ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml))
builds and publishes to Cloudflare Pages automatically, on GitHub's runners (nothing local).
One-time setup: add a repo secret **`CLOUDFLARE_API_TOKEN`** (Settings → Secrets and variables
→ Actions) — a Cloudflare token with **Cloudflare Pages: Edit**. The runtime `CF_ANALYTICS_TOKEN`
is a Pages *project* secret and isn't needed by the workflow (deploys keep existing secrets).

**Manual** (local fallback / preview), with the token from a local, gitignored file:

```powershell
$env:CLOUDFLARE_API_TOKEN = (Get-Content "<path>\cf-token.txt" -Raw).Trim()
npm run deploy      # = vite build && wrangler pages deploy
```

Single Cloudflare account — no account-ID env needed. Pages project: **gss-stats**.

## Security / hardening

- **Access lockdown.** Cloudflare Access (Zero Trust) gates both
  `stats.goodstuff.software` and the `*.pages.dev` URL, allowing only the owner's
  email(s). A `functions/_middleware.ts` host-guard 404s any non-canonical host as a
  backstop.
- **Token hygiene.** The real token lives only in a gitignored `.dev.vars` (local) and
  a Cloudflare Pages secret (production) — never in the repo. Follow-up: mint a
  least-privilege token with only "Account Analytics Read" and set it as the
  `CF_ANALYTICS_TOKEN` secret.
- **Sign-in.** Access uses One-Time PIN (email codes) by default; a Google IdP can be
  added in Zero Trust without code changes.

## Branch

`main` — the deployed line.
