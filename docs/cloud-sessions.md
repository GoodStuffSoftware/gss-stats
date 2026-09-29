# Cloud sessions (Claude Code on the web)

What a claude.ai cloud session of this repo needs, learned the hard way on 2026-09-29.
Local development is in the README ([Local development](../README.md#local-development)).

## Cloudflare / D1 access

- The environment provides `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- The environment's **network access** must allow `api.cloudflare.com`, or every
  `wrangler … --remote` call fails with a bare `fetch failed` (the proxy answers 403 to
  CONNECT). Also allow `sparrow.cloudflare.com` (wrangler's usage metrics). Queries work
  without it, but the proxy logs a denial on every call.
- Run `npm ci` first. Wrangler isn't on the image, only in `node_modules`.
- Read the beacon with
  `npx wrangler d1 execute gss-geo --remote --json --command "<SQL>" 2>/dev/null`.
  Wrangler prints a proxy warning to stderr, so drop stderr before parsing the JSON.
- Best Sudoku rows use **`site = 'bestsudoku-web'`** and **`site = 'bestsudoku-app'`**.
  There is no `site = 'bestsudoku'`, so a query using it silently returns zero.

## Plugins (agent-companion, deckhand)

The marketplaces `agent-templates` (plugin `agent-companion`, the `ac-<model>-<effort>`
worker ladder and guardrail hooks) and `deckhand` (plugin `deckhand`, the agent bus) are
added on the claude.ai account. As of 2026-09-29 the account sync did **not** install them
into cloud containers: `claude plugin list` showed nothing.

Two fallbacks, either is enough:

1. **This repo.** [`.claude/settings.json`](../.claude/settings.json) declares both
   marketplaces and enables both plugins, so any session of gss-stats should load them.
   It changes nothing else.
2. **Every repo in the environment.** Add to the environment's setup script:

   ```bash
   claude plugin marketplace add GoodStuffSoftware/agent-templates
   claude plugin marketplace add msantoro12/deckhand
   claude plugin install agent-companion@agent-templates
   claude plugin install deckhand@deckhand
   ```

Plugins load only at session start. Installing mid-session doesn't help that session, and
`/reload-plugins` isn't available in cloud sessions. Check a new session by confirming the
`agent-companion:ac-*` agents are listed.

## Agent bus identity

The bus name `gss-stats` belongs to the desktop credential. A cloud session that registers
as `gss-stats` is given a separate identity (`gss-stats-3` on 2026-09-29) with its own
empty inbox. It can still drain `gss-stats`'s inbox with `agent_inbox {name: "gss-stats"}`.
A cloud-spelled session id doesn't prove ownership, so joining the two names needs an
operator's admin rebind. Cloud sessions have no wake path while deckhand's automatic
repair is off, so queued messages wait for the next turn.
