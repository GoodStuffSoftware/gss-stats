-- Database gss-budget, binding BUDGET_DB.
-- Applied manually once (see docs/adr/0007-budget-section.md).
-- Private data never lives in this file; schema only.
-- people: the person filter. Labels live only here (private DB), never in code.
CREATE TABLE people (
  id    TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9]*' AND length(id) BETWEEN 1 AND 24),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  sort  INTEGER NOT NULL DEFAULT 0
);
-- accounts: one row per statement account and per payment-only debt. last4 only, ever.
CREATE TABLE accounts (
  id                 TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9-]*' AND length(id) BETWEEN 1 AND 32),
  label              TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  kind               TEXT NOT NULL CHECK (kind IN ('checking','savings','card','loan','line_of_credit','external_debt')),
  person_id          TEXT REFERENCES people(id),          -- NULL = shared (shows under every person)
  last4              TEXT CHECK (last4 IS NULL OR (length(last4) = 4 AND last4 GLOB '[0-9][0-9][0-9][0-9]')),
  is_debt            INTEGER NOT NULL DEFAULT 0 CHECK (is_debt IN (0,1)),
  in_spending        INTEGER NOT NULL DEFAULT 1 CHECK (in_spending IN (0,1)),
  credit_limit_cents INTEGER CHECK (credit_limit_cents IS NULL OR credit_limit_cents >= 0),
  apr_bp             INTEGER CHECK (apr_bp IS NULL OR apr_bp BETWEEN 0 AND 10000),  -- manual rate, external debts
  sort               INTEGER NOT NULL DEFAULT 0,
  archived           INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);
-- categories: generic set seeded here (public words); more come from the private seed.
CREATE TABLE categories (
  id       TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9-]*' AND length(id) BETWEEN 1 AND 32),
  label    TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  color    TEXT CHECK (color IS NULL OR color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  sort     INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);
INSERT INTO categories (id, label, sort) VALUES
 ('groceries','Groceries',10),('fuel','Fuel',20),('dining','Dining',30),('housing','Housing',40),
 ('utilities','Utilities',50),('insurance','Insurance',60),('shopping','Shopping',70),('health','Health',80),
 ('transport','Transport',90),('subscriptions','Subscriptions',100),('kids','Kids',110),('gifts','Gifts & giving',120),
 ('cash','Cash',130),('fees','Fees',140),('travel','Travel',150),('other','Other',990);
