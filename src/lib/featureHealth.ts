// Feature health: for every feature the beacons report on, is it firing, and are people moving
// through it? Pure and shared: functions/api/features.ts builds its SQL from FEATURES and hands the
// rows to assembleHealth; the Overview card and the Features page render the model it returns.
//
// THE ONE CONFIG LIST. A feature is a list of steps, a step is the set of beacon paths that count
// toward it. A new feature (or step) is a one-entry change here: the SQL, the table rows, the status
// and the step chart all read this list and nothing else.
//
// COUNTS ONLY (src/lib/splitGuard.ts). Every number is a per-ET-day total of rows, summed over a
// range. Rows are never joined into a path, never tied to a visitor, and never cut by hour, place or
// device. The "per" figures are plain ratios of two counts, NOT per-person conversion rates: some
// steps fire once per device, others on every occurrence, so the numerator can even exceed the
// denominator. The caption says so (HEALTH_CAPTION).
//
// WEB AND APP ARE COMBINED. Feature tracking is the same for both, so no step reads the site.

import { addDays, etDateFast, etWallTimeMs } from './etTime'

/** Which beacon paths count toward a step. A path matches when it equals one of `exact`, or starts
 * with one of `prefix`, and is not in `except`. Plain strings only (the SQL compares with
 * substr(), so no LIKE wildcard is ever involved). Prefixes end in '/' so a family never swallows
 * a sibling (`/game/complete/` is not `/game/complete-deferred/`). */
export interface StepMatch {
  exact?: readonly string[]
  prefix?: readonly string[]
  except?: readonly string[]
}

export interface StepDef {
  /** Unique within its feature. */
  id: string
  label: string
  match: StepMatch
  /** Show this step as a plain ratio of counts to another step of the same feature. */
  ratioOf?: { per: string }
}

export interface FeatureDef {
  id: string
  label: string
  /** One line: what the feature is, shown under the name on the Features page. */
  blurb: string
  steps: readonly StepDef[]
}

const GAME_DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'] as const

/** Paths below were checked against production D1 (2026-10-15): every path or prefix has arrived at
 * least once, except the ones marked "no rows yet". Dropped because no row ever arrived and no other
 * step of its feature had: `/game/tutorial-complete/…` (the tutorial completion). */
