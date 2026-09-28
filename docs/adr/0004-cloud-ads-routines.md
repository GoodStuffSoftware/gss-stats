# ADR 0004: Running the ads-read routines in the cloud

- **Status:** Proposed, 2026-09-28. Design only: nothing in this ADR has been built, deployed,
  scheduled or changed. The ads follow-up session reviewed the routine half at `e82cbb3` and
  approved the design with 7 edits, all folded in here (§3, §5, §6.1-6.4, §7, §8).
- **Owner asks:** "ideally having the routines able to run on cloud is ideal" (Mike, 2026-09-28).
  Also from Mike, 2026-09-28: "I can set whatever keys we need into cloud environments". Mike
  sets every key himself, and agents never handle key values.
- **Scope:** the Best Sudoku retest reads. These are the daily morning read
  (`docs/routines/bsk-retest-morning-read.md`) and the post-flight reads
  (`docs/routines/bsk-retest-postflight.md`). The design is general enough for the next flight.
- **Builds on:** [ADR 0001](0001-ads-read-store.md) (the `gss-stats-ads` store and the sync
  Worker) and [ADR 0002](0002-google-auth.md) (the dashboard's Google sign-in gate).
- **Who owns what:**
  - **gss-stats:** the Worker, the dashboard API and the data.
  - **The ads follow-up session** (`best-sudoku-ads-retest-followup`): the cloud routine's
    configuration and prompts, and retiring the local tasks.

## Decision (summary)

**Option B, the split.**

1. The `gss-stats-sync` Worker runs every deterministic read that the CLI runs today, on its
   existing hourly cron. The code decides which tick runs which read. The Worker stores the full
   result in `gss-stats-ads`. When the read's own `notify.push` rule fires, the Worker emails
   Mike, so no Claude session sits between a money-at-stake alert and his phone.
2. A claude.ai cloud routine does the parts that need judgment and connectors: the narrative,
   the bus copy and the report page. It reads the stored result through a new, narrowly scoped,
   read-mostly service token on the dashboard API. **The routine holds no Google, Firebase, Play
   or Cloudflare credential**, so it cannot change an Ads setting even in principle.

This needs **Workers Paid ($5/month)**, because a full read is several times Free's 10 ms CPU
limit. Nothing about the in-flight daily read changes before the flight ends. The first cloud
read is a shadow run of the 2026-10-09 wrap-up. Cutover is at the 2026-10-17 day-15 read, behind a
go or no-go decision sent by 10-15. A no-go moves cutover to 11-01.

## 1. Facts: what the routines do today

### 1.1 The local tasks

These are the local scheduled tasks under `~/.claude/scheduled-tasks/`. The ads follow-up session
owns them. They were read for this ADR and not changed.

| Task | Schedule | Runs |
|---|---|---|
| `bsk-retest-morning-read` | daily 06:00 ET, 2026-09-27 to 2026-10-03 | `docs/routines/bsk-retest-morning-read.md` Steps 0 to 8. Release health was folded in on 2026-09-27, and Step 8a, the report page at one fixed Artifact link, was added on 2026-09-28. |
| `bsk-retest-backstop` | **disabled** 2026-09-27, not deleted | Nothing. Its release-health check now runs inside the morning read. |
| `bsk-retest-postflight-{wrapup,day15,day30,day60,december}` | one-time, about 09:00 ET on 10-09, 10-17, 11-01, 12-01 and 12-03 | `docs/routines/bsk-retest-postflight.md` with `--stage <stage>` |

All of them run from the detached checkout `C:/Users/msant/dev/gss-stats-ads-routine`
(`origin/main`), so they need the owner's Windows machine to be awake, online and signed in.

### 1.2 Every external call and the credential it uses

Secret values are not reproduced here. The table says only where each secret lives and what it
is for.

| Step | External call | Credential | Where the credential lives |
|---|---|---|---|
| Step 0: checkout | `git fetch` from github.com (gss-stats, a public repo); `npm ci` from registry.npmjs.org | none | n/a |
| Step 1: Ads keys | `bws secret list` (Bitwarden Secrets Manager). The CLI keeps 4 keys in memory and drops the rest (`scripts/ads-reads/secrets.ts`). | `BWS_ACCESS_TOKEN` | Environment variable on the machine. It can read **every** secret its machine account sees, not only the Ads keys. |
| Step 1: Google Ads | `POST oauth2.googleapis.com/token` (refresh), then `POST googleads.googleapis.com/<v>/customers/8726535246/googleAds:search`, which is a GAQL SELECT only. It covers status, daily spend, placements, the range total, and the diagnostics: hourly, geo, devices, targeting and recommendations (`src/lib/adsApi.ts`). | Client id, client secret, refresh token, developer token | Bitwarden, the source of truth. The same 4 are copied to Cloudflare Secrets Store for the Worker (ADR 0001). The refresh token belongs to a Google user who is assumed to have edit rights; this was not verified here. The `adwords` scope has no read-only variant, so the token can do whatever that user can do. |
| Step 1: ads store | `wrangler d1 execute gss-stats-ads --remote`, i.e. the api.cloudflare.com D1 query API. Reads, plus guarded `INSERT INTO ads_*` statements. | Cloudflare API token | `C:/Users/msant/dev/cf-token.txt`. It holds Workers Scripts, Secrets Store, D1 and Pages **write** (ADR 0001, "Constraints checked"). |
| Step 1: beacon | `wrangler d1 execute gss-geo --remote`, with a SELECT-only guard (`scripts/ads-reads/d1.ts`) | same token | same file |
| Step 1: Firestore counts | `POST oauth2.googleapis.com/token` (a signed JWT); `GET …/documents/promos/first50`; `POST …/documents:runAggregationQuery`. The fence allows exactly these three (`scripts/ads-reads/firebase.ts`). | `firebase-adminsdk-fbsvc@best-sudoku-prod` key | `C:/Users/msant/.firebase/service-accounts/best-sudoku-prod.json`. It holds roles/editor, among others, so it is **not** read-only (firebase.ts header). |
| Step 1: Play bulk reports (morning only) | `POST oauth2.googleapis.com/token` (JWT, `devstorage.read_only` scope); `GET storage.googleapis.com/storage/v1/b/pubsite_prod_6577064245925542510/o…` to list and download. GET only (`scripts/ads-reads/play.ts`). | `play-publisher@best-sudoku-prod` key | `C:/Users/msant/.google-play/service-accounts/best-sudoku-prod.json`. This is the publisher identity. Its Play Console grants were not checked here, so treat its blast radius as "can publish releases". |
| Step 3: push | The `PushNotification` tool, which runs on Anthropic infrastructure | The Claude session | n/a |
| Step 6: bus copy | deckhand `agent_send` from `gss-stats` to `best-sudoku-ads-retest-followup`, through the claude.ai connector or REST `/api/agent/*` | The connector grant, or the machine's bus credential | claude.ai, or the machine |
| Step 7: audit trail (R7) | `git pull` and `git push` on `msantoro12/best-sudoku` (private), branch `docs/ads-next-campaign` | The owner's local git and gh credentials | the machine |
| Step 8a: report page | `npm run ads:read-page` (local), then an Artifact `read` and `publish` to `claude.ai/artifact/MWeDd1o525czFMkNqWzJwL` | The Claude session | n/a |

The post-flight read makes the same calls apart from the Play step (it passes no `--play-sa`).
It adds the Firestore cohort-tier COUNTs on day15, day30 and day60, and it does no git write and
no page.

### 1.3 The cloud pieces that already exist

- **`gss-stats-sync` Worker** (`workers/sync/`). It has an hourly `5 * * * *` cron, and
  `cronShouldSync` decides what each tick does. Its 4 Ads keys come from Secrets Store bindings
  (`ADS_CLIENT_ID`, `ADS_CLIENT_SECRET`, `ADS_REFRESH_TOKEN`, `ADS_DEVELOPER_TOKEN`, all in store
  `deb0011dfe80443091c08d92874ddf06`). It has a D1 binding `gss_stats_ads`. It has no public URL:
  the dashboard reaches it through the Pages Service Binding `ADS_SYNC`. It runs the **same**
  `syncAdsData` (`src/lib/adsSync.ts`) as the local CLI, so spend, restatement and fire-once logic
  already have one implementation in both runtimes.
- **The dashboard** (Pages, `stats.goodstuff.software`). Every route sits behind the Google
  sign-in gate in `functions/_lib/auth.ts`: a signed session cookie, with the allowlist re-checked
  on every request. `/api/ads/readings` already serves the readings log.
- **The read code is dependency-injected.** `runMorningRead` and `runPostflightRead` take
  `ReadDeps` (`scripts/ads-reads/read.ts`), which holds ads, beacon, store, firebase and
  playReports sources. The node-only parts are the adapters (`wrangler`, `bws`, `node:crypto`
  `createSign`, `node:fs`), not the rules. `report.ts` imports only `src/lib`.

### 1.4 The Worker on Workers Free, measured

The account has **no Workers Paid subscription** ([capacity.md §1](../capacity.md)).

The first-night check ran in session `local_6c5a4905-5be5-475f-a235-0adf2d0aade2`, over
09-26 20:50Z to 09-27 13:15Z:
- 17 invocations, all succeeded;
- 0 errors, 0 `exceededCpu`, 0 killed runs;
- CPU p50 4.2 ms, max 18.3 ms.

A read-only GraphQL `workersInvocationsAdaptive` query for this ADR, over 09-26 20:50Z to
09-28 ~18:00Z, gave:

| ET day | Invocations | Errors | CPU p50 | CPU max |
|---|---|---|---|---|
| 09-26 | 3 | 0 | 3.95 ms | 5.2 ms |
| 09-27 | 24 | 0 | 4.21 ms | 18.3 ms |
| 09-28 | 15 | 0 | 4.65 ms | 17.1 ms |

Every run that actually pulls from Google (14 subrequests on each of those days) already exceeds
Free's 10 ms. The platform tolerates that only occasionally: "If your Worker starts hitting the
limit consistently, its execution will be terminated"
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)).

