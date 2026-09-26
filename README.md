# gss-stats

Bot-free traffic dashboard for **Good Stuff Software**. A custom UI on top of
Cloudflare's **RUM** (Real User Monitoring) data — the same human-only dataset that
powers Web Analytics — plus a companion **geo beacon** for the sub-country geography
RUM doesn't provide, rendered as a movable/composable dashboard you control.

🔒 Live at **https://stats.goodstuff.software** — owner-only, behind Google sign-in (see [Auth](#auth)).

The API token stays server-side (in a Pages Function); it never reaches the browser.

## Quick start

```powershell
npm install
# one-time: create .dev.vars, then put your Cloudflare analytics token in it. The
# example turns on the local-only sign-in bypass (see Auth → Local development).
Copy-Item .dev.vars.example .dev.vars

npm run preview     # build + wrangler pages dev (Functions + KV + D1 simulated) on :8788
# or
npm run dev         # Vite only (UI iteration; /api/* not served)

npm test            # vitest — the sign-in gate (see Auth → Tests) plus pure-logic unit tests (day bucketing, rate math, campaign attribution, …)
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
| Auth | Google sign-in (OAuth 2.0 / OIDC) in the Pages middleware, email allowlist |

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
  - **Install outcomes, fixed in Best Sudoku v1.95.4:** before the fix, prompt-driven installs
    recorded no install outcome. `INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS` (2026-09-26 16:26:36
    UTC, the first confirmed post-fix instant) splits every install count row-exactly: earlier
    `/popup-outcome/install-prompt/installed` and `/install/pwa-installed` rows are unmeasured
    ("known gap before fix"), later ones are measured normally, and a range that spans the fix
    carries an "install fix went live 26 Sep 12:26 ET" note. The installed rate compares
    post-fix outcomes with post-fix showings.

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
- **Locked down** — Google sign-in with an email allowlist gates every page and API
  call; the header shows who is signed in with a **Sign out** button, and an expired
  session shows a one-tap re-sign-in banner instead of a wall of errors.
- Light / dark theme matching the Good Stuff Software brand.

## Architecture

```
Browser (Vue 3 + Chart.js + grid-layout-plus)
   │  POST /api/stats   POST /api/geo   GET /api/sites   GET/PUT /api/config
   ▼
