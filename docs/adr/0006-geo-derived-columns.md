# ADR 0006: Compute each derived geo dimension once, as a column of a derived table

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03

## Context

D1 refuses a statement over 100,000 bytes; the local guard (`src/lib/queryLimits.ts`,
`MAX_SQL_BYTES`) stops at 90,000. The geo builders (`functions/api/geo.ts`) restated a derived
dimension's `CASE` expression everywhere it was used: once as the ring key, once in the blank
test and once per filter on it. The byte-heaviest ring the headroom test sweeps (8 dims, 16
pathFamily filters) carried the pathFamily `CASE` 18 times and was 88,664 B at 5 fake campaigns.
`bindHeadroom.test.ts` had to drop its fake-campaign count from 10 to 5 to stay green, and
some heavy filter combinations (for example 8 pathFamily, 4 keyEvent and 4 popupFamily filters)
were already refused as too large.

## Decision

Each derived dimension a statement uses (screenwBucket, pathFamily, popupFamily, popupOutcome,
gameMode, gameDifficulty, campaignFlight, arrival, keyEvent, hourEt, flightDay, landingTag) is
computed once, in its blank-label form, as a column of a derived table in the `FROM`:
`(SELECT hits.*, <expr> AS _<dim> FROM hits) AS hits`. Ring keys, blank tests and filters read
the column; a labelled key or filter is `CASE WHEN _<dim> = '' THEN '<label>' ELSE _<dim> END`,
which equals the inline labelled expression on every row because each expression returns its
label only where its blank form returns ''. SQLite flattens the derived table (a plain
projection), so the plan is the same `SEARCH hits USING INDEX idx_hits_site_ts` /
`idx_hits_ts` range scan and reads the same rows. featureStep, date, dateEt and the late
flight-attribution stage are left as they were. No schema change, no binds added, and the
counts-only split guard's SQL is untouched.

`derivedColumns.on` (exported from `geo.ts`, like `flightAttribution.late`) switches back to
the inline form, byte for byte the old SQL; `geo.derivedColumns.test.ts` runs both forms through
the real handler on real SQLite and requires identical answers.

## Numbers

Heaviest ring the headroom test finds, at 10 fake campaigns:

| Measure | Inline | Derived table |
|---|---|---|
| Sub-day and day-aligned windows (the old sweep) | 89,734 B | about 37 KB |
| With a full-year window (swept from now on) | over 90,000 B, refused | 43,084 B |
| Per added two-uc campaign | about 214 B | about 276 B |

At 10 fakes the heaviest ring holds about 169 more two-uc campaigns.

## Alternatives rejected

- **A registry table in D1** (campaign registry joined rather than stated in SQL): removes the
  per-campaign bytes but not the per-filter copies, which were most of the size; adds a table to
  keep in sync with `src/lib/campaigns.ts` and a deploy step.
- **Generated columns on `hits`**: a schema migration on the production table, and the
  expressions change whenever the registry or a path family does, which a stored column can't
  follow without another migration.
- **Collapsing the CASE expressions** (merging branches, shorter literals): saves a few percent
  per copy but keeps the copy count, so the size still grows with every filter.
