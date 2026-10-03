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

npm test            # vitest (skips .claude/**, where agent worktrees live) — the sign-in gate (see Auth → Tests) plus pure-logic unit tests (day bucketing, rate math, campaign attribution, …)
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

- **"Best Sudoku · Overview"** — the landing page: today-at-a-glance KPI tiles (vs the same
  time yesterday and the 7-day average), the **Overall timeline**, a campaign scorecard, and a
  release before/after panel — each its own movable/editable widget. The KPI tiles and the
  scorecard are **metric cards** (presets `bsk-kpis` and `campaign-scorecard`, see *One metrics
  registry* below), and so is the release panel (preset `release-before-after`: the latest dated
  release's before and after windows, `days` whole days on each side of its ET midnight, bounded
  by the first Best Sudoku hit, as [`src/lib/overview.ts`](src/lib/overview.ts)
  `releaseComparisonWindows` decides). The Overall timeline is a **standard line
  chart** (see *Line charts* below) with five series — page views and tagged arrivals on the left
  axis, auth successes, installs and raw install signals on the right — over the page's date
  range and Best Sudoku sites, with campaign-flight bands, release markers and go-live markers
  on. It buckets by **US-Eastern day** (the `dateEt` beacon dimension, "Date (trend, ET)":
  DST-aware, the same days as `etDateFast` and the flight bands and markers), where the plain
  `date` dimension is a UTC day.
  [`src/lib/releases.ts`](src/lib/releases.ts) holds the hand-entered release dates (`hits` has
  no app-version column; major releases get a labelled line, minor ones a short tick).
  "Best Sudoku · Campaigns" (its funnel, country, cost and return-visits panels are metric
  cards, presets `campaign-funnel`, `campaign-country` — a table with the funnel steps as rows
  and US / CA / Other as columns, each cell a campaign metric with the registry's optional
  `country` param — `campaign-cost` and `campaign-returns` — d0 and each return window's rate,
  dN over d0 with its n/d, as bars side by side. "Arrivals by ET hour of day" and "Daily
  arrivals by flight day" are standard geo charts over the same tagged arrivals (filter
  `arrival` = tagged): a breakdown bar of `hourEt` × `campaignFlight`, and a line of
  `flightDay` × `campaignFlight` with `cumulative` running totals dashed on a right-hand axis.
  A `campaignFlight` breakdown draws every beacon-tracked campaign with a start date, one with
  no arrivals yet at 0, and the flight-day axis runs to the longest of those flights.
  The funnel card also carries the signed-out upsell fix's pre/post-fix segment table, which
  appears on its own once `UPSELL_SIGNEDOUT_FIX_AT` is set. Since layout version 11 no page has a
  bespoke panel left: the former panel bodies and their endpoints (`/api/campaigns`,
  `/api/overview`) are retired, and a saved layout's panels are swapped in place on load — see
  [`src/lib/defaults.ts`](src/lib/defaults.ts) `migratePanelsV11`)
  and "Best Sudoku · Traffic" (per-site/geo/referrer/device detail beyond what Overview and
  Campaigns cover) round out the Best Sudoku tab group, which is kept together and in that
  order — after your own tabs — by a non-destructive reorder on load (see
  [`src/lib/defaults.ts`](src/lib/defaults.ts)'s `reorderBskGroup`).
- **Movable / composable charts** — drag the header, resize from the corner; add /
  edit / duplicate / delete charts of any type: stat, bar, horizontal bar, stacked
  bar, **breakdown bar** (one dimension on the axis × another as the series, grouped or
  stacked — `Widget.barMode`), line (over a non-date axis, a breakdown draws one line per
  value, and `Widget.cumulative` adds each one's running total dashed on a right-hand axis),
  area, doughnut, nested doughnut, pie, table, a geo point
  map, and a note/text tile. Zoom is a single click, always available on every chart; its other
  modification chrome (edit/remove/drag/resize) tucks away until you hover that chart
  — or tap that chart's own reveal icon on touch, which has no hover.
  **Known gap:** the resize grip (drag-to-resize corner) isn't keyboard-operable — it's a
  [`grid-layout-plus`](https://www.npmjs.com/package/grid-layout-plus) limitation, not a
  regression from this app's own code. Resizing a chart currently needs a mouse or touch;
  every other chart action (edit, remove, zoom, duplicate, set-as-default) has a real
  button and works from the keyboard.
- **The main filter bar is always visible**, in normal flow directly under the page
  tabs (range, sites, exclusions, sync-across-pages). If it scrolls out of view, a
  small "show filters" button appears top-right — see the IntersectionObserver on
  `barSectionEl` in [`src/App.vue`](src/App.vue) — and pins the same bar at the top of
  the viewport until you dismiss it (the button again, Escape, or clicking outside) or
  scroll back to where the in-flow bar is visible. Page tabs stay always visible above
  it either way. Hidden only on the campaign page, whose widgets aren't filter-driven.
  The button stays keyboard-reachable at all times (never `tabindex="-1"`, revealed on
  real keyboard focus even while visually hidden); activating it while the in-flow bar
  is already on screen just moves focus to the bar's first control.
- **A shared notes/text library** ([`src/lib/notes.ts`](src/lib/notes.ts)) — every
  caveat, definition, and explanatory paragraph the dashboard shows (small-sample
  warnings, attribution scope, "how to read this" captions, …) is a registry entry with
  an id, a severity, which dataset(s) it defaults for, and an optional gate (e.g. "only
  while tracking hasn't shipped yet"). Rendered through
  [`NoteBlock.vue`](src/components/NoteBlock.vue) (short caveats) or
  [`TextBlock.vue`](src/components/TextBlock.vue) (longer prose) — both support
  **bold** and [links](https://example.com) via a small safe tokenizer
  ([`src/lib/textLite.ts`](src/lib/textLite.ts), never `v-html`) — and attachable to
  any chart as a caption (`widget.notes`) or as its own movable 'note' widget
  (`widget.noteId`), editable from the chart menu either way. Short UI names (metric and
  funnel-step labels such as "Game-screen views") are registry entries too, of kind `label`:
  never a caption and never offered in the caption pickers (the card builder's label pickers
  list them).
- **Durable, multi-page dashboards** — layout + chart definitions persist in KV (not
  `localStorage`), so they follow you across devices. Duplicate / rename / delete
  pages; a protected default page with "restore default charts"; per-page filters and
  per-chart filter overrides. A saved layout is migrated forward on load
  ([`src/lib/defaults.ts`](src/lib/defaults.ts) `normalizeConfig`, `CONFIG_VERSION`), and the
  first save of a newer version first copies the previous stored layout to
  `dashboard:default:backup:v<old version>` in KV ([`functions/api/config.ts`](functions/api/config.ts)),
  once, so a migration can be rolled back by copying that key over `dashboard:default`.
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
- **Per-chart site pick** — "Site override" in the chart editor (`Widget.siteSel`) narrows one
  chart to a site (e.g. Best Sudoku's web + app beacon tags) instead of the page's site pick;
  dates, drills and the other page filters still apply.
- **Line charts** — on a date axis, any line/area chart can draw release markers, go-live
  markers (tracking activation, the game-complete/auth beacons, the install fix, the raw-install
  de-dupe) and shaded campaign-flight bands (an active flight's band runs to the axis end), each
  a checkbox in the chart editor ([`src/lib/timelineOverlay.ts`](src/lib/timelineOverlay.ts)).
  Close labels stagger into rows and drop out rather than overprint (fewer rows at phone width);
  hovering or tapping a marker line or a band's name shows its date and note, and a collapsed
  "Markers and bands" list under the chart holds every item in range for keyboard and touch. A
  beacon line chart can also draw several **series** (`Widget.series`): each is its own date
  query narrowed by one field = value filter (e.g. `keyEvent = install`), on the left or right
  axis, solid/dashed/dotted, with optional axis titles. "Hide known test and household traffic"
  (`excludeKnownTraffic`) applies the campaigns endpoint's `EXCLUSIONS` to a beacon chart.
- **Smart date range** — type spans like `7d` / `24h` / `2w` / `last 3d`, or pick
  exact dates. `since first campaign` (also a chip in a chart's own filter) runs from ET
  midnight of the earliest configured campaign flight's start to now, a window that grows
  instead of rolling ([`src/lib/range.ts`](src/lib/range.ts)); the two campaign arrivals charts
  use it, so a flight's first days never drop off.
- **Geo beacon dataset** — region / city / ISP / new-vs-returning and a visitor map,
  from the beacon (RUM geography is country-only).
- **Pop-up tracking** — a Best Sudoku page for the sign-in prompt, first-50 promo, upsell
  and install pop-ups. It holds ONE breakdown bar chart (every pop-up on the axis — the
  `popupFamily` beacon dimension — and shown, taps, dismissals, each outcome and install's raw
  signals as the series — `popupOutcome`, where the shown row counts as outcome `shown`), a
  **rate table** with only the valid ratios (each pop-up's taps over its showings, and install
  over post-fix install prompts — `POPUP_RATE_TABLE_KEYS`; each with its n/d and "too few to
  report" under `MIN_COHORT`), and the sign-in eligibility counts with their rate. The rate table
  and the eligibility panel are metric cards (presets `popup-rates` and `signin-eligibility`, since
  layout version 11), over the page's range, sites and "hide my own visits", as before. Outcome-over-shown rates are
  not shown as percentages: outcomes land days after the showing, so a range mixes cohorts.
  Every other pop-up chart (reason/platform breakdowns, per-day trends, single rate tiles) is
  still available from the chart editor's "Pop-up tracking" data source.
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

  **v1.95.5 go-live markers** (`GAME_COMPLETE_LIVE_AT` in `lib/popupEvents.ts`,
  `AUTH_NEW_EXISTING_LIVE_AT` in `lib/adsRules.ts` — both `2026-09-26T19:43:02Z`, the first
  confirmed-live instant): this release added `/game/complete/<mode>/<difficulty>` (one row
  per distinct completed game — see "Completed a game" below) and a
  `/auth/success/<provider>/<new|existing|unknown>` beacon that fires ALONGSIDE the existing
  base `/auth/success/<provider>` row for the same sign-in. Every auth-success count in this
  codebase (overview KPIs/release panel, the campaign funnel, the ads-read routine) counts
  only the base two-segment path — `AUTH_SUCCESS_PATHS` / `isAuthSuccessBase` (alias
  `isAuthSuccessPath`) in `lib/campaigns.ts`, the one matcher — so the new suffix row is never
  double-counted. The completion beacon
  is excluded from every page-view/visit count the same way every other pop-up/event beacon
  is (`POPUP_EVENT_PREFIXES`), and powers a new, live "Completed a game" funnel step and
  overview tile (previously always "not yet tracking" — nothing matched before this
  release), plus a mode × difficulty completions breakdown chart (dataset `completions`;
  see [`functions/api/completions.ts`](functions/api/completions.ts)) — a plain generic
  dimension/breakdown widget, same pipeline as the geo/pop-up datasets, so it's
  configurable and movable like any other chart. Added automatically to the "Best Sudoku ·
  Overview" page for anyone who hasn't already customised its default charts.

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
  routine stores, falling back to the hand-entered `CAMPAIGN_SPEND`), a device mix (the
  standard nested doughnut over the beacon: campaign flight → device → OS, share of tagged
  hits), an
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
   │  - /api/completions → completed-game counts from the same D1, by mode × difficulty
   │  - /api/metrics  → one batch of registry metrics/ratios by id (ADR 0003): every metric card
   │                      (Overview, Campaigns, Pop-ups), from the same D1 and the ads store
   │  - /api/ads/readings → the ads routine's readings log + stored spend (D1 gss-stats-ads)
   │  - /api/sites  → auto-builds the merged site list (RUM + beacon, aliases folded)
   │  - /api/config → dashboard layout in KV (backed up once per layout-version bump)
   ▼
Cloudflare GraphQL Analytics API  ·  D1 (gss-geo, read-only)  ·  D1 (gss-stats-ads)  ·  KV (STATS_CONFIG)
```

- **One metrics registry** ([`src/lib/metrics/`](src/lib/metrics), ADR 0003) defines every
  dashboard number once: its unit, the aggregate "fact" (a fixed, code-reviewed `COUNT(*) …
  GROUP BY` statement) it is counted from, its params, windows and go-live rules. A percentage is
  registered only when numerator and denominator share a unit and the numerator is a declared
  subset of the denominator; an invalid ratio fails at import. Labels are notes-registry entries.
  `POST /api/metrics` answers a batch of registry ids and params (never SQL): it validates every
  id and param against the registry, plans the distinct facts (at most 40 statements, else `413`
  with `maxStatements`), caches each fact on its own in the Cache API, and derives every value in
  JS with its status (`ok`, `too-few`, `no-data`, `unmeasured`, `partial`), n/d, deltas and a
  provisional flag for lagged outcomes. Windows are the campaign's attribution window, today so
  far, the page range, the latest release's before/after windows (sized by one cached first-hit
  read), and a campaign's pre/post segments at the signed-out upsell fix (only once that fix is
  set and falls in the flight). **Metric cards** render it: a widget with `card`
  (`{ preset }` from [`src/lib/metrics/presets.ts`](src/lib/metrics/presets.ts), or a saved spec)
  shows `MetricCard` ([`src/components/metrics/`](src/components/metrics)) — one batched request
  per page, following the page's date range and sites, with each card's caveats behind one
  collapsed "Notes" link and "Updated Xs ago" with ↻ where the card asks for it. The Overview's
  "Today at a glance" and campaign scorecard are cards since layout version 10. **Cards are
  editable**: "Add chart" offers a metric card as a chart type, and editing one — a new card or
  an existing "Today at a glance"/scorecard — opens a card builder in place of the usual chart
  fields ([`src/components/metrics/CardEditor.vue`](src/components/metrics/CardEditor.vue)): pick
  each row's label (plain text, a note, a bound field, or the metric's own name), its data (a
  metric, a registered ratio, or a field — only unit-compatible display types are offered, so an
  invalid percentage can't be built), arrange sections, and watch it update live before saving; an
  edit that would leave the card invalid is refused inline instead of being saved.
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

**Pop-up event beacons never count as page views — unless a chart opts in.** Paths under
`/signin-prompt`, `/signin-eligible`, `/promo-first50`, `/first50-congrats`, `/upsell`,
`/install`, `/popup-outcome`, `/return`, `/game/complete/`, the `/auth/success/<provider>/`
status suffix, `/auth/error`, `/auth/redirect` and the first-session beacons (`/tour`,
`/game/first-move`, `/game/abandon`, `/welcome-signed-in`) are pop-up/event beacons, not screens — `/api/geo` and `/api/sites` exclude all
of them from every pageview/visit total and the top-pages breakdown by default (see
[`src/lib/popupEvents.ts`](src/lib/popupEvents.ts) `POPUP_EVENT_PREFIXES`); `/api/popups` is
where they're counted. Each geo chart has its own **"Include event beacons"** option (off by
default, so nothing existing changes) to lift that exclusion and chart event paths directly —
e.g. with the **path family** dimension below. Drilling into an event-family `pathFamily`
value (e.g. "install") carries that option onto the filtered page it opens, so every chart
there — not just the one drilled — can show the event rows just filtered down to; the page
carries a caption explaining why (see [`src/lib/drill.ts`](src/lib/drill.ts)
`drillNeedsEventBeacons`).

**Return, game-completion and tutorial-completion rows are counts only: never split by hour,
place or device.** Rule: "counts only. Never tie beacon rows to a device, time or place." A geo
chart that maps rows (the map/globe), groups by an hour, place or device dimension (`hourEt`;
`country`, `region`, `city`, `postal`, `continent`, `timezone`, `colo`, `org`; `device`,
`browser`, `os`, `lang`, `screenw`, `screenwBucket`, `visitor`), or is drilled into one of them
leaves `/return/…`, `/game/complete/…`, `/game/complete-deferred/…` and
`/game/tutorial-complete/…` rows out entirely, whatever "Include event beacons" says. The rows
still count everywhere else: by path, by ET day or flight day, by campaign, and in the metric
cards. One visible effect: the **Arrivals by ET hour of day** chart no longer counts an arrival
whose first beacon was a return or completion row, so its total can sit slightly below the
flight-day chart's. The "hide known test and household traffic" filter is unchanged. See
[`src/lib/splitGuard.ts`](src/lib/splitGuard.ts).

**Every stored geo-beacon column is a chartable dimension AND a filter.** `functions/api/geo.ts`
whitelists every analytic `hits` column (`GEO_DIMS`) — region/city/postal/country/continent/
timezone/colo/org/referrer/refpath/path/site/device/browser/os/lang/visitor/campaign/source/
medium/date, plus **screen width** (`screenw`, exact pixels) and its bucketed form
(`screenwBucket`: `<480` / `480-767` / `768-1023` / `1024-1439` / `1440+`), plus a derived
**path family** dimension (`pathFamily`) that groups every event-beacon prefix above into
`page` / `signin-prompt` / `signin-eligible` / `promo-first50` / `first50-congrats` / `upsell`
/ `install` / `popup-outcome` / `return` / `game-complete` / `auth-status` / `auth-error` /
`auth-redirect` / `tour` / `game-first-move` / `game-abandon` / `welcome-signed-in`. More derived
dimensions: **pop-up** (`popupFamily`) and **pop-up outcome** (`popupOutcome`), measured rows
only (from the tracking activation day; pre-fix install-gap rows get no value — see
[`src/lib/popupEvents.ts`](src/lib/popupEvents.ts) `popupDimSqlCase`, where
`/popup-outcome/first50-offer/…` resolves to the first-50 promo); a completed game's **mode**
and **difficulty** (`gameMode` / `gameDifficulty`, from `/game/complete/<mode>/<difficulty>`,
malformed rows as `(other)`); **campaign flight** (`campaignFlight`, decided by the same
`campaignAttributionClause` + `EXCLUSIONS` the campaigns endpoint uses); **arrival** (`arrival`:
a first-ever beacon, `tagged` when a flight claims it, else `untagged`); and **key event**
(`keyEvent`: `auth-success` base rows, `install` from the install fix on, `raw-install-signal`,
`game-complete`); the **ET hour of day** (`hourEt`, `0`-`23`, DST-aware like `dateEt`); and the
**campaign flight day** (`flightDay`: `1` for the first ET day of the flight the row is
attributed to, as `campaignFlight` decides it, blank outside that flight's serving days). A
chart on `hourEt` shows all 24 hours, and one on `flightDay` by `campaignFlight` every day up
to the longest of its flights, so an empty bucket still has its place. A chart grouping by
one of the pop-up or completion dimensions counts those event rows without needing "Include
event beacons" (the standing exclusion would remove every row it describes), and never shows
unrelated rows as a "(none)" bar. Every derived dimension except `date` can be one of several
dimensions (a nested-doughnut ring, a breakdown bar's series); they're `CASE` expressions over
the row, built only from those modules' own constants — never request input — with every
literal passed through `sqlLit` (inlined rather than bound because a two-dimension chart would
otherwise pass D1's 100-bound-parameter cap). They filter exactly like a column — the same
whitelisted expression is compared as `(<expr>) = ?`, the value always bound. A
dimension or filter field name never reaches D1 unless it's a `GEO_DIMS` member — that Set is
the whole security boundary. **Never exposed:** `id` (row id), raw `ts` (only the `date`
bucket), `lat`/`lon` (map-mode coordinates only), and `in_app` (declared in gss-beacon's
schema, but its migration hasn't run against production yet — see
[docs/capacity.md](docs/capacity.md)).

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
npm run ads:sync -- --dry-run --cf-token-file <path-to-cf-token>           # the shared sync only
npm run ads:morning-read -- --dry-run --cf-token-file <path>               # daily read; no writes
npm run ads:postflight-read -- --stage wrapup --dry-run --cf-token-file <path>
npm run ads:backfill -- --dry-run --cf-token-file <path>                   # full re-pull + config check
npm run ads:morning-read -- --fixture <file.json> --now <iso>              # offline, recorded data
npm run -s ads:read-page -- --input <read.out> --narrative <n.json> --out <page.html> [--audit-commit <sha>]
npm run typecheck:scripts
```

- **Report page:** `ads:read-page` turns a saved morning-read stdout (report, `----- JSON -----`,
  JSON) plus the routine's narrative JSON (`headline`, `working[]`, `notWorking[]`, `soWhat[]`)
  into the self-contained HTML page the routine publishes (template:
  [`scripts/ads-reads/read-page.template.html`](scripts/ads-reads/read-page.template.html)).
  Any missing or failed sub-read shows as a "not read on this run" line; a missing JSON block
  or an incomplete narrative fails the build and writes nothing.
- **Spend** comes from the Google Ads REST API only (customer 8726535246, no manager
  header), and only through the shared sync (see [Ads data freshness](#ads-data-freshness)).
  Credentials are read from Bitwarden Secrets Manager with `bws` (needs `BWS_ACCESS_TOKEN`)
  into process memory and are never printed, logged or written.
- **Beacon reads** use `wrangler d1 execute gss-geo --remote --json --command`: single
  `SELECT`s only, enforced before wrangler runs.
- **Store:** gss-stats' own D1 database `gss-stats-ads` (spend per day, placement-day cost,
  an append-only readings log and fire-once threshold state). Why and how:
  [docs/adr/0001-ads-read-store.md](docs/adr/0001-ads-read-store.md). Schema:
  [`migrations/gss-stats-ads/`](migrations/gss-stats-ads/) (`npm run ads:migrate`).
- **morning-read** syncs spend first, fires each $25/$50/$75/$100 read once (full read + kill
  rules), appends one daily line per ET day, checks the hard cap on every read, notes any
  earlier scheduled read that never ran, and evaluates release health (a missing child of a
  non-zero parent) every run — there is no longer a time-of-day gate on it. RETIRED
  2026-09-27: release health used to be skipped between 01:00 and 12:00 ET so the run could
  defer to a separate 23:15 ET `--release-health-only` backstop entry; the two entries are now
  one daily run, and the `--release-health-only` flag survives only as a manual/diagnostic
  mode. Parent/child maturity is enforced by the run-independent `parentAgeHours` cutoff (event
  timestamps, not the clock), so removing the gate does not weaken it. Pushes go out only on a
  threshold read, a kill-rule trip, a failed read, or a real release-health alert (parent at
  least MIN_COHORT, outcome window elapsed, child zero). The threshold push names any kill
  rule on WATCH (e.g. `no kill rule tripped, WATCH (funnel-reach), continue`).
  **Kill rule 3 (funnel-reach)** trips on zero tagged asks. Zero tagged arrivals always trips.
  While the app's first-session ask beacon (`/signin-prompt/tutorial`) has no rows site-wide
  in the window, zero tagged asks from tagged arrivals with asks (the ASK_PATHS set) still shown
  site-wide reads WATCH instead (the campaign tag only rides beacons for 30 minutes, so
  later-session prompts go untagged). Once the tutorial ask has any site-wide row, the downgrade
  expires and the rule reads tagged asks only. The rule's detail line says which mode applied.
  Every morning read also prints a **first-session funnel** (arrivals → game views →
  tour start → tour complete/skip → first move → game complete, abandon-by-%-filled buckets,
  sign-in asks shown incl. the tutorial ask, and the signed-in welcome card), tagged counts with
  site-wide web counts alongside over the same window (attribution start to flight end or now).
  Arrivals are `/return/<uc>/d0` rows (one per device's first tagged visit): tagged = the
  campaign's own uc (web and app), site-wide = any uc on web. "Tracked" is decided per beacon
  family, since each family ships in one app release: tour + first move + abandon buckets; the
  welcome card; the tutorial ask. A family with no rows yet reads "not yet tracked", never 0%;
  once any member has a row, a sibling with none is a real 0. Ratios are rows over rows and never
  use game views (page views) as a parent. Informational only — never a kill rule or a push.
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
  first-50 claims in the flight window, `promos/first50` status, the cohort split), plus the
  `open` field of `promos_public/first50`: the doc the signed-out client actually gates its
  first-50 offer on (missing = hidden). The Accounts line reports the counter and the client
  offer separately, flags a disagreement, and reads `client offer UNKNOWN` if that one read
  fails (it never fails the read or changes a decision). The code can only make COUNT queries
  and two document GETs, but the prod key on this machine is not
  a read-only key (it holds `roles/editor`); pointing this flag at a key with only
  `roles/datastore.viewer` is an owner step.
- **Mid-flight instrumentation (the beacon freeze was lifted by the owner on 2026-09-26).** Two
  instants in `src/lib/adsRules.ts`, each `null` until the release coordinator sets it:
  `AUTH_NEW_EXISTING_LIVE_AT` (set: `2026-09-26T19:43:02Z`, v1.95.5; from then on tagged `/auth/success/<provider>/new` rows count as
  **exact** sign-ups, `/existing` rows never count, and `unknown` rows plus sign-ins with no
  status row stay in the "at most" part: min(those, new accounts in the window − exact new) +
  exact new) and `UPSELL_SIGNEDOUT_FIX_AT` (a funnel **segment boundary**: the $100 read and the
  post-flight reads report pre-fix and post-fix spend, asks, accepts and sign-ups separately,
  per spec section 14a's "two separate short tests"; beacon rows are split at the exact
  instant, and the fix day's spend is shown apart). **A sign-in is its base row only:** the
  status row `/auth/success/<provider>/<new|existing|unknown>` is sent ALONGSIDE the base row
  `/auth/success/<provider>` (providers `google` and `email`), so every auth-success count — the
  tagged funnel, the campaign and Overview cards (`/api/metrics`), the sign-up bound — matches the exact base
  shape, and the status split reads only the three-segment rows. A prefix match would count each
  new-client sign-in twice. Kill rule 3's asks now include the tutorial ask
  (`/signin-prompt/tutorial`) alongside placement, streak and the first-50 promo.
- **One reading per entry per day.** A reading is stored once per (campaign, ET day, entry
  kind: `morning`, `backstop`, `threshold-50`, `postflight-wrapup`, …). A same-day rerun is
  stored only when it carries new information (a complete retry of an incomplete read, a new
  pause proposal, a new release-health alert), and a threshold, cap trip or alert already
  pushed that day is not pushed again; a failed read always pushes. The database enforces it
  with a UNIQUE index (migration 0003).

### Adding a new campaign

Reading a new Google Ads campaign is a registry change, not a code change: no campaign id is
written anywhere outside the registry entries below (and fixtures, tests and the routine docs; plus the legacy `RETEST_CAMPAIGN_ID` export in
`adsRules.ts`, kept only for the external release-switchover helper: new code must not use it).
Several campaigns can be live at once. Do these in order. The numbering matters: step 1 comes
**before** anything is registered.

**1. Every campaign's routine doc must pin its own `--campaign`.** The command lines that run
the reads live in the routine docs under [`docs/routines/`](docs/routines/), not in the
scheduled-task prompts: the task prompts only say "read the doc and follow it", and each task
checks out `main` and reads the doc at run time. The retest is already pinned there
(`--campaign 24279250691` on the `ads:morning-read` line of
[`bsk-retest-morning-read.md`](docs/routines/bsk-retest-morning-read.md) and the
`ads:postflight-read` line of [`bsk-retest-postflight.md`](docs/routines/bsk-retest-postflight.md),
which serves all five stages), so registering a second campaign needs no edit to the retest's
routine. Why every doc must pin: without `--campaign`, a read defaults only when **exactly one**
campaign is registered (the same rule for the morning read and every post-flight stage). The
moment a second campaign is registered, an unpinned read exits 1 ("2 campaigns have read plans
… pass --campaign <id>") instead of reading. That is a loud failure, never a silent read of the
wrong campaign, but it would skip a scheduled run. A new campaign's routine docs (step 3) carry
`--campaign <its id>` from the first commit; if any doc or prompt for an existing campaign still
lacks the pin, pin it in the same PR as the registration.

**2. Register the campaign**, two edits, both in `src/lib`:

- **[`campaigns.ts`](src/lib/campaigns.ts) `CAMPAIGNS`** — one `CampaignFlight`: `id` (Google
  Ads campaign id), `label`, `ucValues` (the `utm_campaign` tags), `flightStart`
  (+ `flightStartTimeEt` if the schedule starts mid-day), `flightEnd`, `status`, `kind`,
  `dailyBudgetUsd` and `hardCapUsd` (both required to read it: they arm the pacing line and kill
  rule 4), `servingHoursEt`, `notes`, and `directionalThroughDay` if the first N flight days
  are directional. This alone puts the campaign on the dashboard and in the sync.
- **[`adsRules.ts`](src/lib/adsRules.ts) `ADS_READ_PLANS`** — one `buildReadPlan('<id>', {...})`:
  `channel` (`'display'`, the default, or `'search'`; see
  [Adding an arm](#adding-an-arm-two-campaigns-at-once) below),
  `thresholds` (the spend reads; the report page draws its ladder from them), `killRulesFrom`,
  `placementLeakMaxShare` (display only; optional and ignored for search), `ctrFloor`, `approvedPlacements` (display only), optional `adGroupPlacementCounts`
  (the build-spec counts the targeting diagnostic checks), `morningReadFirstEt` /
  `morningReadLastEt` (the morning-read window), and the two fields that keep two live
  campaigns' output apart:
  - `reportLabel` — the short name that leads the report header and every push/bus line
    ("`<reportLabel>` morning read …"). The retest's is `BSK retest`.
  - `auditSlug` — the audit-trail folder, `docs/marketing/google-ads/<auditSlug>/data/<ET
    date>.json`. The retest's is `retest`.
  Both must be unique across the registry; `campaignRegistry.test.ts` fails if two plans share
  one. Optional: `CAMPAIGN_DAILY_SPEND` and `CAMPAIGN_SPEND` in `campaigns.ts` (audit totals;
  unset reads as no config spend). The Worker bundles `campaigns.ts`, so redeploy it too (see
  [The sync Worker](#the-sync-worker-workerssync-gss-stats-sync)).

**3. Create the new campaign's own routine docs and scheduled tasks**, with `--campaign <new
id>` spelled out on the CLI command lines in the docs (never rely on a default again). A morning
read, daily across its `morningReadFirstEt` .. `morningReadLastEt` window. Five post-flight
tasks, one per stage, each on that stage's due date for the new flight end (the dates come from
`postflightDueDate(stage, flightEnd)` in `adsRules.ts`: flight end + 7, 15, 30 and 60 days, and
`december` at flight end + 62 days but no earlier than 2026-12-01). The existing routine docs
([morning read](docs/routines/bsk-retest-morning-read.md),
[post-flight](docs/routines/bsk-retest-postflight.md)) describe the retest's own copy of these
tasks (its dates, its audit path, its fixed Artifact link): copy them for the new campaign, with
its own dates, its own `--campaign` pin, the audit path above (the page builder derives it from
the plan, so leave `--audit-file` off) and its own Artifact link. The task prompts (outside this
repo) just point at the doc.

**4. Verify with fixtures before the first live read** (no network, no credentials), for each
campaign: `npm run -s ads:morning-read -- --fixture <file> --now <iso> --dry-run --campaign
<id>` and the same with `ads:postflight-read -- --stage <stage> … --force`. Check the header
and push text lead with the right `reportLabel`, and the threshold ladder shows that campaign's
read points.

**5. When the old campaign is done being read, add it to `CLOSED_CAMPAIGN_IDS`** (`adsRules.ts`).
What it changes: `readPlanFor` refuses the campaign for **every** read, morning and post-flight
alike ("campaign … is closed"), so no query, proposal or change can be built for it. What it
does **not** change: the campaign's `ADS_READ_PLANS` entry stays, and a closed plan still counts
as registered for the default, so with two plans registered an unpinned read still errors
rather than guessing: every routine doc stays pinned with `--campaign`. Because a closed
campaign's own pinned post-flight stages are refused too, add it only after its last scheduled
stage (december) has run, not when the flight ends. A campaign that must never be read at all
goes straight into `CLOSED_CAMPAIGN_IDS` instead; a new one never does.

**Which campaign a read runs on.** `--campaign <id>` always wins, and must name a campaign in
`CAMPAIGNS`: an empty value (an unset shell variable), a flag with no value, or an unknown id is
an error listing the registered ids, never a fall-through to the default. Without the flag, one
rule for `morning-read` and every `postflight-read` stage: the read defaults to the plan **only
when exactly one campaign is registered in `ADS_READ_PLANS`**, closed ones counted. Nothing about
dates, windows or status is inferred: a late or forced rerun, or an old unpinned task run after
a newer campaign's window or due date, would otherwise silently read the wrong campaign. Zero or
two or more registered plans: exit 1, listing the registered ids and saying to pass
`--campaign`.

While only the retest is registered, the default is the retest on every date, so every
invocation that omits the flag (before, inside or after its morning-read window, and every
post-flight stage) behaves as it did before the registry (checked by running every routine
invocation against the base and the head: only `--help` differs). The retest's routine docs
pin it anyway (step 1).

### Adding an arm (two campaigns at once)

A test arm is one campaign, added with the steps above. Two arms running together are two
`CAMPAIGNS` entries and two `ADS_READ_PLANS` entries, each read on its own: its own spend,
thresholds, cap, report label and audit folder. Fill in one block per arm:

| Field | Where | Arm A example | Arm B example |
| --- | --- | --- | --- |
| Campaign id | `CAMPAIGNS` `id`, the `ADS_READ_PLANS` key | `<arm A id>` | `<arm B id>` |
| utm tag | `CAMPAIGNS` `ucValues` | `sudoku_funnel_f2_apps` | `sudoku_funnel_f2_search` |
| Channel | plan `channel` | `'display'` (the default) | `'search'` |
| Placements | plan `approvedPlacements` | the 17 `RETEST_APPROVED_PLACEMENTS` | none (omit) |
| Leak limit | plan `placementLeakMaxShare` | `0.1` | none (omit; ignored for search) |
| CTR floor | plan `ctrFloor` (kill rule 2) | `0.0015` (0.15%) | `0.01` (1.0%) |
| Start / end | `CAMPAIGNS` `flightStart` (+ `flightStartTimeEt`), `flightEnd` | start, start + 6 days | same |
| Budget / cap | `CAMPAIGNS` `dailyBudgetUsd`, `hardCapUsd` | `$50` cap over 7 days | same |
| Label / audit | plan `reportLabel`, `auditSlug` (unique) | e.g. `F2 apps`, `f2-apps` | e.g. `F2 search`, `f2-search` |
| Read window | plan `morningReadFirstEt`, `morningReadLastEt` | day 2 .. end + 1 | same |

Why the search CTR floor is higher: a search arm buys exact and phrase keywords on a narrow
set, so CTR under 1% means the ad is showing on irrelevant queries or losing on ad rank. The
display floor would effectively never trip on search.

What the channel changes. A **display** arm reads placements (`group_placement_view`) and runs
kill rule 1 (spend outside the approved list), the off-list lines, approved-vs-itemized cost and
the placement-count, optimized-targeting and computers/TV device checks. A **search** arm has no
placements: the sync never pulls them, kill rule 1 reads `[n/a] placement leak: n/a (search
campaign)`, the report's Placements line and the targeting check say the same, and the device
mix is printed without the mobile-app anomaly; instead, because a search arm is desktop-only,
any spend on MOBILE, TABLET, CONNECTED_TV or OTHER on the closed day is flagged as an ANOMALY to
propose to Mike (a printed flag only, from Google Ads' own device segment, never a kill rule;
it covers that one day, not the flight so far). Never a pass, never a trip. A search plan that
sets `approvedPlacements` or `adGroupPlacementCounts` is refused at load. Spend, impressions,
clicks, CTR (rule 2), funnel reach (rule 3), the hard cap (rule 4) and every beacon count read
the same for both channels.

With two plans registered, **every** read must name its campaign: omitting `--campaign` exits 1
and lists the registered ids. One line per arm, in each arm's own routine doc:

```bash
npm run -s ads:morning-read -- --campaign <arm A id>
npm run -s ads:morning-read -- --campaign <arm B id>
npm run -s ads:postflight-read -- --stage wrapup --campaign <arm A id>
npm run -s ads:postflight-read -- --stage wrapup --campaign <arm B id>
```

(The same for `day15`, `day30`, `day60` and `december`; dry-run either with `--fixture <file>
--now <iso> --dry-run` first, as in step 4.) The Worker bundles `campaigns.ts` and the read
plans, so register any arm, then redeploy the Worker, or its cron and Refresh won't sync that
arm; the CLI reads still work (they sync for themselves).

## Ads data freshness

Every path that needs Google Ads metrics runs **one** function,
[`syncAdsData`](src/lib/adsSync.ts): the morning read, the backstop, the post-flight read,
the backfill (`--full`), `npm run ads:sync`, and the **gss-stats-sync** Cloudflare Worker
(cron + on demand, below). Per campaign it:

1. reads the stored days from `gss-stats-ads` (one query for every campaign);
2. pulls every **missing closed ET day** of the flight plus the **last 3 closed days**, which
   Google still restates (daily metrics and placement-day rows), in at most two date ranges,
   **newest first**: the last 3 days whole, then any older gap from its first missing day up to
   them (after-flight days in between come along, so after-flight spend shows up). Each range
   is checked and written on its own, so a bad old day never holds back newer ones. The
   restatement window is re-checked at most every 6 hours per campaign by the Worker and
   `ads:sync`, and on **every** morning, backstop and post-flight read (a read never decides on
   a yesterday pulled hours earlier); only a pull of all 3 days counts as a re-check. A day counts as **closed** once it was pulled at or after 03:00
   ET the next day (Google still adds late data just after midnight). A closed campaign is
   covered through its flight end and then costs no API call;
3. stores a day the API returns nothing for as zero only when Google's **range total** (one
   aggregate query, made only when a day came back empty) agrees with the daily rows: a
   never-stored flight day becomes $0, and a stored day Google credited in full is restated to
   $0. When the rows and the total disagree, the range is pulled again in halves, newer half
   first, down to single days: the bad day keeps its stored value and is reported, the days
   around it are written. An empty response (no rows, no total) never overwrites stored spend.
   A stored placement row with spend that a response leaves out fails the placement pull within
   the last 3 days; on an older day it is kept as stored and reported as a warning;
4. writes **only rows that changed**; a run with nothing due makes no Google call and writes
   nothing at all, so a second run right after another is a true no-op;
5. records each run that did something in `ads_sync_runs` (start/finish, campaigns, days fetched
   and changed, status, a redacted error).

Today's still-open day is never stored. The Ads client (plain `fetch`) and the store
(`createSqlAdsStore` over a wrangler-CLI adapter locally, a D1-binding adapter in the Worker)
are runtime-agnostic, so the local routines and the Worker run the same code; whichever runs
second finds nothing to write.

The campaigns page's cost card (preset `campaign-cost`: registry metrics `campaign.spendThrough`
and `campaign.lastSync` over the facts `adsCoverage` and `adsLastSync`, the same two reads) and
the readings widget (`/api/ads/readings`) show **"Spend through &lt;date&gt;"** and **"synced
&lt;relative time&gt;"** per campaign, and **"stale — sync pending"** when a flight day that should be stored
by now is missing: yesterday from 09:30 ET (the 08:00 ET morning read has synced by then),
otherwise the day before. A sync run that claimed and never finished (killed mid-run, e.g. by
a CPU limit) shows as a **"Sync alert"** line in the readings widget once it is 15 minutes old
(for 7 days), and the morning, backstop and post-flight reports print it as `SYNC ALERT`. Their **Refresh data** button posts to `/api/ads/refresh` (behind
the sign-in gate), which asks the sync Worker to run only when something is stale, at most once
per 10 minutes. The dashboard holds no Google Ads credential and never calls the Ads API.

### The sync Worker (`workers/sync/`, `gss-stats-sync`)

- **Schedule:** a cron at :05 every hour. While a flight is live (first day through the day
  after the last) every tick checks what is due: yesterday once, at 03:05 ET (before 03:00 ET it
  cannot close yet, so it is not due), a retry after a failure, and the restatement window once
  its last pull is 6 h old. Outside a flight only the 03:05 ET tick checks. A tick with nothing due reads two small queries and stops: no
  claim, no secret read, no token refresh, no write.
- **On demand:** `POST /sync`, reachable only through the Pages Service Binding `ADS_SYNC`:
  the Worker has no `workers.dev` URL, no preview URLs and no route. Nothing due → 200 "up to
  date". Otherwise it claims atomically (a `'running'` row, only if no run finished in the last
  10 minutes); a concurrent request loses and gets 429. Operator body: `{"full": true,
  "campaignIds": [...], "maxDays": n}`. A full re-pull through the Worker is capped like any
  run (`maxDays`, default 7, at most 31), keeps the newest days and is **not resumed** by later
  runs (they pull only missing days): give a `maxDays` that covers the window, or run
  `npm run ads:backfill` / `npm run ads:sync -- --full` locally, which are uncapped.
- **Per-run caps (Workers Free, 10 ms CPU):** at most 7 closed days (live campaigns first, the
  last 3 days before an older gap, and an older gap's newest missing days first) and 40 D1
  statements; the rest continues next run. Measured live: a no-op 1-4 ms CPU (6 ms on a
  fresh isolate), a 1-day pull 9-10 ms warm and 12.6 ms cold, so a cold pull can overrun Free's
  limit (ADR 0001: what then happens, and why Workers Paid removes it).
- **Deploy:** `npm run ads:worker-deploy -- --cf-token-file <path> [--paused]` stamps the version
  with the git SHA (tag, message, and the `GIT_SHA` it reports with a hash of every campaign
  field the sync writes: name, kind, flight, status, uc values, budget, cap, measurement); `--paused` deploys with no cron. The Worker bundles `src/lib/campaigns.ts`, so a
  new campaign needs a Worker redeploy as well as a Pages deploy. **That now happens on merge
  to `main`** (the `deploy-worker` job, see [Deploy](#deploy)); the manual command stays for a
  paused/held deploy. The dashboard's Refresh says when the Worker runs other campaign
  definitions, and CI bundles it on every PR (`npm run ads:worker-check`).
- **Secrets:** the four Google Ads credentials live in Cloudflare **Secrets Store** (account
  store `default_secrets_store`, secret names = the Bitwarden key names, scope `workers`),
  bound as `ADS_CLIENT_ID`, `ADS_CLIENT_SECRET`, `ADS_REFRESH_TOKEN`, `ADS_DEVELOPER_TOKEN`.
  Bitwarden stays the source of truth. **Rotation:** rotate the credential in Bitwarden, then
  run `npm run ads:worker-secrets -- --cf-token-file <path>`: it reads the values with `bws`
  into memory and pipes a new secret into `wrangler secrets-store secret create` on stdin, or
  updates an existing one through the same Secrets Store API call wrangler uses (wrangler's
  `update` can't take a value on stdin non-interactively). Nothing is printed, logged or
  written to disk; the Worker picks the new value up on its next run, no redeploy. The local
  routines keep reading Bitwarden directly.

## Docs

| Area | Entry point |
|---|---|
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Contributing / conventions | [CLAUDE.md](CLAUDE.md) |
| Auth design (ADR) | [docs/adr/0002-google-auth.md](docs/adr/0002-google-auth.md) |
| Ads store decision | [docs/adr/0001-ads-read-store.md](docs/adr/0001-ads-read-store.md) |
| Metric components design (ADR; registry and endpoint built, cards pending) | [docs/adr/0003-metric-components.md](docs/adr/0003-metric-components.md) |
| Ads routine prompts | [docs/routines/](docs/routines/) |
| Geo beacon (companion) | [GoodStuffSoftware/gss-beacon](https://github.com/GoodStuffSoftware/gss-beacon) |
| Capacity / free-plan limits | [docs/capacity.md](docs/capacity.md) |

## Capacity

The account runs on **Workers Free**, where D1 caps reads at **5,000,000 rows/day, account-wide**
(a hard failure, not throttling, once hit) — shared by `gss-geo` and `gss-stats-ads`. A 2026-09-26
audit ([docs/capacity.md](docs/capacity.md)) found usage at ~29% of that cap on an ordinary day,
driven entirely by query pattern against a table of well under 5,000 rows: `/api/sites` full-
scanned `hits` on every dashboard load, and every chart fired a "total" query plus a "grouped"
query. Mitigations (`functions/_lib/edgeCache.ts`, `functions/api/geo.ts`, `functions/api/sites.ts`):

- `/api/sites`'s beacon-count query is bounded to a rolling 90-day window (it's a UI relevance
  badge, not an all-time total — see the "last 90 days" tooltip in the filter picker) and its
  whole response is cached via the Workers **Cache API** (`caches.default`, not KV — KV's
  Free-plan write cap is 1,000/day account-wide) for a few minutes.
- Each geo chart's total-count and grouped-breakdown queries are merged into one statement
  (`GROUP BY` subquery + `SUM(c) OVER ()`), halving the D1 reads per chart.
- `/api/geo` and `/api/stats` responses are cached (Cache API, keyed by the full normalized
  query) with a long TTL for date ranges that end before today (immutable — they can't change)
  and a short TTL for ranges that include today.

- `/api/metrics` caches per fact (90 s while live, 15 min for a closed campaign, 24 h for a closed
  flight window), so one fact read serves every card and page that shows it; a representative
  Overview batch reads about 10,000 rows uncached against about 14,100 for the same sections of
  the retired `/api/overview`, and a full Campaigns page batch is measured in docs/capacity.md §8.

No index changes and no schema/data writes were needed — see docs/capacity.md §4 for why (the
`hits` table is too small for an index to matter, and `GROUP BY` requires a temp b-tree
regardless).

## Deploy

**On merge to `main`** — GitHub Actions ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml))
runs the tests (`npm test`), then builds and publishes to Cloudflare Pages automatically, on
GitHub's runners (nothing local); a red test stops the deploy. Pull requests run the same
tests and build ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
One-time setup: add a repo secret **`CLOUDFLARE_API_TOKEN`** (Settings → Secrets and variables
→ Actions) — a Cloudflare token with **Cloudflare Pages: Edit**. The runtime `CF_ANALYTICS_TOKEN`
and the sign-in settings ([Auth](#auth)) are Pages *project* secrets and aren't needed by the
workflow (deploys keep existing secrets).

**The sync Worker deploys on merge too** — a second, independent job (`deploy-worker`) in the
same workflow, so a Worker failure never fails or blocks the Pages deploy. It runs
`npm run ads:worker-deploy` (SHA-stamped, cron attached; the Google Ads credentials stay in
Secrets Store, nothing secret is needed in the workflow) when a push to `main` changes
`workers/sync/**`, any non-test file under `src/lib/**` (the Worker bundles `campaigns.ts`
and its other imports from there), `package-lock.json` (the pinned wrangler), the root `tsconfig.json`, `scripts/ads-reads/worker-deploy.ts`
(stamping and cron) or `deploy.yml`. Other pushes skip it; **Actions → Deploy → Run workflow** always deploys
it, but only when run on `main` (the job is skipped on any other branch). The job
authenticates with the optional repo secret **`CLOUDFLARE_WORKERS_API_TOKEN`** and falls back to
`CLOUDFLARE_API_TOKEN` when it is unset, so a Worker-capable token can be added without touching
the Pages secret. Whichever it uses needs **Workers Scripts: Edit** (account), plus **Secrets
Store** access if the deploy fails on the `secrets_store_secrets` bindings in
`workers/sync/wrangler.toml`; the Pages token alone may have neither. A failed deploy logs an
error naming both secrets. Worker deploys queue (one at a time, never cancelled mid-flight); if
three Worker-touching pushes land while one is deploying, the middle one's change is only picked
up by the next Worker-touching push or a manual run. A Worker deployed by hand with `--paused`
gets its cron back on the next automatic deploy, **unless you set the repo variable
`WORKER_DEPLOY_PAUSED` to `true`** (Settings → Secrets and variables → Actions → Variables): the job
then logs that it is paused and deploys nothing, on pushes and manual runs alike, until the
variable is removed or set to anything else.

**Manual** (local fallback / preview), with the token from a local, gitignored file:

```powershell
$env:CLOUDFLARE_API_TOKEN = (Get-Content "<path>\cf-token.txt" -Raw).Trim()
npm run deploy      # = vite build && wrangler pages deploy
```

Single Cloudflare account — no account-ID env needed. Pages project: **gss-stats**.

### Restoring a layout backup

The saved dashboard layout lives in KV (`STATS_CONFIG`, key `dashboard:default`). Each time a
release bumps the layout version (`CONFIG_VERSION` in `src/lib/defaults.ts`), the first save
of the migrated layout first copies the layout that was stored until then to
`dashboard:default:backup:v<stored version>`, once, and never overwrites that copy
(`functions/api/config.ts`; if the backup can't be written, the save fails and the old layout
stays). The backup is named after the version that was **stored**, not the one before the new
code: a layout still stored at v8 when v11 ships is backed up as `backup:v8`, one stored at v10
as `backup:v10`. A tab still
running older code gets `409` ("This tab is out of date, reload") instead of overwriting a
newer layout.

**Rolling the code back needs the layout rolled back too.** An older release refuses to save
over a newer stored layout (409), so after rolling back to v0.9.0 (layout v9), for example,
every save fails until the stored layout is back at the version that release writes.

To put a backup back, in this order:

1. **Close every dashboard tab**, on every device. An open tab saves its in-memory layout on the
   next change and would overwrite what you restore.
2. **Roll back or fix the code first.** If the deployed code still has the bad migration, the
   next load migrates the restored layout again. Either redeploy the previous release or ship
   the fixed migration.
3. **Find the backup to restore**: list the backup keys, and pick the version that was stored
   before the upgrade (the highest one below the current `CONFIG_VERSION`: `backup:v8` if
   production was still stored at v8, `backup:v10` if a v10 save happened first). Namespace id
   from `wrangler.toml`; a token with Workers KV Storage: Edit.

   ```bash
   npx wrangler kv key list --remote --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --prefix "dashboard:default:backup:"
   ```

4. **Download it, keep a copy of what's there now, and check the file before writing it back**:
   it must be non-empty, valid JSON with a `pages` array. Only then put it.

   ```bash
   npx wrangler kv key get "dashboard:default" --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --remote > layout-current.json
   npx wrangler kv key get "dashboard:default:backup:v8" --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --remote > layout-backup.json
   node -e "const c=JSON.parse(require('fs').readFileSync('layout-backup.json','utf8')); if(!Array.isArray(c.pages)||!c.pages.length) throw new Error('not a layout'); console.log('ok: version', c.version, '-', c.pages.length, 'pages')"
   npx wrangler kv key put "dashboard:default" --path layout-backup.json --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --remote
   ```

5. Open one tab and check the layout before opening any others.

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

**Worktree agents and the Claude Desktop Browser pane.** `.claude/launch.json` intentionally
defines **no** `preview_start` configuration. A Browser-pane preview command's working directory
resolves against the project root that started the Claude Code *session*, not the cwd of a
subagent running in its own `git worktree` — so a worktree agent's `preview_start` call (or any
preview tool call with no explicit `tabId`) would silently run `wrangler pages dev` rooted at the
**main checkout**, on its real `.dev.vars` (a real `CF_ANALYTICS_TOKEN`), on the same port `8788`
every other worktree session shares. A worktree agent should instead:

1. Create its own `.dev.vars` in its worktree (`Copy-Item .dev.vars.example .dev.vars`, or your
   own test values — never the main checkout's).
2. Run `npx wrangler pages dev --port <own port> --ip 127.0.0.1` from its own worktree directory,
   picking a port other than `8788` (which the main checkout's own manual `npm run preview` may be
   using).
3. Pass that worktree's own explicit `url` and `tabId` to every `preview_*` tool call — never the
   default/no-`tabId` tab, which may belong to another session.

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