export const FEATURES: readonly FeatureDef[] = [
  {
    id: 'coach',
    label: 'Coach strip',
    // No rows yet at the time of writing: the coach beacons ship with the next Best Sudoku release.
    // The feature reads "New" until they arrive.
    blurb: 'The tip strip under the board: a tip is shown, opened into the tour, dismissed or closed.',
    steps: [
      { id: 'shown', label: 'Shown', match: { prefix: ['/coach/shown/'] } },
      { id: 'tour-opened', label: 'Tour opened', match: { exact: ['/coach/tour-opened'] }, ratioOf: { per: 'shown' } },
      { id: 'dismissed', label: 'Dismissed', match: { prefix: ['/coach/dismissed/'] }, ratioOf: { per: 'shown' } },
      { id: 'closed-at', label: 'Closed at', match: { prefix: ['/coach/closed-at/'] }, ratioOf: { per: 'shown' } },
    ],
  },
  {
    id: 'tour',
    label: 'Tour',
    blurb: 'The first-run tour: started, then completed, skipped, or left at a step.',
    steps: [
      { id: 'start', label: 'Started', match: { exact: ['/tour/start'] } },
      { id: 'complete', label: 'Completed', match: { exact: ['/tour/complete'] }, ratioOf: { per: 'start' } },
      { id: 'skip', label: 'Skipped', match: { exact: ['/tour/skip'] }, ratioOf: { per: 'start' } },
      { id: 'exit-at', label: 'Exited at a step', match: { exact: ['/tour/exit-at'], prefix: ['/tour/exit-at/'] }, ratioOf: { per: 'start' } },
    ],
  },
  {
    id: 'signin',
    label: 'Sign-in ask',
    blurb: 'The sign-in pop-up (any reason), accepted or declined, and the sign-ins that completed.',
    steps: [
      { id: 'shown', label: 'Shown', match: { prefix: ['/signin-prompt/'], except: ['/signin-prompt/accept', '/signin-prompt/dismiss'] } },
      { id: 'accept', label: 'Accepted', match: { exact: ['/signin-prompt/accept'] }, ratioOf: { per: 'shown' } },
      { id: 'dismiss', label: 'Declined', match: { exact: ['/signin-prompt/dismiss'] }, ratioOf: { per: 'shown' } },
      { id: 'signed-in', label: 'Signed in', match: { prefix: ['/auth/success/google/', '/auth/success/email/'] }, ratioOf: { per: 'accept' } },
    ],
  },
  {
    id: 'first50-promo',
    label: 'First-50 offer',
    blurb: 'The first-50 promotion pop-up: shown, accepted or declined.',
    steps: [
      { id: 'shown', label: 'Shown', match: { exact: ['/promo-first50/shown'] } },
      { id: 'accept', label: 'Accepted', match: { exact: ['/promo-first50/accept'] }, ratioOf: { per: 'shown' } },
      { id: 'dismiss', label: 'Declined', match: { exact: ['/promo-first50/dismiss'] }, ratioOf: { per: 'shown' } },
    ],
  },
  {
    id: 'first50-congrats',
    label: 'First-50 congrats',
    blurb: 'The congratulations card for a first-50 winner: shown, acknowledged or closed.',
    steps: [
      { id: 'shown', label: 'Shown', match: { exact: ['/first50-congrats/shown'] } },
      // No rows yet (only a close has arrived).
      { id: 'ack', label: 'Acknowledged', match: { exact: ['/first50-congrats/ack'] }, ratioOf: { per: 'shown' } },
      { id: 'close', label: 'Closed', match: { exact: ['/first50-congrats/close'] }, ratioOf: { per: 'shown' } },
    ],
  },
  {
    id: 'upsell',
    label: 'Upsell',
    blurb: 'The upgrade pop-up (any reason): shown, accepted or declined.',
    steps: [
      { id: 'shown', label: 'Shown', match: { prefix: ['/upsell/shown/'] } },
      // No rows yet (one shown row has arrived).
      { id: 'accept', label: 'Accepted', match: { prefix: ['/upsell/accept/'] }, ratioOf: { per: 'shown' } },
      { id: 'dismiss', label: 'Declined', match: { prefix: ['/upsell/dismiss/'] }, ratioOf: { per: 'shown' } },
    ],
  },
  {
    id: 'install',
    label: 'Install prompt',
    blurb: 'The install-the-app prompt: shown, accepted (Play, PWA or store link), declined, installed.',
    steps: [
      { id: 'shown', label: 'Shown', match: { exact: ['/install/prompt/android', '/install/prompt/ios', '/install/prompt/desktop'] } },
      { id: 'accept', label: 'Accepted', match: { exact: ['/install/play', '/install/pwa-accept', '/install/app-store'] }, ratioOf: { per: 'shown' } },
      { id: 'dismiss', label: 'Declined', match: { exact: ['/install/prompt/dismiss', '/install/prompt/dismiss-forever', '/install/prompt/have-it', '/install/pwa-decline'] }, ratioOf: { per: 'shown' } },
      { id: 'installed', label: 'Installed', match: { exact: ['/install/pwa-installed'] }, ratioOf: { per: 'accept' } },
    ],
  },
  {
    id: 'welcome',
    label: 'Welcome card',
    blurb: 'The signed-in welcome card: shown, a tap through to daily or the leaderboard, or dismissed.',
    steps: [
      { id: 'shown', label: 'Shown', match: { exact: ['/welcome-signed-in/shown'] } },
      { id: 'tapped', label: 'Tapped through', match: { exact: ['/welcome-signed-in/daily', '/welcome-signed-in/leaderboard'] }, ratioOf: { per: 'shown' } },
      { id: 'dismiss', label: 'Dismissed', match: { exact: ['/welcome-signed-in/dismiss'] }, ratioOf: { per: 'shown' } },
    ],
  },
  {
    id: 'games',
    label: 'Games',
    blurb: 'Games started and completed (normal and daily), every difficulty.',
    steps: [
      { id: 'start', label: 'Started', match: { prefix: ['/game/start/'] } },
      { id: 'complete', label: 'Completed', match: { prefix: ['/game/complete/'] }, ratioOf: { per: 'start' } },
    ],
  },
  // One feature per difficulty, generated from the same shape: a new difficulty is one more name above.
  ...GAME_DIFFICULTIES.map(
    (d): FeatureDef => ({
      id: `games-${d}`,
      label: `Games, ${d}`,
      blurb: `Games started and completed (normal and daily) on ${d}.`,
      steps: [
        { id: 'start', label: 'Started', match: { exact: [`/game/start/${d}`] } },
        { id: 'complete', label: 'Completed', match: { exact: [`/game/complete/normal/${d}`, `/game/complete/daily/${d}`] }, ratioOf: { per: 'start' } },
      ],
    }),
  ),
]

