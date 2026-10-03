# Changelog

All notable changes to **gss-stats** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **The metric-card editor no longer loses a template's settings.** Re-picking a row's current
  metric or note, switching the badge, a title or a repeat off and back on, or changing a repeat
  and back now leaves a customized card exactly as the preset had it; picking a different metric
  keeps the window and filters it still supports, the window picker says "Default" rather than
  showing a window the row doesn't store, and editing another chart while the editor is open
  shows that chart instead of the previous one.
- **The header stays on one row on a tablet or foldable.** Between 701px and 1000px wide the
  search box shrinks to its icon and the account becomes an icon menu with your e-mail and Log out,
  so the bar no longer wraps onto a second row.
- **Undoing a change while it saves still saves the undo.** Reverting an edit before its save
  finished used to leave the stored dashboard on the edit while the screen showed the original.
- **The dashboard loads with browser storage blocked.** A private window or disabled site data no
  longer stops it loading; the dark-mode choice just isn't remembered.
- **The top-right corner of the header takes clicks again.** The hidden "show filters" button's
  box no longer sits invisibly over the account menu (and, on a phone, the page menu button).
- **Sync all pages shows its real state.** The "Sync all pages" checkbox in the filter bar no
  longer always shows as on — it now genuinely reflects whether page date ranges are synced.
- **Best Sudoku · Overview content sits right under the filter bar again.** The small-sample
  note took a three-row grid cell for one line of text, leaving an empty band between the bar and
  the first card; it now takes one row and the cards below move up (layout version 12, saved
  layouts migrate once and a note you resized keeps its size). The "show filters" button also
  closes the pinned bar again: the open bar no longer covers it.
- **The funnel-reach kill rule no longer trips while sign-in prompts still fire site-wide.**
  Zero tagged asks now reads as WATCH when sign-in prompts were shown site-wide in the same
  window (the campaign tag only rides beacons for 30 minutes, so later-session streak prompts
  go untagged); it still trips when both are zero, and the rule always states the site-wide
  shown count.
- **The funnel-reach WATCH can no longer hide a broken campaign.** Zero tagged arrivals always
  trips; the WATCH downgrade applies only until the tutorial sign-in ask is seen site-wide, after
  which the rule reads tagged asks only; the detail line states which mode applied, the
  site-wide cross-check counts the same asks the rule does (first-50 promo included), and the
  threshold push names a rule on WATCH instead of saying no rule tripped.
- **First-session funnel figures are more faithful.** Arrivals count one per device (first
  tagged visit) instead of new-visitor page rows; a step whose sibling beacons are live reads
  a real 0 instead of "not yet tracked"; the site-wide column now stops at the same end as the
  tagged one; and no ratio divides by game views, which are page views.
- **Agent worktrees no longer leak into the test run.** The test suite skips copies of the
  repository under the agent worktree folder.
- **Two standing retest report notes corrected.** The upsell-near-zero-for-signed-out note
  wrongly called it a known bug (`useUpsellPrompt` returning early on `uid === null`); it is
  expected by design (a signed-out visitor is never walled — the trial starts only once a
  signed-in player plays a game), and the planned "fix" was cancelled. The sign-up note now
  names both segments — bounded before the new/existing sign-in split went live (v1.95.5,
  2026-09-26 19:43:02Z) and exact from `/auth/success/<provider>/new` after it — and the printed
  sign-up line (`at most N campaign sign-ups (at most B + exactly E)`) shows both parts instead
  of collapsing a mixed window to one bound.

### Added
- **A hosted preview at dev.gss-stats.pages.dev.** Preview deployments of branch `dev` are now
  served (still behind Google sign-in) with their own saved-layout store, seeded from
  production's, while reading the same live data; production's hosts, settings and saved layout
  are unchanged.
- **The metric-card editor shows and edits every template setting.** Badge colours, the card's
  Google Ads refresh button, a note label's variables, the message shown when a repeat has nothing
  to show, before/after window and country picks, table column and row-label headings, "leave out
  a measured 0" and the column frame now have controls, and a preset card opens with its settings
  visible (read-only) until you choose Customize.
- **Pages belong to groups.** Every page is filed under a group — "All sites", "Best Sudoku", or
  "Mine" for your own pages unless their name starts with a group's name — and the Best Sudoku
  pages drop their "Best Sudoku · " prefix (Overview, Campaigns, Pop-ups, Traffic). Drill pages
  made before this can't be traced to the page they came from, so they stay ordinary pages under
  Mine.
- **Every page has an icon.** It comes from what the page's charts show (traffic, map, pop-ups,
  campaigns, completions, ads, overview) unless someone picks one; a drill page shows the icon of
  its top-level page with a small drill mark, and Traffic gets its own traffic-line icon.
- **A breadcrumb in the header switches pages.** Group / page / drill page / …, the whole path,
  each opening a list: every group (and ★ Overview), the pages in the group with their drill pages
  nested under them (and a new page there), or a drill page's siblings, its own drill pages and the
  way back. Picking a group opens the page you last viewed in it. Each group has a lettered,
  coloured badge. When the path is too long its middle folds into "…"; on a phone it always does,
  and the lists open from the bottom of the screen.
- **Every page is in a drawer behind ☰.** It opens over the charts on any screen: ★ Overview,
  then each group (collapsible) with its pages indented under it and each level of drill pages one
  step further in (foldable), a ⋯ menu on every page and every group, × on drill pages, and
  "+ New". The ☰ button shows the current group's badge.
- **Every page has a menu.** Rename, duplicate, change icon, move to another group (or a new one
  named right there), restore default charts, delete. Drill pages have the same menu; moving one
  makes it a page of its own. ★ Overview can't be moved or deleted.
- **Create pages and groups from the drawer.** "+ New" asks what to make and walks through a few
  steps: a page's name, group and starting charts (blank, a copy, or a built-in page's defaults)
  and icon; a group's name and which pages to move into it. A group can stay empty.
- **Rename anything where it is.** Page and group names turn into a text field in the drawer or
  the breadcrumb (from a menu, or by double-clicking a breadcrumb segment) — no pop-up prompts —
  and the new name shows everywhere at once, the browser tab's title included.
- **Groups can be renamed and deleted.** Renaming onto another group's name is refused rather than
  merged; deleting a group says how many pages it holds and moves them to the group you pick
  (Mine by default). ★ Overview never moves.
- **Pick a page's icon.** Search about forty icons in five groups, or choose Auto, which shows
  what the page would get on its own.
- **Press / to search every page.** Page names match first, then charts' titles, each result with
  its icon and group; arrow keys move, Enter opens, Esc closes.
- **Drill pages nest under the page they came from.** A drill opens its page straight away, in the
  same group, named by what it adds (for example "California" under "mobile"); a drill from a
  drill page nests under that drill page, up to eight levels deep. Deleting a page deletes every
  drill page under it, asked once; when the page you're on goes, you land on its parent, else the
  page before it in its group, else the group's first page, else ★ Overview.
- **Search campaigns read alongside Display ones.** A campaign can now be registered as a
  Search arm: its placement rules and lines read "n/a (search campaign)" instead of tripping on
  missing placements, while spend, clicks and every other rule read as before, and each of two
  arms running at once is read on its own `--campaign` (given twice, it is refused). A search
  arm's $100 decision is worded for search and compared against its sibling arm (if any), its
  morning read flags the closed day's spend on mobile, tablet or TV (the arm is desktop-only),
  and the readings widget counts rules on watch and draws them in the amber tone, apart from
  all-clear.
- **The retest read shows whether the first-50 offer is actually visible.** The Accounts line
  now reports the first-50 counter and the offer signed-out visitors really see side by side,
  flags when they disagree, and $50-and-later and post-flight reads note that the promo arm was
  absent until 16:11:29 ET on 09-28. Report text only: no kill rule, threshold or push changes.