Cloudflare Pages Functions  (functions/_middleware.ts → functions/api/*.ts)
   │  - _middleware: host guard, then Google sign-in gate on every request (see Auth)
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
- **postflight-read** covers the wrap-up (flight end + 7 days; spend after the flight and the cap are checked first on every run) and the day-15/30/60 and
  December follow-ups, split promo vs non-promo, with the d31-60 return buckets. Day 15/30/60
  add the flight-window account cohort by access tier and promo marker (sitewide, not
  campaign-attributed; it needs Firestore composite indexes that don't exist yet, so it
  reports "tier split unavailable: index missing" until an owner creates them).
- **Sign-ups are an upper bound** everywhere ("at most N campaign sign-ups" =
  min(tagged auth successes, new accounts sitewide in the window)): `/auth/success` also fires
  for returning sign-ins. A pause is never proposed for a campaign that isn't serving (after
  its end date it reads ENABLED/ENDED); it's reported as ended instead.
- `--firebase-sa <service-account.json>` adds Firestore COUNT queries (new accounts and
  first-50 claims in the flight window, `promos/first50` status, the cohort split). The code
  can only make COUNT queries and one document GET, but the prod key on this machine is not
  a read-only key (it holds `roles/editor`); pointing this flag at a key with only
  `roles/datastore.viewer` is an owner step.

## Docs

| Area | Entry point |
|---|---|
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Contributing / conventions | [CLAUDE.md](CLAUDE.md) |
| Auth design (ADR) | [docs/adr/0002-google-auth.md](docs/adr/0002-google-auth.md) |
| Ads store decision | [docs/adr/0001-ads-read-store.md](docs/adr/0001-ads-read-store.md) |
| Ads routine prompts | [docs/routines/](docs/routines/) |
| Geo beacon (companion) | [GoodStuffSoftware/gss-beacon](https://github.com/GoodStuffSoftware/gss-beacon) |

## Deploy

**On merge to `main`** — GitHub Actions ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml))
runs the tests (`npm test`), then builds and publishes to Cloudflare Pages automatically, on
GitHub's runners (nothing local); a red test stops the deploy. Pull requests run the same
tests and build ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
One-time setup: add a repo secret **`CLOUDFLARE_API_TOKEN`** (Settings → Secrets and variables
→ Actions) — a Cloudflare token with **Cloudflare Pages: Edit**. The runtime `CF_ANALYTICS_TOKEN`
and the sign-in settings ([Auth](#auth)) are Pages *project* secrets and aren't needed by the
workflow (deploys keep existing secrets).

**Manual** (local fallback / preview), with the token from a local, gitignored file:

```powershell
$env:CLOUDFLARE_API_TOKEN = (Get-Content "<path>\cf-token.txt" -Raw).Trim()
npm run deploy      # = vite build && wrangler pages deploy
```

Single Cloudflare account — no account-ID env needed. Pages project: **gss-stats**.

## Auth

The app does its own sign-in, the same way deckhand does: Google OAuth plus an email
allowlist. Design, alternatives and the deckhand comparison are in
[ADR 0002](docs/adr/0002-google-auth.md). Code: `functions/_middleware.ts` and
`functions/_lib/auth.ts`.

**What happens on a request.** `functions/_middleware.ts` runs on every request: pages,
static assets, `/api/*` and `/auth/*`.

1. A host guard 404s every host except `stats.goodstuff.software` and loopback. That
   includes `*.pages.dev` and preview-branch URLs.
2. The auth gate then needs a valid session cookie belonging to an email on
   `ALLOWED_EMAILS`:
   - With no valid session, `/api/*` returns **401 JSON**
     (`{"error":"unauthenticated","signIn":"/auth/google/login"}`).
   - A page load **redirects** to Google sign-in and comes back to the same page
     afterwards.
   - An account that signs in with Google but isn't on the list gets a **403 "Not
     allowed"** page and no session.
3. **It fails closed.** If any required setting below is missing, every request gets a
   **503 "sign-in not configured"** that names the missing variable, never a value.

Routes:

| Route | What it does |
|---|---|
| `GET /auth/google/login?next=/…` | Sends the browser to Google's account chooser |
| `GET /auth/google/callback` | Google sends the browser back here; this validates the login and sets the session |
| `POST /auth/logout` | Sign out: clears the session and shows the signed-out page (the header's **Sign out** button) |
| `GET /auth/me` | Returns the signed-in email as JSON |
| `GET /auth/signed-out` | The signed-out page |

The session is a signed cookie, HMAC-SHA256 under `SESSION_SECRET`. It is `HttpOnly`,
`Secure`, `SameSite=Lax` and uses the `__Host-` prefix, and it lasts 7 days by default.
The allowlist is checked again on every request, so removing an email locks that
account out immediately. Rotating `SESSION_SECRET` signs everyone out.

Everything behind the gate (pages, static assets, `/api/*`) is sent with
`Cache-Control: private, no-store`, `Content-Security-Policy: frame-ancestors 'none'`
and `X-Frame-Options: DENY`: no shared cache keeps it, the browser doesn't store it (so
Back after **Sign out** can't bring the dashboard back), and no other site can frame it.
Sign out also sends `Clear-Site-Data: "cache"`. Sign out only deletes this browser's
cookie; a copied cookie stays valid until it expires (see the ADR).

### Settings (Pages project secrets, Production)

| Name | Required | Value |
|---|---|---|
| `GOOGLE_CLIENT_ID` | yes | The OAuth client ID (`….apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | yes | That client's secret |
| `SESSION_SECRET` | yes | At least 32 random characters. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `ALLOWED_EMAILS` | yes | Comma-separated, case-insensitive, exact addresses, no wildcards. Same format as deckhand's `DECKHAND_ADMIN_EMAILS`. Example: `santoro12@gmail.com`. **Only `gmail.com` or Google Workspace addresses.** A Google account registered with any other email (e.g. an ISP or work address that isn't Workspace) can show that email as "verified", but Google doesn't vouch for it later: whoever controls that mailbox afterwards can create a Google account with the same email and sign in |
| `SESSION_TTL_HOURS` | no | Session length in hours: a plain number from `1` to `720`. Default `168` (7 days). Any other value (text, `0`, `1e3`, over `720`) is a configuration error, so sign-in is locked with the 503 below until it is fixed |
| `AUTH_DEV_BYPASS` | **never set on Pages** | Local-only escape hatch (see Local development below). Only the exact value `1` turns it on, and it is ignored off loopback anyway |

Set them as **secrets**, not plain variables. `wrangler.toml` is the source of truth for
plain variables on this project, so the dashboard can't edit those, and nothing here
should be committed because the repo is public. Pages applies secrets at deploy time, so
**set them before the deployment that needs them**. Changing one later only takes effect
after a redeploy (Actions → Deploy → Run workflow).

### Owner setup and rollout: order matters

Do these steps in this order. The Cloudflare Access app stays on until step 6, so the
dashboard is never without a gate.

1. **Create a new Google OAuth client.** Put it in the same Google Cloud project as
   deckhand's, so it shares that project's consent screen and test users. Don't reuse
   deckhand's client: sharing one secret across both apps means a leak or rotation in
   one breaks the other.
   - In Google Cloud Console, go to **APIs & Services → Credentials → Create
     credentials → OAuth client ID**.
   - Choose type **Web application**, named e.g. `gss-stats`.
   - Add this **Authorized redirect URI**, exactly, and nothing else:
     `https://stats.goodstuff.software/auth/google/callback`
   - **Don't add a localhost redirect URI to this client.** That would put the
     production client secret in a dev machine's `.dev.vars`. To try the real flow
     locally, create a **separate** dev client instead (see Local development below).
   - Leave JavaScript origins empty.
   - On the consent screen, check that `goodstuff.software` is an authorized domain. It
     should already be there for deckhand. If the app's publishing status is
     **Testing**, `santoro12@gmail.com` must be listed under **Test users**.
2. **Set the four required secrets** on the `gss-stats` Pages project, Production
   environment. Use the dashboard (**Settings → Variables and Secrets → Add**, type
   **Secret**), or run:
   ```powershell
   $env:CLOUDFLARE_API_TOKEN = (Get-Content "<path>\cf-token.txt" -Raw).Trim()
   npx wrangler pages secret put GOOGLE_CLIENT_ID     --project-name gss-stats
   npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name gss-stats
   npx wrangler pages secret put SESSION_SECRET       --project-name gss-stats
   npx wrangler pages secret put ALLOWED_EMAILS       --project-name gss-stats
   ```
3. **Merge the PR to `main`.** The workflow runs the tests, then deploys.
4. **Verify on the live domain while Access is still on.** Use a normal browser window:
   - Open https://stats.goodstuff.software. Pass Access as usual; you should then see
     Google's account chooser. Pick the allowlisted account and you should land on the
     dashboard, with your email and **Sign out** in the header.
   - Click **Sign out**. You should see the "Signed out" page. **Sign in with Google**
     should get you back in.
   - Optional: try a different Google account. You should get **403 "Not allowed"**.
   - If you see **"Sign-in not configured"** (503), a setting is missing or invalid, and
     the page names which one. It can be a secret that is missing or too short, a
     `SESSION_TTL_HOURS` that isn't a plain number of hours from `1` to `720`, or an
     `ALLOWED_EMAILS` entry that isn't a plain ASCII address (an accented or look-alike
     character, for example). Fix it and redeploy.
   - If you see **502 "Sign-in failed"** after choosing your account, the code exchange
     with Google failed. **Keep Access on** and don't go on to step 6 (removing Access).
     Look in the Pages Functions logs for a line that starts `auth: token exchange …`: run
     `npx wrangler pages deployment tail --project-name gss-stats` (it follows the latest
     production deployment) and sign in again, or open the deployment's real-time logs
     under Workers & Pages → `gss-stats` in the dashboard.
     - `failed: HTTP 401` usually means the client ID and secret don't belong together.
     - `failed: HTTP 400` usually means the code expired or was already used (just sign
       in again), or the redirect URI doesn't match step 1.
     - `error: …` means the request to Google didn't complete at all.
   - If Google says `redirect_uri_mismatch`, the redirect URI in step 1 doesn't match
     byte for byte.
   - You may see the Access login once more in the middle of the Google round trip. That
     depends on how Access's cookie is configured and stops once Access is gone.
5. **Add a rate-limiting rule on the sign-in callback** (recommended), now, while Access
   still covers the site. Anyone can make the app call Google's token endpoint by
   hitting `/auth/google/callback` with a junk code, and a flood could get the OAuth
   client throttled, which would block your own sign-in. That exposure starts when Access
   goes in step 6, and the rule does no harm before then. In the Cloudflare dashboard,
   on the `goodstuff.software` zone, add a WAF **rate limiting rule**:
   - Match: URI path equals `/auth/google/callback`. On the Free plan, **Path** is the
     only request field a rate-limiting rule can match on, so the rule also covers that
     path on the zone's other hostnames, which is harmless at this limit. On Pro or
     higher you can add hostname equals `stats.goodstuff.software`.
   - Count by IP. Limit: for example 5 requests per 10 seconds. Action: **Block**, for
     the longest time your plan allows.
   - The Free plan allows one rate-limiting rule, with a 10-second period and a
     10-second block; paid plans allow longer. A real sign-in makes one callback
     request, so this never gets in your way.
6. **Only now, remove the Cloudflare Access application** for `stats.goodstuff.software`
   (Zero Trust → Access → Applications). Remove the `*.pages.dev` one too if there is
   one; the host guard already 404s that URL.
7. **Verify with no Access**, from a private window and a terminal (in Windows
   PowerShell 5.1, type `curl.exe`, because `curl` there is a different command):
   - https://stats.goodstuff.software should go straight to Google sign-in.
   - `curl -i https://stats.goodstuff.software/api/sites` should return `401` JSON.
   - `curl -i https://stats.goodstuff.software/auth/me` should return `401` JSON.
   - `curl -i -X PUT https://stats.goodstuff.software/api/config -H "Origin: https://evil.example"`
     should return `403` (the cross-origin write guard).
   - `https://gss-stats.pages.dev/` should return `404`.

**Rollback.** If sign-in misbehaves after step 6, first **re-create the Access
application**, which puts the edge gate back. Then fix forward or revert the merge.
Never remove the app gate while Access is off.

### Local development

`npm run preview` runs the real middleware on `http://localhost:8788`. Without sign-in
settings it answers 503, by design. Pick one of two setups in `.dev.vars` (see
[`.dev.vars.example`](.dev.vars.example)):

- `AUTH_DEV_BYPASS=1` skips Google. Only the exact value `1` counts (`true`, `0` and
  the like leave it off). It works only when the request host is `localhost` or
  `127.0.0.1` (IPv6 `[::1]` is not served), so it can't open the deployed site even if
  it were set there. The header then shows `dev@localhost`, or `AUTH_DEV_EMAIL` if you
  set it.
  - **Never combine the bypass with `--ip 0.0.0.0`** (or any other way of exposing the
    dev server to your network). The loopback check reads the request's `Host` header,
    so on a network-bound dev server any machine that sends `Host: localhost` gets the
    bypass, and with it your real analytics data through `CF_ANALYTICS_TOKEN`. The
    default `npm run preview` listens on loopback only, which is safe.
- For the real flow, create a **separate dev OAuth client** (e.g. `gss-stats-dev`, same
  Google Cloud project, type Web application) whose only redirect URI is
  `http://localhost:8788/auth/google/callback`. Put that client's ID and secret, plus
  your own `SESSION_SECRET` and `ALLOWED_EMAILS`, in `.dev.vars`. Never use the
  production client's secret locally. Plain-http loopback uses unprefixed,
  non-`Secure` cookie names; everything else behaves as in production.

`npm run dev` (Vite only) serves no Functions, so it has no auth and no `/api/*`.

**Tests.** `npm test` runs the vitest suite. For auth, `functions/_lib/auth.test.ts`
covers the allowlist (exact match only: superstrings, substrings and non-ASCII
look-alikes are refused), fail-closed configuration (including a bad
`SESSION_TTL_HOURS`), 401 vs. redirect, tampered, expired, future-dated, re-signed and
wrong-purpose cookies, state, nonce, PKCE and ID-token checks (`email_verified` must be
boolean `true`, multi-audience tokens need our `azp`, no future `iat`), open-redirect and
cross-origin guards, sign-out, the no-cache and anti-framing response headers, the dev
bypass (exactly `1`, loopback only) and the host guard. Node accepts some request
settings that the Workers runtime rejects, so `functions/_lib/auth.workerd.test.mjs`
also runs the sign-in inside workerd itself (`workerd test`, with wrangler.toml's
compatibility date and a mock Google): the exact token-request settings, a full sign-in
on the runtime's own `fetch`, a refused token-endpoint redirect, and Google refusing the
exchange. No test calls Google.

## Security / hardening

- **Sign-in gate.** Google sign-in plus an allowlist, enforced in
  `functions/_middleware.ts` on every request. See [Auth](#auth) and the ADR.
- **Host guard.** The same middleware 404s any non-canonical host, including
  `*.pages.dev` and preview URLs, so there is exactly one origin for cookies and the
  OAuth redirect.
- **Token hygiene.** The real tokens live only in a gitignored `.dev.vars` (local) and in
  Cloudflare Pages secrets (production), never in the repo. Follow-up: mint a
  least-privilege token with only "Account Analytics Read" and set it as the
  `CF_ANALYTICS_TOKEN` secret.

## Branch

`main` — the deployed line.