/** The widget view that draws a feature's step chart: `steps:<featureId>`. */
export const STEPS_VIEW_PREFIX = 'steps:'
export function stepsViewFor(featureId: string): string {
  return `${STEPS_VIEW_PREFIX}${featureId}`
}
/** The feature id a `steps:` view names, or null for any other view. */
export function featureIdOfView(view: string | undefined): string | null {
  return view && view.startsWith(STEPS_VIEW_PREFIX) && view.length > STEPS_VIEW_PREFIX.length ? view.slice(STEPS_VIEW_PREFIX.length) : null
}

// ── Status ──────────────────────────────────────────────────────────────────────────────────

/** "Went silent" needs an average of at least this many rows a day over the prior
 * HEALTH_BASELINE_DAYS complete ET days, and none at all on the latest complete ET day. Below it a
 * zero day is ordinary noise (at 5 a day, a quiet day is already rare), so the feature stays OK. */
export const HEALTH_SILENT_MIN_AVG = 5
/** The complete ET days before the latest complete day that the silent average is taken over. */
export const HEALTH_BASELINE_DAYS = 7
/** "New": no rows before this many complete ET days ago. */
export const HEALTH_NEW_DAYS = 7

export type HealthStatus = 'silent' | 'new' | 'ok'
export const HEALTH_STATUS_LABEL: Record<HealthStatus, string> = { silent: 'Went silent', new: 'New', ok: 'OK' }

/** Silent wins over new (a feature that fired and stopped is the alarming reading). `baseline` is the
 * daily total of each of the prior HEALTH_BASELINE_DAYS days, `before` the count of rows before the
 * new-days cutoff. */
export function statusOf(input: { latest: number; baseline: readonly number[]; before: number }): HealthStatus {
  const avg = input.baseline.length ? input.baseline.reduce((a, b) => a + b, 0) / input.baseline.length : 0
  if (avg >= HEALTH_SILENT_MIN_AVG && input.latest === 0) return 'silent'
  if (input.before === 0) return 'new'
  return 'ok'
}

// ── Ratios ──────────────────────────────────────────────────────────────────────────────────

/** A plain ratio of two counts, or null for a zero (or missing) denominator, which renders as "—". */
export function ratio(num: number, den: number): number | null {
  return den > 0 && Number.isFinite(num) ? num / den : null
}
export const NO_RATIO = '—'
export function formatRatio(r: number | null): string {
  return r === null ? NO_RATIO : r.toFixed(2)
}

export const HEALTH_CAPTION =
  'Counts are rows per ET day, web and app combined. "per" figures are plain ratios of two counts, not per-person conversion rates: rows are independent counts, never joined into a path, and some steps fire once per device, so a ratio can exceed 1.'

// ── Config helpers shared by the SQL and the tests ──────────────────────────────────────────

/** Every step of every feature in config order; its position is the SQL column (`s<index>`). */
export interface FlatStep {
  index: number
  featureIndex: number
  feature: FeatureDef
  step: StepDef
}
export function flatSteps(features: readonly FeatureDef[] = FEATURES): FlatStep[] {
  const out: FlatStep[] = []
  features.forEach((feature, featureIndex) => {
    for (const step of feature.steps) out.push({ index: out.length, featureIndex, feature, step })
  })
  return out
}

/** Whether a stored path counts toward a step. The SQL (functions/api/features.ts stepMatchSql)
 * says the same thing; a test runs both over the same paths. */
export function stepMatches(match: StepMatch, path: string): boolean {
  if (path.includes('\u0000')) return false
  if (match.except?.includes(path)) return false
  return !!(match.exact?.includes(path) || match.prefix?.some((p) => path.startsWith(p)))
}

// ── ET windows ──────────────────────────────────────────────────────────────────────────────

export interface HealthDays {
  today: string
  /** The latest complete ET day (yesterday). */
  latest: string
  /** The complete ET day before it. */
  prev: string
  /** The first of the HEALTH_BASELINE_DAYS days before `latest`. */
  baselineStart: string
  /** ET midnight of the first of the last HEALTH_NEW_DAYS complete days: rows before it make a feature not new. */
  newCutoffMs: number
  baselineStartMs: number
  /** ET midnight that ends today: the earliest end of the query window, so today's rows are read too. */
  tomorrowMs: number
}
export function healthDays(nowMs: number): HealthDays {
  const today = etDateFast(nowMs)
  const baselineStart = addDays(today, -(HEALTH_BASELINE_DAYS + 1))
  return {
    today,
    latest: addDays(today, -1),
    prev: addDays(today, -2),
    baselineStart,
    newCutoffMs: etWallTimeMs(addDays(today, -HEALTH_NEW_DAYS)),
    baselineStartMs: etWallTimeMs(baselineStart),
    tomorrowMs: etWallTimeMs(addDays(today, 1)),
  }
}