- **New event-beacon family: deferred completions from EU visitors (best-sudoku card 125).**
  `/game/complete-deferred/<mode>/<difficulty>` — a game that finished while the EU consent
  modal was still unanswered, sent later at consent time — is excluded from page views and
  route counts everywhere the live completion family is, and is never counted as a live
  completion or a campaign funnel step (it is a sibling of `/game/complete/`, not a sub-path of
  it). A new "Deferred completions (EU consent)" tile on the Best Sudoku dashboard, next to
  Games completed, reads an explicit 0 while no rows exist; its caption explains it counts at
  consent time, not completion time, and is EU-only.
- **First-session funnel in the retest morning read and its report page.** Tagged arrivals,
  game views, tutorial tour start/complete/skip, first move and game completions, abandoned
  games by % filled, sign-in asks shown and the signed-in welcome card, each with its site-wide
  count alongside; steps the app does not send yet read "not yet tracked" rather than 0%.
  Informational only, never a kill rule.
- **The tutorial sign-in ask counts as a sign-in ask.** `/signin-prompt/tutorial` joins the
  campaign ask count and the site-wide shown count, and the new tour, first-move, abandon and
  welcome-card beacons are treated as events, never page views.
- **The retest morning read now publishes a rendered report page every run.** A build step turns
  the read's saved output and the daily narrative into one self-contained page (narrative, spend
  against the thresholds, release health, funnel, diagnostics, Play bulk reports, and the
  verbatim report and JSON), published to one fixed link; any sub-read that is missing or failed
  shows as a short "not read on this run" line instead of breaking the page. The routine's chat
  output shrinks to the narrative, the page link and a few status lines.
- **The retest ads routine's morning read now includes Play Console bulk reports (R4), read-only
  and informational only.** Installs by day, acquisition by source, and store listing
  visitors/acquisitions by country (all covering the campaign's own flight window), plus the
  $50/$75 cumulative-spend Play-install checkpoints as informational lines (never a kill rule).
  Reads Google Play's "bulk reports" CSVs directly from the developer account's private Cloud
  Storage bucket via the GCS JSON API (the only programmatic path, since Play has no REST API for
  install/acquisition statistics): no scraping, no browser, GET only. The bucket name
  (`pubsite_prod_6577064245925542510`) was settled by a live authenticated probe, not by memory
  or an old script's guess, which turned out to be wrong (404). The existing
  `play-publisher@best-sudoku-prod.iam.gserviceaccount.com` credential already has the needed
  permission: no new secret plumbing. Day-1/day-7 retention is explicitly reported as NOT
  available from bulk reports (confirmed by listing the bucket: only two report families exist,
  installs and store_performance). Every figure names the date it covers (bulk reports lag a day
  or more) and states that Play device/install counts include the developer's own household
  devices. Wired via a new optional `ReadDeps.playReports` source (`--play-sa <path>`, mirroring
  `--firebase-sa`), so every existing fixture and test keeps compiling untouched.
- **The retest ads routine's morning read regains full diagnostic depth for the closed day,
  informational only.** Hourly delivery (account time zone), geo (country/region plus a live
  location bid-modifier check), device split (computers/Connected TV flagged if nonzero for a
  mobile-app placement campaign), and ad-group targeting (optimized-targeting-off and placement
  count vs. the build spec) restore the old routine's Ads API read depth via read-only GAQL.
  Google Ads Recommendations and enabled auto-apply subscriptions are listed read-only alongside
  the carried standing verdicts (Maximize Conversions, conversion tracking, Customer Match,
  optimized targeting: all REJECT). A beacon country breakdown (aggregate counts only) runs
  alongside the existing funnel reads. A same-day cross-check compares Firestore's new-account
  count against the beacon's `/auth/success/*/new` count for the closed ET day, counts only,
  never joined to an individual. Every sub-read is independently best-effort: one failing is
  recorded and reported, never thrown, and never blocks the others or the spend/kill-rule read —
  none of this feeds a kill rule or an automatic action; it is report lines only.
- **Sign-ins now split by new vs. existing vs. unknown right next to the existing sign-in
  count** on "Today at a glance", with the split's own go-live called out so an early range
  reads as "counted from" a specific time rather than a false zero. Counts only.
- **Pop-up outcomes (signed in, returned, still playing) now show alongside the existing
  install rate** on the Pop-ups page, as counts.

### Changed
- **The dashboard uses the full width of the window.** The header, the filter bar and the charts
  span the screen instead of a centred column, so wide screens show more; the pinned filter bar
  spans it too.
- **Deleting a page also deletes its drill pages.** You're asked once, with the count ("Delete
  Traffic and its 3 drill pages?").
- **The page you're on is yours alone.** It's remembered in your own browser instead of the shared
  dashboard, so switching pages no longer saves anything or moves anyone else, and a first-time
  visitor lands on ★ Overview.
- **Built-in pages are recognised by what they are, not their name.** Renaming a page no longer
  changes how it behaves (its notes, its filter bar, what "restore default charts" brings back).
- **Saved layouts move to version 13.** The first save keeps a backup of the previous layout
  (version 12), and a tab still running the previous version is told to reload instead of
  overwriting the new one.
- **The retest ads routine's release-health check now runs every morning read, at any hour.**
  The 23:15 ET backstop entry is folded into the single daily morning read (moved 08:00 → 06:00
  ET); the clock-based "01:00-12:00 ET quiet window" that used to suppress the check is retired,
  since it would otherwise silently suppress release health forever at whatever hour the one
  remaining run is scheduled. Parent/child maturity is unaffected: it was already enforced by an
  independent 24h event-age cutoff, not the clock.
- **Sign-in failures and redirect fallbacks now show on the Best Sudoku dashboard**, next to
  the existing auth-success numbers on "Today at a glance". Both read a real zero (not a blank
  or a hidden tile) once tracking is live, so "no failures yet" reads differently from "not
  wired up".

### Removed
- **The page tab strip.** The breadcrumb, the page drawer and / search replace it; "+ Page" is
  "New page" in the drawer and in the breadcrumb's page list.

### Fixed
- **Chart queries with many sites and pop-up filters no longer refuse to run.** The dashboard's
  documented maximums (50 sites, 16 path filters) work together again without hitting the
  underlying database's per-query parameter ceiling.

## [0.12.1] — 2026-09-27

### Fixed
- **A campaign with no confirmed start date now shows on the hour-of-day and flight-day charts.**
  It draws at zero, keeping its place in the legend, the same as it already did on the funnel and
  country cards — a campaign no longer disappears from two of the four campaign views just because
  its flight hasn't been scheduled yet.

### Changed
- **A newly added flight-day chart's date range stops growing once every campaign flight is
  over.** It still starts from the first campaign, same as the hour-of-day chart, but once every
  flight has run its course the range settles on a fixed end date instead of always reaching to
  "now" — so its cached data stays valid for longer once nothing is still active. An existing
  flight-day chart keeps its current range until you type "since first campaign until last
  campaign ends" into its own date range field.

## [0.12.0] — 2026-09-27

### Changed
- **The release panel is a metric card.** It shows the same four counts, with Before and After
  as the columns of one table, names the release and how many days each side covers, and keeps
  its "partially instrumented" note. Installs in the Before window read "not yet tracking"
  instead of a 0 nobody could have measured, and on the release day itself the card says there
  is no window yet instead of "No dated release yet".
- **The Pop-ups rate table and sign-in eligibility are metric cards.** The rate table lists the
  same valid rates with their counts ("36.4% (4/11)"), with the install-fix caveat in its Notes;
  the eligibility panel shows earned, capped and unearned as bars and adds the eligibility rate
  under them. Both still follow the page's range, sites and "hide my own visits".
- **The campaign cost panel is a metric card.** Each campaign keeps its spend, where the spend
  came from, how far it is stored and when it last synced ("stale — sync pending" when a day is
  missing), and its cost per arrival and per auth success; "Refresh data" is still above the
  cards. A cost over fewer than 5 arrivals or sign-ins now says "too few to report", and the
  spend-only Play-direct card no longer shows two costs it can never have.
- **The funnel per campaign is a metric card.** Each beacon-tracked campaign keeps its tagged
  hits against its arrivals, its raw install signals, every funnel step as a bar, and the two
  valid rates (accept of asks, install of prompts shown after the fix). The install-fix caveat
  moved into the card's Notes, and the bars use the cards' standard colour. The upsell-fix
  segment table (pre-fix and post-fix tagged upsell) now lives on this card and appears by
  itself once that fix ships.
- **Arrivals & funnel by country is a metric card**, with the same table as before: the funnel
  steps down the side, US, CA and Other across the top, the same counts in every cell.
- **An upcoming campaign has its funnel and country cards.** Before its flight starts (or while
  it has no start date yet) the funnel card shows Arrivals 0 and every other step "not started",
  and the country card lists every step as "not started", as the old panels did.
- **Return visits is a metric card.** Each campaign with return beacons shows its first tagged
  loads (d0) and the return rate of every later window as bars side by side, d1 to d31-60, each
  with its counts, where the line chart and its counts line were. Under 5 first loads, each bar
  says "too few to report" with its counts.
- **Arrivals by ET hour of day and daily arrivals by flight day are standard charts.** The hour
  chart is a breakdown bar (one bar per campaign in every hour, 0:00 to 23:00), and the flight-day
  chart is one line chart: each campaign's daily arrivals, and its running total dashed on a
  right-hand axis, where there used to be two charts side by side. Both count the same tagged
  arrivals, and both can be edited like any other chart. They read every arrival since the first
  campaign began (not a rolling year), and every tracked campaign keeps its series, at 0 when it
  has no arrivals yet.

### Removed
- **The old bespoke panels and their data endpoints.** Every Overview, Campaigns and Pop-ups
  panel is a metric card or a standard chart now, so the old panel code and the two endpoints
  only it used are gone; a saved layout's panels are swapped in place the first time it loads.
  The chart editor no longer offers the old rate-table chart type or the pop-up "sign-in
  eligibility" dimension (both are cards: "Pop-up rates" and "Sign-in eligibility").
- **Reload any dashboard tab that was open during this update.** A tab loaded before it still
  asks for the retired panels' data, so those panels show an error until the page is reloaded
  (the old rate table and sign-in eligibility name the card that replaced them) instead of
  quietly showing "No data".

### Added
- **A "Since first campaign" date range.** Type it in any range field, or pick the chip in a
  chart's own filter: from the first ad campaign's start to now, growing each day.
- **Two new beacon dimensions, "Hour of day (ET)" and "Campaign flight day"**, and line charts
  can now draw one line per value of a second dimension, with an optional running-total line for
  each.

### Fixed
- **The card builder names every preset row.** Customizing a preset no longer shows "Unknown
  note" for rows labelled with a step or title name (most of the funnel's), and their label
  pickers show the current name instead of coming up blank.
- **A card's Notes name each row once.** A table row repeated in several columns (a count under
  US, CA and Other, or under Before and After) is listed once in front of its note.
