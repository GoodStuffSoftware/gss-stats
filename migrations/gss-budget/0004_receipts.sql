-- Database gss-budget, binding BUDGET_DB. Email receipts (docs/adr/0008-email-receipts.md).
-- Applied by hand once (never by an agent or CI); record a Time Travel bookmark first.
-- Additive only: six new tables, their indexes, one trigger and ten generic seed keywords. No existing table, column, index,
-- constraint or row changes, and the code already deployed never names these tables, so it runs unchanged against
-- either state. Private data never lives in this file; schema only (no merchant names, no addresses, no ids).
-- Note: gss-budget is shared by Preview and Production, so applying this for the preview touches production's file.
--
-- Facts the constraints below rely on (checked, not assumed):
--   * Foreign keys: D1 enforces them (PRAGMA foreign_keys is always on; a statement or batch that violates one fails with
--     FOREIGN KEY constraint failed, and D1 does not let a script turn it off). So the ON DELETE CASCADE chains below act
--     in production, not just in the tests. The test database turns the pragma on too (budgetDb.ts), and
--     receiptsSchema.test.ts asserts it. Every cascade here is on a column that is the leading column of an index,
--     so a parent delete does not scan the child table (categories is the one exception: its SET NULL children are
--     unindexed, acceptable because a category is never deleted in normal operation).
--   * Rebuilding a parent table later (transactions, receipts, email_connections, categories: create new, copy, DROP old,
--     rename) fires these cascades on D1: DROP TABLE deletes every receipt_matches and receipt_items row and sets
--     category_hint and proposed_category_id to NULL, and neither PRAGMA defer_foreign_keys nor a pragma off stops it.
--     A later rebuild of a parent table must copy the 0004 child rows aside and restore them, or rebuild the children
--     in the same migration.
--   * json_valid / json_type: D1 builds in SQLite's JSON functions (listed in the D1 "Query JSON" docs), so json_valid
--     works inside a CHECK. A CHECK may call only deterministic functions: json_valid, json_type, date, length, lower,
--     instr and GLOB all qualify.
--   * GLOB is case sensitive and has no repeat operator, so 'c[0-9a-f]*' checks only the second character; the ids
--     below therefore pair a fixed length with a NOT GLOB '*[^0-9a-f]*' test to prove every character is hex.
--
-- email_connections: one Gmail connection per Budget login. The refresh token is AES-GCM ciphertext only
-- (key in a Cloudflare secret, AAD = id); no plaintext token ever lands here. An unusable connection
-- (needs_reconnect, revoked) holds no token material at all: token_ct, token_iv and key_id are all NULL.
CREATE TABLE email_connections (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'c[0-9a-f]*' AND length(id) = 17 AND substr(id, 2) NOT GLOB '*[^0-9a-f]*'),   -- opaque, random
  owner_email      TEXT NOT NULL UNIQUE CHECK (owner_email = lower(owner_email) AND instr(owner_email, '@') > 1 AND instr(owner_email, '@') < length(owner_email) AND length(owner_email) <= 254),
  google_sub       TEXT NOT NULL CHECK (length(google_sub) BETWEEN 1 AND 255),                     -- Google allows up to 255 ASCII characters
  person_id        TEXT REFERENCES people(id),                                                     -- NULL = not tied to a person filter
  status           TEXT NOT NULL CHECK (status IN ('active','needs_reconnect','paused','revoked')),
  token_ct         TEXT CHECK (token_ct IS NULL OR (length(token_ct) BETWEEN 1 AND 2048 AND token_ct NOT GLOB '*[^A-Za-z0-9+/=]*')),          -- base64 ciphertext + tag
  token_iv         TEXT CHECK (token_iv IS NULL OR (length(token_iv) = 16 AND token_iv NOT GLOB '*[^A-Za-z0-9+/=]*')),                         -- base64 of 12 bytes
  key_id           TEXT CHECK (key_id IS NULL OR (length(key_id) = 8 AND key_id NOT GLOB '*[^0-9a-f]*')),   -- first 8 hex of sha256(key)
  scopes           TEXT NOT NULL CHECK (length(scopes) BETWEEN 1 AND 512),
  consent_version  INTEGER NOT NULL CHECK (consent_version >= 1),
  consented_at     TEXT NOT NULL,
  watermark_at     TEXT,                    -- newest email date fully processed (ISO); the next list uses after: watermark - 2 days
  last_run_at      TEXT,
  last_ok_at       TEXT,
  last_error       TEXT CHECK (last_error IS NULL OR (length(last_error) BETWEEN 1 AND 40 AND last_error GLOB '[a-z_]*' AND last_error NOT GLOB '*[^a-z0-9_]*')),   -- a code, never text from Google or mail
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK ((status IN ('active','paused') AND token_ct IS NOT NULL AND token_iv IS NOT NULL AND key_id IS NOT NULL)
      OR (status IN ('needs_reconnect','revoked') AND token_ct IS NULL AND token_iv IS NULL AND key_id IS NULL))
);

