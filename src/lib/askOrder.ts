// The "Ask-order A/B" card (Features page): which order of the two asks (sign in first, or install
// first) gets more people to respond, read as plain counts per group, organic vs tagged.
//
// WHERE THE ROWS COME FROM. Best Sudoku v1.99.2 assigns each device to a group once, ever, and sends
// twin rows under `/ab/ask-order/<group>/...` (src/lib/popupEvents.ts isAbTwinPath):
//   /ab/ask-order/<group>/assigned                  once per device, when it is assigned
//   /ab/ask-order/<group>/shown/<ask>               an ask was shown
//   /ab/ask-order/<group>/<ask>/<outcome>           what happened after that ask
//   /ab/ask-order/<group>/responded/<ask>           once per device, on its first response (<ask> is signin | install)
// <group> is signin-first | install-first, <ask> is signin | install, <outcome> is signed-in | installed
// | returned | still-playing. These paths are the planned shapes (the game version that sends them has
// not shipped); the vocabulary below is the one place to change if the shipped names differ.
//
// TWINS, NEVER TOTALS. Every outcome row is a twin of a real /popup-outcome row. No other card, total
// or report reads these paths (isAbTwinPath, classifyPopupPath, summarizeTagged and the Feature health
// config all leave them out); this card is the one reader, and it never adds them into anything else.
//
// RETURNS come only from the group-carrying twin rows .../returned and .../still-playing, never from the
// ordinary /return/* rows (that would be a join). Organic vs tagged are per-event counts.
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

/** Which measure the 1.5x rule reads. 'auto' (the default) uses the once-per-device responded rows as soon as any exist in the
 * all-time counts, and the combined response rows until then; 'combined' or 'responded' force one. */
export type AskOrderPrimaryMode = 'auto' | 'combined' | 'responded'
export const ASK_ORDER_PRIMARY_MODE: AskOrderPrimaryMode = 'auto'
export type AskOrderPrimaryId = 'combined' | 'responded'

export const ASK_ORDER_ROOT = '/ab/ask-order'
export const askOrderAssignedPath = (g: AskOrderGroupId) => `${ASK_ORDER_ROOT}/${g}/assigned`
export const askOrderShownPath = (g: AskOrderGroupId, ask: AskId) => `${ASK_ORDER_ROOT}/${g}/shown/${ask}`
export const askOrderOutcomePath = (g: AskOrderGroupId, ask: AskId, outcome: OutcomeId) => `${ASK_ORDER_ROOT}/${g}/${ask}/${outcome}`
export const askOrderRespondedPath = (g: AskOrderGroupId, ask: AskId) => `${ASK_ORDER_ROOT}/${g}/responded/${ask}`

/** Feature id of a group (`ao-signin-first`); step ids are `<measure>-<tag>`. */
export const askOrderFeatureId = (g: AskOrderGroupId) => `ao-${g}`
export const assignedStepId = (tag: StepTag) => `assigned-${tag}`
export const shownStepId = (ask: AskId, tag: StepTag) => `shown-${ask}-${tag}`
export const outcomeStepId = (ask: AskId, outcome: OutcomeId, tag: StepTag) => `${ask}-${outcome}-${tag}`
export const respondedStepId = (ask: AskId, tag: StepTag) => `responded-${ask}-${tag}`

/** One FeatureDef per group; per tag: assigned, shown per ask, responded per ask (once per device), and every outcome per ask (26 steps a group).
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
      ...ASK_ORDER_ASKS.map((a) => ({
        id: respondedStepId(a.id, t.id),
        label: `Responded by ${a.label.toLowerCase()} (${t.label.toLowerCase()})`,
        match: { exact: [askOrderRespondedPath(g.id, a.id)], tag: t.id },
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
  'Counts are rows per ET day, web and app combined, organic (no campaign tag) vs tagged. Every figure is a plain ratio of two row counts (a row ratio), not a per-person rate: ' +
  '"per assigned row" divides a count of rows by the assigned rows of that group. ' +
  'The primary figure is the responded rows per assigned row once the once-per-device responded row has been seen, and until then the combined response rows per assigned row (a device that both signs in and installs counts twice). ' +
  'The signed-in and installed figures are shown separately, for display only. ' +
  'Returns come only from the group-carrying returned and still-playing rows, never from the ordinary return rows, so no row is joined to a device. ' +
  'Organic and tagged are per-event counts, so a ratio inside the tagged column is approximate (a device can carry a different tag on different rows); ' +
  'the progress and the rule use every row, organic plus tagged. ' +
  'The progress and the rule read use every day so far, whatever range is selected. ' +
  `The call is made at about ${ASK_ORDER_CALL_ASKS} asks shown per group, or 8 weeks after v1.99.2 ships (first look at flight 3 day 7): ` +
  `on the primary figure, one order at ${ASK_ORDER_SWITCH_MULTIPLE}x or more of the other's switches everyone to it, otherwise sign-in first stays; if sign-ins and installs point opposite ways between the groups, sign-ins decide. ` +
  "Purchases can't be split by group, so they are not shown. Twin rows: never added into any other total."
export const ASK_ORDER_EMPTY_NOTE = "No ask-order A/B data yet — the game version that sends it (v1.99.2) hasn't shipped"

// ── The pre-registered read, from the all-time counts ────────────────────────────────────────────────

/** All-time counts, keyed `<featureId>.<stepId>` (what /api/features answers as `allTime`). */
export type AskOrderAllTime = Readonly<Record<string, number>>

