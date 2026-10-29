// The "Coach tips" card (Features page): for each tip of the game's coach strip, how often it was
// shown, dismissed (the × button) and closed while showing (the page hidden while the tip was up),
// plus the ratios of those counts, and a separate total for "Show me around" taps.
//
// It reuses the feature-health machinery (featureHealth.ts / featureHealthSql.ts / /api/features):
// each tip is a FeatureDef of three exact paths, the "Show me around" total is a fourth kind of
// feature, and assembleHealth makes the counts and ratios.
//
// COUNTS ONLY (src/lib/splitGuard.ts). Splitting by WHICH TIP is a split by PATH, the same kind of
// per-path count every other card makes; it is not an hour, place or device split. The query groups
// by ET day only, with whole-ET-day windows (the refused-window rule), exactly as /api/features does,
// so /coach/shown/%, /coach/dismissed/% and /coach/closed-at/% stay refused for any hour, place or
// device cut and are only read as per-ET-day totals. Rows are never joined to a visitor.

import type { FeatureDef } from './featureHealth'

/** The widget view that draws the card (dataset 'features'). */
export const COACH_TIPS_VIEW = 'coach-tips'

/** The tips, in table order. Matches the game's beacons: /coach/shown/<tip>, /coach/dismissed/<tip>,
 * /coach/closed-at/<tip> (src/lib/popupEvents.ts). */
export const COACH_TIPS = [
  { id: 'place', label: 'Place' },
  { id: 'wheel', label: 'Wheel' },
  { id: 'notes', label: 'Notes' },
  { id: 'hint', label: 'Hint' },
  { id: 'clash', label: 'Clash' },
] as const

export const COACH_TOUR_PATH = '/coach/tour-opened'

/** One FeatureDef per tip (shown, dismissed, closed while showing), then the "Show me around" total.
 * Ids are `tip-<id>` and `tour-opened`; step ids shown / dismissed / closed / opened. */
export const COACH_TIP_FEATURES: readonly FeatureDef[] = [
  ...COACH_TIPS.map(
    (t): FeatureDef => ({
      id: `tip-${t.id}`,
      label: t.label,
      blurb: `The ${t.label.toLowerCase()} tip of the coach strip.`,
      steps: [
        { id: 'shown', label: 'Shown', match: { exact: [`/coach/shown/${t.id}`] } },
        { id: 'dismissed', label: 'Dismissed', match: { exact: [`/coach/dismissed/${t.id}`] }, ratioOf: { per: 'shown' } },
        { id: 'closed', label: 'Closed while showing', match: { exact: [`/coach/closed-at/${t.id}`] }, ratioOf: { per: 'shown' } },
      ],
    }),
  ),
  {
    id: 'tour-opened',
    label: 'Show me around',
    blurb: 'Taps on "Show me around" in the coach strip. Carries no tip.',
    steps: [{ id: 'opened', label: 'Opened', match: { exact: [COACH_TOUR_PATH] } }],
  },
]

/** The Coach tips feature ids (`tip-<id>` and `tour-opened`): a feature.* metric request naming one reads the coach-tips set
 * of the featureDays fact (lib/metrics/facts.ts). None of them is a FEATURES id. */
export const COACH_TIP_FEATURE_IDS: ReadonlySet<string> = new Set(COACH_TIP_FEATURES.map((f) => f.id))
/** The tips alone (the card editor's `tips` repeat): every Coach tips feature but the "Show me around" total. */
export const COACH_TIP_ROWS: readonly FeatureDef[] = COACH_TIP_FEATURES.filter((f) => f.id !== 'tour-opened')

export const COACH_TIPS_CAPTION =
  'Counts are rows per ET day, web and app combined. "Per shown" figures are plain ratios of two counts, not per-person rates: a tip is shown once per device, so a ratio can exceed 1. Latest day is the latest complete ET day. Reading rule per tip: shown, then dismissed, closed-at, or nothing. From v1.99.3, × closes one tip (it no longer retires the schedule) and a shown/notes row with no dismissed or closed-at after it can also mean a note was written. Tip-to-tip comparisons, any "dismissed = stopped" reading and the dismissed or closed per shown of any one tip (after v1.99.3 more people reach the later tips) are not comparable across v1.99.3; a range that straddles it mixes both meanings.'
export const COACH_TIPS_EMPTY_NOTE = "No coach data yet — the game version that sends it hasn't shipped"
