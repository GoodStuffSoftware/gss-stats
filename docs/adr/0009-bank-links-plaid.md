# ADR 0009: Bank links for Budget through Plaid and a separate Worker

- **Status:** Accepted (2026-11-27)
- **Date:** 2026-11-27
- **Amends:** [ADR 0002](0002-google-auth.md) (one more unauthenticated path, `POST /hooks/plaid`, checked by
  signature instead of a session); [ADR 0007](0007-budget-section.md) decision 2 ("nothing else binds" the budget
  database): one more binder, the banks Worker (as [ADR 0008](0008-email-receipts.md) already added the receipts
  Worker).

## Context

Budget is fed by statement files a person loads by hand. That is accurate but late, and a card's balance and due
date are only as fresh as the last file. Plaid can deliver the same transactions, the balances and, for cards and
loans, the payment details directly from the bank, so the page stays current without a load.

Three things make this the most sensitive addition to Budget so far. A Plaid access token reads a bank login's
transactions until it is revoked. The repository is public, so no bank data, name, amount or id may reach code,
tests or docs. And Plaid's free plan allows 10 production Items (bank logins) for life; removing one does not
return its slot, so a careless link is a permanent cost.

## Decisions

1. **The Plaid Link web SDK, not Hosted Link.** The page opens Link in the browser, which hands the public token
   to `onSuccess` directly, so the server can check for a duplicate bank login before it spends a slot. Hosted
   Link has no plan restriction but would need the `SESSION_FINISHED` webhook or polling to get the token back.
   The SDK script is loaded from `cdn.plaid.com` only when a person clicks Link (Plaid does not allow
   self-hosting it); the site's CSP is only `frame-ancestors 'none'`, so no CSP change is needed. A bank that uses
   OAuth returns to `/banks/return`, a path (Plaid forbids query strings in the redirect URI) that Pages serves as
   the single-page app, behind sign-in. The page stores the link token locally for 30 minutes so it can resume
   Link there, then replaces the address with the Banks page.
2. **A separate Worker holds every Plaid secret.** `gss-budget-banks` (`workers/banks/`) has no public URL and no
   route (`workers_dev = false`, `preview_urls = false`). It alone holds the Plaid client id and secret and the
   token key (account Secrets Store bindings), creates link tokens, exchanges the public token, fetches and
   applies transactions on a cron, and removes Items. Pages reaches it only through the `BANKS` Service Binding,
   so compromising a Pages Function does not reveal an access token. The Worker must deploy before Pages, which
   the deploy workflow orders (`deploy-banks`). Every caller route re-checks the owner address against the
   allowed list, so a stray binding cannot act for a stranger.
3. **One unauthenticated path, `POST /hooks/plaid`, amending ADR 0002.** Plaid cannot sign in. The path is the
   exact string `/hooks/plaid`, method POST, and skips the session gate and the origin check (Plaid sends no
   Origin); the host guard and the https redirect still apply and any other method gets the normal gate. Pages
   reads at most 64 KB, requires the `plaid-verification` header, forwards the raw bytes to the Worker and
   never parses or logs them. The Worker verifies Plaid's ES256 JWT (algorithm, key id, key age, signature over
   the header and payload, `iat` within five minutes, and the body's SHA-256 against the signed claim, compared in
   constant time) before it touches D1, and answers 401 with no detail otherwise. A webhook only sets flags
   (sync requested, reconnect needed, new accounts) or, on a revoke (`USER_PERMISSION_REVOKED`,
   `USER_ACCOUNT_REVOKED`), removes the Item at Plaid and wipes its token; no HTTP path runs a sync.
4. **The slot log is append-only.** `plaid_slot_log` gets one row per production exchange attempt, written before
   the exchange call and counted from then on (a timeout keeps counting: over-counting is the safe side). Three
   triggers refuse a delete, an update other than pending to done or failed, and an insert that reuses an id (how
   REPLACE would delete). The slot counter and the guard count only this table, so the number of the 10 used
   cannot be edited or drift when an Item is unlinked. The guard is one atomic `INSERT ... SELECT ... WHERE count
   < 10`. Sandbox Items never count. Items made before this app existed are entered once by hand as `prior` rows.
5. **The access token is encrypted with AES-256-GCM, and the Item id is the AAD.** The code is the receipts
   Worker's `tokenCrypto.ts` (imported, not copied); the key is its own (`BANKS_TOKEN_KEY`), not the receipts key,
   so one leak does not open both. A stored token copied onto another row will not decrypt. The key can rotate:
   `BANKS_TOKEN_KEY_OLD` still decrypts, and a sync that used it re-encrypts under the current key. The plaintext
   token exists only inside a Worker request or tick, never in a response, a log, Pages or D1. The public token
   crosses Pages once (single use, 30-minute life). Logs hold counts and codes only.
6. **Sync is a cron, one whole update at a time, and every write is keyed.** A webhook or "Sync now" only sets
   `sync_requested_at`; the Worker's `*/10 * * * *` cron picks at most three due Items, claims each with a
   15-minute guard, fetches the whole `/transactions/sync` update in memory (restarting on a mid-pagination
   mutation, stopping at 60 pages), then applies it in D1 batches whose last statement moves the cursor. A run that
   dies part way and repeats from the old cursor ends in the same state. A daily check asks Plaid about Items that
   need a reconnect, and liabilities and balances refresh about every 20 hours (never the paid balance call).