-- receipt_queries: the Gmail search terms (senders and keywords). Data, not code: the private seed or a SQL file
-- adds senders; only generic keywords are seeded here (public repo: no merchant names).
CREATE TABLE receipt_queries (
  id     INTEGER PRIMARY KEY,
  kind   TEXT NOT NULL CHECK (kind IN ('from','subject','exclude_from')),
  value  TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 100 AND value NOT GLOB '*[(){}"]*'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (kind, value)
);
INSERT INTO receipt_queries (kind, value) VALUES
 ('subject','receipt'),('subject','order confirmation'),('subject','your order'),('subject','invoice'),
 ('subject','payment received'),('subject','you paid'),('subject','you sent'),('subject','refund'),
 ('subject','has shipped'),('subject','payment declined');

-- receipts: extracted fields of one email, never its body or subject. gmail_msg_id = Gmail's opaque message id
-- (hex): the dedupe key and the only thing the "Open in Gmail" link carries. Never logged.
-- Dates are real calendar dates: the GLOB fixes the shape and date(x) IS x rejects 2026-02-30 and 2026-19-39 (IS, not =:
-- date() answers NULL for an impossible month, NULL = x is NULL, and a CHECK that evaluates to NULL passes).
CREATE TABLE receipts (
  id              TEXT PRIMARY KEY CHECK (id GLOB 'r[0-9a-f]*' AND length(id) = 17 AND substr(id, 2) NOT GLOB '*[^0-9a-f]*'),
  connection_id   TEXT NOT NULL REFERENCES email_connections(id) ON DELETE CASCADE,
  gmail_msg_id    TEXT NOT NULL CHECK (length(gmail_msg_id) BETWEEN 8 AND 32 AND gmail_msg_id NOT GLOB '*[^0-9a-f]*'),
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
  UNIQUE (connection_id, gmail_msg_id)                                                            -- dedupe; also serves the pre-check and the cascade from email_connections
);
CREATE INDEX idx_rcpt_review ON receipts (connection_id, status, email_date, id);            -- review list, keyset paging; scanned backward for ORDER BY email_date DESC, id DESC
CREATE INDEX idx_rcpt_open   ON receipts (connection_id, coalesce(receipt_date, email_date)) WHERE status IN ('unmatched','suggested');   -- re-match window; queries must use this exact expression
CREATE INDEX idx_rcpt_order  ON receipts (connection_id, order_ref) WHERE order_ref IS NOT NULL;   -- refund-original and sibling lookups
CREATE INDEX idx_rcpt_retry  ON receipts (connection_id, attempts) WHERE status IN ('pending','error');

