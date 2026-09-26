-- gss-stats-ads: the ads-read store (docs/adr/0001-ads-read-store.md).
-- Owned by gss-stats. NOT the beacon's gss-geo database — nothing here reads or writes it.
-- Money is integer micros (1 USD = 1,000,000). Dates are ET calendar dates (YYYY-MM-DD, the
-- Google Ads account time zone); timestamps are ISO-8601 UTC strings.
-- Apply: npx wrangler d1 migrations apply gss-stats-ads --remote

-- Campaign definitions, synced (upserted) from src/lib/campaigns.ts CAMPAIGNS, which stays
-- the source of truth. General across every campaign: web or Play-direct, measurable or
-- spend-only, past, current and future.
CREATE TABLE ads_campaigns (
  id                   TEXT    NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 5 AND 20 AND id NOT GLOB '*[^0-9]*'),
  name                 TEXT    NOT NULL CHECK (length(name) > 0),
  uc_values            TEXT    NOT NULL CHECK (json_valid(uc_values) AND json_type(uc_values) = 'array'),
  kind                 TEXT    NOT NULL CHECK (kind IN ('web', 'play-direct')),
  flight_start         TEXT             CHECK (flight_start IS NULL OR flight_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  flight_start_time_et TEXT             CHECK (flight_start_time_et IS NULL OR flight_start_time_et GLOB '[0-2][0-9]:[0-5][0-9]'),
  flight_end           TEXT    NOT NULL CHECK (flight_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status               TEXT    NOT NULL CHECK (status IN ('upcoming', 'active', 'closed')),
  daily_budget_micros  INTEGER          CHECK (daily_budget_micros IS NULL OR daily_budget_micros >= 0),
  hard_cap_micros      INTEGER          CHECK (hard_cap_micros IS NULL OR hard_cap_micros >= 0),
  measurement          TEXT    NOT NULL CHECK (measurement IN ('beacon', 'spend-only')),
  synced_at            TEXT    NOT NULL,
  CHECK (flight_start IS NULL OR flight_start <= flight_end)
);

-- Daily delivery per campaign per ET date, from the Google Ads API. Upsert-idempotent on
-- (campaign_id, date): a re-read overwrites the day (Ads back-fills for about two days).
CREATE TABLE ads_daily_metrics (
  campaign_id  TEXT    NOT NULL REFERENCES ads_campaigns (id),
  date         TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  cost_micros  INTEGER NOT NULL CHECK (cost_micros >= 0),
  impressions  INTEGER NOT NULL CHECK (impressions >= 0),
  clicks       INTEGER NOT NULL CHECK (clicks >= 0 AND clicks <= impressions),
  source       TEXT    NOT NULL CHECK (source IN ('google-ads-api')),
  fetched_at   TEXT    NOT NULL,
  PRIMARY KEY (campaign_id, date)
);

-- Optional placement-level daily cost (Ads group_placement_view), upsert-idempotent.
-- `approved` is 1/0 against that campaign's approved placement list, NULL when the campaign
-- has no list on record.
CREATE TABLE ads_placement_daily (
  campaign_id    TEXT    NOT NULL REFERENCES ads_campaigns (id),
  date           TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  placement      TEXT    NOT NULL CHECK (length(placement) > 0),
  display_name   TEXT,
  placement_type TEXT,
  target_url     TEXT,
  approved       INTEGER          CHECK (approved IS NULL OR approved IN (0, 1)),
  cost_micros    INTEGER NOT NULL CHECK (cost_micros >= 0),
  impressions    INTEGER NOT NULL CHECK (impressions >= 0),
  clicks         INTEGER NOT NULL CHECK (clicks >= 0),
  fetched_at     TEXT    NOT NULL,
  PRIMARY KEY (campaign_id, date, placement)
);

-- The readings log. APPEND-ONLY (triggers below): a correction is a new row, never an edit.
-- `reading_key` makes a retried insert idempotent. JSON columns hold anonymous aggregates
-- only (counts, rule results) — never a row-level or personal value.
CREATE TABLE ads_readings (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  reading_key             TEXT    NOT NULL UNIQUE,
  campaign_id             TEXT    NOT NULL REFERENCES ads_campaigns (id),
  kind                    TEXT    NOT NULL CHECK (kind IN ('daily', 'threshold', 'postflight', 'health')),
  stage                   TEXT             CHECK (stage IS NULL OR stage IN ('wrapup', 'day15', 'day30', 'day60', 'december')),
  read_at                 TEXT    NOT NULL,
  et_date                 TEXT    NOT NULL CHECK (et_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  spend_through_et        TEXT             CHECK (spend_through_et IS NULL OR spend_through_et GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  cumulative_spend_micros INTEGER          CHECK (cumulative_spend_micros IS NULL OR cumulative_spend_micros >= 0),
  thresholds              TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(thresholds) AND json_type(thresholds) = 'array'),
  complete                INTEGER NOT NULL CHECK (complete IN (0, 1)),
  rules                   TEXT             CHECK (rules IS NULL OR json_valid(rules)),
  proposal                TEXT             CHECK (proposal IS NULL OR proposal IN ('PROPOSE PAUSE', 'CONTINUE')),
  decision                TEXT             CHECK (decision IS NULL OR json_valid(decision)),
  counts                  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(counts) AND json_type(counts) = 'object'),
  notes                   TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(notes) AND json_type(notes) = 'array'),
  routine_version         TEXT    NOT NULL CHECK (length(routine_version) > 0),
  CHECK (kind = 'postflight' OR stage IS NULL)
);
CREATE INDEX ads_readings_by_campaign_time ON ads_readings (campaign_id, read_at);

CREATE TRIGGER ads_readings_append_only_update BEFORE UPDATE ON ads_readings
BEGIN
  SELECT RAISE(ABORT, 'ads_readings is append-only');
END;
CREATE TRIGGER ads_readings_append_only_delete BEFORE DELETE ON ads_readings
BEGIN
  SELECT RAISE(ABORT, 'ads_readings is append-only');
END;

-- Threshold state: each (campaign, threshold) fires once. A row exists only after a COMPLETE
-- threshold read; the primary key makes a second firing impossible.
CREATE TABLE ads_threshold_state (
  campaign_id   TEXT    NOT NULL REFERENCES ads_campaigns (id),
  threshold_usd INTEGER NOT NULL CHECK (threshold_usd > 0),
  fired_at      TEXT    NOT NULL,
  reading_id    INTEGER NOT NULL REFERENCES ads_readings (id),
  PRIMARY KEY (campaign_id, threshold_usd)
);

CREATE TRIGGER ads_threshold_state_immutable_update BEFORE UPDATE ON ads_threshold_state
BEGIN
  SELECT RAISE(ABORT, 'ads_threshold_state rows are immutable');
END;
CREATE TRIGGER ads_threshold_state_immutable_delete BEFORE DELETE ON ads_threshold_state
BEGIN
  SELECT RAISE(ABORT, 'ads_threshold_state rows are immutable');
END;
