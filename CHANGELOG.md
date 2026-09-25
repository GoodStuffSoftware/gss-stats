# Changelog

All notable changes to **gss-stats** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Flight 1's start date was off by one ET day.** It was derived from UTC-bucketed daily
  counts; re-derived from ET-bucketed ones (the campaign's real first hit is 2026-09-02
  ~22:56 ET, already 2026-09-03 in UTC), recovering ~150 tagged hits that fell outside every
  flight window.
- **Tagged hits** — every row carrying a campaign tag, as opposed to tagged *arrivals*
  (first-ever beacon only) — is now shown on the campaign page, labeled separately, next to
  the arrivals floor caveat.

### Added
- **"Best Sudoku overview" page** (first in the page list) answers "how's the release
  going, how's each campaign going, and what's happening right now": today-at-a-glance KPI
  tiles compared against the same time yesterday and the 7-day average, a daily timeline
  since the first Best Sudoku hit overlaid with campaign flights / release / tracking-
  activation markers, a campaign scorecard, and a release before/after panel. Uninstrumented
  metrics show "not yet tracking" instead of a fake 0.
- **"Best Sudoku campaigns" page** compares the three Google Ads campaigns (two closed
  display flights sharing a tag, split by date range, plus a new US+CA web retest) side by
  side: a funnel (arrivals → played → completed → sign-in ask → accept → auth success →
  install prompt → install, with "not instrumented" instead of a fake 0 for steps that
  never happened during a flight), arrivals by ET hour of day, arrivals and the funnel by
  country, daily + cumulative arrivals aligned by flight day so the flights overlay, cost
  per tagged arrival/auth success (once ad spend is filled in), device mix, and — once the
  new on-device return beacon starts reporting (v1.90.0) — a return-visit retention curve.
  Attribution is by the beacon's own campaign tag only, with a single swappable function
  deciding row membership; known verification/household traffic is excluded server-side.
- **Pop-up rates never report from a tiny sample.** Every rate (tap, outcome, eligibility)
  now needs at least 5 in its denominator — below that it shows "too few to report" instead
  of a real-looking but noisy percentage (e.g. 1/2 reading as an alarming 50%).

### Fixed
- **The on-device return beacon (`/return/...`) is now excluded from ordinary pageview/visit
  totals**, matching every other pop-up event path — it had been left off that exclusion list.

### Added
- **Pop-up tracking has a configurable activation date, so pre-release data can't read as
  a baseline.** Every pop-up rate (tap, outcome, eligibility) and count widget — other than
  the shown/day trend, which now marks the activation date with a "tracking starts" line and
  mutes the days before it — is gated to that date; a real pre-release denominator (like the
  22-event uncapped-placement-bug reproduction on 2026-09-19) can only ever show "—", never a
  misleading 0%. While the date is unset the "Best Sudoku pop-ups" page carries a note:
  "Tracking not yet active — numbers before release are not a baseline."
- **Best Sudoku pop-up tracking page.** A new "Best Sudoku pop-ups" dashboard page (next to
  the launch page) shows shown / accepted / dismissed counts, tap rates, outcome rates, the
  sign-in eligibility rate, and install's real-outcome counts for every pop-up (sign-in
  prompt, first-50 promo, upsell, install). Day trends bucket by US-Eastern calendar day
  (DST-safe), and a rate shows "—" instead of 0%/NaN until it has real data. Pop-up event
  beacons (`/signin-prompt`, `/signin-eligible`, `/promo-first50`, `/first50-congrats`,
  `/upsell`, `/install`, `/popup-outcome`) no longer count toward ordinary pageview/visit
  totals or the top-pages breakdown.
- **Best Sudoku launch page shows campaign source / medium.** A new "Campaign source /
  medium" chart on the Best Sudoku page groups by `utm_source` (e.g. `google`), alongside
  the existing campaign chart (now labeled "Campaign (utm_campaign)") — both now cover the
  Google Ads campaign traffic as well as tagged Reddit links.
- **Nested doughnuts can have any number of rings.** Add, remove, and reorder ring
  dimensions in the chart editor (e.g. site → device → OS → browser) — each becomes another
  ring outward. Beacon charts nest as deep as the data allows; Cloudflare-RUM charts cap at a
  few rings. Clicking any ring still drills to that ring's value.
- **Drill-down on more charts.** "Open as filtered page" now works from the **site × device**
  breakdown chart (drills to the clicked site or device) and from the **pageviews-over-time**
  chart (opens a page zoomed to that single day).

