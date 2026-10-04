# ADR 0005: Retire the remaining bespoke widgets; every data block is a reusable component

- **Status:** Proposed (2026-10-03). Plan only; each slice below lands as its own PR. Two
  decisions are open (see "Open decisions"). Slice 4 (the rate tile) is built on decision (b)'s
  default: a percentage with its n/d for every key. Slice 5 (the shared stat and bar components)
  is built on decision (a)'s default.
- **Date:** 2026-10-03
- **Amends:** [ADR 0003](0003-metric-components.md) section 5 (the `ads-readings` and `rate` rows)
  and section 7 slice 8 ("Later"), which this ADR replaces with concrete slices.
- **Owner direction (2026-10-03):** "we need to make sure we follow through with the changes to
  remove most fully customized widgets and have all charts and data blocks be reusable comps."
  Two capabilities are approved as part of this work: a **fit-to-content card height** option and
  **inline sparklines**.

## Context

ADR 0003 slices 1-7 moved every Overview and Campaigns panel onto one configurable card
(`MetricCard` over `POST /api/metrics`) and retired their bespoke bodies. What is left is the
dispatch in `src/components/ChartCard.vue`, which still renders several widget bodies with
one-off markup or one-off data fetching. "Bespoke" below means a body that is not a reusable,
config-driven component: its markup, formatting or data fetch exists for that one widget kind.

## Inventory

Every body `ChartCard.vue` can render, in its dispatch order (`origin/main` at `c86455f`). The
generic states between rows 4 and 5 (Loading, the error text, "Tracking not yet active", "No data
in range"), the markers-and-bands list and the attached captions are shared by every non-card
body and are not bodies themselves.

The non-card data bodies all fetch through `fetchStats` (`src/api.ts`), which picks the endpoint
by dataset: `rum` → `/api/stats` (Cloudflare GraphQL RUM), `geo` → `/api/geo`, `popup` →
`/api/popups`, `completions` → `/api/completions` (the last three read D1).

| # | Body | Where it renders | Data | Verdict |
|---|---|---|---|---|
| 1 | Metric card (`widget.card`) | `MetricCard` / `MetricSection` / `MetricItem` | `POST /api/metrics` | **Reusable.** The 9 presets (`bsk-kpis`, `campaign-scorecard`, `release-before-after`, `popup-rates`, `signin-eligibility`, `campaign-funnel`, `campaign-country`, `campaign-cost`, `campaign-returns`) and any saved `{ spec }`. The stored type `rateTable` lands here too: since layout v11 it always carries `card: { preset: 'popup-rates' }`. |
| 2 | Retired-panel text (`overview`/`campaigns` with no `card`) | inline in `ChartCard` | none | **Exception** (see below): a fallback for a layout the v10/v11 migrations could not map, not a data block. |
| 3 | Ads readings log (`dataset: 'ads-readings'`) | the bespoke readings widget component (250 lines; deleted in slice 3) | its own `GET /api/ads/readings` | **Bespoke.** Own fetch, own table, own notices. Convert (slice 3). |
| 4 | Note (`type: 'note'`) | `widgets/NoteWidgetBody.vue` over the notes registry | none | **Exception**: text, not data; already shared with card captions (`NoteBlock` / `TextBlock`). |
| 5 | Stat tile (`type: 'stat'`) | inline markup in `ChartCard` | `fetchStats` totals, any dataset | **Bespoke markup** over a generic data path. Make the markup a shared component (slice 5). |
| 6 | Rate tile (`type: 'rate'`, pop-up dataset) | inline markup in `ChartCard` | `/api/popups` `dimension: 'rate'`, `rateKey` = `widget.dimension` (a `POPUP_RATE_SPECS` key), gated by `gateRate` / `MIN_COHORT` | **Bespoke.** Duplicates the card's percent display and gating. Converted to a card (slice 4, layout key `rateTile: 18`, on decision (b)'s default). |
| 7 | Bar table (`type: 'table'`, any dataset except the retired panels) | inline markup in `ChartCard` | `fetchStats` dimension rows | **Bespoke markup** over a generic data path. Shared component (slice 5). |
| 8 | Map (`type: 'map'`) | `charts/WorldMap.vue` | `/api/geo` points | **Reusable** (one generic component, config-driven). |
| 9 | Chart.js charts (bar, hbar, line, area, doughnut, pie, nestedDoughnut, stackedBar, breakdownBar) | `charts/BaseChart.vue` via `lib/charts.ts buildChartConfig` | `fetchStats` (one call per series for a series line chart) | **Reusable** (one generic component, config-driven). |

