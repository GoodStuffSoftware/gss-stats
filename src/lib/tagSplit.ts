// Per-tag split of a campaign that carries more than one utm_campaign tag (flight 3 Apps runs two
// responsive display ads, HERO and FEATURES, in one campaign). DISPLAY ONLY: every rule, threshold
// and cap in lib/adsRules.ts reads the arm TOTAL over all of `campaign.ucValues` (matching is
// exact, IN), and nothing in this file feeds one. The split is the same tagged rows cut by their
// own `campaign` column.
//
// COUNTS ONLY (src/lib/splitGuard.ts). A campaign tag is not an hour, a place or a device, so
// splitting by it is allowed; but only rows are counted: per-tag totals, cumulative and for one
// ET day, never an hour of day, no visitor join, no place or device dimension. The tagged
// read's own hour buckets are used only to cut at an ET midnight, as summarizeTaggedRows
// already does for the total.
//
// AD COST. A responsive display ad has no name, so the ad is mapped to its tag by the
// utm_campaign in its own `final_urls` (adTagOf). An ad whose links carry no tag, a tag that is
// not one of the arm's, or two different tags (ambiguous) is "untagged": its cost is shown on its
// own line and never assigned to a tag.

import type { AdDayRow } from './adsApi'
import { summarizeTaggedRows, type TaggedRow } from './adsRules'
import { costPer } from './campaigns'

/** The utm_campaign value of a landing link, or null when the link has none (or an empty one).
 * Read from the raw query string, so a relative or templated link still parses; the value is
 * returned as written (the beacon is case-sensitive and matches exactly). */
export function utmCampaignOf(url: string): string | null {
  const q = url.indexOf('?')
  if (q < 0) return null
  const query = url.slice(q + 1).split('#')[0]
  for (const part of query.split('&')) {
    const eq = part.indexOf('=')
    const key = eq < 0 ? part : part.slice(0, eq)
    if (key !== 'utm_campaign') continue
    let v = eq < 0 ? '' : part.slice(eq + 1)
    try {
      v = decodeURIComponent(v)
    } catch {
      return null
    }
    return v === '' ? null : v
  }
  return null
}

/** The arm tag an ad feeds: the ONE distinct utm_campaign across its final_urls, if it is one of
 * the arm's tags (`ucValues`, exact). null = untagged: no link carries a tag, the tag is not the
 * arm's, or the links disagree (never guess between two tags). */
export function adTagOf(finalUrls: readonly string[], ucValues: readonly string[]): string | null {
  const tags = new Set<string>()
  for (const u of finalUrls) {
    const t = utmCampaignOf(u)
    if (t != null) tags.add(t)
  }
  if (tags.size !== 1) return null
  const [tag] = [...tags]
  return ucValues.includes(tag) ? tag : null
}

/** True for an arm that carries more than one tag: the only arms that print a split. */
export function isMultiTag(ucValues: readonly string[]): boolean {
  return ucValues.length > 1
}

export interface TagCounts {
  /** visitor='new' tagged rows: a floor (lib/campaigns.ts ARRIVALS_CAVEAT), as the arm total's. */
  arrivals: number
  /** Game-complete rows (the funnel's completed step). */
  completes: number
  /** Sign-in ask rows (the same count as the arm total's `asks`). */
  asks: number
  /** /auth/success/<provider>/new rows. */
  newAccounts: number
}
export interface TagSplitTag {
  tag: string
  total: TagCounts
  /** The same for one ET day (the day before the read); null when no day window was given. */
  yesterday: TagCounts | null
  /** Ad-level spend on closed days for the ads whose links carry this tag; null = not read. */
  cost: number | null
  clicks: number | null
  impressions: number | null
  /** cost / arrivals, null under MIN_COHORT (5) arrivals or with no cost read: the small-sample gate. */
  costPerArrival: number | null
}
export interface TagSplit {
  tags: TagSplitTag[]
  /** Ads whose links give no usable tag, with their cost; null when none (or cost not read). */
  untagged: { ads: number; cost: number; clicks: number; impressions: number } | null
  /** Tagged rows that could not be put on a tag (no `campaign` on the row, or a tag outside the arm). 0 in a real read. */
  unsplitHits: number
  costRead: boolean
  costError: string | null
  /** The last closed ET day the cost covers. */
  costThroughEt: string | null
}

const round2 = (x: number) => Math.round(x * 100) / 100

function countsFor(rows: readonly TaggedRow[], win?: { fromMs: number; toMs: number }): TagCounts {
  const s = summarizeTaggedRows(rows, win ? { fromMs: win.fromMs, toMs: win.toMs } : {})
  return { arrivals: s.taggedArrivals, completes: s.funnel.completed, asks: s.asks.total, newAccounts: s.authSuccessSplit.new }
}

export interface BuildTagSplitInput {
  rows: readonly TaggedRow[]
  ucValues: readonly string[]
  /** One ET day's UTC bounds for the "yesterday" counts; omitted = cumulative only. */
  yesterday?: { fromMs: number; toMs: number }
  /** Ad-day rows for the closed days (fetchAdDaily); null = not read. */
  adRows: readonly AdDayRow[] | null
  costError?: string | null
  costThroughEt?: string | null
}

/** The per-tag split of the tagged rows and the ad cost. null for a single-tag arm (it prints as
 * it always has). Every tag of the arm gets a line, in `ucValues` order, even with no rows. */
export function buildTagSplit(i: BuildTagSplitInput): TagSplit | null {
  if (!isMultiTag(i.ucValues)) return null
  const byTag = new Map<string, { cost: number; clicks: number; impressions: number }>()
  for (const t of i.ucValues) byTag.set(t, { cost: 0, clicks: 0, impressions: 0 })
  const untaggedAds = new Set<string>()
  const untagged = { cost: 0, clicks: 0, impressions: 0 }
  if (i.adRows) {
    for (const r of i.adRows) {
      const tag = adTagOf(r.finalUrls, i.ucValues)
      const dest = tag ? byTag.get(tag)! : untagged
      dest.cost += r.costMicros / 1e6
      dest.clicks += r.clicks
      dest.impressions += r.impressions
      if (!tag) untaggedAds.add(r.adId)
    }
  }
  const tags: TagSplitTag[] = i.ucValues.map((tag) => {
    const mine = i.rows.filter((r) => r.campaign === tag)
    const total = countsFor(mine)
    const c = byTag.get(tag)!
    const cost = i.adRows ? round2(c.cost) : null
    return {
      tag,
      total,
      yesterday: i.yesterday ? countsFor(mine, i.yesterday) : null,
      cost,
      clicks: i.adRows ? c.clicks : null,
      impressions: i.adRows ? c.impressions : null,
      costPerArrival: cost == null ? null : costPer(cost, total.arrivals),
    }
  })
  const unsplitHits = i.rows.filter((r) => r.campaign == null || !i.ucValues.includes(r.campaign)).reduce((a, r) => a + r.count, 0)
  return {
    tags,
    untagged: i.adRows && untaggedAds.size > 0 ? { ads: untaggedAds.size, cost: round2(untagged.cost), clicks: untagged.clicks, impressions: untagged.impressions } : null,
    unsplitHits,
    costRead: i.adRows != null,
    costError: i.adRows ? null : (i.costError ?? 'not read'),
    costThroughEt: i.adRows ? (i.costThroughEt ?? null) : null,
  }
}
