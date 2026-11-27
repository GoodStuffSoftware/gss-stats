-- Database gss-budget, binding BUDGET_DB. Bank links through Plaid (docs/adr/0009-bank-links-plaid.md).
-- Applied by hand, once, never by CI or a build leg, after a Time Travel bookmark: by the lead once Mike says yes (as
-- for 0004), or by Mike.
-- Additive only: six new tables, their indexes, three triggers and one defaulted column on transactions. No existing
-- table, index, constraint or row changes. The deployed code names its columns on every read and write (TXN_COLUMNS,
-- the load's INSERT, the category_edits INSERTs), so it runs unchanged against either state: its INSERTs get pending = 0
-- and its reads never see the column. Private data never lives in this file; schema only (no bank names, no ids).
-- Note: gss-budget is shared by Preview and Production, so applying this for the preview touches production's file.
--
-- Facts the constraints below rely on (as in 0004): D1 enforces foreign keys, so the ON DELETE chains act in production;
-- every cascade or SET NULL child column here leads an index, so a parent delete does not scan the child table.
-- Rebuilding transactions, accounts or bank_items later (create, copy, DROP, rename) fires these cascades: copy the
-- 0005 child rows aside first. GLOB has no repeat operator, so ids pair a fixed length with NOT GLOB '*[^0-9a-f]*'.
-- Dates use date(x) IS x (IS, not =: date() of an impossible date is NULL and a NULL CHECK passes).
--
-- bank_items: one Plaid Item (one bank login). The access token is AES-GCM ciphertext only (key in the Worker's
-- Secrets Store binding, AAD = id). Plaid's update mode reuses the same access token, so needs_reconnect and
-- pending_disconnect keep it; revoked and removed hold no token material at all.
CREATE TABLE bank_items (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'i[0-9a-f]*' AND length(id) = 17 AND substr(id, 2) NOT GLOB '*[^0-9a-f]*'),
  owner_email      TEXT NOT NULL CHECK (owner_email = lower(owner_email) AND instr(owner_email, '@') > 1 AND instr(owner_email, '@') < length(owner_email) AND length(owner_email) <= 254),
  environment      TEXT NOT NULL CHECK (environment IN ('production','sandbox')),
  plaid_item_id    TEXT NOT NULL UNIQUE CHECK (length(plaid_item_id) BETWEEN 1 AND 64 AND plaid_item_id NOT GLOB '*[^A-Za-z0-9_-]*'),   -- opaque; never logged
  institution_id   TEXT CHECK (institution_id IS NULL OR (length(institution_id) BETWEEN 1 AND 32 AND institution_id NOT GLOB '*[^A-Za-z0-9_]*')),
  institution_name TEXT CHECK (institution_name IS NULL OR length(institution_name) BETWEEN 1 AND 80),              -- digits masked (maskDigits)
  status           TEXT NOT NULL CHECK (status IN ('active','needs_reconnect','pending_disconnect','revoked','removed')),
  token_ct         TEXT CHECK (token_ct IS NULL OR (length(token_ct) BETWEEN 1 AND 2048 AND token_ct NOT GLOB '*[^A-Za-z0-9+/=]*')),   -- base64 ciphertext + tag
  token_iv         TEXT CHECK (token_iv IS NULL OR (length(token_iv) = 16 AND token_iv NOT GLOB '*[^A-Za-z0-9+/=]*')),                  -- base64 of 12 bytes
  key_id           TEXT CHECK (key_id IS NULL OR (length(key_id) = 8 AND key_id NOT GLOB '*[^0-9a-f]*')),                              -- first 8 hex of sha256(key)
  sync_cursor      TEXT CHECK (sync_cursor IS NULL OR length(sync_cursor) BETWEEN 1 AND 256),                                         -- /transactions/sync next_cursor; NULL = start from the beginning
  sync_cursor_base TEXT CHECK (sync_cursor_base IS NULL OR length(sync_cursor_base) <= 256),                                          -- cursor the in-progress update began at (empty = the very start); NULL = no update in progress
  initial_done     INTEGER NOT NULL DEFAULT 0 CHECK (initial_done IN (0,1)),          -- SYNC_UPDATES_AVAILABLE initial_update_complete seen
  historical_done  INTEGER NOT NULL DEFAULT 0 CHECK (historical_done IN (0,1)),       -- historical_update_complete seen
  new_accounts     INTEGER NOT NULL DEFAULT 0 CHECK (new_accounts IN (0,1)),          -- NEW_ACCOUNTS_AVAILABLE seen; cleared by the accounts refresh after an update-mode link
  sync_requested_at TEXT,                   -- set by a webhook or Sync now; the cron clears it after a good run
  consent_version  INTEGER NOT NULL CHECK (consent_version >= 1),
  consented_at     TEXT NOT NULL,
  last_webhook_at  TEXT,
  last_sync_at     TEXT,
  last_ok_at       TEXT,
  liabilities_at   TEXT,
  last_error       TEXT CHECK (last_error IS NULL OR (length(last_error) BETWEEN 1 AND 40 AND last_error GLOB '[a-z_]*' AND last_error NOT GLOB '*[^a-z0-9_]*')),   -- a code, never Plaid text
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK ((status IN ('active','needs_reconnect','pending_disconnect') AND token_ct IS NOT NULL AND token_iv IS NOT NULL AND key_id IS NOT NULL)
      OR (status IN ('revoked','removed') AND token_ct IS NULL AND token_iv IS NULL AND key_id IS NULL AND sync_cursor IS NULL))
);
-- The cron's due pick (status IN active, pending_disconnect) and its daily needs_reconnect check (status =) both
-- search this index by status; not partial, so neither query needs a matching WHERE.
CREATE INDEX idx_bank_items_due ON bank_items (status, sync_requested_at, last_ok_at);

