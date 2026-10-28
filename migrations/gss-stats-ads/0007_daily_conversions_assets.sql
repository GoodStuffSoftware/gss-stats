-- gss-stats-ads 0007: the ads trajectory (2026-10-28): conversions per campaign per ET day by
-- conversion action, and per-asset delivery per ET day (our own headlines, descriptions, images).
-- ADDS THREE TABLES; nothing existing is touched. Rows come from two READ-ONLY GAQL SELECTs
-- (src/lib/adsApi.ts fetchDailyConversions, fetchDailyAssets) through the upsert builders in
-- src/lib/adsStore.ts. Counts only: Google's own aggregates per campaign, day, conversion action
-- or asset, never a user-level value.
-- Ids are Google's numeric ids, stored as digit strings. A conversion action is stored by its
-- trailing numeric id only, never by its resource name (that name carries the account's
-- customer id).
-- Upsert-idempotent: Ads restates conversions for days afterwards, so a re-pull of a day
-- overwrites it in place; an unchanged re-pull writes nothing.
-- Apply (a manual local step; CI never applies it): npx wrangler d1 migrations apply gss-stats-ads --remote   (= npm run ads:migrate)

-- Conversions per campaign per ET day per conversion action (campaign resource, segmented by
-- segments.date and segments.conversion_action). Google returns no row for an action with
-- nothing on a day. conversions counts the actions included in "Conversions"; all_conversions
-- counts every action. Both are REAL: data-driven attribution can split one conversion.
CREATE TABLE ads_daily_conversions (
  campaign_id            TEXT    NOT NULL REFERENCES ads_campaigns (id),
  date                   TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  conversion_action_id   TEXT    NOT NULL CHECK (length(conversion_action_id) BETWEEN 1 AND 20 AND conversion_action_id NOT GLOB '*[^0-9]*'),
  conversion_action_name TEXT             CHECK (conversion_action_name IS NULL OR length(conversion_action_name) BETWEEN 1 AND 200),
  conversions            REAL    NOT NULL CHECK (typeof(conversions) = 'real' AND conversions BETWEEN 0 AND 1e12),
  all_conversions        REAL    NOT NULL CHECK (typeof(all_conversions) = 'real' AND all_conversions BETWEEN 0 AND 1e12),
  source                 TEXT    NOT NULL CHECK (source IN ('google-ads-api')),
  fetched_at             TEXT    NOT NULL,
  PRIMARY KEY (campaign_id, date, conversion_action_id)
);

-- Per-asset delivery per ET day (ad_group_ad_asset_view, segmented by segments.date): one row
-- per (day, ad group, ad, asset, field type), the key the 2026-10-28 probe found unique.
-- performance_label is Google's label at fetch time (an attribute, not a daily metric): the
-- first label stored for a day is kept. clicks is not capped at impressions: like
-- ads_placement_daily, a per-day row this fine can carry a click on another day's impression.
CREATE TABLE ads_daily_assets (
  campaign_id       TEXT    NOT NULL REFERENCES ads_campaigns (id),
  ad_group_id       TEXT    NOT NULL CHECK (length(ad_group_id) BETWEEN 1 AND 20 AND ad_group_id NOT GLOB '*[^0-9]*'),
  ad_id             TEXT    NOT NULL CHECK (length(ad_id) BETWEEN 1 AND 20 AND ad_id NOT GLOB '*[^0-9]*'),
  asset_id          TEXT    NOT NULL CHECK (length(asset_id) BETWEEN 1 AND 20 AND asset_id NOT GLOB '*[^0-9]*'),
  field_type        TEXT    NOT NULL CHECK (length(field_type) BETWEEN 1 AND 40 AND field_type NOT GLOB '*[^A-Z0-9_]*'),
  date              TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  impressions       INTEGER NOT NULL CHECK (typeof(impressions) = 'integer' AND impressions >= 0),
  clicks            INTEGER NOT NULL CHECK (typeof(clicks) = 'integer' AND clicks >= 0),
  conversions       REAL    NOT NULL CHECK (typeof(conversions) = 'real' AND conversions BETWEEN 0 AND 1e12),
  performance_label TEXT             CHECK (performance_label IS NULL OR (length(performance_label) BETWEEN 1 AND 40 AND performance_label NOT GLOB '*[^A-Z0-9_]*')),
  source            TEXT    NOT NULL CHECK (source IN ('google-ads-api')),
  fetched_at        TEXT    NOT NULL,
  PRIMARY KEY (campaign_id, date, ad_group_id, ad_id, asset_id, field_type)
);

-- The assets those rows name: our own ad copy (text assets) and image names, with the first and
-- last ET day each asset had a row in ads_daily_assets.
CREATE TABLE ads_assets (
  asset_id   TEXT NOT NULL PRIMARY KEY CHECK (length(asset_id) BETWEEN 1 AND 20 AND asset_id NOT GLOB '*[^0-9]*'),
  type       TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 40 AND type NOT GLOB '*[^A-Z0-9_]*'),
  text       TEXT          CHECK (text IS NULL OR length(text) BETWEEN 1 AND 2000),
  name       TEXT          CHECK (name IS NULL OR length(name) BETWEEN 1 AND 500),
  first_seen TEXT NOT NULL CHECK (first_seen GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  last_seen  TEXT NOT NULL CHECK (last_seen GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (first_seen <= last_seen)
);