- **A campaign card keeps its chosen campaigns.** A card with one box per campaign (funnel,
  country, cost, returns, the scorecard) shows only the campaigns picked in its chart settings,
  as the old panels did, and the editor offers that picker for it.
- **A chart's own date range survives a reload.** A span picked in a chart's filter (a chip or a
  typed "2w") stays that rolling span after the page reloads, and a calendar range stays fixed,
  instead of reverting to the span the chart was saved with.

## [0.11.0] — 2026-09-27

### Added
- **Metric cards are now editable.** "Add chart" offers a metric card alongside the usual chart
  types, and editing an existing one — including "Today at a glance" and the campaign scorecard —
  opens a builder instead of the chart fields: start from a preset or a blank card, pick each
  row's label, its number, and how it displays, arrange sections, and see it update live before
  saving. A save that would produce an invalid card (an impossible percentage, a broken pick) is
  refused inline instead of being allowed onto the page.

### Fixed
- **The card builder opens at the top on a phone, not mid-scroll.** Its fields — title, then the
  card itself, then the live preview — are reachable from the top of the sheet, the way they're
  meant to be, instead of the sheet opening centered on whatever content happened to land in the
  middle.
- **A live 'bars' card's scale, and a section's show/hide, now follow an edit.** Editing a bars
  card's rows, or adding/removing a section's rows, used to leave the bar widths reading an old
  scale and could leave a section shown or hidden based on data from before the edit.
- **The card builder no longer leaves a gap between the fields and the preview on a phone**, and
  the "Start from" list shows each preset's plain name and a one-line description, never its raw
  id.
- **"Reset to preset" on a saved, customized card no longer risks swapping in the wrong preset.**
  It now always names — and asks to confirm before replacing your edits with — the actual preset
  the card was customized from, and the button no longer appears at all for a card where that
  isn't known.
- **The chart editor behaves like a proper dialog.** Opening it moves keyboard focus to the Title
  field, Tab stays inside it instead of leaking onto the page behind it, Escape closes it, and
  focus returns to whatever you clicked to open it. Saving a metric card is disabled, with a
  reason shown, until its errors are fixed. Every field in a card's item list now shows plain
  names — never a raw metric or ratio id.

## [0.10.0] — 2026-09-27

### Added
- **One batched metrics request.** A single request returns many dashboard numbers with their
  counts and measurement status, reads each underlying query once and caches it, and refuses any
  percentage whose two counts are not comparable. The Overview's cards use it.

### Changed
- **"Today at a glance" and the campaign scorecard are metric cards.** They show the same
  numbers, except where the rate audit changed them: game-screen views read against arrivals
  instead of alone, the install rate counts prompts from the install fix to the minute, and a
  closed or spend-only campaign drops what its flight could not measure. Each card keeps its
  caveats behind one "Notes" link, refreshes when the filter bar changes (the two cards always
  show today and the Best Sudoku sites), and says so with Retry when a number fails to load.
  Saved layouts are updated automatically, and the previous layout is backed up first. A tab
  left open on the previous version shows empty KPI and scorecard panels until it is reloaded.
- **"Games played" and "Played a game" are now "Game-screen views".** Both count visits to the
  game screen (page views, several per device), not games played; the Overview tile, the
  campaign funnel step and the ads-read report now say so.

### Fixed
- **The Overview "Tagged arrivals" tile now counts a campaign exactly like its scorecard card.**
  It uses the campaign's own attribution window, including a mid-day start, so the US+CA
  retest's pre-launch test rows (before 12:00 ET on its first day, and on 2026-09-23) no longer
  count on the tile or in its 7-day average. Its "vs yesterday" and "vs 7d avg" comparisons stay
  hidden until the flight has full days to compare against.

## [0.9.0] — 2026-09-27

### Added
- **A chart's own site pick.** "Site override" in the chart editor now really narrows that one
  chart to a site (e.g. Best Sudoku), leaving the page's site pick and dates alone; the Overall
  timeline uses it, wherever it sits.
- **A US-Eastern date axis for beacon trend charts.** "Date (trend, ET)" buckets by Eastern day,
  daylight saving included; the Overall timeline uses it, so its days line up with its flight
  bands and go-live markers.
- **Arrival and key-event dimensions for beacon charts,** and a per-chart option to hide known
  test and household traffic.
