# ADR 0001: The ads-read store is gss-stats' own D1 database, `gss-stats-ads`

- **Status:** Accepted, 2026-09-26. Owner-approved (Mike, via the coordinating session).
- **Context owner:** gss-stats. The store is written by `scripts/ads-reads/` (the scheduled
  ads-read routines) and read by the dashboard's Pages Functions.

## Context

The Best Sudoku ads routines (`docs/routines/`) replace two retired local scheduled tasks.
They need somewhere durable for:

1. **Daily Google Ads spend per campaign** (cost, impressions, clicks per ET day), fetched
   from the Google Ads API, so `/api/campaigns` stops depending on hand-entered
   `CAMPAIGN_SPEND` figures.
2. **An append-only readings log** (each morning line, each threshold read, each post-flight
   read, with rule results, the proposal and key counts).
3. **Threshold state**, so each $25/$50/$75/$100 read fires exactly once per campaign.
4. Optionally, **placement-level daily cost** (for the placement-leak kill rule and audit).

The data must live in gss-stats' own store, not in best-sudoku and not in the beacon's
`gss-geo` tables (gss-geo belongs to gss-beacon; gss-stats only reads it).

## Options considered

| Option | For | Against |
|---|---|---|
| **A. The existing `STATS_CONFIG` KV namespace**, keys under `ads:` | Already bound; nothing to create | Read-modify-write for an append log; no uniqueness, so fire-once rests on a single writer; eventual consistency; no SQL for totals; shares a namespace with the dashboard config |
| **B. New tables in `gss-geo`** | Already bound | Ruled out: gss-geo is the beacon's database |
| **C. A new D1 database `gss-stats-ads`** (chosen) | Constraints enforce the rules (fire-once primary key, append-only triggers, CHECKs, foreign keys); SQL totals for the dashboard; upsert-idempotent writes; fully isolated from gss-geo | One resource to create and one migration to apply (both done, below) |

The first draft of this work chose A because it needed no resource creation before the first
morning read. The owner approved creating a dedicated database instead, which removes every
"against" in row A.

## Decision

**C.** A dedicated D1 database, `gss-stats-ads` (id `785327a3-683c-4f85-819d-abe11efcacc9`,
region ENAM), bound to the Pages project as `gss_stats_ads` in `wrangler.toml`. Schema lives
in `migrations/gss-stats-ads/`; every SQL statement that touches it is built in
`src/lib/adsStore.ts`, shared by the routine and the dashboard.

### Schema (migration `0001_init.sql`)

General across every campaign (past, current, future; web or Play-direct; measurable or
spend-only). Money is integer micros; dates are ET calendar dates (the Ads account time zone).

| Table | Key | Purpose |
|---|---|---|
| `ads_campaigns` | `id` | Synced (upserted) from `src/lib/campaigns.ts` `CAMPAIGNS` on every run. That file stays the source of truth; the table exists so stored rows can reference a campaign. Holds name, uc values (JSON array), kind (`web` / `play-direct`), flight start/end, start-time cutoff, status, daily budget, hard cap, measurement mode. |
| `ads_daily_metrics` | `(campaign_id, date)` | Cost, impressions, clicks, source, fetched_at. Upsert-idempotent: a re-read overwrites the day, since Google back-fills for about two days. |
| `ads_placement_daily` | `(campaign_id, date, placement)` | Optional placement-level daily cost (`group_placement_view`), tagged approved or not against the campaign's list. |
| `ads_readings` | `id`, unique `reading_key` | The log. **Append-only by trigger** (UPDATE and DELETE abort). Each row carries the read time, cumulative spend, thresholds, rule results (JSON), proposal, decision (JSON), key counts (JSON), notes and `routine_version`. |
| `ads_threshold_state` | `(campaign_id, threshold_usd)` | One row per fired threshold, written only for a **complete** threshold read and pointing at its reading. The primary key makes a second firing impossible. Rows are immutable (triggers). |

CHECK constraints guard formats, non-negative money and counts, enum values and JSON validity.
Foreign keys (enforced by D1) tie every row to `ads_campaigns`.

Migration `0002_no_replace.sql` (review L4) adds BEFORE INSERT triggers that turn an insert
whose key already exists into a silent no-op on `ads_readings` and `ads_threshold_state`, so an
`INSERT OR REPLACE` can no longer rewrite a stored reading or a fired threshold (REPLACE deletes
the old row without firing the append-only DELETE triggers). Ordinary writes are unchanged:
they already use `ON CONFLICT … DO NOTHING`.

