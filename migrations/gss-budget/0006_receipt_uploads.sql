-- Database gss-budget, binding BUDGET_DB. Receipt photo uploads: the receipts table can now hold a receipt that came from an
-- uploaded photo as well as one that came from email (docs/adr/0008-email-receipts.md; ADR for uploads lands with the code).
--
-- APPLY RULE: by the Budget lead, by hand (never an agent or CI), AFTER a Time Travel bookmark
-- (npx wrangler d1 time-travel info gss-budget), away from the receipts Worker cron (it runs at :23 past every hour, UTC),
-- and while nobody edits Budget. The migration rebuilds a table that has cascading foreign keys; it is not "additive".
-- The code from 0.86.1 (and every earlier receipts build) keeps working on the new schema: it never names the new columns,
-- the column DEFAULT makes its rows 'email', it always supplies connection_id and gmail_msg_id (so the email CHECK passes),
-- and every one of its queries filters connection_id = ?, which no upload row matches. So this can be applied before or after
-- the code that uses it. Private data never lives in this file; schema only.
-- Note: gss-budget is shared by Preview and Production, so applying this for the preview touches production's file.
--
-- NUMBERING AND ORDER: the number is 0006 because 0005 is the bank-link migration (six bank_* tables, three triggers and a
-- transactions.pending column; it names none of receipts, receipt_items, receipt_matches). The two migrations touch disjoint
-- tables, so they apply cleanly in either state: tests apply this file over 0001-0004 and over 0001-0005 (functions/_lib/receiptUploadsSchema.test.ts).
-- wrangler applies files in name order, so a database that has not applied 0005 yet gets it first.
--
-- Why a rebuild: SQLite cannot drop NOT NULL with ALTER. connection_id and gmail_msg_id must become nullable (an upload has
-- neither), so receipts is re-created. The other options were rejected (a per-person pseudo email_connection: the status/token
-- CHECK, Gmail retry and disconnect-purge all misfire on it; separate upload tables: the one-applied-receipt-per-bank-row unique
-- index cannot span two tables).
--
-- Facts the order below relies on (checked on D1 for 0004, restated here):
--   * Foreign keys are always on in D1 and a script cannot turn them off. DROP TABLE of a parent performs an implicit DELETE
--     that fires ON DELETE CASCADE / SET NULL (neither PRAGMA defer_foreign_keys nor any pragma stops it), but fires no trigger.
--     So the children (receipt_matches, receipt_items) are copied aside and dropped BEFORE the parent: neither is a parent,
--     their implicit DELETE fires no foreign key action and no trigger, and receipts then has no children left to cascade into.
--     CREATE TABLE ... AS carries no foreign key, so nothing can cascade into the copies either.
--   * No rename is used (create under the final name after the DROP), so no legacy_alter_table / trigger or view rewriting
--     questions arise. Dropping a table drops its indexes and triggers: the four 0004 receipts indexes, idx_match_txn,
--     idx_match_applied and trg_match_applied_gone are all re-created below.
--   * receipt_items and receipt_matches, their two indexes and the trigger are re-created BYTE-IDENTICAL to 0004 (a test diffs
--     the stored DDL text). In particular receipt_matches.txn_id stays REFERENCES transactions(id) ON DELETE CASCADE and
--     idx_match_txn stays on (txn_id, status): the bank-link code relies on both. Match rows keep their ids and values.
--   * Restoring uses INSERT, which fires no AFTER DELETE trigger, and parents before children. categories is never touched, so
--     the SET NULL columns (category_hint, proposed_category_id) are copied and restored with their values.
--   * NULLs are distinct in a UNIQUE constraint, so UNIQUE (connection_id, gmail_msg_id) never collides on upload rows.
--   * A CHECK that evaluates to NULL passes, so every column CHECK below is written NULL-safe (IS NULL OR ...) and the row-shape
--     CHECK uses only IS [NOT] NULL tests and source = '...' on a NOT NULL column, so it always evaluates to 0 or 1.
--
-- Safety nets inside this file, in order: (1) a precheck that fails the file, before anything changes, if receipts already has
-- the new columns (so a second run can never restore upload rows through the email-only path); (2) row counts and a full-content
-- EXCEPT compare of every restored table against its copy, written into a CHECK table whose failed INSERT aborts the file;
-- (3) the copies (_m6_*) are dropped only AFTER that guard, so a guard failure leaves every original row in the _m6_* tables.
--
-- ATOMICITY (rehearsed 2026-11-27, wrangler 4.143.0, LOCAL D1 only; production D1 was never touched): `wrangler d1 migrations
-- apply gss-budget --local --persist-to <scratch>` over 0001-0004 plus a few made-up rows, using a copy of this file with one
-- extra final statement that fails (an INSERT into a table that does not exist). Result: the migration was reported as failed
-- (SQLITE_ERROR no such table) and the WHOLE FILE WAS ROLLED BACK: receipts still had its 24 original columns, the four old
-- indexes and the trigger were intact, no _m6_* table existed, the row counts were unchanged (2 receipts, 1 item), and
-- d1_migrations did not list 0006. The unmodified file then applied cleanly (34 statements; receipts 29 columns, counts
-- unchanged, no leftover _m6_* table). So local D1 applies a migration file atomically. That is evidence about local D1
-- (workerd's SQLite), not a proof about production D1, which cannot be rehearsed without touching it; hence the bookmark.
-- If production were NOT atomic, the guard in step 6 still stops the run and leaves every original row in the _m6_* tables
-- (see Safety nets); the operator then restores the bookmark.
--
-- Query shapes the new partial indexes serve (SQLite uses a partial index only when the query's WHERE repeats the index's WHERE
-- terms; x = ? counts as x IS NOT NULL, but the status IN (...) lists must be written exactly as here):
--   review list  uploader_email = ?1 AND status = ?2 [AND (email_date, id) < (?, ?)] ORDER BY email_date DESC, id DESC   -> idx_rcpt_up_review
--   open window  uploader_email = ?1 AND status IN ('unmatched','suggested') AND coalesce(receipt_date, email_date) >= ?2   -> idx_rcpt_up_open
--   daily count  uploader_email = ?1 AND created_at >= ?2                                                                 -> idx_rcpt_up_day
--   (The upload daily cap counts live rows, so delete-and-reupload resets it. Accepted for two trusted users; the server leg documents it.)
--   retry list   uploader_email IS NOT NULL AND status IN ('pending','error') AND attempts < ?1 ORDER BY attempts, id       -> idx_rcpt_up_retry
--   hash dedupe  image_sha256 = ?1                                                                                        -> idx_rcpt_up_hash

-- 1. Precheck (fails the file before any change) and the guard table.
CREATE TABLE _m6_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _m6_check (ok)
  SELECT NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'receipts' AND sql LIKE '%uploader_email%');