Where they are used today: the default layouts (`src/lib/defaults.ts`) hold 4 stat tiles
(`kpi-views`, `kpi-visits`, `bcn-views`, `bsk-views`), 3 notes, every card listed in row 1, no
bar table, no rate tile and no ads-readings widget (it is added from the chart editor). The
production layout fixture (`src/lib/__fixtures__/prodLayout.v9.json`, 109 widgets) holds 14 stat
tiles (8 RUM, 6 geo), 3 notes, 7 maps, 1 `rateTable` and no rate tile and no bar table: its 9
`type: 'table'` widgets are all `overview`/`campaigns` panels, which are cards since v11. The v8
capture had 22 rate tiles; by the v9 capture the Pop-ups page used the rate table (now the
`popup-rates` card), so a rate tile or a bar table now exists only where someone added one by hand.

A `rateTable` widget without a `card` would reach the generic states and draw an empty body
(`buildChartConfig` returns nothing for it), but `migratePanelsV11` runs on every load and puts
the `popup-rates` card back, so that path does not occur in practice.

**Summary:** 9 bodies; 4 bespoke ones to convert (ads readings, rate tile, stat tile, bar table);
2 exceptions (note, retired-panel fallback); charts and the map are already reusable.

## Decision

1. **Every data block renders through a reusable component.** The two bodies whose data the
   registry can already express (the rate tile and the readings log) become metric cards. The
   two whose data it cannot (the stat tile and the bar table, see "Exceptions" and decision (a))
   keep their data path but render through shared components, the same ones the card uses for a
   tile and a bar.
2. **No layout rewrite on load; a version bump where stored output outgrows an older build.** A
   converted widget is mapped to its card at render time (`ChartCard` dispatch, the way an
   `overview` widget with a `card` already renders), and the chart editor opens it in the card
   editor. Saving it writes `card`; nothing rewrites a stored layout on load. Slice 1 does not
   bump `CONFIG_VERSION` (losing `fit` only resets a height). Slices 2, 3 and 4, whose saved
   specs an older build cannot read, each bump it with no data migration, only to get the save
   guard: `functions/api/config.ts` refuses a save from a lower version with 409 ("This tab is
   out of date, reload") and backs the stored layout up to `dashboard:default:backup:v<old>`
   before the first higher-version save. Each takes the next free number on `main`: page
   navigation took v13, so slice 2 (sparklines) is v14. Why the bump, and what it does and
   does not protect, is spelled out under "Saved layouts and rollback".
3. **Parity is a test, not a claim.** Each conversion gets a parity test in the
   `src/components/metrics/presets.parity.test.ts` pattern: the old body's visible numbers and
   the new card's, from one fixture, every difference listed and asserted.
4. **Counts only.** No slice adds per-device, per-time or per-place linking of beacon rows.
   Sparklines are per-day aggregate counts (the same grain the date charts already show), never
   row times. The readings log reads stored reading records, which are anonymous aggregates.

## Open decisions (Mike)

Each has a default the plan follows unless Mike picks otherwise. Log the answer in this ADR's
status line when it comes.

### (a) Stat tile and bar table: share components, or move onto the registry

**Default: they keep their data path and only share components.** The stat tile and the bar
table keep reading through `fetchStats` (`/api/stats` for RUM; `/api/geo`, `/api/popups` and
`/api/completions` for the other datasets) with the page's full filters, and render through new
`StatTile` and `BarTable` components that the card's tile frame and bars layout also use. Their
numbers cannot change, because their data path does not.

Alternative: make them metric cards over `/api/metrics`. That needs RUM facts over Cloudflare
GraphQL and the drill and dimension-filter params in the registry, which widens the security
boundary ADR 0003 fixes (clients name registered metrics only; no free filters). It would be its
own ADR. A narrower alternative, if the bar table proves unused: drop "Table" from the chart
editor and leave existing ones rendering through `BarTable` (the v9 production capture holds none).

### (b) Rate tiles for outcome rates outside the page's rate rule

**Slice 4 took the default: keep today's display** (a percentage with its
`(n/d)` and the too-few state) for every tile. Mike can still choose the page rule; it is a
reversible follow-up.

