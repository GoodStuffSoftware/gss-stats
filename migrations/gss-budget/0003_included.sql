-- Database gss-budget, binding BUDGET_DB. Exclude / include a purchase from the spending numbers (docs/adr/0007-budget-section.md).
-- Applied by hand once (never by an agent or CI); record a Time Travel bookmark first.
-- Additive only: one defaulted column and two NULLable columns. The deployed code names its columns on
-- every read and write (TXN_COLUMNS, the load's INSERT, the category_edits INSERTs), so it runs unchanged against either
-- state: its INSERTs get included = 1 and its reads never see the column. Private data never lives in this file; schema only.
-- Note: gss-budget is shared by Preview and Production, so applying this for the preview touches production's file.
--
-- transactions.included: 1 (the default) = the row counts in spending totals, pies and trends; 0 = a person excluded it.
-- Only PATCH /api/budget/transactions/:id writes it, and that stamps updated_by with the signed-in address. The protections:
-- the load's INSERT ... ON CONFLICT(id) DO NOTHING never touches an existing row, and neither the load's pairing update nor
-- the rules write this column, so a re-import cannot reset it. The pairing update also skips any row whose updated_by holds
-- an address (a person's edit, including a note-only edit, is never changed by a script); see ADR 0007 point 10.
ALTER TABLE transactions ADD COLUMN included INTEGER NOT NULL DEFAULT 1 CHECK (included IN (0,1));
-- category_edits stays the one audit log: an include change is a row with old/new_included set (NULL = not an include change).
ALTER TABLE category_edits ADD COLUMN old_included INTEGER CHECK (old_included IS NULL OR old_included IN (0,1));
ALTER TABLE category_edits ADD COLUMN new_included INTEGER CHECK (new_included IS NULL OR new_included IN (0,1));
--
-- ROLLBACK (not a second .sql file: wrangler applies every .sql in this directory). Additive, so code from before 0003
-- runs unchanged against either state; roll back only to remove the objects, and only after the code that reads
-- included is reverted (that code names the column and would answer 500). Exclusions are lost: list them first with
--   SELECT id FROM transactions WHERE included = 0;
-- Then run as ONE batch, in this order (the last statement un-records the migration, so a later `migrations apply`
-- re-adds the columns; without it the column stays missing and the code that names it answers 500):
--   ALTER TABLE category_edits DROP COLUMN new_included;
--   ALTER TABLE category_edits DROP COLUMN old_included;
--   ALTER TABLE transactions DROP COLUMN included;
--   DELETE FROM d1_migrations WHERE name = '0003_included.sql';
-- Last resort, only if a DROP fails: wrangler d1 time-travel restore gss-budget --bookmark <bookmark taken before 0003>
-- (loses every write made after the bookmark).