/** The two kinds of response the rule is applied to, each on its own. */
export type ResponseKind = 'signed-in' | 'installed'

export interface AskOrderGroupRead {
  group: AskOrderGroupId
  label: string
  /** Assigned rows, organic + tagged. */
  assigned: number
  /** Asks shown, both asks, organic + tagged. */
  asksShown: number
  /** asksShown / ASK_ORDER_CALL_ASKS, capped at 1: the progress bar. */
  progress: number
  reachedCall: boolean
  /** Each outcome's rows (either ask, organic + tagged) and that count per assigned row (a row ratio, or null with no assigned rows). */
  perOutcome: Record<OutcomeId, { count: number; perAssigned: number | null }>
  /** Signed-in rows + installed rows. A device that does both counts twice: shown only with that label. */
  responseRows: number
  responseRowsPerAssigned: number | null
  /** Once-per-device responded rows (either ask, organic + tagged) and that count per assigned row. */
  respondedRows: number
  respondedPerAssigned: number | null
  /** The active primary's count for this group and its row ratio (combined response rows, or responded rows). */
  primaryRows: number
  primaryPerAssigned: number | null
  /** The active primary's split by kind (signed-in / installed, or responded by sign-in / by install): display and tie-break. */
  byKind: Record<ResponseKind, { count: number; perAssigned: number | null }>
}
export type AskOrderVerdict =
  | { state: 'preliminary'; note: string }
  | { state: 'call'; switchTo: AskOrderGroupId | null; multiple: number | null; note: string }
/** One kind of response, for display and the tie-break only: the rule is applied to the primary. */
export interface AskOrderKindRead {
  kind: ResponseKind
  label: string
  /** The group with the larger rows-per-assigned-row for this kind, or null on a tie or with nobody assigned. */
  larger: AskOrderGroupId | null
  /** Larger over smaller, or null when either group has no assigned rows or the smaller reads zero. */
  multiple: number | null
}
/** Which measure the rule reads, and why. */
export interface AskOrderPrimary {
  id: AskOrderPrimaryId
  label: string
}
/** The 1.5x rule on the active primary, or on sign-ins when the two kinds point opposite ways. */
export interface AskOrderRuleRead {
  basis: 'primary' | 'sign-ins'
  /** True when signed-in and installed point opposite ways between the groups, so sign-ins decide. */
  tieBreak: boolean
  larger: AskOrderGroupId | null
  multiple: number | null
  verdict: AskOrderVerdict
}
export interface AskOrderRead {
  groups: AskOrderGroupRead[]
  /** True once BOTH groups have reached ASK_ORDER_CALL_ASKS asks shown. */
  bothReachedCall: boolean
  /** Which primary is in use and why. */
  primary: AskOrderPrimary
  /** One per response kind, signed-in then installed: display only. */
  kinds: AskOrderKindRead[]
  /** The pre-registered rule on the active primary. */
  rule: AskOrderRuleRead
}

export const ASK_ORDER_RESPONSE_KINDS: readonly { id: ResponseKind; label: string }[] = [
  { id: 'signed-in', label: 'Signed-in rows' },
  { id: 'installed', label: 'Installed rows' },
]

