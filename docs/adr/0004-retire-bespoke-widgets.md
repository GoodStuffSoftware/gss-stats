# ADR 0004: Retire the remaining bespoke widgets; every data block is a reusable component

- **Status:** Proposed (2026-10-03). Plan only; each slice below lands as its own PR.
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

Every body `ChartCard.vue` can render, in its dispatch order.

| # | Body | Where it renders | Data | Verdict |
|---|---|---|---|---|
| 1 | Metric card (`widget.card`) | `MetricCard` / `MetricSection` / `MetricItem` | `POST /api/metrics` | **Reusable.** The 9 presets (`bsk-kpis`, `campaign-scorecard`, `release-before-after`, `popup-rates`, `signin-eligibility`, `campaign-funnel`, `campaign-country`, `campaign-cost`, `campaign-returns`) and any saved `{ spec }`. |
| 2 | Retired-panel text (`overview`/`campaigns` with no `card`) | inline in `ChartCard` | none | **Exception** (see below): a fallback for a layout the v10/v11 migrations could not map, not a data block. |
| 3 | Ads readings log (`dataset: 'ads-readings'`) | `widgets/AdsReadingsWidgetCard.vue` (250 lines) | its own `GET /api/ads/readings` | **Bespoke.** Own fetch, own table, own notices. Convert (slice 3). |
| 4 | Note (`type: 'note'`) | `widgets/NoteWidgetBody.vue` over the notes registry | none | **Exception**: text, not data; already shared with card captions (`NoteBlock`). |
| 5 | Stat tile (`type: 'stat'`) | inline markup in `ChartCard` | `/api/stats` totals (RUM via Cloudflare GraphQL, or geo beacon D1) | **Bespoke markup** over a generic data path. Make the markup a shared component (slice 5). |
| 6 | Rate tile (`type: 'rate'`, pop-up dataset) | inline markup in `ChartCard` | `/api/stats` pop-up rate with n/d and MIN_COHORT gating | **Bespoke.** Duplicates the card's percent display and gating. Convert to a card (slice 4). |
| 7 | Bar table (`type: 'table'`) | inline markup in `ChartCard` | `/api/stats` dimension rows | **Bespoke markup** over a generic data path. Shared component (slice 5). |
| 8 | Map (`type: 'map'`) | `charts/WorldMap.vue` | `/api/stats` geo points | **Reusable** (one generic component, config-driven). |
| 9 | Chart.js charts (bar, hbar, line, area, doughnut, pie, nestedDoughnut, stackedBar, breakdownBar) | `charts/BaseChart.vue` via `lib/charts.ts buildChartConfig` | `/api/stats` | **Reusable** (one generic component, config-driven). |

Where they are used today: the default layouts (`src/lib/defaults.ts`) hold 4 stat tiles
(`kpi-views`, `kpi-visits`, `bcn-views`, `bsk-views`), 2 notes, every card listed in row 1 and no
ads-readings widget (it is added from the chart editor). The production layout fixture
(`src/lib/__fixtures__/prodLayout.v9.json`) holds 14 stat, 9 table, 3 note and 7 map widgets and
no rate tile (the v8 capture had 22; by the v9 capture the Pop-ups page used the rate table,
now the `popup-rates` card), so a rate tile now exists only where someone added one by hand.

**Summary:** 9 bodies; 4 bespoke ones to convert (ads readings, rate tile, stat tile, bar table);
2 exceptions (note, retired-panel fallback); charts and the map are already reusable.

## Decision

1. **Every data block renders through a reusable component.** The two bodies whose data the
   registry can already express (the rate tile and the readings log) become metric cards. The
   two whose data it cannot (the stat tile and the bar table, see "Exceptions") keep their data
   path but render through shared components, the same ones the card uses for a tile and a bar.
2. **No layout migration unless one is unavoidable.** A converted widget is mapped to its card
   at render time (`ChartCard` dispatch, the way an `overview` widget with a `card` already
   renders), and the chart editor opens it in the card editor. Saving it writes `card`; nothing
   rewrites a stored layout on load. This keeps `CONFIG_VERSION` at 12, so it does not collide
   with `feat/nav`'s v13. If a slice finds it needs a stored migration after all, it takes the
   next number on `main` and its PR says `feat/nav` must renumber.
3. **Parity is a test, not a claim.** Each conversion gets a parity test in the
   `src/components/metrics/presets.parity.test.ts` pattern: the old body's visible numbers and
   the new card's, from one fixture, every difference listed and asserted.
4. **Counts only.** No slice adds per-device, per-time or per-place linking of beacon rows.
   Sparklines are per-day aggregate counts (the same grain the date charts already show), never
   row times. The readings log reads stored reading records, which are anonymous aggregates.

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
resize, re-measure). The fit must settle after fonts and async data load.

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