-- 2. Counts for the guard, then every table copied aside (explicit column lists: the copies hold exactly the 0004 columns).
CREATE TABLE _m6_counts AS SELECT
  (SELECT count(*) FROM receipts) AS r,
  (SELECT count(*) FROM receipt_items) AS i,
  (SELECT count(*) FROM receipt_matches) AS m,
  (SELECT count(*) FROM receipt_matches WHERE status = 'applied') AS a;
CREATE TABLE _m6_receipts AS SELECT id, connection_id, gmail_msg_id, email_date, status, attempts, error_code, kind, sender_domain, merchant,
  payment_via, card_last4, order_ref, receipt_date, related_date, currency, total_cents, tax_cents, shipping_cents, charges_json, extract_model,
  created_at, updated_at, updated_by FROM receipts;
CREATE TABLE _m6_items AS SELECT receipt_id, seq, description, amount_cents, quantity, category_hint FROM receipt_items;
CREATE TABLE _m6_matches AS SELECT id, receipt_id, txn_id, group_key, rule, share_cents, score, status, proposed_category_id, txn_updated_at,
  created_at, decided_at, decided_by FROM receipt_matches;

-- 3. Drop the children first, then the parent (see "Facts" above). receipt_matches takes idx_match_txn, idx_match_applied and
--    trg_match_applied_gone with it; receipts takes its four indexes.
DROP TABLE receipt_matches;
DROP TABLE receipt_items;
DROP TABLE receipts;