const at = (allTime: AskOrderAllTime, g: AskOrderGroupId, stepId: string) => Number(allTime[`${askOrderFeatureId(g)}.${stepId}`]) || 0
const sumTags = (allTime: AskOrderAllTime, g: AskOrderGroupId, stepIdOf: (t: StepTag) => string) =>
  ASK_ORDER_TAGS.reduce((a, t) => a + at(allTime, g, stepIdOf(t.id)), 0)
const per = (num: number, den: number): number | null => (den > 0 ? num / den : null)
const groupLabel = (g: AskOrderGroupId) => ASK_ORDER_GROUPS.find((x) => x.id === g)!.label

/** The ask each response kind is read from in the once-per-device responded rows. */
const KIND_ASK: Record<ResponseKind, AskId> = { 'signed-in': 'signin', installed: 'install' }

/** The larger group of two on a count per assigned row, the multiple, and whether it meets the rule (the 1.5x test is on the
 * integer counts, hi/hiAssigned >= 1.5 * lo/loAssigned, so exactly 1.5x is not lost to float division). A tie, or a group
 * with nobody assigned, has no larger group. */
function compareGroups(
  a: AskOrderGroupRead,
  b: AskOrderGroupRead,
  countOf: (g: AskOrderGroupRead) => number,
): { larger: AskOrderGroupId | null; multiple: number | null; meets: boolean } {
  const ra = per(countOf(a), a.assigned)
  const rb = per(countOf(b), b.assigned)
  if (ra === null || rb === null || ra === rb) return { larger: null, multiple: null, meets: false }
  const [hi, lo] = ra > rb ? [a, b] : [b, a]
  const loRatio = per(countOf(lo), lo.assigned)!
  return {
    larger: hi.group,
    multiple: loRatio > 0 ? per(countOf(hi), hi.assigned)! / loRatio : null,
    meets: countOf(hi) * lo.assigned >= ASK_ORDER_SWITCH_MULTIPLE * countOf(lo) * hi.assigned,
  }
}

/** The pre-registered read of the A/B from all-time counts (organic + tagged together). The 1.5x rule reads ONE primary:
 * the once-per-device responded rows per assigned row as soon as any responded row exists (mode 'auto'), the combined
 * response rows per assigned row until then. The signed-in and installed figures are display only, except the tie-break:
 * if they point opposite ways between the groups, sign-ins decide. The rule applies ONLY once both groups have reached
 * the call point; before that the multiple is shown as preliminary. */
