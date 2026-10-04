-- gss-stats-ads 0005: Google Play's own per-day install totals (retention build R-4, "Play tiles").
-- ADDS ONE TABLE; nothing existing is touched. Written by the local `npm run ads:play-sync` CLI
-- from Play's bulk-report installs overview (scripts/ads-reads/play.ts); read by the
-- `adsPlayDaily` fact (src/lib/metrics/facts.ts). Counts only, one row per Play day:
-- Google's aggregate for the whole app, never a beacon row, and never split by country, source,
-- device or hour (no such column exists). Upsert-idempotent on `date`: Play re-posts days, so a
-- re-sync overwrites the day.
-- `date` is the Play report's own day (YYYY-MM-DD), as Google Play reports it. It is NOT
-- confirmed to be an ET day, so it is never mixed with the ET-day beacon metrics.
-- Each count may be NULL (a column missing from the report); a stored count is >= 0.
-- `active_device_installs` is a stock (devices with the app installed at the end of that day),
-- not a per-day flow: readers take the last day in a range, never a sum.
-- Apply (a manual local step; CI never applies it): npx wrangler d1 migrations apply gss-stats-ads --remote   (= npm run ads:migrate)

CREATE TABLE ads_play_daily (
  date                   TEXT    NOT NULL PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  device_installs        INTEGER          CHECK (device_installs IS NULL OR device_installs >= 0),
  user_installs          INTEGER          CHECK (user_installs IS NULL OR user_installs >= 0),
  device_uninstalls      INTEGER          CHECK (device_uninstalls IS NULL OR device_uninstalls >= 0),
  active_device_installs INTEGER          CHECK (active_device_installs IS NULL OR active_device_installs >= 0),
  fetched_at             TEXT    NOT NULL
);