-- plaid_slot_log: the Trial plan allows 10 Production Items for life and removing one does not free a slot, so this
-- log is never edited or emptied. One row per exchange attempt, written BEFORE the exchange call (status 'pending',
-- which counts), set to 'done' with the item id after it, or 'failed' only when Plaid answered with an error (a
-- timeout stays 'pending' and keeps counting: overcounting is the safe side). No FK: rows outlive their Item.
CREATE TABLE plaid_slot_log (
  id            INTEGER PRIMARY KEY,
  environment   TEXT NOT NULL CHECK (environment IN ('production','sandbox')),
  status        TEXT NOT NULL CHECK (status IN ('pending','done','failed','prior')),   -- prior = an Item made outside this app (entered by hand)
  plaid_item_id TEXT CHECK (plaid_item_id IS NULL OR (length(plaid_item_id) BETWEEN 1 AND 64 AND plaid_item_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  institution_id TEXT CHECK (institution_id IS NULL OR (length(institution_id) BETWEEN 1 AND 32 AND institution_id NOT GLOB '*[^A-Za-z0-9_]*')),
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 254),
  finished_at   TEXT
);
CREATE TRIGGER trg_slot_log_no_delete BEFORE DELETE ON plaid_slot_log
BEGIN
  SELECT RAISE(ABORT, 'plaid_slot_log is append-only');
END;
-- REPLACE (and INSERT OR REPLACE) deletes the old row without firing the DELETE trigger while recursive_triggers is
-- off (the default), so an insert that reuses an existing id is refused as well.
CREATE TRIGGER trg_slot_log_no_replace BEFORE INSERT ON plaid_slot_log
WHEN EXISTS (SELECT 1 FROM plaid_slot_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'plaid_slot_log ids are never reused');
END;
-- Only pending -> done or pending -> failed, and nothing else changes.
CREATE TRIGGER trg_slot_log_one_way BEFORE UPDATE ON plaid_slot_log
WHEN OLD.status <> 'pending' OR NEW.status NOT IN ('done','failed') OR NEW.environment IS NOT OLD.environment
  OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by OR NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'plaid_slot_log rows only move from pending to done or failed');
END;