- **A breakdown bar chart for any two dimensions.** Put one dimension on the axis and another
  as the series, grouped side by side or stacked, from the normal chart editor; movable,
  zoomable and editable like every other chart.
- **Pop-up, completed-game and campaign-flight dimensions for beacon charts.** Chart or filter
  by which pop-up, what happened to it (shown, tapped, dismissed, or an outcome), a completed
  game's mode and difficulty, and which campaign flight a visit belongs to. Pop-up counts
  start the day tracking went live and skip installs from before the install fix.

### Changed
- **The Best Sudoku Pop-ups page is now one bar chart.** Every pop-up sits on the axis with
  shown, taps, dismissals and each outcome as the series. A small table below lists only the
  rates that are valid (taps over showings, and installs over install prompts since the
  install fix), each with its counts and "too few to report" under five. Sign-in eligibility
  stays; the other tiles are gone. Saved layouts are updated automatically; charts you added
  to the page are kept.
- **The campaign device mix uses the standard nested pie.** Campaign flight, then device, then
  operating system, on the same chart the other pages use for site and device, labelled as a
  share of tagged hits. Saved layouts keep its place, size, title and captions, and a chart
  scoped to one campaign keeps that scope. What changed: the browser and screen-width shares
  are gone (add them as extra rings from the chart editor), and an operating system's
  percentage is now its share within its device, not within the whole campaign.
- **The Overall timeline is a standard line chart.** Same look (page views and tagged arrivals
  on the left, sign-ins, installs and raw install signals on the right, campaign-flight bands,
  release and go-live markers), now edited in the normal chart editor. Hovering or tapping a
  marker or band shows its date and note, and a collapsed list under the chart has them all.
  Saved layouts keep its place, size and title.
- **Every line chart can show release markers, go-live markers and campaign-flight bands,** and
  a beacon line chart can draw several series on a left and right axis.
- **Overview tile labels are short and plain.** "Return visits (day 1+)" and "Installs", with the
  install-fix caveat under the label instead of in it.
- **A saved dashboard is backed up before a layout upgrade.** The first save after an upgrade
  keeps a copy of the previous layout, so an upgrade can be undone.

### Fixed
- **Chart captions stay inside their card on phones.** They used to sit flush against the
  card's edge and get clipped at narrow widths.
- **A chart with its own filter no longer fails to draw** when that filter was set up from the
  current site picker rather than the old single-site one.
- **Captions and notes read as plain language.** None of them names a source file any more.
- **Each note shows once per card.** The Campaigns cards no longer repeat a caveat at the top
  and again under the chart.
- **The Return visits chart fits its card.** Its plot used to stretch far below the card, so
  only the top of the axis showed.
- **The sign-in eligibility chart has a short title** that fits its card.
- **Timeline marker labels no longer collide,** on desktop or phone.
- **Chart editor checkboxes sit right next to their labels,** and clicking the label toggles them.
- **The timeline's tagged-arrivals line matches the campaign funnel.** It now counts a first
  visit even when that first beacon was a pop-up or install event.
- **A long trend chart keeps its most recent days** when the range has more days than the
  chart's limit, instead of the oldest ones.
- **Raw install signals skip installs from before the install fix,** like every other install
  count.
- **Pop-up charts read unusual beacon paths the same way the rest of the dashboard does**
  (a trailing or doubled slash, an extra segment).
- **An oversized chart request gets a clear error** instead of a database message: too many
  sites or filters, or a combination too large for one query, says what to cut back.
- **"Hide my visits" applies to the pop-up rate table and eligibility counts too,** so they
  agree with the pop-up bar chart.
- **A tab left open on older code can't overwrite a newer layout.** Its save is refused, so the
  layout is protected either way. A tab that loaded this version says "This tab is out of date,
  reload"; a tab still open on v0.8.x just shows "Save failed" (reload it).
- **The notes picker in the chart editor shows plain text,** without markup or placeholders.

## [0.8.1] — 2026-09-27

### Changed
- **The main filter bar is back**, always visible in normal flow under the page tabs, exactly
  as it was before it was hidden behind a top-right toggle. If it scrolls out of view, a small
  "show filters" button appears — always reachable from the keyboard — and pins the same bar at
  the top of the viewport until dismissed or scrolled back into view. Per-chart reveal + zoom
  (added earlier) remains the way to show a chart's own controls.

## [0.8.0] — 2026-09-26

### Added
- **Every stored geo-beacon field can now split or filter any beacon chart.** New dimensions:
  screen width (exact pixels, and a bucketed `<480`/`480-767`/`768-1023`/`1024-1439`/`1440+`
  view), and a "path family" dimension that groups pop-up/install/return/game-complete/
  auth-status event beacons apart from ordinary page views — all filterable, not just
  groupable. A new per-chart "Include event beacons" option (off by default, so every
  existing chart's numbers are unchanged) lets a chart include those event paths instead of
  excluding them. Drilling into an event family carries that option to the filtered page's
  other charts too, with a caption explaining why.
- **A raw-install de-dupe marker on the Overview timeline.** Marks when duplicate cross-tab
  `/install/*` rows stopped being sent — shown only on the raw install-signal line, never the
  primary (already deduplicated) install count.
- **A completions chart (mode × difficulty).** Shows distinct completed games broken down by
  normal/daily and difficulty, live from the game-complete beacon's go-live. Added to the
  Best Sudoku Overview page automatically for anyone who hasn't customised it; a configurable,
  movable chart like any other, buildable on any page from the chart menu.

### Changed
- **Two D1-heavy per-campaign checks are now cached at the edge**, cutting repeated database
  reads on every dashboard load: the campaigns/overview "which funnel steps has this flight
  actually seen" check (shared by both pages, keyed by campaign + flight window, long-lived
  once a flight is closed), and the new completions chart's own query.
- **Closed campaigns' scorecard no longer shows "not instrumented" chips.** A funnel step a
  closed flight's window never actually had a beacon for is left off the chip list entirely,
  instead of showing a misleading "not instrumented" label — derived from the same per-flight
  check the campaigns page already used, not a hand-written list.
- **Closed campaigns omit uninstrumented funnel/country steps instead of labeling them.** Same
  rule as the scorecard, applied to the campaigns page's own funnel and country-breakdown
  views.
- **Spend-only closed campaigns (e.g. Play-direct) no longer appear in beacon-based campaign
  charts.** Funnel, hour-of-day, country, flight-day, device-mix and return-visit charts never
  had real data for a campaign whose ads bypass the beacon entirely; it now shows only in the
  spend and cost views, where its numbers are real.

### Fixed
- **Removed funnel/scorecard percentages that mixed incompatible units.** "Played a game",
  "Completed a game", "Sign-in ask", "Auth success" and "Install prompt" showed a nonsense
  percentage (e.g. "314.7%") because their numerator counted event rows while their
  denominator counted arrivals or other rows, with no shared visitor id to make it a real
  rate. They now show a plain count. Accept/ask, install/install-prompt (denominator
  restricted to prompts shown after the install-outcome-gap fix), and return-visit rates are
  unaffected — those are real ratios.
