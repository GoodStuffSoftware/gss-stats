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
9. **Loan facts get two tables' worth of schema, added by an additive migration (`0002_loans.sql`).** A
   Loans page needs what `accounts` and `statements` do not hold. `debt_terms` (one row per debt: original
   amount, opened and maturity dates, term, scheduled payment with its cadence, cosigned flag) keeps
   `accounts` and its row mapping untouched; `statements` gains the NULLable `escrow_cents` and
   `payoff_cents`; `statement_promos` holds the promotional or deferred-interest balances printed on one
   statement (several per statement, so they cannot be columns), keyed `(account_id, period_end, seq)` with a
   foreign key to the statement. Nothing existing changes, so the deployed code keeps working against either
   state. The database is shared by Preview and Production, so applying it for the preview changes
   production's file too (the section stays 403 there). These tables are written only by the private load
   (as in point 7); no route writes them. Rollback is the commented block at the end of the migration (drop
   the two tables, then the two columns), with the pre-migration Time Travel bookmark as the last resort.
   Layout: an open loan replaces the facts row and the list at every width (the same on phone and desktop;
   "← Loans" and Back return to the list), instead of keeping them above the open loan on wide screens.
10. **A purchase is excluded with a flag, not a category (`0003_included.sql`).** `transactions.included` (1 = counts,
   the default; 0 = a person took it out) is an additive column; `category_edits` gains the NULLable `old_included` and
   `new_included`, so the one audit log also records an include change. A category would have lost the purchase's real
   category and mixed two questions (what is it, and does it count); the flag leaves category, kind and the review flag alone.
   Only the spending totals, pies and drills filter on it (`included = 1`); the review count, the transaction list, Debts and
   Loans do not, so an excluded row stays listed with its switch off. Only `PATCH transactions/:id` (`included`, true or
   false) writes it, and a value equal to the current one writes nothing. The switch is shown on spend, refund and fee rows
   only (the kinds that are spending; a row already excluded keeps it so it can be turned back on). No partial index: no
   code reads `included = 0`. The database is shared by Preview and Production, so applying the migration for the preview
   changes production's file too; the category picker no longer offers "Exclude" (kind `other`): the flag replaced it, and
   rows a person had excluded that way were converted once by a private script (`included = 0`, kind restored). It is additive, and the code now on production names its columns, so it is unaffected.
   Rollback is the commented block at the end of the migration (drop the three columns, then delete its `d1_migrations`
   row so a later apply re-adds them), with the pre-migration Time Travel bookmark as the last resort.
   **Trade-off kept on purpose:** the load's pairing update (`pairUpdateSql`) skips any row whose `updated_by` holds an
   address, which is broader than the switch needs (that update never writes `included`, and the load's INSERT never
   touches an existing row). Repo rule: a row last edited by a person is never changed by a script. The cost: a row whose
   only edit was a note, or that `rules/apply` stamped, no longer auto-pairs as a transfer and stays a spend until it is
   fixed by hand in the table. To undo, remove the two `instr(updated_by, '@') = 0` terms in `pairUpdateSql`
   (`src/lib/budget/sqlFile.ts`) and the matching test.

11. **Transactions toolbar prefs (2026-11-22).** Search, filter and sort state is saved per login in `STATS_CONFIG` KV
   (`budget:prefs:<sha256 hex of the lowercased login>`, route `GET`/`PUT /api/budget/prefs`, body `{ txnView }`) with a
   localStorage cache for the first paint; no D1 schema change. The filters are applied client-side after fetching every page
   of the current period (one request per page), and never appear in a URL. To reverse: remove the route and delete the
   `budget:prefs:*` keys.