-- 4. receipts, new shape. Every 0004 column, CHECK and default is kept verbatim; the five new columns come LAST (as an ALTER
--    ... ADD would have put them) so nothing that reads by position moves. For an upload row: email_date = the upload day (UTC),
--    connection_id and gmail_msg_id are NULL, uploader_email is the lower-cased login, image_sha256 is the hash of the stripped
--    bytes (kept after the image is deleted: household-wide dedupe), image_key is NULL once the image is deleted.
CREATE TABLE receipts (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'r[0-9a-f]*' AND length(id) = 17 AND substr(id, 2) NOT GLOB '*[^0-9a-f]*'),
  connection_id   TEXT REFERENCES email_connections(id) ON DELETE CASCADE,
  gmail_msg_id    TEXT CHECK (gmail_msg_id IS NULL OR (length(gmail_msg_id) BETWEEN 8 AND 32 AND gmail_msg_id NOT GLOB '*[^0-9a-f]*')),
  email_date      TEXT NOT NULL CHECK (email_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(email_date) IS email_date),
  status          TEXT NOT NULL CHECK (status IN ('pending','skipped','error','no_total','unmatched','suggested','applied','dismissed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 9),
  error_code      TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 40 AND error_code GLOB '[a-z_]*' AND error_code NOT GLOB '*[^a-z0-9_]*')),
  kind            TEXT CHECK (kind IS NULL OR kind IN ('purchase','refund','subscription','payment_sent','payment_received','decline','other')),
  sender_domain   TEXT CHECK (sender_domain IS NULL OR length(sender_domain) <= 80),
  merchant        TEXT CHECK (merchant IS NULL OR length(merchant) <= 80),                       -- digits masked (maskDigits)
  payment_via     TEXT CHECK (payment_via IS NULL OR payment_via IN ('card','paypal','venmo','apple','amazon','google','bank','other')),
  card_last4      TEXT CHECK (card_last4 IS NULL OR (length(card_last4) = 4 AND card_last4 GLOB '[0-9][0-9][0-9][0-9]')),
  order_ref       TEXT CHECK (order_ref IS NULL OR (length(order_ref) BETWEEN 1 AND 64 AND order_ref NOT GLOB '*[^A-Za-z0-9#-]*')),   -- full order number (shown to the people); a card-like value is dropped before it gets here
  receipt_date    TEXT CHECK (receipt_date IS NULL OR (receipt_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(receipt_date) IS receipt_date)),
  related_date    TEXT CHECK (related_date IS NULL OR (related_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(related_date) IS related_date)),
  currency        TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]')),
  total_cents     INTEGER CHECK (total_cents IS NULL OR (typeof(total_cents) = 'integer' AND total_cents BETWEEN 0 AND 100000000)),
  tax_cents       INTEGER CHECK (tax_cents IS NULL OR (typeof(tax_cents) = 'integer' AND tax_cents BETWEEN 0 AND 100000000)),
  shipping_cents  INTEGER CHECK (shipping_cents IS NULL OR (typeof(shipping_cents) = 'integer' AND shipping_cents BETWEEN 0 AND 100000000)),
  -- stated split charges: a JSON array. The CASE keeps json_type from running on text that is not JSON.
  charges_json    TEXT CHECK (charges_json IS NULL OR (length(charges_json) <= 400
                    AND CASE WHEN json_valid(charges_json) THEN json_type(charges_json) = 'array' ELSE 0 END)),
  extract_model   TEXT CHECK (extract_model IS NULL OR length(extract_model) <= 64),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'email' CHECK (source IN ('email','upload')),
  uploader_email  TEXT CHECK (uploader_email IS NULL OR (uploader_email = lower(uploader_email) AND instr(uploader_email, '@') > 1 AND instr(uploader_email, '@') < length(uploader_email) AND length(uploader_email) <= 254)),
  image_key       TEXT CHECK (image_key IS NULL OR (length(image_key) = 25 AND image_key GLOB 'img/r*.jpg' AND substr(image_key, 6, 16) NOT GLOB '*[^0-9a-f]*')),   -- 'img/' || id || '.jpg'; NULL once the image is deleted
  image_sha256    TEXT CHECK (image_sha256 IS NULL OR (length(image_sha256) = 64 AND image_sha256 NOT GLOB '*[^0-9a-f]*')),   -- of the stripped bytes; kept after the image goes
  image_bytes     INTEGER CHECK (image_bytes IS NULL OR (typeof(image_bytes) = 'integer' AND image_bytes BETWEEN 1 AND 3000000)),
  CHECK ((source = 'email'  AND connection_id IS NOT NULL AND gmail_msg_id IS NOT NULL AND uploader_email IS NULL
                            AND image_key IS NULL AND image_sha256 IS NULL AND image_bytes IS NULL)
      OR (source = 'upload' AND connection_id IS NULL AND gmail_msg_id IS NULL AND uploader_email IS NOT NULL AND image_sha256 IS NOT NULL)),
  UNIQUE (connection_id, gmail_msg_id)                                                            -- dedupe; also serves the pre-check and the cascade from email_connections (NULLs are distinct: uploads never collide)
);
-- the four 0004 indexes, verbatim (email rows; an upload row has NULL connection_id and is never matched by them)
CREATE INDEX idx_rcpt_review ON receipts (connection_id, status, email_date, id);            -- review list, keyset paging; scanned backward for ORDER BY email_date DESC, id DESC
CREATE INDEX idx_rcpt_open   ON receipts (connection_id, coalesce(receipt_date, email_date)) WHERE status IN ('unmatched','suggested');   -- re-match window; queries must use this exact expression
CREATE INDEX idx_rcpt_order  ON receipts (connection_id, order_ref) WHERE order_ref IS NOT NULL;   -- refund-original and sibling lookups
CREATE INDEX idx_rcpt_retry  ON receipts (connection_id, attempts) WHERE status IN ('pending','error');
-- the upload twins (partial: they hold upload rows only, so email rows cost nothing)
CREATE INDEX idx_rcpt_up_review ON receipts (uploader_email, status, email_date, id) WHERE uploader_email IS NOT NULL;
CREATE INDEX idx_rcpt_up_open   ON receipts (uploader_email, coalesce(receipt_date, email_date)) WHERE uploader_email IS NOT NULL AND status IN ('unmatched','suggested');
CREATE INDEX idx_rcpt_up_day    ON receipts (uploader_email, created_at) WHERE uploader_email IS NOT NULL;
CREATE INDEX idx_rcpt_up_retry  ON receipts (attempts, id) WHERE uploader_email IS NOT NULL AND status IN ('pending','error');
CREATE UNIQUE INDEX idx_rcpt_up_hash ON receipts (image_sha256) WHERE image_sha256 IS NOT NULL;   -- one upload per image, household-wide

