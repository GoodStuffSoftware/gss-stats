# ADR 0007: A Budget section with its own database, list and privacy rules

- **Status:** Accepted (2026-11-20)
- **Date:** 2026-11-20
- **Amends:** [ADR 0002](0002-google-auth.md) (a second allowlist, listed-viewer writes under
  `/api/budget/*`); one row added to [ADR 0005](0005-retire-bespoke-widgets.md)'s Exceptions.

## Context

The household wants one place in the dashboard to see where money goes: a spending pie that drills
from category to merchant to purchase, a debt pie with each debt's balance, rate and interest over
time, and an editable transaction table whose edits teach later categorizing. The data is bank
statements: the most sensitive thing this project has ever held, in a repository that is public.

The dashboard's other data is traffic counts, kept in shared stores behind the owner and view-only
roles. Bank data needs a narrower circle than "everyone who may read traffic", it must be editable by
the people it belongs to even when they are view-only accounts for the traffic dashboard, and a
mistake in the budget code must not be able to reach the traffic stores (or the other way round).

## Decisions

1. **A code-defined section outside the shared layout.** Budget is opened with `?section=budget`
   and drawn by its own components; it is not a page of widgets in the layout stored in KV, so it
   writes no layout and never bumps `CONFIG_VERSION`. This is consistent with ADR 0005: that rule
   keeps one-off *data blocks* out of the layout editor's widgets; Budget is not a widget and adds
   no bespoke block. Its pieces are reusable components (a drill-down pie, a breadcrumb, an editable
   table, the existing line chart) that the layout editor can adopt later. The section can be removed by
   deleting its folders and one route group, with nothing stored in the dashboard to migrate.
2. **A separate database, `gss-budget` (binding `BUDGET_DB`).** Its own D1 database, its own
   migrations directory (`migrations/gss-budget/`), bound at the top level and in `[env.preview]`
   of `wrangler.toml`. Nothing else binds it, so a bug in geo, ads or metrics code cannot read it
   and a restore of it touches nothing else. The schema is applied by hand once per environment;
   before the first remote migration the operator records a Time Travel bookmark
   (`wrangler d1 time-travel info gss-budget`). On an empty database that protects nothing, so the
   real backup of a load is the private SQL file it came from; the habit is for later migrations.
3. **A budget allowlist secret, `BUDGET_ALLOWED_EMAILS`.** See the ADR 0002 amendment of this date:
   every method needs the list, owner or viewer alike; empty or missing locks everyone out; a listed
   viewer may write under `/api/budget/*` and nowhere else; the root gate and a scoped middleware
   both check; every budget response is `private, no-store` and `Vary: Cookie`; budget code never
   touches the edge cache (a test enforces it). Preview has its own list; Production's stays unset
   until a production go.
4. **Privacy rules for a public repository.**
   - No real bank data in the repo: no statements, exports, names, institutions, merchants,
     amounts, account numbers or email addresses, in code, tests, fixtures, docs, commit messages or
     screenshots shared outside the household. Fixtures are synthetic (made-up accounts with last
     four digits `0001` to `0009`, made-up merchants, `example.com` addresses).
   - Real data is loaded from a private folder outside any git work tree (the load tool refuses an
     output path inside one) as a SQL file run once with `wrangler d1 execute --file`. That file is
     the backup of the load.
   - Account numbers are masked at the edge: any run of five or more digits, and any number printed
     in groups joined by single spaces, dashes or slashes with nine or more digits in all, is
     shortened to a bullet and its last four before storage. Dates (`2026-11-20`, `11-20-26`,
     `11/20/2026`, `11-28`, and two of them joined by a dash as a period), a phone number standing
     alone and short reference numbers stay, even next to a long number (`STORE 0412 2026-11-20`
     keeps both). Groups joined by dots stay as written. A long number is masked even when
     its start looks like a date or a phone number. `accounts.last4` holds four digits and nothing
     longer, and descriptions are stored masked.
   - `.gitignore` blocks statement files (`*.pdf`, `*.ofx`, `*.qfx`, `*.qbo`, `*.csv`,
     `*.budget.json`, `*.budget.sql`, `budget-data/`, `statements/`), and `.gitleaks.toml` has a rule
     for bank-masked account tokens (a run of `X`s then four digits) and 15-digit bank trace
     numbers, so the `secret-scan` workflow fails a push that carries one.
