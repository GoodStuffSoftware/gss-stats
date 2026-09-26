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

Migration `0004_sync_claims.sql` (review of the sync Worker, 2026-09-26) is a single rebuild of
`ads_sync_runs` only (create new, copy every row with its id, drop, rename, recreate the index
and triggers): status `'running'` for the atomic claim, and `campaigns_pulled` (the campaigns
whose closed days were pulled through the end of their window) for the restatement recheck
cadence. D1 runs the whole file and its `d1_migrations` row as one request, all or nothing.

Since 0003, `ads_daily_metrics` holds **closed ET days only** (a day is closed once it was
pulled at or after 03:00 ET the next day: Google still adds late data just after midnight),
zero-filled where the API returns no row — only for days never stored, only inside the flight,
and only when Google's range total agrees with the daily rows — so the stored flight days are
contiguous and "spend through" is the last of them (never past the flight end). A stored day
with spend that the daily rows leave out is restated to zero only when a non-empty range total
agrees; an empty response never zeroes stored spend. When the rows and the total disagree the
range is re-pulled in halves (newer first) down to single days, so one bad day is isolated and
the rest written. The sync pulls newest first, in at most two ranges per campaign (the last 3
days whole, then an older gap), each checked and written on its own (review L1-L3,
2026-09-26). It is written by exactly one function, `syncAdsData` (`src/lib/adsSync.ts`), which writes
only rows that changed.

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

### The sync Worker: from local-only to a Cloudflare Worker (2026-09-26)

**Why it moved.** Until now every Google Ads pull ran on the owner's Windows machine (the
scheduled local routines). If that machine was asleep, offline or its routine failed, stored
spend simply stopped at the last good day and the dashboard had no way to catch up. The owner
asked for the data to be checked and pulled when it is missing, and approved storing the Ads
keys in Cloudflare's secret manager (2026-09-26). So a Worker, `gss-stats-sync`
(`workers/sync/`), now runs **the same `syncAdsData`** on a cron and on demand. The local
routines keep their analysis, pushes and bus copies and still sync first; whichever runs second
finds nothing to write, because the sync writes only changed rows.

**Shape.**
- D1 through a binding (`gss_stats_ads`), via the same `createSqlAdsStore` on the
  `d1BindingAdsDb` adapter; the write guard applies unchanged.
- Cron `5 * * * *`; `cronShouldSync` makes it hourly during a live flight (first day through
  the day after the last) and a single 01:05 ET pass otherwise. The owner suggested hourly
  during serving hours with a closing pass after midnight. Every tick first plans from two D1
  reads; only when something is due (a new closed day right after midnight ET, a retry after a
  failure, or the restatement window once its last pull is 6 h old) does it claim, read the
  secrets, refresh the token and call Google. So an hourly cron costs one Google pull every
  ~6 h plus the post-midnight one, and a missed or failed pass is retried within the hour.
- On demand: `POST /sync`, reachable **only** through the Pages Service Binding `ADS_SYNC`
  (`workers_dev = false`, `preview_urls = false`, no route). `/api/ads/refresh` (behind the
  sign-in gate) calls it only when a campaign is stale. The rate limit is atomic (migration
  0004): a sync first INSERTs a `'running'` claim row only if no run finished in the last 10
  minutes (one `INSERT … SELECT … WHERE NOT EXISTS`), so of two concurrent requests exactly one
  syncs and the other gets 429. A claim with no finished row after it is a run that died: after
  15 minutes `/api/ads/readings` returns it as a `syncAlerts` entry (the readings widget shows
  it) and the reads' reports print it (review I2).
- Work per invocation is capped: at most 7 closed days (live campaigns first, newest days
  first) and 40 D1 statements (Free allows 50); the rest continues on the next run, and the run row is always
  recorded.

**Secrets.** Cloudflare Secrets Store (open beta; the account's single store
`default_secrets_store`, 100-secret limit), chosen over per-Worker secrets because the account
supports it and it keeps the keys account-level, scoped to `workers`, not readable back through
the API or dashboard. Four secrets, named exactly like their Bitwarden keys. Bitwarden stays the
source of truth; `npm run ads:worker-secrets` copies them bws → memory → Cloudflare (create:
piped into `wrangler secrets-store secret create` on stdin; update: the Secrets Store API call
wrangler itself makes, because `wrangler … update` cannot read stdin non-interactively). Nothing
is printed, logged or written to disk. In the Worker the values are registered with `redact()`
and the Ads client never sends `login-customer-id`.