-- bank_accounts: one Plaid account of an Item. account_id is the Budget account its rows land in (an existing one
-- picked by the owner, or one made for it). sync: unmapped (new, not set up), on, off. sync_from: the first posted date
-- taken from the bank (the day after the newest row the mapped account already had); NULL = everything the bank sends.
-- name is masked (maskDigits); mask holds the last 4 digits only, or NULL.
CREATE TABLE bank_accounts (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'b[0-9a-f]*' AND length(id) = 17 AND substr(id, 2) NOT GLOB '*[^0-9a-f]*'),
  item_id          TEXT NOT NULL REFERENCES bank_items(id) ON DELETE CASCADE,
  plaid_account_id TEXT NOT NULL UNIQUE CHECK (length(plaid_account_id) BETWEEN 1 AND 64 AND plaid_account_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  account_id       TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  mask             TEXT CHECK (mask IS NULL OR (length(mask) = 4 AND mask GLOB '[0-9][0-9][0-9][0-9]')),
  type             TEXT NOT NULL CHECK (type IN ('depository','credit','loan','investment','other')),
  subtype          TEXT CHECK (subtype IS NULL OR (length(subtype) BETWEEN 1 AND 40 AND subtype NOT GLOB '*[^a-z0-9 _-]*')),
  sync             TEXT NOT NULL DEFAULT 'unmapped' CHECK (sync IN ('unmapped','on','off')),
  sync_from        TEXT CHECK (sync_from IS NULL OR (sync_from GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(sync_from) IS sync_from)),
  balance_cents    INTEGER CHECK (balance_cents IS NULL OR (typeof(balance_cents) = 'integer' AND balance_cents BETWEEN -10000000000 AND 10000000000)),
  available_cents  INTEGER CHECK (available_cents IS NULL OR (typeof(available_cents) = 'integer' AND available_cents BETWEEN -10000000000 AND 10000000000)),
  limit_cents      INTEGER CHECK (limit_cents IS NULL OR (typeof(limit_cents) = 'integer' AND limit_cents BETWEEN 0 AND 10000000000)),
  balance_as_of    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (sync <> 'on' OR account_id IS NOT NULL)
);
CREATE INDEX idx_bank_acct_item ON bank_accounts (item_id);
CREATE INDEX idx_bank_acct_budget ON bank_accounts (account_id);                                 -- SET NULL from accounts
-- One bank feed per Budget account; also the lookup behind the statement-load guard (sqlFile.ts txnSql).
CREATE UNIQUE INDEX idx_bank_acct_on ON bank_accounts (account_id) WHERE sync = 'on';

-- bank_txns: which Plaid transaction a Budget row stands for. role inserted = sync wrote the row; matched = the row came
-- from a statement file and sync only claimed it (sync never writes a matched row). state dropped = Plaid removed it but a
-- person had edited the row, so it waits for a person (Banks page: Delete or Keep); kept = a person kept it.
-- dup_of = the statement row a flagged (possible_duplicate) insert may repeat. One claim per Budget row (idx_bank_txn_txn).
CREATE TABLE bank_txns (
  plaid_txn_id    TEXT PRIMARY KEY CHECK (length(plaid_txn_id) BETWEEN 1 AND 64 AND plaid_txn_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  txn_id          TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('inserted','matched')),
  state           TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live','dropped','kept')),
  dup_of          TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  seen_at         TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (state = 'live' OR role = 'inserted'),
  CHECK (dup_of IS NULL OR (role = 'inserted' AND dup_of <> txn_id))
);
CREATE UNIQUE INDEX idx_bank_txn_txn ON bank_txns (txn_id);
CREATE INDEX idx_bank_txn_acct ON bank_txns (bank_account_id);
CREATE INDEX idx_bank_txn_dup  ON bank_txns (dup_of);
CREATE INDEX idx_bank_txn_dropped ON bank_txns (state, bank_account_id) WHERE state = 'dropped';

