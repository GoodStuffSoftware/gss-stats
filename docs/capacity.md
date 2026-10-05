# gss-stats capacity audit — 2026-09-26

> **Status (perf/d1-reads, 2026-09-26):** the two "clear waste" items this audit identifies
> — `/api/sites`'s unbounded full-table scan (§4.2) and the total+grouped query pair on every
> chart (§4.3) — have been fixed: see the "Capacity" section of [README.md](../README.md) and
> `functions/_lib/edgeCache.ts`, `functions/api/geo.ts`, `functions/api/sites.ts`. Everything
> below is the original read-only findings, kept as-is for the record.

Read-only. No plan, setting, schema or data was changed. All figures pulled live via
the Cloudflare REST API, the GraphQL Analytics API, and read-only `wrangler d1 execute`
`SELECT`/`EXPLAIN QUERY PLAN` statements against `gss-geo`. Non-Cloudflare figures
(Google Ads API, Firestore) are inferred from routine docs/ADRs checked into
`gss-stats` worktrees (not merged to `main`) — flagged as such below.

## 1. Account plan(s)

| Scope | Plan | Evidence |
|---|---|---|
| Workers/Pages (account) | **Free** — no Workers Paid subscription exists | `GET /accounts/:id/subscriptions` returns only a `teams_free` (Zero Trust) line item; no `workers.*` rate plan present |
| Zone `goodstuff.software` | **Free Website** | `GET /zones?name=goodstuff.software` → `plan.legacy_id: "free"` |
| Zero Trust / Access | Teams Free (50 users) | Same subscriptions call |
| Secrets Store | Beta, 1 store/account, 100 secrets/account | `default_secrets_store` exists with 4 secrets (Stripe keys, unrelated to gss-stats) |

Everything below is scoped to the **Workers Free** plan's limits unless noted.

## 2. Cloudflare resource usage vs. limits

### D1

Two databases exist, both bound in `wrangler.toml`/planned bindings:
- **gss-geo** (`fa0b2929-…`) — the beacon's shared store, created 2026-06-25, 2 tables (`hits`, `excluded_ips`).
- **gss-stats-ads** (`785327a3-…`) — created 2026-09-26 per `docs/adr/0001-ads-read-store.md` (on a feature branch, not yet in `main`, but the live D1 resource already exists and is being written to).

D1's **rows-read/rows-written caps are account-wide**, shared across every database.

| Metric | gss-geo (24h) | gss-stats-ads (24h) | Combined (24h) | Free limit | Headroom |
|---|---|---|---|---|---|
| Rows read | 1,458,916 | 1,722 | **1,460,638** | 5,000,000/day | **70.8%** |
| Rows written | 680 | 636 | **1,316** | 100,000/day | 98.7% |
| Read queries | 614 | 86 | 700 | 50/invocation (not aggregate) | n/a |
| Write queries | 170 | 27 | 197 | — | — |

| Metric | gss-geo (7d) | gss-stats-ads (7d, ~3h old) |
|---|---|---|
| Rows read | 4,439,975 | 1,938 |
| Rows written | 1,628 | 636 |
| Read queries | 1,907 | 88 |
| Write queries | 407 | 27 |

Storage (account-wide cap 5 GB total / 500 MB per DB, 10 DB max):

| DB | Size now | Size 7d ago | Δ/week | Days to 500 MB (per-DB) |
|---|---|---|---|---|
| gss-geo | 1,216,512 B (1.16 MB) | 1,118,208 B | +98,304 B (+8.8%) | ~102 years at current rate — **no storage risk** |
| gss-stats-ads | 139,264 B | n/a (created today) | one-time migration+backfill, not a daily rate | negligible |

Databases used: **2 / 10**. Total storage: **1.36 MB / 5 GB** (0.03%).

**`hits` row count: only 4,887 rows** (site created 2026-06-06; min `ts` ≈ 2026-06, max ≈ today). The table is tiny — the read-cap pressure is **100% a query-pattern problem, not a data-volume problem** (detail in §4).

### Workers / Pages Functions

Requests to Pages Functions bill against the same Workers Free **100,000 requests/day** account-wide pool (confirmed in Cloudflare docs: "Requests to your Pages Functions count towards your quota for the Workers Free plan").

| Script | Requests (24h) | Requests (7d) | Errors |
|---|---|---|---|
| gss-stats prod Function | 202 | 652 (8 days sampled) | 0 |
| gss-beacon prod Function | 197 | 921 (5 days sampled) | 0 |
| **Combined** | **399 / 100,000 (0.4%)** | — | 0 |

No standalone `workersInvocationsAdaptive` rows at all — the account's only standalone Worker is `goodstuffsoftware-mailer` (unrelated), with **0 cron triggers** registered. Free-plan account caps relevant to the **planned `gss-stats-sync` Worker** (hourly cron during flights + on-demand sync):