export function readAskOrder(allTime: AskOrderAllTime, mode: AskOrderPrimaryMode = ASK_ORDER_PRIMARY_MODE): AskOrderRead {
  const respondedSeen = ASK_ORDER_GROUPS.some((g) => ASK_ORDER_ASKS.some((a) => sumTags(allTime, g.id, (t) => respondedStepId(a.id, t)) > 0))
  const primaryId: AskOrderPrimaryId = mode === 'auto' ? (respondedSeen ? 'responded' : 'combined') : mode
  const primary: AskOrderPrimary = {
    id: primaryId,
    label:
      primaryId === 'responded'
        ? `Primary: responded per assigned (${respondedSeen ? 'once-per-device row' : 'set by hand; no responded row seen yet'})`
        : `Primary: combined response rows (${mode === 'auto' ? 'responded row not seen yet' : 'set by hand'})`,
  }

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
    const responseRows = ASK_ORDER_RESPONSE_OUTCOMES.reduce((a, o) => a + perOutcome[o].count, 0)
    const respondedOf = (kind: ResponseKind) => sumTags(allTime, g.id, (t) => respondedStepId(KIND_ASK[kind], t))
    const respondedRows = ASK_ORDER_RESPONSE_KINDS.reduce((a, k) => a + respondedOf(k.id), 0)
    const byKind = Object.fromEntries(
      ASK_ORDER_RESPONSE_KINDS.map((k) => {
        const count = primaryId === 'responded' ? respondedOf(k.id) : perOutcome[k.id].count
        return [k.id, { count, perAssigned: per(count, assigned) }]
      }),
    ) as AskOrderGroupRead['byKind']
    const primaryRows = primaryId === 'responded' ? respondedRows : responseRows
    return {
      group: g.id,
      label: g.label,
      assigned,
      asksShown,
      progress: Math.min(1, asksShown / ASK_ORDER_CALL_ASKS),
      reachedCall: asksShown >= ASK_ORDER_CALL_ASKS,
      perOutcome,
      responseRows,
      responseRowsPerAssigned: per(responseRows, assigned),
      respondedRows,
      respondedPerAssigned: per(respondedRows, assigned),
      primaryRows,
      primaryPerAssigned: per(primaryRows, assigned),
      byKind,
    }
  })
  const [a, b] = groups
  const bothReachedCall = groups.every((g) => g.reachedCall)
  const short = groups.filter((g) => !g.reachedCall).map((g) => `${g.label} ${g.asksShown} of ${ASK_ORDER_CALL_ASKS}`)

  const kinds = ASK_ORDER_RESPONSE_KINDS.map((k): AskOrderKindRead => {
    const c = compareGroups(a, b, (g) => g.byKind[k.id].count)
    return { kind: k.id, label: k.label, larger: c.larger, multiple: c.multiple }
  })

  // Sign-ins and installs pointing opposite ways between the groups: sign-ins decide.
  const [signIns, installs] = kinds
  const tieBreak = signIns.larger !== null && installs.larger !== null && signIns.larger !== installs.larger
  const basis: AskOrderRuleRead['basis'] = tieBreak ? 'sign-ins' : 'primary'
  const countOf = tieBreak ? (g: AskOrderGroupRead) => g.byKind['signed-in'].count : (g: AskOrderGroupRead) => g.primaryRows
  const { larger, multiple, meets } = compareGroups(a, b, countOf)
  const noun = tieBreak ? (primaryId === 'responded' ? 'responded sign-in rows' : 'signed-in rows') : primaryId === 'responded' ? 'responded rows' : 'response rows'
  const tieNote = tieBreak ? ' Sign-ins and installs point opposite ways between the groups, so sign-ins decide.' : ''

  let verdict: AskOrderVerdict
  if (!bothReachedCall) {
    verdict = { state: 'preliminary', note: `Preliminary, not at the call point yet (${short.join(', ')} asks shown).${tieNote}` }
  } else {
    // At the call point. A larger group with a zero smaller rate is an unbounded multiple: the rule switches.
    const switches = larger !== null && larger !== ASK_ORDER_DEFAULT_GROUP && meets
    const switchTo = switches ? larger : null
    const keep = groupLabel(ASK_ORDER_DEFAULT_GROUP).toLowerCase()
    const mult = multiple === null ? null : `${multiple.toFixed(2)}x`
    verdict = {
      state: 'call',
      switchTo,
      multiple,
      note:
        (switches
          ? `Call point reached: ${groupLabel(larger!)} has ${mult === null ? `more ${noun} per assigned row than the other order, which has none` : `${mult} the ${noun} per assigned row of the other`}, ${ASK_ORDER_SWITCH_MULTIPLE}x or more: switch everyone to ${groupLabel(larger!).toLowerCase()}.`
          : larger === ASK_ORDER_DEFAULT_GROUP
            ? `Call point reached: ${groupLabel(larger)} already has the more ${noun} per assigned row (${mult === null ? 'the other has none' : mult}): keep ${keep}.`
            : `Call point reached: ${mult === null ? 'no difference' : mult} in ${noun} per assigned row, below ${ASK_ORDER_SWITCH_MULTIPLE}x: keep ${keep}.`) + tieNote,
    }
  }
  return { groups, bothReachedCall, primary, kinds, rule: { basis, tieBreak, larger, multiple, verdict } }
}

// ── Reading the range model (the table) ──────────────────────────────────────────────────────────

/** One count of a step (latest ET day or range) from a group's FeatureHealth, 0 when absent. */
export function stepCount(f: FeatureHealth | undefined, stepId: string, which: 'latest' | 'range'): number {
  return f?.steps.find((s) => s.id === stepId)?.[which] ?? 0
}

/** Rows of the given outcomes (either ask) for one group and tag, latest/range. */
export function outcomeRowsOf(f: FeatureHealth | undefined, tag: StepTag, outcomes: readonly OutcomeId[], which: 'latest' | 'range'): number {
  return ASK_ORDER_ASKS.reduce((a, k) => a + outcomes.reduce((b, o) => b + stepCount(f, outcomeStepId(k.id, o, tag), which), 0), 0)
}

/** Signed-in rows + installed rows of one group and tag (a device that does both counts twice). */
export const responseRowsOf = (f: FeatureHealth | undefined, tag: StepTag, which: 'latest' | 'range'): number =>
  outcomeRowsOf(f, tag, ASK_ORDER_RESPONSE_OUTCOMES, which)