-- bank_liabilities: the newest /liabilities/get snapshot per bank account, typed fields only. Never the account number,
-- property address, servicer address or payment reference Plaid also returns.
CREATE TABLE bank_liabilities (
  bank_account_id              TEXT PRIMARY KEY REFERENCES bank_accounts(id) ON DELETE CASCADE,
  kind                         TEXT NOT NULL CHECK (kind IN ('credit','mortgage','student')),
  apr_bp                       INTEGER CHECK (apr_bp IS NULL OR apr_bp BETWEEN 0 AND 10000),          -- credit: purchase APR; mortgage/student: interest rate
  min_due_cents                INTEGER CHECK (min_due_cents IS NULL OR (typeof(min_due_cents) = 'integer' AND min_due_cents BETWEEN 0 AND 10000000000)),
  next_due_date                TEXT CHECK (next_due_date IS NULL OR (next_due_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(next_due_date) IS next_due_date)),
  last_statement_date          TEXT CHECK (last_statement_date IS NULL OR (last_statement_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(last_statement_date) IS last_statement_date)),
  last_statement_balance_cents INTEGER CHECK (last_statement_balance_cents IS NULL OR (typeof(last_statement_balance_cents) = 'integer' AND last_statement_balance_cents BETWEEN -10000000000 AND 10000000000)),
  last_payment_cents           INTEGER CHECK (last_payment_cents IS NULL OR (typeof(last_payment_cents) = 'integer' AND last_payment_cents BETWEEN 0 AND 10000000000)),
  last_payment_date            TEXT CHECK (last_payment_date IS NULL OR (last_payment_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(last_payment_date) IS last_payment_date)),
  is_overdue                   INTEGER CHECK (is_overdue IS NULL OR is_overdue IN (0,1)),
  past_due_cents               INTEGER CHECK (past_due_cents IS NULL OR (typeof(past_due_cents) = 'integer' AND past_due_cents BETWEEN 0 AND 10000000000)),
  next_monthly_payment_cents   INTEGER CHECK (next_monthly_payment_cents IS NULL OR (typeof(next_monthly_payment_cents) = 'integer' AND next_monthly_payment_cents BETWEEN 0 AND 10000000000)),
  escrow_cents                 INTEGER CHECK (escrow_cents IS NULL OR (typeof(escrow_cents) = 'integer' AND escrow_cents BETWEEN 0 AND 10000000000)),
  origination_date             TEXT CHECK (origination_date IS NULL OR (origination_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(origination_date) IS origination_date)),
  origination_cents            INTEGER CHECK (origination_cents IS NULL OR (typeof(origination_cents) = 'integer' AND origination_cents BETWEEN 0 AND 10000000000)),
  maturity_date                TEXT CHECK (maturity_date IS NULL OR (maturity_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(maturity_date) IS maturity_date)),
  expected_payoff_date         TEXT CHECK (expected_payoff_date IS NULL OR (expected_payoff_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(expected_payoff_date) IS expected_payoff_date)),
  ytd_interest_cents           INTEGER CHECK (ytd_interest_cents IS NULL OR (typeof(ytd_interest_cents) = 'integer' AND ytd_interest_cents BETWEEN 0 AND 10000000000)),
  ytd_principal_cents          INTEGER CHECK (ytd_principal_cents IS NULL OR (typeof(ytd_principal_cents) = 'integer' AND ytd_principal_cents BETWEEN 0 AND 10000000000)),
  fetched_at                   TEXT NOT NULL
) WITHOUT ROWID;

-- bank_sync_runs: one row per Worker sync of an Item (counts and codes only). The Worker keeps the newest 200 per Item.
CREATE TABLE bank_sync_runs (
  id          INTEGER PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES bank_items(id) ON DELETE CASCADE,
  run_trigger TEXT NOT NULL CHECK (run_trigger IN ('webhook','cron','manual','initial','resync')),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  pages INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0, modified INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0, posted INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  error_code  TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 40 AND error_code GLOB '[a-z_]*' AND error_code NOT GLOB '*[^a-z0-9_]*')),
  CHECK (pages >= 0 AND added >= 0 AND modified >= 0 AND removed >= 0 AND inserted >= 0 AND matched >= 0
     AND flagged >= 0 AND posted >= 0 AND dropped >= 0 AND skipped >= 0)
);
CREATE INDEX idx_bank_runs_item ON bank_sync_runs (item_id, id DESC);

-- transactions.pending: 1 while the bank still shows the row as pending (only sync sets it; a load inserts 0).
ALTER TABLE transactions ADD COLUMN pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0,1));
--
-- ROLLBACK (not a second .sql file: wrangler applies every .sql in this directory). Additive, so code from before 0005
-- runs unchanged against either state; roll back only after the code that names these objects is reverted (it would
-- answer 500), and unlink every Item first (/item/remove) so no access token is orphaned. Bank-inserted transactions
-- stay as ordinary rows unless removed first with
--   DELETE FROM transactions WHERE id IN (SELECT txn_id FROM bank_txns WHERE role = 'inserted');
-- Then run as ONE batch, in this order (children first; the last statement un-records the migration):
--   DROP TABLE bank_sync_runs;
--   DROP TABLE bank_liabilities;
--   DROP TABLE bank_txns;
--   DROP TABLE bank_accounts;
--   DROP TABLE plaid_slot_log;
--   DROP TABLE bank_items;
--   ALTER TABLE transactions DROP COLUMN pending;
--   DELETE FROM d1_migrations WHERE name = '0005_bank_links.sql';
-- Dropping plaid_slot_log loses the slot count: copy `SELECT * FROM plaid_slot_log` aside first and re-insert it after a
-- re-apply (Plaid's own count never resets). Dropping a table drops its indexes and triggers with it.
-- Last resort, only if a DROP fails: wrangler d1 time-travel restore gss-budget --bookmark <bookmark taken before 0005>
-- (loses every write made after the bookmark).
