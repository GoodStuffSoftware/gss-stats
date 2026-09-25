# ADR 0001: Google sign-in in the app, replacing Cloudflare Access

- **Status:** Accepted (branch `feat/google-auth`). The rollout is manual; see README "Auth".
- **Date:** 2026-09-25
- **Code:** `functions/_middleware.ts` (host guard, then the auth gate),
  `functions/_lib/auth.ts` (gate and OAuth flow), `functions/_lib/auth.test.ts`

## Context

The dashboard and its API (RUM via `CF_ANALYTICS_TOKEN`, beacon geo from D1 `gss_geo`,
layout in KV) were protected only by a Cloudflare Access application on
`stats.goodstuff.software`. Nothing in the app checked identity: there was no
`Cf-Access-Jwt-Assertion` validation. A host-guard middleware 404'd every other hostname,
because a self-hosted Access app does not cover the project's `*.pages.dev` URL. The
owner wants to remove Access and sign in with Google "like deckhand".

**Nothing here needs to be public.** gss-beacon is a separate Pages project. It shares
only the D1 database with this app and makes no HTTP calls here, so every route can
require sign-in.

## The precedent: deckhand

Deckhand is an Express server on Hetzner behind cloudflared. Its sign-in code is
`core/oauth-google.mjs`, `routes/auth.mjs`, `core/session-auth.mjs`,
`docs/google-oauth-setup.md`, and decision D74/D76. How it works:

- Google's OAuth 2.0 authorization-code flow, as a confidential client. It asks for
  `openid email profile` with `access_type=online` and `prompt=select_account`.
- The anti-CSRF `state` is 24 random bytes, kept in a 10-minute HttpOnly `SameSite=Lax`
  cookie. That cookie is cleared on every callback outcome.
- Identity comes from the **userinfo** endpoint, and the email must be
  `email_verified`.
- Sessions are server-side rows in **SQLite**, stored as the hash of the session id,
  with a 7-day TTL (`DECKHAND_SESSION_TTL_HOURS`).
- The allowlist is `DECKHAND_ADMIN_EMAILS`: comma-separated, case-insensitive, exact
  match, no wildcards. It is applied on first login only and grants a role. Accounts
  that aren't on it are still created, with no role.
- Without config, login is disabled (503), never open.
- Rollout, from its decision log: the app-side gate came first, verified, and only
  then was the edge (Access) removed.

## Decision

The app enforces Google sign-in itself, in the Pages middleware that already runs on
every request (static assets, `/api/*`, `/auth/*`).

What we reused from deckhand:

- The OAuth flow shape, including `access_type=online` and `prompt=select_account`.
- The state cookie: 10 minutes, HttpOnly, Lax, cleared on every outcome.
- Requiring `email_verified`.
- The allowlist convention: comma-separated, case-insensitive, exact, no wildcards.
- The 7-day default TTL.
- Fail-closed behaviour when config is missing.
- The rollout order: app first, edge second.

What we changed, and why:

| Deckhand | gss-stats | Why |
|---|---|---|
| Sessions in SQLite, keyed by the session id's hash | **Stateless HMAC-SHA256-signed cookie** (`__Host-gss_session`) holding `{email, sub, iat, exp}` | Pages has no SQLite. There is one allowlisted owner, so a session table would only add storage and a revocation list for no benefit. |
| Allowlist checked on first login only, and grants a role | **Allowlist re-checked on every request.** No roles: you are on the list or you are refused. | This is a single-purpose owner dashboard, not multi-user RBAC. Re-checking means that taking an email off the list locks it out immediately, even with a live cookie. |
| Identity from userinfo, using the access token | **Identity from the ID token** returned by the token endpoint. We check `iss`, `aud`, `azp` (required to be ours when `aud` lists more than one client), `exp`, `iat` (not in the future beyond 5 minutes of skew), `nonce` and `email_verified` (only the JSON boolean `true` counts). | Saves a network round trip. It also lets us bind the login to our client (`aud`/`azp`) and to this attempt (`nonce`). |
| No PKCE, no nonce | **PKCE S256 plus an OIDC nonce.** The PKCE verifier is derived from `state` with HMAC, so it is never stored. | Current OAuth best practice (RFC 9700), and cheap. |
| Scope `openid email profile` | Scope **`openid email`** | We never use the profile. |
| Redirect URI from env or loopback | **Derived from the request origin** | The host guard lets only the canonical domain and loopback reach this code, so the value is fixed, and local dev works on any port. |
| `DECKHAND_*` variable names | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_EMAILS`, `SESSION_TTL_HOURS` | Pages variables are already scoped per project, and the one existing variable (`CF_ANALYTICS_TOKEN`) has no prefix. |
| Logout: POST with a custom-header CSRF guard | Logout: POST with an **`Origin` check applied to every non-GET request**, `/api/*` included | SameSite=Lax already stops cross-*site* posts. The Origin check also stops cross-*origin*, same-site posts from sibling `*.goodstuff.software` sites. |

Other rules:

- **Fail closed.** If `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`
  (32 characters or more) or a non-empty `ALLOWED_EMAILS` is missing, everything gets
  a 503: JSON for the API, a page otherwise. The response names the missing variable,
  never a value.
- **Unauthenticated requests.** `/api/*` and `/auth/me` get `401` JSON. A `GET` page
  load or asset gets a `302` to `/auth/google/login?next=<path>`. `next` must be a
  same-origin path, so it can't be used as an open redirect.
- **Cookies.** Both cookies are HttpOnly, SameSite=Lax, Path=/, and carry the
  `__Host-` prefix and `Secure` on HTTPS. The prefix means a sibling subdomain can't
  plant or overwrite them. Plain-http requests off loopback are redirected to HTTPS
  before any cookie is set.
- **Signing.** Session and state cookies are signed with the same secret but with
  different purpose prefixes, so one can't be replayed as the other. Verification
  uses `crypto.subtle.verify`, which is constant-time.
- **Allowlist matching.** Exact and case-insensitive, never a substring or domain match.
  An email that isn't printable ASCII is refused before it is lower-cased, because
  lower-casing folds some non-ASCII letters onto ASCII ones (U+212A KELVIN SIGN becomes
  `k`). An `ALLOWED_EMAILS` entry that isn't plain ASCII is a configuration error.
- **Sessions.** Default length is 7 days. `SESSION_TTL_HOURS` must be a plain number
  from 1 to 720 (30 days); anything else is a configuration error (503), not a silent
  fallback. Lowering the setting also shortens sessions already issued. A session
  dated in the future (beyond 5 minutes of skew) is refused. Rotating `SESSION_SECRET`
  signs everyone out.
- **Local dev.** With `AUTH_DEV_BYPASS` set to exactly `1`, the gate is skipped only
  when the request host is `localhost` or `127.0.0.1`. On the deployed hostname the
  flag does nothing, so it can never open production. It is off by default, and the
  local server without it (or without Google config) returns 503.
- **Host guard.** Kept, so there is one origin for the cookie and the redirect URI,
  and `*.pages.dev` and preview URLs stay unreachable.

### Why the ID token signature is not checked

The ID token comes straight from `https://oauth2.googleapis.com/token`, over TLS, in
reply to a request that we authenticated with our client secret and PKCE verifier.
OIDC Core §3.1.3.7(6) allows TLS server validation to stand in for signature
checking in this case, and Google's OpenID Connect guide says the same for the
server-side flow. Checking against JWKS would mean fetching and caching Google's
keys and handling key rotation, with no extra security on this channel. All the
claim checks are still done. If identity is ever taken from a token that did **not**
come straight from the token endpoint (implicit flow, a token passed in by the client,
etc.), the signature must be verified first. To keep this ruling valid:

- The token endpoint stays a constant in the code, never a setting.
- The token request is sent with `redirect: 'error'`, so the TLS argument can't
  silently extend to a redirect target.
- The unverified decoder is private to the callback and named for the token-endpoint
  response only (`unverifiedClaimsFromTokenEndpoint`).

## Alternatives considered

1. **Keep Cloudflare Access and add Google as its identity provider.** This needs no
   code and is the smallest change. But the owner explicitly wants Access removed,
   and it keeps the Zero Trust dependency and the edge-only gate (the app itself
   still trusts every request). Rejected because it doesn't meet the goal. It is
   still the fallback if this change has to be rolled back (see README "Auth").
2. **Keep Access and validate `Cf-Access-Jwt-Assertion` in the app**, as defence in
   depth. It hardens today's setup but still needs Access. Rejected for the same
   reason.
3. **Server-side sessions in KV, as deckhand does with SQLite.** This would allow
   revoking one session at a time. But every request would pay a KV read, KV is only
   eventually consistent, and with one owner, "revoke" already works through the
   allowlist or by rotating the secret. Rejected. It can be revisited if there are
   ever multiple users.
4. **Sessions in D1.** `gss_geo` is the beacon's shared database, which this app
   treats as read-only. Adding auth tables there couples two projects. Rejected.
5. **A library** such as Auth.js or `@hono/oauth-providers`. That means an extra
   runtime framework and dependency surface for about 300 lines of standard,
   fully tested code. Deckhand made the same call and hand-rolled its version.
   Rejected.
6. **Google Identity Services (the browser-side One Tap / Sign-In button) posting an
   ID token to us.** That token arrives through the browser, so it would need JWKS
   signature verification and a different CSRF model. The server-side code flow is
   simpler to get right. Rejected.
7. **Reuse deckhand's OAuth client** instead of creating a new one. It would work: add
   a second redirect URI. But both deployments would then share one client secret, so
   a leak or rotation in one affects the other. Rejected in favour of a **new OAuth
   client in the same Google Cloud project**, which reuses the consent screen and
   test users. See README "Auth".
8. **Encrypted cookies (JWE) instead of signed ones.** The session payload is only
   the owner's own email plus timestamps, which is not secret from its owner, and
   the cookie is HttpOnly. Signing gives the integrity we need. Rejected as
   unnecessary complexity.

## Consequences

- The app becomes the only gate once Access is removed. Removing Access **after** the
  gate is live and verified is required. Doing it in the other order would leave the
  dashboard open between those two steps. README "Auth" gives the order.
- Every new `/api/*` route (for example `/api/popups` on `feat/popup-tracking`) is
  covered automatically, because the gate works by path prefix.
- There is no way to revoke one session on its own. The levers are removing the
  email from `ALLOWED_EMAILS` or rotating `SESSION_SECRET`. Both need a redeploy,
  because Pages variables take effect on the next deployment.
- The Google consent screen's publishing status and test users (Google's own gate)
  apply in addition to `ALLOWED_EMAILS`.