A full read adds three things on top of that 1-day pull:
- about 10 more GAQL queries;
- RSA signing for two service accounts;
- UTF-16 CSV parsing for Play, plus beacon summarisation and report formatting.

It also needs about 30 to 45 external subrequests, against Free's cap of 50 per invocation.
**A full read on Free is not viable.**

The same finding matters for delivery. The first-night check's `PushNotification` reached the
**desktop only**, "because Remote Control is off". The tool "Sends a desktop notification, and a
phone push when Remote Control is connected"
([tools reference](https://code.claude.com/docs/en/tools-reference)). **Worth your attention:**
that applies to today's local morning read too. A threshold push at 06:00 ET reaches the phone
only if Remote Control is connected at that moment.

## 2. Facts: the cloud runtimes

### 2.1 claude.ai cloud routines

Sources: [routines](https://code.claude.com/docs/en/routines),
[cloud environments](https://code.claude.com/docs/en/cloud-environments) and
[Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web), all read on
2026-09-28. Routines are a research preview.

**Secrets**
- Environment variables are ".env-style" and "Anyone who uses the environment can read the
  values". The dialog "warns against putting secrets there".
- The model can read them, and so can every command it runs.
- On **Pro and Max** (not Team or Enterprise yet), an environment can hold **API credentials**.
  The agent proxy adds a Bearer or custom header to requests for the hosts you list. "The key
  never reaches Claude, the commands it runs, or the session's environment variables."
- A credential is a static header. That fits a bearer token. It cannot perform the Google OAuth
  refresh, whose client secret and refresh token travel in the request body, or service-account
  JWT signing.
- There is no documented secret-file mechanism. A service-account JSON would have to be an
  env var, and so readable by the model.

**Network**
- The levels are None, Trusted (the default), Full, and Custom (your own allowlist).
- Trusted includes `*.googleapis.com` and `storage.googleapis.com`. It does not include
  `api.cloudflare.com` or `stats.goodstuff.software`, so a routine that calls those needs Custom.
- Connector traffic (deckhand) and API-credential hosts bypass the allowlist.
- All egress goes through Anthropic's security proxy.

**Repos**
- Each run clones the selected repos from the default branch. Pushes to `claude/*` branches are
  always accepted.
- A push to another branch is rejected if:
  - the branch is protected;
  - someone else has an open PR from it; or
  - it carries commits by another author.
- `git push works only against the session's current working branch`.
- Checked 2026-09-28: `msantoro12/best-sudoku` is private, `docs/ads-next-campaign` is
  unprotected, and no PR is open from it. `GoodStuffSoftware/gss-stats` is public and its `main`
  is unprotected.

**Schedules**
- Presets are hourly, daily, weekdays and weekly. Custom cron is set with `/schedule update`,
  and the minimum interval is 1 hour.
- Times are entered in local time and converted.
- "exactly on the hour … can start several minutes late", so pick :07 and similar times.
- One-off runs auto-disable and do not count against the daily run cap.

**Delivery**
- The run's session is viewable on the web and in the mobile app. A green status means only "no
  infrastructure error".
- Phone push is documented only for Remote Control and Dispatch
  ([mobile](https://code.claude.com/docs/en/mobile)). **A phone push from a cloud routine run is
  undocumented.** The `claude-update-watch` cloud routine calls `PushNotification` and allows for
  it being unavailable. That it reaches the phone is unverified.

**Connectors and Artifacts**
- The account's claude.ai connectors, including deckhand, are included by default.
- A scheduled run republishes an **existing** artifact without asking only when all of these
  hold: it is not public; its viewers do not auto-see each new version; the publish is the page
  only; and the page has no connector grants. A new artifact always asks, which stalls an
  unattended run.

**Limits**
- Runs draw down subscription usage, and there is also a per-account **daily run cap**.
- Without usage credits, "additional runs are rejected until the window resets".
- The VM is Ubuntu 24.04 with 4 vCPU and 16 GB. Node 22 is on PATH.
- Bash commands time out after 2 minutes by default, up to 10 minutes.

**API trigger (`/fire`)**
- It is a per-routine bearer token, created on the web only.
- Call it as `POST https://api.anthropic.com/v1/claude_code/routines/<trig_id>/fire` with
  `anthropic-beta: experimental-cc-routine-2026-04-01`.
- The `text` field arrives wrapped as untrusted data.
- It is a beta, and its shapes may change.

**Precedent on this machine**
- `claude-update-watch`: its "canonical home is the claude.ai CLOUD routine", and the local file
  is the prompt of record.
- `best-sudoku-feedback-digest`: it detects "Windows → LOCAL, Linux → CLOUD", and on cloud its
  credentials come from env vars such as `BSK_SA_PROD_JSON` and `CLOUDFLARE_API_TOKEN`. That is
  the env-var pattern option A would follow.

### 2.2 Cloudflare

Sources: [limits](https://developers.cloudflare.com/workers/platform/limits/),
[pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Secrets Store](https://developers.cloudflare.com/secrets-store/manage-secrets/),
[the D1 enforcement changelog](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)
and [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/),
all read on 2026-09-28.

| Limit | Workers Free | Workers Paid ($5/month) |
|---|---|---|
| CPU per cron invocation | 10 ms | 30 s for a cron interval under 1 hour, 15 min for 1 hour or more. Cap it with `[limits] cpu_ms`. |
| External subrequests per invocation | 50 | 10,000 |
| Cron triggers per account | 5 (1 used) | 250 |
| D1 rows read and written | 5M reads and 100k writes per day, account-wide. Queries **fail** once a cap is hit (enforced since 2026-09-01). | 25B reads and 50M writes per month included |
| Secrets Store (open beta) | 1 store per account, 100 secrets per account, each value up to 65,536 bytes. A service-account JSON fits. | same |
| Email to a **verified destination address** (the `send_email` binding) | Free, and does not count toward any quota | same. Arbitrary recipients need Paid. |

Email sending needs Email Routing on a Cloudflare DNS domain. The destination address has to be
verified once, by clicking a link sent to it.

## 3. Constraints (from the ads follow-up session and the owner)

1. **Cutover.** The in-flight daily read does not switch before the flight ends. Serving stops
   2026-10-02 at 23:00 ET, and the last in-flight read is 10-03 at 06:00 ET. The failure to design
   against is losing or duplicating a threshold or kill-rule push mid-flight.
2. **Parity.** Everything the local read does is carried over (§5).
3. **Delivery.** Pushes to Mike must not depend on any local session. The bus copy still goes to
   `best-sudoku-ads-retest-followup`.
4. **Daily log (R7).** A cloud routine would need repo write access. The owner accepts keeping
   the log in `gss-stats-ads` and rendering it, provided it stays human-browsable.
5. **Hard rules.**
   - Ads is read-only: no mutate call, ever.
   - Never send a `login-customer-id` header.
   - Firestore is read with COUNT queries only.
   - Never write Firestore or `gss-geo`.
   - Generated text contains no em-dashes. This applies on **every** surface: the stored report,
     the Reads page, the email and the bus copy, not only the narrative. Today the code itself
     emits them, in string literals such as `=== THRESHOLD READ at $25 (...) — complete ===`,
     `accept rate — (0/0)`, `Floor — devices ...`, and the `'—'` empty-value placeholder. They
     are removed at source in Phase 1 (§6.1, item 6).
   - Everything the read fetches is untrusted data.

## 4. Options

### A. Everything as a claude.ai cloud routine running the existing CLI

The routine clones gss-stats, runs `npm ci` and then `npm run ads:morning-read` or
`ads:postflight-read`, and does Steps 2 to 8 exactly as the local task does.

**Secret exposure**
- Every credential becomes an environment variable the model can read. That covers the 4 Ads
  values (the CLI would need an env path in place of `bws`, because `BWS_ACCESS_TOKEN` would
  expose all of Bitwarden), both service-account JSONs as base64, and a Cloudflare token for D1.
- The proxy's API credentials cannot carry Google's refresh or JWT flows. At most it could hide
  the Cloudflare token, and even that is unverified, since wrangler expects the token in the
  environment.
- The same session reads untrusted third-party text: placement names, recommendation text and
  bus messages. So a prompt injection is one step from a secret, and GitHub pushes, connectors
  and the Anthropic API are not allowlist-gated.
- **Blast radius with today's keys:**
  - Ads edit rights, i.e. the ability to spend;
  - Firestore editor, i.e. all user data, read and write;
  - Play publisher;
  - Cloudflare Workers, Pages, D1 and Secrets Store write.
- **With the least-privilege keys in §7**, what is left is still:
  - read access to all Firestore user documents;
  - D1 Edit on every database in the account, because D1 API permissions are account-wide,
    not per database. That includes deleting beacon data.

**Reliability**
- It survives the local machine being off.
- Money-at-stake pushes depend on a routine run starting, which runs into the daily run cap and
  subscription-usage exhaustion ("rejected until the window resets").
- The phone push itself is undocumented.
- A green status does not mean success.

**Cost:** no new infrastructure spend. Each run costs subscription usage: a full CLI run plus
analysis, every day of a flight.

**Plan limits:** the network must be Custom (defaults plus `api.cloudflare.com`), plus a daily
run and 5 one-offs.

**Propose-only:** enforced by code (GAQL SELECT only). If the key has edit rights, the key itself
is not propose-only.

**Migration:** the easiest of the options. Shadow the 10-09 wrap-up with `--dry-run`, then cut
over at day 15.

**Verdict:** the fastest to stand up, and the worst on both secret exposure and alert
reliability.

### B. The split: the Worker does the deterministic reads, a cloud routine does the narrative (recommended)

**Secret exposure**
- Every Google credential stays in Secrets Store. Only the Worker binding can read it, and it
  cannot be read back through the API or the dashboard.
- No model ever sees these credentials, and untrusted text reaches no process that holds them
  and follows instructions. The Worker does not interpret text.
- The cloud environment holds one secret: a service token that can read `/api/ads/*` and append
  a narrative. With an API credential (Pro or Max), even the routine cannot see it.
- The blast radius of a leak is ads readings (spend and counts, no personal data) plus junk
  narrative rows. The narrative table is append-only and a correction is a new row.

**Reliability**
- The Worker cron is platform-scheduled and needs neither an LLM nor a local machine.
- Alerts are emailed by the Worker the moment the rule fires.
- If the routine fails, only the narrative and the bus copy are late. The numbers, the ledger,
  the alert and the dashboard page are unaffected.

**Cost:** Workers Paid at $5/month, which also removes the account-wide D1 hard-fail risk
([capacity.md §5](../capacity.md)). The routine runs are small (read JSON, write about 150
words).

**Plan limits:** no new cron trigger (the hourly tick is code-gated). 3 more Secrets Store
secrets (11 of 100). Custom network for `stats.goodstuff.software` only.

**Propose-only:** structural. The routine has no Ads credential at all. The Worker has only GAQL
search. With §7's key, the Ads identity itself is read-only.

**Migration:** as in §6.

**Verdict:** recommended.

### C. A GitHub Actions cron runs the unchanged CLI, and a cloud routine narrates

This option was considered.

**Secret exposure**
- The keys become GitHub encrypted secrets, which are masked in logs.
- gss-stats is **public**, so run logs and artifacts are world-readable. The CLI's report (spend,
  sign-up counts, kill-rule state) would be public unless every output were suppressed, and one
  slip publishes it.
- Any workflow change reaches the secrets unless they sit in an Environment restricted to a
  protected `main`. Today `main` is unprotected, and Claude sessions can push branches.

**Reliability**
- Scheduled workflows are best-effort: they can be delayed or dropped under load.
- Scheduled workflows in public repos are disabled after 60 days without repository activity
  ([github-actions](https://code.claude.com/docs/en/github-actions)).

**Cost:** free.

**Verdict:** rejected. It would only be reasonable from a private repo with Environment-protected
secrets, and it still has weaker scheduling than a Worker cron.

### D. Worker only, with a templated narrative and no LLM

**Pros:** the most reliable option and the least exposed.

**Cons:** it loses the R6 judgment ("Working / Not working / So what") and the bus copy's
context.

**Verdict:** not chosen as the target. It is **option B's degraded mode**: if the routine does
not run, Mike still gets the email and the dashboard page.

### Why B over A, now that keys are not a blocker

Mike can set any key, so secret placement no longer decides this. What still decides it:

1. **Alert path.** In B, a threshold, kill-rule or failed-read alert is an email the Worker sends
   deterministically. In A, it depends on a cloud LLM run starting inside the daily cap and
   usage window, and then on a phone push the docs do not promise.
2. **Least privilege holds only in B.** Google's refresh and JWT flows cannot go through the
   agent proxy, so in A every Google key is readable by the model. That model also ingests
   third-party placement names and bus messages.
3. **Post-flight stages need no one-off triggers.** The Worker already knows each stage's due
   date (`POSTFLIGHT_STAGES`, keyed to the flight end), so its hourly tick runs a stage when it
   falls due.
4. **One implementation.** B extends the pattern ADR 0001 already chose for the sync: the same
   `src/lib` code in both runtimes, with idempotent writes and a fire-once ledger in D1.

## 5. Parity map: where each part of today's read runs under B

| Item (checklist: `docs/routines/bsk-retest-morning-read.md` and the post-flight doc) | Runs in | Notes |
|---|---|---|
| Spend sync, restatement window, closed-day rule | Worker | Already there (`syncAdsData`) |
| Thresholds $25/$50/$75/$100 (fire-once), kill rules, the $100 decision table, the hard cap on every read | Worker | `runMorningRead` / `fullRead`, unchanged. The D1 ledger is the arbiter. |
| Release-health pairs (MIN_COHORT, 24 h age, the install pair after the fix) | Worker | Beacon reads through a **new read-only `gss_geo` binding** that reuses `d1.ts`'s SELECT-only guard |
| Ads diagnostics: hourly, geo with bid modifiers, devices, targeting and placement count | Worker | `adsApi` fetchers, which are already runtime-neutral |
| Recommendations and auto-apply, read-only, plus the standing verdicts | Worker | GAQL SELECT, and the report prints the verdicts |
| Beacon country counts | Worker | the `gss_geo` binding |
| Firestore new-account cross-check, window counts, first-50, post-flight tier split | Worker | New read-only service account. The fence (token, first50 GET, `runAggregationQuery`) is kept. The signing moves to WebCrypto. |
| Play bulk reports, with the informational $50/$75 checkpoints | Worker | New reports-only service account. The UTF-16 decode moves to `TextDecoder`. |
| Two-segment sign-up line ("at most" before 15:43:02 ET 09-26, exact after) | Worker | `signUpsPhrase`. The routine relays it verbatim and never upgrades a bound. |
| Corrected upsell note, household caveat, retention "not available" line | Worker | `report.ts` / `play.ts` text |
| Household exclusion, closed-campaign guard (24215315197, 24234347705) | Worker | `applyExclusions`, `syncableCampaigns` |
| Missed-read detection | Worker | `missedReads`, plus a new dead-man check (§6.2) |
| Post-flight stages wrapup, day15, day30, day60, december | Worker | Run on the due date at the 09:05 ET tick. The not-due path (after-flight spend guard, cap) runs daily in the window. |
| Push decision (`notify.push`) and its text | Worker | The same rule. It is delivered by **email** (§6.2). The routine's `PushNotification` is a best-effort echo. |
| Narrative (R6) | Cloud routine | Reads the stored report and POSTs the narrative (append-only). The server rejects an incomplete narrative or one with an em-dash (§6.3, item 8). |
| No em-dashes in generated text | Worker (at source) plus the narrative route | The code's own report, note and push strings lose their em-dashes in Phase 1 (§6.1, item 6), so the rule holds for the stored report, the Reads page, the email and the bus copy. |
| Bus copy | Cloud routine | deckhand connector, `from: gss-stats`, same subject format |
| Audit trail (R7) | D1 plus the dashboard | `ads_readings` (existing) plus `ads_read_reports` and `ads_read_narratives` (new), rendered on a signed-in **Reads** page. The git log in best-sudoku is optional (§6.4). |
| Report page (Step 8a) | Dashboard, with the Artifact optional | The dashboard renders `read-page.template.html` server-side. The routine may still republish the fixed Artifact if it meets the conditions in §2.1. |

## 6. Design of B

### 6.1 The Worker (owned by gss-stats)

1. **Runtime split.** Keep the rules where they are. Add Worker adapters for `ReadDeps`:
   - the beacon, through the `gss_geo` binding and the existing SELECT-only guard;
   - the store, through `d1BindingAdsDb`, which already exists;
   - Firestore and Play, through `fetch` plus WebCrypto (`importKey('pkcs8')` and `sign`, which
     replace `createSign`) and `TextDecoder('utf-16le')` (which replaces `Buffer`).
   - Move `HOUSEHOLD_NOTE` and `RETENTION_NOTE` out of `play.ts`, which imports `node:fs`, so that
     `read.ts` bundles for workerd.
   - `npm run ads:worker-check` then proves that the bundle **builds**. It says nothing about
     cold-start CPU (item 7).
2. **Gate.** The existing hourly tick adds `readDue(nowMs)`:
   - the morning read at the first tick at or after 06:00 ET, on days inside a campaign's
     morning-read window (from `campaigns.ts`, not hardcoded);
   - post-flight stages at the first tick at or after 09:00 ET on or after their due date, until
     recorded.
   Because the cron is hourly and gated on ET, DST (2026-11-01) needs no cron change. An atomic
   claim, the same shape as `ads_sync_runs`, stops two ticks or an on-demand call from running
   the same read at once.
3. **Mode switch.** A var `READS_MODE = off | shadow | live`.
   - `shadow` runs with `dryRun: true`, the CLI's own no-write mode. It writes nothing to
     `ads_readings` or `ads_threshold_state`, so it cannot consume a threshold or suppress
     today's local push. It stores its result as `mode = 'shadow'` and sends no email.
   - `live` records and emails.
4. **Storage** (migration `0005`):
   - `ads_read_reports`: campaign, ET date, kind, mode, `read_at`, worker SHA, the human report
     text and the result JSON. It is append-only (with the same triggers as `ads_readings`) and
     unique on campaign, date, kind and mode. D1 caps a statement at 100 KB, so measure the
     largest real result and gzip it (`CompressionStream`) or chunk it if needed.
   - `ads_read_narratives`: the report id, headline, working, notWorking and soWhat (JSON),
     author, and `created_at`. It is append-only, and the latest row wins.
   - `ads_read_alerts`: one row per live read whose `notify.push` was true. It records the report
     id, `attempted_at`, and the `send_email` outcome (`sent`, or `failed` with a redacted
     one-line reason). It is written in the same run as the report, append-only (§6.2).
5. **Paid plan settings:** `[limits] cpu_ms = 60000` as a runaway guard, and default subrequests.
6. **No em-dashes at source.** This can ship after 10-03, and must land before cutover.
   - Replace every U+2014 in the string literals that feed generated output with a comma, a colon
     or parentheses. That covers `scripts/ads-reads/report.ts`, `play.ts` and `read.ts`, plus the
     `src/lib` strings the report prints: the `adsRules.ts` notes and proposals, the
     `adsSync.ts` sync summary lines and the `campaigns.ts` caveats.
   - Examples: `=== THRESHOLD READ at $25 (...) — complete ===` becomes
     `=== THRESHOLD READ at $25 (...): complete ===`; `accept rate — (0/0)` becomes
     `accept rate: none yet (0/0)`; `Floor — devices ...` becomes `Floor: devices ...`.
   - The empty-value placeholder `'—'` becomes `n/a`.
   - Code comments are not output and stay as they are. The dashboard's own card placeholders
     (`src/lib/metrics/render.ts`, `kpiFormat.ts`) are UI, not routine output, so they are out of
     scope unless the owner wants them changed too.
   - Add a test: format the morning, threshold, post-flight and not-due reports from every
     fixture, plus `notify.text` and the rendered read page, and assert that no U+2014 appears
     anywhere.
7. **No `Intl` at module scope** (a build checklist item for every Phase 1 change):
   - No `Intl.NumberFormat`, `Intl.DateTimeFormat` or similar formatter, and no `toLocale*String`
     call, may run at module scope anywhere in the Worker bundle. Build formatters lazily, inside
     the handler, or use the plain ET arithmetic in `src/lib/etTime.ts`.
   - Why: PR #27 regressed this once. A module-scope `Intl.DateTimeFormat` in `adsRules.ts` took
     the Worker's module init from 2.2-4.0 ms to 16.7-24.8 ms (PR #33,
     `fix/ads-rules-no-intl-at-load`, measured on the esbuild bundle).
   - The guard is PR #33's `scripts/ads-reads/workerNoIntlAtLoad.test.ts`, which spies on every
     `Intl` constructor and `toLocale*String` and then imports the Worker entry fresh. Every new
     module the reads pull into the bundle is reached through that import, so the test covers it.
     Keep it green.
   - `ads:worker-check` proves only that the bundle builds, so cold-start CPU must also be checked
     with this test and with `scripts/ads-reads/profile-worker.ts`.

### 6.2 Alerts that need no Claude session

- A `send_email` binding with `destination_address` pinned to Mike's verified address, so the
  binding cannot mail anyone else. It is sent when a live read's `notify.push` is true. The
  subject and body are `notify.text` (already short and secret-free by construction) plus a link
  to the dashboard Reads page. It is free on every plan
  ([Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/)).
  The from-address and its subdomain are set in §7, "Non-secret setup".
- **The send result is recorded.** Every live read with `notify.push` true writes an
  `ads_read_alerts` row (§6.1, item 4) holding the `send_email` outcome. A failed or missing send
  is then visible to the routine and on the Reads page, not only in Worker logs.
- **Dead-man check:** at the 07:05 ET tick on a morning-read day, and the 10:05 ET tick on a
  stage due date, if no live report exists for today, email "BSK read did not run" with the
  claim or error state. The ads session accepts that this is about an hour slower than today's
  immediate bootstrap-failure push.
- **Second observer, for a missing report:** the cloud routine sees a missing report. It reports
  that in its own run and on the bus, and makes a best-effort `PushNotification`.
- **Second observer, for a failed alert email.** This is separate from the dead-man check. The
  routine reads today's live report. If its `notify.push` is true and its `ads_read_alerts` row
  says `failed`, or there is no row, the routine treats that as its own alert:
  - it sends one `PushNotification` carrying the report's `notify.text`;
  - it sends one bus message to `best-sudoku-ads-retest-followup` saying that the alert email did
    not go out, plus the same text.

  That is the one case where the routine relays push text for the numbers. It uses the Worker's
  text verbatim and never writes its own.

### 6.3 The dashboard API and the service token (owned by gss-stats)

**New routes**
- `GET /api/ads/report?campaignId=&etDate=&kind=` returns the stored report and the latest
  narrative.
- `POST /api/ads/narrative` appends a narrative.
- A signed-in **Reads** page lists each report with its narrative. It is the human-browsable R7
  log.

**Service-token path in `functions/_lib/auth.ts`**
1. **Format.** `gssrt_` plus 32 random bytes in base64url. The prefix lets
   `scripts/ads-reads/scan-secrets.ts` and GitHub secret scanning spot a leak.
2. **Storage.** Only its **SHA-256** is stored, as the Pages secret `ADS_ROUTINE_TOKEN_SHA256`,
   with an expiry `ADS_ROUTINE_TOKEN_NOT_AFTER`. A leak of the Pages environment does not leak
   the token.
3. **Where it is accepted.** Only in an `Authorization: Bearer` header. It is never taken from a
   cookie or a query string, is never turned into a session, and gets no `/auth/me`.
4. **Check order.** It is checked before the session. A presented token that is invalid, expired
   or used off the allowlist gets `401` or `403`. It never falls through to the Google session or
   redirect path, and it never mixes with a cookie session in the same request.
5. **Allowlist, by exact method and path.**
   - Allowed: `GET /api/ads/readings`, `GET /api/ads/report`, `POST /api/ads/narrative`.
   - Not allowed: `/api/ads/refresh` (it triggers Google pulls), `/api/config` (KV writes),
     `/api/geo`, `/api/metrics` and every page or asset.
6. **Comparison.** Constant time, on the hash. It fails closed if the secret is missing or
   malformed, and the gate's `503` "not configured" behaviour is untouched for everything else.
7. **The Origin check** (ADR 0002) stays for cookie-authenticated non-GET requests. A bearer
   request carries no ambient credential, so CSRF does not apply to it.
8. **Narrative validation.**
   - The campaign must be in `CAMPAIGNS`.
   - The date and kind must match a stored **live** report.
   - `headline` must be a non-empty string, and `working`, `notWorking` and `soWhat` must each be
     a non-empty array of non-empty strings. The route rejects anything else with `400`. The
     morning-read Step 5 rule is that "a report with the headline alone is a failed run". The
     route enforces it, so the Reads page never shows an incomplete narrative as complete. The
     same shape is what `ads:read-page --narrative` already requires.
   - Each string is at most 500 characters, and the body at most 8 KB.
   - U+2014 (the em-dash) is rejected.
   - The text is always rendered HTML-escaped, because LLM text shaped by untrusted fetches must
     not become script on the signed-in dashboard.
9. **Logging.** Log the principal `service:ads-routine`, the path and the status. Never log the
   header.

**Security review**
- **A leaked token** can read spend, counts and rule results (no personal data, by the
  COUNTS-only design) and append size-capped narratives. It cannot reach Google, Firebase, Play,
  raw beacon rows, KV config or sessions. Revoking it means deleting the Pages secret and
  redeploying, after which the gate fails closed with `401`. Rotation, like every Pages variable,
  takes effect on the next deployment (ADR 0002).
- **Replay** is no worse than holding the token: TLS only, and no URL placement.
- **Dashboard bot protection or WAF** could challenge requests from Anthropic's egress IPs. This
  is to verify in Phase 0 (§8).
- **Alternatives rejected:**
  - A Cloudflare API token with D1 Read: account-wide, so it would expose raw `gss-geo` hits.
  - A Cloudflare Access service token on `/api/ads/*`: it re-adds Access, which ADR 0002
    removed, and needs app-side JWT validation. It is the fallback if redeploy-to-rotate becomes
    a burden.
  - Handing the report over the bus: bus bodies are untrusted by contract, and the Worker would
    need a bus token.

### 6.4 The cloud routine (owned by the ads follow-up session)

**Environment**
- Custom network access: the default list plus `stats.goodstuff.software`. It needs no Google or
  Cloudflare hosts.
- One API credential (Bearer, host `stats.goodstuff.software`) on Pro or Max. On Team, an env var
  instead.

**Connectors:** deckhand only. Remove the rest, since a routine can use every included
connector's tools, writes included, without asking.

**Repo:** gss-stats, read-only use. It is needed only if the routine rebuilds the Artifact page
with `npm run ads:read-page`, which works unchanged if the API returns the report in the CLI's
`.out` shape.

**Morning prompt**
1. Wait for today's live report, polling for up to 20 minutes.
2. Check its alert row (§6.2). If `notify.push` is true and the email failed or has no row,
   send the push and the bus alert described there.
3. Compose the R6 narrative from the report's numbers only.
4. `POST /api/ads/narrative`.
5. When `notify.busCopy` is set, make the bus copy as Step 6 does today:
   - the narrative **followed by the full human report**, i.e. everything above
     `----- JSON -----`, which the API returns verbatim;
   - `agent_send` from `gss-stats` to `best-sudoku-ads-retest-followup`, with
     `includeEphemeral: true`;
   - the current subject format: `BSK retest $<highest crossed threshold> read <ET date>`, or
     `BSK retest post-flight <stage> <ET date>`.

   The narrative alone is not enough.
6. Optionally republish the fixed Artifact.
7. Output the narrative, the Reads-page link and at most three status lines.

Apart from the failed-email case in step 2, it never writes or relays push text for the numbers,
because the Worker has already emailed.

**Post-flight prompt:** the same, for the stage's report.

**Schedules**
- Daily at 06:37 ET inside a morning-read window.
- One-offs at 09:37 ET on stage due dates, which do not count against the daily cap.

**Later option:** the Worker fires the routine through `/fire` right after storing a report. That
is event-driven, with no idle runs, but it needs a routine token in Secrets Store, and the
endpoint is a beta.

**R7 git log:** optional. If the owner wants the best-sudoku log kept, the routine can push to
`docs/ads-next-campaign`. That needs the Claude GitHub App on the private repo, and the run must
work on that branch. By default the log moves to D1 and the Reads page (constraint 4).

**Acknowledged by the ads session (review of e82cbb3, 2026-09-28):**
- D1 plus the Reads page satisfies constraint 4, provided the Reads page is reachable to Mike.
  After cutover, the ads session itself carries the post-flight results into section 13 of the
  retest build spec. So the Claude GitHub App is not needed on the private repo. Mike can
  overrule this (§9, decision 5).
- The dead-man check at 07:05 ET is about an hour slower than today's immediate
  bootstrap-failure push. That is acceptable.

## 7. Keys Mike sets

Agents never see or handle these values. Mike creates each key and puts it in place himself.

| # | Credential | Target | Least-privilege scope | Replaces (local copy retired after cutover) |
|---|---|---|---|---|
| 1 | Google Ads refresh token | Secrets Store `google-ads-api-rep-refresh-token` → `ADS_REFRESH_TOKEN` (exists, value replaced) | Minted by a dedicated **Read-only** Google Ads user; never `login-customer-id` | The edit-capable user's token (Bitwarden stays the source of truth) |
| 2 | Ads client id, client secret, developer token | Secrets Store `google-ads-api-rep-client-id`, `-client-secret`, `-developer-token` → `ADS_CLIENT_ID`, `ADS_CLIENT_SECRET`, `ADS_DEVELOPER_TOKEN` (exist, unchanged) | App identity | `BWS_ACCESS_TOKEN` use at read time |
| 3 | Firestore read-only SA (new) | Secrets Store `gss-firestore-ro-sa` → `FIRESTORE_RO_SA` | `roles/datastore.viewer` only, plus the COUNT-only code fence | `~/.firebase/service-accounts/best-sudoku-prod.json` (editor-level) for the reads |
| 4 | Play bulk-reports SA (new) | Secrets Store `gss-play-reports-ro-sa` → `PLAY_REPORTS_SA` | No GCP roles; Play Console "View app information" (Global) only | `~/.google-play/service-accounts/best-sudoku-prod.json` (publisher) for the reads |
| 5 | Dashboard service token (new) | Pages secret `ADS_ROUTINE_TOKEN_SHA256` (hash only) and, in the claude.ai environment, an API credential for `stats.goodstuff.software` (Team plan: env var `GSS_ADS_TOKEN`) | Three routes: `GET /api/ads/readings`, `GET /api/ads/report`, `POST /api/ads/narrative` | Nothing (new) |
| 6 | Deckhand bus | claude.ai connector grant (no key) | Bus send as `gss-stats` | The machine's bus credential, for this routine |
| 7 | Routine `/fire` token (optional, later) | Secrets Store `gss-ads-routine-fire-token` → `ROUTINE_FIRE_TOKEN` | Starts that one routine only | Nothing (new) |

The subsections below give, for each row, the exact commands or UI path and how to rotate or
revoke it.

- The Secrets Store store id is `deb0011dfe80443091c08d92874ddf06`.
- Run each `wrangler` command from the gss-stats repo root, signed in as Mike.
- Every `secrets-store secret create` reads the value from stdin or a prompt; never use `--value`
  ([wrangler Secrets Store](https://developers.cloudflare.com/workers/wrangler/commands/secrets-store/)).
- To pipe a JSON key as one line in PowerShell:
  `(Get-Content key.json -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 5) | npx wrangler secrets-store secret create deb0011dfe80443091c08d92874ddf06 --name <name> --scopes workers --remote`
  Then delete the local `key.json`.

### Google Ads refresh token

Target and scope:
- Secrets Store `google-ads-api-rep-refresh-token`, binding `ADS_REFRESH_TOKEN`. It exists; the
  value is replaced.
- Least privilege is a **new token minted by a dedicated Google identity with Read-only access**
  on Ads customer 8726535246. A Read-only user cannot edit campaigns
  ([access levels](https://support.google.com/google-ads/answer/9978556)), and the `adwords`
  scope has no read-only variant.
- It never sends `login-customer-id`, and the code sends GAQL `googleAds:search` only.

How Mike sets it:
1. Invite the identity as Read-only in Google Ads, under Admin, then Access and security.
2. As that identity, with the existing OAuth client, run
   `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/adwords,https://www.googleapis.com/auth/cloud-platform --client-id-file=<client json>`
   ([single-user auth](https://developers.google.com/google-ads/api/docs/oauth/single-user-authentication)).
3. Put the `refresh_token` into Bitwarden `google-ads-api-rep-refresh-token`.
4. Run `npm run ads:worker-secrets -- --cf-token-file <path>`, which updates Secrets Store from
   Bitwarden.
5. Delete the generated ADC file. Do **not** run `revoke`, which would kill the new token.

**Do this after 10-03.** Both the local reads (through Bitwarden) and the Worker switch to the
read-only identity at once.

Rotate or revoke: mint a new token and repeat steps 3 and 4. To revoke, remove the identity's
access in Google Ads, or revoke the app in that Google account's security settings.

Replaces: the edit-capable user's refresh token. Bitwarden stays the source of truth.

### Google Ads client id, client secret and developer token

Target: Secrets Store `google-ads-api-rep-client-id`, `-client-secret` and `-developer-token`,
bindings `ADS_CLIENT_ID`, `ADS_CLIENT_SECRET` and `ADS_DEVELOPER_TOKEN`. These already exist
(ADR 0001).

Scope: the app identity. It is not user-scoped.

How Mike sets it: no change. `npm run ads:worker-secrets` copies them from Bitwarden.

Rotate or revoke: rotate in Bitwarden, then run `npm run ads:worker-secrets`, and the Worker picks
the new values up on its next invocation.

Replaces: the reads' use of `BWS_ACCESS_TOKEN` at run time.

### Firestore read-only service account (new)

Target: Secrets Store `gss-firestore-ro-sa`, binding `FIRESTORE_RO_SA`.

Scope: a new service account `gss-ads-reads-ro@best-sudoku-prod.iam.gserviceaccount.com` with
**only `roles/datastore.viewer`**. The code fence stays on top: token, first50 GET and
`runAggregationQuery` only, COUNT only.

How Mike sets it:
1. `gcloud iam service-accounts create gss-ads-reads-ro --project best-sudoku-prod`
2. `gcloud projects add-iam-policy-binding best-sudoku-prod --member serviceAccount:gss-ads-reads-ro@best-sudoku-prod.iam.gserviceaccount.com --role roles/datastore.viewer`
3. `gcloud iam service-accounts keys create key.json --iam-account gss-ads-reads-ro@best-sudoku-prod.iam.gserviceaccount.com`
4. Pipe `key.json` to `secrets-store secret create --name gss-firestore-ro-sa`, as shown at the
   top of §7.

Rotate or revoke: `keys create` a new key and update the secret. The dashboard route is Secrets
Store, then `gss-firestore-ro-sa`, then Edit. Then `gcloud iam service-accounts keys delete <old id>`.
To revoke, disable the service account.

Replaces: the reads' use of `~/.firebase/service-accounts/best-sudoku-prod.json` (the
firebase-adminsdk key, editor-level). That key keeps whatever other best-sudoku uses it has, but
the reads stop using it.

### Play bulk-reports service account (new)

Target: Secrets Store `gss-play-reports-ro-sa`, binding `PLAY_REPORTS_SA`.

Scope:
- A new service account `gss-play-reports-ro@best-sudoku-prod.iam.gserviceaccount.com` with **no
  GCP roles**.
- In Play Console, under Users and permissions, invite it with only **View app information**,
  set to **Global** (read-only). Bulk-report access is granted in Play Console, not by IAM on the
  `pubsite_prod_…` bucket, which Google owns
  ([Play Console reports](https://support.google.com/googleplay/android-developer/answer/6135870)).

How Mike sets it:
1. `gcloud iam service-accounts create gss-play-reports-ro --project best-sudoku-prod`
2. In Play Console, go to Users and permissions, then Invite new user, and give the address the
   View app information (Global) permission only.
3. `gcloud iam service-accounts keys create …`
4. Pipe the key to `secrets-store secret create --name gss-play-reports-ro-sa`.

Create it in Phase 0, because Play access can take time to apply.

Rotate or revoke: rotate the key the same way as the Firestore one. To revoke, remove the user in
Play Console or disable the service account.

Replaces: the reads' use of `~/.google-play/service-accounts/best-sudoku-prod.json` (the
play-publisher key). The publisher key keeps its release role for uploads and **must never go to
a cloud environment**.

### Dashboard service token (new)

Target and scope:
- (a) The Pages secret `ADS_ROUTINE_TOKEN_SHA256`, plus the var `ADS_ROUTINE_TOKEN_NOT_AFTER`,
  on project `gss-stats`.
- (b) In the claude.ai cloud environment, an **API credential** of type Bearer on host
  `stats.goodstuff.software`. On a Team plan, an env var `GSS_ADS_TOKEN` instead.
- It can call three routes only: `GET /api/ads/readings`, `GET /api/ads/report` and
  `POST /api/ads/narrative` (§6.3).

How Mike sets it:
1. Generate the token and its hash on his own machine:
   `node -e "const c=require('crypto');const t='gssrt_'+c.randomBytes(32).toString('base64url');console.log(t);console.log(c.createHash('sha256').update(t).digest('hex'))"`
2. Set the hash: `npx wrangler pages secret put ADS_ROUTINE_TOKEN_SHA256 --project-name gss-stats`
   and paste the hash.
3. Redeploy (merge to `main`).
4. At claude.ai/code, open the environment's settings, then API credentials, then Add credential.
   Paste the token.

Rotate or revoke: generate a new token, `pages secret put` the new hash, redeploy, and replace the
credential. The old token dies at that deploy. To revoke, `npx wrangler pages secret delete ADS_ROUTINE_TOKEN_SHA256 --project-name gss-stats`
and redeploy; the gate then fails closed.

Replaces: nothing. It is new.

### Deckhand bus

Target: the claude.ai **connector** included in the routine, as a connector grant. It needs no
key.

Scope: bus send as `gss-stats`.

How Mike sets it: approve the connector once, if it is not already connected.

Rotate or revoke: revoke the connector at claude.ai/customize/connectors.

Replaces: the machine's bus credential, for this routine.

### Optional, later: routine `/fire` token

Target: Secrets Store `gss-ads-routine-fire-token`, binding `ROUTINE_FIRE_TOKEN`.

Scope: it can start that one routine only, and its text arrives as untrusted data.

How Mike sets it: at claude.ai/code/routines, choose the routine, then Edit, then Add another
trigger, then API, then Generate token. Pipe the token to `secrets-store secret create`.

Rotate or revoke: use Regenerate or Revoke in the same modal.

Replaces: nothing.

### Non-secret setup

Alerts by email:
- **From-address (Mike's choice).** The default is `alerts@notify.goodstuff.software`, on a
  dedicated subdomain `notify.goodstuff.software`. A Worker can send only from a domain that has
  Email Routing enabled
  ([Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/)).
  A dedicated subdomain keeps its MX records away from the apex domain's mail.
- **Check first** whether `goodstuff.software` already receives mail elsewhere, because Email
  Routing adds MX records. The default subdomain avoids that conflict whatever the answer is.
  Use the apex domain only if it has no mail setup and Mike prefers it.

Steps:
1. In the Cloudflare dashboard, go to Compute, then Email Service, then Email Routing, and enable
   it on the chosen subdomain.
2. Under Destination Addresses, add Mike's address and click the verification link.
3. Add a `send_email` binding to `workers/sync/wrangler.toml`, with `destination_address` set to
   that verified address. The Worker sends from the from-address above.

### Credentials that are no longer needed in the cloud or by the reads after cutover

- `C:/Users/msant/dev/cf-token.txt`: the Worker uses bindings. Keep the file for deploys.
- `BWS_ACCESS_TOKEN` at read time. Bitwarden stays the source of truth for
  `ads:worker-secrets`.
- Both local service-account files, for the reads.
- Every local copy stays in place until day 60, because the local tasks are the fallback until
  then (§8).

## 8. Phased plan

| Phase | Dates | What happens | Owner |
|---|---|---|---|
| **0. Decide and verify** | now to 10-03 | See the list below this table. | Mike, gss-stats, the ads session |
| **1. Build** | 09-29 to 10-08 | See the list below this table. | gss-stats |
| **2. Shadow** | 10-09 (wrap-up) | See the list below this table. | gss-stats, the ads session |
| **3. Cutover** | 10-10 to 10-17 (day 15) | See the list below this table. | Mike, gss-stats, the ads session |
| **4. Cloud only** | 11-01 (day 30), 12-01 (day 60), 12-03 (december) | See the list below this table. | the ads session, Mike |
| **Next flight** | when it is configured | The morning read runs in the Worker from day 1, and the routine runs the narrative. There are no local tasks. | all |

**Phase 0: decide and verify (now to 10-03)**
- The flight keeps running on the **unchanged local tasks** (constraint 1).
- Mike approves the ADR, Workers Paid, and the email channel.
- Mike creates the read-only Firestore and Play identities and the service token. They are
  created now and **not wired in yet**. The Ads refresh-token swap waits until after 10-03.
- Probes, each read-only:
  1. A throwaway cloud routine calls `PushNotification` and `curl`s `https://stats.goodstuff.software/auth/me`. It must get `401` JSON, not a bot challenge.
  2. Check the plan tier, to confirm the API-credentials feature.
  3. Check that the Artifact meets the republish conditions.
  4. Check the MX records for Email Routing.

**Phase 1: build (09-29 to 10-08)**
- On `feat/` branches, each reviewed:
  - the Worker adapters, `readDue`, the claim, `READS_MODE`, migration 0005 and the email
    binding;
  - the service-token gate, `/api/ads/report`, `/api/ads/narrative` and the Reads page;
  - fixture parity tests, in which the same fixture run through the CLI and the Worker adapters
    gives byte-identical JSON and report text;
  - the source-level em-dash removal and its no-U+2014 test (§6.1, item 6). It can ship after
    10-03, when changing report text no longer touches an in-flight read, and it must land before
    cutover.
- **Build checklist for every Phase 1 PR:**
  - no `Intl` formatter is built at module scope in the Worker bundle (§6.1, item 7);
  - `workerNoIntlAtLoad.test.ts` stays green;
  - cold-start CPU is re-profiled, because `ads:worker-check` proves only that the bundle builds.
- Deploy only with `READS_MODE=off` before 10-03. From 10-04, use `shadow`. The daily not-due
  post-flight run doubles as a live check of the after-flight spend guard.
- The ads session writes the cloud routine prompts and environment, and rehearses against the
  shadow reports with the bus copy labelled "rehearsal".

**Phase 2: shadow (10-09, the wrap-up)**
- The **local wrap-up stays live** (09:00 ET) and is the read of record.
- The Worker runs the same stage in `shadow` at 09:05 ET.
- The routine rehearses.
- Compare the thresholds, rule results, `notify`, counts and report text.
- A difference caused only by read time is noted. Any rule or notify difference blocks cutover.

**Phase 3: cutover (10-10 to 10-17, day 15)**
- **Cutover gate.**
  1. After the 10-09 comparison, and **by 10-15**, gss-stats sends the ads session a **go** or
     **no-go** decision by cross-session message (SendMessage). The ads session's bus handle has
     no wake handle, so a bus message alone is not enough. The bus copy is in addition, not
     instead.
  2. **On go:** the ads session edits the local day-15 task to add `--dry-run`, making it a
     comparator. It confirms back to gss-stats, by cross-session message, with the task's new
     prompt line quoted. gss-stats does not set `READS_MODE=live` until that confirmation
     arrives.
  3. **On no-go, or with no confirmation by 10-16:** the local day-15 task stays live and is the
     read of record, the Worker stays in `shadow`, 10-17 is a second comparison, and cutover
     moves to 11-01 with the same gate (decision by 10-29).
- After 10-03, Mike swaps the Ads refresh token to the read-only identity (§7) and sets the new
  keys.
- On go, set `READS_MODE=live`. On 10-17 the Worker records and emails, and the routine narrates
  and makes the bus copy.
- The dedup ledger makes a manual local live run safe if the Worker's report is missing by
  09:45 ET: "stored by a concurrent run" means no second push.

**Phase 4: cloud only (11-01, 12-01, 12-03)**
- The local post-flight tasks are **disabled, never deleted**, once day 15 matched.
- After 12-03, retire the local credential copies listed in §7 for the reads.

**Gaps checked.** In-flight reads stay local through the last one on 10-03 at 06:00 ET. From
10-04 to 10-08 no read is scheduled (the morning window ends on 10-03), and the Worker's daily
03:05 ET sync continues. Each post-flight date has exactly one read of record: local on 10-09,
Worker from 10-17 on a go, otherwise local until the 11-01 gate. Duplicates are impossible by construction, because the unique
`(campaign, et_date, entry_kind)` key and the fire-once threshold key decide which run pushes.

## 9. Owner decisions needed

1. **Accept option B.** A is the fallback only if B cannot be ready for 11-01. Until then, stay
   local.
2. **Workers Paid, $5/month.** Required for B. It also removes the D1 free-tier hard-fail risk
   for the dashboard.
3. **Keys (§7):**
   - the read-only Ads identity (after 10-03);
   - the new read-only Firestore service account;
   - the new Play reports-only service account;
   - the dashboard service token.

   All are new credential plumbing, which is why they need this approval.
4. **Alert channel:** email through Cloudflare Email Routing to a verified address, from
   `alerts@notify.goodstuff.software` by default (§7, "Non-secret setup"). The alternative is a
   push service such as ntfy, which adds a vendor and a token.
5. **R7 log:** the D1 and Reads page (default), or also the best-sudoku git log. The second
   needs the Claude GitHub App on the private repo. The ads session accepts the default, provided
   the Reads page is reachable to Mike, and it carries the post-flight results into section 13 of
   the retest build spec itself (§6.4). The default stands unless Mike overrules.
6. **Plan tier.** On Pro or Max, the service token goes in as an API credential that the model
   cannot see. On Team, it is an env var.

## 10. Open risks

- **Phone push from cloud runs is undocumented.** It is designed around (§6.2) and probed in
  Phase 0.
- **Today's local pushes may reach only the desktop** unless Remote Control is connected at run
  time (§1.4). It is flagged for the in-flight days and not changed here.
- **Runtime port fidelity.** RSA-JWT signing through WebCrypto, UTF-16 CSV decoding and beacon
  summarisation must match the Node output. This is guarded by the fixture parity tests and the
  10-09 shadow.
- **Report size against D1's 100 KB statement cap.** Measure it, then gzip or chunk.
- **Bot protection or WAF** on `stats.goodstuff.software` blocking Anthropic egress. This is the
  Phase 0 probe. If it bites, a WAF skip rule scoped to `Authorization: Bearer gssrt_` on
  `/api/ads/*` is the fix. The Free plan has limited rules.
- **Email Routing MX conflict** on the apex domain. Use a subdomain.
- **Research-preview churn.** Routines, the daily cap and `/fire` may change. The deterministic
  path does not depend on any of them.
- **Secrets Store is an open beta** with one store and 100 secrets; 11 would be used.
- **Service-account key creation** may be blocked by an org policy
  (`iam.disableServiceAccountKeyCreation`). Check in Phase 0. If it is blocked, the owner lifts
  it for the project or the design needs a keyless path, and none exists for Workers today.
- **A D1 binding is not read-only at the platform level.** The Worker's new `gss_geo` binding
  relies on the code's SELECT-only guard, as the dashboard's already does.
- **Mixed ledger writers during Phase 3.** A comparator must be `--dry-run`. A live local run is
  safe only because of the dedup design. If the ledger is unreadable, a duplicate push is
  preferred over a missed one, by design.

## Reversal

- Set `READS_MODE=off`. The Worker returns to sync only.
- Re-enable the disabled local tasks. They were never deleted.
- Remove the service-token secret and redeploy, and the gate fails closed.
- Delete the three new Secrets Store secrets (owner only).
- Downgrade from Workers Paid, after checking CPU with `READS_MODE=off`.

The `ads_read_*` tables are append-only history and harmless if left in place.