Migration `0003_sync_and_dedup.sql` (2026-09-26, owner requirement: "check if it has the most
recent data and if it doesn't, poll for the data… they should both be using the same
routine… make sure we're not duplicating data"):

| Change | Why |
|---|---|
| `ads_daily_metrics.placements_fetched_at` (nullable) | Placement rows only exist on days with placement spend, so a day's metrics row records when its placement pull succeeded; the sync re-pulls days where it is missing. |
| `ads_readings.entry_kind` (nullable) + `UNIQUE (campaign_id, et_date, entry_kind)` + a BEFORE INSERT no-replace trigger on that key | One reading per campaign, ET day and entry (`morning`, `backstop`, `threshold-50`, `postflight-wrapup`, with `+incomplete` / `+pause` / `+alert-<pair>` qualifiers). A same-day rerun is stored only when its entry kind differs, i.e. it carries new information. Rows from before 0003 are NULL (NULLs never collide) and get the same key derived in code. |
| `ads_sync_runs` (append-only, no-replace) | One row per completed sync run: source, start/finish, campaigns and the ones that synced, days fetched/changed, placement rows fetched/changed, status, a redacted error. `lastSync` on the dashboard comes from here. |

Every new column is nullable, so the v0.4.0 writers keep working against a 0003 database.

Since 0003, `ads_daily_metrics` holds **closed ET days only**, zero-filled where the API
returns no row (no delivery), so the stored days are contiguous and "spend through" is the
last stored day. It is written by exactly one function, `syncAdsData` (`src/lib/adsSync.ts`),
which writes only rows that changed.

### How each side uses it

- **One store, several adapters:** every statement is built in `src/lib/adsStore.ts`, and
  `createSqlAdsStore` runs them over an `AdsDb` adapter: `wranglerAdsDb`
  (`scripts/ads-reads/d1Store.ts`, the local CLIs), `d1BindingAdsDb` (a Worker or Pages
  Function) or a `node:sqlite` one in the tests (migrations applied for real). The write
  guard runs before any adapter sees a statement.
- **Routine writer:** `wrangler d1 execute gss-stats-ads --remote --json --command "<INSERT…>"`,
  one statement per call. A guard refuses anything other than a single `INSERT INTO ads_*`
  (upserts use `ON CONFLICT … DO UPDATE / DO NOTHING`), and the store is an allowlist: it only
  ever targets `gss-stats-ads`. `--dry-run` skips every write. Stored notes have local paths
  stripped. No statement binds more than 100 parameters (D1's cap for bound statements).
- **Dashboard reader:** the `gss_stats_ads` binding. `/api/campaigns` and `/api/overview`
  prefer stored spend over `CAMPAIGN_SPEND`; `/api/ads/readings` serves the readings widget.
  `/api/campaigns` and `/api/ads/readings` also return `spendThrough`, `lastSync` and `stale`
  (`src/lib/adsFreshness.ts`); they never call the Google Ads API.
  **Fail soft:** a missing binding, a missing table or any D1 error reads as "nothing
  stored", so spend falls back to the config and the readings widget shows an empty state.

## Constraints checked (2026-09-26)

- The account held one D1 database (gss-geo). Worst-case Workers Free limits: 10 databases,
  500 MB per database, 5 GB total, 5M rows read and 100k rows written per day per account
  (enforced since 2026-09-01), 50 queries per invocation, 100 bound parameters and 100 KB per
  statement, 5-term compound SELECT. This store's load is tiny (a few rows written per day).
- gss-geo read about 1.08M rows in the 24 h before this check (dashboard scans of `hits`),
  about a fifth of the Free daily read cap. That is the existing dashboard's risk, not this
  store's, and worth watching if the account is on Free.
- `wrangler.toml` (with `pages_build_output_dir`) is the source of truth for Pages bindings;
  top-level bindings apply to production and preview. The deploy workflow's token (Pages:
  Edit) already deploys a D1 binding (gss_geo), so a second one needs no new permission.
- `migrations_dir` is scoped to this database, and no `.sql` file sits at the top of
  `migrations/`, so `wrangler d1 migrations apply gss-geo` finds nothing to apply.

## Operations

Done on 2026-09-26 (owner-authorized; nothing else was created or changed):

```powershell
npx wrangler d1 create gss-stats-ads                       # id 785327a3-683c-4f85-819d-abe11efcacc9
npx wrangler d1 migrations apply gss-stats-ads --remote    # = npm run ads:migrate (0001, then 0002 the same day, then 0003)
```

The binding is in `wrangler.toml`; it takes effect on the next deploy of `main`. Sync (a no-op
when nothing changed): `npm run ads:sync -- --cf-token-file <path>`; full re-pull with the
config check: `npm run ads:backfill -- --cf-token-file <path>`.

A future schema change is a new numbered file in `migrations/gss-stats-ads/`, applied with
`npm run ads:migrate`.

## Consequences

- Spend on the dashboard comes from the Google Ads API once the routine or the backfill has
  run; `CAMPAIGN_SPEND` / `CAMPAIGN_DAILY_SPEND` remain the fallback and the audit trail.
- Corrections to the log are new rows, never edits.
- **Reversal:** remove the `[[d1_databases]]` block for `gss_stats_ads` from `wrangler.toml`
  and redeploy. Every reader fails soft to the config figures. The database can then be
  deleted with `npx wrangler d1 delete gss-stats-ads` (irreversible; owner only).
