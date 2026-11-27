# ADR 0010: Receipt photo uploads

- **Status:** Accepted (2026-11-27)
- **Date:** 2026-11-27
- **Amends:** [ADR 0008](0008-email-receipts.md) decision 1 (the Anthropic key and the extraction stay in the
  receipts Worker: it now also holds a photo store) and decision 4 (a second input besides Gmail).

## Context

Paper receipts never reach Gmail. A Budget person can photograph one on the Receipts page and get the same
fields, the same matching and the same suggestions as an emailed receipt.

## Decisions

1. **The Worker holds the key and the store.** Pages checks the login, the type and the size, then hands the bytes
   to the receipts Worker over the `RECEIPTS` service binding (`POST /upload`, `/upload-delete`, `GET /image`). Pages
   writes nothing to D1 for an upload and never sees the Anthropic key.
2. **Private object store.** The photo lives in a private R2 bucket bound to the Worker only, key `img/<receipt id>.jpg`.
   If R2 is not enabled, a Worker-only KV namespace sits behind the same `ImageStore` interface.
3. **Two-step metadata removal.** The browser re-encodes the photo (long edge at most 2576 px, the high-resolution read tier, JPEG), which bakes
   orientation in and drops metadata. The Worker then rebuilds the file from an allowlist of JPEG segments (no APPn,
   no comments, nothing after the end marker). Photos are served only with inert headers (nosniff, a `default-src
   'none'; sandbox` CSP, `Cross-Origin-Resource-Policy: same-origin`, `private, no-store`).
4. **Schema 0006 rebuilds `receipts`.** `connection_id` and `gmail_msg_id` become nullable under a `source`
   (`email` | `upload`) CHECK; new columns `uploader_email`, `image_key`, `image_sha256`, `image_bytes`; upload-side
   indexes. Old code runs unchanged on it. One matcher, one apply path, one "applied" unique index.
5. **Suggest only.** An upload is never auto-applied, whatever `RECEIPTS_AUTO_APPLY` says. Apply goes through the
   same Pages path, so a person-set category is never overwritten (ADR 0008 decision 7).
6. **Visibility.** Fields follow `RECEIPTS_SHARE` unchanged. The photo follows a new Pages var
   `RECEIPTS_IMAGE_SHARE`: `both` (default, set in `wrangler.toml`) shows it to every listed person once the
   receipt is applied; `owner` only to the uploader. Delete is the uploader's alone. A receipt that is missing or not
   yours answers the same 404.
7. **Review list, owner test.** "Mine" is the Gmail connection owner OR the uploader. The list is a `UNION ALL` of the
   email arm (`idx_rcpt_review`) and the upload arm (`idx_rcpt_up_review`), each with the keyset cursor and
   LIMIT, merged by (email_date, id).
8. **Retention 90 days.** A bucket lifecycle rule deletes `img/` after 90 days (covers the 75-day stale window);
   Delete removes the photo and the receipt at once. The hash stays after the photo goes, for duplicate detection.
9. **No PDFs in v1.** The server accepts JPEG only; the browser converts what it can decode.
10. **The daily cap counts live rows.** 20 uploads per person per day, counted from existing rows; deleting an upload
    frees a slot. Accepted as simple and cheap.

11. **Sec-Fetch-Site is checked only when present.** `POST /api/budget/uploads` answers 403 when the header is
    present and not `same-origin`, and allows an absent header. Safari before 16.4 does not send it. The real guard is
    the exact `Content-Type: image/jpeg`: it is non-simple, so a cross-site send needs a preflight, and no CORS grant is
    given. A test pins both cases.

## Consequences

- The Worker needs the R2 binding and a token that can deploy it; R2 must be enabled on the account first.
- Pages gains three routes under `/api/budget/uploads` and one var; the upload cap (2,000,000 bytes) is checked in
  Pages by header and by counting the stream, and again in the Worker.

## Rollout order

1. Apply migration 0006 by hand (after a Time Travel bookmark) BEFORE this Worker deploys: the upload code names `receipts.source`
   and `image_key`, so on the old schema the email receipt list and auto-apply fail (auto-apply logs `schema_old`).
2. Create the R2 bucket lifecycle rule on prefix `img/` (keep days + 1, so 91 days at the default) at the landing step, when
   the `RECEIPT_IMAGES` binding is added. It is the backstop for an image whose row insert never happened. The KV store has
   its own per-key `expirationTtl` (keep days x 86400 s, above KV 60 s minimum).
3. Then merge to main, which deploys the Worker and Pages.
