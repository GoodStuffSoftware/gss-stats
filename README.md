# gss-stats

Bot-free traffic dashboard for **Good Stuff Software**. A custom UI on top of
Cloudflare's **RUM** (Real User Monitoring) data — the same human-only dataset that
powers Web Analytics — plus a companion **geo beacon** for the sub-country geography
RUM doesn't provide, rendered as a movable/composable dashboard you control.

🔒 Live at **https://stats.goodstuff.software** — the owner, plus any [view-only](#view-only-access) viewers, behind Google sign-in (see [Auth](#auth)).

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

- **Best Sudoku / Overview** — the Best Sudoku group's first page: today-at-a-glance KPI tiles (today so far, with
  "vs yesterday" and "vs 7d avg" arrows at the same clock time, except for counts-only rows: see *KPI
  tiles for counts-only rows* below), the **Overall timeline**, a campaign scorecard, and a
  release before/after panel — each its own movable/editable widget. The KPI tiles and the
  scorecard are **metric cards** (presets `bsk-kpis` and `campaign-scorecard`, see *One metrics
  registry* below), and so is the release panel (preset `release-before-after`: the newest release
  with a full ET day after its release date; `days` whole days before its ET midnight and `days`
  after the following midnight, the release day itself excluded, bounded
  by the first Best Sudoku hit, as [`src/lib/overview.ts`](src/lib/overview.ts)
  `releaseComparisonWindows` decides). The Overall timeline is a **standard line
  chart** (see *Line charts* below) with five series — page views and tagged arrivals on the left
  axis, auth successes, installs and raw install signals on the right — over the page's date
  range and Best Sudoku sites, with campaign-flight bands, release markers and go-live markers
  on. It buckets by **US-Eastern day** (the `dateEt` beacon dimension, "Date (trend, ET)":
  DST-aware, the same days as `etDateFast` and the flight bands and markers), where the plain
  `date` dimension is a UTC day. **Web vs app activity** (last card on the Overview) shows how much activity each platform gets: page
  views per ET day, one line for the website (`bestsudoku-web`) and one for the app
  (`bestsudoku-app`). Every feature card (coach tips, tour, pop-ups, game starts and completions,
  hints, mode × difficulty) counts web and app together by default; the beacons still carry the
  site tag, and a chart can still be scoped to one site from its editor, but no default does. The
  Traffic page's "Web vs app" doughnut is the all-time share of page views by site for the chosen
  range, not a per-day trend. `site` is not a split-guard dimension (an ET-day count of page views
  is not an hour, place or device split).
  Every default Traffic card hides known test and household traffic (`excludeKnownTraffic`), the same
  exclusion Overview's "Today at a glance" always applies, so on whole ET days the two page-view counts
  agree. The windows still differ, by definition: Traffic's "1d" is the last 24 hours, the glance is today
  since ET midnight, which the Pageviews card's caption says (a new Traffic page only: Reset keeps a page's existing cards). A layout saved before this keeps its cards as
  saved (no layout version bump, nothing is rewritten on load); the setting is changed in the chart editor.
  Beacon data has no visit count, so the v4 beacon re-point (`beaconizeWidget`) retitles a "Visits" card
  "Pageviews" rather than leave a second, identical "Visits" card.
  [`src/lib/releases.ts`](src/lib/releases.ts) holds the hand-entered release dates (`hits` has
  no app-version column; major releases get a labelled line, minor ones a short tick). The v1.99.1
  web release (live 2026-10-16 21:07Z) is a labelled marker that carries the v1.99.0 content, since
  v1.99.0 never went live on its own and so has no marker; the release panel takes the newest
  release, v1.99.2 on that same day. The one Play-store marker is `v1.99.2 Play` (2026-10-17: committed to Play production at 22:49 ET 10-16, reaching users once Google's review clears). The `v1.99.4 web` (2026-10-18: live 14:57:49Z) and `v1.99.4 Play` (promoted 15:15:55Z, 19904) markers are plain release markers in `releases.ts`, not measurement changes: the beacon is unchanged. The `v1.103.0 web` marker (2026-10-26: live 22:19:36Z) is likewise plain; it is when the first-finish and chunk-reload rows begin, and the `v1.103.0 Play` marker (2026-10-26: promoted 22:28:21Z, 1103000) follows it. The `v1.104.0 web` (2026-10-27: live 17:04:17Z) and `v1.104.0 Play` (promoted 17:18:40Z, 1104000) markers are plain too; guests now see pass prices on the paywall, so a guest's pass tap counts as "Pass tapped, sign-in first" and Paywall shown rises, and `v1.104.0 Play` is followed by the v1.105.0 markers. The `v1.105.0 Play` (2026-10-28: promoted 21:55:45Z, 1105000) and `v1.105.0 web` (live 21:58:36Z, listed last so it is the newest) markers are plain too; the one counting change is the hidden `v1.105.0` entry in `measurementChanges.ts` (`errorRowsOnly`, no marker or caveat of its own): a single transient sw.js update failure goes to `/app/error/sw-update-transient` instead of an error row, so sw-update error rows fall.
  [`src/lib/measurementChanges.ts`](src/lib/measurementChanges.ts) marks a day when *how we count*
  changed (v1.99.2's sign-in first-touch fallback): its one `dateEt` is entered by hand once the
  version is live (dated 2026-10-16 for the web). The Play release of v1.99.2 is a
  second entry with its own `dateEt` (2026-10-17) (the notes registry has no per-arm targeting, so it uses the
  same caveat under the tagged cards, listing both days). Once set, the timeline marks the
  day, the tagged auth-success and new-account cards carry a caveat that the rise is partly
  measurement, and the ads read reports print a marker line on that day and a "since" line after it.
  The v1.99.3 coach-strip meaning change (× closes one tip; a written note ends the notes tip) is a
  separate `v1.99.3 web` entry (dated 2026-10-17: live 05:58:55Z, 01:58 ET, before the first flight-3 serve; its note also lists the release's reset/duplicate fix, cross-device pop-up notices, no mid-game reloads and the save after email verification, and says notes-tip completions are not counted after it) plus a `v1.99.3 Play` entry (both coach-only; the Play one is dated 2026-10-17, promoted to production 06:09:41Z = 02:09 ET and public on Google Play 06:34Z 10-17, and carries no install caveat; Android beacons carry no app version, so Android coach rows after it mix old and new semantics until updates spread): it marks the timeline
  and shows only on the coach readouts (Coach tips card, Feature health Coach row, the report's
  tagged coach line), never under the auth-success cards.
  The `v1.103.0 Android` entry (dated 2026-10-26: Play production 22:28:21Z, versionCode 1103000) is
  `authErrorOnly`: native Google sign-in cancels move from the no-code row to the user-cancelled row,
  while older Android installs keep sending cancels as no-code until they update. It adds a dated
  caveat under the card with the Sign-in failures tile (Today at a glance, the only card with the
  `bsk.authErrors` metric; the total counts every code, so it does not change) and nothing else: no timeline marker of its own (the plain
  `v1.103.0 Play` marker is the one for that release), and never the auth-success caveat, the coach
  readouts or the read reports.
  Best Sudoku / Campaigns (its funnel, country, cost and return-visits panels are metric
  cards, presets `campaign-funnel`, `campaign-country` — a table with the funnel steps as rows
  and US / CA / Other as columns, each cell a campaign metric with the registry's optional
  `country` param; it has no "Completed a game" row, because completions take no `country`
  param (counts only, below), and a card that puts a country split over such a metric is
  refused — `campaign-cost` and `campaign-returns` — d0 and each return window's rate,
  dN over d0 with its n/d, as bars side by side. A campaign's return rows count from the web
  site and the installed app (`bestsudoku-app`) alike, from its attribution start (each counts
  its own installs, so a phone that used both counts once on each). After the
  campaigns comes one more row, "Organic (web)": the `/return/organic/` rows the web site sends
  for untagged visitors, never app rows, as a baseline to read the
  campaigns against. Organic means a device's first-ever web visit with no utm and no ad click id
  (so a gclid visit is not organic); first touch wins, and a malformed utm counts as neither. Organic
  and campaign d0 are disjoint. It is tracked from v1.98.0 (2026-10-03): earlier ranges read "not yet
  tracking", and after that it stays hidden until its d0 count is above zero. It never enters the
  site-wide "Return visits (day 1+)" tile or the routine's site-wide arrivals, which stay
  tagged-only. Return rows are counts
  only — never split by hour, place or device. "Arrivals by ET hour of day" and "Daily
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
  and Best Sudoku / Traffic (per-site/geo/referrer/device detail beyond what Overview and
  Campaigns cover) round out the Best Sudoku group, in that order (see *Page navigation* below).
  Below the notes, "Flight 3 Apps: No ads (hero) vs Features" is a donut of the Apps arm's arrivals
  per ad landing tag (`landingTag`: `sudoku_funnel_f3_apps_hero` "No ads (hero)",
  `sudoku_funnel_f3_apps_feat` "Features", and the bare `sudoku_funnel_f3_apps` as a small "Untagged"
  slice only when it has arrivals). A slice is the `/return/<tag>/d0` arrival rows over the card's own
  range (since the first campaign; the page has no filter bar), the legend reads "Label · count · share"
  with the share taken over the plotted slices, and the note under it says a slice counts d0 devices,
  which differ from the report's arrivals (first-ever tagged rows), and that the ads may not rotate
  evenly (check the report's impressions balance before reading the share as how well each ad
  converts). A saved layout still carrying the old caption gets the new one on load; an edited caption
  is left alone. It is counts only: no cost and no
  impressions, because the ads sync keeps campaign-level spend, not per-ad. Flight 3 is live (the Apps
  arm's dates in `STAGED_FLIGHT_3_DATES` are filled, so it is in `CAMPAIGNS`), so the card draws the
  donut. Only if no registered campaign carried these tags (a staged arm, its dates null) would it read
  "Flight 3 isn't live yet" and send no query. Like every `/return/` read it is whole ET days and never split by hour,
  place or device. The card is in the defaults only; a saved layout gets it by adding the widget.
  The legend shares come from the chart editor's **Show each slice's share in the legend** option
  (`Widget.showShares`, doughnut and pie only; saved as an explicit true or false), which the
  landing-tag dimension turns on by default, so this donut looks the same with no saved change. The
  slice labels, colours and the not-live text belong to the dimension's definition
  (`DimensionDef` in [`src/lib/catalog.ts`](src/lib/catalog.ts): `valueLabel`, `valueColors`,
  `sharesByDefault`, `unavailableText`), not to code that names the dimension; another dimension
  gets the same behaviour by declaring those traits. Shares also work on a doughnut or pie with a
  breakdown.
- **Movable / composable charts** — drag the header, resize from the corner; add /
  edit / duplicate / delete charts of any type: stat, bar, horizontal bar, stacked
  bar, **breakdown bar** (one dimension on the axis × another as the series, grouped or
  stacked — `Widget.barMode`), line (over a non-date axis, a breakdown draws one line per
  value, and `Widget.cumulative` adds each one's running total dashed on a right-hand axis),
  area (a breakdown stacks one area per value), doughnut, nested doughnut, pie, table, a geo point
  map, and a note/text tile. A breakdown never drops on a type switch: bar, horizontal bar,
  doughnut, pie and table draw one bar / slice / row per dimension × breakdown pair, labelled
  `<dimension> · <breakdown>` (`pairRows` in `src/lib/charts.ts`), and the editor says so (a click drills on the pair's first value). Which widgets can carry a breakdown is one check, `breakdownCapability` in `src/lib/catalog.ts` (the pop-up data source and a date axis cannot; the editor warns before Save removes a stored one). A pie or doughnut's legend title names what a slice is (`Mode · Difficulty` for pairs, `Mode` alone without a breakdown), and a breakdown bar, line or area's names its series. Break down by never offers the Group by dimension itself, and a completions chart does not offer the world map. **Reset to default** in the editor fills in a built-in chart's factory settings (`factoryWidget` in `src/lib/defaults.ts`; only on a page with its own default set), keeping its place on the grid; Save keeps them, Cancel leaves the chart as it was. Zoom is a single click, always available on every chart; its other
  modification chrome (edit/remove/drag/resize) tucks away until you hover that chart
  — or tap that chart's own reveal icon on touch, which has no hover.
  **Known gap:** the resize grip (drag-to-resize corner) isn't keyboard-operable — it's a
  [`grid-layout-plus`](https://www.npmjs.com/package/grid-layout-plus) limitation, not a
  regression from this app's own code. Resizing a chart currently needs a mouse or touch;
  every other chart action (edit, remove, zoom, duplicate, set-as-default) has a real
  button and works from the keyboard.
- **Sparkline display** — a card's count or money item can be shown as a **Sparkline**: the
  current number, with a small per-day line beside it. The server counts the same metric per ET
  day from a daily twin of its fact
  ([`src/lib/metrics/series.ts`](src/lib/metrics/series.ts); at most 92 days, oldest first) and
  [`MetricItem.vue`](src/components/metrics/MetricItem.vue) draws it
  ([`sparkline.ts`](src/lib/metrics/sparkline.ts)). It reads the page range or a campaign's
  attribution window (not "today so far"), never a ratio, rate or cost; the editor greys the
  option with the reason otherwise. A day the metric was not measured (before a go-live, or an
  unsynced spend day) is a break in the line, never a zero; a measured day with no rows is 0. A
  money series rounds each day to cents, so its points can differ from the tile's total by a cent
  or two. A sparkline item has a **List the days** checkbox in the card builder (`days: true`) that
  prints the latest 14 ET days with their counts under the line. Days only: no hour, place or device split (a `/return` or game-complete row gets no
  more than the day's count and the kind the tile already reads). Each series is one extra
  statement per distinct twin read (items that share a window share it) against the 40-statement
  batch budget ([`docs/capacity.md`](docs/capacity.md) §9). Layout version 14 was a save
  guard only (page navigation holds 13): the first save from that build backed the stored v13
  layout up once, and a tab still on the old build is told to reload; nothing is rewritten.
- **Full width** — there's no centred max-width column: the header (a strip across the window),
  the filter bar and the chart grid span the window with a 16px gutter (12px on a phone), so a
  wide screen shows wider charts, and the pinned filter bar (below) spans it too.
- **Fit height to content** — a card's editor has a "Fit height to content" checkbox (next to
  the display and size controls) that sets `Widget.fit: 'content'`. A fit panel's height then
  follows what it renders: the dashboard measures the bottom of the card's last in-flow child
  ([`src/composables/useFitHeight.ts`](src/composables/useFitHeight.ts), a `ResizeObserver` on
  the card's children, never on the card itself) and sets the grid height `h` to the fewest
  whole rows that hold it ([`src/lib/fit.ts`](src/lib/fit.ts) `fitRows`: `h` rows are
  `h*40 + (h-1)*14` px, minimum 3), so the card is neither clipped nor scrolling, and it
  grows or shrinks as data arrives or captions appear. A fit card has no resize grip (its
  height is the content's) and the option is not offered on canvas charts (bar, line, pie,
  map, ...), which have no content height of their own; metric cards, stat tiles, tables and
  notes can use it. It is off by default and absent from every existing layout, which render
  exactly as before: no storage migration and no `CONFIG_VERSION` bump. On a phone
  (<= 700px) the one-column stack sizes itself, so the measurement is not written back to the
  desktop `h`; a zoomed card is not fitted either. The last fitted `h` is saved as an ordinary
  height, so turning the option off keeps the card at that size. The height is measured with
  the card's layout box (not its on-screen rect, so the zoom animation cannot inflate it), is
  reported only after the content has been quiet for 300ms (data that loads in two steps saves
  once) and never from a hidden or detached card; a layout equal to the one last loaded or
  saved is not written back. The fitted `h` depends on the card's width (text wraps), and the
  layout is shared: two tabs open at different widths each compute their own `h` and the
  last save wins.
- **The main filter bar is always visible**, in normal flow directly under the header
  (range, sites, exclusions, sync-across-pages). If it scrolls out of view, a
  small "show filters" button appears top-right — see the IntersectionObserver on
  `barSectionEl` in [`src/App.vue`](src/App.vue) — and pins the same bar at the top of
  the viewport until you dismiss it (the button again, Escape, or clicking outside) or
  scroll back to where the in-flow bar is visible. Hidden only on the campaign page
  (`isCampaignComparePage`, by id), whose widgets aren't filter-driven.
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
  ([`src/lib/textLite.ts`](src/lib/textLite.ts), never `v-html`) — and shown as
  their own movable 'note' widget (`widget.noteId`, whose editor also takes plain text with
  "Insert from library"). Short UI names (metric and
  funnel-step labels such as "Game-screen views") are registry entries too, of kind `label`:
  never a caption, never a caveat and never offered in the editor's caption lists (the card
  builder's label pickers list them).
- **Chart captions and data caveats** (layout version 16). Everything under a chart comes from one
  list in a fixed order, [`chartNotes()`](src/lib/chartNotes.ts): the chart's own caption, any
  legacy notes, the automatic caveats, then the response's own notes (the pop-up note, the split
  guard, whole-day counting, the range notice). A card's own captions render inside the card.
  - **Caption** (`Widget.caption`, up to 2,000 characters, cut on load, never dropped): plain text
    the chart's author writes in the chart editor, with **bold** and links; the same field on a
    chart and on a card, stored beside the card rather than in its spec. "Insert from library"
    copies a *static* registry entry's text into it (fixed text only: not date-gated, computed,
    tied to a value from code or a data-cut note); the library stays read-only.
  - **Value tokens** (`{=path|format}`; the grammar and every path are documented once, in
    [`src/lib/valueTokens.ts`](src/lib/valueTokens.ts)). "Insert value ▾" in the chart editor puts
    one at the caption's cursor. A token in a chart's caption is filled from that chart's own
    response, with no extra request: its total, top item, the top item's count and share, and the
    first and last day shown; plus the newest release, the web go-live date and the Play
    submission date. Formats are `number`, `pct` and `date`. A token with no value (no data yet, an
    error, a rate tile or a multi-series line for the chart values, an unknown path or a mismatched
    format) shows "—", as every token does on a tab from before value tokens and in any note other
    than a caption or a note widget, so the raw token never shows, even one wrapped around bold or a link. A value
    is put in only as plain text and never read again, so a value holding `**`, a link or another
    token shows as written; a token inside bold or a link label shows "—", and a link whose address
    holds `{` or `}` stays plain text.
  - **Catalog values** (`{=metric:<id>@<window>}`, e.g. `{=metric:bsk.pageviews@page|number}`; the
    grammar is pinned in [`src/lib/valueTokens.ts`](src/lib/valueTokens.ts)). A caption, a note
    widget or a metric card's label (its title, a section heading, an item's label, caption or
    column hint, a repeat's empty message) can show any catalog metric or proportion ratio that needs no campaign or popup choice,
    over one of its own windows (`page` for the page's date range, `todaySoFar`, `before`, `after`);
    the window is required and the kind (number, percentage, date) is the catalog's own. Every
    widget on a page shares ONE batched `/api/metrics` request, the same one the cards use (so a
    value a card already loaded is never fetched twice; a card's label tokens ride in the card's
    own request, and a card with none fetches nothing extra); while it loads, on an error and for an
    unknown id a token shows "—", and so does a value the server withholds or cannot fully measure
    (too few, no data, a shorter span than the range). A token sends only its metric and window,
    so it can never ask for a split the catalog withholds: the counts-only rule (return, game
    starts, completions, tutorial completions, tour skips and tour exits, coach-strip shows, dismisses and closes, ask-order A/B and paid-funnel rows: no hour, place or device split, no visitor id)
    stays enforced on the server, where a sub-day range counts those rows over whole ET days. A
    chart's ↻ (or a metric card's own ↻ / Retry) refetches its caption's tokens along with the chart, and a token deleted from a
    caption or label stops loading; a live push refetches a token only when the server flagged that
    token's own last value safe, as it does for a chart.
  - **Note widgets** take values too: `release.*`, `golive.*`, `play.*` and `metric:` tokens fill
    in; `chart.*` shows "—" (a note belongs to no chart).
  - **Insert value** is one control in every text box that takes inserts: the caption, a note
    widget and a card label. It groups This chart (not in a note or a card that renders its own
    body), Dates and Metrics (a card label offers the repeat's own fields, Dates and Metrics, not
    This chart). A metric option shows its current value only if the page already holds it
    (a card label's menu reads the value for the card editor's page context); nothing is fetched
    to label an option, and a token that would not fit whole under the label's 200 characters is
    not inserted. Insertion is an explicit choice: pick in the menu, then press **Insert** (a closed
    menu fires a change on every arrow key, which would drop a token per option).
  - **Caveats** are system-owned and follow the code: dated or gated entries, computed text, text
    tied to a value from code, and the runtime notes. A chart shows its data source's caveats
    automatically (`autoCaveatIds`: the `overview`, `campaigns`, `popup`, `geo` and `ads-readings`
    scopes; a note widget and a chart with no such source show none), and one added to the
    registry later reaches every chart on that source. A caveat that names a view, such as the
    country-columns note, carries a `NoteDef.appliesTo` condition and shows only where it is true.
  - **Hiding** (`Widget.hiddenCaveats`, up to 32 registry or runtime ids, `/^[a-z0-9-]{1,64}$/`): the
    editor's "Data caveats" list has a Show/Hide button on each hideable caveat, per chart. A
    caveat that says data was cut or withheld (`NoteDef.hideable: false`, the range limit, the
    split guard, whole-day counting, the country-columns note and the retention
    disjoint-populations note) always shows; listing one in `hiddenCaveats` does nothing. A card's
    own captions (from its preset or spec) take the same Show/Hide buttons in the card builder,
    and a caption id this version does not know is kept as saved until its Remove button is used.
    In the card builder's custom mode every caption row has a Remove button, and an **Add a caption**
    picker lists every caption note that is true for the card and is not already on it.
  - **Upgrading a chart.** Version 16 hides, once per chart, every hideable caveat that chart did
    not show before (`seedHiddenAutoCaveatsV16`, run only on a layout stored below version 16), so
    an existing chart looks the same; the built-in default charts, a fresh layout and "restore
    default charts" are seeded the same way. The seed only ever hides the caveats that existed at
    version 16 (`V16_SEEDABLE_CAVEATS`), so one added to the registry later shows on every chart,
    a restored default chart and a layout not yet saved at version 16 included. A campaigns chart
    gains the country-columns note only if it splits by country. A chart a person adds shows its
    caveats at once.
  - **Legacy notes** (`Widget.notes`, no longer written): they keep rendering. The first time a
    chart is edited, its static entries fold into the caption as text and drop out of `notes`;
    dated, computed, value-tied and data-cut entries stay in `notes` as caveats. A duplicated
    chart is a deep copy, so the two never share a list.
- **Durable, multi-page dashboards** — layout + chart definitions persist in KV (not
  `localStorage`), so they follow you across devices. Duplicate / rename / delete
  pages (see *Page navigation*); a protected default page with "restore default charts"; per-page filters and
  per-chart filter overrides (set from the chart's filter button, or from the Filters row in the chart
  editor, which shows "Uses the page's filters" or what the chart overrides, with Edit and Clear; a card
  shows the summary and Clear only, and a pop-up rate tile has Edit too, as on the chart). A saved layout is migrated forward on load
  ([`src/lib/defaults.ts`](src/lib/defaults.ts) `normalizeConfig`, `CONFIG_VERSION`), and the
  first save of a newer version first copies the previous stored layout to
  `dashboard:default:backup:v<old version>` in KV ([`functions/api/config.ts`](functions/api/config.ts)),
  once, so a migration can be rolled back by copying that key over `dashboard:default`.
  Every save that changes the stored layout also first copies the stored one to
  `dashboard:default:prev`, and the first such save of each ET day to
  `dashboard:default:day:<YYYY-MM-DD>` (kept 30 days); if a copy can't be written the save is
  refused (`503`) and the stored layout and `:prev` are left as they were (see
  [Restoring the layout](#restoring-the-layout)). That makes a changing save 2 KV writes (3 on the
  first of an ET day) instead of 1, so the Free plan's 1,000 writes a day (account-wide) cover
  about half as many edits; past the cap every save fails (a changing one with that `503`, another kind
  with a `500`).
  A tab saves only after it has read the stored layout ([`src/api.ts`](src/api.ts) `loadConfig`
  resolves to `null` only when nothing is stored yet): if the read fails — no answer, a non-2xx,
  or a body that isn't a layout or can't be normalized — it shows the built-in defaults under a "Couldn't load your saved
  layout" banner, labels edits "Not saved", and sends no save until **Try again** reads the layout
  (which replaces the defaults and any edits made on them). A `401` shows the sign-in banner instead.
- **Page navigation** — every page belongs to a **group** (`DashboardPage.group`, a plain
  string: "All sites", "Best Sudoku", "Mine", …, so a new product is just a new group). The
  default page, **★ Overview** (all-sites traffic), is shown pinned first, outside the groups,
  and can't be deleted. Order is data: groups appear in the config's optional `groupOrder` (which
  also keeps a group that has no page yet), then in the order they first occur in the saved page
  list, and pages keep their saved order within a group — nothing is re-sorted on load
  (`normGroupOrder` sanitises the list and stores it only when it says more than the pages do).
  Built-in pages are recognised **by id only** ([`src/lib/defaults.ts`](src/lib/defaults.ts)
  `isOverviewPage`, `isCampaignComparePage`, …), so renaming a page never changes how it
  behaves. The page each viewer is on (and the page they last viewed in each group) is
  remembered **in their own browser** ([`src/lib/viewerPrefs.ts`](src/lib/viewerPrefs.ts)), not
  in the shared KV config: switching pages never saves anything or moves anyone else, and a
  first-time viewer lands on ★ Overview (the config's `activePageId`). Layout version 13
  (`migrateNavV13`) filed the existing pages: the built-ins by id, the Best Sudoku pages renamed
  Overview, Campaigns, Pop-ups and Traffic (their group shows "Best Sudoku"), and every other
  page under the group its name starts with, else **Mine**. Drill pages made before version 13
  can't be linked to the page they came from (nothing stored it), so they stay ordinary pages
  under Mine.
  - **Breadcrumb** ([`src/components/nav/NavBreadcrumb.vue`](src/components/nav/NavBreadcrumb.vue))
    — `Group / Page / Drill / Drill…` in the header (the whole path to the page on screen), the
    everyday way to move around. Each segment opens a menu: the group segment lists ★ Overview
    and every group (picking a group opens the page you last viewed in it, else its first page)
    and "Rename <group>"; the page segment lists the group's pages with their drill pages nested
    under them, all pickable (a page with more than six folds them behind "Show N drill pages"
    unless you're in there), plus "New page in <group>" (a copy of the page on screen, in that
    group); a drill segment lists its sibling drill pages, its own drill pages under it, and the
    way back to its parent. On ★ Overview the group segment is ★ Overview itself. When the path
    doesn't fit, the middle folds into a "…" segment whose menu lists it; at phone width it
    always does (`Group / … / Page`) and the menus open as a bottom sheet. Menus are
    keyboard-operable (arrows, Home/End, Esc/Tab return focus to the segment).
  - **Search** ([`src/components/nav/SearchPalette.vue`](src/components/nav/SearchPalette.vue))
    — press <kbd>/</kbd> anywhere you're not typing (or the header's search button) to search
    every page in every group: page names first, then pages matched only by a chart title, each
    with its icon, its path for a drill page ("Traffic › mobile › California") and its group
    badge. <kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>↵</kbd> opens,
    <kbd>esc</kbd> closes ([`src/lib/nav.ts`](src/lib/nav.ts) `searchPages`).
  - **Drawer** ([`src/components/nav/NavDrawer.vue`](src/components/nav/NavDrawer.vue)) — the
    ☰ button (it carries the current group's badge, ★ on ★ Overview) opens the whole page tree
    as an overlay over the charts, on every screen size: ★ Overview pinned first (unindented),
    then each group — its header collapsible (remembered per viewer), with its badge, a ⋯ group
    menu and its page count — its pages indented under it and each level of drill pages one more
    step in (a page with drill pages folds them away; remembered per viewer, and the path to the
    page on screen always shows). Every page, drill pages included, has the ⋯ page menu; drill
    pages also have × to delete them. Esc, the scrim or picking a page closes it; focus stays
    inside while it's open and returns to ☰.
  - **Group menu** ([`src/components/nav/GroupMenu.vue`](src/components/nav/GroupMenu.vue)) — ⋯
    on a drawer group header: Rename (in place), New page in this group (the page wizard with
    the group picked), Delete group… ([`DeleteGroupDialog.vue`](src/components/nav/DeleteGroupDialog.vue):
    says how many pages it holds and moves them to the group you pick — "Mine" by default, the
    first other group when Mine is the one going; ★ Overview never moves). A group can exist
    with no pages. Renaming a group renames it on every page, in `groupOrder` and in `groupMeta`
    at once; another group's name (in any case) is refused with a message, never merged
    ([`src/lib/nav.ts`](src/lib/nav.ts) `renameGroup`, `deleteGroup`).
  - **"+ New"** ([`src/components/nav/WizardCarousel.vue`](src/components/nav/WizardCarousel.vue),
    [`NewWizards.vue`](src/components/nav/NewWizards.vue), [`src/lib/wizards.ts`](src/lib/wizards.ts))
    — at the bottom of the drawer. Its label slides aside to a menu of what can be created (a
    small registry of wizard definitions), and the chosen wizard runs as a carousel of steps with
    Back / Next (Create on the last step), each step's Next waiting until the step is complete
    and saying why inline. A **page**: its name; its group (an existing one or a new one named
    there); what it starts from (blank, a copy of the page on screen, or a built-in page's
    default charts, including **Best Sudoku · Retention**) and its icon (Auto, shown, or one from the icon picker) — it's added to its
    group and opened. A page built from a built-in page stores which one (`templateId`, an optional
    field, guarded by layout version 19), so **Restore default charts** on it brings back that page's own
    chart set rather than the generic one; a page without the marker is read by its id, and a
    Retention page made before the marker by its scope note. A **group**: its name (unique); pages to move into it (optional, ★ Overview
    excluded); a review — it's listed even when empty, and the drawer scrolls to it. Esc or ×
    closes and starts over; with reduced motion nothing slides.
  - **Page menu** ([`src/components/nav/PageMenu.vue`](src/components/nav/PageMenu.vue)) — ⋯
    next to the breadcrumb (the page on screen) or on a drawer row: Rename, Duplicate (same
    group and icon; a copy of a drill page stays under the same page), Change icon…, Move to
    group (every group, or "New group…" named right in the menu; the page's drill pages move
    with it — a drill page moved this way becomes a page of its own in that group), Restore
    default charts, Delete. ★ Overview can't be moved or deleted, and **deleting a page deletes
    every drill page under it too**, asked once ("Delete "Traffic" and its 3 drill pages?").
    When the page on screen is deleted you land on its nearest remaining parent, else the page
    before it in its group, else the group's first page, else ★ Overview
    (`landingAfterDelete`).
  - **Renaming in place** ([`src/components/nav/InlineName.vue`](src/components/nav/InlineName.vue))
    — Rename (a ⋯ menu, or double-clicking the breadcrumb's group or page segment) turns the name
    into a text field right where it is: Enter or leaving the field saves, Esc cancels, an empty
    name changes nothing. No prompt dialogs. Every name on screen — breadcrumb, drawer, search,
    menus and the browser tab's title — is rendered from the one config, so a rename shows
    everywhere at once.
  - **Icon picker** ([`src/components/nav/IconPicker.vue`](src/components/nav/IconPicker.vue))
    — search the ~40 curated icons (Traffic, Engagement, Money, Product, Geography), or pick
    **Auto**, which shows what the page would resolve to on its own.
- **Page icons and group badges** ([`src/lib/icons.ts`](src/lib/icons.ts)) — every page shows an
  icon without anyone setting one. The config stores at most a short registry key
  (`DashboardPage.icon`, e.g. `megaphone`), never markup; the registry maps ~40 curated keys to
  [Lucide](https://lucide.dev) icons (`@lucide/vue`, named imports, so only those ship), and
  an unknown key shows the generic page icon. `resolveIcon`, first match wins: the icon someone
  picked; for a drill page, the icon of its nearest ancestor someone picked one for, else its
  top-level page's own icon, with a small drill mark; the icon of the dataset
  most of the page's charts read (notes don't count, a chart with no dataset is `rum`, a tie goes
  to the first chart in layout order: rum → trending-up, geo → map-pin, popup → app-window,
  campaigns → megaphone, completions → trophy, ads-readings → tag, overview → layout-grid); else
  the generic page icon. Traffic carries the one explicit built-in icon (`trending-up`), since
  its beacon charts would otherwise show Beacon's map pin. Each group gets a lettered badge (the
  first letters of its first two words, or a one-word name's first two letters) in one of seven
  colours hashed from its name (FNV-1a), each with a light and a dark value; the config's
  optional `groupMeta[group]` pins a colour (a slot `g0`…`g6` or a hex colour) or a logo image
  (an https URL, a same-origin path or a base64 image), validated on load.
- **Auto-built site filter** — a single multi-select of your sites and subdomains,
  built live from the data. It merges each site's RUM host and beacon tag into one
  entry, groups subdomains under their site, folds **alias hosts** (an HTTP redirect
  or a `rel="canonical"` pointing elsewhere) into their canonical site, and excludes
  dev/preview hosts from both the picker and the numbers.
- **Click-to-drill-down** — click any chart value to open a new page filtered to it
  (device, referrer, location, browser, …). The drill page is created at once, nested under the
  page it came from (`DashboardPage.parentId`, its immediate parent, in its group), and named by
  what it adds to that page, e.g. "California" under "mobile" ([`src/lib/nav.ts`](src/lib/nav.ts)
  `drillTrail`) — the drawer, breadcrumb and search show the rest of the path. Drilling again
  from a drill page stacks the filters and nests one level deeper, up to 8 levels
  (`MAX_DRILL_DEPTH`; beyond that a drill attaches to the deepest page allowed). Every load
  repairs the tree: a link to a missing page, to itself or closing a loop is dropped, and a tree
  deeper than 8 is re-attached (`normDrillLinks`).
  Clicking a day on a trend chart opens that day as an absolute date range: the UTC day for a
  `date` chart, and for a `dateEt` chart (the default trends) the Eastern day, from ET midnight to
  the next ET midnight (23 or 25 hours on a daylight-saving change). The footer and the date pickers show that one Eastern date.
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
  report" under `MIN_COHORT`), the sign-in eligibility counts with their rate, and two upsell
  charts by reason. The upsell has four outcome kinds on `/upsell/<kind>/<reason>`: `shown`,
  `accept` (the pass tapped while signed in), `accept-signin` ("Pass tapped, sign-in first": a guest
  tapped the pass and was sent to sign in first, tracked from Best Sudoku 1.104.0) and `dismiss`; the
  chart series, the kind picker, the Feature health Upsell row, the campaign funnel's upsell column and
  a count row in the rate table all carry it. The tap rates (`popup.tapRate`, `bsk.popupTapRate`)
  count **every** pass tap in the numerator (`accept` plus `accept-signin`; `popup.taps`,
  `bsk.popupTaps`), while the accept counts (`popup.accepts`, `bsk.popupAccepts`, the campaign
  upsell "accepted") stay signed-in only, so a rate before 1.104.0 is unchanged (no `accept-signin`
  rows exist then); once guests see the paywall the accept count no longer includes their taps. The eligibility card also splits the earned finishes by the reason on the row
  (placement, committed repeat, committed challenge, first-50, first finish, rows from before the reason existed,
  any other) and counts, outside the rate, finishes below the floor, "not now" and stopped
  (`/signin-eligible/{below-floor,not-now,stopped}`; counts only). The two upsell charts
  (`pu-upsell-dismiss-reasons`, `pu-upsell-signedin-reasons`) are the `reason` breakdown of the
  upsell's dismissals and of the sign-ins after it (each carries a caption: a dismiss can be a
  sign-in tap, so net it against the signed-in outcome for that reason before calling it
  rejection); the chart editor's Pop-up stage picker also
  offers the outcome stages (signed in, installed, returned, still playing) for any pop-up's
  reason or per-day chart. The rate table
  and the eligibility panel are metric cards (presets `popup-rates` and `signin-eligibility`, since
  layout version 11), over the page's range, sites and "hide my own visits", as before. Outcome-over-shown rates are
  not shown as percentages: outcomes land days after the showing, so a range mixes cohorts.
  Every other pop-up chart (reason/platform breakdowns, per-day trends) is
  still available from the chart editor's "Pop-up tracking" data source. A single rate tile
  (any `POPUP_RATE_SPECS` key) is a one-item metric card since layout version 18: it shows the
  percentage big with its n/d under it, "too few to report" under `MIN_COHORT`, "—" over "(0/0)"
  when nothing was shown, and the registry's notes (counted-from date, "still arriving" on a
  lagged outcome rate, the install-fix note, the eligibility caveat). A saved rate tile is mapped
  to the card when it is drawn (`src/lib/metrics/rateTileCard.ts`); the layout is not rewritten,
  and a stored hide of the install-fix note (`popup-note` in the chart's data caveats) still hides it.
  The chart editor no longer offers "Rate" as a chart type for a new chart (add a rate as a metric
  card: a one-line hint under Chart type says so, and the "Pop-up rates" preset is the starting
  point); a saved rate tile still opens and edits. `/api/popups` no longer answers
  `dimension: 'rate'` (removed in 0.24.1): like `rates` and `eligible`, it is a 400 naming the card
  and asking for a reload, so a tab from an older build shows an error on that tile, not a 500. The Stat and Table chart types draw through the
  shared `StatTile` and `BarTable` components (`src/components/metrics/`), as the metric card's
  tile and bar do.
  A key this build does not know shows a message asking you to pick a rate. Differences from the
  old tile: before tracking went live it reads "not yet tracking" where the old tile read "—"
  over "0/0"; the card clamps a range longer than the metrics limit to its newest days, reads a
  bare-date range as Eastern days, and shows "unavailable" for a bare-date range whose start
  equals its end. Percent columns in card tables are right-aligned.
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
  - **Provisional P1 beacon names** (best-sudoku `docs/design/signin-ask-buyer-intent.md` §7.4 @
    ffc46239; may still change): both shapes are accepted at once. `/popup-outcome/<popup>/<outcome>`
    (old) and `/popup-outcome/<popup>/<reason>/<outcome>` (new) both feed the outcome totals; the
    reason is shown in the pop-ups page's `reason` breakdown, with old rows as `legacy`. An outcome
    is never read as a reason. `/signin-eligible/earned` (old, reason `legacy`) and
    `/signin-eligible/earned/<reason>` (new) share the earned total. `/ab/ask-order/<group>/...`
    twin rows are in no ask, eligible or outcome total. New families are counted as plain rows:
    `/funnel/trial-start`, `/funnel/checkout-start/<web|play>`, `/funnel/purchase/<web|play>`,
    `/signin-eligible/{below-floor,not-now,stopped}`, `/install/inapp/*` and
    `/install/prompt/{ios,android}-inapp`. The morning read prints them on a "P1 beacons" line.
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
  on-device return-visit retention curve, and the ads routine's **readings log** (a metric card, preset `ads-readings-log`; see *Ads data
  freshness*). The
  funnel's Install step counts `/popup-outcome/install-prompt/installed` (once per showing);
  raw `/install/*` outcome beacons, which can double-count one install, are shown only as a
  secondary "raw install signals" line. Attribution is by the beacon's own
  campaign tag only, with no date-based split — one swappable function decides row
  membership, and known verification/household traffic, lifecycle email and the app's own manual
  production checks (`utm_campaign=manual_check`, `/return/manual_check/` paths) are excluded
  server-side. Two
  campaigns have no beacon rows at all (the September Play-direct arm, whose ads go straight to the
  Play Store, and Flight 4, an App install campaign); each is shown spend-only rather than an
  empty funnel.
- **Retention verdict** — a per-arm read of "did the campaign's arrivals come back", offered in
  the card picker as the `retention-verdict` preset (a table, one row per campaign arm plus
  "Organic (web)": the verdict, the days 2-7 return rate with its 90% lower and upper bounds,
  first tagged loads (d0), and completed games per arrival) and, beside it, `campaign-engagement`
  (completed games per arrival with its two counts). Neither is a default and neither bumps the
  layout version. **Where to find them together:** the page template **Best Sudoku · Retention**
  (`defaultRetentionPage` in [`src/lib/defaults.ts`](src/lib/defaults.ts), offered by
  [`src/lib/wizards.ts`](src/lib/wizards.ts)) puts a scope note, the small-sample note, the verdict
  table, `campaign-returns` and `campaign-engagement` on one page. Create it from **+ New > Page >
  Start from > Best Sudoku · Retention**. It is a template only: it is not on any layout until someone
  creates it, it is not in the fresh default layout, and it needs no migration (what
  a person saves is an ordinary page of card widgets). Its campaign figures are per campaign over the whole
  flight, so the page's date range does not change them; the Play tiles do follow it. Because
  nothing on the page reads the site picker or the own-visit exclusions, the page's filter bar
  keeps only the date range (and Sync all pages); when the page already holds a site filter or an
  exclusion that is off its default, the bar adds a one-line note that those still apply to any
  chart added there. The rate is the share of an arm's d0 devices that came back on any of days 2-7
  after arrival (ET days), and its bounds are a **Wilson score interval at 90%**
  (`wilsonBounds` in [`src/lib/metrics/retention.ts`](src/lib/metrics/retention.ts)). The verdict
  compares those bounds with a **bar**: a fixed 7.5%, or 0.6 times the organic days 2-7 rate once
  the organic baseline is sound, meaning at least 1,000 *matured* organic arrivals, at least 21
  matured organic ET days, and at least one organic day 2-7 return (zero returns would make the
  bar 0 and hand every arm a GO, so that case keeps the fixed 7.5%). The verdict cell says which
  bar was used and, for the fixed one, why. Codes: **too few** (under 200 d0, no read);
  **maturing** (the arm's last arrival's day 2-7 window has not closed, so returns can still
  arrive; a maturing arm never gets an early NO-GO); **provisional** (matured, 200-499 d0, the
  upper bound is not below the bar; it can still be NO-GO when it is); **GO** (matured, at least 500
  d0, lower bound at or above the bar); **NO-GO** (matured, upper bound below the bar); **HOLD**
  (matured, at least 500 d0, the bar sits inside the bounds). At 500 d0 against the fixed 7.5%
  bar, GO needs 48 or more returns (lower bound 7.65%; 47 gives 7.47%) and NO-GO needs 27 or fewer
  (upper bound 7.32%; 28 gives 7.54%). These are Wilson thresholds, not the Wald 49 and 28. When the organic bar is used it
  **runs high**: the organic day 2-7 count is cut at ET midnights, so it also includes returns from
  recent arrivals that are not yet in the matured arrival count, about 2.5 to 3.5 days of
  arrivals' worth (2.5 if first returns are spread evenly over days 2-7, 3.5 if they come on
  day 2). The bar is therefore too high by about that many days divided by the matured organic
  days (roughly 12 to 17% at 21 days, about 10% at 30, and larger the fewer there are). A high bar
  makes NO-GO easier and GO harder, never the reverse, and that is why the 21-day minimum exists.
  Organic d0
  and campaign d0 are **disjoint populations** (a device is organic only on a first-ever web visit
  with no campaign tag, first touch wins), so the organic bar *compares* the two groups and nets
  nothing out of a campaign; that caveat can't be hidden from the card. The rates are also a lower
  bound on people (d0 counts browser storage, not people), and the bounds cover sampling error
  only. Everything is **counts only**: rows only, with no hour, place or device split offered on
  any of it.
- **Locked down** — Google sign-in with an email allowlist gates every page and API
  call; the header shows who is signed in with a **Sign out** button (between 701px and 1000px
  wide, where the bar would wrap, the search box shrinks to its icon and the account becomes an
  icon menu with the e-mail and **Log out** — the same `/auth/logout`), and an expired
  session shows a one-tap re-sign-in banner instead of a wall of errors.
- Light / dark theme matching the Good Stuff Software brand.

## Feature health

The **Feature health** card sits on the Best Sudoku Overview under the KPIs and reads
`/api/features` ([`functions/api/features.ts`](functions/api/features.ts)). The **Features**
page (last in the Best Sudoku group) charts every step of every feature, one line per step and
one point per ET day, as ordinary line charts (see *Step charts* below). Both count web and app
combined and follow the page's range, sites and exclusions. Rows from the app's manual production checks
(`manual_check` campaign or paths) never count here, even with known traffic shown. A feature can
carry a one-sentence caption, shown on its step chart and under the card table: Tour says
`/tour/start` no longer counts tours opened from the coach strip (from v1.99.1), and Upsell says
it is not comparable to flight 2 because the guest trial changed in v1.99.1. Upsell also says a
dismiss can be a sign-in tap (net it against the signed-in outcome) and that the post-sign-in
passes upsell, shown from v1.99.1, sends no shown beacon; the Money funnel says a checkout start
after sign-in can come from that upsell. The Sign-in ask and Install prompt say asks wait while a
coach tip shows, so impressions dip where tips run more often; Install adds that iPhone users outside
Safari count under `/install/prompt/ios` and a dismissal after an in-app App Store tap
counts as a dismissal.

- **Card:** a small card per feature with its status, and per step the count for the latest
  complete ET day, the day before and the selected range, plus the ratio of those counts (see
  *Feature health in the card editor* below).
- **Ratios are counts per count**, e.g. "tapped per shown". They are not per-person rates:
  rows are independent counts, never joined into a path, so a ratio can exceed 1. A zero
  denominator shows "—".
- **Status:** *Went silent* if the latest complete ET day had 0 rows, and the 7 days before the
  current run of zero days averaged at least 5 rows a day with rows on at least 6 of those 7
  days; *New* if it has no rows before the last 7 days; otherwise *OK*. A quiet day below 5 a
  day, or a gap in a bursty feature (rows on fewer than 6 of the 7 days), stays OK. An outage
  keeps flagging for up to 7 zero days, then stops being news.
- **Coach:** the coach strip reads "New / no rows yet" until the app ships its `/coach`
  beacons.
- **Money funnel:** the last feature (Features page, after Ask-order), with the steps trial
  started, checkout started (web, Play) and purchased (web, Play), each purchase per its
  checkout. Provisional beacons (`/funnel/*`): the feature reads "New" until rows arrive.
- **In-app install help:** a step of the Install prompt feature (`/install/inapp/*`, no ratio): the
  help shown inside another app's browser, where the install prompt cannot run.
- **Adding a feature** is one entry in `FEATURES` in
  [`src/lib/featureHealth.ts`](src/lib/featureHealth.ts): it adds a card row and a Features
  chart.
- Counts only: the card splits by nothing (no hour, place, device or visitor).

### Feature health in the card editor

The Overview's Feature health readout is an ordinary metric card, the **Feature health** preset:
it repeats over the features (one small card each: the status, the 7-day average behind it, the
latest-day and range totals and the feature's caption), and each card has a table that repeats
over the feature's steps (Step, Yesterday, Day before, Range, and the three ratios with what
they are per). The same card can be built or changed in the card editor like any other.

- **Building blocks.** Repeats *Features* (all, or the ones checked) and *Steps* (the enclosing
  feature's); windows *Latest complete ET day* (`latestDay`), *Day before* (`previousDay`) and the
  page range; metrics `feature.step`, `feature.total`, `feature.stepRatio` (a plain ratio of two
  counts, never a percent), `feature.status` (OK, New or Went silent) and `feature.baselineAvg`
  (rows a day over the 7 days the status reads). They read one `featureDays` fact: rows per ET day
  and path, over the same window and filters as `/api/features`, with known traffic always hidden.
- **Same numbers as the old table.** `functions/api/featureDays.parity.test.ts` runs the real
  `/api/metrics` and `/api/features` handlers over one fixture (three clocks, six ranges, four
  filter sets) and compares every status, average, total, step count and ratio.
- **What reads differently.** The status sentence is now the status plus its 7-day average; a
  feature's caption sits in its own card; a range whose bounds moved to ET midnights carries the
  whole-days caption, as a step chart does; and a range over 400 days is refused (the metrics
  endpoint's cap), where the old table showed its newest 731 days. No "All time" view beyond
  400 days is accepted for now: Best Sudoku's data is well under 400 days old.
- **Cost.** The card's 334 requests (14 features, 44 steps) go out as 2 `/api/metrics` POSTs, and
  on a cold cache each runs its own `featureDays` statement, so an uncached Overview load reads
  the feature rows about twice where the old table read them once (see
  [docs/capacity.md §12](docs/capacity.md)).
- **Saved layouts are not rewritten.** A Feature health table saved by an older build (dataset
  `features`, view `health`) that hides known traffic is drawn as this card at render time
  (`featureHealthCardFor` in [`src/lib/defaults.ts`](src/lib/defaults.ts)), keeping its place,
  title and settings; one that shows known traffic keeps the old table. The layout version does
  not change.

### Step charts

Each Features-page step chart is an ordinary chart-editor line chart: the beacon dataset on the
ET-day axis (`dateEt`), one series per step, each series a filter on the **Feature step**
dimension (`featureStep`, value `<feature>.<step>`, e.g. `tour.start`; see Data & dimensions).
It can be edited or duplicated like any chart, and the same chart can be built from scratch in
the chart editor. The chart caption is the feature's blurb, then its caption; the status chip
stays on the Feature health card.

- **Same numbers as the card.** A step counts exactly the rows the card counts for it (web and
  app combined, known test and household traffic hidden unless the chart shows it, manual checks
  never), per ET day. `functions/api/featureStep.parity.test.ts` pins every step of every feature
  against `/api/features`, per day and in total.
- **Whole ET days; today from noon ET.** As on the card, each bound of the range moves to the
  nearest ET midnight, and the axis draws exactly the counted days. Before 12:00 ET a range that
  ends now stops at yesterday, so there is no "today" point; from 12:00 ET today is drawn with
  its rows so far.
- **The axis starts at the first day any step has a row**, as on every series line chart, and
  its ticks are whole numbers.
- **Page filters apply.** A drill or filter on the page (a country, a device) narrows the step
  charts, which the old step charts ignored. Under an hour, place or device filter the counts-only
  rows (see the counts-only rule under Data & dimensions) drop out and the chart says so: a step
  made only of those rows shows nothing, Sign-in ask "Shown" keeps every showing but the
  first-finish ask's, and a step with none of them counts as before.
- **Like any chart.** A click on a point opens a drill on that day, and a step chart with no
  counts-only rows refreshes on live updates; the old step charts did neither.
- **One request per chart.** A chart whose every series is one `featureStep` filter asks
  `/api/geo` once with `stepSeries` (the step values in legend order, at most 16) and gets one
  response per series from one D1 statement. Each series' total, caption and live flags equal its
  own request's; its days are the newest `limit` days with any step's rows, so with a short limit
  a step's own request could keep older days of its own (the shipped limit, 500 days, is never
  reached). The page makes 14 such requests for its 14 step charts, where the old step charts
  shared one `/api/features` request ([docs/capacity.md](docs/capacity.md) §11).
- **Saved layouts are not rewritten.** A step chart saved by an older build (dataset
  `features`, view `steps:<feature>`) is drawn, edited and duplicated as the ordinary chart at
  render time (`stepChartFor` in [`src/lib/defaults.ts`](src/lib/defaults.ts)), keeping its
  place, title, caption and settings. The layout version does not change.

### Coach tips

The **Coach tips** card (bottom of the Features page) has a row per coach-strip tip (place,
wheel, notes, hint, clash): shown, dismissed and closed while showing, with dismissed per shown
and closed per shown (ratios of counts, "—" for 0), for the latest complete ET day and the
selected range. "Show me around" taps (`/coach/tour-opened`, no tip) are a separate total row.
It is the same `/api/features` endpoint with `view: 'coach-tips'`
([`src/lib/coachTips.ts`](src/lib/coachTips.ts)): same two statements, grouped by ET day only.
Splitting by *which tip* is a split by path, not by hour, place or device, so the refused
`/coach/shown/%`, `/coach/dismissed/%` and `/coach/closed-at/%` paths are still read only as
per-ET-day totals. Web and app combined, humans only, the same exclusions as the other cards;
viewers can read it. Until the game version that sends the beacons ships (no coach row ever),
the card says so and every row reads 0. Its caption gives the reading rule per tip (shown, then
dismissed, closed-at, or nothing) and warns that, from v1.99.3, × closes one tip and a written
note ends the notes tip with no beacon, so ratios and tip-to-tip comparisons are not comparable
across that version (the note under the card appears once the version's date is set).

### Ask-order A/B

The **Ask-order A/B** card (Features page, under Coach tips; `?page=bsk-features`) reads the test
of which ask goes first, sign in or install. Each device is put in one group once, and the game
sends twin rows under `/ab/ask-order/<group>/…` (assigned, shown per ask, and the outcome after
each ask, plus a once-per-device `responded` row on a device's first response). The card shows, per
group and organic vs tagged, assigned and shown rows, the responded rows, the signed-in rows and
installed rows per assigned row (display only, as plain row ratios, never a per-person rate), and
returned and still-playing rows from the group's own twin rows. The pre-registered read is
progress to about 150 asks shown per group (all traffic, organic plus tagged) and one 1.5x rule on
one **primary**: responded rows per assigned row once any once-per-device responded row has been
seen, and until then the combined response rows (signed-in plus installed; a device that both
signs in and installs counts twice) per assigned row. The card says which primary is active and
why (`ASK_ORDER_PRIMARY_MODE` in [`src/lib/askOrder.ts`](src/lib/askOrder.ts) is `auto`, or can force
`combined` or `responded`). At the call point, one order at 1.5x or more of the other on the
primary switches everyone to it (compared as integers, so exactly 1.5x counts), otherwise sign-in
first stays. If sign-ins and installs point opposite ways between the groups, the sign-ins
decide: the same 1.5x test is then run on the signed-in (or responded sign-in) rows. The read uses
every day so far whatever range or site is picked. It is the same `/api/features` endpoint with
`view: 'ask-order'`. Caveat it states: tagged-cell ratios are approximate because organic and
tagged are per-event counts. The whole `/ab/ask-order/%` family
is counts only: read as per-ET-day totals, never split by hour, place or device, and never added
into any other total. Purchases cannot be split by group, so they are not shown.

## Page links

`https://stats.goodstuff.software/?page=<page id>` opens that page (for example `?page=bsk-features`
for Features); the link wins over the page remembered in the browser, and an unknown id falls back
to the remembered or landing page. Switching pages updates the address bar (`replaceState`), so a
copied URL reopens the same page. Through sign-in, the existing same-origin-only return path
(`next`, `safeNext` in [`functions/_lib/auth.ts`](functions/_lib/auth.ts)) carries the query, so you
land on the page you asked for; `//host`, absolute URLs and `/auth/…` still return to `/`.
The param only picks among existing pages ([`src/lib/pageLink.ts`](src/lib/pageLink.ts)); it is
never used as a URL.

## Architecture

```
Browser (Vue 3 + Chart.js + grid-layout-plus)
   │  POST /api/stats   POST /api/geo   GET /api/sites   GET/PUT /api/config
   ▼
Cloudflare Pages Functions  (functions/_middleware.ts → functions/api/*.ts)
   │  - _middleware: host guard, then Google sign-in gate on every request (see Auth)
   │  - hold CF_ANALYTICS_TOKEN (secret) — never sent to the browser
   │  - /api/stats  → RUM GraphQL (server-side), requestHost allow-list, range gated (see Range limits)
   │  - /api/geo    → reads the beacon's D1 (bot-free sub-country geo)
   │  - /api/popups → pop-up funnel counts/rates from the same D1 (sign-in, upsell, install, …)
   │  - /api/completions → completed-game counts from the same D1, by mode × difficulty
   │  - /api/features → the Feature health card, Coach tips and Ask-order from the same D1 (web and app combined)
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
  `POST /api/metrics` answers a batch of registry ids and params (never SQL; `context.day`, a
  `YYYY-MM-DD` Eastern day that is not in the future and at most 90 days back, reads the today-so-far
  windows for that day instead, whole, else `400`): it validates every
  id and param against the registry, plans the distinct facts (at most 40 statements, else `413`
  with `maxStatements`), caches each fact on its own in the Cache API, and derives every value in
  JS with its status (`ok`, `too-few`, `no-data`, `unmeasured`, `partial`), n/d, deltas (or whole-day context, see *KPI tiles for counts-only rows* below) and a
  provisional flag for lagged outcomes. Windows are the campaign's attribution window, today so
  far, the page range, the compared release's before/after windows (sized by one cached first-hit
  read), and a campaign's pre/post segments at the signed-out upsell fix (only once that fix is
  set and falls in the flight). **Metric cards** render it: a widget with `card`
  (`{ preset }` from [`src/lib/metrics/presets.ts`](src/lib/metrics/presets.ts), or a saved spec)
  shows `MetricCard` ([`src/components/metrics/`](src/components/metrics)) — one batched request
  per page, following the page's date range and sites, with each card's caveats behind one
  collapsed "Notes" link and "Updated Xs ago" with ↻ where the card asks for it. **When data
  loads:** on mount, when the range or a filter changes, on the ↻ / Refresh buttons, and when you
  come back to the tab (the tab turns visible or the window regains focus; one page-level listener,
  [`useReturnRefresh`](src/composables/useReturnRefresh.ts)). That last refetch is throttled — a
  card reloads only if its last load is a minute or more old and none is in flight (a request
  still running after 30 s counts as hung and no longer blocks it), never while the tab is hidden
  — and is an ordinary request (never `fresh`); metric cards go out as the usual batched
  `POST /api/metrics`, and a failed refetch keeps the numbers already on screen. It is not free:
  the edge cache below only answers a return within its 90 s window of the last load, so a return
  after more than 90 s reads D1 again, and `/api/popups` and `/api/ads/readings` are never cached
  (cost: [docs/capacity.md](docs/capacity.md)). There is no polling: a tab that stays in the
  foreground never updates itself, and a relative range such as "last 7 days" is resolved when the
  page loads, so a tab left open past midnight refetches the same window until it is reloaded.
  **Day selector** (`dayPicker: true` on a card spec; the "Today at a glance" preset sets it, and the
  card editor has a checkbox): previous and next arrows and a date pick beside the card's status
  line, today by default with "next" disabled at today. A past day is an Eastern calendar day, up to
  90 days back, and the title says it ("Mon Oct 5 at a glance"; "Today at a glance" stays for
  today). The card then reads that day whole instead of today so far: the prior day and the 7 days
  before it are the comparisons, the rate tiles and the "too few to report" thresholds are unchanged,
  and a go-live that day reads "new that day". The choice is view state in the card (not in the URL,
  never stored server-side); it goes to the server as `context.day` (below). A past day is static, so
  it shows no "Updated Ns ago" and a live ping never refetches it; picking today is the live card
  again.
  The Overview's
  "Today at a glance" and campaign scorecard are cards since layout version 10. **Cards are
  editable**: "Add chart" offers a metric card as a chart type (the Overview and campaign cards
  are presets of it, so they are not separate data sources there), and editing one — a new card or
  an existing "Today at a glance"/scorecard — opens a card builder in place of the usual chart
  fields ([`src/components/metrics/CardEditor.vue`](src/components/metrics/CardEditor.vue)): pick
  each row's label (plain text, a note, a bound field, or the metric's own name), its data (a
  metric, a registered ratio, or a field — only unit-compatible display types are offered, so an
  invalid percentage can't be built), arrange sections, and watch it update live before saving; an
  edit that would leave the card invalid is refused inline instead of being saved. A preset card
  opens showing all of its settings read-only; **Customize…** copies them into an editable card,
  where every template field has a control (badge colours, card actions, note variables, a
  repeat's ids and empty message, table headings, gating) and using a control without changing it
  leaves the card exactly as it was. A card the builder saves always loads again: it holds the
  same size limits loading checks (up to 32 badge colours, for one), and a note id from a newer
  version is kept as saved and shows nothing until this version knows it. Each of a card's own
  captions has a Show/Hide button (see *Chart captions and data caveats* above).
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
`/install`, `/popup-outcome`, `/return`, `/funnel`, `/ab/ask-order`, `/coach`, `/game/complete/`, the `/auth/success/<provider>/`
status suffix, `/auth/error`, `/auth/redirect` and the first-session beacons (`/tour`, which
includes `/tour/exit-at/<stage>`, `/game/tutorial-complete`, `/game/first-move`, `/game/abandon`,
`/welcome-signed-in` and `/game/start/<difficulty>`) are pop-up/event beacons, not screens — `/api/geo` and `/api/sites` exclude all
of them from every pageview/visit total and the top-pages breakdown by default (see
[`src/lib/popupEvents.ts`](src/lib/popupEvents.ts) `POPUP_EVENT_PREFIXES`). `/api/popups` counts
only the pop-up events among them (the sign-in, first-50, upsell, install and pop-up-outcome
families); it never counts the first-session beacons (`/tour/…`, `/game/start/…`,
`/game/tutorial-complete/…`, `/game/first-move`, `/game/abandon/…`, `/welcome-signed-in/…`), and
the counts-only rule below says where those are counted. Each geo chart has its own **"Include event beacons"** option (off by
default, so nothing existing changes) to lift that exclusion and chart event paths directly —
e.g. with the **path family** dimension below. Drilling into an event-family `pathFamily`
value (e.g. "install") carries that option onto the filtered page it opens, so every chart
there — not just the one drilled — can show the event rows just filtered down to; the page
carries a caption explaining why (see [`src/lib/drill.ts`](src/lib/drill.ts)
`drillNeedsEventBeacons`).

**Return, game-start, game-completion, tutorial-completion, tour-skip, tour-exit, coach-strip shown, dismiss and close, ask-order A/B and paid-funnel (trial, checkout, purchase) rows are
counts only: never split by hour, place or device.** Rule: "counts only. Never tie beacon rows to a device, time or place." A geo
chart that maps rows (the map/globe), groups by an hour, place or device dimension (`hourEt`,
and the UTC `date`, whose count minus `dateEt`'s for the same day would give an evening band;
`country`, `region`, `city`, `postal`, `continent`, `timezone`, `colo`, `org`; `device`,
`browser`, `os`, `lang`, `screenw`, `screenwBucket`, `visitor`), or is drilled into one of them
leaves `/return/…`, `/game/start/…`, `/game/complete/…`, `/game/complete-deferred/…`,
`/game/tutorial-complete/…`, `/tour/skip`, `/tour/exit-at/…`, `/coach/dismissed/…`, `/coach/closed-at/…`, `/coach/shown/…`, `/ab/ask-order/…` and `/funnel/…` rows out entirely, and any row whose
path contains a NUL byte (SQLite LIKE stops reading at one, so the SQL guard tests `instr(path, char(0))`
too, in step with the JS matcher `isSplitRefusedPath`), whatever
"Include event beacons" says, marks the response `meta.splitGuard: true`, and the chart says so in a caption.
The rows still count everywhere else: by path, by ET day or flight day, by campaign, and in the
metric cards. For the Best Sudoku v1.97.0 first-run counters that means plain totals: a game
start (`/game/start/<difficulty>`), a tour skip (the exact path `/tour/skip`) and a tour exit
(`/tour/exit-at/<stage>`, sent only right after a skip) are counted by path, by ET day and by web
or app site in the geo charts (with "Include event beacons" on), and in the morning read's
first-session funnel; `/api/popups` never counts them. `/tour/start` and `/tour/complete` are not
part of the rule. Likewise the Best Sudoku coach strip (`/coach/shown/<tip>`, `/coach/dismissed/<tip>`,
`/coach/closed-at/<tip>`, `/coach/tour-opened`; tip is place, wheel, notes, hint or clash) is an event family (path family
`coach`), kept out of page views; only `/coach/tour-opened` stays splittable, like `/tour/start` (`/coach/shown/…` is once per tip per device, so it is counts only like `/return`). The metric cards follow the same rule: in a country cell (`campaign-country`)
these rows belong to no country, so they count only where no country is asked, and
`campaign.completions` takes no `country` param at all. The same holds for the once-per-device first-finish row (`/game/first-finish`, path family `game-first-finish`, constant `FIRST_FINISH_PATH`): it marks a person who finished a puzzle, a device remembering its own first finish (no id), so it is counts only like `/return`. Its metric components `campaign.firstFinish` (people who finished) and `campaign.costPerFinisher` (stored spend over those rows) are usable in the card and chart editors. The ads morning read prints a WATCH-only line for them (no rule reads it; n/a until the app ships the row) and labels its per-row cost as including repeats. Cost per finisher is like for like: the rows only exist from the first whole ET day after the v1.103.0 web release (`FIRST_FINISH_START_ET` in `lib/releases.ts`, derived from that release marker, 10-27), so the line and the `campaign.costPerFinisher` ratio (numerator `campaign.spendFromFirstFinish`, a go-live-gated spend metric) divide that day's spend by that day's finishers (the ratio's finisher count has no time bucket, so it also holds the evening before; its caption says so) through the read's last closed day, and a read ending before 10-27 prints "not available before 10-27". Android counts keep rising as devices update. `/api/popups` and the ads-read
routine's hourly site-event read and per-country read leave them out too, and the routine's tagged read groups them by ET day (never by hour). The first-finish sign-in ask is counts only for the same reason (ruling 2026-10-24): its showing (`/signin-prompt/first-finish`), its eligibility row (`/signin-eligible/earned/first-finish`) and its outcomes (`/popup-outcome/signin-prompt/first-finish/<outcome>`) each fire once per device, right after its first finish. They are pop-up rows (`REFUSED_POPUP_PATH_PATTERNS`), so they still count wherever no split is asked: `/api/popups`, the pop-up metrics (`popup.shown`, the sign-in eligibility and outcome metrics, their daily series) and the routine's site-wide event read count them per ET day over whole ET days, never by hour. Every geo hour, place and device split and the routine's per-country read leave them out. The Overview **pop-ups shown** tile (`bsk.popupShown`) keeps its same-time arrows and live refresh, so it leaves the ask out and says so in a caption. Its taps still count in the accepts tile, since every sign-in ask taps the same reasonless `/signin-prompt/accept` row, so the Overview **tap rate** (`bsk.popupTapRate`) is no true share: it carries a caveat that it can read high (even over 100%). The rule still holds when the ask runs in the routine's windowed reads: the rule-3 site-wide ask count and the 24-hour-old prompt count take a refused row as its whole ET day. The Pop-ups page counts it, and its cards say it is counted as whole ET days. The guard keys on dimensions and drills;
a date range that is not whole ET days is handled by the whole-days rule below. One visible effect: the **Arrivals by ET hour of day** chart no longer counts an arrival
whose first beacon was a return or completion row, so its total can sit slightly below the
flight-day chart's. A chart that groups by the UTC `date` counts without these rows and carries the
caption; with event beacons excluded (their default) the only rows that would drop are refused rows
not on the event-beacon list, and there are none since game starts joined it. The default **Pageviews over
time** (Beacon page) and **Pageviews over time** (Best Sudoku · Traffic) trends group by `dateEt`
since layout version 15, so they count every row and carry no caption: layout version 15 moves a
stored copy of either from `date` to `dateEt` once, only when it is still exactly the shipped
default (same dataset, title, type, metric, limit and release markers, any id or position; the
match is a frozen copy of what v14 stored, not the current factories), and a chart with any other
title or setting keeps its axis. Charts by `dateEt` are unchanged. The "hide known test and household traffic" filter is
unchanged. The guard's path patterns are inlined as SQL literals, so it costs no D1 bound
parameters. So are the other registry-driven lists (the campaign `utm_campaign` values, the game-completion
prefix, the own-hosts exclusion and the metric segment cuts, each checked by `sqlLit` / `sqlInt`, which refuse
a quote), so a server query's bind count does not grow with the campaigns or patterns registered: every
`/api/geo` shape binds at most 81 of D1's 100, and a test fails any query that binds more than 90, with extra
campaigns registered.

Two things stay allowed, by ruling (2026-10-03). **New vs returning:** the device may remember
its own first visit, so a row's new/returning bit stays on these rows; it is what makes an
arrival an arrival (`arrival` dimension, the Arrivals tiles and charts), and the free-form
`visitor` dimension stays refused. **Fixed-instant cuts:** a metric may cut these rows at a
flight start, a release, a fix go-live or an ET day boundary (the metric registry's segment and
day indices, and the routine's tagged read, which groups these rows by ET day and cuts only
`new`-visitor rows at the release-health maturity instant, a running total up to an instant like "today
so far"), which is never an hour-of-day split. The routine's Play line names only the ET date of the first or last
`/return/` row, never its time. See
[`src/lib/splitGuard.ts`](src/lib/splitGuard.ts).

**A date range that is not whole ET days counts these rows over whole ET days.** Otherwise
three back-to-back one-hour ranges would read the rows back hour by hour. Each bound of the
range moves to the nearest ET midnight (an exact tie, noon, goes to the later one) for these
rows only; every other row keeps the exact range. Nearest is Mike's ruling (2026-10-03); the
two other rules (outward: widen to the whole days touched; inward: shrink to the whole days
inside) stay one constant away (`REFUSED_WINDOW_SNAP`). When the bounds meet, as for most
ranges shorter than a day, these rows count zero. A range already on ET midnights (the date
picker's ET days, a whole-day preset) runs exactly as before. Charts, `/api/completions` and
the metric cards' page range (`window: 'page'`, sparkline days included) all follow it and say
so in a caption: "Any return, game-start, completion, tutorial-completion, tour-skip, tour-exit, coach-strip shown, dismiss and close, ask-order A/B, paid-funnel,
first-finish or first-finish sign-in ask rows here are counted over whole ET days." The pop-up metrics (`popupRangePath`) follow it for the first-finish
sign-in ask and carry the same note. A chart shows it only when it can count one of those
rows, so never under a path or path-family filter none of them matches (a site filter does not
narrow it: it errs toward showing). A chart that leaves event beacons out (the default) counts none of them, since
game starts are event beacons too, so it shows no caption. Rolling presets (last 24 hours, last
7 days) are rarely on ET midnights, so most Best Sudoku views that count those rows carry it. It adds no D1 bound
parameters. Today's totals stay live (ruling 2026-10-03), so polling a running total still
shows when it grew; only shrinking to whole days and holding the open day would close that, and
live data was chosen over it.

**KPI tiles for counts-only rows show whole days, not same-time arrows.** A "today so far" count
tile normally compares today against the same clock time yesterday and over the 7 days before
(`vs yesterday`, `vs 7d avg`). For a metric that can count one of the counts-only rows above, that
comparison would give a closed day's count up to a clock time, an hour-of-day split of those rows
read after the fact. So the data layer (`bskKpiDays`) counts them over whole ET days (a same-time
flag is always off for them), and the tile shows one plain line instead of arrows: "Yesterday
1,234 · 7-day avg 1,180/day", yesterday's full ET-day total and the average over the 7 full ET days
before today (a whole number from 10 up, one decimal below; the two "delta" checkboxes in the
editor pick which part shows). **Best Sudoku Page views does not follow this rule** since 0.27.3: its
path test leaves out every refused path (`isSplitRefusedPath`, which folds case like the SQL guard, so a malformed upper-case
variant is out too) as well as the event beacons, so it opts out (`countsRefused: false`) and keeps
its same-time arrows. Because those rows are not in its count at all, no refused row is cut at a
clock time. A metric that never counts them (`countsRefused: false`: page views, auth successes,
game views, pop-up shown and accepted, and so on) keeps its same-time arrows unchanged. Like the
arrows, the whole-day figures follow neither the page's date range nor its filters: they depend
on today's ET date alone.

**Every stored geo-beacon column is a chartable dimension AND a filter.** `functions/api/geo.ts`
whitelists every analytic `hits` column (`GEO_DIMS`) — region/city/postal/country/continent/
timezone/colo/org/referrer/refpath/path/site/device/browser/os/lang/visitor/campaign/source/
medium/date, plus **screen width** (`screenw`, exact pixels) and its bucketed form
(`screenwBucket`: `<480` / `480-767` / `768-1023` / `1024-1439` / `1440+`), plus a derived
**path family** dimension (`pathFamily`) that groups every event-beacon prefix above into
`page` / `signin-prompt` / `signin-eligible` / `promo-first50` / `first50-congrats` / `upsell`
/ `install` / `popup-outcome` / `return` / `game-complete` / `auth-status` / `auth-error` /
`auth-redirect` / `coach` / `tour` / `tutorial-complete` / `game-first-move` / `game-abandon` /
`welcome-signed-in` / `game-start` / `funnel` / `ab-ask-order`. More derived
dimensions: **pop-up** (`popupFamily`) and **pop-up outcome** (`popupOutcome`), measured rows
only (from the tracking activation day; pre-fix install-gap rows get no value — see
[`src/lib/popupEvents.ts`](src/lib/popupEvents.ts) `popupDimSqlCase`, where
`/popup-outcome/first50-offer/…` resolves to the first-50 promo); a completed game's **mode**
and **difficulty** (`gameMode` / `gameDifficulty`, from `/game/complete/<mode>/<difficulty>`,
malformed rows as `(other)`); **campaign flight** (`campaignFlight`, decided by the same
`campaignAttributionClause` + `EXCLUSIONS` the campaigns endpoint uses); **arrival** (`arrival`:
a first-ever beacon, `tagged` when a flight claims it, else `untagged`); the Flight 3 Apps **landing tag**
(`landingTag`, the `/return/<tag>/d0` arrival rows of a tag a registered campaign claims; see the Campaigns
page card above); and **key event**
(`keyEvent`: `auth-success` base rows, `install` from the install fix on, `raw-install-signal`,
`game-complete`); the **feature step** (`featureStep`: `<feature>.<step>` for a Feature health
step in `FEATURES`, [`src/lib/featureHealth.ts`](src/lib/featureHealth.ts); grouped, a row lands on
its first matching step, while as a filter a step matches all its own paths, so two steps that share
a path each count it; with no split guard it counts whole ET days, like `/api/features`, and
echoes the counted window as `meta.since` / `meta.until`); the **ET hour of day** (`hourEt`, `0`-`23`, DST-aware like `dateEt`); and the
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
otherwise pass D1's 100-bound-parameter cap). The three that read the campaign registry
(`campaignFlight`, `flightDay`, `arrival`) look it up in one `flight_reg` table stated once at the
start of the statement (`withFlightRegistry`), not once per use, so a registered campaign adds
about 0.2 KB to the worst-case statement and no bound parameter: the 90,000-byte statement cap
holds about 48 campaigns for the heaviest ring the headroom test sweeps (the 8 costliest dims with 16 filters; API-only, the chart
editor stops at 5 dims) and about 19 with realistic campaigns, which have more ad groups and longer names and cost about 0.63 KB each
(a typical 5-dim ring holds about 280 more). The old per-use copy held 10 on a lighter ring (`bindHeadroom.test.ts` guards the heaviest
ring with 15 two-ad-group campaigns of room left). They filter exactly like a column — the same
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

## Range limits

A data source that caps how wide, or how far back, one query may reach is **gated before it is
queried**: a range the source would refuse is cut to the most recent window it allows (ending at
the requested end), and a range it accepts is never touched. A start moved forward lands on a
whole day: a UTC midnight for a `date` series (RUM buckets by UTC day, so the first bar is
complete), an ET midnight otherwise. `/api/stats` returns a runtime
`notice` — `{ kind: 'range-clamped', source, reason, requested, served, limitDays, lookbackDays }`
— which the chart card shows as a small note under the chart ("Jul 3 – Oct 3 shown
(Cloudflare limit: 93 days)."). When a range is cut, the response's
`meta.since` is the served start, so chart date axes cover only the days queried; the range asked
for stays in `notice.requested`. The notice is never saved: it is not part of the layout config
or widget schema. A range wholly outside the lookback is not queried at all. If Cloudflare still
refuses a range (its limits changed), whether in a 200 `errors` payload or a non-2xx reply, the
same note appears instead of the raw error, and that response is not cached; any other error
keeps its current behaviour.

| Source | Limit | Gated |
|---|---|---|
| Cloudflare RUM (`rumPageloadEventsAdaptiveGroups`: `/api/stats`) | 93 days (13w2d) per query; start no older than 184 days (26w2d) | yes |
| Cloudflare `/api/sites` RUM query | fixed 90-day window, under the 93-day cap | no need |
| D1: beacon `hits` (`/api/geo`, `/api/popups`, `/api/completions`, `/api/features`, `/api/metrics`) and the ads store | none (SQLite scans the range given) | no |
| Ads sync (Google Ads reads) | none that bound a dashboard range | no |

The limits are constants in [`functions/_lib/rangeGate.ts`](functions/_lib/rangeGate.ts)
`RANGE_LIMITS` (the one place), not fetched per request: a fetch would add a round trip and a
failure mode to every chart load for numbers that only change with the account's plan.
`npm run limits:check` compares them with the account's live settings
(`viewer.accounts.settings.<dataset>{ maxDuration notOlderThan }`, read with the local analytics
token and `CF_ACCOUNT_ID`, from the environment or `.dev.vars`, neither printed) and exits 1 on a
mismatch.

## Ads-read routines (Best Sudoku)

Node tooling in [`scripts/ads-reads/`](scripts/ads-reads/) that the scheduled routines in
[`docs/routines/`](docs/routines/) run from this checkout. It **proposes only** — it can't
change a campaign (the Google Ads client can only run GAQL `SELECT`s). The rules, thresholds,
exclusions, MIN_COHORT and ET-day logic are the same `src/lib` code the dashboard uses
([`src/lib/adsRules.ts`](src/lib/adsRules.ts) on top of `campaigns.ts` / `popupEvents.ts`), so
the routine and the dashboard can't disagree.

```powershell
npm run ads:sync -- --dry-run --cf-token-file <path-to-cf-token>           # the shared sync only
npm run ads:morning-read -- --campaign <id> --dry-run --cf-token-file <path>   # daily read; no writes
npm run ads:morning-read -- --campaign <id> --window-end <YYYY-MM-DD> --dry-run ...   # pin the window end before the registered flight end (F3 Search week-1 final read: 2026-10-23)
npm run ads:postflight-read -- --stage wrapup --campaign <id> --dry-run --cf-token-file <path>
npm run ads:backfill -- --dry-run --cf-token-file <path>                   # full re-pull + config check
npm run ads:morning-read -- --campaign <id> --fixture <file.json> --now <iso>   # offline, recorded data
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
  Credentials are read from Bitwarden Secrets Manager with `bws` (needs `BWS_ACCESS_TOKEN`, else the token file `~/.bws-token`, or `BWS_TOKEN_FILE`),
  or from env vars when that is unset (see
  [Running the ads reads from env vars](#running-the-ads-reads-from-env-vars-cloud)), into
  process memory, and are never printed, logged or written.
- **Beacon reads** use `wrangler d1 execute gss-geo --remote --json --command`: single
  `SELECT`s only, enforced before wrangler runs.
- **Store:** gss-stats' own D1 database `gss-stats-ads` (spend per day, placement-day cost,
  daily conversions and per-asset results ([below](#daily-conversions-and-per-asset-results-syncadsextras)),
  an append-only readings log and fire-once threshold state). Why and how:
  [docs/adr/0001-ads-read-store.md](docs/adr/0001-ads-read-store.md). Schema:
  [`migrations/gss-stats-ads/`](migrations/gss-stats-ads/) (`npm run ads:migrate`).
- **morning-read** syncs spend first, fires each of the campaign's spend-threshold reads once
  (full read + kill rules; the retest's are $25/$50/$75/$100), appends one daily line per ET day, checks the hard cap on every read, notes any
  earlier scheduled read that never ran, and evaluates release health (a missing child of a
  non-zero parent) every run — there is no longer a time-of-day gate on it. RETIRED
  2026-09-27: release health used to be skipped between 01:00 and 12:00 ET so the run could
  defer to a separate 23:15 ET `--release-health-only` backstop entry; the two entries are now
  one daily run, and the `--release-health-only` flag survives only as a manual/diagnostic
  mode. Parent/child maturity is enforced by the run-independent `parentAgeHours` cutoff (event
  timestamps, not the clock), so removing the gate does not weaken it. Pushes go out only on a
  threshold read, a kill-rule trip, a failed read, or a real release-health alert (parent at
  least MIN_COHORT, outcome window elapsed, child zero). The threshold push names any kill
  rule on WATCH and any rule that is NOT COMPUTABLE (e.g. `no kill rule tripped, NOT COMPUTABLE (funnel-reach), continue`).
  **Kill rule 3 (funnel-reach)** trips on zero tagged asks. Zero tagged arrivals always trips.
  The first-session mode is gone: the tutorial ask is being silenced by the client (and cached PWA
  clients may keep sending a few), so no tutorial row, stale or not, makes zero tagged asks decisive.
  Zero tagged asks with tagged arrivals reads **NOT COMPUTABLE** (status no-data, named in the push),
  never a false trip or WATCH, unless site-wide asks are known to be exactly zero, which still trips. Asks are counted over ASK_PATHS (placement, streak, tutorial,
  committed-repeat, committed-challenge, first-finish, first-50 promo).
  Every morning read also prints a **first-session funnel** (arrivals → game views →
  tour start → tour complete/skip, with the skips split by stage (preamble / hub / section) →
  game starts by difficulty → tutorial complete (first run vs replay) → first move → game
  complete, abandon-by-%-filled buckets, sign-in asks shown incl. the tutorial ask, and the
  signed-in welcome card), tagged counts with
  site-wide web counts alongside over the same window (attribution start to flight end or now).
  Arrivals are `/return/<uc>/d0` rows (one per device's first tagged visit): tagged = the
  campaign's own uc (web and app), site-wide = any uc on web. "Tracked" is decided per beacon
  family, since each family ships in one app release: tour + first move + abandon buckets; the
  welcome card; the v1.97.0 first-run counters (tour skip by stage, game start, tutorial
  complete); the tutorial ask. A family with no rows yet reads "not yet tracked", never 0%;
  once any member has a row, a sibling with none is a real 0. Ratios are rows over rows and never
  use game views (page views) as a parent. The first-run counters are counter totals read side
  by side, matched by exact path (the same matchers that classify them as events, in
  `popupEvents.ts`): no ratio between them and no join of any row to a device, time or place (the counts-only
  rule, under Data & dimensions).
  The stage line is the tour-skip rows split by where (`/tour/exit-at/<stage>` fires only on a
  skip), so it is printed under tour skip and never counted as a further step. A game start
  counts every counted start (menu, play again, or leaving the tour for a real game), so it
  cannot be matched to the skip that led to it. Informational only — never a kill rule or a
  push.
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
  new-client sign-in twice. Kill rule 3's asks include the tutorial ask
  (`/signin-prompt/tutorial`) and the provisional `committed-repeat` / `committed-challenge` / `first-finish` asks
  alongside placement, streak and the first-50 promo.
- **One reading per entry per day.** A reading is stored once per (campaign, ET day, entry
  kind: `morning`, `backstop`, `threshold-50`, `postflight-wrapup`, …). A same-day rerun is
  stored only when it carries new information (a complete retry of an incomplete read, a new
  pause proposal, a new release-health alert), and a threshold, cap trip or alert already
  pushed that day is not pushed again; a failed read always pushes. The database enforces it
  with a UNIQUE index (migration 0003).

### Running the ads reads from env vars (cloud)

The claude.ai cloud routine has no `bws`, no key files and no `--cf-token-file`, so every
credential the reads need can come from plain environment variables instead. Nothing here
changes the local default: with a bws token available (`BWS_ACCESS_TOKEN`, else the file `~/.bws-token`), the Ads keys still come from Bitwarden.

| Variable | Used for |
|---|---|
| `ADS_SA_B64`, `ADS_DEVELOPER_TOKEN` | Google Ads API through a service account, when no bws token is available (no `BWS_ACCESS_TOKEN` and no `~/.bws-token`): the service account's JSON key, base64 on one line, signed in with an RS256 JWT for the `adwords` scope (the same signer the Firestore reads use). The service account is added in Google Ads as a **Read only** user. Wins over the four variables below when set. The search requests carry the same headers either way. |
| `ADS_CLIENT_ID`, `ADS_CLIENT_SECRET`, `ADS_REFRESH_TOKEN`, `ADS_DEVELOPER_TOKEN` | Google Ads API through a refresh token, when no bws token is available and `ADS_SA_B64` is unset. All four are required. The names match the sync Worker's bindings ([`workers/sync/wrangler.toml`](workers/sync/wrangler.toml)). |
| `FIRESTORE_SA_B64` | Firestore COUNT reads, when `--firebase-sa` is not given: the service-account JSON, base64-encoded on one line. It is decoded in memory and never written to disk. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | wrangler's D1 reads and writes (`gss-stats-ads` and the beacon's `gss-geo`), with no `--cf-token-file`. |

Every secret is registered for redaction as it loads (`CLOUDFLARE_ACCOUNT_ID` is an identifier, not a secret). A missing-credential error names
variables, never values.

```powershell
npm run ads:cloud-check   # preflight: env var presence + one read-only probe per dependency
npm run ads:postflight-read -- --stage wrapup
```

`ads:cloud-check` prints one line each for `ads`, `firestore`, `d1-ads` and `d1-beacon`. Each
line shows every required variable NAME as `present` or `missing`, then `ok` or
`fail: <class>`. The probes are read-only: GAQL `SELECT customer.id FROM customer LIMIT 1`, one
Firestore COUNT the post-flight read already runs, and `SELECT 1` on each D1 database. A failure
prints only a fixed class (`missing-env`, `auth`, `timeout`, `network`, `http-4xx`,
`http-5xx`, `bad-credential`, `wrangler-missing`, `wrangler-exit`, `bad-response`, `error`),
never a value, token, id, count or error message. It exits non-zero if any line fails. The
`ads` line accepts either Ads credential set.

Every read CLI (`ads:morning-read`, `ads:postflight-read`) prints plain ASCII: the report, the
push text and the JSON block. Typography in shared labels (em dashes, arrows, `>=`) is folded
at print time, so a routine can relay the text exactly and still send ASCII.

#### Minting the cloud keys into Bitwarden

Three argument-free scripts mint the cloud routine's keys straight into Bitwarden (project
`prod`), for an agent to run locally with a bws token available (`BWS_ACCESS_TOKEN`, else `~/.bws-token`). Each one refuses if its key
already exists, hands the value to `bws secret create` from inside Node, and prints only
`stored <KEY> (prod)` plus non-secret names (a service-account email, a project id, a key id,
a token name and id). Service-account keys are created through the IAM REST API, so no key
file ever touches disk; if the Bitwarden store fails, the new key is deleted again. A reused
service account that holds any role beyond the expected one is refused. bws has no stdin form,
so a value is briefly on the `bws` command line (visible to the same user's processes).

| Script | Mints | Bitwarden key |
|---|---|---|
| `npm run ads:mint-firestore-sa` | Service account `gss-ads-reads-ro@best-sudoku-prod` with `roles/datastore.viewer`, and a JSON key | `infra--cloud-routine-env--FIRESTORE_SA_B64` |
| `npm run ads:mint-ads-sa` | Service account `gss-ads-reads-ads` in the Ads OAuth client's own GCP project (`best-sudoku-17306`, re-verified from the client id and the enabled Google Ads API), no IAM role, and a JSON key. Prints the email to add in Google Ads as **Read only**. | `infra--cloud-routine-env--ADS_SA_B64` |
| `npm run ads:mint-cf-d1` | Account-scoped Cloudflare token `gss-ads-reads-cloud-d1` with D1 Read and D1 Write (the CLI stores readings), no expiry, made with the local admin token | `infra--cloud-routine-env--CLOUDFLARE_API_TOKEN` |

#### Handing the env to the cloud environment

```powershell
npm run ads:cloud-env
```

It reads Bitwarden in-process, builds the `.env` block (`ADS_SA_B64`, `ADS_DEVELOPER_TOKEN`,
`FIRESTORE_SA_B64`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`WRANGLER_SEND_METRICS=false`, `ADS_ROUTINE_MODE=SHADOW`; never `BWS_ACCESS_TOKEN`) and copies
it to the Windows clipboard through PowerShell's standard input, marked to stay out of clipboard
history and cloud sync. It prints the variable names only, then clears the clipboard after 60 s
if it still holds the block (Ctrl+C or closing the window clears it at once). A third-party
clipboard manager may ignore the history exclusion. Paste it into claude.ai/code, environment
`gss-ads-reads`, **Edit environment**, **Environment variables**. The routine itself is
[`docs/routines/ads-cloud-daily.md`](docs/routines/ads-cloud-daily.md).

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
  (+ `flightStartTimeEt` if the schedule starts mid-day), `flightEnd`, `kind`,
  `installActionId` (the Google conversion action id whose conversions are this campaign's installs;
  unset means the campaign has no install figure, never 0), `dailyBudgetUsd` and `hardCapUsd` (both required to read it: they arm the pacing line and kill
  rule 4), `servingHoursEt`, `notes`, and `directionalThroughDay` if the first N flight days
  are directional. This alone puts the campaign on the dashboard and in the sync. The id and
  tag `organic` are reserved for the organic baseline row: a campaign using either fails at
  load. `status` is not stored in the registry: it is derived from the flight dates by
  `campaignStatusOn(campaign, todayEt)` (`upcoming` before `flightStart` or with no start yet,
  `active` from the start day through `flightEnd`, `closed` after), and the `status` on a `CAMPAIGNS`
  entry is a live getter for today in ET. Anything holding an injected date calls the function with
  it. The ads sync writes the derived status to the `ads_campaigns` row whenever it writes data (so that row can lag the in-app status). Cron syncs of a closed flight pull through `flightEnd` + 3 days; the post-flight reads pull through yesterday (`uncapped`), so stray spend after the end is still seen. A spend day newer than the latest stored conversion day has no install figure yet (the extras pass stores conversions apart from spend).
  Installs and cost per install: registry metrics `campaign.adsInstalls` (Google's conversions on the
  campaign's `installActionId`, summed over the stored spend days, attribution window) and
  `campaign.costPerAdsInstall` (stored spend over those installs, a ratio of sums, no data at 0
  installs). `campaign.adsInstalls` also has a daily series, like `campaign.spend` and `campaign.clicks`
  (the latter two now draw ad clicks too); the cost per install has no series by design.
  Ad assets: registry metrics `asset.impressions`, `asset.clicks` and `asset.conversions` (the stored
  `ads_daily_assets` rows of one asset in one campaign, summed over ads and days; params `campaignId` and
  `assetId`, attribution window), each with a daily series (a day the asset has no row is a gap, not
  a zero). Google's per-asset aggregates do not add up to the campaign totals, and the read is fail
  soft: with no ads database the cards show no value. The card and chart editors offer a repeat axis
  `over: 'assets'` ('One per ad asset') wherever they offer the campaign axis: one tile or sparkline
  per asset of a campaign (the enclosing campaign repeat's, or the repeat's own `campaignId`),
  labelled `asset.label` (the field type and the asset's text, else its name, else its id, for
  example "Headline: Free daily sudoku"), ordered by `sortBy` (impressions, clicks or conversions,
  highest first, impressions by default) and cut to the top `limit` (30 by default). The asset list and
  totals ride on `GET /api/ads/readings?assets=1`.
- **[`adsRules.ts`](src/lib/adsRules.ts) `ADS_READ_PLANS`** — one `buildReadPlan('<id>', {...})`:
  `channel` (`'display'`, the default, or `'search'`; see
  [Adding an arm](#adding-an-arm-two-campaigns-at-once) below),
  `thresholds` (the spend reads; the report page draws its ladder from them), `killRulesFrom`,
  `placementLeakMaxShare` (display only; optional and ignored for search), `ctrFloor`, `approvedPlacements` (display only), optional `allDevices` (search only: no desktop-only device flag), optional `adGroupPlacementCounts`
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

Five plans are registered now (the retest, flight 2's two arms and flight 3's two arms, which
register from their dates), so every read must pin its campaign. Before flight 2's arms were registered the default was the retest on every date, and
every invocation that omitted the flag behaved as it did before the registry (checked by running
every routine invocation against the base and the head: only `--help` differed). The retest's
routine docs pin it (step 1).

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
| Budget / cap | `CAMPAIGNS` `dailyBudgetUsd`, `hardCapUsd` | `$10`/day, `$70` cap over 7 days | same |
| Spend reads | plan `thresholds`, `killRulesFrom` | 25/50/75/100% of the cap in whole dollars (`18, 35, 53, 70`), kill rules from 50% (`35`) | same |
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
it covers that one day, not the flight so far); a search plan that serves on all devices sets
`allDevices` (flight 3's Search arm) and gets no such flag. Never a pass, never a trip. A search plan that
sets `approvedPlacements` or `adGroupPlacementCounts` is refused at load. Spend, impressions,
clicks, CTR (rule 2), funnel reach (rule 3), the hard cap (rule 4) and every beacon count read
the same for both channels.

**Flight 3 rule readouts.** Every flight 3 morning read prints an `F3 rules (proposals only; nothing
is paused)` block between the first-session lines and `Thresholds:`: nine numbered lines, each
`Rule <n> · <name>: <number> | threshold <t> → PASS | PROPOSE PAUSE | WATCH | NOT YET | NO DATA` (WATCH is
only a Play-direct arm's tagged-row rules, listed below, and never a pause proposal), then a
`Proposal:` line. Rules 1-4 are the coded kill rules above; 5 is the day 1-2 tracking check, 6 cost
per tagged complete row (at most $3), 7 the Apps first-move row ratio (at least 20% of d0 rows),
8 traffic held (derived from rules 2 and 6) and 9 the D+7 go / iterate / stop table
(`decideFlight3`, `src/lib/flight3Rules.ts`). Rules 5-7 read NOT YET until their data exists and CTR
arms from flight day 3; rule 9 reads NOT YET until flight day 8; on an arm whose flight runs past day 7 (Search) the day 8 to flight-end dailies label it `D+7 verdict (interim, week <n> running, 2 on days 8-14 and 3 on days 15-21; final on <end + 1>)`. A rules 1-7 pause proposal pushes
once per ET day per arm; the cap decision push on a flight 3 row reads `F3 verdict GO | ITERATE |
STOP | INCONCLUSIVE`. The cloud read on flight end + 1 stores its row but sends no push or bus
message: the 07:05 final read reports the verdict. The flight 3 day15 read leaves out the purchase
rows (the D + 21 purchases read owns them; the JSON still holds them). Every figure is a tagged row
count or dollars (counts only), and flight 2 and
retest reads print exactly what they did before (pinned byte for byte by `f2ReportGolden.test.ts`).
Rows the app's own manual production checks write (`utm_campaign=manual_check`, `/return/manual_check/`
paths) sit in the standing exclusions (`EXCLUSIONS` in `campaigns.ts`), so the campaign reads, the
morning read and every chart or fact that applies "hide known test and household traffic" leave them out.
A few readers have no such setting and always drop them: the pop-ups reader (`/api/popups`) and its
two range facts, `/api/completions`, the site tag counts in `/api/sites`, the geo charts and maps
(`/api/geo`) with "hide known traffic" off, and the flight-paths-seen read.

**Flight 3 report gaps.** The flight 3 morning read also prints: an `impressions balance: UNEVEN | even
enough` line under the per-tag split (each ad's share of tagged-ad impressions; UNEVEN when the shares are
more than 20 points apart, then compare rates, not totals), a `coach strip` line (tagged coach tip rows as
ET-day totals, never split by hour, place or device), tagged new accounts as a cumulative count with the
v1.99.2 measurement-change caveat, the two arrival counts under distinct labels (`arrivals (new-visitor
tagged rows)` vs `d0 devices (/return/<tag>/d0)`), and the per-arm cost-per-arrival baselines (Apps about
$0.32-0.34, Search about $0.64). Both flight 3 arms serve 12:00-24:00 ET. Flight 2 and retest reads are
unchanged (pinned by `f2ReportGolden.test.ts`).

**Flight 3 Search, Ads side.** The Search arm's morning read also prints a `Search Ads side` block built
from Google Ads alone (three read-only GAQL SELECTs in `src/lib/adsApi.ts`: campaign per ET day,
campaign over the range so Google aggregates the shares, and `keyword_view`): impressions, clicks,
average CPC, search impression share and the shares lost to rank and to budget, per closed ET day and
cumulative, plus a per-keyword table (`keyword_view` refuses lost-to-budget, so keywords carry impression
share and lost-to-rank only). Google's sentinels print as `<10%` (impression share below its 10%
floor), `>90%` (a lost share over its 90% cap) and `n/a` (no figure), never 0%. From flight day 3 the block
ends with `Search: X clicks/day, avg CPC $Y, lost to rank Z% → bid-limited | budget-limited | fine` and a
proposal (`PROPOSE: raise the 'app' keywords only to $1.25 max CPC (Mike decides)` at under 2 clicks a day
and 50%+ lost to rank, else `HOLD $0.99`); before day 3 it reads `NOT YET`. Cut-offs: `SEARCH_READOUT` in
`src/lib/searchAdsSide.ts`. Proposals only: no Google Ads setting is changed. Both flight 3 arms' Spend
line also carries the average CPC (cost / clicks) and that arm's baseline cost per arrival (`F3_ARM_BASELINES`).

**Staging an arm, activated by its dates.** Flight 3's two arms hold everything in code: the
Google Ads ids and tags (`STAGED_FLIGHT_3` in `campaigns.ts`) and the read-plan settings
(`STAGED_FLIGHT_3_PLAN_SETTINGS` in `adsRules.ts`). An arm is registered, and so synced, charted and
read, only once both its `flightStart` and `flightEnd` are filled in `STAGED_FLIGHT_3_DATES`
(`campaigns.ts`); with both null it is in neither `CAMPAIGNS` nor `ADS_READ_PLANS`, and exactly one
set throws at load. Both arms are live for 2026-10-17..2026-10-23 (Apps started ahead of the Play release, so
its report carries a one-line Play-install caveat only for a reading that starts before v1.99.3 went public on Play, 2026-10-17T06:34:32Z, so flight 3 reads print none). The same two dates go in the arm's `by-date` row of the runbook (a test
fails if they differ), and the flight 3 post-flight reads are derived from them (wrapup on flight
end + 7, day15 on flight end + 15). The remaining manual steps (the D + 7 07:05 ET final read, the
D + 21 and D + 35 purchase reads, enabling the campaign in Google Ads) are in
[docs/routines/ads-cloud-daily.md](docs/routines/ads-cloud-daily.md), "To activate flight 3".

With several plans registered, **every** read must name its campaign: omitting `--campaign` exits 1
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

### The Play-direct arm kind and the Play install lines

A **Play-direct** arm is a campaign whose ads open the Play Store listing instead of a web page
(`CampaignFlight.kind === 'play-direct'`; a staged arm sets `kind` and, for a window shorter than
seven days, `servingDays: { min, max }` in `STAGED_FLIGHT_3`, `src/lib/campaigns.ts`; unset means
a 7-day web arm). Everything below follows from that registry property, never from a campaign id.
There is no web arrival, so the first open is the proof: the app reads the Play install referrer
and its first open writes a tagged `/return/<uc>/d0` row.

- **Tracking check (rule 5).** From flight day 2, at 30+ closed-day clicks with no tagged `/return/<uc>/d0` row the
  rule reads `WATCH`: `Watch: N clicks, 0 tagged first opens`, then the reason it is a watch item, not a
  break (an emulator check on 2026-10-19 showed the Play-delivered app emits `/return/<uc>/d0` and tags
  later beacons; if Play's UTM file later shows acquisitions while tagged first opens stay 0, the break is
  Play handing the referrer to the production app; at this size 0 opens can also be chance). It is never a
  pause proposal, and no Google Ads setting is changed.
- **Play Console installs.** `scripts/ads-reads/play.ts` also sums Play's store-listing file by its
  UTM campaign column, one row per tag (`acquisitionByUtmCampaign`: listing visitors and listing
  acquisitions as Play prints them, aggregate counts only). A Play-direct morning or post-flight
  read prints the arm's own figure from it (`scripts/ads-reads/playDirect.ts`), labelled by how
  far Play has caught up: `PARTIAL` until the store-listing data runs seven days past the flight
  end, `INSTALL VERDICT` after. With no row for the tag it says `not landed yet (lags 6-14 days)`
  while Play's data is short of the flight end, and `no row ... (0 acquisitions as printed)` once
  it is not. Play's bulk files lag 6-14 days, so an early post-flight read is expected to say `PARTIAL`
  and a later one `INSTALL VERDICT`.
- **Acquisitions are not device installs.** A store-listing acquisition is an installer Play ties
  to a visit through the tag. The installs-by-day lines count every device install on the account,
  the developer's own household devices included, with no campaign attached. The report prints this
  note under the install line and never subtracts one from the other.
- **Baseline.** Each read also prints the closed Play-direct twin (found by `kind` and
  `status: 'closed'`) beside the arm: its stored spend ($75.17), its figures from a second Play
  read over its own dates by its own tag (September's file: `2 acquisitions / 120 listing visitors
  (UTM file)`), and `tagged app rows: none`. A separate quoted note, `"8 net device installs"
  (hand-derived in the September review ...)`, carries the review's hand-derived number with its
  source; it is not read from any file, and it prints only beside that September twin.

- **WATCH rules on a Play-direct arm.** Tagged rows here depend on Play's referrer hand-off, the
  numbers are tiny, and the arm's question (installs) cannot be read in flight, so every rule that
  reads tagged app rows prints as a `WATCH` line, with no pause proposal and no push (keyed on
  `kind === 'play-direct'`, never an id): **rule 3** (funnel reach reads tagged ask rows; the kill
  evaluation reports its zero-asks finding as `watch`, not `trip`, so neither the daily proposal nor
  the threshold push sees it), **rule 5** (the tracking check above), **rule 6** (cost per complete
  row) and **rule 7** (first-move row ratio). A rule that would have proposed a pause prints WATCH
  instead; one that passes still passes. **Rules 1 (placement leak), 2 (CTR floor), 4 (hard cap) and
  8 (traffic held)** are Ads-side, mean the same thing here and still propose a pause; rule 8 rests
  on the CTR half alone while rule 6 is a WATCH line. **Rule 9** stays NOT YET until the arm's day-8
  verdict day (the last read is flight day 6) and prints the interim tagged first opens
  (`/return/<uc>/d0`) and sign-ins (`/auth/success/*/new`) beside it, naming the 11-21 d35 read as
  the install verdict.
- **Cost per tagged first open.** A `WATCH · cost per tagged first open` line under the first-opens
  line: closed-day spend over the tagged `/return/<uc>/d0` count in those same closed days (today's partial day is in neither), with the September twin's
  ~$9.50 per net install as its reference, labelled hand-derived in the September review (the same
  source note as the net device installs figure; never computed from a file, and printed only beside
  that twin). With 0 opens it reads `no tagged first opens yet`. A first open is not an install, so it
  is a watch figure and never a rule.

These lines are report text and data only: no widget, no kill rule, no visitor id and no join, and
no hour, place or device split on return, complete, start or tour rows. Tests:
`playDirect.test.ts` (labels, baseline, lines) and `playDirectArm.test.ts` (a made-up arm read end
to end).

### Flight 4: an App install campaign, spend-only

**Flight 4 - Android installs** (campaign 24392866056, `kind: 'play-direct'`, `measurement: 'spend-only'`;
`src/lib/campaigns.ts`) is a Google Ads **App** campaign for the Play app: $10 a day, US/English,
2026-10-26 (noon ET) to 2026-11-02, about $75 in all. Its result is the Play installs Google reports
(conversion action 7756366796). It has no SDK, utm tag or install referrer, so it writes **no beacon
rows**, and Google's install counts cannot be joined to the site's own counts. It is registered
spend-only with **no read plan** (`ADS_READ_PLANS`): the morning and post-flight reads and the kill
rules never run on it, and the morning read's default campaign still comes from the read plans only.
The dashboard shows its spend (the $75 cap is in the registry); the ads lead reads its installs from Google Ads.
Its `ucValues` holds one placeholder tag, `sudoku_f4_android_installs_no_beacon` (`F4_NO_BEACON_TAG`),
that no row carries; it exists only because an empty `ucValues` breaks the beacon SQL. The entry sets
`noPlacements: true`, so the hourly sync (the `gss-stats-sync` Worker) pulls its daily spend but never
the placement report (an App campaign has no placement report, so the pull is skipped rather than risked), and a
skipped pull is never counted as a missing day. Every other campaign pulls exactly as before.
It is also not a baseline twin: `closedPlayDirectCampaigns` leaves out a `noPlacements` arm, so a later
Play-direct read never prints it as the September twin once it is marked closed.
Tests: `scripts/ads-reads/f4AndroidArm.test.ts`.

### Play installs (`ads:play-sync`, table `ads_play_daily`)

The Best Sudoku Retention page's **Play installs** card (preset `play-installs`: registry
metrics `play.deviceInstalls`, `play.deviceUninstalls`, `play.activeDeviceInstalls` and
`play.dataThrough` over the fact `adsPlayDaily`) shows Google Play's whole-app daily totals for
the page's date range. They live in `ads_play_daily` (migration `0005_play_daily.sql`): one row
per Play day with four nullable counts and `fetched_at`, nothing else. Counts only, read as
rows only: there is no hour, country, source or device column, no campaign, and no join to
beacon rows.

What the figures are, and are not:

- **Lag.** Play's bulk reports trail by about 3-7 days, so the card shows a "data through" date.
- **Play's day.** Play reports in its own day, which is not confirmed to be the ET day, so Play
  days are never added to ET-day figures. The card follows the date range only; the sites and
  own-visits filters do not apply to it.
- **Active device installs is a stock**, shown as the last stored day in the range, not a sum.
- **Household.** The counts include our own devices and cannot be attributed to a campaign (no
  install-referrer capture).
- **No retention.** Play's bucket has no retention report, so the card has no retention figure
  and no ratio.
- **Before the first sync** the card says "no Play figures stored yet". A missing table or
  binding reads the same way and costs the page nothing. Any other read error (a D1 outage, a
  bad statement) shows as an error on the tiles, never as "no figures yet".

**How to activate (one time, run by a person; neither CI nor the Worker does it):**

```powershell
# 1. Create the table in the production ads database. First list what is pending (read-only);
#    only 0005 should be. ads:migrate applies EVERY pending migration to the production
#    gss-stats-ads database and uses wrangler's own auth (`npx wrangler login`, or
#    CLOUDFLARE_API_TOKEN in the environment), not --cf-token-file.
npx wrangler d1 migrations list gss-stats-ads --remote
npm run ads:migrate
# 2. Dry run: reads the Play bucket, writes nothing, needs no Cloudflare token
npm run ads:play-sync -- --play-sa <path-to-play-service-account.json> --dry-run
# 3. The first real sync (idempotent: re-running overwrites the same days)
npm run ads:play-sync -- --play-sa <path-to-play-service-account.json> --cf-token-file <path-to-cf-token>
```

The default start is 2026-09-26 (the Play tracking go-live); `--since` / `--until` change the
range. Re-run the sync whenever fresher Play days are wanted (Play re-posts recent days; the
upsert overwrites them, except that a count Play leaves blank keeps the last stored number). A
**new** Retention page includes the card; a page already created from the template does not
gain it, so add it from the card picker ("Play installs").

### Carry-over completions (Retention page)

The Retention page's **Carry-over completions** card (preset `carry-over-completions`: the
site-wide `bsk.completions` total beside the `bsk.carryOverCompletions` per-day line) shows games
completed per ET day with **no campaign tag** on the beacon row: mostly players coming back on their
own, but a weak signal. The campaign tag lasts only 30 minutes, so an ad-acquired player who returns
later is untagged and counts here too. The card says so.

- **Definition.** "Tagged" is the shipped `anyTag` rule (any non-empty `campaign` on the beacon row,
  as `bsk.taggedArrivals`); carry-over is the complement, counted from the same completion rows as
  `bsk.completions` (the page's sites, date range and refused-row whole-day snap), so it is never
  above the site-wide count and can never go below zero. BSK's first-touch and organic rules belong
  to the returns metrics and are not re-derived here. No tagged-completions metric ships, and
  `campaign.completions` uses a different tagged rule (registered tags from the flight start), so
  carry-over plus the campaign completions is not the site-wide count.
- **Counts only.** It reads the existing `bskRangePath` / `bskRangeDaily` facts: ET-day totals, no
  hour, place or device column, no visitor id and no clock time, and no new SQL or bind.
- **Only new Retention pages.** It is in the page template, so a new page (and "Restore default
  charts" on a page made from the template) includes it; a page already created does not gain it,
  so add it from the card picker ("Carry-over completions").

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
the readings log card (`/api/ads/readings`) show **"Spend through &lt;date&gt;"** and **"synced
&lt;relative time&gt;"** per campaign, and **"stale — sync pending"** when a flight day that should be stored
by now is missing: yesterday from 09:30 ET (the 08:00 ET morning read has synced by then),
otherwise the day before. A sync run that claimed and never finished (killed mid-run, e.g. by
a CPU limit) shows as a **"Sync alert"** line in the readings log card once it is 15 minutes old
(for 7 days), and the morning, backstop and post-flight reports print it as `SYNC ALERT`. Their **Refresh data** button posts to `/api/ads/refresh` (behind
the sign-in gate), which asks the sync Worker to run only when something is stale, at most once
per 10 minutes. The dashboard holds no Google Ads credential and never calls the Ads API.

### The readings log card

The ads routine's readings log is a metric card like any other (preset `ads-readings-log`, ADR
[0005](docs/adr/0005-retire-bespoke-widgets.md)): one block per campaign that has activity, each
with its freshness lines (spend through, synced, thresholds fired, sync alerts) above a table of
that campaign's stored readings, newest first. The **Refresh data** button sits above the blocks,
after the page notices. A stale freshness line ("stale — sync pending") is plain text, no longer
red. It is edited
like any card (**Customize…**), can be fitted to its content, and a page can repeat it. Two small
engine hooks serve it and any other card: a **cell tone** (the Rules and Proposal cells are
coloured trip / watch / clear / muted by the reading itself, which styles a value already shown and
adds no data) and a **column hint** (`MetricItem.hint`, the header cell's tooltip; Sign-ups says
that the figure is an upper bound). First load shows "Loading…", a refetch keeps the
rows up, and a failed load (including one that takes longer than 15 seconds) shows the card's own
"couldn't load" status with Retry and no "no campaign has readings" line. A wide table scrolls
sideways inside its block, and a card only loads the readings when it reads them: the campaign
cost card, which shares the Refresh data button, never calls `/api/ads/readings`.

A saved layout needs no change. A widget with `dataset: 'ads-readings'` and no `card` is mapped to
the preset when it is drawn, so its stored fields (`dataset`, `view`, `campaignIds`, `limit`, `type`)
stay as they are and an older build still reads it. `campaignIds` narrows the campaigns, `limit`
(default 30, at most 500) sets the table's row limit, and any `view` draws the log, the only view it
ever had. In the chart editor there is no View picker any more (no data source left to need one): choosing the "Best
Sudoku ads readings log" data source for a new chart starts it as the preset card; an existing widget
is not converted by opening it.

The card shows counts only: a reading's table cells read the five whitelisted counts (tagged
arrivals, asks, accepts, auth successes, sign-ups) and nothing else of the stored record, and no
return, game-start, tutorial or tour figure, hour, place or device is reachable from it.

### The Campaigns page's Flight 3 cards

Three cards read flight 3 on the Campaigns page. Each is a metric card (customize it like any other);
none adds a data source of its own.

- **Flight 3 rules** (preset `f3-rule-readouts`, widget `cw-f3-rules`): one block per flight 3 arm
  with the newest stored morning read's ET date, flight day and proposal, then the nine rules as the
  morning report prints them (rule, number, threshold, verdict). A PROPOSE PAUSE verdict and
  proposal show in red; a read with no stored rules yet says "no F3 read yet". The rules come from a
  new nullable column on the readings log, `ads_readings.f3` (migration `0006_readings_f3.sql`),
  which the daily read fills for flight 3 arms only; older rows and other campaigns' rows leave it
  empty. The card loads the readings through `/api/ads/readings` like the readings log card. It
  shows the report's text and changes nothing: proposals only, nothing is paused.
- **Flight 3 daily counts** (preset `campaign-f3-daily`, widget `cw-f3-daily`): one block per
  flight 3 arm with three rows, completed games, sign-in asks (the three the flight 3 app sends:
  placement, committed repeat and committed challenge; streak, tutorial and first-50 asks and the
  ask-order test twins are left out) and new accounts (`/auth/success/<provider>/new`). Each row
  has a sparkline and the latest 14 ET days listed with their counts ("Oct 17 12 · Oct 18 9").
  Counts only: a day is the finest cut, so there is no hour, place or device and no country
  option on these metrics. Before an arm is live the block reads "Flight 3 has not started".
  The new-accounts row carries the v1.99.2 measurement note like the other auth-success cards.
- **Cost card additions** (preset `campaign-cost`): **Average CPC** (stored spend over the stored
  Google Ads clicks, which only the ads store holds, so a hand-entered spend total reads "no data")
  and **Cost / completed game** (spend over the campaign's tagged completed-game rows, withheld
  under the usual minimum count). A caption under the card says the cost per auth success divides by
  all auth successes, not only new accounts, and is approximate from v1.99.2 because the count now
  carries first-touch tags while sign-in screens mostly do not.

### The sync Worker (`workers/sync/`, `gss-stats-sync`)

- **Schedule:** a cron at :05 every hour. While a flight is live (first day through the day
  after the last) every tick checks what is due: yesterday once, at 03:05 ET (before 03:00 ET it
  cannot close yet, so it is not due), a retry after a failure, and the restatement window once
  its last pull is 6 h old. Outside a flight only the 03:05 ET tick checks. A tick with nothing due reads two small queries and stops: no
  claim, no secret read, no token refresh, no write. A second cron, `20,50 8-11 * * *` UTC, runs only
  the conversions-and-assets pass ([below](#daily-conversions-and-per-asset-results-syncadsextras)).
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

### Daily conversions and per-asset results (`syncAdsExtras`)

A second pass, [`syncAdsExtras`](src/lib/adsSync.ts), stores two counts the cost sync does not,
read-only GAQL like the rest, counts only (no user, device or place split):

- **Tables** (migration `0007_daily_conversions_assets.sql`): `ads_daily_conversions` (per
  campaign, closed ET day and conversion action: conversions and all conversions),
  `ads_daily_assets` (per campaign, ad group, ad, asset, field type and day: impressions, clicks,
  conversions, performance label) and `ads_assets` (what each asset is: type, text or name, first
  and last day seen). Every syncable campaign is included, the spend-only arm too.
- **Schedule:** its own Worker cron, `20,50 8-11 * * *` UTC (eight ticks, 04:20-07:50 EDT or
  03:20-06:50 EST, after the 03:00 ET close; one cron trigger, so the Worker uses 2 of the Free
  plan's 5). The hourly cost cron never runs it, and it never runs the cost sync. A tick with
  nothing due reads one row and stops.
- **Window:** each campaign's flight start through flight end + 3 days, by the registry's dates
  (not its status), never past the last closed day (the cost sync's close rule). The last 3
  closed days of that window are re-pulled whole at most every 6 h (restatements; the eight
  ticks span under 6 h, so once a day); any other day is pulled once, when it is missing, and
  never again.
- **Per-run budget (Workers Free):** each run is planned before it fetches, so it never pulls
  what it cannot write: about 120 rows (each kind estimated from the most rows one day has
  returned, 6 conversion and 30 asset rows until then) and the 40 D1 statements less the run
  row's reserve, every row assumed changed. Campaigns go least recently tried first, in flight
  before ended; the newest days first. A re-check too big for one run is split, newest days
  first, and stays due until all 3 days are in. The run's first campaign takes at least one day
  even past the row budget (the statement budget still holds), so a dense campaign still moves.
  The rest continues next tick. Measured locally (parse, diff,
  statement build and planning; network and D1 waits are not CPU): about 4.5 ms on a cold
  isolate, about 1.3 ms warm, against the 10 ms limit.
- **Error isolation:** the pass keeps its state only in its own `ads_sync_runs` rows (`run_key`
  starting `extras:`), which the cost sync's "synced" time, rate
  limit and claim ignore. A failed conversions or assets pull marks only that kind stale for
  that campaign; it never touches the spend rows, their freshness or the other kind. An empty
  response over stored days counts as an error and writes nothing; a conversion action missing
  from a returned day is stored as zero (asset rows are never zero-filled).
- **Backfill:** `npm run ads:backfill -- --dry-run --cf-token-file <path>`, then the same without
  `--dry-run`: after the cost backfill it runs this pass with `full` and no cap, every
  campaign's whole window (above) re-pulled in one run, whatever the cost sync's outcome.

### Spend-only arm daily line (`ads_readings`, flight 4)

A spend-only arm (no read plan, no rules) still gets one daily line in `ads_readings`, built only
from the stored cost and conversion rows (no Google Ads call): date, spend, impressions, clicks,
installs (the conversions of the campaign's `installActionId` in the registry, never a hardcoded
id), cost per install (`null` with no installs) and cumulative spend against the `hardCapUsd`
cap. It is labelled "spend-only, Google-reported installs" and reads `INFO`: no rule, verdict or
proposal, and spend at or over the cap is information only. `npm run ads:morning-read -- --campaign
24392866056` stores every closed day since the flight start that is not yet stored (so the first
run backfills; a rerun stores nothing, one row per campaign and day) and prints the line as the
push text; a day whose spend or install conversions are not synced yet is left for the next run
instead of being stored as zero. The cloud routine runs it daily 2026-10-27 to 11-03
([runbook](docs/routines/ads-cloud-daily.md)).

## Live updates

An open dashboard tab refreshes its numbers by itself shortly after new traffic is counted, with no
polling. It is push, not a timer: nothing is sent while nothing happens.

**How it works.**

1. The beacon ([gss-beacon](https://github.com/GoodStuffSoftware/gss-beacon)) tells the
   `gss-live` Worker (`workers/live/`) after it has written a **non-refused** row. The call is
   fire-and-forget and swallowed on any error, so the pixel never fails because of it.
2. `gss-live` holds one Durable Object (`LiveHub`) with the open tabs' hibernating WebSockets.
   It sets one alarm for the **next 15-minute ET boundary** (:00/:15/:30/:45, which are also the
   epoch boundaries, since ET offsets are whole hours). Any number of notifies before then share
   that alarm. With no tab connected, a notify sets nothing.
3. At the boundary the alarm sends every socket the literal text `{"t":"changed"}`.
4. A tab that is **open, visible and recently used** (input in the last 2 h) holds the socket
   (`/api/live`, a same-origin Pages Function behind the normal sign-in, bound to `gss-live` by
   the `LIVE` service binding). On a ping it waits 95–120 s after the ping arrives (the server sends it at the
   boundary, so that is past the 90 s edge-cache TTL and the refetch cannot be served the answer
   from before the change; the spread keeps tabs from all hitting at once; counted from receipt,
   never from the browser's clock, so a skewed clock cannot fire early) and then refetches **only
   the cards flagged `liveSafe`**, in the background, never while a load is running. A chart
   refetches at most once an hour this way, and a chart whose request has changed since the flagged
   answer (an editor change to its type, rings, dataset or filters) waits for a fresh flagged
   answer first. A hidden or idle tab closes its socket and drops pings; the existing
   return-to-tab refetch catches it up. With no socket at all, the dashboard behaves exactly as
   it did before live updates.
5. The hub holds at most 100 open sockets. Each socket carries its accept time (a bare number,
   set when it is accepted). At the cap a new connection **closes the open socket with the oldest
   accept time** (close code 1013, "try again later"; a socket that is already closing does not
   count toward the cap) and is accepted, so one leaky tab or script evicts itself instead of
   locking everyone else out; an evicted tab reconnects with backoff. Any answer from
   `gss-live` other than a real WebSocket upgrade reaches the browser as a bare `503`, with no
   detail.

**Privacy: counts only (rows only).**

- A refused row (`SPLIT_REFUSED_PATH_PATTERNS`: `/return`, game-complete, game-complete-deferred,
  tutorial-complete, tour skip and exit, coach shown, dismissed and closed-at, ask-order A/B, paid funnel, game-start, first-finish, and the first-finish
  sign-in ask's showing, eligibility and outcome rows; any path containing a NUL byte counts as
  refused too, because SQLite LIKE stops reading at a NUL) **never triggers or shifts a ping**: the
  beacon does not call `gss-live` for it. The beacon keeps its own copy of the list, pinned equal to
  this one by a literal in both repos' tests (`src/lib/splitGuard.beaconParity.test.ts`).
- The ping carries nothing: no row, id, count, path, site or clock time, and it only ever lands on a
  15-minute boundary, so it adds no time resolution to any count.
- The Durable Object stores **only its alarm**, and each socket carries only its accept time (used
  to evict the oldest at the cap). It keeps no row data and no count, and `notify()` takes no
  arguments. No client ever sees a row id or a count through this path.
- Fail closed: the server marks a response `liveSafe: true` only when it cannot count a refused row
  (a `/api/geo` answer whose request reaches no refused pattern; a `/api/metrics` value whose
  metric, or both sides of a ratio, has `countsRefused === false`). The client refetches on a ping
  only on an explicit `true`. A missing flag, an error or an older server means no ping refetch.
  Charts over event beacons and every `/api/completions` chart never refetch on a ping.
- **`/api/stats` (Cloudflare RUM) never refreshes on a ping.** RUM is not beacon data, so a beacon
  ping says nothing about it. It still loads on page load, filter change, Refresh, return and ET
  midnight, as before.
- **`/api/completions` never refreshes on a ping.** Its rows *are* refused paths.

**D1 cost (every figure here is an estimate from the design note, not a measurement).** The free account allows 5M D1 rows read per day account-wide (about 29 % used on an
ordinary day, see [Capacity](#capacity)). A live refetch re-reads about 10k rows for an Overview
batch and about 20k for a full chart page. Uncapped, a tab left visible 24 h with a non-refused row in
every window would cost an estimated 96 × 10k = 960k rows a day (19 %) on the Overview and 96 × 20k = 1.92M (38 %) on
a full chart page. Two caps bring this down: pings are ignored after 2 h without input, and a chart
refetches on a ping at most hourly (metric cards are not capped, only charts are; the socket stays up to
2 h after the last input); a full chart page left open and used for 8 hours is then about
400k rows (8 %, an estimate that leaves out that 2 h tail, which would make it roughly 500k). The edge cache and the 60 s return throttle still apply. Workers and the
Durable Object are estimated at $0 on Workers Free: about one notify per written non-refused beacon (hundreds
to about 2,000 a day during a flight; each is one Durable Object request even with no tab open, though it
sets no alarm then), at most 96 alarms a day plus reconnects, plus the 50 s keepalive, which may count as
incoming messages at 20:1 (about 86 requests per all-day tab), against 100k
Durable Object requests a day, with about zero billed duration under hibernation. No plan change
and no D1 migration. Load detail: [docs/capacity.md §10](docs/capacity.md).

**Deploy order and recovery.** `gss-live` has no public URL (`workers_dev = false`, no routes). Its
only callers are two service bindings.

1. On the first deploy, `deploy-live` (see [Deploy](#deploy)) deploys `gss-live` before the Pages
   `deploy` job runs, because Pages' `LIVE` binding needs the Worker to exist.
2. Check `gss-live` is in the Cloudflare Workers dashboard.
3. Only then merge and deploy the beacon (`npm run deploy` in gss-beacon). Deployed earlier, its
   binding would point at nothing and the beacon would simply not notify.
4. Check it works: load a normal page, then look at the `gss-live` Observability log for a `Notify`
   call (a real, non-refused hit; the owner's own IP is excluded, so use real traffic or another
   network). If none appears, the beacon's binding or `entrypoint` is not wired.

If `deploy-live` fails on the first merge (usually a token that lacks **Workers Scripts: Edit**),
`gss-live` does not exist. **UNKNOWN: Cloudflare's docs do not say what a Pages deploy does when its
`[[services]]` binding targets a Worker that does not exist.** It may reject the deploy (production
stays on the previous version), accept it with `/api/live` answering `503` (the dashboard works without
live updates), or accept it with the Functions bundle failing (every `/api/*` call breaks). If
`deploy-live` is red but `deploy` is green, open stats.goodstuff.software at once and confirm the
dashboard loads; `/api/live` returns `503` until `gss-live` exists. Fix the token
(`CLOUDFLARE_WORKERS_API_TOKEN`, or `CLOUDFLARE_API_TOKEN`), then **Actions → Deploy → Run
workflow** on `main`: a manual run (when not paused) deploys `gss-live` first and then Pages. If `gss-live` is down
later, notifies fail silently, sockets drop, tabs reconnect with backoff (1 s doubling to 5 min, kept across a tab switch) and
the dashboard works as it did before. To stop `gss-live` deploys, set the repo variable
`LIVE_DEPLOY_PAUSED` to `true`: nothing deploys it then, a manual run included. After removing the
variable, use **Run workflow** to ship what merged meanwhile.

## Docs

| Area | Entry point |
|---|---|
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Contributing / conventions | [CLAUDE.md](CLAUDE.md) |
| Auth design (ADR) | [docs/adr/0002-google-auth.md](docs/adr/0002-google-auth.md) |
| Ads store decision | [docs/adr/0001-ads-read-store.md](docs/adr/0001-ads-read-store.md) |
| Metric components design (ADR; slices 1-7 built) | [docs/adr/0003-metric-components.md](docs/adr/0003-metric-components.md) |
| Retiring the remaining bespoke widgets (ADR; plan) | [docs/adr/0005-retire-bespoke-widgets.md](docs/adr/0005-retire-bespoke-widgets.md) |
| Ads routine prompts | [docs/routines/](docs/routines/) |
| Best Sudoku ad flight 3 (proposal handoff) | [docs/campaigns/flight-3-handoff.md](docs/campaigns/flight-3-handoff.md) |
| Geo beacon (companion) | [GoodStuffSoftware/gss-beacon](https://github.com/GoodStuffSoftware/gss-beacon) |
| Capacity / free-plan limits | [docs/capacity.md](docs/capacity.md) |
| Cloud (Claude Code on the web) sessions | [docs/cloud-sessions.md](docs/cloud-sessions.md) |

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

- `/api/metrics` caches per fact (90 s while live, 15 min for a closed campaign or yesterday read as a
  chosen day, 24 h for a closed flight window or an older chosen day), so one fact read serves every card and page that shows it; a representative
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
→ Actions) — a Cloudflare token with **Cloudflare Pages: Edit** — and a repo secret
**`CLOUDFLARE_ACCOUNT_ID`** (the account id, which every deploy job passes to wrangler). The
manual gss-geo workflows (`diagnose-geo.yml`, `migrate-campaign.yml`) also read
**`GSS_GEO_D1_ID`**. The runtime `CF_ANALYTICS_TOKEN`, `CF_ACCOUNT_ID` and the sign-in settings
([Auth](#auth)) are Pages *project* secrets and aren't needed by the workflow (deploys keep
existing secrets). See [Environment data](#environment-data).

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

**The live-push Worker (`gss-live`) deploys on merge too, and before Pages** — a third job
(`deploy-live`) that the Pages `deploy` job waits for (`needs`, with `if: !cancelled()`, so a red
`deploy-live` does not by itself stop the Pages deploy). Pages binds `gss-live` as the `LIVE`
service (`wrangler.toml`), so the Worker must exist first. It runs `npx vitest run workers/live`,
then `npx wrangler deploy -c workers/live/wrangler.toml`, when a push to `main` changes
`workers/live/**` (non-test files) or `deploy.yml`; **Run workflow** deploys it (unless paused), on `main` only.
`package-lock.json` is deliberately not a trigger, because every release changes it and each deploy
drops every open socket: after a wrangler bump, use **Run workflow** to redeploy `gss-live`. It uses the same token rule as `deploy-worker` (**Workers Scripts:
Edit**; `CLOUDFLARE_WORKERS_API_TOKEN`, falling back to `CLOUDFLARE_API_TOKEN`), and the repo
variable `LIVE_DEPLOY_PAUSED=true` skips it. `gss-live` has no secrets and no D1 access; its
Durable Object migration ships in its own config. Dry run, no auth needed: `npm run live:check`.
See [Live updates](#live-updates) for the first-merge order and recovery.

**Manual** (local fallback / preview), with the token from a local, gitignored file:

```powershell
$env:CLOUDFLARE_API_TOKEN = (Get-Content "<path>\cf-token.txt" -Raw).Trim()
npm run deploy      # = vite build && wrangler pages deploy
```

Single Cloudflare account — no account-ID env needed. Pages project: **gss-stats**.

### Preview (dev)

A hosted preview runs at **https://dev.gss-stats.pages.dev**: a Pages *preview* deployment
of branch `dev`, built from whatever is checked out. It is not deployed automatically.

```bash
npm run build && npx wrangler pages deploy dist --project-name gss-stats --branch dev
```

Any branch other than `main` deploys as a preview and uses `wrangler.toml`'s `[env.preview]`
(production keeps the top-level config). That section repeats every binding, points
`STATS_CONFIG` at the preview's own KV namespace (`gss-stats-config-preview`, seeded with a
copy of production's saved layout), and sets `PREVIEW_HOST`, the one extra hostname the host
guard serves ([ADR 0002, 2026-09-30 amendment](docs/adr/0002-google-auth.md#amendment-2026-09-30-one-hosted-preview-host)).
Only the `dev` alias is served; other preview URLs still 404.

- **Real data.** The preview binds the same D1 databases as production (geo and ads) and the
  real `gss-stats-sync` and `gss-live` Workers, so it shows live numbers and **an ads refresh on the preview
  runs a real Google Ads sync**. Only the saved layout is separate.
- **One-time owner setup**, before the first preview deploy (it is fail-closed, 503, until then):
  1. Add `https://dev.gss-stats.pages.dev/auth/google/callback` as an **Authorized redirect
     URI** on the Google OAuth client.
  2. Set the preview's **secrets** (Pages keeps them per environment, so production's don't
     carry over): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` (use a
     different value from production), `ALLOWED_EMAILS`, and `CF_ANALYTICS_TOKEN` (for the
     Cloudflare analytics charts); optional `SESSION_TTL_HOURS`. Values and rules are in
     [Auth → Settings](#settings-pages-project-secrets-production). Each one:
     `npx wrangler pages secret put <NAME> --project-name gss-stats --env preview`.
     Check with `npx wrangler pages secret list --project-name gss-stats --env preview`.
     Never set `AUTH_DEV_BYPASS`.

### Restoring a layout backup

The saved dashboard layout lives in KV (`STATS_CONFIG`, key `dashboard:default`). Each time a
release bumps the layout version (`CONFIG_VERSION` in `src/lib/defaults.ts`), the first save
of the migrated layout first copies the layout that was stored until then to
`dashboard:default:backup:v<stored version>`, once, and never overwrites that copy
(`functions/api/config.ts`; if the backup can't be written, the save fails and the old layout
stays). The backup is named after the version that was **stored**, not the one before the new
code: a layout still stored at v8 when v11 ships is backed up as `backup:v8`, one stored at v10
as `backup:v10`. Production is stored at v12 when layout version 13 (page navigation) ships, so
its first v13 save writes `backup:v12`. Layout version 14 (sparklines) is a save-guard bump
only: its first save over a stored v13 writes `backup:v13`, and rolling the code back past it
needs `backup:v13` restored (same steps below, with that key). Layout version 15 (the default
trend charts on `dateEt`) rewrites the dimension of those untouched charts: its first save over a
stored v14 writes `backup:v14`, and rolling the code back past it needs `backup:v14` restored.
Layout version 16 (chart captions and hideable caveats) adds `caption` and `hiddenCaveats` to a
chart and hides, once, the caveats an existing chart did not show: its first save over a stored
v15 writes `backup:v15`. Layout versions 17 (the readings log as a metric card), 18 (the
pop-up rate tile as a metric card) and 19 (the template-page marker, so a tab on older code cannot
drop it) are save-guard bumps only, like v14: the first save over any
older stored layout writes `backup:v<stored>`, and rolling the code back past either needs that
backup restored (same steps below, with that key).
Production is stored at v12 until its first save, so that save writes
`backup:v12` (the page navigation, trend-chart and caption changes of v13-v16 are all applied on
load and written by it), and rolling the code back past v19 needs that backup restored. A tab still
running older code gets `409` ("This tab is out of date, reload") instead of overwriting a
newer layout.

**Rolling the code back needs the layout rolled back too.** An older release refuses to save
over a newer stored layout (409), so after rolling back to the release before page navigation
(layout v12), for example, every save fails until `backup:v12` is restored.

To put a backup back, in this order:

1. **Close every dashboard tab**, on every device. An open tab saves its in-memory layout on the
   next change and would overwrite what you restore.
2. **Roll back or fix the code first.** If the deployed code still has the bad migration, the
   next load migrates the restored layout again. Either redeploy the previous release or ship
   the fixed migration.
3. **Find the backup to restore**: list the backup keys, and pick the version that was stored
   before the upgrade (the highest one below the current `CONFIG_VERSION`: `backup:v12` to undo
   the v13 page-navigation upgrade). Namespace id
   from `wrangler.toml`; a token with Workers KV Storage: Edit. The commands below are for
   Windows PowerShell 5.1; run them one at a time, from the repo root.

   ```powershell
   npx wrangler kv key list --remote --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --prefix "dashboard:default:backup:"
   ```

4. **Download it, keep a copy of what's there now, and check the file before writing it back**:
   it must be non-empty, valid JSON with a `pages` array. Run each block on its own and only
   continue when the previous one finished cleanly. (The `cmd /c` wrapper is deliberate: in
   PowerShell 5.1 a plain `>` writes the file as UTF-16, which is not what KV holds, and
   `| Set-Content` re-encodes the text.)

   Keep what's there now, in case you need to undo the restore:

   ```powershell
   cmd /c 'npx wrangler kv key get dashboard:default --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --remote > layout-current.json'
   ```

   Download the backup (change `v12` to the version you picked in step 3):

   ```powershell
   cmd /c 'npx wrangler kv key get dashboard:default:backup:v12 --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --remote > layout-backup.json'
   ```

   Check it. This must print `ok: version ..., N pages`; if it throws or prints nothing, stop
   and do **not** run the next block:

   ```powershell
   Get-Content layout-backup.json -Raw -Encoding UTF8 | ConvertFrom-Json | ForEach-Object { if ($_.pages -isnot [array] -or $_.pages.Count -eq 0) { throw 'not a layout' }; "ok: version $($_.version), $($_.pages.Count) pages" }
   ```

   Only after that printed `ok`, put it back. **This discards every layout edit made since the
   backup was taken** (widget and chart edits too, not only the navigation changes), because
   it replaces the whole stored layout:

   ```powershell
   npx wrangler kv key put "dashboard:default" --path layout-backup.json --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --remote
   ```

5. Open one tab and check the layout before opening any others.

### Restoring the layout

For when a save replaced the layout with the wrong one at the **same** layout version (say, a tab
that never loaded the real layout saved the defaults over it). The version backups above don't
cover that; these two copies do (`functions/api/config.ts`):

- `dashboard:default:prev` — the layout as it was before the most recent save that changed it.
  The next changing save replaces it, so it only helps if nothing was saved after the bad save.
  A save that failed after its copies were written (a `500`, say the layout write itself hitting the
  daily write cap) has already replaced it with the layout still stored: if `layout-restore.json` matches
  `layout-current.json`, use a `:day:` key instead.
- `dashboard:default:day:<YYYY-MM-DD>` — the layout as it was before the first changing save of
  that ET day. Kept 30 days. Use this when more saves followed the bad one: pick the day the bad
  save happened (or the day before) and it holds the layout as that day began.

Same order and cautions as above: **close every dashboard tab first** (the next changing save
replaces `:prev`), then run these one at a time from the repo root, in Windows PowerShell 5.1.

Read-only — list the copies, keep what's there now, and download the one you want (`:prev`, or a
`:day:` key from the list):

```powershell
npx wrangler kv key list --remote --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --prefix "dashboard:default:"
```

```powershell
cmd /c 'npx wrangler kv key get dashboard:default --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --remote > layout-current.json'
```

```powershell
cmd /c 'npx wrangler kv key get dashboard:default:prev --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --remote > layout-restore.json'
```

```powershell
cmd /c 'npx wrangler kv key get dashboard:default:day:2026-10-03 --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --remote > layout-restore.json'
```

Check it the same way (it must print `ok: version ..., N pages`; otherwise stop):

```powershell
Get-Content layout-restore.json -Raw -Encoding UTF8 | ConvertFrom-Json | ForEach-Object { if ($_.pages -isnot [array] -or $_.pages.Count -eq 0) { throw 'not a layout' }; "ok: version $($_.version), $($_.pages.Count) pages" }
```

Write — only after that printed `ok`. It replaces the whole stored layout, and writing with
wrangler makes no `:prev` copy, so keep `layout-current.json` in case you need to undo it:

```powershell
npx wrangler kv key put "dashboard:default" --path layout-restore.json --namespace-id f1fa625cdb844c109c4db4acc02d00f5 --remote
```

Then open one tab and check the layout before opening any others.

## Auth

The app does its own sign-in, the same way deckhand does: Google OAuth plus an email
allowlist. Design, alternatives and the deckhand comparison are in
[ADR 0002](docs/adr/0002-google-auth.md). Code: `functions/_middleware.ts` and
`functions/_lib/auth.ts`.

**What happens on a request.** `functions/_middleware.ts` runs on every request: pages,
static assets, `/api/*` and `/auth/*`.

1. A host guard 404s every host except `stats.goodstuff.software` and loopback. That
   includes `*.pages.dev` and preview-branch URLs; the one exception is the hosted
   preview's own host, on preview deployments only ([Deploy → Preview (dev)](#preview-dev)).
2. The auth gate then needs a valid session cookie belonging to the owner (an email on
   `ALLOWED_EMAILS`) or a viewer (see [View-only access](#view-only-access), which also
   covers the 403 on a viewer's writes):
   - With no valid session, `/api/*` returns **401 JSON**
     (`{"error":"unauthenticated","signIn":"/auth/google/login"}`).
   - A page load **redirects** to Google sign-in and comes back to the same page
     afterwards.
   - An account that signs in with Google but is neither the owner nor a viewer gets a
     **403 "Not allowed"** page and no session.
3. **It fails closed.** If any required setting below is missing, every request gets a
   **503 "sign-in not configured"** that names the missing variable, never a value.

Routes:

| Route | What it does |
|---|---|
| `GET /auth/google/login?next=/…` | Sends the browser to Google's account chooser |
| `GET /auth/google/callback` | Google sends the browser back here; this validates the login and sets the session |
| `POST /auth/logout` | Sign out: clears the session and shows the signed-out page (the header's **Sign out** button, or **Log out** in the compact account menu) |
| `GET /auth/me` | Returns the signed-in email and its `role` (`owner` or `viewer`) as JSON |
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

### View-only access

A **viewer** signs in with Google like the owner and sees every page and chart, but can't
change anything:

- **Can:** open every page, chart and drill-down, and use filters. Those
  stay in the browser tab and are never saved.
- **Can't:** add, edit, duplicate, move, resize or delete a chart; add, rename, move or delete a
  page or group; set or reset a default; refresh the ads data. Every edit control is shown
  greyed out with the tooltip "View-only access", and the server refuses every write a viewer
  sends with **403** `{"error":"view_only"}`. A viewer may only `GET`/`HEAD`, plus `POST` to the
  read-only query routes (`/api/stats`, `/api/geo`, `/api/metrics`, `/api/popups`,
  `/api/completions`, `/api/features`); everything else is refused.
- **The owner** (`ALLOWED_EMAILS`) is unchanged. An email on both lists is the owner.

The viewer list lives in the `STATS_CONFIG` KV namespace, never in the repo: one key per
viewer, `auth:viewer:<lower-case email>`, with the value `viewer`. Nothing is sent to the
viewer; tell them yourself. The commands below read the binding from `wrangler.toml`:

```bash
# add
npx wrangler kv key put "auth:viewer:viewer@example.com" viewer --binding STATS_CONFIG --remote
# remove (takes effect within about 60 s, the KV edge cache)
npx wrangler kv key delete "auth:viewer:viewer@example.com" --binding STATS_CONFIG --remote
# list
npx wrangler kv key list --binding STATS_CONFIG --remote --prefix "auth:viewer:"
```

The same Gmail-or-Workspace rule as `ALLOWED_EMAILS` applies. If the Google OAuth app is still
in **Testing**, add the viewer under Google Auth Platform → Audience → Test users too, or Google
won't let them sign in.

### Settings (Pages project secrets, Production)

| Name | Required | Value |
|---|---|---|
| `CF_ACCOUNT_ID` | yes | The Cloudflare account id (32 hex) that `/api/stats` and `/api/sites` query RUM for, alongside `CF_ANALYTICS_TOKEN`. Without it `/api/stats` answers 500 `CF_ACCOUNT_ID not configured` and the site list falls back to beacon hosts only |
| `GOOGLE_CLIENT_ID` | yes | The OAuth client ID (`….apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | yes | That client's secret |
| `SESSION_SECRET` | yes | At least 32 random characters. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `ALLOWED_EMAILS` | yes | Comma-separated, case-insensitive, exact addresses, no wildcards. Same format as deckhand's `DECKHAND_ADMIN_EMAILS`. Example: `you@gmail.com`. **Only `gmail.com` or Google Workspace addresses.** A Google account registered with any other email (e.g. an ISP or work address that isn't Workspace) can show that email as "verified", but Google doesn't vouch for it later: whoever controls that mailbox afterwards can create a Google account with the same email and sign in |
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
     **Testing**, every address in `ALLOWED_EMAILS` must be listed under **Test users**.
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
  Cloudflare Pages secrets (production), never in the repo (see [Environment data](#environment-data)). Follow-up: mint a
  least-privilege token with only "Account Analytics Read" and set it as the
  `CF_ANALYTICS_TOKEN` secret.

## Environment data

**The repo is public, so it holds no env data.** Every secret (tokens, keys, client secrets,
session secrets), every piece of personal or ops data (email addresses, IP addresses, names) and
the Cloudflare account id come from one of these at run time, never from a committed file:

| Where it runs | Source | Set with |
|---|---|---|
| Pages Functions (production) | Pages project secrets: `CF_ANALYTICS_TOKEN`, `CF_ACCOUNT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_EMAILS` | `npx wrangler pages secret put <NAME> --project-name gss-stats`, value on stdin |
| Pages Functions (viewer list) | KV `STATS_CONFIG` keys `auth:viewer:<email>` ([View-only access](#view-only-access)) | `npx wrangler kv key put … --binding STATS_CONFIG --remote` |
| `gss-stats-sync` Worker | Cloudflare Secrets Store (the four Google Ads credentials) | `npm run ads:worker-secrets` (from Bitwarden) |
| GitHub Actions | Repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_WORKERS_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GSS_GEO_D1_ID` | `gh secret set <NAME>`, value on stdin |
| Local scripts (`scripts/`) | Bitwarden Secrets Manager (`bws`, token from `BWS_ACCESS_TOKEN`, else the file `~/.bws-token`) or env vars; the account id is `CLOUDFLARE_ACCOUNT_ID`, else bws prod `infra--cloud-routine-env--CLOUDFLARE_ACCOUNT_ID` | `bws secret create` |
| Local `wrangler pages dev` | The gitignored `.dev.vars` ([`.dev.vars.example`](.dev.vars.example) lists the names) | by hand |

What stays committed, on purpose: the binding ids `wrangler.toml` and `workers/sync/wrangler.toml`
need (the KV namespace, the two D1 databases, the Secrets Store), the Web Analytics site tags
(public in every page's beacon snippet), and the Google Ads customer id and GCP project ids the
Ads guards pin. None of them grants access on its own. Tests and examples use made-up values
(`example.com`, `0123…` ids).

**Guard.** `.github/workflows/secret-scan.yml` runs [gitleaks](https://github.com/gitleaks/gitleaks)
(pinned, checksum-verified) on every push and pull request, with the rules in
[`.gitleaks.toml`](.gitleaks.toml) (the defaults plus personal email addresses, public IP
addresses, account ids and Google OAuth client ids). A finding fails the run. To run it before
you push, with a local gitleaks binary: `gitleaks git --config .gitleaks.toml --redact .`
Old commits were rewritten on 2026-10-13 to drop personal and account data; a clone made before
the rewrite still holds them, so replace it with a fresh clone. The two false positives left in old
commits are listed by fingerprint (never by value) in [`.gitleaksignore`](.gitleaksignore).

## Branch

`main` — the deployed line.