-- receipt_items: line items (masked description, at most 20 per receipt). Verbatim from 0004.
CREATE TABLE receipt_items (
  receipt_id    TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 20),
  description   TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
  amount_cents  INTEGER CHECK (amount_cents IS NULL OR (typeof(amount_cents) = 'integer' AND amount_cents BETWEEN -100000000 AND 100000000)),
  quantity      INTEGER CHECK (quantity IS NULL OR (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 999)),
  category_hint TEXT REFERENCES categories(id) ON DELETE SET NULL,
  PRIMARY KEY (receipt_id, seq)
) WITHOUT ROWID;

-- receipt_matches, its two indexes and the trigger: verbatim from 0004 (comments there).
CREATE TABLE receipt_matches (
  id             INTEGER PRIMARY KEY,
  receipt_id     TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  txn_id         TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,                     -- a deleted load row drops its matches
  group_key      TEXT NOT NULL CHECK (length(group_key) BETWEEN 1 AND 40),                        -- rows of one split proposal share it
  rule           TEXT NOT NULL CHECK (rule IN ('exact','split_charges','split_receipts','refund','decline_retry')),
  share_cents    INTEGER NOT NULL CHECK (typeof(share_cents) = 'integer' AND share_cents BETWEEN -100000000 AND 100000000),
  score          INTEGER NOT NULL CHECK (typeof(score) = 'integer' AND score BETWEEN 0 AND 100),
  status         TEXT NOT NULL CHECK (status IN ('suggested','applied','rejected','superseded')),
  proposed_category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  txn_updated_at TEXT NOT NULL,                                                                   -- the row's updated_at when proposed
  created_at     TEXT NOT NULL,
  decided_at     TEXT,
  decided_by     TEXT,
  UNIQUE (receipt_id, txn_id)
);
CREATE INDEX idx_match_txn     ON receipt_matches (txn_id, status);
CREATE UNIQUE INDEX idx_match_applied ON receipt_matches (txn_id) WHERE status = 'applied';
CREATE TRIGGER trg_match_applied_gone AFTER DELETE ON receipt_matches
WHEN OLD.status = 'applied'
BEGIN
  UPDATE receipts SET status = 'unmatched', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by = 'db:match_deleted'
   WHERE id = OLD.receipt_id AND status = 'applied'
     AND NOT EXISTS (SELECT 1 FROM receipt_matches m WHERE m.receipt_id = OLD.receipt_id AND m.status = 'applied');