- **Fixed the campaigns "Return visits" chart rendering broken/empty.** A campaign with zero
  `/return/` rows so far — not yet instrumented for its flight, or simply no rows yet — used to
  fall through to an empty, axis-only chart instead of being recognized as having no data. It's
  now omitted from the grid, and the whole chart shows one line ("No return visits recorded
  yet") when nothing has data at all.
- **The overview scorecard's "Completed a game" chip now shows a campaign's real count once
  it's live.** It used to always show "not instrumented", even for a campaign whose flight is
  well after the completed-game beacon went live, because it checked a permanent constant
  instead of that campaign's actual data. Closed campaigns whose flight predates the beacon
  still omit the chip.
- **The ads-read reports no longer show an "ask rate" percentage.** Like the funnel/scorecard
  fix above, it divided an event count by an arrivals count with no shared visitor id — not a
  real rate. Reports now show it as a count pair ("N asks · M arrivals"); accept rate is
  unaffected.
- **Widgets look like the old bespoke pages again, with customization tucked away.** Every
  chart's title bar is gone — just a plain heading, with two small icons in the corner: zoom
  (one tap) and reveal, which shows that chart's own filter/reload/menu controls until you tap
  it again, press Escape, or tap elsewhere. Desktop hover still reveals a chart's controls too,
  and the page's own edit-mode toggle reveals every chart at once. Double-tapping a chart also
  zooms it. A note widget shows only the reveal icon, since it has nothing to zoom.
- **Notes render as a plain caption line**, not a boxed card with its own title bar.
- **"Today at a glance" and other content-heavy widgets size to their content** instead of
  clipping their top row or scrolling inside a fixed box.
- **KPI comparisons show sensible precision** (whole numbers, not raw decimals), wrap their
  label instead of truncating it, and a metric with no valid comparison yet (just gone live)
  says "new today" instead of a nonsense percentage.
- **Overlapping release-marker labels on the Overall timeline** now stagger onto separate rows,
  or drop the label (keeping the tick) rather than run into each other — and are visible in dark
  theme, where they used to be unreadably dark-on-dark.
- **The Overall timeline's caption no longer repeats itself** — it rendered twice (once inline,
  once through the shared caption system).
- **The page-controls toggle could get stuck closed on a touchscreen** — a tap opened it and
  immediately closed it again on the same touch, so once it became the only way to reach edit
  mode on touch, the controls were unreachable there. One tap now reliably opens it, a second
  closes it.

## [0.7.0] — 2026-09-26

### Added
- **Campaign spend shows how fresh it is.** The campaigns page and the readings log show
  "Spend through &lt;date&gt; · synced &lt;time ago&gt;" for each campaign, and flag
  "stale — sync pending" when a flight day that should be stored by now is missing.
- **One shared Google Ads sync (`npm run ads:sync`).** Every ads routine now fills in every
  missing day, re-checks the last three days Google may still restate, and writes only what
  changed, so running it twice in a row changes nothing.
- **Ads data syncs on its own in Cloudflare.** A private sync worker runs the same sync every
  hour during a flight and once a day otherwise, so spend stays current even when the local
  routines don't run.
- **A "Refresh data" button on the campaigns page and the readings log** syncs stale Ads data
  on demand (at most once every 10 minutes) and updates the freshness line.
- **Reads split at the signed-out upsell fix.** Once its go-live time is set, the $100 read and
  the post-flight reads report spend, asks, accepts and sign-ups before and after the fix
  separately (two separate short tests), and the campaigns page marks the fix day and shows the
  campaign's upsell shown/accepted on each side.
- **Exact campaign sign-ups from the new/existing sign-in beacon.** Since that beacon went live
  (v1.95.5), the reads count sign-ups from new accounts exactly; earlier sign-ins and "unknown"
  answers stay an "at most" upper bound, and returning sign-ins never count.

### Changed
- **Ads readings are recorded once per day per entry.** Rerunning a read the same day no
  longer adds a duplicate row or repeats a push for the same threshold, cap trip or alert; a
  rerun is recorded only when it carries new information, and a failed read still pushes.
- **Stored spend covers closed days only.** Today's still-open numbers are no longer stored;
  flight days with no delivery are stored as zero so the stored days have no gaps, and an empty
  or incomplete answer from Google is treated as a failed read that never overwrites stored
  spend.
- **A day with no rows from Google is stored as $0 only when Google's range total agrees.**
  A partial answer can no longer record a real spend day as $0; the day it left out keeps its
  stored value and is reported, while the days around it are still stored.
- **The newest Ads days sync first.** The last three days are pulled before any older gap, so
  one day that keeps failing never holds back newer ones, and the restatement re-check only
  counts when all three days were pulled.
- **The morning read, backstop and post-flight read always re-check the last three days.**
  They no longer skip that re-check because the sync worker pulled a few hours earlier, so a
  read never decides on a yesterday pulled before Google's late data arrived.
- **A day counts as final from 03:00 ET the next day.** A pull just after midnight no longer
  marks yesterday as closed, so late clicks and cost that Google adds overnight are picked up;
  the sync worker pulls yesterday once, at 03:05 ET, instead of every hour after midnight.
- **Page views no longer count the new/existing sign-in beacon.** It fires alongside the
  ordinary sign-in beacon, so it is now excluded from page-view and visit totals like every
  other event beacon; the sign-in page view itself still counts.
- **A sync run that was cut off mid-run is reported.** The readings log shows a "Sync alert"
  and the morning, backstop and post-flight reports print it, instead of the run vanishing.
- **The Refresh warning about a mismatched sync Worker covers every campaign setting** (name,
  kind, budget, cap and measurement as well as the flight).

## [0.6.1] — 2026-09-26

### Fixed
- **Completed-game beacons no longer inflate page views.** Best Sudoku's new per-game
  completion beacon was being counted as an ordinary page view everywhere page views are
  totaled; it's now excluded the same way every other event beacon is, while the real
  "played a game" page view is unaffected.
- **Auth successes were being double-counted.** Best Sudoku's new sign-up/sign-in
  breakdown beacon fires alongside the existing auth-success beacon for the same event;
  every auth-success count in the dashboard and the scheduled ads-read routine now counts
  the event once, not twice.

### Added
- **"Completed a game" is now a real, live funnel step and overview tile** (previously
  always shown as not-yet-tracked), backed by Best Sudoku's new per-game completion
  beacon, with a go-live marker on the relevant charts. A mode/difficulty breakdown of
  completions is a planned follow-up.

## [0.6.0] — 2026-09-26

### Added
- **Best Sudoku release history, with real dates.** The overview timeline and the "Best
  Sudoku · Traffic" page's trend chart now mark every verified production release from
  v1.86.4 through v1.95.3 — major releases as labeled dashed lines, minor ones as short
  ticks — instead of a single hand-entered marker.
- **Every Best Sudoku overview and campaigns chart is now a real widget**: movable,
  resizable, removable, and editable from the chart menu, the same as every other chart
  in the dashboard. A non-destructive migration converts existing saved layouts once;
  any charts you've already customized are left exactly as they are.
- **A "note" chart type** for the small caveats (small-sample size, attribution scope)
  that used to be fixed page text — now their own movable/removable tile.
- **A hidden-by-default function bar** for filters and chart controls (range, sites,
  exclusions, add chart, theme) — hover a small top-right icon on desktop, or tap it on
  touch, to reveal it; Escape or tapping outside hides it again. Page tabs stay always
  visible. Every chart's zoom button is now a single click, always there, just
  low-contrast until you hover that chart; its edit/remove/drag/resize controls tuck
  away the same way as the filter bar.
- **A shared notes/text library.** Every caveat, definition, and explanatory paragraph
  the dashboard shows — small-sample warnings, attribution notes, "how to read this"
  captions, and more — now comes from one place, can be attached to any chart as a
  caption, and is editable from the chart menu (pick from the library or write your own).

### Changed
- **Best Sudoku tabs are grouped and reordered automatically**: your own tabs first,
  then Overview / Campaigns / Pop-ups / Traffic together in that order, then your other
  pages — applied non-destructively on load, every load, without touching any widgets.
- **The "Best Sudoku launch" page is now "Best Sudoku · Traffic"**, trimmed to what
  Overview and Campaigns don't already cover (per-site/geo/referrer/device detail), and
  its trend chart now carries release markers.
