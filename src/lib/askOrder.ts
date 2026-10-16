// The "Ask-order A/B" card (Features page): which order of the two asks (sign in first, or install
// first) gets more people to respond, read as plain counts per group, organic vs tagged.
//
// WHERE THE ROWS COME FROM. Best Sudoku v1.99.2 assigns each device to a group once, ever, and sends
// twin rows under `/ab/ask-order/<group>/...` (src/lib/popupEvents.ts isAbTwinPath):
//   /ab/ask-order/<group>/assigned                  once per device, when it is assigned
//   /ab/ask-order/<group>/shown/<ask>               an ask was shown
//   /ab/ask-order/<group>/<ask>/<outcome>           what happened after that ask
// <group> is signin-first | install-first, <ask> is signin | install, <outcome> is signed-in | installed
// | returned | still-playing. These paths are the planned shapes (the game version that sends them has
// not shipped); the vocabulary below is the one place to change if the shipped names differ.
//
// TWINS, NEVER TOTALS. Every outcome row is a twin of a real /popup-outcome row. No other card, total
// or report reads these paths (isAbTwinPath, classifyPopupPath, summarizeTagged and the Feature health
// config all leave them out); this card is the one reader, and it never adds them into anything else.
//
// COUNTS ONLY (src/lib/splitGuard.ts). The card reads per-ET-day totals of rows, and one all-time total
// per step, split only by the row's campaign tag (organic or tagged) and by PATH (group, ask, outcome),
// never by hour, place, device or visitor. The whole `/ab/ask-order/%` family is also refused for any
// hour, place or device split (SPLIT_REFUSED_PATH_PATTERNS). Every ratio is a plain ratio of two row
// counts, labelled "per assigned" or "per shown": not a per-person rate. Purchases cannot be split by
// group (an install moves the player into the app, where the web group does not follow, and no row is
// joined to a visitor), so the card does not show them.
//
// It reuses the feature-health machinery (featureHealth.ts / featureHealthSql.ts / /api/features): a
// FeatureDef per group, a step per path per tag.

import type { FeatureDef, FeatureHealth, StepTag } from './featureHealth'

/** The widget view that draws the card (dataset 'features'). */
export const ASK_ORDER_VIEW = 'ask-order'

export const ASK_ORDER_GROUPS = [
  { id: 'signin-first', label: 'Sign-in first' },
  { id: 'install-first', label: 'Install first' },
] as const
export type AskOrderGroupId = (typeof ASK_ORDER_GROUPS)[number]['id']

export const ASK_ORDER_ASKS = [
  { id: 'signin', label: 'Sign-in ask' },
  { id: 'install', label: 'Install ask' },
] as const
export type AskId = (typeof ASK_ORDER_ASKS)[number]['id']

export const ASK_ORDER_OUTCOMES = [
  { id: 'signed-in', label: 'Signed in' },
  { id: 'installed', label: 'Installed' },
  { id: 'returned', label: 'Returned' },
  { id: 'still-playing', label: 'Still playing' },
] as const
export type OutcomeId = (typeof ASK_ORDER_OUTCOMES)[number]['id']

/** Organic first: a row with no campaign tag. Tagged: a row with one (the row's uc). */
export const ASK_ORDER_TAGS: readonly { id: StepTag; label: string }[] = [
  { id: 'organic', label: 'Organic' },
  { id: 'tagged', label: 'Tagged' },
]

/** An outcome that counts as a response to the asks (the PRIMARY measure): the player signed in or installed. */
export const ASK_ORDER_RESPONSE_OUTCOMES: readonly OutcomeId[] = ['signed-in', 'installed']

/** Asks shown per group at which the call is made (pre-registered 2026-10-16), or at 8 weeks after v1.99.2 ships. */
export const ASK_ORDER_CALL_ASKS = 150
/** The rule: one order responding at this multiple of the other's or more, everyone switches to it. */
export const ASK_ORDER_SWITCH_MULTIPLE = 1.5
/** The order kept when the rule does not switch. */
export const ASK_ORDER_DEFAULT_GROUP: AskOrderGroupId = 'signin-first'

export const ASK_ORDER_ROOT = '/ab/ask-order'
export const askOrderAssignedPath = (g: AskOrderGroupId) => `${ASK_ORDER_ROOT}/${g}/assigned`
export const askOrderShownPath = (g: AskOrderGroupId, ask: AskId) => `${ASK_ORDER_ROOT}/${g}/shown/${ask}`
export const askOrderOutcomePath = (g: AskOrderGroupId, ask: AskId, outcome: OutcomeId) => `${ASK_ORDER_ROOT}/${g}/${ask}/${outcome}`