END;

-- 5. Restore, parents first. Existing rows are all email rows (source takes its DEFAULT, 'email').
INSERT INTO receipts (id, connection_id, gmail_msg_id, email_date, status, attempts, error_code, kind, sender_domain, merchant,
  payment_via, card_last4, order_ref, receipt_date, related_date, currency, total_cents, tax_cents, shipping_cents, charges_json, extract_model,
  created_at, updated_at, updated_by)
  SELECT id, connection_id, gmail_msg_id, email_date, status, attempts, error_code, kind, sender_domain, merchant,
  payment_via, card_last4, order_ref, receipt_date, related_date, currency, total_cents, tax_cents, shipping_cents, charges_json, extract_model,
  created_at, updated_at, updated_by FROM _m6_receipts;
INSERT INTO receipt_items (receipt_id, seq, description, amount_cents, quantity, category_hint)
  SELECT receipt_id, seq, description, amount_cents, quantity, category_hint FROM _m6_items;
INSERT INTO receipt_matches (id, receipt_id, txn_id, group_key, rule, share_cents, score, status, proposed_category_id, txn_updated_at,
  created_at, decided_at, decided_by)
  SELECT id, receipt_id, txn_id, group_key, rule, share_cents, score, status, proposed_category_id, txn_updated_at,
  created_at, decided_at, decided_by FROM _m6_matches;

-- 6. Guard: the restored tables must equal the copies (same counts, and no copy row missing or different), and the copies must
--    equal the counts taken before anything was dropped. A failed CHECK fails the INSERT and so the file. NULLs compare equal in
--    EXCEPT, and every table has a unique key, so equal counts plus an empty EXCEPT means equal contents.
INSERT INTO _m6_check (ok)
  SELECT (SELECT count(*) FROM _m6_receipts) = c.r AND (SELECT count(*) FROM receipts) = c.r
     AND (SELECT count(*) FROM _m6_items) = c.i AND (SELECT count(*) FROM receipt_items) = c.i
     AND (SELECT count(*) FROM _m6_matches) = c.m AND (SELECT count(*) FROM receipt_matches) = c.m
     AND (SELECT count(*) FROM receipt_matches WHERE status = 'applied') = c.a
     AND (SELECT count(*) FROM (SELECT * FROM _m6_receipts EXCEPT SELECT id, connection_id, gmail_msg_id, email_date, status, attempts, error_code, kind, sender_domain, merchant,
            payment_via, card_last4, order_ref, receipt_date, related_date, currency, total_cents, tax_cents, shipping_cents, charges_json, extract_model,
            created_at, updated_at, updated_by FROM receipts)) = 0
     AND (SELECT count(*) FROM (SELECT * FROM _m6_items EXCEPT SELECT receipt_id, seq, description, amount_cents, quantity, category_hint FROM receipt_items)) = 0
     AND (SELECT count(*) FROM (SELECT * FROM _m6_matches EXCEPT SELECT id, receipt_id, txn_id, group_key, rule, share_cents, score, status, proposed_category_id, txn_updated_at,
            created_at, decided_at, decided_by FROM receipt_matches)) = 0
  FROM _m6_counts c;