| Limit | Free cap | Current use | Planned addition |
|---|---|---|---|
| Cron triggers/account | 5 | 0 | +1 (hourly) — comfortable |
| Workers/account | 100 | 1 (mailer) | +1 — comfortable |
| CPU time/invocation | 10 ms | not directly measured (no errors observed; D1/GraphQL waits don't count as CPU) | a GAQL fetch + a couple of D1 upserts is unlikely to approach 10ms CPU, but not directly measured this session |
| Subrequests/invocation | 50 | n/a | an hourly sync doing OAuth refresh + a few GAQL calls + a few D1 writes stays well under 50 |

### KV (`STATS_CONFIG`)

Free cap: 100,000 reads/day, **1,000 writes/day**, 1,000 deletes/day, 1,000 list/day, 1 GB stored.

| | 24h | 7d total | Peak single day (7d) |
|---|---|---|---|
| Writes | 18 | 62 | 34 (2026-09-25) |
| Reads | 4 | 32 | 10 |
| Lists | 1 | 1 | 1 |

Peak observed write day (34) = **3.4% of the 1,000/day cap**. `App.vue`'s `scheduleSave()` (line 44) debounces every layout change (drag/resize/edit) to a single `PUT /api/config` 700 ms after the last change — so even an intense single-owner editing session collapses to a handful of writes; exhausting 1,000/day would need a save roughly every 86 seconds non-stop for 24h. **Low risk** for the current single-owner usage pattern; would need re-checking if a second collaborator is added or the debounce regresses. Only 2 keys stored (`dashboard:default`, `site-alias-map`), both tiny — no risk to the 1 GB cap.

### Pages

- **Builds/month cap: 500 (Free).** The deploy workflow uses `wrangler pages deploy dist` (a **direct upload** from a GitHub Actions build), not Cloudflare's own git-integrated build pipeline — so this project likely doesn't draw against the "Builds" quota the same way a Cloudflare-built project would. Either way, observed cadence is **6 deployments in the last 30 days** (1.2% of 500 even if it did count) — no risk.
- **Functions requests count toward the Workers request quota** — confirmed above (§ Workers/Pages Functions), already reported together.

### Secrets Store

Beta, 1 store per account (exists), 100 secrets/account cap. **4/100 secrets used**, all Stripe keys for an unrelated project — gss-stats doesn't use Secrets Store (its `CF_ANALYTICS_TOKEN` is a plain Pages secret, not a Secrets Store binding). No risk, no action needed.

### GraphQL Analytics API

- Rate limit (per-token, default tier): **300 queries / 5 minutes** (~1/sec sustained, or a 300-query burst). The dashboard has **no polling/auto-refresh** (grepped the codebase — no interval or timer fetches); every GraphQL call is user-triggered (load / filter change / drill) or the one return-to-tab refetch, which fires when a tab becomes visible or the window regains focus (one debounced page-level listener), and only for a card whose last load is 60 s or more old with none in flight (a request still running after 30 s counts as hung, so a half-open socket cannot block it), so one return costs at most one pass over the page's cards and a tab flipped back and forth inside a minute costs nothing. It never sends `fresh: true` and metric cards go out as the normal batched `POST /api/metrics`.

  **What a return costs, stated plainly.** The 90 s edge cache only answers a repeat within 90 s of the previous load of the same request, and the throttle already lets a refetch through from 60 s, so only a return 60–90 s after the last load can hit the cache; **every return more than 90 s after the last load is a miss** for a live range (a closed range has a longer TTL, see §7) and reads D1 and, for charts, GraphQL again. `/api/popups` and `/api/ads/readings` are not cached at all (`Cache-Control: no-store`), so they hit D1 on every return. The cost in D1 rows read, from this doc's own measurements: the Overview's metrics batch is **~10k rows when every fact misses** (§7, 9,994), a full page of charts adds its own §4-style reads on top (up to ~20k rows for a full pass, an estimate that grows with `hits`), and each return is a fresh pass. Worked example, one tab: **60 genuine returns a day x ~10k rows = ~600k rows = 12% of the 5M/day free budget** for the Overview metrics alone, up to **~1.2M rows = 24%** with a full chart page, on top of the 29% already used (§5) — and the cap is shared with gss-stats-ads and fails hard, not softly. The cost is bounded by one pass per tab per minute and by people actually leaving and returning, never by a timer. If it ever needs tightening, `RETURN_MIN_AGE_MS` (src/composables/useReturnRefresh.ts) is the one knob: raising it makes returns refetch less often. A full 41-widget default dashboard load fires at most ~20 RUM chart queries in a few seconds — well inside the 300/5min budget even with several tabs open at once.
- Data retention/window for **this account's** `rumPageloadEventsAdaptiveGroups` node (queried directly via the GraphQL `settings` introspection, not assumed):
  - `notOlderThan`: 15,897,600 s = **~184 days (~6 months)** of RUM history available.
  - `maxDuration`: 8,035,200 s = **~93 days** max span per single query.
  - `maxPageSize`: 10,000; `maxNumberOfFields`: 30 (the dashboard caps itself to 4 dims — far under).
- Same introspection for `d1AnalyticsAdaptiveGroups` / `d1StorageAdaptiveGroups` / `kvOperationsAdaptiveGroups` / `pagesFunctionsInvocationsAdaptiveGroups`: `notOlderThan` = 7,776,000 s (90 days), `maxDuration` = 2,764,800 s (32 days) — plenty for this audit's 24h/7d windows and for any future trend dashboard.

No GraphQL Analytics API risk identified.

## 3. Non-Cloudflare dependencies

These aren't verifiable from the gss-stats Cloudflare account; figures come from `docs/adr/0001-ads-read-store.md` and `docs/routines/bsk-retest-morning-read.md` (present only on `feat/ads-read-routines` / other worktree branches, not `main`).

- **Google Ads API developer-token/project access level.** As of the Sept 9, 2026 sunset, quota attaches to the **Google Cloud project**, not a developer token. Current tiers: **Explorer 2,880 ops/day**, **Basic 15,000 ops/day**, Standard higher. Which tier this project holds isn't visible from this session (Google Cloud Console access, not Cloudflare) — **flag for owner to confirm**. Estimated usage: the morning-read + backstop routine does a handful of GAQL `SELECT`s (campaign status, daily metrics, optionally placement view) at most twice a day per active campaign; the **planned** `gss-stats-sync` hourly cron during flights adds ~24 more small read bursts/day. Realistic combined load is on the order of a few hundred operations/day — **under 10% even of the lowest (Explorer) tier**. Low risk regardless of tier, pending owner confirmation of which tier is active.
- **Firestore (best-sudoku project) free tier.** Spark plan: 50,000 reads/day, 20,000 writes/day, 1 GiB stored. Used only for a COUNT aggregation at the **$100 threshold read** (an infrequent, not-daily event per campaign/flight), per the routine doc. Negligible against the daily cap — **low risk**, but unverified beyond what the routine doc states (best-sudoku isn't checked out in this session).
- **GitHub Actions minutes.** Both `GoodStuffSoftware/gss-stats` and `GoodStuffSoftware/gss-beacon` are **public repositories** (confirmed via `gh api`) — Actions minutes are unlimited/free on public repos. **Not a constraint.** The ads-read routines themselves run locally on the owner's Windows machine via scheduled tasks, not GitHub Actions, so they don't draw from any Actions minutes budget either.

## 4. Every query against `gss-geo.hits`, WHERE columns, and measured cost

Schema (`hits`): `id, ts, site, path, referrer, country, region, city, postal, continent, timezone, lat, lon, colo, org, device, browser, os, lang, screenw, visitor, refpath, source, medium, campaign`.

Existing indexes (read-only `SELECT name, sql FROM sqlite_master WHERE type='index'`):
```
idx_hits_ts       ON hits (ts)
idx_hits_site_ts  ON hits (site, ts)
sqlite_autoindex_excluded_ips_1   (unrelated table)
```

All `hits` SQL lives in **`functions/api/geo.ts`** and **`functions/api/sites.ts`** (nothing in `src/lib/*.ts` builds SQL — those files only shape the request body sent to these two endpoints).

| # | Endpoint / mode | WHERE columns | GROUP BY | Measured `rows_read` | EXPLAIN QUERY PLAN |
|---|---|---|---|---|---|
| 1 | `geo.ts` single-dim breakdown, **no site filter**, 7d range | `ts` (range) | 1 dim (e.g. `region`) | **873** (of 4,887 total) | `SEARCH hits USING INDEX idx_hits_ts (ts>? AND ts<?)`; `TEMP B-TREE` for GROUP BY + ORDER BY |
| 2 | `geo.ts` single-dim breakdown, **with site filter**, 7d range | `ts` (range) + `site IN (...)` | 1 dim | **198** | `SEARCH hits USING INDEX idx_hits_site_ts (site=? AND ts>? AND ts<?)` |
| 3 | `geo.ts` map/points mode, 7d, no site | `ts` (range) + `lat<>''` | `lat, lon` | **907** | same `idx_hits_ts` search pattern + TEMP B-TREE |
| 4 | `geo.ts` nested doughnut, 3-ring (`country`,`region`,`device`), 7d, no site | `ts` (range) + 3× `<>''` | 3 dims | **882** | same `idx_hits_ts` search + TEMP B-TREE (ring count doesn't change the scan, only the grouping cost) |
| 5 | **`sites.ts`** site-tag counts — runs on every `/api/sites` load | `site<>''` — **no `ts` filter at all** | `site` | **4,887 (100% of the table, every call)** | `SCAN hits USING COVERING INDEX idx_hits_site_ts` — a full covering-index scan because there's no date predicate to narrow it |

Every drill-down constraint (`constraints: [{field, value}]`), the "hide my own visits" exclusion (`browser`/`os`, case-insensitive `LOWER()` — never indexed, never will be usefully), and the self-referral exclusion (`referrer`) add to the `WHERE` clause but don't change which index SQLite picks — the planner already uses `idx_hits_ts` or `idx_hits_site_ts` for the `ts`/`site` predicate in every case observed. Additionally, **every** chart panel fires a second, near-identical query for the grand total (`SELECT COUNT(*) FROM hits WHERE <same WHERE, no GROUP BY>`) — so a chart panel's real cost is roughly **2× the numbers above**.

### Why gss-geo is at 29% of the daily read cap despite a 4,887-row table

Rows-read scales with **(queries per dashboard load) × (rows touched per query)**, not with data volume. A single load of the default dashboard (41 widgets across 3 pages, roughly half geo-backed) can issue on the order of 20–40 D1 queries; `/api/sites` alone burns a full 4,887-row scan on **every** load regardless of date range. That reconciles with the known baseline (~1.08M rows/24h across 286 queries) and today's measured 1,458,916 rows/614 read queries (~2,376 rows/query average) — consistent with mostly-unfiltered or lightly-filtered scans of a small table, repeated often.

### Proposed index set — **not created**

Given the measurements above, the honest minimal-index answer is nuanced:

1. **No new index meaningfully reduces `rows_read` for the breakdown/nested queries.** SQLite/D1 already picks the best of the two existing indexes for every `ts`/`site` predicate observed (queries 1–4). `GROUP BY` over the matched rows requires a temp B-tree regardless of any index on the group-by column itself (no covering index exists that also removes the aggregation step), so adding e.g. an index on `region` or `device` would not appear in any `EXPLAIN QUERY PLAN` here and would only add write cost (each index adds a written row per insert, i.e. multiplies `rows_written` for gss-beacon's own ingestion — currently small, but not worth paying for zero read benefit).
2. **Query #5 (`/api/sites`) is the one clear waste** — a full-table scan on every dashboard load with no date filter — but no index fixes it (it's already scanning the narrowest available covering index; SQLite must touch every row to enumerate distinct `site` values). The fix here is a **code-level cache**, not a schema change: the same 24h-TTL KV cache pattern `sites.ts` already uses for the alias map (`getAliasMap`) should wrap this per-site count aggregate too. That alone removes one guaranteed full-table read per load.
3. **Combine the "total" + "grouped" query pair** into one `SELECT ... COUNT(*) OVER() AS total, COUNT(*) AS c FROM hits WHERE ... GROUP BY ...` statement — halves `rows_read` for every chart panel with no index changes.
4. **If/when `hits` grows past the low tens of thousands of rows**, revisit with a small daily-rollup/summary table maintained by the beacon writer (pre-aggregated counts by day×dimension) — that's the durable structural fix for "many small-but-frequent full-ish scans," not a single index. Not needed yet at 4,887 rows.

No `CREATE INDEX`, `ALTER`, or write statement was run — every command above was a read-only `SELECT` or `EXPLAIN QUERY PLAN`.

## 5. Risk table

| Resource | Limit | Current usage | Headroom | Trend | Risk | Recommended fix |
|---|---|---|---|---|---|---|
| **D1 rows read (account, all DBs)** | 5,000,000/day | 1,460,638 (24h) | **29.2% used / 70.8% headroom** | 7d total 4.44M read (gss-geo alone); today's 24h figure (1.46M) is ~2.3× the 7-day daily average and ~35% above the ADR's same-day earlier reading (1.08M) — bursty, session-driven, and will scale up as `hits` itself grows (+8.8%/week in size) | **HIGH — flagged: >50% swing risk within a single active day; hard failure (not throttling) since 2026-09-01** | Cache `/api/sites`'s full scan (§4.2); merge total+grouped queries (§4.3); add response caching per query signature; revisit with a rollup table as `hits` grows |
| D1 rows written (account) | 100,000/day | 1,316 (24h) | 98.7% headroom | Flat, low | Low | None needed |
| D1 storage (per-DB / total) | 500 MB / 5 GB | 1.36 MB combined | >99.9% headroom | +8.8%/week on gss-geo ≈ 102 years to 500 MB | None | None needed |
| D1 databases | 10 | 2 | 80% headroom | +1 planned (none — gss-stats-ads already created) | None | None needed |
| Workers/Pages requests (account) | 100,000/day | ~399/day | 99.6% headroom | Flat | None | None needed |
| Cron triggers (account) | 5 | 0 (1 planned) | 80%+ headroom | — | None | None needed |
| KV writes (STATS_CONFIG) | 1,000/day | 34 peak day | 96.6% headroom | Flat, debounced | Low | Re-check if a second collaborator/session is added |
| KV reads/lists/stored data | 100,000/day, 1,000/day, 1 GB | 10, 1, ~tens of KB | >99% headroom | Flat | None | None needed |
| Pages builds/month | 500 | 6/30d (likely doesn't even count — direct upload) | >98% headroom | Flat | None | None needed |
| Secrets Store | 100/account | 4 (unrelated project) | 96% headroom | Flat | None | None needed |
| GraphQL Analytics API rate limit | 300 queries/5min | ~20/load; no polling, plus one throttled refetch per tab return (at most once a minute per tab) | High headroom | Flat (no auto-refresh; return refetch bounded by the 60 s throttle) | None | None needed |
| RUM data retention (this account) | ~184 days history, ~93-day query window | n/a | — | — | None | None needed |
| Google Ads API ops/day (inferred) | 2,880–15,000/day depending on tier | Est. low hundreds/day incl. planned hourly sync | High headroom either tier | Rising with planned sync | Low | Confirm actual Google Cloud project access tier (not visible from here) |
| Firestore reads/day (inferred) | 50,000/day | Infrequent ($100-threshold only) | High headroom | Flat | Low | None needed |
| GitHub Actions minutes | Unlimited (public repos) | n/a | n/a | n/a | None | None needed |

**Bottom line:** every Cloudflare resource has comfortable headroom **except D1 rows-read**, which sits at 29% of the account-wide 5M/day free cap today and is driven entirely by query pattern (a full-table scan on every `/api/sites` call, plus a "total + grouped" query pair per chart, against a 41-widget default dashboard) rather than by data volume. That pattern will keep costing more per query as `hits` grows, and D1 now hard-fails (not throttles) once the daily cap is hit — the two counter-measures in §4 (cache the sites-scan, merge total+grouped queries) are the highest-leverage, lowest-risk fixes and require no plan upgrade.

## 6. New dimensions (feat/all-beacon-fields, 2026-09-26) — no regression

"All beacon data on demand" adds `screenw` (real column), `screenwBucket` and `pathFamily`
(both derived via a `CASE` expression in `functions/api/geo.ts`) as groupable AND filterable
dimensions, plus a per-chart "include event beacons" opt-in that can drop the standing
`popupExcludeClause` path-prefix filter. All four measured read-only against production
`gss-geo` (7-day window, same `SUM(c) OVER ()` merged-query shape §4 already uses), with
`EXPLAIN QUERY PLAN` confirming the index choice:

| # | Query | WHERE columns | `rows_read` | Index used |
|---|---|---|---|---|
| 1 | Breakdown by `screenwBucket`, no site, event paths excluded (default) | `ts` (range) + 8 popup-prefix exclusions | **719** | `SEARCH hits USING INDEX idx_hits_ts (ts>? AND ts<?)` |
| 2 | Breakdown by `pathFamily`, no site, **`includeEventBeacons: true`** (no path-prefix filter at all) | `ts` (range) only | **770** | `idx_hits_ts` |
| 3 | Breakdown by `device`, filtered by the new `pathFamily = 'install'` derived-expression constraint (`(CASE …) = ?`), plus the standing exclusion | `ts` (range) + prefix exclusions + one derived-CASE equality | **382** | `idx_hits_ts` |
| 4 | Breakdown by `screenw` (raw), site-scoped (`site = 'bestsudoku-web'`) | `site` + `ts` (range) + prefix exclusions | **605** | `SEARCH hits USING INDEX idx_hits_site_ts (site=? AND ts>? AND ts<?)` |

All four land in the same range as §4's pre-existing single-dim breakdown queries (198–907
`rows_read`) — **no full-table scan, no new index needed**. `idx_hits_ts`/`idx_hits_site_ts`
are still the plan SQLite picks for every one of them: a `CASE` expression in the SELECT list
or the WHERE clause (query 3's derived-dimension filter) isn't something SQLite can push into
an index lookup, but it doesn't defeat the `ts`/`site` range-scan that already runs first — the
same "TEMP B-TREE for GROUP BY" cost every existing breakdown query already pays, not a new
one. Query 2 (events included) reads slightly MORE rows than query 1 (770 vs. 719) simply
because it scans a few dozen more matching rows once the 8-prefix exclusion is lifted — not a
different plan. No `CREATE INDEX` or write statement was run for this section either.

## 7. `POST /api/metrics` (ADR 0003 slice 3, 2026-09-26) — rows read and CPU

The batched metrics endpoint (`functions/api/metrics.ts`) runs a small set of fixed aggregate
"facts" (`src/lib/metrics/facts.ts`), each once per batch and each cached on its own in the Cache
API. Measured read-only against production with `npm run metrics:capture -- --cf-token-file <path>
--legacy-scorecard` (`scripts/metrics/capture-facts.ts`: it plans the batch exactly as the endpoint
does and runs each planned fact's `SELECT` through `wrangler d1 execute --remote --json --command`;
never `--file`, never a write), as of 2026-09-27T03:46Z (23:46 ET on 2026-09-26).

**The batch:** a representative Overview page — the `campaign-scorecard` preset over all three
campaigns plus the `bsk-kpis` tiles (`scripts/metrics/overviewBatch.ts`): 47 requests, planned into
6 distinct facts. The planner reads nothing a campaign's config already rules out: the spend-only
Play-direct campaign plans no beacon fact, and the Android launch's return rate needs no
`campaignReturns` read (its flight ended before the return beacon existed).

| Fact | Params | Rows returned | `rows_read` | Cached for |
|---|---|---|---|---|
| `campaignPathVisitor` | Android launch (closed) | 8 | 3,354 | 15 min |
| `flightPathsSeen` | Android launch (closed) | 10 | 2,621 | 24 h (window closed) |
| `adsSpend` (gss-stats-ads) | — | 3 | 20 | 5 min |
| `campaignPathVisitor` | US+CA retest (active) | 10 | 327 | 90 s |
| `campaignReturns` | US+CA retest (active) | 1 | 2,952 | 90 s |
| `bskKpiDays` | today (ET) | 55 | 720 | 90 s |
| **Total, every fact a cache miss** | | 87 | **9,994** | |

The KPI fact returns one row per ET day window, time segment, path, visitor kind and campaign tag
(55 rows) rather than one per minute (it returned 247 per-minute rows before review finding #8), so
its size no longer grows with traffic; its `WHERE` is unchanged, so `rows_read` is too.

For comparison, `/api/overview`'s scorecard runs its two per-campaign statements for **every**
campaign on **every** load, uncached. They have exactly these facts' `WHERE` clauses, so the same
`rows_read`: 3,354 + 2,919 (Android launch), 919 + 2,919 (Play-direct), 327 + 2,952 (retest) =
**13,390**, plus the KPI query (720) and the spend read (20) — about **14,130 rows per load** for the
sections the metrics batch covers, against **9,994 for a fully uncached batch and 0 for a cached
one** (a cache entry is per colo). The timeline, first-hit and release-panel queries are not part of
the batch; they stay on `/api/overview` until later slices.

Two reads dominate and are candidates for later work: `campaignReturns` (now bounded below by the
campaign's attribution start with no upper bound, so it no longer counts pre-launch QA return
beacons, though the `site`-only index may still not use `ts`) and a closed campaign's
`campaignPathVisitor`, which scans every row since its flight start (there is no index on
`campaign`).

### CPU

Workers Free allows 10 ms of CPU per request. Two harnesses, both running the real handler end to
end in Node (the same V8 as workerd) against a fake D1 that answers each statement from rows
re-parsed from JSON on every call, with a fresh in-memory cache (every fact a miss) unless noted:

- `npm run metrics:profile -- --seed <captured.json>` (`scripts/metrics/profile-metrics.ts`, the
  `scripts/ads-reads/profile-worker.ts` approach): the Overview batch over the fact rows captured
  above;
- the review harness (finding #8): the synthetic test fixture plus 4,500 extra minute groups over the
  KPI's 8 days, with three batches — Overview + Campaigns (137 requests), Overview + Campaigns +
  Pop-ups (163 requests over a page range), and 200 requests naming 5 KPI metrics.

| Batch | First call before → after | Warm (cache miss) before → after |
|---|---|---|
| Overview, production rows (47 requests) | 8.6–9.6 → 4.2–4.4 ms | 1.44–1.48 → 0.86–0.91 ms |
| Overview, fixture (47 requests) | 6.6 → 3.3–3.5 ms | 1.96 → 1.38–1.42 ms |
| Overview + Campaigns (137) | 14.2 → 4.2–4.6 ms | 6.40 → 1.94–2.13 ms |
| Overview + Campaigns + Pop-ups (163) | 21.6 → 5.4–6.1 ms | 8.89 → 2.30–2.56 ms |
| 200 requests, 5 KPI metrics | 23.8 → 2.7–2.8 ms | 15.7 → 1.27–1.34 ms |

With every fact cached, the production-rows Overview batch takes 0.70 ms warm. The first-call figures
in the Node harness include Node's own `Request`/`Response`/`Headers` implementation (undici, loaded
and compiled on first use) and the in-memory cache stand-in, both native in workerd: a batch with no
fact at all takes 0.86 ms on its first call, and a batch with one fact 1.86 ms.

What changed (review finding #8):

- **Facts are aggregated by SQL, not per row in JS.** Timed facts group by a time *segment* (the
  bucket's position against the few instants any metric filters on: go-lives, attribution starts,
  the install fix) and the KPI fact by ET *day window*, so a fact's size is bounded by paths ×
  visitor kinds × campaign tags × segments (× 8 days), however much traffic or range there is.
- **Each fact is indexed once per batch**, each distinct path is classified once per metric, each
  distinct request side is resolved once (shared by planning and derivation), and identical
  requests share one result.
- **ET date maths is plain arithmetic** (`src/lib/etTime.ts`, checked against `Intl` in its tests)
  instead of an `Intl` format per call, and is done once per batch or memoized.
- **The request path is compiled at isolate start-up**, not on the first request:
  `src/lib/metrics/prewarm.ts` runs the whole derivation once over synthetic facts at module scope,
  and the config-fixed facts' cache keys are hashed then too. That costs about 10 ms of start-up CPU
  per isolate (Node estimate), against Workers' separate 1-second start-up limit.

## 8. The Campaigns page as cards and charts (ADR 0003 slice 7, 2026-09-27) — rows read and CPU

Since layout version 11 the Campaigns page has no bespoke panel: its funnel, country, cost and
return-visits panels are metric cards (one `POST /api/metrics` batch for all four) and its two
arrivals panels are standard `/api/geo` charts. `/api/campaigns` is retired. Measured read-only
against production with `npx tsx scripts/metrics/capture-facts.ts --cf-token-file <path> --batch
campaigns` (the batch is built by `scripts/metrics/presetBatch.ts` with the same scope and request
code `MetricCard` runs; each `SELECT` runs through `wrangler d1 execute --remote --json --command`,
never `--file`, never a write), at 2026-09-27T14:00Z — re-measured for v0.12.1. The previous
2026-09-27T12:22Z capture (commit 2c8003e) labeled its two `/api/geo` chart rows "since the first
campaign" but was actually taken before that range replaced the old rolling-12-month default
(d147fe1, ~55 minutes later) and was never rerun after — its 5,415 / 5,361 figures were still the
year-wide scan, not the ~25-day one the label described. This capture is the first against the
range the charts actually use.

**The batch:** 112 distinct requests (the four presets over the three campaigns, the country cells
split US / CA / Other), planned into 7 facts. Nothing is read for what a campaign's config rules
out (the spend-only Play-direct campaign plans no beacon fact; the Android launch plans no return
read, its flight predating the return beacon).

| Read | Params | Rows returned | `rows_read` | Cached for |
|---|---|---|---|---|
| `campaignPathVisitor` (now split by country bucket) | Android launch (closed) | 15 | 3,363 | 15 min |
| `flightPathsSeen` | Android launch (closed) | 10 | 2,621 | 24 h |
| `campaignPathVisitor` | US+CA retest (active) | 22 | 336 | 90 s |
| `campaignReturns` | US+CA retest (active) | 1 | 2,955 | 90 s |
| `adsSpend` (gss-stats-ads) | — | 3 | 20 | 5 min |
| `adsCoverage` (gss-stats-ads) | — | 20 | 20 | 5 min |
| `adsLastSync` (gss-stats-ads) | — | 3 | 61 | 60 s |
| **Metrics batch, every fact a miss** | | 74 | **9,376** | |
| `/api/geo` hour of day (`hourEt` × `campaignFlight`, arrival = tagged, since the first campaign) | | 25 | 2,623 | `/api/geo` cache |
| `/api/geo` flight day (`flightDay` × `campaignFlight`, same filter, until last campaign ends — new-chart default, below) | | 9 | 2,569 | `/api/geo` cache |
| **Page total, nothing cached** | | | **14,568** | |

For comparison, the retired `/api/campaigns` ran, for **every** campaign on **every** load and
uncached, its attribution scan, its flight-window check and its return scan (the same `WHERE`
clauses as `campaignPathVisitor`, `flightPathsSeen` and `campaignReturns`): 3,363 + 2,621 + 2,922
(Android launch), 928 + 465 + 2,922 (Play-direct), 336 + 411 + 2,955 (retest) = **16,923**, plus
three ads-store reads per campaign (about 300): about **17,200 rows per load**, essentially
unchanged from the last capture (the ads-store and per-campaign figures barely moved). The card
batch reads 9,376 once and then serves every card, page and colo visit from its fact cache (15
minutes to 24 hours for the closed flight); the two arrivals charts scan `hits` by `ts` from the
first campaign's start (they cannot use an index on `campaign`, as the old attribution scan could
not either), so a page with nothing cached now reads about **2,650 fewer** rows than the old
`/api/campaigns` page did — the opposite of what the stale 20,145 figure implied — and a cached
page reads none for the cards. `campaignReturns` is now bounded below by the campaign's attribution
start (§7) with no upper bound.

**A newly added flight-day chart's range closes once every flight is over (v0.12.1,
lib/range.ts):** the hour-of-day chart's window keeps growing forever (`since first campaign`,
until = now — every load rescans a few more hours, so its `rows_read` rises slowly over time and
its `/api/geo` cache key changes on every load). The `flightDayWidget` factory instead defaults a
newly built flight-day chart to `since first campaign until last campaign ends` — until = now too,
while the retest (the last-configured flight, through 2026-10-02) is still open, so the two charts
read almost the same 2,623 / 2,569 rows above (this capture calls the factory directly, so it
measures that new default). Once the retest ends, that chart's `until` freezes at ET midnight of
2026-10-03 instead of continuing to track "now": its scanned window (and so its `rows_read` and
its `/api/geo` cache key) stops changing from that day forward, while the hour-of-day chart's
keeps growing and re-scanning on every load indefinitely.

This is a new-chart default only — there is no v12 migration, so a flight-day chart already saved
in a production layout (CONFIG_VERSION 11, which production is on) keeps whatever `rangeRel` it
was saved with, `since first campaign`, and its range will keep tracking "now" forever like the
hour-of-day chart's, exactly as it does today. It opts into the closed range only if someone types
`since first campaign until last campaign ends` into that chart's own date range field (lib/range.ts
`SINCE_FIRST_UNTIL_LAST_CAMPAIGN`), or the panel is deleted and re-added from the chart picker.

The release panel (Overview) reads the first Best Sudoku hit (6 rows, an indexed `MIN`, cached
6 hours) and both windows in ONE statement (394 rows for the 2026-09-26 release, one day each
side), where `/api/overview` read the first hit and each window separately (6 + 24 + 376 = 406).
The Pop-ups page's rate table and eligibility card share one `popupRangePath` fact, where
`/api/popups` answered each with its own scan.

### CPU

`npx tsx scripts/metrics/profile-metrics.ts --batch campaigns [--seed <captured.json>]` (§7's
harness: the real handler end to end in Node against a fake D1, a fresh cache per call):

| Batch | First call (cold) | Warm, every fact a miss | Warm, every fact cached |
|---|---|---|---|
| Campaigns page, production rows (112 requests, 7 facts, 74 fact rows) | 4.97–5.29 ms | 1.84 ms mean (max 3.15) | 1.47–1.55 ms mean |
| Campaigns page, fixture rows | 4.11–4.38 ms | 1.81–1.93 ms mean | 1.40 ms mean |

Every figure is under the 10 ms per-request limit with room to spare. The request path for the new
windows, facts and store metrics is compiled at isolate start-up too (`prewarm.ts` now warms a
release window, the country split and the ads-store facts).

## 9. Daily series for sparklines (ADR 0005 slice 2, 2026-10-03) — rows read

A card item shown as a sparkline asks for `series: 'daily'`. The engine then plans ONE extra
statement per distinct twin read: the metric's daily twin (`campaignDaily`, `bskRangeDaily`,
`popupRangeDaily`, `adsSpendDaily`), the same WHERE as the scalar fact, with `GROUP BY` the ET
date added. Method (as in §8): `EXPLAIN QUERY PLAN` on a fixture holding the two production
`hits` indexes (`idx_hits_ts`, `idx_hits_site_ts`), pinned as an exact-plan test per twin in
`src/lib/metrics/series.test.ts`.

| Twin | Plan | Rows read vs the scalar fact |
|---|---|---|
| `campaignDaily` | `SEARCH hits USING INDEX idx_hits_ts (ts>?)` + `USE TEMP B-TREE FOR GROUP BY` | the scalar's rows: the campaign WHERE has no site filter and no upper bound, so it reads every site's rows since the flight start |
| `bskRangeDaily` | `SEARCH hits USING INDEX idx_hits_site_ts (site=? AND ts>? AND ts<?)` + `USE TEMP B-TREE FOR GROUP BY` | same range, same rows |
| `popupRangeDaily` | with `sites`: `idx_hits_site_ts (site=? AND ts>? AND ts<?)`; without: `idx_hits_ts (ts>? AND ts<?)`; both + `USE TEMP B-TREE FOR GROUP BY` | same range, same rows |
| `adsSpendDaily` | a full read of the ads store's `ads_daily_metrics` (`ORDER BY campaign_id, date`) | every stored day of every campaign (tens of rows today, about 365 per campaign per year); the one campaign and the latest 92 days are picked in JS |

No full-table scan of `hits` and no new index. Counting what a card adds:

- **Extra statements per card** = the number of distinct twin reads among its sparkline items.
  `campaignDaily`: one per distinct `campaignId`. `bskRangeDaily`: one per distinct (since,
  until). `popupRangeDaily`: one per distinct (since, until, sites, ownBrowser, ownOS).
  `adsSpendDaily`: exactly one however many campaigns (it has no key parameters). Items that
  share a read share one statement. Each counts against `MAX_STATEMENTS = 40` in `planBatch`.
- **Rows read per extra statement** = the rows its scalar twin reads (§7 measured 327 rows for the
  live US+CA retest and 3,354 for the closed Android launch, 2026-09-27). For a live campaign the
  window has no upper bound, so it grows with traffic.
- **Miss rate.** A closed campaign's `campaignDaily` is cached 15 min (about 96 misses a day), a
  closed `range` twin 24 h, a live one 90 s. Worst case, a page held open continuously on one
  sparkline: a live campaign 960 misses/day x 327 rows is about 0.31M rows/day; a closed one 96
  misses/day x 3,354 rows is about 0.32M rows/day; each is roughly 6% of the 5M/day account cap.
  A normal visit pattern is far below that.
- **Not prewarmed.** `prewarm.ts` warms no twin: a series is asked for only by an item the owner
  chose to draw as a sparkline, so the first read after expiry pays one more statement inside the
  batch, and an ordinary page (no sparkline) is unchanged.

## 10. Live push (`gss-live`, 0.29.0, 2026-10-05) — D1 rows read and Durable Object load

A new Worker, `gss-live` (README → Live updates), tells open dashboard tabs "something changed" at
each 15-minute ET boundary. It reads no D1 and writes no D1. What it adds is the refetches the
tabs then make, and a small Durable Object load. Figures are from the design note (2026-10-04) and
are estimates, not measurements; nothing here was re-read against the account.

**D1 rows read.** A ping refetch re-reads what the page's load reads: about 10k rows for an
Overview batch (§7) and about 20k for a full chart page. Only `liveSafe` cards refetch.

| Case (a tab visible all day, a non-refused row in every window) | Rows/day | Share of the 5M cap |
|---|---|---|
| Overview, uncapped: 96 x ~10k | ~960k | 19 % |
| Full chart page, uncapped: 96 x ~20k | ~1.92M | 38 % |
| Full chart page with the shipped caps (input within 2 h; a chart at most hourly), about 8 h of use | ~400k | 8 % |

All of it sits on the ~29 % baseline (§2) and adds up across tabs and colos: two all-day uncapped
chart tabs plus the baseline would reach the cap, which is why the idle cutoff and the hourly
per-chart cap ship. The edge cache (90 s while live) and the 60 s return throttle still apply.
`/api/stats` (RUM) and `/api/completions` never refetch on a ping. On Workers Paid none of this matters
(25B rows/month included).

**Durable Object and Worker requests (Workers Free: 100k Durable Object requests/day).** One
`notify` per written non-refused beacon (hundreds to about 2,000 a day during a flight; none
when no tab is connected, and a request that sets no new alarm still counts as one request), at most 96
alarms a day, plus one request per tab connect and reconnect (backoff 1 s doubling to 5 min). The
50 s keepalive is answered by the runtime (`setWebSocketAutoResponse`) without waking the object, and
hibernation bills about zero duration (13,000 GB-s/day allowed); outgoing messages are free. The
object is capped at 100 sockets. Expected load is a few percent of the daily allowance, and $0.