-- receipt_items: line items (masked description, at most 20 per receipt).
CREATE TABLE receipt_items (
  receipt_id    TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 20),
  description   TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
  amount_cents  INTEGER CHECK (amount_cents IS NULL OR (typeof(amount_cents) = 'integer' AND amount_cents BETWEEN -100000000 AND 100000000)),
  quantity      INTEGER CHECK (quantity IS NULL OR (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 999)),
  category_hint TEXT REFERENCES categories(id) ON DELETE SET NULL,
  PRIMARY KEY (receipt_id, seq)
) WITHOUT ROWID;

-- receipt_matches: a proposed or applied link from a receipt to a bank row. group_key ties the rows of one split
-- proposal (one order charged several times, or several receipts summed into one charge).
-- idx_match_applied allows ONE applied match per bank row, so a bank row carries at most one receipt's category and
-- link. Several receipts summed into one charge (split_receipts) can therefore have only one of them applied; the
-- others stay suggested or are dismissed. If that proves too strict, relaxing a unique index later is a safe
-- migration (dropping it cannot fail on data), whereas adding a stricter one later could fail on rows already there.
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
-- A deleted bank row cascades away its applied match; this puts the receipt back to unmatched so it can match again.
-- Un-applying by UPDATE (rejected, superseded) does not fire it: the apply/undo code sets the receipt status itself.
CREATE TRIGGER trg_match_applied_gone AFTER DELETE ON receipt_matches
WHEN OLD.status = 'applied'
BEGIN
  UPDATE receipts SET status = 'unmatched', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by = 'db:match_deleted'
   WHERE id = OLD.receipt_id AND status = 'applied'
     AND NOT EXISTS (SELECT 1 FROM receipt_matches m WHERE m.receipt_id = OLD.receipt_id AND m.status = 'applied');
END;

-- receipt_sync_runs: one row per Worker run per connection (counts and codes only). The Worker keeps the newest 200.
CREATE TABLE receipt_sync_runs (
  id            INTEGER PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES email_connections(id) ON DELETE CASCADE,
  trigger       TEXT NOT NULL CHECK (trigger IN ('cron','manual','backfill')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  listed INTEGER NOT NULL DEFAULT 0, fetched INTEGER NOT NULL DEFAULT 0, extracted INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0, auto_applied INTEGER NOT NULL DEFAULT 0,
  model_in_tokens INTEGER NOT NULL DEFAULT 0, model_out_tokens INTEGER NOT NULL DEFAULT 0,
  error_code    TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 40 AND error_code GLOB '[a-z_]*' AND error_code NOT GLOB '*[^a-z0-9_]*')),
  CHECK (listed >= 0 AND fetched >= 0 AND extracted >= 0 AND skipped >= 0 AND matched >= 0 AND auto_applied >= 0
     AND model_in_tokens >= 0 AND model_out_tokens >= 0)
);
CREATE INDEX idx_runs_conn ON receipt_sync_runs (connection_id, id DESC);
--
-- ROLLBACK (not a second .sql file: wrangler applies every .sql in this directory). Additive, so code from before 0004
-- runs unchanged against either state; roll back only to remove the objects, and only after the code that reads them
-- is reverted (it names these tables and would answer 500). Run as ONE batch, in this order (children first; the last
-- statement un-records the migration, so a later `migrations apply` re-creates the tables; without it they stay missing):
--   DROP TABLE receipt_sync_runs;
--   DROP TABLE receipt_matches;
--   DROP TABLE receipt_items;
--   DROP TABLE receipts;
--   DROP TABLE receipt_queries;
--   DROP TABLE email_connections;
--   DELETE FROM d1_migrations WHERE name = '0004_receipts.sql';
-- Dropping a table drops its indexes and triggers with it (trg_match_applied_gone goes with receipt_matches). Categories already applied to transactions stay (ordinary audited edits).
-- Notes were never written; the Receipt block disappears with the tables.
-- Last resort, only if a DROP fails: wrangler d1 time-travel restore gss-budget --bookmark <bookmark taken before 0004>
-- (loses every write made after the bookmark).
