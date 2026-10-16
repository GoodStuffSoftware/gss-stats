// The Flight 3 Apps arm's landing tags, for the "No ads (hero) vs Features" donut (the Campaigns
// page card 'cw-f3-hero-donut'; geo dimension 'landingTag', lib/campaigns.ts landingTagSqlCase).
//
// A LEAF module (no imports): functions/api/geo.ts, lib/campaigns.ts and lib/charts.ts all read it.
// The Apps arm runs two display ads, each landing with its own utm_campaign. Both tags are listed in
// STAGED_FLIGHT_3.apps.ucValues (lib/campaigns.ts), together with the bare Apps tag (a catch-all for a
// link left without a variant), which is what lets the arm's rules read the sum; a test pins that every
// tag here is in that list. The values are lowercase and underscore-only on purpose: best-sudoku only
// sends a /return/<tag>/d0 arrival row for a tag that fits /^[a-z][a-z0-9_]{0,39}$/ (campaignReturns.ts).

export const F3_APPS_HERO_TAG = 'sudoku_funnel_f3_apps_hero'
export const F3_APPS_FEATURES_TAG = 'sudoku_funnel_f3_apps_feat'
export const F3_APPS_BARE_TAG = 'sudoku_funnel_f3_apps'

export interface LandingTag {
  tag: string
  /** The slice and legend label. */
  label: string
}
/** The donut's slices, in legend order. The bare tag reads "Untagged": an Apps arrival whose link
 * carried no ad variant. */
export const LANDING_TAGS: readonly LandingTag[] = [
  { tag: F3_APPS_HERO_TAG, label: 'No ads (hero)' },
  { tag: F3_APPS_FEATURES_TAG, label: 'Features' },
  { tag: F3_APPS_BARE_TAG, label: 'Untagged' },
]

/** The beacon sites a /return/ arrival row can come from for this arm: the web build and the installed
 * app (the app forwards the landing tags through the Play install referrer). Equal to
 * lib/metrics/facts.ts BSK_WEB_SITE and BSK_APP_SITE (a test pins it; this module cannot import them). */
export const LANDING_SITES: readonly string[] = ['bestsudoku-web', 'bestsudoku-app']

/** The arrival row the donut counts: one per device on its first tagged visit, whose path embeds the tag. */
export const landingArrivalPath = (tag: string): string => `/return/${tag}/d0`

export function landingTagLabel(value: string): string {
  return LANDING_TAGS.find((t) => t.tag === value)?.label ?? value
}

/** Shown in place of the donut while no registered campaign carries these tags (the arm is staged,
 * not activated), and the reason the card sends no query at all in that state. */
export const LANDING_NOT_LIVE_TEXT = "Flight 3 isn't live yet"
/** The one-line note under the donut. */
export const LANDING_TAG_NOTE = 'The two ads rotate evenly, so the slice share reflects how well each ad converts to arrivals.'