-- imports: one row per load (API call or SQL file), so a bad load can be found and removed.
CREATE TABLE imports (
  id           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  source_label TEXT NOT NULL CHECK (length(source_label) <= 64),
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  rows_in      INTEGER NOT NULL CHECK (rows_in >= 0)
);
-- statements: header facts per account per period; the debt history and debt-pie balance come from here.
CREATE TABLE statements (
  account_id            TEXT NOT NULL REFERENCES accounts(id),
  period_end            TEXT NOT NULL,
  period_start          TEXT NOT NULL,
  import_id             TEXT REFERENCES imports(id),
  opening_balance_cents INTEGER,
  closing_balance_cents INTEGER,          -- debt accounts: amount owed, positive
  credit_limit_cents    INTEGER, apr_bp INTEGER, apr2_bp INTEGER,   -- apr2 = cash/second rate
  interest_cents        INTEGER, fees_cents INTEGER, principal_paid_cents INTEGER,
  advances_cents        INTEGER, min_due_cents INTEGER, due_date TEXT,
  CHECK (period_start <= period_end),
  PRIMARY KEY (account_id, period_end)    -- serves "history of one account by date"
) WITHOUT ROWID;
-- merchant_rules: private rules (seeded from a file outside the repo, or made from an edit).
-- id = 'r' + 16 hex of sha256(merchant_key|store_no|account_id|min|max): deterministic, so upserts need no lookup.
CREATE TABLE merchant_rules (
  id               TEXT PRIMARY KEY CHECK (length(id) = 17),
  merchant_key     TEXT NOT NULL CHECK (length(merchant_key) BETWEEN 1 AND 80),
  store_no         TEXT,                  -- exact, as normalized; NULL = any store
  account_id       TEXT REFERENCES accounts(id),
  amount_min_cents INTEGER, amount_max_cents INTEGER,   -- on |amount|; NULL = open
  set_category_id  TEXT REFERENCES categories(id),
  set_kind         TEXT,
  debt_account_id  TEXT REFERENCES accounts(id),        -- payments to a payment-only debt
  display_name     TEXT CHECK (display_name IS NULL OR length(display_name) <= 60),
  confidence       INTEGER NOT NULL DEFAULT 90 CHECK (confidence BETWEEN 0 AND 100),
  review           INTEGER NOT NULL DEFAULT 0 CHECK (review IN (0,1)),
  review_reason    TEXT,
  source           TEXT NOT NULL CHECK (source IN ('seed','edit')),
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  CHECK (set_category_id IS NOT NULL OR set_kind IS NOT NULL OR review = 1),
  CHECK (amount_min_cents IS NULL OR amount_max_cents IS NULL OR amount_min_cents <= amount_max_cents)
);
CREATE INDEX idx_rules_merchant ON merchant_rules (merchant_key) WHERE active = 1;
-- transactions: id = dedupe key (32 hex). INSERT ... ON CONFLICT(id) DO NOTHING makes re-import idempotent
-- and can never touch an existing row, so a manual edit survives any re-import.
CREATE TABLE transactions (
  id                 TEXT PRIMARY KEY CHECK (length(id) = 32),
  account_id         TEXT NOT NULL REFERENCES accounts(id),
  statement_end      TEXT,
  import_id          TEXT NOT NULL REFERENCES imports(id),
  posted_date        TEXT NOT NULL CHECK (posted_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  txn_date           TEXT,
  amount_cents       INTEGER NOT NULL,      -- sign rule in types.ts
  description        TEXT NOT NULL CHECK (length(description) <= 300),   -- masked (maskDigits)
  merchant_key       TEXT NOT NULL DEFAULT '',
  merchant_name      TEXT NOT NULL DEFAULT '',
  store_no           TEXT,
  counterparty_last4 TEXT,
  bank_ref           TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('spend','refund','fee','income','interest_earned','interest_charged',
                       'transfer','transfer_external','overdraft_move','card_payment','loan_payment','loan_advance','debt_payment','other')),
  kind_source        TEXT NOT NULL CHECK (kind_source IN ('manual','rule','auto','hint')),
  category_id        TEXT REFERENCES categories(id),
  category_source    TEXT NOT NULL CHECK (category_source IN ('manual','rule','auto','none')),
  rule_id            TEXT REFERENCES merchant_rules(id) ON DELETE SET NULL,
  confidence         INTEGER NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  needs_review       INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
  review_reason      TEXT,
  pair_id            TEXT,                  -- other side of an own-account move (no FK: may arrive later)
  debt_account_id    TEXT REFERENCES accounts(id),
  principal_cents    INTEGER, interest_cents INTEGER,
  note               TEXT CHECK (note IS NULL OR length(note) <= 500),
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE INDEX idx_txn_date     ON transactions (posted_date, id);                 -- table default, keyset paging, MIN/MAX
CREATE INDEX idx_txn_kind     ON transactions (kind, posted_date);               -- pie level 0, pairing candidates
CREATE INDEX idx_txn_cat      ON transactions (category_id, posted_date);        -- pie level 1, table category filter
CREATE INDEX idx_txn_merchant ON transactions (merchant_key, posted_date);       -- pie level 2, rule re-apply
CREATE INDEX idx_txn_account  ON transactions (account_id, posted_date);         -- duplicate check, account filter
CREATE INDEX idx_txn_review   ON transactions (posted_date) WHERE needs_review = 1;
CREATE INDEX idx_txn_debt     ON transactions (debt_account_id, posted_date, id) WHERE debt_account_id IS NOT NULL;  -- debt detail payments, newest first, no sort
CREATE INDEX idx_txn_pay      ON transactions (account_id, posted_date, id) WHERE kind IN ('card_payment','loan_payment');  -- debt detail payments, newest first, no sort
CREATE INDEX idx_txn_import   ON transactions (import_id);
-- category_edits: who changed what (undo, trust between two editors).
CREATE TABLE category_edits (
  id INTEGER PRIMARY KEY,
  txn_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  old_category_id TEXT, new_category_id TEXT, old_kind TEXT, new_kind TEXT, rule_id TEXT,
  edited_at TEXT NOT NULL, edited_by TEXT NOT NULL
);
CREATE INDEX idx_edits_txn ON category_edits (txn_id, edited_at);
-- debt_balances: typed balances for payment-only debts (or a manual override for any debt).
CREATE TABLE debt_balances (
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  as_of         TEXT NOT NULL,
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  apr_bp        INTEGER CHECK (apr_bp IS NULL OR apr_bp BETWEEN 0 AND 10000),
  entered_at TEXT NOT NULL, entered_by TEXT NOT NULL,
  PRIMARY KEY (account_id, as_of)
) WITHOUT ROWID;
