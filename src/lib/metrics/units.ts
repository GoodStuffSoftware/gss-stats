// What one counted thing IS (ADR 0003 section 2). Ratio validity is decided on units: a
// percentage needs the same unit on both sides AND a declared subset (lib/metrics/ratios.ts).
//
// Unit display words ("views", "arrivals", "showings") are notes-registry labels
// (lib/notes.ts, NoteKind 'label'), never literals here, so every visible string stays in one
// registry. A metric can name a more specific word (campaign.taggedArrivals counts devices,
// shown as "arrivals") through MetricDef.unitLabel.

// 'instant' (an epoch-ms time: when spend was last synced) and 'code' (a category shown as its
// label: where a spend figure came from) are never counts: no ratio can use them.
export const UNITS = ['device', 'row', 'pageview', 'completion', 'showing', 'signin', 'finish', 'usd', 'day', 'instant', 'code'] as const
export type Unit = (typeof UNITS)[number]

/** The notes-registry label id for a unit's display word. */
export function unitLabelId(unit: Unit): string {
  return `unit.${unit}`
}

/** The unit one row of each beacon path family counts (lib/popupEvents.ts pathFamilyOf /
 * PATH_FAMILY_OPTIONS — the same family list the event-beacon exclusion is built from). Keyed
 * by family so the event-family list and the unit taxonomy cannot drift: metrics.test.ts ("units key off the beacon path families") fails
 * when a family is added there without a unit here. A metric may still count a family's rows
 * as plain `row`s when a row is not one of the family's things (raw install signals can
 * double-count one install); metrics.test.ts lists every such exception with its reason. */
export const PATH_FAMILY_UNIT: Readonly<Record<string, Unit>> = {
  page: 'pageview',
  'signin-prompt': 'showing',
  'signin-eligible': 'finish',
  'promo-first50': 'showing',
  'first50-congrats': 'showing',
  upsell: 'showing',
  install: 'showing',
  'popup-outcome': 'showing', // an outcome is recorded at most once per showing
  return: 'device', // deduplicated on the device, once per bucket
  'game-complete': 'completion',
  'game-complete-deferred': 'completion',
  'auth-status': 'signin',
  'auth-error': 'row', // one row per failed sign-in attempt
  'auth-redirect': 'row', // one row per popup-to-redirect fallback
  tour: 'row', // one row per tour start / complete / skip / exit
  'tutorial-complete': 'row', // one row per tutorial win, first run or replay: not a real game completion
  'game-first-move': 'row', // one row per game's first placed digit
  'game-abandon': 'row', // one row per abandoned game
  'welcome-signed-in': 'showing', // the card's shown row and the taps on that showing
  'game-start': 'row', // one row per counted game start (menu, play-again and tour-exit starts alike)
}