7. **Dedupe, and what a person's edit is worth.** A Plaid transaction maps to a Budget row in `bank_txns`: the sync
   either inserted the row or only claimed an existing statement row (role `matched`, never written). A pending row
   that posts is updated in place, keeping its id, category, edits and receipt matches. At the cutover (`sync_from`,
   the day after the account's newest row) one same-amount row within three days is matched, two are flagged
   `possible_duplicate`, none inserts. A manual category or kind, a note and an address in `updated_by` are never
   overwritten by a modify, a posting or a resync. If Plaid removes a row a person has edited, it is marked
   `dropped` and waits for Delete or Keep on the Banks page; an unedited removed row is deleted.
8. **The statement load steps aside for a linked account.** The load's insert is guarded: rows dated on or after
   `sync_from` for an account whose bank feed is on are skipped, so a file and the bank never double up. Rows before
   the cutover still load, and the statement's own facts (balances, APR) load as before. Loan and debt readings
   taken from the bank are marked source `bank` and never replace a person's own entry for the same day.
9. **Bank data is household data; management is the linker's.** Both listed Budget people see every linked
   account and row (the person filter is only a view), as with statement files. Only the person who linked an Item
   maps its accounts, reconnects, shares new accounts and unlinks it. Anyone listed can ask for a sync. The slot
   count is household-wide.
10. **No Item from the preview.** `dev.gss-stats.pages.dev` shares the production budget database, so it does not
    bind `BANKS`: every bank route but the status read answers 503 `banks_not_configured` there, and so does the
    webhook path. No agent, test or script creates a production Item; development uses Plaid's sandbox, locally.
11. **What is read and kept is bounded.** Transactions (date, amount, description, merchant name as the fallback
    description, pending or posted) for up to two years, USD only; each account's name (masked), type, last four
    digits, balances and credit limit; for cards, mortgages and student loans the typed fields: interest rate,
    minimum payment, next monthly payment, due date, overdue flag, past-due amount, last statement date and balance,
    last payment amount and date, escrow balance, original loan amount and date, interest and principal paid this
    year, and payoff or maturity dates. Masking (`maskDigits`) cuts a run of 5 or more digits, and a number written
    in groups (single spaces, dashes or slashes) that totals 9 or more digits, to a bullet plus its last four;
    shorter numbers, dates and a lone phone number stay. It is applied to descriptions and to account and bank
    names. Plaid's own ids are kept (item, institution, account and transaction ids, and `transactions.bank_ref`
    as `plaid:` plus the transaction id) and stay after an unlink. Never kept or logged: the full account number,
    routing numbers, property or servicer addresses, payment reference numbers, and Plaid's own category.
    `/privacy` names every field above and must change with this list. Consent is asked of each person before
    their own first link (the card shows until they own an Item); `consented_at` and `consent_version` are stored
    per Item.
12. **Deleting a Budget account that a bank account feeds is refused.** `bank_accounts.account_id` is
    `ON DELETE SET NULL`, but the table's CHECK (`sync <> 'on' OR account_id IS NOT NULL`) fails first, so such a
    delete errors. That is a backstop, pinned by a test. No account-delete route exists today; one added later must
    answer 409 `account_synced` ("This account gets bank transactions. Stop syncing it on the Banks page first.")
    before it touches the row.

## Consequences

- One more place holds secrets, a small one with no public surface. The cost of a leak at Pages is a link token
  or a flag, not a bank login.
- Unlinking ends Plaid's access (`/item/remove`) and wipes the token, key id, cursor and the card and loan details;
  the Item's name, the accounts' masked names, last four digits and balances, and every transaction already in
  Budget stay as household records, with the owner address, consent record, Plaid's ids and the sync-run counts. It
  does not return the slot; `plaid_slot_log` keeps the Plaid item id, institution id and the linker's address.
  Revoking access at the bank or through Plaid does the same once Plaid sends the webhook.
- The slot counter is only as right as the number of Items made outside this app, which a person enters once.
- The one public path accepts anonymous POSTs; the cost is bounded (64 KB cap, a header check, then a signature
  check before any database read, and negative caching of unknown key ids).
- The migration (`migrations/gss-budget/0005_bank_links.sql`, six tables, three triggers and `transactions.pending`)
  is additive and applied by hand, once, with a Time Travel bookmark first. The deployed code runs unchanged
  against either state, but the guarded statement load needs 0005 before it runs.
- A webhook-driven sync can lag by up to ten minutes (the cron tick), and a first pull of two years runs in the
  background, not in a request.
- The privacy policy at `/privacy` gains its own Bank links section. Plaid's own end-user terms apply to the
  bank login step.

## Alternatives considered

- **Hosted Link.** Rejected (decision 1): the duplicate check before the exchange needs the public token at once.
- **Doing it in Pages Functions.** Rejected: the client secret, token key and access tokens would sit in the
  public-facing project, and a two-year first pull does not fit a request.
- **Counting slots from Plaid or from live Items.** Rejected: neither survives an unlink. An append-only log
  does, and a wrong row can never be removed, so rows are only written, never corrected.
- **Plain-text token behind D1 access control.** Rejected, as in ADR 0008: a database read would hand over bank
  logins. With AES-GCM the key lives only in the Worker's Secrets Store.
- **Reusing `RECEIPTS_TOKEN_KEY`.** Rejected: one leak would open mail and bank tokens together.
- **Replacing statement rows with bank rows.** Rejected: statement rows carry a person's edits and receipt matches.
  Matching at the cutover and skipping the load afterwards keeps them.
- **Plaid's own category.** Not stored: the site's classifier and merchant rules already categorize statement rows,
  so a bank row gets the same category as the same purchase on a statement.
