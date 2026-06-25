# gss-stats

Private, bot-free traffic dashboard for **Good Stuff Software**. Custom UI on top of
Cloudflare's **RUM** (Real User Monitoring) data — the same human-only dataset that
powers Web Analytics, but rendered in a movable/composable dashboard you control.

🔒 Live at **https://stats.goodstuff.software** — behind Cloudflare Access (owner-only).

---

## Why this exists

- **Cloudflare Web Analytics (RUM)** is bot-filtered and accurate, but its UI is fixed.
- **Edge/GraphQL analytics** (`httpRequestsAdaptiveGroups`) is customizable but, on
  Free/Pro plans, can't filter bots — and this account's edge traffic is ~99% bots.
- RUM data **is** available via the GraphQL API (`rumPageloadEventsAdaptiveGroups`),
  bot-free. So this is a custom UI on the RUM API.

## Architecture

```
Browser (Vue 3 + Chart.js + grid-layout-plus)
   │  POST /api/stats          GET/PUT /api/config
   ▼
Cloudflare Pages Functions  (functions/api/*.ts)
   │  - holds CF_ANALYTICS_TOKEN (secret) — never reaches the browser
   │  - queries GraphQL Analytics API server-side
   │  - dashboard config persisted in KV (STATS_CONFIG)
   ▼
Cloudflare GraphQL Analytics API  ·  Cloudflare KV
```

- **Token is server-side only.** The browser calls our Functions; the Function adds the
  Bearer token and calls GraphQL. The token is never exposed to client JS.
- **Durable config.** Dashboard layout + chart definitions live in Cloudflare KV
  (`STATS_CONFIG`), so your customizations follow you across browsers/devices — not
  `localStorage`. (Theme preference is the only local-only setting.)
- **Locked down.** Cloudflare Access (Zero Trust) gates both `stats.goodstuff.software`
  and the `*.pages.dev` URL, allowing only the owner emails. A `_middleware.ts`
  host-guard is a backstop that 404s any non-canonical host.

## Features

- Movable / resizable widgets (drag the card header; resize from the corner).
- Add / edit / duplicate / delete charts of any type: **stat, bar, horizontal bar,
  stacked bar, line, area, doughnut, pie, table**.
- Group by any RUM dimension: site/host, page path, device, country, referrer, date.
- Global filters: site, subdomain, date range (7/30/90-day presets or custom),
  hide-self-referrals.
- Default dashboard out of the box (pageviews/visits KPIs, trend, by-site, site×device,
  top referrers, by-country, top pages, device split). "Reset" restores it.
- Light / dark theme matching the Good Stuff Software brand.

## RUM sites & dimensions

Account `a32bba62c77df5e8f6bd33d04478ec34`. RUM site tags:

| Site | siteTag |
|---|---|
| goodstuff.software (starrupture./simpletile./apex) | `7dd3bcb059af40f79f8df92d6d0be750` |
| goodstuffsoftware.com | `0289e02254fc4db8b73b232c59f8421f` |
| bestsudoku.app | `a8baf99f3d294215a92a176e8c56bd15` |

Whitelisted dimensions (server-side): `requestHost`, `requestPath`, `deviceType`,
`countryName`, `refererHost`, `userAgentBrowser`, `userAgentOS`, `date`.
**Geography is country-only** — RUM has no region/state/city dimension.

**"Hide my own visits"** excludes the owner's browser+OS *combination* server-side
(De Morgan `OR: [browser_neq, os_neq]`, so e.g. Chrome/Windows isn't dropped).
Defaults to Opera/Windows, on by default, configurable in the filter bar. RUM
exposes no client IP/visitor ID, so a UA combo is the only self-exclusion proxy.

**Not yet wired (available for the asking):** Cloudflare has two more bot-free RUM
datasets — **Performance** (`rumPerformanceEventsAdaptiveGroups`: load/FCP/render/
DNS/TTFB percentiles, µs) and **Web Vitals** (`rumWebVitalsEventsAdaptiveGroups`:
LCP/INP/CLS/FCP/TTFB bucketed Good/Needs/Poor). The Pageload dataset we use has
only two metrics: `count` (pageviews) and `visits`.

## Local development

```powershell
npm install
# one-time: create local secret from the deploy/analytics token
"CF_ANALYTICS_TOKEN=$((Get-Content C:\Users\msant\dev\cf-token.txt -Raw).Trim())" `
  | Out-File .dev.vars -Encoding ascii -NoNewline

npm run preview     # build + wrangler pages dev (Functions + KV simulated) on :8788
# or
npm run dev         # Vite only (UI iteration; /api/* not served)
```

`.dev.vars` is gitignored. `localhost` / `127.0.0.1` are allowed by the host-guard.

## Deploy

Manual `wrangler` deploy with the local token (same pattern as goodstuffsoftware.com):

```powershell
$env:CLOUDFLARE_API_TOKEN = (Get-Content "C:\Users\msant\dev\cf-token.txt" -Raw).Trim()
npm run deploy      # = vite build && wrangler pages deploy
```

Single Cloudflare account — no account-ID env needed. Pages project: **gss-stats**.

## Provisioned resources

| Resource | Value |
|---|---|
| Pages project | `gss-stats` → https://gss-stats.pages.dev |
| Custom domain | `stats.goodstuff.software` (CNAME → gss-stats.pages.dev, proxied) |
| KV namespace | `STATS_CONFIG` id `f1fa625cdb844c109c4db4acc02d00f5` |
| Secret | `CF_ANALYTICS_TOKEN` (production) |
| Access app | "GSS Stats" id `69c4cfb0-b413-4dcd-912d-fd5745d887f5` |
| Access policy | "Owner only" — santoro12@gmail.com, mike@goodstuffsoftware.com |
| Zero Trust team | `bestsudoku.cloudflareaccess.com` |

## Security / hardening follow-ups

1. **Dedicated read-only token (recommended).** The Function secret currently reuses the
   deploy token (`cf-token.txt`), which has more than analytics-read. The deploy token
   lacks "API Tokens: Write" so a least-privilege token couldn't be minted via API.
   To harden: create a token in the CF dashboard with **only** "Account Analytics Read"
   (account = Good Stuff Software), then:
   ```powershell
   $env:CLOUDFLARE_API_TOKEN=(Get-Content C:\Users\msant\dev\cf-token.txt -Raw).Trim()
   "PASTE_READONLY_TOKEN" | npx wrangler pages secret put CF_ANALYTICS_TOKEN --project-name gss-stats
   npm run deploy   # redeploy so Functions pick up the new secret
   ```
2. **Google sign-in (optional).** Access currently uses **One-Time PIN** (email codes) —
   zero-config and already owner-only. To add one-click Google: create an OAuth client in
   Google Cloud Console, add a Google IdP in Cloudflare Zero Trust → Settings →
   Authentication, and it works automatically (the policy allows by email regardless of IdP).
