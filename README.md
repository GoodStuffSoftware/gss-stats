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
  pattern is defined. A configurable **tracking activation date** (`TRACKING_ACTIVATION_DATE_ET`,
  null until v1.90.0 ships) keeps pre-release data from reading as a baseline: every rate
  and every pop-up count widget (other than the trend line, which plots full history with
  a "tracking starts" marker) is gated to that date, so a real pre-release denominator
  (e.g. a bug reproduction) can only ever render "—", never a misleading 0%.
- **Campaign comparison** — a bespoke "Best Sudoku campaigns" page (not the generic
  chart-grid model) compares the three Google Ads campaigns configured in
  [`src/lib/campaigns.ts`](src/lib/campaigns.ts): a funnel per campaign, arrivals by ET
  hour of day, arrivals/funnel by country, daily + cumulative arrivals aligned by flight
  day, cost per arrival/auth success (once spend is filled in), device mix, and an
  on-device return-visit retention curve. Attribution is by the beacon's own campaign tag
  only — one swappable function decides row membership, and known verification/household
  traffic is excluded server-side.
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
   │  - /api/sites  → auto-builds the merged site list (RUM + beacon, aliases folded)
   │  - /api/config → dashboard layout in KV
   ▼
Cloudflare GraphQL Analytics API  ·  D1 (gss-geo)  ·  KV (STATS_CONFIG)
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
`/signin-eligible`, `/promo-first50`, `/first50-congrats`, `/upsell`, `/install` and
`/popup-outcome` are pop-up interaction events, not screens — `/api/geo` and `/api/sites`
exclude them from every pageview/visit total and the top-pages breakdown (see
[`src/lib/popupEvents.ts`](src/lib/popupEvents.ts)); `/api/popups` is where they're counted.

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

## Docs

| Area | Entry point |
|---|---|
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Contributing / conventions | [CLAUDE.md](CLAUDE.md) |
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