-- 7. Clean up (only reached when the guard passed).
DROP TABLE _m6_check;
DROP TABLE _m6_counts;
DROP TABLE _m6_matches;
DROP TABLE _m6_items;
DROP TABLE _m6_receipts;
--
-- ROLLBACK (not a second .sql file: wrangler applies every .sql in this directory). Code from before 0006 runs unchanged on
-- 0006, so reverting code needs no schema rollback. Roll back only to remove the columns, and only after the upload code is
-- reverted. Take a Time Travel bookmark first. The SQL between the two markers (leading "-- " removed) is ONE batch, in this
-- order; a test runs it. It deletes the upload rows (their items and matches cascade; a category already applied to a bank row from
-- an upload stays, as an ordinary audited edit), does the same aside / drop children / drop parent / re-create dance back to 0004's
-- DDL text, and un-records the migration so a later `migrations apply` runs 0006 again. Empty the image bucket separately.
-- Last resort: wrangler d1 time-travel restore gss-budget --bookmark <bookmark taken before 0006> (loses every write after it).
-- ROLLBACK-SQL-BEGIN
-- DELETE FROM receipts WHERE source = 'upload';
-- CREATE TABLE _m6_receipts AS SELECT id, connection_id, gmail_msg_id, email_date, status, attempts, error_code, kind, sender_domain, merchant,
--   payment_via, card_last4, order_ref, receipt_date, related_date, currency, total_cents, tax_cents, shipping_cents, charges_json, extract_model,
--   created_at, updated_at, updated_by FROM receipts;
-- CREATE TABLE _m6_items AS SELECT receipt_id, seq, description, amount_cents, quantity, category_hint FROM receipt_items;
-- CREATE TABLE _m6_matches AS SELECT id, receipt_id, txn_id, group_key, rule, share_cents, score, status, proposed_category_id, txn_updated_at,
--   created_at, decided_at, decided_by FROM receipt_matches;
-- DROP TABLE receipt_matches;
-- DROP TABLE receipt_items;
-- DROP TABLE receipts;
-- CREATE TABLE receipts (
--   id              TEXT PRIMARY KEY CHECK (id GLOB 'r[0-9a-f]*' AND length(id) = 17 AND substr(id, 2) NOT GLOB '*[^0-9a-f]*'),
--   connection_id   TEXT NOT NULL REFERENCES email_connections(id) ON DELETE CASCADE,
--   gmail_msg_id    TEXT NOT NULL CHECK (length(gmail_msg_id) BETWEEN 8 AND 32 AND gmail_msg_id NOT GLOB '*[^0-9a-f]*'),
--   email_date      TEXT NOT NULL CHECK (email_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(email_date) IS email_date),
--   status          TEXT NOT NULL CHECK (status IN ('pending','skipped','error','no_total','unmatched','suggested','applied','dismissed')),
--   attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 9),
--   error_code      TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 40 AND error_code GLOB '[a-z_]*' AND error_code NOT GLOB '*[^a-z0-9_]*')),
--   kind            TEXT CHECK (kind IS NULL OR kind IN ('purchase','refund','subscription','payment_sent','payment_received','decline','other')),
--   sender_domain   TEXT CHECK (sender_domain IS NULL OR length(sender_domain) <= 80),
--   merchant        TEXT CHECK (merchant IS NULL OR length(merchant) <= 80),                       -- digits masked (maskDigits)
--   payment_via     TEXT CHECK (payment_via IS NULL OR payment_via IN ('card','paypal','venmo','apple','amazon','google','bank','other')),
--   card_last4      TEXT CHECK (card_last4 IS NULL OR (length(card_last4) = 4 AND card_last4 GLOB '[0-9][0-9][0-9][0-9]')),
--   order_ref       TEXT CHECK (order_ref IS NULL OR (length(order_ref) BETWEEN 1 AND 64 AND order_ref NOT GLOB '*[^A-Za-z0-9#-]*')),   -- full order number (shown to the people); a card-like value is dropped before it gets here
--   receipt_date    TEXT CHECK (receipt_date IS NULL OR (receipt_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(receipt_date) IS receipt_date)),
--   related_date    TEXT CHECK (related_date IS NULL OR (related_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(related_date) IS related_date)),
--   currency        TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]')),
--   total_cents     INTEGER CHECK (total_cents IS NULL OR (typeof(total_cents) = 'integer' AND total_cents BETWEEN 0 AND 100000000)),
--   tax_cents       INTEGER CHECK (tax_cents IS NULL OR (typeof(tax_cents) = 'integer' AND tax_cents BETWEEN 0 AND 100000000)),
--   shipping_cents  INTEGER CHECK (shipping_cents IS NULL OR (typeof(shipping_cents) = 'integer' AND shipping_cents BETWEEN 0 AND 100000000)),
--   -- stated split charges: a JSON array. The CASE keeps json_type from running on text that is not JSON.
--   charges_json    TEXT CHECK (charges_json IS NULL OR (length(charges_json) <= 400
--                     AND CASE WHEN json_valid(charges_json) THEN json_type(charges_json) = 'array' ELSE 0 END)),
--   extract_model   TEXT CHECK (extract_model IS NULL OR length(extract_model) <= 64),
--   created_at      TEXT NOT NULL,
--   updated_at      TEXT NOT NULL,
--   updated_by      TEXT NOT NULL,
--   UNIQUE (connection_id, gmail_msg_id)                                                            -- dedupe; also serves the pre-check and the cascade from email_connections
-- );
-- CREATE INDEX idx_rcpt_review ON receipts (connection_id, status, email_date, id);            -- review list, keyset paging; scanned backward for ORDER BY email_date DESC, id DESC
-- CREATE INDEX idx_rcpt_open   ON receipts (connection_id, coalesce(receipt_date, email_date)) WHERE status IN ('unmatched','suggested');   -- re-match window; queries must use this exact expression
-- CREATE INDEX idx_rcpt_order  ON receipts (connection_id, order_ref) WHERE order_ref IS NOT NULL;   -- refund-original and sibling lookups
-- CREATE INDEX idx_rcpt_retry  ON receipts (connection_id, attempts) WHERE status IN ('pending','error');
-- CREATE TABLE receipt_items (
--   receipt_id    TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
--   seq           INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 20),
--   description   TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
--   amount_cents  INTEGER CHECK (amount_cents IS NULL OR (typeof(amount_cents) = 'integer' AND amount_cents BETWEEN -100000000 AND 100000000)),
--   quantity      INTEGER CHECK (quantity IS NULL OR (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 999)),
--   category_hint TEXT REFERENCES categories(id) ON DELETE SET NULL,
--   PRIMARY KEY (receipt_id, seq)
-- ) WITHOUT ROWID;
-- CREATE TABLE receipt_matches (
--   id             INTEGER PRIMARY KEY,
--   receipt_id     TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
--   txn_id         TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,                     -- a deleted load row drops its matches
--   group_key      TEXT NOT NULL CHECK (length(group_key) BETWEEN 1 AND 40),                        -- rows of one split proposal share it
--   rule           TEXT NOT NULL CHECK (rule IN ('exact','split_charges','split_receipts','refund','decline_retry')),
--   share_cents    INTEGER NOT NULL CHECK (typeof(share_cents) = 'integer' AND share_cents BETWEEN -100000000 AND 100000000),
--   score          INTEGER NOT NULL CHECK (typeof(score) = 'integer' AND score BETWEEN 0 AND 100),
--   status         TEXT NOT NULL CHECK (status IN ('suggested','applied','rejected','superseded')),
--   proposed_category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
--   txn_updated_at TEXT NOT NULL,                                                                   -- the row's updated_at when proposed
--   created_at     TEXT NOT NULL,
--   decided_at     TEXT,
--   decided_by     TEXT,
--   UNIQUE (receipt_id, txn_id)
-- );
-- CREATE INDEX idx_match_txn     ON receipt_matches (txn_id, status);
-- CREATE UNIQUE INDEX idx_match_applied ON receipt_matches (txn_id) WHERE status = 'applied';
-- CREATE TRIGGER trg_match_applied_gone AFTER DELETE ON receipt_matches
-- WHEN OLD.status = 'applied'
-- BEGIN
--   UPDATE receipts SET status = 'unmatched', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by = 'db:match_deleted'
--    WHERE id = OLD.receipt_id AND status = 'applied'
--      AND NOT EXISTS (SELECT 1 FROM receipt_matches m WHERE m.receipt_id = OLD.receipt_id AND m.status = 'applied');
-- END;
-- INSERT INTO receipts SELECT * FROM _m6_receipts;
-- INSERT INTO receipt_items SELECT * FROM _m6_items;
-- INSERT INTO receipt_matches SELECT * FROM _m6_matches;
-- DROP TABLE _m6_matches;
-- DROP TABLE _m6_items;
-- DROP TABLE _m6_receipts;
-- DELETE FROM d1_migrations WHERE name = '0006_receipt_uploads.sql';
-- ROLLBACK-SQL-END