/** Feature id of a group (`ao-signin-first`); step ids are `<measure>-<tag>`. */
export const askOrderFeatureId = (g: AskOrderGroupId) => `ao-${g}`
export const assignedStepId = (tag: StepTag) => `assigned-${tag}`
export const shownStepId = (ask: AskId, tag: StepTag) => `shown-${ask}-${tag}`
export const outcomeStepId = (ask: AskId, outcome: OutcomeId, tag: StepTag) => `${ask}-${outcome}-${tag}`

/** One FeatureDef per group; per tag: assigned, shown per ask, and every outcome per ask (22 steps a group).
 * Ratios: shown per assigned, outcome per that ask's shown. */
export const ASK_ORDER_FEATURES: readonly FeatureDef[] = ASK_ORDER_GROUPS.map(
  (g): FeatureDef => ({
    id: askOrderFeatureId(g.id),
    label: g.label,
    blurb: `Devices assigned the ${g.label.toLowerCase()} order, the asks shown to them and what followed.`,
    steps: ASK_ORDER_TAGS.flatMap((t) => [
      { id: assignedStepId(t.id), label: `Assigned (${t.label.toLowerCase()})`, match: { exact: [askOrderAssignedPath(g.id)], tag: t.id } },
      ...ASK_ORDER_ASKS.map((a) => ({
        id: shownStepId(a.id, t.id),
        label: `${a.label} shown (${t.label.toLowerCase()})`,
        match: { exact: [askOrderShownPath(g.id, a.id)], tag: t.id },
        ratioOf: { per: assignedStepId(t.id) },
      })),
      ...ASK_ORDER_ASKS.flatMap((a) =>
        ASK_ORDER_OUTCOMES.map((o) => ({
          id: outcomeStepId(a.id, o.id, t.id),
          label: `${a.label}: ${o.label.toLowerCase()} (${t.label.toLowerCase()})`,
          match: { exact: [askOrderOutcomePath(g.id, a.id, o.id)], tag: t.id },
          ratioOf: { per: shownStepId(a.id, t.id) },
        })),
      ),
    ]),
  }),
)

export const ASK_ORDER_CAPTION =
  'Counts are rows per ET day, web and app combined, organic (no campaign tag) vs tagged. Every figure is a plain ratio of two row counts, not a per-person rate: ' +
  '"per assigned" divides a count by the devices assigned to that group, and a device that answers both asks counts for both. ' +
  'The progress, responses and rule read below use every day so far, whatever range is selected. ' +
  `The call is made at about ${ASK_ORDER_CALL_ASKS} asks shown per group, or 8 weeks after v1.99.2 ships (first look at flight 3 day 7): ` +
  `one order responding at ${ASK_ORDER_SWITCH_MULTIPLE}x or more of the other's switches everyone to it, otherwise sign-in first stays. ` +
  "Purchases can't be split by group, so they are not shown. Twin rows: never added into any other total."
export const ASK_ORDER_EMPTY_NOTE = "No ask-order A/B data yet — the game version that sends it (v1.99.2) hasn't shipped"

// ── The pre-registered read, from the all-time counts ────────────────────────────────────────────────

/** All-time counts, keyed `<featureId>.<stepId>` (what /api/features answers as `allTime`). */
export type AskOrderAllTime = Readonly<Record<string, number>>

export interface AskOrderGroupRead {
  group: AskOrderGroupId
  label: string
  assigned: number
  /** Asks shown, both asks, organic + tagged. */
  asksShown: number
  /** asksShown / ASK_ORDER_CALL_ASKS, capped at 1: the progress bar. */
  progress: number
  reachedCall: boolean
  /** Signed-in + installed outcome rows, either ask, organic + tagged. */
  responses: number
  /** responses / assigned (a ratio of two row counts), or null with nobody assigned. */
  responsesPerAssigned: number | null
  /** Each outcome's rows (either ask) per assigned, separately: the secondary read. */
  perOutcome: Record<OutcomeId, { count: number; perAssigned: number | null }>
}
export type AskOrderVerdict =
  | { state: 'preliminary'; note: string }
  | { state: 'call'; switchTo: AskOrderGroupId | null; multiple: number | null; note: string }
export interface AskOrderRead {
  groups: AskOrderGroupRead[]
  /** Larger responses-per-assigned over the smaller, or null when either group has nobody assigned or both read zero. */
  multiple: number | null
  larger: AskOrderGroupId | null
  verdict: AskOrderVerdict
}

const at = (allTime: AskOrderAllTime, g: AskOrderGroupId, stepId: string) => Number(allTime[`${askOrderFeatureId(g)}.${stepId}`]) || 0
const sumTags = (allTime: AskOrderAllTime, g: AskOrderGroupId, stepIdOf: (t: StepTag) => string) =>
  ASK_ORDER_TAGS.reduce((a, t) => a + at(allTime, g, stepIdOf(t.id)), 0)