12. **Similar-purchase spread (`transactions/similar`, no schema change).** After a person changes a category, `GET ?id=` returns
    the same merchant key's other rows from every month (one statement, `idx_txn_merchant`; newest 300) and `POST` changes the
    ticked ones in one batch with a per-row `updated_at` check and one `category_edits` row each under the signed-in address.
    The POST only touches other rows of the source's merchant; stale or foreign rows come back as `conflicts`. A merchant is
    "mixed" by a heuristic (payment-service key, several display names, or 3+ categories), never by a chain list (public repo);
    mixed merchants get no rule offer. A row a person set (manual and an `@` edit) is never suggested for ticking; a
    script-set manual row is not suggested on a mixed merchant. No Undo: `category_edits` does not record the old
    `category_source`, so an exact undo needs an additive column.
    The dialog (`SimilarDialog`) sits on the shared `ModalPanel` (a bottom sheet under 600 px) and lists rows with
    `EditableTable`'s opt-in `selectable` column; its "Same amount only" choice is kept per merchant in the prefs
    blob (`sameAmount`, at most 30 merchant keys), and the "from now on" rule locks the rows it will move anyway.

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

## Layout, debt drill and donut size (amendment)

- **Layout is a per-device choice.** From 1024 px a picker switches Side by side and Tabs; it is kept in one
  `localStorage` key per device (not per login, not in KV): it describes this screen, like the column widths and the
  phone's Cards | Table switch. Below 1024 px the tabs always apply.
- **A debt drills in place.** The Debts pie replaces its slices with that debt's balance and history (a crumb, Back,
  and a "Loan details" link to the Loans page) rather than navigating away. The id is kept in `history.state` only,
  never the URL, so a shared link cannot name a debt; the history is fetched once per debt and cached.
- **Donut size is per device, chart and mode.** One `localStorage` key per chart and per mode (solo: one chart has
  the width; split: two side by side), because a size that suits one chart alone is too big beside the other. When a
  chart is alone and its box is 640 px or more, the donut sits beside an auto-filling legend.
- **Shared-component rule.** `DrillPie` stays free of Budget words: `resizable`, `wide` and `sizeKey` are opt-in
  props that default off (other callers render exactly as before), and the caller builds the storage key
  (`donutSizeKey` in `lib/budget/panelVisibility.ts`). A saved size is clamped to the room it has now.

## Remembered view (amendment, 2026-11-23)

- **Saved per login, in its own KV key.** The Show choice and the drill location (tab, page, range, person, review
  filter, the spending path of at most two steps, the open debt) are saved as `{ view }` under
  `budget:prefs-view:<sha256 hex of the lowercased login>`, through the same `GET`/`PUT /api/budget/prefs` route. It is
  a key of its own, not a field of the toolbar's `budget:prefs:*` blob: the two save independently when both flush as
  the page closes (no read-modify-write that could lose one), and each has its own 4 KB cap. Strict on write, lenient on
  read (a bad or old block is treated as nothing saved).
- **Precedence.** A link (`b_*` parameters) or Back/Forward state (`history.state` drill, loan or debt mark) always
  wins; the saved view is applied once, on a plain open, before the first data fetch (so there is no double fetch). The
  Show choice is not part of a link, so it applies either way.
- **Stale parts fall back quietly, never an error.** A category that is gone drops the drill to the top; a person that
  is gone is "All"; a custom range the server would refuse is the default; a preset is recomputed from today; the
  second drill step is checked against the first level's slices when they load; an unknown debt returns to the pie.
- **Migration.** `localStorage` keeps the Show choice as the first-paint cache. With nothing saved on the server, the
  device's old choice is sent once; an untouched view writes nothing. The GET is raced against a 3 s timeout; when the
  server does not answer nothing is restored, and nothing is written until the person changes something.
- **Stays per device.** The layout picker and donut sizes (above): they describe this screen.
- To reverse: stop restoring (remove the call in `BudgetSection.vue`) and delete the `budget:prefs-view:*` KV keys.

## Transactions table interaction (amendment)

The table's note is read with a click or tap (a tip, as for the merchant) and edited with a press-and-hold, Enter or F2; an empty note
shows "Add note". Columns resize by dragging the header edge and the widths stay per device. On a phone the card list is the default and
a Cards | Table switch (per device) shows the real table scrolled sideways. All of this is `EditableTable` options and one shared
toggletip composable, no new widget type (ADR 0005).
