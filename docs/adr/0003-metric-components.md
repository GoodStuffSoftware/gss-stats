# ADR 0003: Metric components: one configurable card, a metrics registry, one batched endpoint

- **Status:** Accepted (owner-approved 2026-09-26). Slices 1-7 are implemented (slice 7: see [its notes](#implementation-notes-slice-7)). Slices 1-3 were implemented on
  `feat/metrics-core`; see [Implementation notes](#implementation-notes-slices-1-3) for where the
  code differs from this design and why.
- **Date:** 2026-09-26
- **Branch:** `design/metric-components` (from `origin/main` v0.7.0, `1f69930`)
- **Prototype:** [`0003-metric-components.prototype.ts`](0003-metric-components.prototype.ts), a
  self-contained, type-checked file that proves the schema can express the current cards and that
  the ratio-validity rule is mechanical. Run it with `node docs/adr/0003-metric-components.prototype.ts`.
- **Lands after:** `feat/trim-uninstrumented`, `fix/clean-look`, `feat/all-beacon-fields` (section 6).

## Context

The owner, looking at the Campaign scorecard (three campaign cards, each with a title, a status badge,
flight dates, rows such as "Tagged arrivals 353" and "Cost / arrival $0.35", and funnel pills such as
"Played a game: 314.7% (1111/353)"):

> These should each be comps and not rely on custom data objects. Should be more configurable as to
> what the label is, text or object, then data and a display type. That way we can reuse one comp
> repeatedly.

How it works today:

- **Bespoke response objects.** `/api/overview` returns `OverviewResponse` (`kpis[]`, `scorecard[]`,
  `timeline`, `releasePanel`) and `/api/campaigns` returns `CampaignCompareResponse`. Each is a
  hand-shaped object in `src/types.ts`, computed in one large handler.
- **Bespoke bodies.** `OverviewWidgetBody.vue` and `CampaignsWidgetBody.vue` switch on `widget.view`
  and hand-render every field. Labels are literals in templates ("Tagged arrivals", "Cost / arrival").
  Formatting helpers (`fmt`, `pct`, `money`, `counts`) are copied between the two files.
- **Rates are chained on the server.** `funnelStepRates` divides each step of `FUNNEL_STEP_ORDER` by
  the step before it, whatever the two steps count. That is where 314.7% comes from.
- **Adding one number** means touching a response type, a handler, a body template and often a
  composable (`overviewData.ts`, `campaignsData.ts`).

Constraints any design must keep:

- **Anonymity is a hard rule.** `hits` has no per-visitor id. Every query is `COUNT(*) ... GROUP BY`
  (or `MIN`/`MAX`), never a row fetch, never a cross-row join (`functions/api/popups.ts`,
  `lib/campaigns.ts` headers).
- **D1 on Workers Free** (`docs/capacity.md`): 5,000,000 rows read per day account-wide (29% used on
  an ordinary day; a hard failure once hit), 50 queries per invocation, 10 ms CPU per invocation.
  Response caching uses the Cache API (`functions/_lib/edgeCache.ts`), never KV, whose Free-plan
  write cap is 1,000 per day.
- **Auth.** Every `/api/*` route sits behind the gate in `functions/_middleware.ts` (ADR 0002),
  including an `Origin` check on non-GET requests.
- **Text safety.** All visible text goes through the notes registry (`lib/notes.ts`) and the
  `lib/textLite.ts` tokenizer: bold and https links only, variables substituted after tokenizing,
  never `v-html`.
- **Saved layouts** are one KV value (`dashboard:default`) normalized on load by
  `lib/defaults.ts` `normalizeConfig`, whose `normWidget` is a field whitelist: an unknown widget
  field is dropped on the next load.

## The rate audit

The defect: "Played a game: 314.7% (1111/353)" and "255.3% (97/38)". The numerator counts `/game`
page-view rows (any visitor, many per device); the denominator counts arrivals (`visitor = 'new'`,
one per device). With no per-visitor ids, "the share of arrivals who played" cannot be computed at
all. The same step-over-previous-step construction produces every other funnel rate, so each one was
checked the same way: what one counted thing is (its **unit**), and whether every counted numerator
thing maps to a distinct counted denominator thing (a **declared subset**).

| # | Where it shows | Ratio | Numerator unit | Denominator unit | Verdict | Fix |
|---|---|---|---|---|---|---|
| 1 | Scorecard pill "Played a game"; Campaigns funnel "of previous step"; ads-routine threshold `funnelRates` | `/game` rows / tagged arrivals | page view | device | **Invalid.** 314.7%, 255.3% | Counts: "1,111 game-screen views · 353 arrivals" |
| 2 | Same places | completed / played: `/game/complete/*` rows / `/game` rows | completion | page view | **Invalid.** One page view can hold several games, and one game can span several views | Counts |
| 3 | Same places | ask / completed: sign-in and first-50 prompt showings / completions | showing | completion | **Invalid.** A showing is not a subset of completions (reasons include placement and streak), and completions were not instrumented before v1.95.5 | Counts |
| 4 | Same places | accept / ask | showing | showing (accept ⊂ shown) | **Valid** | Keep % |
| 5 | Same places | auth success / accept: `/auth/success/<provider>` base rows / prompt accepts | sign-in | showing | **Invalid.** Sign-ins also start from menus, so they are not a subset of accepts | Counts. The valid rate is the `signed-in` pop-up outcome over asks shown |
| 6 | Same places | install prompt / auth success | showing | sign-in | **Invalid.** Unrelated events | Counts |
| 7 | Same places | install / install prompt: `/popup-outcome/install-prompt/installed` / `/install/prompt/*` | showing | showing | **Valid in kind, deflated in practice.** Pre-fix installs are dropped row-exactly (`excludeInstallGapUnmeasured`) while pre-fix showings stay in the denominator | Keep %, but count the denominator only from `INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS` on, as `/api/popups` already does (`installPostFix`) |
| 8 | Scorecard "Return rate (d2-7)"; Campaigns returns d1 to d31-60 | `/return/<uc>/<bucket>` / `/return/<uc>/d0` | device (deduplicated on the device) | device | **Valid, but lagged.** "0.0% (0/33)" on the retest's first day is zero by construction: d2-7 cannot fire until day 2 | Keep %; mark provisional (or hide) until the bucket's lag has passed |
| 9 | Scorecard "Cost / arrival"; Campaigns cost per arrival and per auth success; ads routine | spend / arrivals; spend / sign-ins | USD | device; sign-in | **Valid as a cost**, never a percent | Keep currency. Arrivals are a floor (`ARRIVALS_CAVEAT`), so cost per arrival is a ceiling |
| 10 | Overview KPI "Pop-up tap rate" | accepts / showings (all pop-ups, today) | showing | showing | **Valid** | Keep |
| 11 | Pop-ups page `<popup>:tap` tiles | accept / shown | showing | showing | **Valid** | Keep |
| 12 | Pop-ups page `<popup>:outcome:<o>` tiles | outcome / shown | showing | showing | **Valid, but lagged.** `returned` (days 1-7) and `still-playing` (days 14-21) land after the showing, so a short or recent range mixes cohorts and can in principle pass 100% | Keep %; mark provisional while the range end is inside the lag |
| 13 | Pop-ups page `signin-eligible:rate` | earned / (earned + capped + unearned) | finish | finish (a partition) | **Valid** | Keep |
| 14 | Campaigns device mix | OS, browser or screen count / all tagged rows | row | row (a partition) | **Valid arithmetic, misleading population.** Shares are of tagged hits, so a heavy user weighs more | Label "share of tagged hits", or compute over arrival rows (`visitor = 'new'`) for a share of arrivals |
| 15 | Overview KPI deltas "vs yesterday" and "vs 7d avg" | today / a comparison window | same metric | same metric | **Invalid whenever a comparison window predates the metric's go-live.** Today (2026-09-26): Games completed (live 19:43Z, so yesterday and the 7-day average read 0), Installs (pre-fix rows are dropped, so yesterday reads 0), Pop-ups shown and accepted (tracking went live 2026-09-26, so both comparison windows predate it) | Omit a delta unless both windows are fully instrumented |
| 16 | Ads-routine report "ask rate" (`scripts/ads-reads/read.ts`, `report.ts`) | asks / tagged arrivals | showing | device | **Invalid** | Counts. Stored readings are append-only, so fix it going forward |
| 17 | Nested-doughnut outer-ring percentage (`lib/charts.ts`) | value / parent ring total | row | row (a partition) | **Valid** | Keep |

Label findings from the same pass:

- The KPI "Games played" and the funnel step "Played a game" count `/game` **page views**, not games.
  Rename both to "Game-screen views".
- The KPI "Tagged arrivals — US+CA web retest" filters on `ucValues` alone. It skips the
  `flightStartTimeEt` bound that `campaignAttributionClause` applies, so pre-launch QA rows (today
  before 12:00 ET, and the 2026-09-23 rows inside the 7-day average) can count on the KPI tile but
  never on the campaign card. One registry definition per metric removes that drift.

**The rule this ADR encodes:** a percentage is allowed only when the numerator and denominator share a
unit **and** the numerator is a declared subset of the denominator, both counted over the same
instrumented window. A cost is money over a count and never shows as a percent. Any other pairing is
counts only. The prototype applies the rule to the current funnel and reproduces the verdicts above.

## Decision

1. **One component family, configured by data.** A widget with a `card` reference (new widgets get
   type `card`) renders a `CardSpec`: an optional repeat (for example one instance per campaign), a
   title binding, a badge binding, and
   sections of `MetricItem`s. Each item is a **label** (literal text or a bound object), **data** (a
   registry id plus params) and a **display type**, with optional gating and a caption. The
   scorecard is one card repeated over campaigns. KPI tiles, funnel pills, the release panel and the
   readings log are the same component with different specs.
2. **A metrics registry** (`src/lib/metrics/`, shared by the client and the Functions the way
   `lib/popupEvents.ts` is) defines every metric once: its unit, the aggregate "fact" it comes from,
   its reducer, params, windows and instrumentation rules. Ratios are registered separately and
   checked for validity when the registry loads. Labels and captions are notes-registry ids.
3. **One batched endpoint, `POST /api/metrics`.** The client sends metric ids and params, never SQL.
   The server groups the requests into a small set of fixed, parameterized aggregate queries
   ("facts"), runs each distinct fact once, caches it with the Cache API, and derives every metric
   from the fact rows in JS.
4. **Instrumentation gating is data, not markup.** Each metric value comes back with a status
   (`ok`, `too-few`, `no-data`, `unmeasured`, `partial`, `error`). A closed campaign **omits** an
   unmeasured item instead of labelling it (the owner's closed-campaign rule). `MIN_COHORT` and the
   n/d counts are applied in one place.
5. **Migration is additive.** Existing widgets gain a `card: { preset }` reference and keep their
   legacy `dataset`/`view`, so an older build still renders them. The bespoke bodies are retired only
   after parity tests pass.

## 1. The config schema

These types move into `src/lib/metrics/types.ts`. The prototype declares the same types and checks the
examples below against them with `satisfies`.

```ts
/** What one counted thing IS. Ratio validity is decided on units (section 2). */
export type Unit = 'device' | 'row' | 'pageview' | 'completion' | 'showing' | 'signin' | 'finish' | 'usd' | 'day'

/** Fields of the object a card instance is bound to. Config or stored records, never a beacon query. */
export type ScopePath =
  | 'campaign.id' | 'campaign.label' | 'campaign.status' | 'campaign.statusToday'
  | 'campaign.flight' | 'campaign.measurabilityNote'
  | 'popup.id' | 'popup.label'
  | 'window.label'
  | 'reading.readAt' | 'reading.kind' | 'reading.spend' | 'reading.rules' | 'reading.proposal'

/** (a) LABEL: literal text, or a bound object. */
export type Label =
  | string                                            // literal; textLite markup; {campaign.label}-style vars from scope
  | { note: string; vars?: Record<string, ScopePath> } // a lib/notes.ts registry entry
  | { bind: ScopePath }                               // a field of the bound object, e.g. the campaign's name
  | { metric: true }                                  // the data binding's own registry label

/** (b) DATA: a registry id plus params. Never SQL, never an endpoint path. */
export type ParamValue = string | { scope: 'campaignId' | 'popup' }
export interface Params { campaignId?: ParamValue; popup?: ParamValue }
export type WindowSpec = 'page' | 'attribution' | 'flight' | 'todaySoFar' | 'allTime' | 'before' | 'after' | { scope: 'window' }
export type DataBinding =
  | { metric: string; params?: Params; window?: WindowSpec }
  | { ratio: string; params?: Params; window?: WindowSpec }
  | { field: ScopePath }

/** (c) DISPLAY. */
export type Display =
  | { as: 'number'; deltas?: ('yesterday' | 'avg7')[] }
  | { as: 'currency' }
  | { as: 'percent'; decimals?: 0 | 1 | 2 | 3 | 4 }  // always followed by "(n/d)" — widened to 0–4 (matches validate.ts and render.ts)
  | { as: 'counts' }                  // "1,111 game-screen views · 353 arrivals"
  | { as: 'dateRange'; days?: boolean }
  | { as: 'datetime' }
  | { as: 'badge'; tones?: Record<string, 'neutral' | 'live' | 'warn'> }
  | { as: 'bar' }                     // funnel bar, scaled to the section's largest count
  | { as: 'sparkline'; series: 'daily' }
  | { as: 'text' }

export interface Gating {
  minCohort?: number                              // may only RAISE the MIN_COHORT floor
  whenUnmeasured?: 'auto' | 'omit' | 'label'      // auto = omit for a closed campaign, label otherwise
  whenEmpty?: 'dash' | 'omit' | { note: string }  // a field or series with no value
}

export interface RepeatSpec {
  over: 'campaigns' | 'popups' | 'windows' | 'readings'
  ids?: string[]                                  // campaigns or popups; for windows: 'before' | 'after'
  status?: ('closed' | 'active' | 'upcoming')[]
  flightingToday?: boolean
  empty?: { label: Label; text: Label }           // shown once when the repeat yields nothing
}

export interface MetricItem {
  id: string                                      // stable within the card: keys, reorder, edits
  label: Label
  data: DataBinding
  display: Display
  gating?: Gating
  caption?: Label                                 // rendered through NoteBlock under the value
  frame?: 'row' | 'pill' | 'tile'                 // overrides the section layout for this item
  repeat?: RepeatSpec                             // expands in place, e.g. one tile per flighting campaign
}

export interface Section {
  layout: 'rows' | 'pills' | 'tiles' | 'bars' | 'table' // 'table': items are columns, repeat instances are rows
  title?: Label
  repeat?: RepeatSpec
  items: MetricItem[]
}

/** The container: a Card (one instance) or, with `repeat`, a StatList of N identical instances. */
export interface CardSpec {
  v: 1
  repeat?: RepeatSpec
  title?: Label
  badge?: { data: DataBinding; display: Extract<Display, { as: 'badge' }> }
  sections: Section[]
  captions?: string[]                             // note ids under the whole card
  link?: 'campaigns-page'                         // click-through; replaces the scorecard's emit('open-campaigns')
  minWidth?: number                               // grid minimum per instance (230 px today)
}

/** What a Widget stores. A preset is a code-reviewed CardSpec in src/lib/metrics/presets.ts. */
export type CardRef = { preset: string } | { spec: CardSpec }
```

**How a Widget references it** (`src/types.ts`):

```ts
export type ChartType = /* existing members */ | 'card'
export interface Widget {
  // ...existing fields, unchanged...
  /** type 'card', or a migrated overview/campaigns panel: the card this widget renders. When set,
   * ChartCard renders MetricCardBody and ignores dimension/metric/breakdown. */
  card?: CardRef
}
```

`ChartCard.vue` checks `widget.card` before its current dispatch chain and counts it in
`isBespokeBody`, so a card makes no `/api/stats` call and shows no per-chart filter button.

**Resolution rules:**

- **Scope.** A card-level `repeat` makes N instances, each with a scope (`campaign`, `popup`,
  `window` or `reading`). A param left unset is taken from the scope when the metric declares it.
  That is why the examples below never spell out `campaignId`. An explicit string pins the param
  instead.
- **Labels.** A plain string is tokenized first and interpolated second
  (`tokenizeAndInterpolate`), with vars built from the scope, so scope values can never become
  markup. `{ note }` renders through `noteTokens`. `{ bind }` reads the scope field as plain text.
  `{ metric: true }` uses the metric's registry label.
- **Display compatibility** is fixed by the data kind, not by the user:

  | Data kind | Allowed displays |
  |---|---|
  | count metric | number (optionally with deltas), bar, sparkline |
  | money metric (unit `usd`) | currency, sparkline |
  | proportion ratio | percent (n/d always shown), counts |
  | cost ratio | currency |
  | pair (counts-only juxtaposition) | counts |
  | field | dateRange, datetime, badge, text, number, currency |

  `validateCard` (prototype) enforces this on load, in the editor and in tests. When a saved config
  asks for a display its data kind doesn't allow (a percent on a pair, say), loading coerces it to
  the kind's first allowed display: `counts` for a pair, `number` for a count, `currency` for a cost.
- **Frames.** A section's layout sets each item's frame (row, pill or tile), and an item can override
  it. The owner's "pill" is therefore a frame around any display, not a display type of its own.
- **Rendering.** `MetricCardBody` (repeat) → `MetricCard` (title, badge, sections) → `MetricSection`
  (layout) → `MetricItem` (frame) → one small renderer per display type. All text goes through
  `NoteBlock` or textLite tokens. A pure function `itemViewModel(item, value, scope)` does the
  formatting so it can be tested without mounting components.

### Example: the current campaign card

The widget as saved. A preset reference keeps saved layouts small, and an improvement to the preset
reaches every widget that has not been customized:

```json
{
  "id": "ow-scorecard", "i": "ow-scorecard", "title": "Campaign scorecard",
  "type": "table", "dataset": "overview", "view": "scorecard",
  "dimension": "", "metric": "pageviews", "limit": 1,
  "card": { "preset": "campaign-scorecard" },
  "x": 0, "y": 23, "w": 12, "h": 14
}
```

The preset `campaign-scorecard` expands to this spec (also the body of `{ "spec": ... }` once a user
customizes it):

```json
{
  "v": 1,
  "repeat": { "over": "campaigns" },
  "link": "campaigns-page",
  "minWidth": 230,
  "title": { "bind": "campaign.label" },
  "badge": { "data": { "field": "campaign.statusToday" }, "display": { "as": "badge", "tones": { "flighting today": "live" } } },
  "sections": [
    { "layout": "rows", "items": [
      { "id": "flight",   "label": "Flight", "data": { "field": "campaign.flight" }, "display": { "as": "dateRange", "days": true }, "gating": { "whenEmpty": { "note": "flight-pending" } } },
      { "id": "arrivals", "label": { "metric": true }, "data": { "metric": "campaign.taggedArrivals" }, "display": { "as": "number" } },
      { "id": "auth",     "label": "Auth successes", "data": { "metric": "campaign.authSuccess" }, "display": { "as": "number" } },
      { "id": "installs", "label": "Installs", "data": { "metric": "campaign.installs" }, "display": { "as": "number" } },
      { "id": "return",   "label": "Return rate (d2-7)", "data": { "ratio": "campaign.returnD2to7PerD0" }, "display": { "as": "percent", "decimals": 1 } },
      { "id": "cpa",      "label": "Cost / arrival", "data": { "ratio": "campaign.costPerArrival" }, "display": { "as": "currency" } }
    ]},
    { "layout": "pills", "items": [
      { "id": "played",    "label": "Game-screen views", "data": { "ratio": "campaign.gameViewsVsArrivals" }, "display": { "as": "counts" } },
      { "id": "completed", "label": "Completed games", "data": { "metric": "campaign.completions" }, "display": { "as": "number" } },
      { "id": "asks",      "label": "Sign-in asks", "data": { "metric": "campaign.asks" }, "display": { "as": "number" } },
      { "id": "accept",    "label": "Accept", "data": { "ratio": "campaign.acceptPerAsk" }, "display": { "as": "percent", "decimals": 1 } },
      { "id": "signedIn",  "label": "Signed in after ask", "data": { "ratio": "campaign.signedInPerAsk" }, "display": { "as": "percent", "decimals": 1 } },
      { "id": "prompts",   "label": "Install prompts", "data": { "metric": "campaign.installPrompts" }, "display": { "as": "number" } },
      { "id": "install",   "label": "Install", "data": { "ratio": "campaign.installPerPrompt" }, "display": { "as": "percent", "decimals": 1 } }
    ]}
  ]
}
```

How this lines up with the screenshot:

- Title (`bind campaign.label`) and badge (`campaign.statusToday`: "flighting today" when
  `flightDayIndex(today)` is set, otherwise the status) are unchanged. So are the Flight row
  (`2026-09-02 → 2026-09-09 (8d)`, or the `flight-pending` note while `flightStart` is null) and the
  five number rows.
- The pill row changes where the audit says it must. "Played a game: 314.7% (1111/353)" becomes
  "Game-screen views: 1,111 views · 353 arrivals". The chain of step rates becomes counts plus the
  three valid proportions (accept, signed in after ask, install).
- Gating does the rest. For the closed Android-launch flight (served 09-02..09-09), the
  return-rate row and the completed-games pill come back `unmeasured`, because both beacons went live
  on 2026-09-26, after the flight ended. So does every step whose path never appeared site-wide during
  the serving window; that is the per-flight check `feat/trim-uninstrumented` factors out, and it is
  how that branch already decides it. All of these are **omitted**, not shown as "not instrumented"
  or "— (0/0)". What remains is the flight row, tagged arrivals, cost per arrival, the game-screen
  views pair, and any step the check finds was live.
- The spend-only Play-direct card shrinks to its flight row, because every beacon-derived value is
  `unmeasured` (reason `spend-only`) and the campaign is closed. Adding one text item bound to
  `campaign.measurabilityNote` would say why. That is a one-line change to the preset, left for the
  owner to decide.
- The active retest keeps labelled states ("not yet tracking") rather than omissions. Its
  attribution starts at 12:00 ET, so installs come back `partial` from the 12:26 ET install fix, and
  completions come back `partial` from the 15:43 ET game-complete go-live. Each carries a "counted
  from" caption. Its day-1 return rate comes back provisional.

### Example: KPI tiles

The whole "Today at a glance" widget is one card with a single `tiles` section. One tile is the unit
the owner asked about; the arrivals tile shows the item-level repeat:

```json
{
  "v": 1,
  "sections": [
    { "layout": "tiles", "items": [
      { "id": "pv", "label": "Page views",
        "data": { "metric": "bsk.pageviews", "window": "todaySoFar" },
        "display": { "as": "number", "deltas": ["yesterday", "avg7"] } },
      { "id": "arrivals", "label": "Tagged arrivals — {campaign.label}",
        "data": { "metric": "campaign.taggedArrivals", "window": "todaySoFar" },
        "display": { "as": "number", "deltas": ["yesterday", "avg7"] },
        "repeat": { "over": "campaigns", "flightingToday": true,
                    "empty": { "label": "Tagged arrivals", "text": { "note": "no-campaign-flighting" } } } },
      { "id": "tap", "label": "Pop-up tap rate",
        "data": { "ratio": "bsk.popupTapRate", "window": "todaySoFar" },
        "display": { "as": "percent", "decimals": 1 } },
      { "id": "auth", "label": "Auth successes",
        "data": { "metric": "bsk.authSuccess", "window": "todaySoFar" },
        "display": { "as": "number", "deltas": ["yesterday", "avg7"] } }
    ]}
  ]
}
```

The full preset (`bsk-kpis`) lists every current tile: page views, arrivals per flighting campaign,
game-screen views, games completed, pop-ups shown and accepted, tap rate, auth successes, installs,
raw install signals, and `/return/` d1+ returns. "Not yet tracking" and "no campaign flighting today"
are no longer special tile shapes. They are the `unmeasured` status and the repeat's `empty`
fallback. The prototype also checks a third spec, the ads readings log: a per-campaign spend row plus
a `table` section repeated over stored readings.

## 2. The metrics registry

Files, all importable from both `src/` and `functions/` (the same pattern as `lib/popupEvents.ts` and
`lib/campaigns.ts`):

| File | Holds |
|---|---|
| `src/lib/metrics/types.ts` | Section 1's types, plus `MetricValue` |
| `src/lib/metrics/units.ts` | `Unit`, unit display labels ("arrivals", "views", "showings") |
| `src/lib/metrics/facts.ts` | `FactDef`s: fixed SQL builders that reuse `campaignAttributionClause`, `applyExclusions`, `excludeInstallGapUnmeasured`, `siteWindowClause` and `popupIncludeClause` |
| `src/lib/metrics/metrics.ts` | `MetricDef`s |
| `src/lib/metrics/ratios.ts` | `RatioDef`s, plus the validity check that runs at module load and in tests |
| `src/lib/metrics/instrumentation.ts` | Go-live rules, reusing the existing constants (never copies) |
| `src/lib/metrics/presets.ts` | Code-reviewed `CardSpec`s (`campaign-scorecard`, `bsk-kpis`, ...) |
| `src/lib/metrics/validate.ts` | `validateCard`, `normCardRef` (load-time), and request validation (server) |

### Definitions

```ts
export type FactId = 'campaignPathVisitor' | 'campaignReturns' | 'flightPathsSeen' | 'bskKpiMinutes' | 'adsSpend' | 'popupHourPath' | 'bskHourPath' | 'adsReadings'

export interface FactDef {
  id: FactId
  params: ('campaignId' | 'since' | 'until' | 'sites')[]
  /** Builds ONE aggregate statement. Column names are literals here; only bound values vary. */
  sql(p: FactParams): { db: 'gss_geo' | 'gss_stats_ads'; sql: string; binds: unknown[] }
  /** Page filters this fact honours. Campaign facts use attribution windows and honour none, as today. */
  honors: ('range' | 'sites' | 'excludeOwn')[]
  ttl: 'range' | 'live' | { seconds: number }
}

/** `against: 'flight'` compares the go-live with the campaign's SERVING window (flightStart..flightEnd),
 * not the open-ended attribution window: a flight that ended before the go-live is unmeasured for that
 * metric (today's returnBeaconNotInstrumented and gameCompleteNotInstrumented). Default 'window'. */
export type InstrumentationRule =
  | { kind: 'liveAt'; atMs: number | null; against?: 'window' | 'flight'; source: string }         // e.g. GAME_COMPLETE_LIVE_AT; null = not live
  | { kind: 'liveOnEtDate'; dateEt: string | null; against?: 'window' | 'flight'; source: string } // e.g. TRACKING_ACTIVATION_DATE_ET
  | { kind: 'unmeasuredBefore'; atMs: number | null; source: string }  // install gap: the fact drops rows row-exactly
  | { kind: 'seenInFlightWindow' }                                     // empirical, per campaign (trim branch's check)
  | { kind: 'beaconMeasurable' }                                       // false for measurement: 'spend-only'
  | { kind: 'annotateAt'; atMs: number; noteId: string }               // a marker, never a gate (raw-install de-dupe)

export interface MetricDef {
  id: string
  label: string                          // notes-registry id (new NoteKind 'label')
  unit: Unit
  subsetOf?: string                      // each counted thing maps to a DISTINCT counted thing of that metric
  fact: FactId
  reduce(rows: FactRow[], ctx: ReduceCtx): number   // server-only, pure
  params: ('campaignId' | 'popup')[]
  windows: WindowSpec[]                  // allowed; the first is the default
  instrumented: InstrumentationRule[]
  lagDays?: [number, number]             // outcome beacons that arrive after the event they describe
  caveats?: string[]                     // note ids that travel with the value
}

export interface RatioDef {
  id: string
  label: string
  kind: 'proportion' | 'cost' | 'pair'
  num: string
  den: string
  /** proportion only: count the denominator only where the numerator is measured (the install fix). */
  alignDenominator?: boolean
}
```

### Facts (the only SQL there is)

| Fact | Statement (always `COUNT(*) ... GROUP BY`) | Params | Statements | TTL |
|---|---|---|---|---|
| `campaignPathVisitor` | `SELECT path, visitor, (ts >= ?) AS pf, COUNT(*) FROM hits WHERE <attribution> AND <exclusions> AND <install gap> GROUP BY path, visitor, pf` | campaignId | 1 per campaign | live 90 s; closed campaign 15 min |
| `campaignReturns` | `SELECT path, COUNT(*) FROM hits WHERE site = 'bestsudoku-web' AND (path LIKE '/return/<uc>/%' ...) AND ts >= ? AND <exclusions> GROUP BY path` (`ts >=` the campaign attribution start; no upper bound) | campaignId | 1 per campaign | live 90 s; closed 15 min |
| `flightPathsSeen` | `SELECT path, COUNT(*) FROM hits WHERE site = ? AND ts >= ? AND ts < ? GROUP BY path` over the serving window (the trim branch's `notInstrumentedFunnelSteps`) | campaignId | 1 per campaign with a start date | closed window: 24 h; open: 90 s |
| `bskKpiMinutes` | Today's KPI query: minute buckets × path × visitor × campaign over 8 ET days via `siteWindowClause` | none | 1 | 90 s |
| `adsSpend` | `readSpendSummaries` + `readFreshness` on `gss_stats_ads` | none (all campaigns) | 2 | 5 min |
| `popupHourPath` | The `/api/popups` query (hour × path × `pf`) | since, until, sites | 1 | `ttlSecondsFor(until)` |
| `bskHourPath` | The timeline query (hour × path × visitor × campaign) | since, until | 1 | `ttlSecondsFor(until)` |
| `adsReadings` | The readings-log read from `/api/ads/readings` (stored records, not beacon rows) | campaignId | 1 | 60 s |

A new metric is a new reducer over an existing fact. A new fact is a code-reviewed SQL builder. That
is the growth path, and it keeps the SQL surface small and auditable.

### The initial metric catalog

| Id | Unit | Subset of | From (fact, reducer) | Instrumented |
|---|---|---|---|---|
| `campaign.taggedHits` | row | | campaignPathVisitor, all rows | beaconMeasurable |
| `campaign.taggedArrivals` | device | | `visitor = 'new'` | beaconMeasurable |
| `campaign.gameViews` | pageview | | `path = '/game'` | beaconMeasurable |
| `campaign.completions` | completion | | `/game/complete/` prefix | liveAt `GAME_COMPLETE_LIVE_AT` against flight; seenInFlightWindow |
| `campaign.asks` | showing | | sign-in prompt and first-50 `shown` | seenInFlightWindow |
| `campaign.accepts` | showing | asks | ... `accept` | seenInFlightWindow |
| `campaign.signedInAfterAsk` | showing | asks | `popup-outcome:{signin-prompt,promo-first50}` `signed-in` | liveOnEtDate `TRACKING_ACTIVATION_DATE_ET`; seenInFlightWindow; lag 0-1 d |
| `campaign.authSuccess` | signin | | `isAuthSuccessBase` | seenInFlightWindow |
| `campaign.installPrompts` | showing | | install `shown` | seenInFlightWindow |
| `campaign.installs` | showing | installPrompts | `isInstallPromptInstalled` | unmeasuredBefore `INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS`; seenInFlightWindow; lag 0-7 d |
| `campaign.rawInstallSignals` | row | | `isRawInstallSignal` | annotateAt raw-install de-dupe (trim branch) |
| `campaign.returnD0` | device | | campaignReturns `d0` | liveOnEtDate `TRACKING_ACTIVATION_DATE_ET` against flight (`returnBeaconNotInstrumented`) |
| `campaign.returnD1` ... `campaign.returnD31to60` | device | returnD0 | per bucket | same; lag per bucket (d1: 1 d, d2-7: 7 d, d8-14: 14 d, ...) |
| `campaign.spend` | usd | | adsSpend, `resolveCampaignSpend` | |
| `bsk.pageviews` | pageview | | bskKpiMinutes, not `isEventPath` | |
| `bsk.carryOverCompletions` | completion | | as `bsk.completions`, only rows with no campaign tag (`untagged`, the complement of `anyTag`) | |
| `bsk.gameViews`, `bsk.completions`, `bsk.authSuccess`, `bsk.installs`, `bsk.rawInstallSignals` | as the campaign versions | | bskKpiMinutes | as above |
| `bsk.popupShown` | showing | | `isPopupShown` | liveOnEtDate `TRACKING_ACTIVATION_DATE_ET` |
| `bsk.popupAccepts` | showing | popupShown | `isPopupAccept` | same |
| `bsk.returnsD1plus` | row (device × bucket) | | `/return/` non-d0 | same |

`campaign.taggedArrivals` with `window: 'todaySoFar'` reads `bskKpiMinutes` through the same
attribution predicate (including `flightStartTimeEt`), which fixes the KPI/card drift noted above. The
reducer sees a campaign-scoped view of the rows, built from `campaignAttributionClause`'s logic
applied in JS to the minute rows.

### Instrumentation windows and go-live gating

For a request (metric M, campaign C if scoped, window W = [a, b)), the server computes M's
**measured interval** I:

1. `beaconMeasurable`: a spend-only campaign makes every beacon-derived metric `unmeasured`
   (reason `spend-only`).
2. `liveAt t` / `liveOnEtDate d`: I = [max(a, t), b). A null instant means not live, so
   `unmeasured`. With `against: 'flight'`, a flight whose serving window ended before t is
   `unmeasured` outright.
3. `unmeasuredBefore t`: the fact already drops those rows, so I = [max(a, t), b).
4. `seenInFlightWindow`: if none of M's paths appeared site-wide during C's serving window, the
   result is `unmeasured` (reason `not-seen-in-flight`).
5. If I is empty the status is `unmeasured`. If I is a strict part of W the status is `partial`: the
   value is a floor, and the rule's note becomes a caption (for example the install-fix note).
   Otherwise the status is `measured`.

A ratio uses I(num) ∩ I(den). With `alignDenominator`, the denominator is counted only inside that
intersection. The facts carry split columns for exactly these boundary instants. Today there is one:
`pf`, the install fix, the same split `/api/popups` already uses.

**Deltas** use the same rule. A "vs yesterday" or "vs 7d avg" value is returned only when every
comparison window lies inside I. Otherwise it is left out, never shown as "+N".

**Closed campaigns: omit, don't label.** `Gating.whenUnmeasured: 'auto'` (the default) omits an
`unmeasured` item when the instance's campaign is `closed`, and omits a section left with no items.
For an active or upcoming campaign it keeps the labelled state (the registry note
`not-yet-tracking`), matching the trim branch's "leave the active campaign's rendering as it is".
`'omit'` and `'label'` force either behaviour per item. This replaces the scattered
`notInstrumented` arrays, `FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED` checks in templates and
`noteRawText('not-instrumented')` calls.

### MIN_COHORT, n/d, and which ratios are valid

- **MIN_COHORT** stays the single constant in `lib/popupEvents.ts`. The server computes every
  proportion and cost through `gateRate`/`computeRate`, so a denominator under the floor returns
  status `too-few` with its counts. An item can raise the floor (`gating.minCohort`) but never lower
  it: `validateCard` rejects values under `MIN_COHORT`, and the server clamps.
- **n/d is always returned** for proportions and costs (`numerator`, `denominator`), including 0/0.
  A percent always shows "(n/d)", following `SMALL_SAMPLE_NOTE` ("Always read the counts"), so there
  is no toggle to hide it. A `counts` display shows "n unit · d unit" (for example "1,111 views ·
  353 arrivals"). It uses no slash, because a slash reads as a fraction.
- **Validity is checked, not documented.** At module load and in a unit test, every `RatioDef` must
  pass the prototype's `ratioVerdict`:
  - a **proportion** needs `unit(num) === unit(den)` **and** a `subsetOf` chain from num to den;
  - a **cost** needs `num` in USD and `den` a count;
  - a **pair** is always allowed, and is counts only.

  An invalid registration throws at import, so a bad ratio cannot ship. Clients can only name
  registered ratios; there is no ad-hoc num/den request. The registered set to start with:
  `campaign.acceptPerAsk`, `campaign.signedInPerAsk`, `campaign.installPerPrompt`
  (`alignDenominator`), `campaign.returnDnPerD0` × 5, `campaign.costPerArrival`,
  `campaign.costPerSignin`, `campaign.gameViewsVsArrivals` (pair),
  `campaign.taggedHitsVsArrivals` (pair; replaces "tagged hits: X (vs Y arrivals)"),
  `bsk.popupTapRate`, `popup.<id>.tap`, `popup.<id>.outcome.<o>`, and `popup.eligibility`.
- **Lag.** A ratio whose numerator has `lagDays` returns `provisional: true` until the maximum lag
  has passed since the denominator stopped growing. For campaign metrics that point is the flight's
  serving end, because the attribution window itself never closes. For page-range metrics it is the
  range end. The display adds a registry caption ("still arriving"), so the retest's day-1 "0.0%
  (0/33)" d2-7 return rate reads as provisional, not as a firm zero.
- **What would make "played per arrival" valid:** a device-deduplicated beacon, the way
  `/return/<uc>/d0` is (for example `/first-play/<uc>`, fired once per device). It would count
  devices, register as `subsetOf: 'campaign.taggedArrivals'`, and the proportion would pass the rule
  unchanged. That is a best-sudoku change, and anonymity is unaffected (the device decides, nothing
  is joined).

### Labels and captions reuse the notes registry

Every metric label, unit label, status word and gating message becomes a `lib/notes.ts` entry with a
new `NoteKind` of `'label'`: short, single-line, never a scope-default caption. `noteOptions()` keeps
listing only `note` and `text` kinds for the caption pickers, so they don't fill up with labels.
New entries include `flight-pending`, `no-campaign-flighting`, `not-yet-tracking`,
`still-arriving`, one `label.<metricId>` per metric, and the unit labels. `measurabilityNote` on
`CampaignFlight` becomes a note id. Captions (`MetricItem.caption`, `CardSpec.captions`) are
note ids or textLite strings, rendered by `NoteBlock`, so any compact-notes styling from
`fix/clean-look` applies automatically.

## 3. Data fetching

### Client: one batch per page

`useMetrics()` (`src/lib/metrics/useMetrics.ts`) replaces `useOverviewData` and `useCampaignsData`
for card widgets:

- Each `MetricCard` resolves its items against its scope into concrete requests (`{ metric | ratio,
  params, window, deltas }`) during `setup`.
- **Dedupe.** The request key is a stable stringify of the request plus only the page filters the
  metric's fact honours. A campaign metric's key therefore does not change with the page's date
  range, and changing the range refetches nothing it doesn't affect.
- **Coalesce.** Requests enqueued in the same tick, plus a 10 ms window, go out as one `POST`, split
  into chunks of at most 150 requests.
- **Cache.** A module-level `Map<key, Entry>` with in-flight dedupe, following the fixes already made
  in `overviewData.ts` and `campaignsData.ts`: a forced reload waits for the in-flight request, and
  watchers are registered synchronously in the component's effect scope so unmount stops them.
- **Reload** re-requests only that widget's keys with `fresh: true`. It hangs off ChartCard's reload
  control, which appears only in edit mode after `fix/clean-look`, instead of the in-body ↻ buttons
  both bespoke bodies carry today.
- **Errors.** A per-request error becomes that item's `error` status. A failed batch marks its
  widgets as failed, and an auth or network error calls `checkSessionExpired()`, as
  `ChartCard.load` does.

### Server: `POST /api/metrics`

```ts
interface MetricsRequestBody {
  v: 1
  context?: { since?: string; until?: string; sites?: string[]; excludeOwnVisits?: boolean; ownBrowser?: string; ownOS?: string }
  fresh?: boolean
  requests: { key: string; metric?: string; ratio?: string; params?: { campaignId?: string; popup?: string }; window?: string; deltas?: ('yesterday' | 'avg7')[] }[]
}
export interface MetricValue {
  status: 'ok' | 'too-few' | 'no-data' | 'unmeasured' | 'partial' | 'error'
  value?: number | null
  numerator?: number
  denominator?: number
  deltas?: { yesterday?: { delta: number; deltaPct: number | null }; avg7?: { delta: number; deltaPct: number | null } }
  measuredFrom?: number        // epoch ms, when partial
  provisional?: boolean        // lagged numerator still arriving
  noteIds?: string[]           // registry ids only, never text
  reason?: string              // machine code: 'spend-only' | 'not-live' | 'not-seen-in-flight' | 'unknown-id' | ...
}
interface MetricsResponseBody { v: 1; generatedAt: string; results: Record<string, MetricValue>; meta: { facts: number; cacheHits: number; statements: number } }
```

The server's steps:

1. **Validate** (see the whitelist below).
2. **Plan.** Map each request to its fact key: fact id plus the normalized fact params that fact
   honours. Deduplicate, then add the facts that instrumentation rules need (`flightPathsSeen` for
   campaigns with a start date).
3. **Budget.** If the plan needs more than 40 statements, answer `413` with `{ maxStatements: 40 }`
   and the client splits the batch. The limit is 50 queries per invocation, and this leaves room for
   the ads-store reads.
4. **Fetch** every fact with `Promise.all`. Each fact is served by
   `cachedJson`-style logic keyed by `buildCacheKeyUrl('/fact/<id>', params)`, with the fact's TTL.
   Caching is per fact, not per batch, so different batches and different pages share entries.
   `fresh: true` skips `cache.match` but still refreshes the entry.
5. **Derive** every metric in JS from the fact rows, apply instrumentation, `gateRate`, deltas and
   lag, and return numbers, enums and note ids only.

**Budget compared with today, per page load.** `/api/overview` runs about 12 to 14 uncached
statements: 3 for KPIs, timeline and first hit; 2 per campaign for the scorecard, plus 1 per closed
campaign on the trim branch; 2 for the release panel; 1 for ads spend. The Campaigns page runs about
18 uncached statements (per campaign: 4 on `gss_geo` plus 2 on `gss_stats_ads`). The scorecard plus
KPI cards need 3 `campaignPathVisitor` + 3 `campaignReturns` + 3 `flightPathsSeen` + 1
`bskKpiMinutes` + 2 `adsSpend` = 12 statements. Those are cached for 90 s to 24 h, and the Campaigns
page's card presets reuse the same fact entries. `rows_read` drops accordingly. Charts that stay on
their bespoke endpoints are unchanged.

**CPU.** The facts are already aggregated: hundreds of rows, a few thousand at most for the 8-day
minute fact. Deriving about 50 metrics is linear passes over those rows, well inside 10 ms. Slice 3
measures it with the `scripts/ads-reads/profile-worker.ts` approach before cutover.

### The security whitelist

1. **Auth and CSRF.** The route is under `/api/*`, so the ADR 0002 gate and its non-GET `Origin`
   check apply unchanged.
2. **Size limits.** The body is at most 64 KiB, with at most 200 requests. Keys must match
   `^[a-z0-9_.:-]{1,64}$`.
3. **Ids.** `metric` and `ratio` are `Map` lookups in the registry. An unknown id is a per-request
   `error` (reason `unknown-id`). It never reaches SQL, and exactly one of `metric` or `ratio` must
   be set.
4. **Params.** Only names in the metric's declared `params` are accepted, and anything else is
   rejected. `campaignId` must be in `CAMPAIGNS`' id set and `popup` in `POPUPS`' id set. `window`
   must be in the metric's `windows` and `deltas` in its enum. `sites` use the existing
   `/^[a-z0-9.\-]{1,40}$/i` filter, `since` and `until` use `WHEN_RE`, booleans must be exactly
   `true`, and `ownBrowser`/`ownOS` go through `lib/ownExclusion.ts`'s sanitizer. There are no
   free-text params.
5. **SQL.** Every statement comes from a `FactDef` builder. Column and table names are literals in
   those builders; for future geo filter params, they come from `GEO_DIMS` (and exclude
   `DERIVED_ONLY_DIMS`, from `feat/all-beacon-fields`). The client can never supply a column name,
   an operator or a SQL fragment.
6. **Anonymity.** A registry test asserts that every fact statement is an aggregate with `GROUP BY`
   (or a bare `MIN`/`MAX`), that none selects `id` or raw `ts`, and that none contains a `JOIN`.
   `adsReadings` reads gss-stats' own records, not beacon rows.
7. **Output.** The response carries numbers, enums and note ids, never text or markup. Labels are
   resolved on the client through textLite, so a card config cannot inject markup even by
   hand-editing KV.
8. **Stored card configs.** They are validated by `normCardRef` on load and `validateCard` on save.
   The server never trusts a card config: it only ever sees request lists.
9. **`fresh`.** It is only available to allowlisted, signed-in users. If more users are ever added,
   rate-limit it.

## 4. Editor UX

"Card (metrics)" becomes a chart type in `ChartEditor`. Its fields live in a child component,
`components/editor/CardEditor.vue`, so `ChartEditor` doesn't grow further. The panel widens to 640 px
on desktop and becomes a full-screen sheet on phones.

1. **Start from:** a preset (Campaign scorecard, Today at a glance, Campaign cost, Release
   before/after) or Blank. The first edit to a preset copies it into an explicit spec. A "Reset to
   preset" link undoes that.
2. **Repeat:** none, one per campaign, or one per pop-up. For campaigns: checkboxes reusing
   `CAMPAIGN_OPTIONS` (none checked means all, as today), status filter chips (closed, active,
   upcoming) and "flighting today only". The widget's existing `campaignIds` feeds this.
3. **Card title and badge:** a segmented control (Text | Campaign name | Note) plus an input or a
   select. Badge: none, campaign status, or flighting today.
4. **Sections:** each has a layout select (Rows, Pills, Tiles, Bars, Table), ↑ ↓ ✕ buttons, and
   "+ Add section".
5. **Items:** a compact list, one line per item ("Tagged arrivals · campaign.taggedArrivals ·
   number"), with ↑ ↓ ⧉ (duplicate) ✕ buttons. This is the same button pattern as the
   nested-doughnut ring editor, so it works with a keyboard and on touch; drag handles can come later.
   Each item opens to three pickers, in the owner's order:
   - **Label:** Text | Metric's own | Note | Bound field. The text input has an "insert variable"
     menu listing only the scope paths the repeat provides.
   - **Data:** Metric | Ratio | Field tabs. Metrics are grouped by source (Campaign, Today, Pop-ups,
     Spend), and each option shows its unit ("Tagged arrivals: devices"). The Ratio tab lists only
     registered ratios, each with its kind spelled out ("Accept rate: accepts ÷ asks, same showing";
     "Game-screen views vs arrivals: counts only"). Params inherited from the scope show as a chip
     ("campaign: from card") with an override. The window select lists the metric's allowed windows,
     with a hint when it ignores the page's date range.
   - **Display:** only the displays compatible with the data kind (the table in section 1), so a
     percent can't be picked for a pair. Percent offers decimals; n/d is always on.
   - **Gating** (under "More"): "When not measured" (Auto: omit for closed campaigns | Always omit |
     Show label), and a minimum cohort input with a minimum of `MIN_COHORT`. **Caption:** the
     existing note picker, or text.
6. **Live preview:** the first instance renders through `useMetrics`, debounced by 300 ms, so every
   change is visible before saving.
7. **Save** runs `validateCard`, shows errors inline next to the item, and stays disabled while any
   remain. The widget-level "Captions" checkbox list is unchanged.

## 5. Migration

### What happens to each current panel

| Current panel | Becomes | Slice |
|---|---|---|
| `overview` / `kpis` | preset `bsk-kpis` | 5 |
| `overview` / `scorecard` | preset `campaign-scorecard` | 5 |
| `overview` / `releasePanel` | preset `release-before-after` (repeat over windows before/after) | 7 |
| `overview` / `timeline` | stays a chart body (series metrics are future work) | none |
| `campaigns` / `funnel` | preset `campaign-funnel` (bars for counts, pills for valid ratios) | 7 |
| `campaigns` / `cost` | preset `campaign-cost` | 7 |
| `campaigns` / `returns` | the number rows become a preset; the line chart stays a chart | 7 |
| `campaigns` / `hourOfDay`, `flightDay`, `country`, `deviceMix` | stay chart bodies | none |
| `ads-readings` / `log` | preset `ads-readings-log` ([ADR 0005](0005-retire-bespoke-widgets.md) slice 3) | 8 |
| `popup` `rate` tiles | a one-item card ([ADR 0005](0005-retire-bespoke-widgets.md) slice 4) | 8 |

### Rules for saved layouts (KV `dashboard:default`)

1. **Additive.** `CONFIG_VERSION` goes to 8. The v8 step in `normalizeConfig` adds
   `card: { preset }` to a widget whose `dataset`/`view` matches a migrated panel and which has no
   `card` yet. It keeps `dataset`, `view`, `title`, `x/y/w/h`, `notes`, `isDefault` and
   `campaignIds` (the preset's repeat reads `campaignIds`). Nothing is removed or renamed.
2. **Version-gated and idempotent.** The step runs only when `raw.version < 8`, so a user who later
   chooses "Use legacy view" (which clears `card`) is not migrated again. Running it twice changes
   nothing.
3. **`normWidget` must pass `card` through `normCardRef`.** It validates the shape, drops unknown
   fields and invalid items, coerces displays the data kind doesn't allow, and caps sizes (at most 8
   sections, 40 items, 200-character strings). Without this, the whitelist would silently strip
   `card` on the next load. `feat/all-beacon-fields` has the same problem with
   `includeEventBeacons` today.
4. **Rollback-safe.** An older build doesn't know `card`. It renders the widget from
   `dataset`/`view` as before, and strips `card` when it next saves. Preset references cost nothing
   to lose, because v8 re-adds them. Customized specs would be lost, so:
5. **Back up on a version bump.** `functions/api/config.ts` `PUT` copies the stored value to
   `dashboard:backup:v<storedVersion>` before it first overwrites a lower version. That is one extra
   KV write per version bump. The deploy checklist also takes a manual
   `wrangler kv key get dashboard:default` before shipping slice 5.
6. **Lazy persistence.** `App.vue` only saves after `loaded` is true and a real change happens, so
   the migrated shape is written on the owner's first edit, not on page load.
7. **Restore defaults.** `defaultOverviewWidgets` and `defaultCampaignsWidgets` emit
   preset-bearing widgets from slice 5 on, so "Restore default charts" produces the new shape.
8. **Retirement.** The `kpis`/`scorecard` branches of `OverviewWidgetBody`, and the matching sections
   of `/api/overview` (`kpis`, `scorecard` and their types), are deleted only after slice 5's parity
   tests pass and one release has shipped with both paths. The timeline and release panel keep the
   endpoint until they migrate.

## 6. The in-flight branches

This work lands **after** all three. Their state on 2026-09-26: `feat/trim-uninstrumented` and
`feat/all-beacon-fields` both sit at `1f69930` with uncommitted changes in their worktrees, and
`fix/clean-look` has no branch yet.

**`feat/trim-uninstrumented`** (closed campaigns omit uninstrumented steps, a completions breakdown
widget, a raw-install marker, the return-visits chart fix):

- `functions/_lib/campaignInstrumentation.ts` `notInstrumentedFunnelSteps` becomes the
  `flightPathsSeen` fact plus the `seenInFlightWindow` rule. Slice 2 splits it into a pure SQL
  builder and row classifier, shared from `src/lib/metrics/`, and a thin executor that stays in
  `functions/_lib`. That way the logic is moved, not copied.
- Its closed-only scorecard rule (`row.status === 'closed' && notInstrumented.includes(step)`) is
  exactly `whenUnmeasured: 'auto'`. The per-row `notInstrumented` field it adds to
  `OverviewScorecardRow` is retired with the scorecard section of `/api/overview` in slice 7.
- `parseGameCompletePath` and the completions (mode × difficulty) widget stay a chart. The registry
  can later add `campaign.completions` params for mode and difficulty.
- `RAW_INSTALL_DEDUPE_LIVE_AT_UTC_MS` becomes an `annotateAt` rule (a marker, never a gate), and the
  `raw-install-dedupe` note becomes that metric's caveat.
- The `no-return-visits-yet` note becomes the return items' `whenEmpty` text.
- Order: trim merges first. Slice 1 below is written against its code.

**`fix/clean-look`** (no card header bars, controls only in edit mode, compact notes):

- A card's title and badge are content inside the card body, not a header bar, so they are not
  affected. The outer `ChartCard` header follows whatever clean-look decides.
- "Controls only in edit mode" moves reload into edit mode. `useMetrics().reload` binds to that
  control, and the in-body ↻ buttons in both bespoke bodies go away with them.
- Compact notes reach every caption automatically, because captions render through `NoteBlock`.
- Order: clean-look merges before slice 4, which builds the card components against its visual
  tokens.

**`feat/all-beacon-fields`** (every hits column as a dimension or filter):

- `GEO_DIMS` and `DERIVED_ONLY_DIMS` become the whitelist for any future filter param on
  geo-derived facts. One source, imported, never copied.
- `pathFamilyOf` and `PATH_FAMILY_LABELS` are the natural key for mapping event families to units.
  The unit table in `units.ts` should key off them, so the event-family list and the unit taxonomy
  cannot drift.
- **Hazard, to fix on that branch:** it adds `Widget.includeEventBeacons` and sends it from `api.ts`,
  but `normWidget` in `lib/defaults.ts` does not pass it through, so the flag is dropped on the next
  load. Section 5 rule 3 is the same fix for `card`.
- Order: independent of the card work. It needs to land before any card offers geo filter params
  (slice 8 or later).

## 7. Phased implementation plan

Each slice is its own `feat/`/`refactor/` branch, with tests, a CHANGELOG bullet when it is visible to
users, and a review gate.

| Slice | Scope | Tests | Depends on |
|---|---|---|---|
| **1. Fix the wrong numbers now** | In the current bodies: invalid funnel steps render as counts, "Played a game" and "Games played" become "Game-screen views", KPI deltas are omitted across go-live boundaries, the install rate's denominator starts at the fix, the KPI arrivals tile uses `campaignAttributionClause`, and the ads routine's "ask rate" becomes counts. It uses a small `RATIO_VALIDITY` table in `lib/campaigns.ts` that slice 2 absorbs. | With fixture counts: no % above 100, and no % for an invalid pair; deltas are null when yesterday or the 7-day window predates a go-live; the retest's pre-noon rows are excluded from its KPI tile | trim |
| **2. Registry** | `src/lib/metrics/` types, units, facts (builders only), metrics, ratios, instrumentation, validate; the new `label` note kind and notes | Every ratio passes `ratioVerdict`, and a deliberately invalid ratio throws; every label/caveat id exists in `NOTES_REGISTRY`; every fact is an aggregate with no `JOIN`; instrumentation interval math (live, partial, unmeasured, deltas, lag) as table tests; `validateCard` over every preset | 1 |
| **3. Endpoint** | `functions/api/metrics.ts`: validation, planner, per-fact cache, derivation | Validation rejects unknown ids, unknown params, oversize bodies and over-budget plans; fact SQL snapshots; equivalence: the same `node:sqlite` fixture (as in `geo.mergedSql.test.ts`) gives the same counts through `/api/metrics` as through `/api/overview` and `/api/campaigns`, except the deliberately changed ratios; CPU profile under 10 ms | 2 |
| **4. Components** | `MetricCardBody`, `MetricCard`, `MetricSection`, `MetricItem`, the display renderers, `useMetrics` | `itemViewModel` table tests for every display × status (ok, too-few, no-data, unmeasured with closed and active campaigns, partial, provisional, error); batcher dedupe, coalescing and chunking with a fake fetch; the effect-scope cleanup regression test ported from `campaignsData` | 3, clean-look |
| **5. Presets and migration** | `campaign-scorecard`, `bsk-kpis`; the v8 `normalizeConfig` step; `normCardRef`; `ChartCard` dispatch; the KV backup on version bump | Migration is idempotent, keeps legacy fields, doesn't re-run at v8, and survives a round trip through the v7 normalizer; parity golden test (scorecard and KPIs render the same numbers as the bespoke bodies, except the documented changes); `config.ts` backup test | 4 |
| **6. Editor** | `CardEditor.vue` | Pure-function tests for the draft ↔ spec mapping; the editor never offers an incompatible display; save is blocked while `validateCard` reports errors | 5 |
| **7. The rest of the panels** | `campaign-funnel`, `campaign-cost`, the returns rows, `release-before-after`; retire the matching bespoke branches and the `kpis`/`scorecard` sections of `/api/overview` | Parity golden tests per preset; `/api/overview`'s remaining response snapshot | 5 (6 is optional) |
| **8. Later** | Sparklines, the readings-log preset and the rest of the bespoke bodies: planned in [ADR 0005](0005-retire-bespoke-widgets.md). Still later: the timeline as a series card; device mix over arrival rows; geo filter params | As each lands | 7, all-beacon-fields |

### Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A batch goes over the 50-queries-per-invocation limit | Low (12 statements for the Overview page) | Planner cap of 40 statements, `413` with `maxStatements`, client chunking |
| D1 rows-read rises during rollout, while old and new paths both run | Medium, briefly | Per-fact caching (the old endpoints have none); measure with the `docs/capacity.md` method before and after slice 5 |
| A custom card spec is lost on a rollback-then-save | Low | Presets re-derive; KV backup on version bump; a manual backup before slice 5 |
| `normWidget` strips a new field | Certain if missed | Section 5 rule 3; a round-trip test for every new `Widget` field |
| Parity regressions while retiring bespoke bodies | Medium | Golden tests; one release with both paths; retire only after sign-off |
| The owner reads counts where there used to be percentages as lost information | Medium | It is the requested fix. The CHANGELOG bullet explains it, and the pair display keeps both numbers visible |
| Client and server registries drift | Low | One shared module; only the server evaluates data, and the client uses the registry for labels, units and display compatibility |
| Lagged outcomes are misread | Medium | `provisional` flag plus the `still-arriving` caption |
| Scope creep into a general query builder | Medium | New facts are code-reviewed builders, never client-defined. That line is the security boundary, and this ADR fixes it |

## Alternatives considered

### Component model

1. **Extend the existing Widget types**, one grid widget per number: `stat` or `rate` tiles with a
   `metricId`. This is the fewest new concepts and reuses the editor as it is. Rejected. A campaign
   card is about 13 values, so three campaigns would mean about 40 grid widgets that can't be moved
   as a unit. Nothing repeats over campaigns, so a new campaign means hand-adding widgets. And
   `Widget` is already overloaded (`dimension` holds a rate key for `rate` tiles and is empty for
   bespoke views). It also does nothing about invalid ratios.
2. **A composable card and item model inside one widget** (chosen). One component renders every
   stat-list shape. Repetition, scope binding and gating are config, and the grid keeps one widget
   per panel as today.
3. **Stored templates or a layout DSL** (Vue templates or HTML in KV). Rejected. It is an injection
   surface (the reason `v-html` is banned), it can't be validated, and it would bypass the notes
   registry.

### Transport

1. **A generic `/api/metrics` with a fact planner** (chosen). One round trip per page, facts shared
   across widgets and pages, per-fact caching, one validation point, and SQL that stays in
   code-reviewed builders.
2. **Client adapters over the existing endpoints**, mapping each metric id to a field path in
   `OverviewResponse` or `CampaignCompareResponse`. No server work. Rejected as the end state: the
   invalid rates are computed on the server, so the adapter would need its own ratio math; each
   response recomputes every section (the whole overview to show one tile); neither endpoint is
   cached; the bespoke response objects the owner objects to stay load-bearing; and every metric
   would be defined twice (adapter plus handler). Slice 1 takes the one useful piece of this idea:
   fix the rates in place first.
3. **Per-dataset metric endpoints** (`/api/metrics/campaign`, `/api/metrics/site`). Rejected. A card
   that mixes datasets (the KPI tiles mix site and campaign metrics, and cost cards mix beacon and ads
   data) would need several round trips and could not share one budget. The planner already groups
   facts by database internally.
4. **A client-side query language** (a GraphQL-like selection of columns, filters and groupings).
   Rejected. It moves the SQL-shape decision to the client, which is what the whitelist exists to
   prevent, and it makes the anonymity guarantee much harder to review.

## Consequences

- Adding a number to a card is an editor action, or a registry entry when the metric is new. It no
  longer touches a response type, a handler and a template.
- A percentage can no longer come from a unit mismatch. The registry refuses it at import, the editor
  never offers it, and the loader coerces it away. Five funnel pills change from percentages to
  counts (auth success is replaced by the valid "signed in after ask" rate), and the CHANGELOG says
  so.
- Closed campaigns get shorter, quieter cards: steps that were never measured disappear instead of
  reading "not instrumented" or "— (0/0)".
- `OverviewResponse.kpis/scorecard` and much of `CampaignCompareResponse` become dead weight. (As
  built: both endpoints were removed in slice 7. The timeline and device mix had become standard
  charts in layout version 9; hour-of-day and flight-day became standard `/api/geo` charts over
  new `hourEt` and `flightDay` dimensions rather than waiting for series metrics, and country a
  card.)
- `lib/metrics/` becomes a second shared domain module next to `popupEvents.ts` and `campaigns.ts`.
  Their classifiers stay the single source, and the registry only composes them.
- The ads routine (`scripts/ads-reads`) can later read the same registry for its reports, which
  removes the last separate copy of the funnel-rate logic.

## Implementation notes (slices 1-3)

Written against `origin/main` v0.8.0 (`0bc08fe`), which had already shipped much of slice 1
(invalid funnel rates as counts, delta gating across go-live, the post-fix install denominator,
the ads "ask rate" removal, closed campaigns omitting uninstrumented steps). The registry absorbs
that code rather than copying it.

**Slice 1 (the remainder).**
- `campaignAttributionClause` returns a JS twin, `matches(tag, rowStartMs)`, built on the same
  lower bound (`campaignAttributionStartMs`). The KPI "Tagged arrivals" tile uses it on its minute
  rows. The bound is always a whole ET minute, so minute buckets are row-exact.
- `kpiComparisonGate` also gates an `arrivals-<campaignId>` tile on its flight start: comparison
  days before it are zero by construction, and the start day is partial. (An extension of this
  ADR's row 15, approved with the plan.)
- Funnel-step labels moved from `lib/campaigns.ts` into the notes registry
  (`FUNNEL_STEP_LABEL_IDS`, `funnelStepLabel`). `campaigns.ts` cannot import `notes.ts` (a cycle:
  `notes.ts` imports `ARRIVALS_CAVEAT`), and the sync Worker bundles `campaigns.ts`.

**Slice 2 (the registry, `src/lib/metrics/`).**
- `metrics.ts` declares the fact **per window** (`windows: { attribution: 'campaignPathVisitor',
  todaySoFar: 'bskKpiDays' }`) instead of one `fact`: `campaign.taggedArrivals` is served from
  either, and the site-wide metrics from `bskKpiDays` (today so far) or `bskRangePath` (a page
  range). A metric is a row test (`path`, `visitor`) over its fact rather than a free-form
  `reduce`; spend is the one `spend()` reducer.
- Pop-up ratios take the pop-up as a param (`popup.tapRate` with `{ popup }`, …) instead of one id
  per pop-up (`popup.<id>.tap`), so one item repeated over pop-ups covers them all.
- `seenInFlightWindow` marks only a **closed** flight unmeasured (its serving window is final); an
  active or upcoming flight stays live (lead's ruling). `/api/campaigns` also marks an active
  flight's unseen steps "not instrumented"; the equivalence test lists that difference.
- `adsSpend` is one statement (`SPEND_SUMMARY_SQL`); no registered metric needs `readFreshness`.
  `adsReadings` (slice 8) and `normCardRef` (slice 5, where it is wired into `normWidget`) are not
  built yet.
- The rows every endpoint needs moved into shared modules rather than being copied:
  `isEventPath`, `isPopupShown`, `isPopupAccept`, `isReturnD1Plus` (`lib/overview.ts`),
  `WHEN_RE`/`SITE_TAG_RE` (`lib/range.ts`), the `flightPathsSeen` SQL and its classifier
  (`functions/_lib/campaignInstrumentation.ts` now runs them), and `comparisonGateForGoLive`
  (`lib/kpiFormat.ts`, shared by the KPI tiles and the registry's deltas).
- Delta gating is day-level, exactly as `kpiComparisonGate`: a go-live on or after a comparison
  day hides that comparison (the go-live day itself is partial).
- Gating messages and unit words are notes of kind `label` (never a caption, never a scope
  default); a partial value carries `counted-from` (or the rule's own note, e.g. the install fix).

**Slice 3 (`POST /api/metrics`).**
- Engine split: `src/lib/metrics/engine.ts` (pure: `planBatch`, `deriveBatch`),
  `functions/_lib/metricFacts.ts` (runs and caches facts), `functions/api/metrics.ts` (wires them).
- The planner skips any side a request's config already rules out (a spend-only campaign, a
  beacon not live for the flight, a pending flight), so the representative Overview batch needs 6
  statements, not the 12 estimated above. Measured `rows_read` and CPU: `docs/capacity.md` §7.
- Batch-level problems (body over 64 KiB, more than 200 requests, a malformed body, key or
  context, duplicate keys) are a `400`/`413`; a bad id, param, window or delta list is that
  request's `error` result (`unknown-id`, `bad-param`, `missing-param`, `bad-window`,
  `missing-range`, `bad-deltas`), so the rest of the batch still answers.
- Requests gained an optional `minCohort` (the `Gating.minCohort` this design says the server
  clamps): it may only raise `MIN_COHORT`, and only for a proportion or a cost.
- A `page` window needs `context.since` and `context.until`; there is no server default range.
  `excludeOwnVisits`, `ownBrowser` and `ownOS` are validated, but no fact honours them yet (none
  of the replaced sections does today).
- Each fact's cache key includes a hash of its SQL text, so a changed statement never reads an
  entry an older build stored, and the entry keeps the instant it was read (`asOfMs`), so
  today-so-far windows use the rows' own clock.
- The ads store is read fail-soft, as `readSpendSummaries` is: absent or unreadable means spend
  falls back to `CAMPAIGN_SPEND`.
- Deliberate differences from the endpoints the registry replaces, each asserted in
  `functions/api/metrics.equivalence.test.ts`: the install-rate denominator is row-exact at the
  fix (the `pf` split, as `/api/popups`), where `/api/overview` and `/api/campaigns` bucket by
  hour; an active flight's not-yet-seen step stays live (as above); and a step or return rate the
  endpoints still count for a flight that could not measure it is `unmeasured`.
- Beside D1-D6, two KPI differences existed on 2026-09-26 only, the day both go-lives fell on:
  "Games completed" today-so-far counted from `GAME_COMPLETE_LIVE_AT` (the registry's `partial`,
  where `/api/overview` showed "not yet tracking" until that instant), and "Installs" was
  `unmeasured` before the install fix (`INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS`) that day. Both
  go-lives are in the past, so every later today-so-far window starts after them and neither
  difference can recur.
- ET date conversions and each campaign's attribution are memoized within the engine: without that
  a batch spent most of its CPU formatting the same few dates through `Intl`.
- `campaignReturns` is now bounded below by the campaign's attribution start (the same lower bound
  as the arrivals tile), with no upper bound, so pre-launch QA return beacons are no longer counted
  and `rows_read` covers only rows since the flight began.

**Review fixes (2026-09-27).** An adversarial review passed slices 1-3 with fixes:
- **CPU (#8).** The timed facts are renamed for what they now return: `bskKpiMinutes` →
  `bskKpiDays`, `bskHourPath` → `bskRangePath`, `popupHourPath` → `popupRangePath`. They are
  aggregated by SQL into ET day windows (the KPI fact) and time segments — the bucket's position
  against the fact's cuts (`engine.ts` `factCuts`: every go-live, attribution start and alignment
  instant a metric on it can filter on, derived from the registry) — instead of one row per minute
  or hour, comparing the bucket start exactly as the engine did per row, so counts are unchanged
  and a fact's size no longer grows with traffic or range. The engine indexes each fact once per
  batch, classifies each path once, resolves each side once (planning and derivation share a
  `SideMemo`), and shares results between identical requests. ET date maths uses
  `lib/etTime.ts` (plain DST arithmetic) instead of `Intl` per call, and the request path is
  compiled at isolate start-up (`lib/metrics/prewarm.ts`). Numbers: `docs/capacity.md` §7.
- **Correctness and hardening.** #1: the notes registry has a null prototype and every lookup is
  an own-key check (`hasNote`), so `constructor`, `toString`, `__proto__` and the like are unknown
  ids, never inherited members; presets, repeat kinds and the KPI go-live map use the same rule.
  #9: a fact's cache key hashes its SQL and bound values, built at a fixed "now" so the KPI fact's
  live bounds never split it, plus an entry-format version, so a config change (tags,
  `flightStart`, `flightStartTimeEt`, `flightEnd`, cuts) never reads a stale entry. #10: context
  dates must be real calendar days and clock times, `since` before `until`, and at most 400 days
  apart. #11: a closed flight with no `flightPathsSeen` evidence is unmeasured. #12: a bad site tag
  has its own error. #13: a bare `YYYY-MM-DD` page range is an ET day (the rest of the dashboard's
  days are ET); `/api/popups` and `/api/geo` still read it as a UTC day (equivalence difference D6;
  the dashboard's range control always sends datetimes). #5: a ratio of unknown kind is refused at
  registration. #6: the ads routine's report says "game-screen views", through the notes label.
  Deltas are emitted only when finite and their percentage only when finite (absent against a zero
  day, never `null`); a non-finite value is an `error`.
- **#2, checked:** the KPI fact filters on the Best Sudoku sites and the campaign fact does not, so
  the two could disagree only if a campaign's tagged rows landed on another site. A read-only
  production query (2026-09-27) found no row on any other site carrying any configured campaign
  tag (0 arrivals, 0 rows); the registry comment says so instead of claiming they can never
  disagree.
- **Follow-up (#7), not changed here:** `lib/campaigns.ts` `etTimeUtcMs` returns a fallback
  instant for a wall-clock time the spring-forward transition skips (02:00-02:59 ET on the second
  Sunday of March). It predates this branch and no configured `flightStartTimeEt` falls in that
  hour; `etTime.ts` `etWallTimeMs` maps such a time forward instead. Worth aligning the two before
  a campaign ever starts in that hour.

## Implementation notes (slices 4-5)

**Slice 4 (`src/components/metrics/`, `src/composables/useMetrics.ts`).**
- `MetricCard` resolves the `CardRef` and the card-level repeat; `MetricSection` lays out one
  section; `MetricItem` renders a row, pill or tile; `MetricTableCell` is a `table` column cell;
  `MetricPlaceholder` draws a repeat's `empty` fallback in the same frame as its neighbours (the
  KPI "no campaign flighting today" tile). All formatting is the pure `itemViewModel`
  (`lib/metrics/render.ts`); scope expansion and request building are pure functions in
  `lib/metrics/scope.ts`.
- There is no `MetricCardBody`: `ChartCard` will render `MetricCard` directly (slice 5 phase B).
- Hardening from the slice-4 review: `itemViewModel` never renders a non-finite number (a dash
  instead of `NaN`, `$Infinity` or `NaN%`), treats a null or non-finite delta as absent (a
  delta of `Infinity` arrives as `null` after JSON), and always shows a percent's `(n/d)`, with
  `?` for a side that did not come back. Preset ids are read through `presetById`
  (`Object.hasOwn` over a null-prototype `PRESETS`), so `constructor` is an unknown card.

**Page context and stale responses (`useMetrics`).** A card follows the page's filter bar:
`useMetrics(context)` takes a ref or getter, and one watcher per `useMetrics()` call, keyed on
the normalized context's stable key, re-points each of its requests at the cache entry for the
new context. It acquires every new entry first (so they go out as one coalesced batch) and then
releases the old ones (unqueued, or aborted once no other card wants them). Each request's value
is a `computed` over a swappable entry ref, so the watcher, the computeds and the one
`onScopeDispose` are all created synchronously in `setup()`; nothing reactive is created in a
callback, which is the v0.8.0 `campaignsData` leak this module exists to avoid.
- The review suggested keying the card subtree on the context key instead (a remount per
  change). Not chosen: a remount throws away the DOM state a reader has (an open notes toggle,
  focus), re-runs every repeat expansion and request build, and drops every shared entry's
  refcount to zero before the new subtree acquires it, so two cards sharing a request would
  race to abort and re-create it. The watcher keeps the component instances and swaps only the
  data. It is safe under the same two conditions a remount would give for free: it is disposed
  with the scope (a test changes the context after `scope.stop()` and asserts no fetch), and it
  is race-guarded.
- The race guard is per entry: `entry.inflight` is the POST most recently dispatched for it, and
  a response or a failure writes the entry only while it still owns it. A reload, or a context
  flip back to a key that is still in flight for another card, replaces the owner, so a slow
  ordinary fetch resolving after a reload can no longer overwrite the fresher value (the slice-4
  review's race; `useMetrics.context.test.ts` resolves the slow one last and asserts the fresh
  value stays).
- The client's cache key still includes the whole page context, even for requests whose fact
  honours none of it (campaign attribution windows, today so far). A filter change therefore
  re-requests those too; the server answers them from its per-fact cache, not D1. Keying each
  request only on the filters its fact honours (section 3, "Dedupe") is a later refinement.

**Slice 5, phase A (presets; no layout change yet).**
- `campaign-scorecard` and `bsk-kpis` reproduce the bespoke Overview `scorecard` and `kpis`
  views. `presets.parity.test.ts` mounts the old body over `/api/overview` and the preset over
  `/api/metrics` against one `node:sqlite` fixture, compares every title, badge, row, pill,
  tile, value and delta line, and lists each difference: D1, D3, D4 and D5 from slice 3, the
  game-screen-views pair (slice 1), two relabelled KPI tiles, and caveats that now sit behind
  the card's Notes toggle.
- D5 stays by design: the closed Android flight's "Installs" row is omitted although the old
  body showed a count of 1. The flight never saw the installed outcome while it served, and the
  owner's rule for closed campaigns is to omit what the flight could not measure, not to show a
  count that only the post-flight trickle produced.
- Parity rather than the ADR example for the pills: they keep the bespoke body's step names and
  its "Auth success" count, and do not add a "Signed in after ask" rate (lead's ruling).
- The owner's look, kept: a rate tile shows the rate big and its `(n/d)` as a small line under
  it (`ItemViewModel.split`; rows and pills keep it inline); "Updated Xs ago" and the reload
  control sit top-right above the tiles (`CardSpec.showUpdated`: `'header'`, the default for
  `true`, or `'footer'`; `reload()` is also exposed for `ChartCard`); and caveats add no visible
  line. Items with `captionMode: 'compact'` show no caption; each card instance
  (`MetricCardInstance`) has one "Notes" toggle in its header, collapsed by default, listing
  them as "<label>: <caveat>". The click-through is the title, a real button, so no
  `role="button"` wraps other controls.
- Other generic render additions: a "new today" delta line when a today-so-far count asked for
  deltas and every comparison predates its go-live; muted status words ("not yet tracking");
  and a section with no visible item after gating is omitted, title included.
- Errors never look like data: an error value is the muted word "unavailable", not a dash, and
  while any value on a card is in error (`useMetrics().hasError`), "Updated" gives way to "Some
  numbers could not be loaded." with Retry, on every card whether or not it shows freshness.
- Decided on the client from the campaign's own config (`unmeasuredByConfig`, the same two
  checks as the engine's `sideStatic`): a spend-only campaign's beacon items and a flight
  without a start date's non-spend items are omitted whatever the status, and never requested.
  So the Play-direct card is its Flight row from the first render, with no "…" and no "not yet
  tracking", and "pending — start date not yet confirmed" appears only in the Flight row.
- The ET day follows the clock (or the `nowMs` seam), not the first render. The day is part of
  every request's client cache key (`useMetrics`' `epoch`, never sent), and the card body is
  keyed on it: at midnight "flighting today" repeats re-expand, badges change, and today-so-far
  values are re-requested instead of served from yesterday's entry. The card's own request list
  lives in an effect scope rebuilt per day and stopped with the component.
- Text: the "/return/ d1+ returns" tile is "Return visits (day 1+)" (owner-approved), with what
  it counts in the `returns-d1plus-caveat` note; the raw-install de-dupe note no longer names a
  beacon path.
- Follow-ups from the metrics-core re-review, landed here: at exactly ET midnight the
  today-so-far window is empty and now reads as a measured 0, not `unmeasured` (tiles never
  flash "not yet tracking" at midnight); the 400-day range cap counts calendar days when both
  ends are bare dates, so an extra fall-back hour no longer refuses a 400-day range; and
  `prewarm()` returns whether it succeeded and warms every registry request in
  `MAX_REQUESTS`-sized chunks instead of truncating to the first 200.
- From the phase-A fix verification: a window that has not begun (start after end, e.g. an
  attribution window before a flight's 12:00 ET start) is `unmeasured` with reason and note
  `not-started`, rendered as a muted "not started"; only an empty window (start == end, ET
  midnight) is a measured 0. A flighting-today repeat whose only campaigns are spend-only shows
  its placeholder as "no beacon-tracked campaign flighting today" rather than losing the tile.
  The status line follows `showUpdated` (an error in a footer card stays in the footer, with
  Retry), shows on an untitled card too, and the error is announced through one live region
  that is in the DOM, empty, from mount. Each Notes toggle is labelled "Notes: <card title>"
  and controls its list; a status word in a pill is muted like one in a row or tile.

**Slice 5, phase B (the cards replace the panels; `CONFIG_VERSION` 10).**
- Version 10 in place of section 5's version 8 (v8 and v9 shipped other migrations first). The
  step is additive as designed: `migrateCardsV10` adds `card: { preset }` to every widget with
  dataset `overview` and view `kpis` or `scorecard` (`bsk-kpis`, `campaign-scorecard`), on any
  page, matched by what the widget is, never by its title or its page's name. It keeps id,
  position, size, title, notes and the default mark, keeps dataset/view (an older build still
  recognises the panel), never touches a card already set, and never adds or removes a widget.
  It runs on every load rather than only below version 10, because the bespoke bodies are
  retired: a panel created later from the chart editor must get its card too. The editor keeps
  the card in step with the view (`syncCardWithView`). There is no "use legacy view" opt-out.
- `normWidget` passes `card` through `normCardRef`: a `{ preset }` is kept by id (an unknown id
  renders as an unknown card); a `{ spec }` is kept as a plain-JSON copy when it passes
  `validateCard` and the caps (8 sections, 40 items, 200-character strings, 16 KiB), otherwise
  it becomes the `invalid-card` placeholder, which renders a one-line message.
- `ChartCard` renders `MetricCard` for any widget with `card`, before its dataset dispatch,
  passing the page context (`lib/metrics/pageContext.ts`: the effective range, capped at the
  server's 400 days, and the resolved beacon site tags; no own-visit fields, which no fact
  honours and the server would refuse if malformed). Its header ↻ calls the card's `reload()`;
  zoom and reveal are unchanged; the per-chart filter button stays hidden, as for the panels.
- The KV backup needed no change: `functions/api/config.ts` already copies the stored layout to
  `dashboard:default:backup:v<stored>` on the first save of a newer version; its 400/409 guards
  read `CONFIG_VERSION`. The key is named after the version that was stored, not the previous
  release: production was still stored at v8 with no backup keys (review, 2026-09-27), so unless
  a v0.9.0 save happens first, the first v10 save writes `backup:v8`. A code rollback to v0.9.0
  also needs that layout restored, since v0.9.0 gets 409 on a v10 layout (README, "Restoring a
  layout backup").
- Retired with the panels: the `kpis` and `scorecard` branches of `OverviewWidgetBody`, the KPI
  and scorecard sections of `/api/overview` (its minute-bucket KPI query and the per-campaign
  scorecard queries; the endpoint now serves only the release panel), `OverviewKpiTile`,
  `OverviewScorecardRow`, `lib/overview.ts`'s KPI tile helpers, `lib/kpiFormat.ts`'s tile
  formatters and `lib/campaigns.ts` `scorecardNotInstrumentedSteps`. The equivalence test's
  `/api/overview` comparisons retired with them; the parity test now compares the cards with a
  golden captured from the retired body over the same fixture, the commit before it was removed.
- Migration tests run on the real default layout, on the production layout (read read-only from
  KV, the owner's browser/OS fingerprint replaced, committed as `src/lib/__fixtures__/`
  `prodLayout.v8.json` plus its v9 normalisation), on custom, deleted and renamed variants, and on
  an already-v10 layout. On production, v9 → v10 changes exactly two widgets, `ow-kpis` and
  `ow-scorecard` on "Best Sudoku · Overview", by adding their card.

## Implementation notes (slice 7)

**The rest of the panels (`CONFIG_VERSION` 11).** Every remaining bespoke panel is a card preset
or a standard chart, swapped in place by `migratePanelsV11` (`lib/defaults.ts`) on every load:
matched by what the widget is (`panelKey`: dataset and view, and for the pop-up dataset its
`rateTable` type or `eligible` dimension), never by its title or page; id, position, size, title,
captions and default mark kept; nothing added, removed or reordered; a card already set is left
alone. On production, v9 → v11 changes eleven widgets: the two v10 cards, seven v11 cards and two
charts (`defaults.v11.test.ts`).

| Panel | Becomes |
|---|---|
| `overview` / `releasePanel` | preset `release-before-after`: a column table (Before / After) of four counts |
| `campaigns` / `funnel` | preset `campaign-funnel`, with the upsell-fix segment table as a section |
| `campaigns` / `country` | preset `campaign-country`: steps as rows, US / CA / Other as columns |
| `campaigns` / `cost` | preset `campaign-cost`, with the ads refresh button as a card action |
| `campaigns` / `returns` | preset `campaign-returns`: d0 and dN/d0 as bars side by side |
| `campaigns` / `hourOfDay` | a breakdown bar, `hourEt` × `campaignFlight`, arrival = tagged |
| `campaigns` / `flightDay` | a line, `flightDay` × `campaignFlight`, arrival = tagged, `cumulative` |
| `popup` rate table | preset `popup-rates` |
| `popup` / `eligible` | preset `signin-eligibility` (plus the eligibility rate) |

Registry and component additions (all generic):
- Windows `before` / `after` (the newest release whose first after-day is complete, release day excluded, sized as `releaseComparisonWindows` from
  one cached first-hit read the endpoint makes before planning) and `upsellPre` / `upsellPost`
  (a campaign's attribution window split at `UPSELL_SIGNEDOUT_FIX_AT`; a `boundaryInFlight` rule
  keeps them unmeasured while it is unset or outside the flight). `{ scope: 'window' }` binds an
  item to the window of the repeat or column it sits in.
- An optional `country` param on campaign-fact metrics (the fact now groups by a US / CA / other
  bucket); units `instant` and `code` (never a ratio side); displays `date`, `ago`, `status` and
  `bar` on a rate; `Gating.whenZero`; `Gating.whenNotStarted` (`'label'` keeps a not-yet-begun
  flight's item as "not started", even with no start date, where it would be omitted; `'zero'`
  shows a count that cannot have happened yet as 0): the funnel and country cards show an
  upcoming flight as the old panels did (Arrivals 0, every other step "not started"), while the
  scorecard keeps omitting a pending flight's steps.
- Nested scopes (a repeat keeps the instance it sits in), repeats over countries and over
  beacon-tracked campaigns only, a column repeat on `table` sections (`columns`, `columnLabel`,
  `rowsLabel`), a `columns` section layout, card `actions` and rendered card `captions`; a
  repeated instance with nothing visible is hidden, and the repeat's `empty` text shows when all
  are.
- The pop-up fact honours "hide my own visits" (the page context now carries it), as
  `/api/popups` did.
- A widget's `campaignIds` narrows a card whose top-level repeat is over campaigns (MetricCard
  `campaignIds`, `narrowToCampaigns`), as it narrowed the old campaign panels; the chart editor
  shows the Campaign(s) picker for such a card.

Retired: both bespoke bodies, `/api/campaigns`, `/api/overview`, `/api/popups`' `rates` and
`eligible` sections, `lib/campaignsData`, `lib/overviewData`, `functions/_lib/campaignInstrumentation`.
Parity: `slice7.parity.test.ts` and `slice7.upsell.test.ts` compare every panel's visible numbers
with the old body over its old endpoint on one `node:sqlite` fixture, each difference listed and
asserted; the old side was captured and checked live in commit `76caad5`, and is a golden since.
Measured cost: `docs/capacity.md` §8.
