-- gss-stats-ads 0003: the shared sync (syncAdsData, src/lib/adsSync.ts) and readings de-dup
-- (2026-09-26). Backward compatible with the v0.4.0 writers: every new column is nullable, so an
-- older routine's INSERTs keep working unchanged.
-- Apply: npx wrangler d1 migrations apply gss-stats-ads --remote   (= npm run ads:migrate)

-- 1. Placement coverage per stored day. Placement rows only exist on days with placement
--    spend, so "which days still need a placement pull" is recorded on the day's metrics row:
--    set when the placement pull covering that day succeeded after the day had closed.
ALTER TABLE ads_daily_metrics ADD COLUMN placements_fetched_at TEXT;

-- 2. Readings de-dup. One row per (campaign, ET reading date, entry kind): e.g. `morning`,
--    `backstop`, `threshold-50`, `postflight-wrapup`, plus `+incomplete` / `+pause` /
--    `+alert-<pair>` qualifiers (lib/adsRules.ts readingEntryKind), so a same-day rerun appends
--    only when it carries new information. NULL for rows written before this migration (and
--    by an older writer); SQLite's UNIQUE treats NULLs as distinct, so those never collide.
ALTER TABLE ads_readings ADD COLUMN entry_kind TEXT
  CHECK (entry_kind IS NULL OR (length(entry_kind) BETWEEN 1 AND 160 AND entry_kind NOT GLOB '*[^a-z0-9+-]*'));
CREATE UNIQUE INDEX ads_readings_one_per_entry ON ads_readings (campaign_id, et_date, entry_kind);

-- Like 0002: a REPLACE that collides on the new key would DELETE the stored row without firing
-- the append-only DELETE trigger. This makes such an insert a silent no-op instead; ordinary
-- writes use INSERT ... ON CONFLICT DO NOTHING and behave the same.
CREATE TRIGGER ads_readings_no_replace_entry BEFORE INSERT ON ads_readings
WHEN NEW.entry_kind IS NOT NULL
  AND EXISTS (SELECT 1 FROM ads_readings WHERE campaign_id = NEW.campaign_id AND et_date = NEW.et_date AND entry_kind = NEW.entry_kind)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- 3. One row per completed sync run, so freshness is observable (the dashboard's "synced …"
--    and the per-campaign lastSync come from here). Append-only. Counts and ids only: `error`
--    is a redacted one-line summary, `detail` holds per-campaign ranges and counts.
CREATE TABLE ads_sync_runs (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key                TEXT    NOT NULL UNIQUE,
  source                 TEXT    NOT NULL CHECK (source IN ('ads-sync', 'morning-read', 'backstop', 'postflight-read', 'backfill', 'worker-cron', 'worker-on-demand')),
  started_at             TEXT    NOT NULL,
  finished_at            TEXT    NOT NULL CHECK (finished_at >= started_at),
  campaigns              TEXT    NOT NULL CHECK (json_valid(campaigns) AND json_type(campaigns) = 'array'),
  campaigns_ok           TEXT    NOT NULL CHECK (json_valid(campaigns_ok) AND json_type(campaigns_ok) = 'array'),
  days_fetched           INTEGER NOT NULL CHECK (days_fetched >= 0),
  days_changed           INTEGER NOT NULL CHECK (days_changed >= 0),
  placement_rows_fetched INTEGER NOT NULL CHECK (placement_rows_fetched >= 0),
  placement_rows_changed INTEGER NOT NULL CHECK (placement_rows_changed >= 0),
  status                 TEXT    NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  error                  TEXT             CHECK (error IS NULL OR length(error) <= 500),
  detail                 TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND json_type(detail) = 'object')
);
CREATE INDEX ads_sync_runs_by_finish ON ads_sync_runs (finished_at);

CREATE TRIGGER ads_sync_runs_append_only_update BEFORE UPDATE ON ads_sync_runs
BEGIN
  SELECT RAISE(ABORT, 'ads_sync_runs is append-only');
END;
CREATE TRIGGER ads_sync_runs_append_only_delete BEFORE DELETE ON ads_sync_runs
BEGIN
  SELECT RAISE(ABORT, 'ads_sync_runs is append-only');
END;
CREATE TRIGGER ads_sync_runs_no_replace BEFORE INSERT ON ads_sync_runs
WHEN EXISTS (SELECT 1 FROM ads_sync_runs WHERE run_key = NEW.run_key)
  OR (NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM ads_sync_runs WHERE id = NEW.id))
BEGIN
  SELECT RAISE(IGNORE);
END;