## Per bespoke body: what replaces it, what is missing, the risks

### Ads readings log (`AdsReadingsWidgetCard`) becomes preset `ads-readings-log`

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

Every `POPUP_RATE_SPECS` key has a registered ratio (`popup.tapRate`, `popup.signedInRate`,
`popup.installedRate`, `popup.returnedRate`, `popup.stillPlayingRate`, `popup.eligibility`),
so a rate tile maps to a card with one percent item and the pop-up as a param. The card already
shows "(n/d)" and "too few to report". Missing: nothing in the registry; the mapping function
and the editor change (the "Rate" type stops being offered; a new rate is a card).

Risks: the tile reads `/api/stats`, which honours drill and dimension filters that
`/api/metrics` does not; the parity test must show whether any filter changes the tile's
numbers and list it if so. Outcome rates other than tap and the install gap fail the ADR 0003
rate-validity rule; the parity test shows what the card renders for them (counts instead of a
percentage would be the rule applied, and is a visible change to call out).

### Stat tile and bar table become shared components

The stat tile shows a total (pageviews or visits) with the other measure under it; the bar table
shows dimension rows with a bar scaled to the largest. Both follow the page's full filters
(sites, dates, drills, dimension filters, per-chart overrides) and read RUM through the
Cloudflare GraphQL API, none of which the metrics registry can express. They become
`StatTile` and `BarTable` components that `MetricItem` (tile frame) and `MetricSection` (bars
layout) also use, so a stat tile and a card tile look, format and gate the same way. The data
path is unchanged, so the numbers are identical by construction; a render test pins them.

Risks: card tile and stat tile styling converge, which changes the stat tile's look slightly;
the `.stat` class is styled in `ChartCard.vue` and in the zoomed view.

## Exceptions

| Body | Why it stays as it is |
|---|---|
| Note widget | Text from the notes registry, not data. It already renders through the shared `NoteBlock`. |
| Retired-panel text | A fallback for a layout the v10/v11 migrations could not map. Removing it would leave such a widget blank. |
| Stat tile and bar table **data path** | `/api/stats` carries RUM (Cloudflare GraphQL) and the drill and dimension filters. Moving them onto `/api/metrics` would add GraphQL facts and filter params to the registry, which widens the security boundary ADR 0003 fixes. Only their markup becomes shared. |
| Chart.js charts and the map | Already one generic, config-driven component each. Turning the timeline into a series card (ADR 0003's "then the timeline") is not part of this work. |

## Slices

Each slice is one PR from a fresh `origin/main`, with tests, a CHANGELOG `[Unreleased]` bullet
and a README update when it is visible to users, and an adversarial parity review.

| Slice | Scope | Tests | Depends on |
|---|---|---|---|
| **1. Fit-to-content height** | `Widget.fit`, `normWidget` whitelist, the measuring and grid-height logic, the editor checkbox | Row-count maths as table tests; `normWidget` round trip; canvas widgets never fit | none |
| **2. Sparklines** | `series` on the request and value, the engine's per-day series, validation, `render.ts`, the SVG in `MetricItem`, the editor enabling it | Engine series equals the date chart's per-day counts on one `node:sqlite` fixture; a ratio series is rejected; go-live gaps; editor and render tests flipped | none |
| **3. Readings log preset** | Readings scope source, `reading.count.*` and campaign spend/freshness/threshold scope paths, card notices, preset `ads-readings-log`, `ads-readings` widgets render it; retire `AdsReadingsWidgetCard` | Parity: every number and label the old body shows, from one readings fixture, through the card; `campaignIds` narrowing; refresh reloads readings | 1 |
| **4. Rate tile to card** | The rate-tile-to-card mapping, the editor no longer offering "Rate", retire the inline rate markup | Parity per `POPUP_RATE_SPECS` key: n/d, percent and too-few state, old tile versus card, differences listed | none |
| **5. Shared stat and bar components** | `StatTile`, `BarTable`, used by `ChartCard` and by the card's tile frame and bars layout; retire the inline markup | Render tests pin the stat and table numbers before and after; card tests unchanged | none |

Slice 1 is first because it is small, self-contained, approved, and the readings log needs it.
Slices 2, 4 and 5 are independent of each other and of slice 3.

## Consequences

- `ChartCard.vue` keeps only the dispatch: card, map, chart, note, the retired-panel fallback,
  and the stat and table components.
- `AdsReadingsWidgetCard.vue` and the inline rate markup are deleted.
- Layouts are not rewritten, so a rollback to an older build still renders every widget.