- Every Best Sudoku tab is renamed consistently (`Best Sudoku · <name>`).
- **Pop-up chart titles are plain names again.** The "no outcome tracking yet" and
  sign-in-eligibility caveats that used to be baked into a couple of pop-up chart titles
  are now default captions instead (via the notes library above) — applied
  non-destructively on load; a title you've already edited is left exactly as you left it.

### Fixed
- **Note/text links only ever render for `https:` and same-site targets** (an absolute
  path, an in-page anchor, or a plain relative path) — any other scheme, including
  `javascript:`, `data:`, `vbscript:`, plain `http:`, and a protocol-relative `//host`
  link, now renders as inert plain text instead of a clickable link. A link href is also
  fully stripped of control characters and whitespace from anywhere in it (not just the
  ends) before that check, so a disguised scheme like `java` + tab + `script:` can no
  longer slip past as "not javascript:" while still being one to the browser.
- **A data-driven value can no longer introduce markup of its own** — note/text templates
  are parsed for **bold**/[link](url) syntax before any `{variable}` is substituted, so a
  variable's value is always rendered as plain text, never as new markup.
- The always-visible zoom button's larger touch target now applies on any touch-capable
  device (`pointer: coarse`), not just narrow viewports.
- **A pop-up chart's data caveat (e.g. the known install-outcome measurement gap) now
  actually shows under the chart** — the API was already sending it, but nothing rendered
  it.

## [0.5.2] — 2026-09-26

### Changed
- **Far fewer D1 reads per dashboard load.** The site-filter list's traffic count now covers
  the last 90 days (labeled as such) instead of scanning the whole visit history on every
  load, each chart now reads the database once instead of twice for its total, and geo/stats
  chart responses are cached briefly (or, for date ranges that are already fully in the past,
  much longer) so repeat views of the same chart don't re-query at all. No numbers you rely on
  change — this only cuts the traffic-database work behind the scenes. See
  [docs/capacity.md](docs/capacity.md).

## [0.5.1] — 2026-09-26

### Fixed
- **First-50 promo outcome beacons were being dropped.** The promo's sign-in/install/
  return/still-playing outcomes use a different wire name than its shown/accept/dismiss
  beacons; the dashboard now recognizes both, so those outcomes count instead of vanishing.
  A congrats-popup beacon that has no outcome tracking is now surfaced as an "unexpected"
  count instead of disappearing silently.

## [0.5.0] — 2026-09-26

### Security
- **Sign in with Google.** The dashboard and every API call now need a signed-in Google
  account on an owner-set allowlist. The app enforces this itself, so Cloudflare Access can
  be removed once the new sign-in is verified live. If the sign-in settings are missing,
  it locks everyone out rather than opening up. The tests also run the sign-in inside
  Cloudflare's own runtime, so a request setting that runtime rejects can't ship.
- **Sign out.** The header shows who is signed in, with a Sign out button. An expired
  session brings up the re-sign-in banner on every page, the overview and campaign pages
  included, and no longer risks saving a fallback layout over your stored one.
- **Stricter sign-in checks.** Only an exact, plain-ASCII match on the allowlist gets in
  (look-alike addresses are refused), Google must mark the email verified with a real
  `true`, and sign-ins or sessions dated in the future are rejected.
- **A bad session-length setting locks sign-in instead of being guessed.** A session
  length that isn't a number of hours from 1 to 720 now shows "Sign-in not configured"
  rather than silently falling back or issuing sessions that end at once.
- **Back after Sign out no longer shows the dashboard.** Dashboard pages, files and data
  are never kept by the browser or a shared cache, Sign out also clears the site's
  cache, and no other site can embed the dashboard in a frame.
- **The local sign-in bypass is harder to switch on by accident.** It now needs the exact
  value `1` (not `true`, `0` or anything else), still only on the developer's own machine.

## [0.4.0] — 2026-09-26

### Added
- **Campaign spend now comes from the Google Ads API.** The campaigns page and the overview
  scorecard read daily spend stored in the dashboard's own database, and fall back to the
  hand-entered figures when nothing is stored.
- **A readings log on the campaigns page** shows each ads-routine read: spend, the
  thresholds reached, kill-rule results, the proposal and key counts. Sign-ups are shown as
  "at most N" (an upper bound), and a campaign that has already ended shows as ended rather
  than as a pause proposal.
- **Scheduled ads-read tooling for the US+CA web retest.** A daily morning read and the
  post-flight reads fetch spend from the Google Ads API, fire each spend threshold once, apply
  the pre-registered kill rules and decision table, and only ever propose. A failed read, a
  missed scheduled read and a real release-health alert are all surfaced rather than silent.

### Changed
- **The campaign funnel's Install step and the overview's Installs tile and timeline count
  each install once** (the pop-up outcome), with the raw install beacons, which can
  double-count, shown as a secondary tile and line.
- **The pop-ups page note now says outcomes and return visits may arrive up to 30 minutes
  late**, replacing the inaccurate "nothing is measured within 30 minutes after a sign-in".
- **Install outcomes are measured from Best Sudoku's install fix onward** (v1.95.4, 26 Sep
  12:26 ET): earlier install outcomes stay unmeasured, and ranges that span the fix say when it
  went live.

## [0.3.2] — 2026-09-26

### Added
- **Pop-up and campaign-return tracking is now live** for v1.95.3 (production web,
  2026-09-26): the "tracking not yet active" note is gone, rates and pop-up counts are
  measured, and the release timeline shows a "tracking starts" marker. Rows from before
  the release (including the 2026-09-19 sign-in-prompt spike) stay unmeasured and are
  never used as a baseline.
- **The Best Sudoku overview's release panel now shows v1.95.3** ("Pop-up +
  campaign-return tracking live on web") instead of the placeholder v1.90.0 entry.
- **Android/Play tracking now has its own config**, separate from the web release date.
  v1.95.3 was submitted to the Play production track the same day, but that's a
  review-then-staged-rollout process, not a single ship date — charts get their own
  "submitted, reaching devices from review onward" marker and a rollout caveat instead of
  being graphed as measured/unmeasured the way the web date is.
- **A standing small-sample note** on the pop-ups, campaigns and overview pages
  ("Very small numbers: rates are anecdotal. Always read the counts.") — production has
  only 14 registered users. Every computed rate on those pages, including the campaign
  page's device-mix breakdown, now shows its numerator/denominator next to the percentage
  and is gated the same way every other rate in this app is (a share computed over fewer
  than 5 devices reports "too few to report" instead of a bare, overconfident percentage).
- **The US+CA web retest campaign is now confirmed and serving** (2026-09-26 through
  2026-10-02, $13/day budget with a $100 hard stop). Its ad schedule starts at noon ET, so
  attribution now excludes same-day validation/QA traffic tagged before that time, not just
  traffic from earlier calendar days — campaign flights can optionally set a start TIME
  (not just a start date), converted DST-safely the same way every other ET boundary in
  this app is.

## [0.3.1] — 2026-09-25

### Fixed
- **Install pop-up outcomes now classify correctly.** The install-prompt outcome beacon
  previously failed to map to the install pop-up family at all.
- **Retired and unrecognized upsell reasons are grouped under "other"** instead of showing
  up as their own breakdown bucket or being silently dropped.
- **First-50 congrats no longer shows empty outcome-rate rows.** It has no outcome beacon,
  so it now shows a one-time "no outcome tracking" note instead.

### Added
- **New "still-playing" pop-up outcome rate**, covering days 14-21 after the pop-up was
  shown.
- **Sign-in-eligibility chart now carries a caveat** that its rows are measured at least 30
  minutes after finish, so they're never a valid hour-of-day signal; the pop-ups page also
  gets a standing note that sign-in-correlated rates are conservative for the same reason.

## [0.3.0] — 2026-09-25

