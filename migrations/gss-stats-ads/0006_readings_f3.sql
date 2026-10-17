-- gss-stats-ads 0006: the flight 3 rules block per daily reading (2026-10-16), for the
-- Campaigns page rule-readouts card. Additive and nullable: older writers' INSERTs keep working
-- unchanged, and every row written before this migration (and every F2 / retest row after it)
-- carries NULL.
-- Apply: npx wrangler d1 migrations apply gss-stats-ads --remote   (= npm run ads:migrate)

-- One JSON object per F3 morning read: { v, arm, flightDay, readouts: [{ n, name, number,
-- threshold, verdict }], proposal } (lib/adsRules.ts ReadingF3). Proposals only, anonymous
-- aggregates only, like the rest of the row.
ALTER TABLE ads_readings ADD COLUMN f3 TEXT CHECK (f3 IS NULL OR json_valid(f3));