### Changed
- **Touch gestures on charts: tap to read, hold to drill.** On a touchscreen a short tap now
  just shows the datapoint's tooltip, and a half-second press-and-hold opens the "open as
  filtered page" menu (with a small haptic tick). Mouse behaviour is unchanged — a click still
  drills straight away.

### Fixed
- **You can scroll the dashboard by dragging anywhere on a chart again.** Cards that were
  draggable disabled touch-scrolling across the *whole* card on Android, so scrolling only
  worked from the page margin. Drag-to-rearrange is now switched off on touchscreens (it was
  only ever off on narrow ones, so large phones and tablets were affected); mouse users keep it.
- **Tapping a chart no longer flashes a blue highlight box** over it, and holding no longer pops
  the browser's own context menu on top of the drill menu.
- **On phones, the drill-down menu is now a bottom sheet and never covers the chart.** It was
  anchored at your fingertip, sitting right on top of the data (and its tooltip) you'd just
  tapped. On narrow screens it now slides up from the bottom with a dimming backdrop; on
  desktop it opens beside the point you clicked and stays fully on-screen near an edge.
- **Tapping a chart no longer leaves a tooltip stuck under the drill menu.** On touch, a
  browser's synthetic mouse event could re-show the tooltip in the instant between the tap and
  the menu opening; the tooltip is now switched off in the same moment the tap is handled.
- **Trend charts now show every day in the range.** Days with no traffic are plotted as zero
  instead of being left out, so a 4-day range no longer collapses into a 2-point line that
  looks like a 2-day range — gaps are visible as gaps.
- **"Hide my visits" and "Hide self-referrals" now apply to beacon charts too.** They were
  silently ignored on every beacon chart, so beacon and Cloudflare-RUM charts disagreed on the
  same traffic. Beacon numbers will read lower now — your own visits are finally excluded there
  as well.
- **The drill-down menu no longer overlaps the chart's hover tooltip — and hover stays
  smooth.** Only the chart you drilled hides its tooltip while its menu is open (other charts
  are untouched), and the hover state is cleared on every toggle, so a tooltip can never get
  stuck showing a stale value.
- **A stray drill can no longer silently blank the Overview, Beacon, or Best Sudoku launch
  pages.** Those canonical pages now drop any persistent page-level drill-down on load — so
  a filter written into the config by another tool can't quietly narrow a whole page to a
  value it has no data for (which was making the launch page show nothing).

### Added
- **Campaign / subreddit attribution.** New beacon dimensions — **Campaign** (utm), Source,
  and Medium — so links tagged per source (e.g. one `utm_campaign` per subreddit) are
  attributed even when the referrer is stripped. The Best Sudoku launch page gains a "By
  subreddit (tagged link)" chart; you can also group/drill any beacon chart by these.
  (Requires the companion gss-beacon campaign-tags update + its one-time DB migration.)
- **Zoom any chart.** An expand button grows the chart itself — same element, same aspect
  ratio — from its spot to a centered panel filling most of the screen, animated both ways.
  Close with the button (now a zoom-out), by clicking outside, or Esc.

### Fixed
- **"Sync all pages" no longer wipes a page's site filter.** It now shares only the date
  range across pages; each page keeps its own site selection. Previously it also synced the
  site filter, so changing a filter anywhere could overwrite a purpose-built page's sites
  (e.g. Best Sudoku's beacon filter) and leave it stuck showing no data at any date.
- **The drill-down menu stays with its chart.** "Open as filtered page" is now anchored to
  the page, so scrolling no longer leaves it stranded over a different chart.
- **Range slider is usable on touch.** The date-range slider now has − / + stepper buttons
  to nudge one step at a time, plus a taller slider and a larger thumb, so you can land on
  the exact span instead of fighting the tiny drag steps on a phone.
- **Consistent chart colors.** A value now keeps the same color across every chart and page
  — "desktop"/"mobile" and "new"/"returning" no longer swap colors based on sort order.
  Region and country charts switch to a single brand-hue gradient (most opaque = highest,
  fading down the list) instead of a rainbow.
- **Tooltips work on touch.** Tapping a data point on mobile now shows its tooltip: line
  charts get a much larger tap target, and a tap that doesn't drill keeps its tooltip up
  instead of clearing it.
- **RUM charts fail gracefully when the analytics API stalls.** The RUM endpoint now bounds
  the Cloudflare GraphQL call with a timeout and reports a clean, retryable error instead of
  hanging until the platform returns a raw 502 page.

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
