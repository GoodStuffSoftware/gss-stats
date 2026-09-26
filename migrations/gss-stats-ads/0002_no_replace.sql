-- gss-stats-ads 0002: close the REPLACE hole (review L4, 2026-09-26).
-- `INSERT OR REPLACE` (or `REPLACE INTO`) resolves a key conflict by DELETING the old row —
-- and with recursive_triggers off that delete does not fire the append-only DELETE triggers
-- from 0001. These BEFORE INSERT triggers make an insert whose key already exists a silent
-- no-op (RAISE(IGNORE)), which is exactly what the routine's own
-- `ON CONFLICT ... DO NOTHING` retries do, so ordinary writes are unchanged while a REPLACE
-- can no longer rewrite a stored reading or a fired threshold.
-- Apply: npx wrangler d1 migrations apply gss-stats-ads --remote

CREATE TRIGGER ads_readings_no_replace BEFORE INSERT ON ads_readings
WHEN EXISTS (SELECT 1 FROM ads_readings WHERE reading_key = NEW.reading_key)
  OR (NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM ads_readings WHERE id = NEW.id))
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER ads_threshold_state_no_replace BEFORE INSERT ON ads_threshold_state
WHEN EXISTS (SELECT 1 FROM ads_threshold_state WHERE campaign_id = NEW.campaign_id AND threshold_usd = NEW.threshold_usd)
BEGIN
  SELECT RAISE(IGNORE);
END;
