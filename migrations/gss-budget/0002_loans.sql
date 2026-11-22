-- Database gss-budget, binding BUDGET_DB. Loans page schema (docs/adr/0007-budget-section.md, Decision 9).
-- Applied manually once per environment (never by an agent or CI); record a Time Travel bookmark first.
-- Additive only: two new tables and two NULLable columns. No existing row, column, index or constraint
-- changes, so the code already deployed (which names its columns and never reads statements with *) keeps working.
-- Private data never lives in this file; schema only.
-- Note: gss-budget is shared by Preview and Production, so applying this for the preview touches production's file.
--
-- debt_terms: paperwork facts of one debt (original amount, dates, term, scheduled payment, cosigned).
-- Written only by the private load; no API route writes it. The row's account should be an is_debt = 1 account
-- (SQLite cannot CHECK another table; the load validates it).
CREATE TABLE debt_terms (
  account_id     TEXT PRIMARY KEY REFERENCES accounts(id),
  original_cents INTEGER CHECK (original_cents IS NULL OR original_cents >= 0),
  opened_on      TEXT CHECK (opened_on IS NULL OR opened_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  maturity_on    TEXT CHECK (maturity_on IS NULL OR maturity_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  term_months    INTEGER CHECK (term_months IS NULL OR term_months BETWEEN 1 AND 480),
  payment_cents  INTEGER CHECK (payment_cents IS NULL OR payment_cents >= 0),
  payment_every  TEXT CHECK (payment_every IS NULL OR payment_every IN ('monthly','semimonthly','biweekly')),
  cosigned       INTEGER NOT NULL DEFAULT 0 CHECK (cosigned IN (0,1)),
  updated_at     TEXT NOT NULL,
  updated_by     TEXT NOT NULL,
  CHECK (payment_cents IS NULL OR payment_every IS NOT NULL),            -- a payment needs its cadence to become a monthly figure
  CHECK (opened_on IS NULL OR maturity_on IS NULL OR opened_on <= maturity_on)
) WITHOUT ROWID;
-- statements: what a lender prints beyond 0001's header facts. NULL = not printed or not loaded yet.
-- (CHECKs on ADD COLUMN are allowed because the default is NULL, which each check accepts for the existing rows.)
ALTER TABLE statements ADD COLUMN escrow_cents INTEGER CHECK (escrow_cents IS NULL OR escrow_cents >= 0);
ALTER TABLE statements ADD COLUMN payoff_cents INTEGER CHECK (payoff_cents IS NULL OR payoff_cents >= 0);
-- statement_promos: promotional / deferred-interest balances printed on one statement (several per statement).
-- The foreign key names statements' whole primary key, so the parent key is valid. It is NO ACTION on purpose:
-- deleting a statement that still has promos fails loudly instead of dropping them (an INSERT OR REPLACE of the
-- same statement keeps them); the load deletes a statement's promos first and re-inserts them.
CREATE TABLE statement_promos (
  account_id     TEXT NOT NULL,
  period_end     TEXT NOT NULL,
  seq            INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 50),
  balance_cents  INTEGER NOT NULL CHECK (balance_cents >= 0),
  apr_bp         INTEGER CHECK (apr_bp IS NULL OR apr_bp BETWEEN 0 AND 10000),
  ends_on        TEXT CHECK (ends_on IS NULL OR ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  deferred_interest_cents INTEGER CHECK (deferred_interest_cents IS NULL OR deferred_interest_cents >= 0),
  PRIMARY KEY (account_id, period_end, seq),                              -- one statement's promos in order, no extra index
  FOREIGN KEY (account_id, period_end) REFERENCES statements(account_id, period_end)
) WITHOUT ROWID;
--
-- ROLLBACK (not a second .sql file: wrangler applies every .sql in this directory). Everything above is additive,
-- so code from before 0002 runs unchanged against either state; roll back only to remove the objects. Run as ONE
-- batch, in this order (statement_promos first, it references statements). DROP COLUMN needs SQLite 3.35+
-- (D1 has it) and works here because each column's only CHECK is its own.
--   DROP TABLE statement_promos;
--   DROP TABLE debt_terms;
--   ALTER TABLE statements DROP COLUMN payoff_cents;
--   ALTER TABLE statements DROP COLUMN escrow_cents;
-- Last resort, only if a DROP fails: wrangler d1 time-travel restore gss-budget --bookmark <bookmark taken before 0002>
-- (loses every write made after the bookmark).