const per = (num: number, den: number): number | null => (den > 0 ? num / den : null)
const groupLabel = (g: AskOrderGroupId) => ASK_ORDER_GROUPS.find((x) => x.id === g)!.label

/** The pre-registered read of the A/B from all-time counts. The rule is applied ONLY once both groups have
 * reached the call point; before that the multiple is shown as preliminary. */
export function readAskOrder(allTime: AskOrderAllTime): AskOrderRead {
  const groups: AskOrderGroupRead[] = ASK_ORDER_GROUPS.map((g) => {
    const assigned = sumTags(allTime, g.id, assignedStepId)
    const asksShown = ASK_ORDER_ASKS.reduce((a, k) => a + sumTags(allTime, g.id, (t) => shownStepId(k.id, t)), 0)
    const outcomeCount = (o: OutcomeId) => ASK_ORDER_ASKS.reduce((a, k) => a + sumTags(allTime, g.id, (t) => outcomeStepId(k.id, o, t)), 0)
    const perOutcome = Object.fromEntries(
      ASK_ORDER_OUTCOMES.map((o) => {
        const count = outcomeCount(o.id)
        return [o.id, { count, perAssigned: per(count, assigned) }]
      }),
    ) as AskOrderGroupRead['perOutcome']
    const responses = ASK_ORDER_RESPONSE_OUTCOMES.reduce((a, o) => a + perOutcome[o].count, 0)
    return {
      group: g.id,
      label: g.label,
      assigned,
      asksShown,
      progress: Math.min(1, asksShown / ASK_ORDER_CALL_ASKS),
      reachedCall: asksShown >= ASK_ORDER_CALL_ASKS,
      responses,
      responsesPerAssigned: per(responses, assigned),
      perOutcome,
    }
  })
  const [a, b] = groups
  const ra = a.responsesPerAssigned
  const rb = b.responsesPerAssigned
  let larger: AskOrderGroupId | null = null
  let multiple: number | null = null
  if (ra !== null && rb !== null) {
    if (ra !== rb) {
      const [hi, lo] = ra > rb ? [a, b] : [b, a]
      larger = hi.group
      multiple = lo.responsesPerAssigned! > 0 ? hi.responsesPerAssigned! / lo.responsesPerAssigned! : null
    }
  }
  const bothReached = a.reachedCall && b.reachedCall
  let verdict: AskOrderVerdict
  if (!bothReached) {
    const short = groups.filter((g) => !g.reachedCall).map((g) => `${g.label} ${g.asksShown} of ${ASK_ORDER_CALL_ASKS}`)
    verdict = { state: 'preliminary', note: `Preliminary, not at the call point yet (${short.join(', ')} asks shown).` }
  } else {
    // At the call point. A larger group with a zero smaller rate is an unbounded multiple: the rule switches.
    const switches = larger !== null && (multiple === null || multiple >= ASK_ORDER_SWITCH_MULTIPLE)
    const switchTo = switches ? larger : null
    verdict = {
      state: 'call',
      switchTo,
      multiple,
      note: switches
        ? `Call point reached: ${groupLabel(larger!)} responds at ${multiple === null ? 'more than the other order, which has none' : `${multiple.toFixed(2)}x the other`}, ${ASK_ORDER_SWITCH_MULTIPLE}x or more: switch everyone to ${groupLabel(larger!).toLowerCase()}.`
        : `Call point reached: ${multiple === null ? 'no difference' : `${multiple.toFixed(2)}x`}, below ${ASK_ORDER_SWITCH_MULTIPLE}x: keep ${groupLabel(ASK_ORDER_DEFAULT_GROUP).toLowerCase()}.`,
    }
  }
  return { groups, multiple, larger, verdict }
}

// ── Reading the range model (the table) ──────────────────────────────────────────────────────────

/** One count of a step (latest ET day or range) from a group's FeatureHealth, 0 when absent. */
export function stepCount(f: FeatureHealth | undefined, stepId: string, which: 'latest' | 'range'): number {
  return f?.steps.find((s) => s.id === stepId)?.[which] ?? 0
}

/** Signed-in + installed outcome rows of one group and tag, either ask, for latest/range. */
export function responsesOf(f: FeatureHealth | undefined, tag: StepTag, which: 'latest' | 'range'): number {
  return ASK_ORDER_ASKS.reduce(
    (a, k) => a + ASK_ORDER_RESPONSE_OUTCOMES.reduce((b, o) => b + stepCount(f, outcomeStepId(k.id, o, tag), which), 0),
    0,
  )
}