**Trade-offs.**
- (+) Freshness no longer depends on one laptop; the dashboard can self-heal a stale day.
- (−) The Ads credentials now also live in Cloudflare (a second place to rotate and a second
  blast radius). Mitigations: Secrets Store scope `workers`, no public entry point, a read-only
  client (GAQL `SELECT` only), and a one-command rotation from Bitwarden.
- (−) The account is on **Workers Free**: 10 ms CPU per invocation, 50 external subrequests,
  5 cron triggers per account (this Worker uses 1). **Correction (review, 2026-09-26):** the
  first version claimed a sync was "I/O-bound" and would "fail loudly". Measured, it was not:
  every run read the secrets and refreshed the token even with nothing to pull, and the bundle
  built Intl formatters at module load. A no-op took 9.7 ms and a full re-pull 33 ms (it
  succeeded only because Free tolerates occasional overruns). After the fixes (plan first and
  stop when nothing is due; lazy Ads client and token reuse; no Intl on the Worker path; per-run
  caps), live `wrangler tail` cpuTime on the deployed Worker:
  - a no-op: 1-4 ms warm;
  - the first call on a fresh isolate: 6 ms;
  - a 1-day pull: 9-10 ms warm and 12.6 ms on a cold isolate (4 secret reads, a token
    refresh, two GAQL queries, three D1 statements; Workers analytics agree).
  So a due run on a cold isolate (what an hourly cron usually gets) passes 10 ms: it ran to
  completion in every test, because Free tolerates occasional overruns, but on Free the platform may end
  the invocation. That is visible (a `'running'` claim with no finished row, `exceededCpu` in
  `wrangler tail`) and safe: writes are idempotent, the next tick continues, and the local
  routines still sync. Workers Paid (5 min CPU) removes the concern; the code needs no change
  either way.
- (−) The Worker bundles `src/lib/campaigns.ts`: a new or changed campaign needs a Worker
  redeploy as well as the Pages deploy. `npm run ads:worker-deploy` stamps the version with the
  git SHA (tag, message, and the `GIT_SHA` var the Worker reports in every run row and
  response, with a hash of the campaign definitions); the dashboard's Refresh flags a Worker
  built from other definitions, and CI bundles the Worker on every PR (`npm run
  ads:worker-check`). Deploying it stays manual: the CI token has no Workers or Secrets Store
  permission.
- **Reversal:** remove the `[[services]]` block from `wrangler.toml` (the Refresh button then
  reports "not available"), delete the Worker (`npx wrangler delete gss-stats-sync`) and the four
  Secrets Store secrets (owner only). The local routines are unaffected.

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
- For the sync Worker (checked before deploying): no Workers Paid subscription on the account
  (Workers Free limits above apply); 0 of 5 cron triggers in use (one other Worker, fetch-only);
  Secrets Store available with its single store already created; the local deploy token holds
  Workers Scripts, Secrets Store, D1 and Pages write.

## Operations

Done on 2026-09-26 (owner-authorized; nothing else was created or changed):

```powershell
npx wrangler d1 create gss-stats-ads                       # id 785327a3-683c-4f85-819d-abe11efcacc9
npx wrangler d1 migrations apply gss-stats-ads --remote    # = npm run ads:migrate (0001, then 0002 the same day, then 0003, then 0004)
```

0003 was applied to the remote database on 2026-09-26 (row counts unchanged: 3 campaigns, 13
day rows, 185 placement rows, 0 readings, 0 thresholds). The first live `npm run ads:sync`
then stored 19 closed day rows (the two closed campaigns' zero-spend days through flight end
+ 3, and placement coverage on the existing ones; the 185 placement rows re-pulled identical);
a second run made no Ads call and changed nothing, and a `--full` re-pull fetched all 19 days
and 185 placement rows and changed nothing. (Six of those 19 rows are zero rows after the
closed campaigns' flight ends, from the first version; since the review the sync zero-fills
only inside the flight and spend-through stops at the flight end, and the writer cannot delete
them. They are harmless zeros.)

0004 was applied to the remote database on 2026-09-26 after a read-only backup of
`ads_sync_runs` (`migrations/gss-stats-ads/backups/pre-0004-ads_sync_runs.json`, 5 rows) and a
local rehearsal on 0001-0003 with those 5 rows (every value identical after the rebuild). After
the remote apply every `ads_*` table kept its row count (3 / 19 / 185 / 0 / 0 / 5), the five rows
matched the backup value for value, and every 0002/0003 trigger, the unique index and the
`ads_sync_runs` triggers and index were present in `sqlite_master`.

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
