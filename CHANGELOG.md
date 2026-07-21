# Changelog

All notable changes to **gss-stats** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] — 2026-07-21

### Fixed
- **Drill-down menu no longer collides with the chart tooltip.** Clicking (or tapping) a
  chart value now dismisses the hover tooltip as the "Open as filtered page" menu opens, so
  the two no longer overlap — most noticeable on touch, where a tap triggered both at once.
- **Best Sudoku launch page is now fully beacon-backed.** When built by duplicating the
  RUM "Overview" page, half its charts queried Cloudflare RUM — which has almost no Best
  Sudoku data (the site is behind Access; the beacon is the real source) — and rendered
  empty. Every chart on the page now reads the bot-free beacon, filtered to the Best
  Sudoku beacon tags (web + app), and new charts added there default to the beacon too. A
  one-time migration repairs already-saved dashboards, and "Restore default charts" on that
  page re-switches every chart to the beacon (keeping your layout) rather than reverting to
  the RUM charts.
- **Beacon stat tiles no longer undercount.** A beacon stat / percentage now reflects the
  full matching set instead of only the top-N rows it charted, so its total is right even
  when there's a long tail of regions, cities, or referrers.
- **"Restore default charts" now respects the page.** It used to rebuild every page with the
  RUM "Overview" charts; a beacon page (or a drill-down off one) now comes back with beacon
  charts instead of empty Cloudflare ones, and each drill-down restores to the data source
  it was using.
- **Geo charts stay consistent with each other.** Referrer/subreddit/device/screen charts
  no longer drop visits with a blank value — they bucket them as "(direct)" / "(none)" — so
  a day of direct visits no longer shows a full map but an empty referrer chart. Every
  visit is now counted in every geo chart.
- **Your dashboard settings now actually persist.** A load-time bug discarded every saved
  configuration and silently reverted the dashboard to defaults on each visit — so filter,
  layout, and page changes never survived a reload. Your saved state is durable again.
- **First page load no longer shows briefly inflated numbers.** RUM charts now wait
  for the real-host allow-list before their first fetch, so dev/preview traffic is
  never counted — not even for the split second before the site list loads.

### Added
- **Pin your own default charts.** Each chart has a "Set as default" option (★) in its ⋯
  menu; "Restore default charts" then keeps the charts you've pinned and drops the rest,
  falling back to the factory set only when nothing is pinned.
- **Beacon charts can break down by a second dimension.** Nested-doughnut and stacked-bar
  charts now work on the beacon dataset (e.g. site × device), matching what RUM already
  offered — the chart editor exposes "Break down by" for beacon charts too.
- **Relative date ranges stay relative.** "Last 7d / 24h / …" now recomputes to a fresh
  window on every load instead of freezing to the moment you set it; exact calendar ranges
  are still kept as-is.
- **Range slider replaces the day chips.** One control opens a vertical slider spanning
  the whole window — hours (1h–23h) at the bottom, days (1d–30d) at the top — so you can
  dial in any span from "last hour" to "last month" without typing.
- **"Sync all pages" toggle.** When on, every page shares the same date range *and* site
  selection — change the filter on one page and they all match. Turn it off for independent
  per-page filters. (Drill-down pages keep their own drill constraints either way.)
- **"Best Sudoku launch" dashboard page** — a beacon page pre-filtered to Best Sudoku
  traffic (web + app) showing where visitors come from (referrers + subreddit), geo,
  device, web-vs-app, and new-vs-returning. Added automatically via a one-time migration.
- **"Referrer path" dimension** (beacon dataset) — chart the referrer's path, e.g. which
  subreddit sent a visit, alongside the referrer host; click-to-drill-down works on it too
  (drill a referrer, then see its subreddit breakdown).

## [0.1.0] — 2026-07-05

First public release — the dashboard as currently deployed at
`stats.goodstuff.software`.

### Added
- **Custom bot-free analytics dashboard.** A movable/resizable grid of charts over
  Cloudflare RUM (human-only) data, with the API token held server-side so it never
  reaches the browser.
- **Durable, multi-page dashboards.** Layout and chart definitions persist in
  Cloudflare KV (not `localStorage`), with multiple pages, per-page filters, and
  per-chart filter overrides.
- **Geo beacon dataset.** True sub-country region / city / ISP and a visitor map,
  sourced from the companion `gss-beacon` (Cloudflare RUM is country-only).
- **Auto-built site filter.** A single multi-select of sites and subdomains, built
  live from the data, that merges each site's RUM and beacon identifiers and folds
  alias hosts (HTTP redirect or `rel="canonical"`) into their canonical site.
- **Click-to-drill-down.** Clicking any chart value opens a new page filtered to it
  (device, referrer, location, and more), titled by the value.
- **Owner-visit exclusion.** Hide your own traffic by browser+OS, plus a per-device
  "exclude this device" opt-out that covers every site (first-party cookie for the
  same domain, server-side IP list for others).
- **Dev / preview traffic excluded** from both the site picker and every number.
- **Smart date range** — type spans like `7d` / `24h` / `2w` or pick exact dates.
- **Cloudflare Access lockdown** (owner-only) with a session-expiry re-sign-in prompt.
- **Light / dark theme** matching the Good Stuff Software brand.
