-- gss-stats-ads 0004: sync claims and pulled campaigns (review of the sync Worker, 2026-09-26).
-- A single transactional rebuild of ads_sync_runs ONLY (create new, copy, drop old, rename);
-- no other table is touched. SQLite cannot change a CHECK in place, and two things need it:
--   * status 'running': a sync first INSERTs a claim row (INSERT … SELECT … WHERE NOT EXISTS a
--     run that finished inside the claim window), so of two concurrent on-demand requests
--     exactly one wins and the other gets 429. A claim with no later finished row is a run that
--     never finished (e.g. it ran out of CPU): visible, not silent.
--   * campaigns_pulled: the campaigns whose closed days were actually pulled from Google in the
--     run, so the sync re-checks the restatement window on a cadence instead of on every tick.
-- Every row keeps its id and values; campaigns_pulled is back-filled from campaigns_ok for runs
-- that fetched days. The append-only and no-REPLACE triggers are recreated as in 0003.
-- Apply: npx wrangler d1 migrations apply gss-stats-ads --remote   (= npm run ads:migrate)

CREATE TABLE ads_sync_runs_0004 (
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
  status                 TEXT    NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  error                  TEXT             CHECK (error IS NULL OR length(error) <= 500),
  detail                 TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND json_type(detail) = 'object'),
  campaigns_pulled       TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(campaigns_pulled) AND json_type(campaigns_pulled) = 'array')
);

INSERT INTO ads_sync_runs_0004 (id, run_key, source, started_at, finished_at, campaigns, campaigns_ok, days_fetched, days_changed, placement_rows_fetched, placement_rows_changed, status, error, detail, campaigns_pulled)
SELECT id, run_key, source, started_at, finished_at, campaigns, campaigns_ok, days_fetched, days_changed, placement_rows_fetched, placement_rows_changed, status, error, detail,
       CASE WHEN days_fetched > 0 THEN campaigns_ok ELSE '[]' END
FROM ads_sync_runs;

DROP TABLE ads_sync_runs;
ALTER TABLE ads_sync_runs_0004 RENAME TO ads_sync_runs;

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