5. **Spending, transfers and debt.** The spending pie counts the kinds `spend`, `refund` and `fee`
   (a refund nets against its category; a bank fee is spending, in category Fees). Moving money
   between the household's own accounts is not spending: `transfer`, `transfer_external`,
   `overdraft_move`, `card_payment`, `loan_payment` and `loan_advance` never reach the pie, and
   pairing matches the two sides of an own-account move so neither is counted. A payment on a debt
   counts as spending when the purchases it pays for are not in the data (a mortgage is housing, an
   auto loan is transport, a store card or another lender's loan is its category) and stays out when
   they are (the credit card; draws from a line of credit that land in checking). That is done with
   seed rules (`set_kind: 'spend'` plus a category, and `debt_account_id` to tie the payment to its
   debt), not with code, so the answer for any one debt is a data change. A row whose kind was set
   by hand or by a rule is never changed by pairing or by a re-run. A pair lands on both rows or on
   neither: when one side cannot take it (a hand-set kind or category, or already paired), the
   other keeps its own classification and no pair.
6. **Interest and fees.** Interest charged (card interest lines; the interest part of a loan
   payment) is not spending: it shows in the debt view per period, because treating card interest as
   spending but loan interest as not would be inconsistent. Interest earned is income. Bank fees stay
   in the spending pie.
7. **No import button and no import route in v1.** The private load tool (`npm run budget:load-sql`)
   is the only way in; the first load and later ones are the private SQL file. An in-browser statement parser would mean
   a PDF library and an institution-specific layout parser in a public repository. A CSV or OFX
   import can be added later if a bank offers one.
8. **The drill pie plays its motion under reduced motion too.** Opening or leaving a level is shown only by the pie
   growing out of the slice (or around the one you came back from); a fade in its place reads as no
   motion, and the user who sets the preference still needs to see that the level changed. It is a short
   one-shot (about half a second, never a loop) in this one pie; every other chart stays still.

## Consequences

- Two more places carry a list of emails (`ALLOWED_EMAILS`, `BUDGET_ALLOWED_EMAILS`) plus the
  viewer keys in KV; removing someone from budget means changing one secret and redeploying.
- A non-listed account sees one 403 in its browser console per load (the access probe); accepted over
  adding a flag to `/auth/me` for everyone.
- Classification is heuristic: a missed transfer pattern overstates spending. The review filter,
  transfer pairing and "use for all of this merchant" are the correction loop, and the first load
  needs a pass over the review list.
- A statement re-sent in another format gives different dedupe keys; it is flagged
  (`possible_duplicate`) rather than prevented.
- The database is real money data on Cloudflare's free-tier-sized store: the summary and list reads
  are index range scans bounded by the date range (400 days at most), and a test asserts the plan for
  every query shape. Two reads are bounded differently, on purpose. A rule re-apply reads a merchant's
  whole history, because a rule says what the merchant is and a date window would skip rows; it is
  key-limited and index-backed (`idx_txn_merchant`), and only "apply all" reaches every merchant with
  an active rule. The debt detail reads each debt's newest 60 payments by an index walk in order
  (`idx_txn_debt`, `idx_txn_pay`: no sort, no scan of the account's older rows).
- Preview and Production bind the same database (one `database_id`, the same pattern as the ads
  database); only each environment's `BUDGET_ALLOWED_EMAILS` decides who can open it. Data loaded for
  Preview is therefore in Production's database too. Production's list stays unset until a production
  go, so the section answers 403 there; setting it opens the data at once.