The Pop-ups page's rule (`POPUP_RATE_TABLE_KEYS`, the `popup-rates` preset) shows a percentage
only for the tap rates and the install gap; the other outcome rates are lagged cohorts and show
as counts there. A rate tile can still name any of the 22 `POPUP_RATE_SPECS` keys:

| Keys | Count | Inside the page rule | Card ratio |
|---|---|---|---|
| `<popup>:tap` for `signin-prompt`, `promo-first50`, `first50-congrats`, `upsell`, `install` | 5 | yes | `popup.tapRate` |
| `install:outcome:installed` (the install gap) | 1 | yes | `popup.installedRate` with `alignDenominator` |
| `signin-eligible:rate` | 1 | not in the table, but valid (ADR 0003 row 13, a partition) | `popup.eligibility` |
| `<popup>:outcome:signed-in`, `:returned`, `:still-playing` for `signin-prompt`, `promo-first50`, `upsell`, `install` | 12 | **no** | `popup.signedInRate`, `popup.returnedRate`, `popup.stillPlayingRate` |
| `<popup>:outcome:installed` for `signin-prompt`, `promo-first50`, `upsell` | 3 | **no** | `popup.installedRate` (no install fix for these pop-ups, so the alignment is a no-op) |

The 15 tiles in the last two rows are the ones in question. The code holds both readings today:
ADR 0003's audit (row 12) calls them "valid, but lagged: keep %, mark provisional", and the
registry registers all four outcome ratios as valid proportions; the Pop-ups page shows them as
counts. What each choice shows on those 15 tiles once they are cards:

- **Keep today's display (default).** The card shows the same percentage, `(n/d)` and
  "too few to report" as the tile. The engine adds what ADR 0003 row 12 asked for: the value is
  marked provisional, with the `still-arriving` caveat, while the range end is inside the
  outcome's lag (signed-in 0-1 days, installed 0-7, returned 1-7, still-playing 14-21). That
  caveat is the one visible addition on these 15 tiles; the parity test asserts the numbers
  equal and lists it.

Under either choice, two display differences apply to all 22 tiles and the parity test pins
each:

- **Zero denominator.** The tile shows "too few to report" and "(0/0)" whenever the cohort is
  short, including when nothing was shown; the engine reports `no-data` when the denominator is
  0 and `too-few` only for 1-4. Default: the card's `no-data` wins for d = 0 (nothing was shown,
  which is not a small cohort); d = 1-4 stays "too few to report".
- **The eligibility caveat.** The `signin-eligible:rate` tile today shows no caveat; its card
  carries the registry's `signin-eligible-caveat`. Default: keep it (it explains the partition)
  and list it as a visible addition.
- **Apply the page rule.** Those 15 tiles stop showing a percentage and show two counts instead,
  "N <outcome> · M shown", as the Pop-ups page does. Slice 4 then registers `pair` ratios for the
  four outcomes (or uses a two-item card), and the four outcome proportions should be
  deregistered (or restricted to the install gap) so no card can ask for them again; that second
  step touches the registry and its tests, and is a visible change on any tile that exists.

Either way the 7 tiles in the first three rows keep their percentage.

## The two approved capabilities

### Fit-to-content height

