# Render check: look at the page as it renders

Reading a diff does not show what a page looks like. Before landing any change that alters what a page
shows (code, or a stored prod layout), render it locally with the real layout and a copy of the real data,
at desktop and phone widths, and compare before and after screenshots. This is the procedure.

Nothing here signs in: the local server uses the repo's `AUTH_DEV_BYPASS=1` (loopback only; README, Local
development). Never bind to all interfaces, and never pass `--remote` to a write command below. Env data
(tokens, ids) comes from Bitwarden (`bws`) or env vars at run time, never from this file.

`<S>` is a scratch directory outside the repo for the D1 export, layout files and screenshots.

## 1. One worktree per code version

    git fetch origin
    git worktree add --detach ../gss-stats-wt-before origin/main     # "before"
    git worktree add -b fix/<scope> ../gss-stats-wt-after origin/main  # "after": your branch

## 2. Data: one prod D1 export per session

D1 reads are metered, so export once, keep the files in `<S>`, and delete them when done.

    export CLOUDFLARE_API_TOKEN=...      # from Bitwarden; never echo it
    npx wrangler d1 export gss-geo       --remote --output "<S>/d1/gss-geo.sql"
    npx wrangler d1 export gss-stats-ads --remote --output "<S>/d1/gss-stats-ads.sql"

The layout to look at is the saved layout: export it once (`wrangler kv key get dashboard:default
--binding STATS_CONFIG --remote`) to `<S>/layout-prod.json`. Any candidate layout is another JSON file.

## 3. Per worktree: build, then seed local D1 and KV

    cp <main checkout>/.dev.vars .dev.vars && printf '\nAUTH_DEV_BYPASS=1\n' >> .dev.vars
    npm ci && npm run build
    npx wrangler d1 execute gss-geo       --local --file "<S>/d1/gss-geo.sql" -y
    npx wrangler d1 execute gss-stats-ads --local --file "<S>/d1/gss-stats-ads.sql" -y
    npx wrangler kv key put dashboard:default --path "<S>/layout-prod.json" --binding STATS_CONFIG --local

`.dev.vars` is gitignored; delete it when finished.

## 4. Serve

One port per worktree, loopback only, in the background:

    npx wrangler pages dev --port 8791 --ip localhost

After a code edit run `npm run build` in that worktree and reload the page.

## 5. Swap layouts (local KV only)

Put the layout JSON in local KV with the `kv key put` line above, then clear the browser's local storage
and reload. A fit-to-content layout is not written back by a page load (saves hold each fit card at its
loaded height), but re-put the layout before each shot anyway so every shot starts from the same state.

## 6. Look

- Widths: 1280 (desktop), about 740 (narrow, where fit cards wrap), and 390 (phone).
- Pages: every page the change can touch, at each width. For a layout change, the whole page, tall enough
  to hold it (a 12000 px viewport avoids a cropped full-page shot).
- Screenshots: headless Chrome with a fresh profile, `--screenshot=<file> --window-size=<w>,<h>
  --virtual-time-budget=25000 "http://localhost:<port>/?page=<page-id>"`, before and after, same names
  apart from a `before`/`after` marker. Never open a visible window.
- Live DOM: with the page open, `.vgl-item` gives each card's `transform` (translate3d y) and
  `offsetHeight`; overlap is a card whose y is less than the previous card's y plus height in the same
  column. Hidden content is `.card-body` with `scrollHeight` greater than `clientHeight`.
- Read every shot: no card over another, no clipped row, no scroll inside a card that should show all its
  rows, and the card you changed shows what it should. Differences between before and after outside the
  change are findings.

## 7. Clean up

Stop the servers; delete `<S>/d1/*.sql`, each worktree's `.wrangler/state` and `.dev.vars`; remove the
worktrees (`git worktree remove`).