### Fixed
- **The overview page's "same time of day" comparisons were off by an hour around DST
  transitions.** `vsYesterday`/`vsAvg7` used to reuse one elapsed-millisecond span computed
  from today's own midnight for every comparison day; it's now derived from each comparison
  day's own wall-clock time, correct on both sides of the spring-forward/fall-back
  transitions.
- **The overview page's KPI tiles, daily timeline, and release before/after panel now apply
  the same household/lifecycle exclusions as the campaign scorecard** — they'd been reading
  `hits` unfiltered, so Mike's own traffic and lifecycle-email sends could skew the numbers
  (previously up to ~4% of all-time rows). All three sections now share one WHERE-clause
  builder so this can't drift out of sync again.
- **The overview page's pop-up tap rate, campaign scorecard rates, and return rate now show
  "too few to report"** (instead of a bare "—") when they have some data but fewer than 5
  in their denominator, matching the campaign page.
- **Campaign definitions corrected against the Google Ads API.** The two closed campaigns
  weren't one flight split by date — they're two different campaigns with two different
  delivery paths: "Android launch" gets every tagged row for its uc family with no date
  split (including returners who come back after the ads stopped), while "Play-direct" sends
  ads straight to the Play Store listing and has no beacon rows at all, so it's now shown as
  spend-only ("not measurable in beacon — no Install Referrer reader") rather than an empty
  funnel. The retest campaign's start date is left unconfirmed (`null`) so its 9 existing
  rows — pre-launch validation traffic — don't count until a real flight date is set. Spend
  ($124.47 / $75.17) is now filled in from Google Ads' daily figures, so cost-per-arrival and
  cost-per-auth-success compute for the Android launch flight.
- **Flight 1's start date was off by one ET day.** It was derived from UTC-bucketed daily
  counts; re-derived from ET-bucketed ones (the campaign's real first hit is 2026-09-02
  ~22:56 ET, already 2026-09-03 in UTC), recovering ~150 tagged hits that fell outside every
  flight window.
- **Tagged hits** — every row carrying a campaign tag, as opposed to tagged *arrivals*
  (first-ever beacon only) — is now shown on the campaign page, labeled separately, next to
  the arrivals floor caveat.

### Added
- **"Best Sudoku overview" page** (first in the page list) answers "how's the release
  going, how's each campaign going, and what's happening right now": today-at-a-glance KPI
  tiles compared against the same time yesterday and the 7-day average, a daily timeline
  since the first Best Sudoku hit overlaid with campaign flights / release / tracking-
  activation markers, a campaign scorecard, and a release before/after panel. Uninstrumented
  metrics show "not yet tracking" instead of a fake 0.
- **"Best Sudoku campaigns" page** compares the three Google Ads campaigns (Android launch,
  Play-direct — spend-only, no beacon rows — and a new US+CA web retest) side by
  side: a funnel (arrivals → played → completed → sign-in ask → accept → auth success →
  install prompt → install, with "not instrumented" instead of a fake 0 for steps that
  never happened during a flight), arrivals by ET hour of day, arrivals and the funnel by
  country, daily + cumulative arrivals aligned by flight day so the flights overlay, cost
  per tagged arrival/auth success (once ad spend is filled in), device mix, and — once the
  new on-device return beacon starts reporting (v1.90.0) — a return-visit retention curve.
  Attribution is by the beacon's own campaign tag only, with a single swappable function
  deciding row membership; known verification/household traffic is excluded server-side.
- **Pop-up rates never report from a tiny sample.** Every rate (tap, outcome, eligibility)
  now needs at least 5 in its denominator — below that it shows "too few to report" instead
  of a real-looking but noisy percentage (e.g. 1/2 reading as an alarming 50%).

### Fixed
- **The on-device return beacon (`/return/...`) is now excluded from ordinary pageview/visit
  totals**, matching every other pop-up event path — it had been left off that exclusion list.

### Added
- **Pop-up tracking has a configurable activation date, so pre-release data can't read as
  a baseline.** Every pop-up rate (tap, outcome, eligibility) and count widget — other than
  the shown/day trend, which now marks the activation date with a "tracking starts" line and
  mutes the days before it — is gated to that date; a real pre-release denominator (like the
  22-event uncapped-placement-bug reproduction on 2026-09-19) can only ever show "—", never a
  misleading 0%. While the date is unset the "Best Sudoku pop-ups" page carries a note:
  "Tracking not yet active — numbers before release are not a baseline."
- **Best Sudoku pop-up tracking page.** A new "Best Sudoku pop-ups" dashboard page (next to
  the launch page) shows shown / accepted / dismissed counts, tap rates, outcome rates, the
  sign-in eligibility rate, and install's real-outcome counts for every pop-up (sign-in
  prompt, first-50 promo, upsell, install). Day trends bucket by US-Eastern calendar day
  (DST-safe), and a rate shows "—" instead of 0%/NaN until it has real data. Pop-up event
  beacons (`/signin-prompt`, `/signin-eligible`, `/promo-first50`, `/first50-congrats`,
  `/upsell`, `/install`, `/popup-outcome`) no longer count toward ordinary pageview/visit
  totals or the top-pages breakdown.
- **Best Sudoku launch page shows campaign source / medium.** A new "Campaign source /
  medium" chart on the Best Sudoku page groups by `utm_source` (e.g. `google`), alongside
  the existing campaign chart (now labeled "Campaign (utm_campaign)") — both now cover the
  Google Ads campaign traffic as well as tagged Reddit links.
- **Nested doughnuts can have any number of rings.** Add, remove, and reorder ring
  dimensions in the chart editor (e.g. site → device → OS → browser) — each becomes another
  ring outward. Beacon charts nest as deep as the data allows; Cloudflare-RUM charts cap at a
  few rings. Clicking any ring still drills to that ring's value.
- **Drill-down on more charts.** "Open as filtered page" now works from the **site × device**
  breakdown chart (drills to the clicked site or device) and from the **pageviews-over-time**
  chart (opens a page zoomed to that single day).

### Changed
- **Touch gestures on charts: tap to read, hold to drill.** On a touchscreen a short tap now
  just shows the datapoint's tooltip, and a half-second press-and-hold opens the "open as
  filtered page" menu (with a small haptic tick). Mouse behaviour is unchanged — a click still
  drills straight away.

### Fixed
- **You can scroll the dashboard by dragging anywhere on a chart again.** Cards that were
  draggable disabled touch-scrolling across the *whole* card on Android, so scrolling only
  worked from the page margin. Drag-to-rearrange is now switched off on touchscreens (it was
  only ever off on narrow ones, so large phones and tablets were affected); mouse users keep it.
- **Tapping a chart no longer flashes a blue highlight box** over it, and holding no longer pops
  the browser's own context menu on top of the drill menu.
- **On phones, the drill-down menu is now a bottom sheet and never covers the chart.** It was
  anchored at your fingertip, sitting right on top of the data (and its tooltip) you'd just
  tapped. On narrow screens it now slides up from the bottom with a dimming backdrop; on
  desktop it opens beside the point you clicked and stays fully on-screen near an edge.
- **Tapping a chart no longer leaves a tooltip stuck under the drill menu.** On touch, a
  browser's synthetic mouse event could re-show the tooltip in the instant between the tap and
  the menu opening; the tooltip is now switched off in the same moment the tap is handled.
- **Trend charts now show every day in the range.** Days with no traffic are plotted as zero
  instead of being left out, so a 4-day range no longer collapses into a 2-point line that
  looks like a 2-day range — gaps are visible as gaps.
- **"Hide my visits" and "Hide self-referrals" now apply to beacon charts too.** They were
  silently ignored on every beacon chart, so beacon and Cloudflare-RUM charts disagreed on the
  same traffic. Beacon numbers will read lower now — your own visits are finally excluded there
  as well.