// ── The model ───────────────────────────────────────────────────────────────────────────────

export interface RatioHealth {
  /** "tour opened per shown" */
  label: string
  latest: number | null
  prev: number | null
  range: number | null
}
export interface StepHealth {
  id: string
  label: string
  latest: number
  prev: number
  range: number
  /** One count per day of `days`. */
  perDay: number[]
  ratio?: RatioHealth
}
export interface FeatureHealth {
  id: string
  label: string
  blurb: string
  status: HealthStatus
  /** Why: "averaged 12.3 a day over the prior 7 days, none yesterday", "no rows yet", … */
  statusNote: string
  latest: number
  prev: number
  range: number
  steps: StepHealth[]
}
export interface FeatureHealthModel {
  /** The ET days of the selected range, oldest first (the step charts' axis). */
  days: string[]
  latestDay: string
  prevDay: string
  features: FeatureHealth[]
}

/** One row of the grouped query: an ET day and one count per flat step (`s<index>`). */
export interface DayCounts {
  d: string
  s: readonly number[]
}

export function dayRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d < to && out.length < 4000; d = addDays(d, 1)) out.push(d)
  return out
}

const lc = (s: string) => s.toLowerCase()

/** Builds the model from the per-day step counts. `before[featureIndex]` is the count of rows before
 * the new-days cutoff; `rangeFrom`..`rangeTo` (exclusive) is the selected range's ET days. */
export function assembleHealth(input: {
  features?: readonly FeatureDef[]
  rows: readonly DayCounts[]
  before: readonly number[]
  nowMs: number
  rangeFrom: string
  rangeTo: string
}): FeatureHealthModel {
  const features = input.features ?? FEATURES
  const flat = flatSteps(features)
  const days = dayRange(input.rangeFrom, input.rangeTo)
  const hd = healthDays(input.nowMs)
  const baseline = dayRange(hd.baselineStart, hd.latest)
  const byDay = new Map<string, readonly number[]>()
  for (const r of input.rows) byDay.set(r.d, r.s)
  const at = (day: string, stepIndex: number) => Number(byDay.get(day)?.[stepIndex]) || 0

  const out: FeatureHealth[] = features.map((feature, fi) => {
    const mine = flat.filter((f) => f.featureIndex === fi)
    const steps: StepHealth[] = mine.map(({ index, step }) => ({
      id: step.id,
      label: step.label,
      latest: at(hd.latest, index),
      prev: at(hd.prev, index),
      range: days.reduce((a, d) => a + at(d, index), 0),
      perDay: days.map((d) => at(d, index)),
    }))
    for (const [i, { step }] of mine.entries()) {
      if (!step.ratioOf) continue
      const per = steps.find((s) => s.id === step.ratioOf!.per)
      const perDef = mine.find((m) => m.step.id === step.ratioOf!.per)
      if (!per || !perDef) continue
      const s = steps[i]
      s.ratio = {
        label: `${lc(step.label)} per ${lc(perDef.step.label)}`,
        latest: ratio(s.latest, per.latest),
        prev: ratio(s.prev, per.prev),
        range: ratio(s.range, per.range),
      }
    }
    const total = (day: string) => mine.reduce((a, m) => a + at(day, m.index), 0)
    const latest = total(hd.latest)
    const baselineCounts = baseline.map(total)
    const before = Number(input.before[fi]) || 0
    const status = statusOf({ latest, baseline: baselineCounts, before })
    const avg = baselineCounts.reduce((a, b) => a + b, 0) / (baselineCounts.length || 1)
    const recent = [...baseline, hd.latest].reduce((a, d) => a + total(d), 0) + total(hd.today)
    const statusNote =
      status === 'silent'
        ? `averaged ${avg.toFixed(1)} rows a day over the prior ${HEALTH_BASELINE_DAYS} days, none on ${hd.latest}`
        : status === 'new'
          ? recent === 0 && before === 0
            ? 'no rows yet'
            : `no rows before the last ${HEALTH_NEW_DAYS} days`
          : `${avg.toFixed(1)} rows a day over the prior ${HEALTH_BASELINE_DAYS} days`
    return {
      id: feature.id,
      label: feature.label,
      blurb: feature.blurb,
      status,
      statusNote,
      latest,
      prev: total(hd.prev),
      range: days.reduce((a, d) => a + total(d), 0),
      steps,
    }
  })
  return { days, latestDay: hd.latest, prevDay: hd.prev, features: out }
}
