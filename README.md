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
| Auth | Google sign-in (OAuth 2.0 / OIDC) in the Pages middleware, email allowlist |

## Features

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

**"Hide my own visits"** excludes the owner's browser+OS *combination* server-side
(De Morgan `OR: [browser_neq, os_neq]`, so e.g. Chrome/Windows isn't dropped). RUM
exposes no client IP or visitor ID, so a UA combo is the only self-exclusion proxy on
that dataset; the beacon adds a precise per-device/per-network opt-out.

## Docs

| Area | Entry point |
|---|---|
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Contributing / conventions | [CLAUDE.md](CLAUDE.md) |
| Auth design (ADR) | [docs/adr/0001-google-auth.md](docs/adr/0001-google-auth.md) |
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
[ADR 0001](docs/adr/0001-google-auth.md). Code: `functions/_middleware.ts` and
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

### Settings (Pages project secrets, Production)

| Name | Required | Value |
|---|---|---|
| `GOOGLE_CLIENT_ID` | yes | The OAuth client ID (`….apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | yes | That client's secret |
| `SESSION_SECRET` | yes | At least 32 random characters. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `ALLOWED_EMAILS` | yes | Comma-separated, case-insensitive, exact addresses, no wildcards. Same format as deckhand's `DECKHAND_ADMIN_EMAILS`. Example: `santoro12@gmail.com` |
| `SESSION_TTL_HOURS` | no | Session length in hours: a plain number from `1` to `720`. Default `168` (7 days). Any other value (text, `0`, `1e3`, over `720`) is a configuration error, so sign-in is locked with the 503 below until it is fixed |
| `AUTH_DEV_BYPASS` | **never set on Pages** | Local-only escape hatch (see Local development below). Only the exact value `1` turns it on, and it is ignored off loopback anyway |

Set them as **secrets**, not plain variables. `wrangler.toml` is the source of truth for
plain variables on this project, so the dashboard can't edit those, and nothing here
should be committed because the repo is public. Pages applies secrets at deploy time, so
**set them before the deployment that needs them**. Changing one later only takes effect
after a redeploy (Actions → Deploy → Run workflow).

### Owner setup and rollout: order matters

Do these steps in this order. The Cloudflare Access app stays on until step 5, so the
dashboard is never without a gate.

1. **Create a new Google OAuth client.** Put it in the same Google Cloud project as
   deckhand's, so it shares that project's consent screen and test users. Don't reuse
   deckhand's client: sharing one secret across both apps means a leak or rotation in
   one breaks the other.
   - In Google Cloud Console, go to **APIs & Services → Credentials → Create
     credentials → OAuth client ID**.
   - Choose type **Web application**, named e.g. `gss-stats`.
   - Add this **Authorized redirect URI**, exactly:
     `https://stats.goodstuff.software/auth/google/callback`
   - Optionally, to try the real flow locally, also add
     `http://localhost:8788/auth/google/callback`.
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
   - If you see **"Sign-in not configured"**, a secret is missing or too short (the page
     says which). Set it and redeploy.
   - If Google says `redirect_uri_mismatch`, the redirect URI in step 1 doesn't match
     byte for byte.
   - You may see the Access login once more in the middle of the Google round trip. That
     depends on how Access's cookie is configured and stops once Access is gone.
5. **Only now, remove the Cloudflare Access application** for `stats.goodstuff.software`
   (Zero Trust → Access → Applications). Remove the `*.pages.dev` one too if there is
   one; the host guard already 404s that URL.
6. **Verify with no Access**, from a private window:
   - https://stats.goodstuff.software should go straight to Google sign-in.
   - `curl -i https://stats.goodstuff.software/api/sites` should return `401` JSON.
   - `https://gss-stats.pages.dev/` should return `404`.

**Rollback.** If sign-in misbehaves after step 5, first **re-create the Access
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
- For the real flow, set the four settings above in `.dev.vars` and register
  `http://localhost:8788/auth/google/callback` on the OAuth client. Plain-http loopback
  uses unprefixed, non-`Secure` cookie names; everything else behaves as in production.

`npm run dev` (Vite only) serves no Functions, so it has no auth and no `/api/*`.

**Tests.** `npm test` runs the vitest suite. For auth, `functions/_lib/auth.test.ts`
covers the allowlist (exact match only: superstrings, substrings and non-ASCII
look-alikes are refused), fail-closed configuration (including a bad
`SESSION_TTL_HOURS`), 401 vs. redirect, tampered, expired, future-dated, re-signed and
wrong-purpose cookies, state, nonce, PKCE and ID-token checks (`email_verified` must be
boolean `true`, multi-audience tokens need our `azp`, no future `iat`), open-redirect and
cross-origin guards, sign-out, the dev bypass (exactly `1`, loopback only) and the host
guard. No test calls Google.

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