- **The drill-down menu no longer overlaps the chart's hover tooltip — and hover stays
  smooth.** Only the chart you drilled hides its tooltip while its menu is open (other charts
  are untouched), and the hover state is cleared on every toggle, so a tooltip can never get
  stuck showing a stale value.
- **A stray drill can no longer silently blank the Overview, Beacon, or Best Sudoku launch
  pages.** Those canonical pages now drop any persistent page-level drill-down on load — so
  a filter written into the config by another tool can't quietly narrow a whole page to a
  value it has no data for (which was making the launch page show nothing).

### Added
- **Campaign / subreddit attribution.** New beacon dimensions — **Campaign** (utm), Source,
  and Medium — so links tagged per source (e.g. one `utm_campaign` per subreddit) are
  attributed even when the referrer is stripped. The Best Sudoku launch page gains a "By
  subreddit (tagged link)" chart; you can also group/drill any beacon chart by these.
  (Requires the companion gss-beacon campaign-tags update + its one-time DB migration.)
- **Zoom any chart.** An expand button grows the chart itself — same element, same aspect
  ratio — from its spot to a centered panel filling most of the screen, animated both ways.
  Close with the button (now a zoom-out), by clicking outside, or Esc.

### Fixed
- **"Sync all pages" no longer wipes a page's site filter.** It now shares only the date
  range across pages; each page keeps its own site selection. Previously it also synced the
  site filter, so changing a filter anywhere could overwrite a purpose-built page's sites
  (e.g. Best Sudoku's beacon filter) and leave it stuck showing no data at any date.
- **The drill-down menu stays with its chart.** "Open as filtered page" is now anchored to
  the page, so scrolling no longer leaves it stranded over a different chart.
- **Range slider is usable on touch.** The date-range slider now has − / + stepper buttons
  to nudge one step at a time, plus a taller slider and a larger thumb, so you can land on
  the exact span instead of fighting the tiny drag steps on a phone.
- **Consistent chart colors.** A value now keeps the same color across every chart and page
  — "desktop"/"mobile" and "new"/"returning" no longer swap colors based on sort order.
  Region and country charts switch to a single brand-hue gradient (most opaque = highest,
  fading down the list) instead of a rainbow.
- **Tooltips work on touch.** Tapping a data point on mobile now shows its tooltip: line
  charts get a much larger tap target, and a tap that doesn't drill keeps its tooltip up
  instead of clearing it.
- **RUM charts fail gracefully when the analytics API stalls.** The RUM endpoint now bounds
  the Cloudflare GraphQL call with a timeout and reports a clean, retryable error instead of
  hanging until the platform returns a raw 502 page.

## [0.2.0] — 2026-07-21

### Fixed
- **Drill-down menu no longer collides with the chart tooltip.** Clicking (or tapping) a
  chart value now dismisses the hover tooltip as the "Open as filtered page" menu opens, so
  the two no longer overlap — most noticeable on touch, where a tap triggered both at once.
- **Best Sudoku launch page is now fully beacon-backed.** When built by duplicating the
  RUM "Overview" page, half its charts queried Cloudflare RUM — which has almost no Best
  Sudoku data (the site is behind Access; the beacon is the real source) — and rendered
  empty. Every chart on the page now reads the bot-free beacon, filtered to the Best
  Sudoku beacon tags (web + app), and new charts added there default to the beacon too. A
  one-time migration repairs already-saved dashboards, and "Restore default charts" on that
  page re-switches every chart to the beacon (keeping your layout) rather than reverting to
  the RUM charts.
- **Beacon stat tiles no longer undercount.** A beacon stat / percentage now reflects the
  full matching set instead of only the top-N rows it charted, so its total is right even
  when there's a long tail of regions, cities, or referrers.
- **"Restore default charts" now respects the page.** It used to rebuild every page with the
  RUM "Overview" charts; a beacon page (or a drill-down off one) now comes back with beacon
  charts instead of empty Cloudflare ones, and each drill-down restores to the data source
  it was using.
- **Geo charts stay consistent with each other.** Referrer/subreddit/device/screen charts
  no longer drop visits with a blank value — they bucket them as "(direct)" / "(none)" — so
  a day of direct visits no longer shows a full map but an empty referrer chart. Every
  visit is now counted in every geo chart.
- **Your dashboard settings now actually persist.** A load-time bug discarded every saved
  configuration and silently reverted the dashboard to defaults on each visit — so filter,
  layout, and page changes never survived a reload. Your saved state is durable again.
- **First page load no longer shows briefly inflated numbers.** RUM charts now wait
  for the real-host allow-list before their first fetch, so dev/preview traffic is
  never counted — not even for the split second before the site list loads.

### Added
- **Pin your own default charts.** Each chart has a "Set as default" option (★) in its ⋯
  menu; "Restore default charts" then keeps the charts you've pinned and drops the rest,
  falling back to the factory set only when nothing is pinned.
- **Beacon charts can break down by a second dimension.** Nested-doughnut and stacked-bar
  charts now work on the beacon dataset (e.g. site × device), matching what RUM already
  offered — the chart editor exposes "Break down by" for beacon charts too.
- **Relative date ranges stay relative.** "Last 7d / 24h / …" now recomputes to a fresh
  window on every load instead of freezing to the moment you set it; exact calendar ranges
  are still kept as-is.
- **Range slider replaces the day chips.** One control opens a vertical slider spanning
  the whole window — hours (1h–23h) at the bottom, days (1d–30d) at the top — so you can
  dial in any span from "last hour" to "last month" without typing.
- **"Sync all pages" toggle.** When on, every page shares the same date range *and* site
  selection — change the filter on one page and they all match. Turn it off for independent
  per-page filters. (Drill-down pages keep their own drill constraints either way.)
- **"Best Sudoku launch" dashboard page** — a beacon page pre-filtered to Best Sudoku
  traffic (web + app) showing where visitors come from (referrers + subreddit), geo,
  device, web-vs-app, and new-vs-returning. Added automatically via a one-time migration.
- **"Referrer path" dimension** (beacon dataset) — chart the referrer's path, e.g. which
  subreddit sent a visit, alongside the referrer host; click-to-drill-down works on it too
  (drill a referrer, then see its subreddit breakdown).

## [0.1.0] — 2026-07-05

First public release — the dashboard as currently deployed at
`stats.goodstuff.software`.

### Added
- **Custom bot-free analytics dashboard.** A movable/resizable grid of charts over
  Cloudflare RUM (human-only) data, with the API token held server-side so it never
  reaches the browser.
- **Durable, multi-page dashboards.** Layout and chart definitions persist in
  Cloudflare KV (not `localStorage`), with multiple pages, per-page filters, and
  per-chart filter overrides.
- **Geo beacon dataset.** True sub-country region / city / ISP and a visitor map,
  sourced from the companion `gss-beacon` (Cloudflare RUM is country-only).
- **Auto-built site filter.** A single multi-select of sites and subdomains, built
  live from the data, that merges each site's RUM and beacon identifiers and folds
  alias hosts (HTTP redirect or `rel="canonical"`) into their canonical site.
- **Click-to-drill-down.** Clicking any chart value opens a new page filtered to it
  (device, referrer, location, and more), titled by the value.
- **Owner-visit exclusion.** Hide your own traffic by browser+OS, plus a per-device
  "exclude this device" opt-out that covers every site (first-party cookie for the
  same domain, server-side IP list for others).
- **Dev / preview traffic excluded** from both the site picker and every number.
- **Smart date range** — type spans like `7d` / `24h` / `2w` or pick exact dates.
- **Cloudflare Access lockdown** (owner-only) with a session-expiry re-sign-in prompt.
- **Light / dark theme** matching the Good Stuff Software brand.