A widget option `fit: 'content'` (absent = today's fixed grid height). The card measures its
own content and sets its grid height to the smallest whole number of rows that holds it, on
load and whenever the content changes (a `ResizeObserver`); the vertical resize grip is hidden
for it. Canvas widgets (`needsChartHeight`) cannot use it, because a Chart.js canvas has no
content height of its own. Phones already size every card to its content, so it changes only
the desktop grid. It is a new optional `Widget` field, so `normWidget` must whitelist it and a
round-trip test must pin that; no version bump. The editor offers it as a checkbox ("Fit height
to content") for non-canvas widgets.

Risks: a height written back by the grid fires `layout-updated`, which saves the layout; the
fitted height is derived, so a saved value is harmless, but the fit must not loop (measure,
resize, re-measure). The fit must settle after fonts and async data load. An older build drops
`fit` when it saves a layout (its `normWidget` does not know the field), so the widget falls back
to its stored fixed height. That happens on a rollback, and also when a tab opened before the
deploy saves afterwards (same version, so the save guard does not refuse it). Harmless: the
preference is lost, not data.

### Inline sparklines

`{ as: 'sparkline', series: 'daily' }` already exists in the schema and `DISPLAYS_FOR` (count
and money only), but the editor disables it and `render.ts` falls back to the current value,
because `MetricValue` carries no series. The work:

- `MetricRequest.series?: 'daily'` and `MetricValue.series?: { day: string; value: number }[]`
  (ET days, oldest first). Only count and money metrics may ask for it; validation rejects a
  ratio, so no per-day rate ever escapes MIN_COHORT gating.
- The engine computes the series from the same fact grouped by ET day, over the item's window,
  capped at 92 days; the planner counts the extra statement against the existing budget.
- `render.ts` returns the series and `MetricItem` draws a small inline SVG polyline next to the
  current value; the editor enables the option (the `editorModel.test.ts` "ALWAYS disabled"
  assertion and `CardEditorDisplay.vue`'s note flip with it).

Risks: D1 rows read rise (one GROUP BY day per series fact; measure with the `docs/capacity.md`
method); a go-live boundary inside the window must show as a gap, not a zero.

**Implemented (slice 2).** The series comes from a daily twin of the metric's own fact (it is
never derived from the scalar): it is the same metric counted per ET day, and its points sum to
the tile unless the window holds a go-live gap or exceeds 92 days. Rules as built: only `page`
and `attribution` windows (a today-so-far window is one partial day); no store metrics except
the ad-spend twin; no ratio or instant or code unit; the popup twin refuses a visitor-filtered
metric. A go-live inside the window drops the days before it (a gap, never a zero); a measured
day with no rows reads 0; a spend day the store never synced has no point. The twins group by ET
day only, with no hour, place or device column. They keep the visitor kind exactly as the scalar
facts do (the new-visitor arrivals tile reads it on every row, including `/return` and
game-complete paths, ruled in R-1a/R-1b), so a series sums to its tile; a day's total is the same
number the tile shows for a one-day ET range, so the series exposes nothing the tile does not.
Decision 2026-10-03 (A over B): were this reversed, drop `sparkline` from the allowed displays
of visitor-kind metrics (B). The sparkline draws a gap as a break in the line.
`CONFIG_VERSION` moves to 14 via `LAYOUT_VERSIONS.sparklines` (a save guard; no stored layout is
rewritten; the first v14 save backs the stored v13 layout up to `backup:v13`).

## Per bespoke body: what replaces it, what is missing, the risks

### Ads readings log (bespoke readings widget) becomes preset `ads-readings-log`

What it shows today: notices (store not bound, store unreadable, `SMALL_SAMPLE_NOTE`,
"Proposals only…"), the refresh button, sync alerts; per campaign its label, spend with its
source, a freshness line with the stale note, fired-threshold chips; then a table of readings
(Read, Kind, Spend, Rules, Proposal, Arrivals, Asks, Accepts, Auth, Sign-ups as "at most N" or
"N (exact)"). Campaigns shown: those with readings, Google Ads API spend, or active (all of
`campaignIds` when set); 30 readings by default.

Missing card capabilities:

- **A readings scope source.** `RepeatSpec.over: 'readings'` and the `reading.*` scope paths
  exist but nothing fills `RepeatContext.readings`. Readings are stored records, which is
  exactly what a scope path may bind ("config or stored records, never a beacon query"), so the
  card loads `GET /api/ads/readings` once when its spec repeats over readings, with no new
  metric and no new SQL.
- **Scope paths** for the reading counts (`reading.count.arrivals`, `asks`, `accepts`, `auth`,
  `signups`, with the "at most" / "exact" qualifier) and for the campaign's spend source,
  freshness line and fired thresholds.
- **Card-level notices** for the store and sync states (a `notices` slot fed by the readings
  response, not free markup).
- **Fit-to-content height** (slice 1), since the log's length varies.

Risks: the readings response is per campaign, so the readings repeat must nest inside the
campaign repeat; `campaignIds` narrowing must keep the old filter rule; the refresh action must
reload the readings source as well as the metrics.

### Rate tile (`type: 'rate'`) becomes a one-item card

Every `POPUP_RATE_SPECS` key has a registered ratio (see decision (b)'s table), so a rate tile
maps to a card with one item and the pop-up as a param. The card already shows "(n/d)" and
"too few to report". Missing: nothing in the registry under the default; the mapping function;
the editor change (the "Rate" type stops being offered for new charts, in slice 5; a new rate is a card, and a saved rate tile keeps the option); and the
per-chart filter button. `ChartCard` hides that button for any widget it treats as a card
(`isBespokeBody`), but the card still honours a stored `widget.filters` override, so a mapped
rate tile would keep an override nobody can see or clear. Default: keep the filter button for
mapped rate tiles. Under the page-rule choice, the outcome `pair` ratios too.

Risks:

- **Inputs.** The tile sends `/api/popups` the range, the site tags and the "hide my visits"
  fields, and nothing else (no drill, no dimension filters); `metricsContextFor` carries the same
  three, but they are not read identically. Four differences, each a parity-test case:
  - the card clamps a range longer than `MAX_RANGE_DAYS - 1` days to its newest days, where
    `/api/popups` does not;
  - a bare-date range (a legacy filter; live filters are ISO instants) is a UTC day to
    `/api/popups` and an ET day to the engine;
  - a bare-date range with `since === until` sends no range to the card at all, so its
    page-window items fail `missing-range`, where the tile still returns a number;
  - `metricsContextFor` sends the "hide my visits" fields only when `safeUA` leaves the browser
    and OS strings unchanged, so for any other string the card silently counts the viewer's own
    visits while the tile excludes them.
- **Engine versus `computePopupRate`.** The numbers must match per key: tap over activation-gated
  showings, the install gap over post-fix showings, eligibility over the earned + capped +
  unearned partition, and the `MIN_COHORT` threshold.
- **The response note.** `/api/popups` attaches the install-gap note to the install-gap tile
  (`data.note`, rendered under the body); the card must show the same caveat (the registry's
  install-fix caveat), or the parity test lists its loss.
- **Display.** Decision (b).

### Stat tile and bar table become shared components

The stat tile shows a total (pageviews or visits) with the other measure under it; the bar table
shows dimension rows with a bar scaled to the largest (it ignores `breakdown`, although the
editor allows one for "Table"). Both follow the page's full filters (sites, dates, drills,
dimension filters, per-chart overrides) through `fetchStats`, and RUM reads go through the
Cloudflare GraphQL API; the metrics registry can express none of that. They become `StatTile`
and `BarTable` components that `MetricItem` (tile frame) and `MetricSection` (bars layout) also
use, so a stat tile and a card tile look, format and gate the same way. The data path is
unchanged, so the numbers are identical by construction; a render test pins them.

The states around them are not in the data path; they live in `ChartCard` and must survive the
move: a stat tile counts as empty on its rows, not its totals ("No data in range" even when the
totals are not zero), and a pop-up-dataset stat tile shows "Tracking not yet active" before
go-live. The render test pins both.

Risks: card tile and stat tile styling converge, which changes the stat tile's look slightly;
the `.stat` class was styled in `ChartCard.vue` and in the zoomed view; slice 5 as built replaces it
with the shared `.stat-tile-*` styles. The rate tile is a metric card since slice 4, so it no longer
touches those styles.

## Saved layouts and rollback

Layouts live in KV `dashboard:default` and are normalized on load (`normalizeConfig`,
`normWidget`, `normCardRef`). The app reads the layout once, when the tab mounts, and saves the
whole layout on every change. The server's only guard is the version: it refuses a save whose
version is lower than the stored one (409), and backs the stored layout up only when a higher
version is first saved. Two builds with the same version always pass, last writer wins.

- **Forward (new build, old layout).** Safe: nothing is rewritten; a rate tile or an
  ads-readings widget without `card` is mapped at render time, so its stored fields
  (`type`, `dataset`, `dimension`, `campaignIds`) are what the mapping reads and must stay
  readable for as long as such a widget can exist.
- **A stale tab (old build, still open after a deploy).** This is the likelier case, not a
  rollback. A tab opened before the deploy holds the old layout in memory; with no version bump
  its next save overwrites everything the new build saved (card specs, `fit`, converted tiles),
  with no 409 and no backup. A tab running the old build that loads a layout saved by the new
  one also hits the loss described next. Last-writer-wins exists today; what would be new is
  dropping the guard during a rollout that adds stored capabilities. Hence the bump on slices
  2, 3 and 4 (decision 2): the stale tab gets 409 and "reload", and the first save under the
  new version backs up the old layout.
- **Rollback (old build, layout saved by a new build).** With the bump, the older build's
  saves are refused (its version is lower than the stored one), so it cannot overwrite or lose
  anything; it is read-only on the layout until `dashboard:default:backup:v<old>` is restored
  or the new build returns. What it renders meanwhile: a widget re-saved through the card editor
  carries `card`, which an older build dispatches first. `{ preset: 'ads-readings-log' }` passes
  the older `normCardRef` (the id is well formed) but the older `presetById` does not know it, so
  the card shows as an unknown preset instead of the old log. A `{ spec }` that uses a
  capability the older build lacks (the readings source, the new scope paths, notices, a series)
  fails the older `validateCard` and shows the invalid-card placeholder. Widgets never re-saved
  are unaffected.
- **Mitigation, beyond the bump.** Each slice that adds a capability a stored spec can use
  keeps the old body's stored fields on the widget (the editor writes `card` alongside them,
  never instead of them), so deleting `card` restores the old body on an older build, and its
  PR states the rollback window. Slice 1 takes no bump: a stale tab or a rollback drops `fit`,
  which only resets a height.

## Exceptions

| Body | Why it stays as it is |
|---|---|
| Note widget | Text from the notes registry, not data. It already renders through the shared `NoteBlock` / `TextBlock`. |
| Retired-panel text | A fallback for a layout the v10/v11 migrations could not map. Removing it would leave such a widget blank. |
| Stat tile and bar table **data path** | Decision (a), default. `fetchStats` carries RUM (Cloudflare GraphQL) and the drill and dimension filters for every dataset. Moving them onto `/api/metrics` would add GraphQL facts and filter params to the registry, which widens the security boundary ADR 0003 fixes. Only their markup becomes shared. |
| Chart.js charts and the map | Already one generic, config-driven component each. Turning the timeline into a series card (ADR 0003's "then the timeline") is not part of this work. |

## Slices

Each slice is one PR from a fresh `origin/main`, with tests, a CHANGELOG `[Unreleased]` bullet
and a README update when it is visible to users, and an adversarial parity review.

| Slice | Scope | Tests | Depends on |
|---|---|---|---|
| **1. Fit-to-content height** | `Widget.fit`, `normWidget` whitelist, the measuring and grid-height logic, the editor checkbox | Row-count maths as table tests; `normWidget` round trip; canvas widgets never fit | none |
| **2. Sparklines** | `series` on the request and value, the engine's per-day series, validation, `render.ts`, the SVG in `MetricItem`, the editor enabling it; `CONFIG_VERSION` bump (no data migration) | Engine series equals the date chart's per-day counts on one `node:sqlite` fixture; a ratio series is rejected; go-live gaps; editor and render tests flipped | none |
| **3. Readings log preset** | Readings scope source, `reading.count.*` and campaign spend/freshness/threshold scope paths, card notices, preset `ads-readings-log`, `ads-readings` widgets render it; retire the bespoke readings widget; `CONFIG_VERSION` bump | Parity: every number and label the old body shows, from one readings fixture, through the card; `campaignIds` narrowing; refresh reloads readings | 1 |
| **4. Rate tile to card** | The rate-tile-to-card mapping, the per-chart filter button kept for mapped tiles, retire the inline rate markup (until slice 5 the editor keeps offering "Rate": a new one stores the same `type: 'rate'` shape and is mapped at render time; slice 5 drops the option for new charts, and a saved rate tile keeps it so it can still be edited and switched back); `CONFIG_VERSION` bump; under the page-rule choice, the outcome `pair` ratios | Parity per `POPUP_RATE_SPECS` key (all 22): n/d, percent and too-few state, old tile versus card; d = 0 and d = 1-4; a range longer than `MAX_RANGE_DAYS`; a bare-date range and `since === until`; a browser string `safeUA` rewrites; the install-gap note and the eligibility caveat; a stored filter override; differences listed | decision (b) (default taken; built as layout key `rateTile: 18`) |
| **5. Shared stat and bar components** | `StatTile`, `BarTable`, used by `ChartCard` and by the card's tile frame and bars layout; retire the inline markup | Render tests pin the stat and table numbers before and after, per dataset, plus the empty-rows and "Tracking not yet active" states; card tests unchanged | decision (a) (the default unblocks it) |

Slice 4, as built: a saved rate tile is mapped to a one-item card when it is drawn (nothing is
rewritten, so a rollback loses nothing). Differences from the old tile, each asserted in
`rateTile.parity.test.ts`: the n/d line reads "(n/d)"; a zero denominator is "—" over "(0/0)"; a
range longer than `MAX_RANGE_DAYS` is clamped to its newest days; a bare-date range is read as
Eastern days, and one with `since === until` reads "unavailable"; **before tracking went live
(`TRACKING_ACTIVATION_DATE_ET`) the tile reads "not yet tracking" where the old tile read "—"
over "0/0"**; the registry notes (counted-from date, "still arriving", the eligibility caveat)
are new under the tile. The install-fix note was already shown by the old tile, as the hideable
`popup-note`; it is now the tile's caption, and a stored hide of `popup-note` still hides it.

Slice 5, as built: `StatTile` and `BarTable` (with `BarTrack`, the one bar) live in
`src/components/metrics/`. `ChartCard`'s Stat and Table bodies render them, fed by `fetchStats`
exactly as before (decision (a): the data path did not move), and `MetricItem`'s tile frame and
bar render the same `StatTile` and `BarTrack`. Nothing is stored differently, so there is no
layout key and no `CONFIG_VERSION` change. `ChartCard.statTable.parity.test.ts` pins the figures
per dataset (RUM, geo, pop-up, completions) and metric: the stat's number, label and other
measure, and each table row's label, value and bar width, against the formulas of the retired
markup, plus the "No data in range" and "Tracking not yet active" states. Differences: the
`.stat` / `.t-*` class names are now `.stat-tile-*` / `.bt-*`, and the card tile and the page
stat tile share their elements and styles but keep their own order and sizes (the page tile
reads number, then label; the card tile reads label, then number). The editor stops offering
"Rate" for a new chart; a saved rate tile still opens with its own type.

Slice 1 is first because it is small, self-contained, approved, and the readings log needs it.
Slices 2, 4 and 5 are independent of each other and of slice 3, apart from the shared `.stat`
styles noted above.

## Consequences

- `ChartCard.vue` keeps only the dispatch: card, map, chart, note, the retired-panel fallback,
  and the stat and table components.
- The bespoke readings widget component and the inline rate markup are deleted.
- Layouts are not rewritten on load, so an older build still renders every widget that was not
  re-saved through the card editor; see "Saved layouts and rollback" for the ones that were.
- `CONFIG_VERSION` rises once per slice 2, 3 and 4 with no data migration, so a tab left open
  across one of those deploys is told to reload instead of overwriting the new layout, and an
  older build cannot save over it after a rollback.
