# ADR 0008: Email receipts for Budget through a separate Worker

- **Status:** Accepted (2026-11-23)
- **Date:** 2026-11-23
- **Amends:** [ADR 0007](0007-budget-section.md) decision 2 ("nothing else binds" the budget
  database): one more binder, the receipts Worker.

## Context

A bank line says where money went, not what it bought. The receipt emails in each Budget person's
Gmail say which items, and a category is often obvious from them. The feature reads those emails,
pulls out the fields (merchant, date, total, items), matches each receipt to a transaction and
suggests a category.

Two things make this the riskiest addition to Budget so far. A Gmail refresh token reaches a whole
mailbox, far more than the bank data it helps with, and the repository is public, so nothing about
mail may land in code, tests or docs. And the household shares one Budget but not one mailbox, so
who sees whose receipt needs an explicit answer.

## Decisions

1. **A separate Worker holds every Gmail secret.** `gss-budget-receipts` (`workers/receipts/`) has
   no public URL and no route. It alone holds the Gmail client secret, the token encryption key and
   the Anthropic key (account Secrets Store bindings), does the token exchange, the hourly mail
   read, the extraction and the revoke. The Pages project reaches it only through a Service Binding
   (`RECEIPTS`: connect callback, sync, disconnect). Pages never sees a refresh token or a secret
   other than the public client id it needs to start the redirect. The Worker must therefore deploy
   before Pages, which the deploy workflow orders.
2. **The refresh token is encrypted with AES-GCM, and the connection id is the AAD.** A stored token
   is useless when copied onto another connection's row. A reconnect updates the row in place, so
   the id stays stable. The key can be rotated: an optional old key still decrypts until every row is
   re-encrypted.
3. **Read-only Gmail scope.** Only `gmail.readonly` is requested, next to `openid email`. Granular
   consent lets a person untick Gmail on Google's screen, so the connect step checks the granted
   scopes and refuses without it. Gmail has its own OAuth client, apart from the sign-in client, so
   nothing about sign-in can change.
4. **Sharing is set to fields.** `RECEIPTS_SHARE=fields`: the other Budget person sees the receipt
   fields on a transaction, and only the mailbox owner gets the "Open in Gmail" link (it would open
   the viewer's own mailbox, where the message does not exist). The consent text says so from its
   first version: receipts you connect are also shown to the other Budget person. Someone not on the
   Budget list gets 403, as everywhere under `/api/budget/*`.
5. **Review and apply are per owner.** The review list, apply and dismiss show and act on the
   signed-in person's own receipts only. Each person applies their own.
6. **One applied receipt per transaction.** A unique index enforces it. A charge that several
   receipts add up to is suggest-only: one receipt is applied and the others show as "also matches".
   Relaxing a unique index later is a safe migration; tightening it could fail on existing rows.
7. **Apply never changes a manual category or one a person set.** It links the receipt and leaves the
   category, and says so in its answer. A bulk apply of up to 50 rows could otherwise undo someone's
   own choices quietly. When apply does set a category it clears the row's review flag.
8. **Auto-apply is off by default.** The Worker only suggests (`RECEIPTS_AUTO_APPLY` is `0`). It is
   turned on only after the suggestions' precision has been checked by hand, and then only at or
   above a minimum score.
9. **Spend limits stop the run.** A model call that answers 400 (a spend limit on the workspace) or
   429/529 (rate or organisation cap) stops that run, uses up no attempt, and is retried by the next
   hourly run. They are never recorded as a bad receipt. The run records a distinct code (a rejected
   request versus a limit), and the status route and the page show the run as paused. A per-run and a
   per-day cap on messages and model calls bound the cost either way.
10. **Extraction is data, not instructions.** The model returns JSON only. Each field is validated
    (card numbers are reduced to their last four, totals bounded) and no mail text is stored beyond
    the fields. Logs carry counts and codes, never content.

## Consequences

- One more place holds secrets, but a small one with no public surface. Compromising a Pages
  Function does not reveal a mailbox token.
- A person who connects Gmail agrees that the other Budget person sees the extracted fields of the
  receipts it finds. The consent text states it; disconnecting revokes the grant at Google and can
  also delete that person's receipts.
- The Google client is unverified and in production: a "not verified" screen appears at connect, and
  Google caps unverified apps at 100 new users, far above a household's need.
- A key or limit problem pauses extraction (and shows it) instead of failing silently each hour.
- The migration (`migrations/gss-budget/0004_receipts.sql`) is applied once per remote database by
  the operator's lead, with a Time Travel bookmark first, like the earlier ones.
- Because the id_token comes straight from the token endpoint over TLS, its signature is not
  checked, as in the sign-in path. The single-use OAuth state is a KV mark backed by Google's
  single-use code, not an atomic database guard.

## Alternatives considered

- **Gmail scope on the sign-in client.** Rejected for now: a Google action against the Gmail app
  (cap, suspension) could then break site sign-in. Reversible by adding the scope to that client.
- **Doing it all in Pages Functions.** Rejected: the client secret, key and refresh tokens would sit
  in the public-facing project, and a long mail run does not fit a request.
- **Storing the refresh token in plain form behind D1 access control.** Rejected: a database read
  would then hand over mailboxes. With AES-GCM the key lives only in the Worker's Secrets Store.
- **Sharing none, or fields plus the link.** Mike chose fields: both people see each other's
  receipts, but a link to a message only its owner can open helps nobody.
- **Applying matches automatically from day one.** Rejected until suggestion precision is measured.
- **Workers AI for extraction.** Rejected for accuracy on messy receipts; a small Claude model does
  the extraction.
