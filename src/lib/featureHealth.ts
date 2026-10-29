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
import { SPLIT_REFUSED_PATH_PATTERNS } from './splitGuard'
import { isDateDim } from './rings'
import type { Widget } from '../types'

/** Which beacon paths count toward a step. A path matches when it equals one of `exact`, or starts
 * with one of `prefix`, and is not in `except`. Plain strings only (the SQL compares with
 * substr(), so no LIKE wildcard is ever involved). Prefixes end in '/' so a family never swallows
 * a sibling (`/game/complete/` is not `/game/complete-deferred/`). */
export interface StepMatch {
  exact?: readonly string[]
  prefix?: readonly string[]
  except?: readonly string[]
  /** Only rows whose campaign tag (`hits.campaign`, the row's uc) is set ('tagged') or empty ('organic'). The Ask-order A/B
   * card (askOrder.ts) is the one user. Unset: the tag is ignored. */
  tag?: StepTag
}
export type StepTag = 'tagged' | 'organic'

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
  /** An optional one-sentence reading caveat (a counting change, a comparison that does not hold): shown on the feature's step chart and under the Feature health table. */
  caption?: string
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
    blurb: 'The first-run tour: started, then completed or skipped.',
    // v1.99.1 is the first web release with the coach strip live (v1.99.0 never shipped on its own); from it the strip opens the tour without a /tour/start row.
    caption: '/tour/start no longer counts tours opened from the coach strip (from v1.99.1).',
    steps: [
      { id: 'start', label: 'Started', match: { exact: ['/tour/start'] } },
      { id: 'complete', label: 'Completed', match: { exact: ['/tour/complete'] }, ratioOf: { per: 'start' } },
      { id: 'skip', label: 'Skipped', match: { exact: ['/tour/skip'] }, ratioOf: { per: 'start' } },
      // No "exited at a step" leg: /tour/exit-at/<stage> is a second beacon for every skip (checked in
      // production D1 2026-10-15: identical counts on all 10 days, 74 and 74), so it would only repeat
      // Skipped and double the feature total.
    ],
  },
  {
    id: 'signin',
    label: 'Sign-in ask',
    blurb: 'The sign-in pop-up (any reason), accepted or declined, and the sign-ins that completed.',
    caption: 'Sign-in asks wait while a coach tip is showing, so ask impressions dip where coach tips run more often.',
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
    blurb: 'The upgrade pop-up (any reason): shown, accepted, pass tapped with sign-in first (a guest), or declined.',
    // The device-anchored guest trial (and its limit pop-up) rode in v1.99.0, which went live as v1.99.1.
    caption: 'Not comparable to flight 2: the guest trial changed in v1.99.1. A dismiss can be a sign-in tap: net it against the signed-in outcome for that reason before calling it rejection. From v1.99.1 the post-sign-in passes upsell shows but sends no shown beacon, so /upsell/shown does not count its views.',
    steps: [
      { id: 'shown', label: 'Shown', match: { prefix: ['/upsell/shown/'] } },
      // No rows yet (one shown row has arrived).
      { id: 'accept', label: 'Accepted', match: { prefix: ['/upsell/accept/'] }, ratioOf: { per: 'shown' } },
      // A guest's pass tap (best-sudoku 1.104.0) sends only this row, never the accept row too; Accepted stays the signed-in tap.
      { id: 'accept-signin', label: 'Pass tapped, sign-in first', match: { prefix: ['/upsell/accept-signin/'] }, ratioOf: { per: 'shown' } },
      { id: 'dismiss', label: 'Declined', match: { prefix: ['/upsell/dismiss/'] }, ratioOf: { per: 'shown' } },
    ],
  },
  {
    id: 'install',
    label: 'Install prompt',
    blurb: 'The install-the-app prompt: shown, accepted (Play, PWA or store link), declined, installed.',
    caption: 'Install asks wait while a coach tip is showing, so prompt impressions dip where coach tips run more often. iPhone users outside Safari count under /install/prompt/ios, and a dismissal after an in-app App Store tap counts as a dismissal.',
    steps: [
      { id: 'shown', label: 'Shown', match: { exact: ['/install/prompt/android', '/install/prompt/ios', '/install/prompt/desktop'] } },
      { id: 'accept', label: 'Accepted', match: { exact: ['/install/play', '/install/pwa-accept', '/install/app-store'] }, ratioOf: { per: 'shown' } },
      { id: 'dismiss', label: 'Declined', match: { exact: ['/install/prompt/dismiss', '/install/prompt/dismiss-forever', '/install/prompt/have-it', '/install/pwa-decline'] }, ratioOf: { per: 'shown' } },
      // No ratio: Accepted also counts Play and app-store taps, which never produce a PWA-installed row.
      { id: 'installed', label: 'Installed (PWA)', match: { exact: ['/install/pwa-installed'] } },
      // No ratio: the in-app-browser help (a page opened inside another app's browser, where the install prompt cannot run) is its own row, not a step after Shown. Provisional beacon: not checked against production D1.
      { id: 'inapp', label: 'In-app install help', match: { prefix: ['/install/inapp/'] } },
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
  // Last, so the default Features layout keeps every earlier chart where it was.
  {
    id: 'funnel',
    label: 'Money funnel',
    blurb: 'Paid conversion: a trial started, a checkout opened and a purchase made, on the web and on Google Play.',
    // Provisional beacons (counts only, sent at least 30 minutes after the event), not checked against production D1: the feature reads "New" until rows arrive.
    caption: 'From v1.99.1, a checkout start after sign-in can come from the passes upsell, whose views /upsell/shown does not count.',
    steps: [
      { id: 'trial', label: 'Trial started', match: { exact: ['/funnel/trial-start'] } },
      { id: 'checkout-web', label: 'Checkout started (web)', match: { exact: ['/funnel/checkout-start/web'] } },
      { id: 'checkout-play', label: 'Checkout started (Play)', match: { exact: ['/funnel/checkout-start/play'] } },
      { id: 'purchase-web', label: 'Purchased (web)', match: { exact: ['/funnel/purchase/web'] }, ratioOf: { per: 'checkout-web' } },
      { id: 'purchase-play', label: 'Purchased (Play)', match: { exact: ['/funnel/purchase/play'] }, ratioOf: { per: 'checkout-play' } },
    ],
  },
]

// ── The `featureStep` chart dimension (functions/api/geo.ts, catalog.ts) ──────────────────────────
// A step is addressed as `<featureId>.<stepId>` (ids hold letters, digits and '-', never '.'). The chart
// editor reads FEATURES alone, so a new feature or step is still a one-entry change above.

/** The chart-dimension value of one step. */
export function featureStepKey(featureId: string, stepId: string): string {
  return `${featureId}.${stepId}`
}
/** The step a `featureStep` value names, or null for a value that names none. No request text ever reaches
 * SQL: the SQL reads the step's own match, looked up here. */
export function featureStepOf(key: string): { feature: FeatureDef; step: StepDef } | null {
  const dot = key.indexOf('.')
  if (dot <= 0) return null
  const feature = FEATURES.find((f) => f.id === key.slice(0, dot))
  const step = feature?.steps.find((s) => s.id === key.slice(dot + 1))
  return feature && step ? { feature, step } : null
}
/** "Tour: Started": the name of one step on a chart. An unknown value shows as it is. */
export function featureStepLabel(key: string): string {
  const hit = featureStepOf(key)
  return hit ? `${hit.feature.label}: ${hit.step.label}` : key
}
/** Every step a `featureStep` value can name, in FEATURES order, as the chart editor's picker lists them (editor tools
 * T7: the value is picked, never typed, so a typo can no longer save a series that counts 0). */
export function featureStepChoices(): { value: string; label: string }[] {
  return FEATURES.flatMap((f) => f.steps.map((st) => ({ value: featureStepKey(f.id, st.id), label: featureStepLabel(featureStepKey(f.id, st.id)) })))
}
/** The featureStep values in a chart's series that name no step (a value saved before the picker, or a step since
 * removed from FEATURES), in series order, each once. Empty when every one is known. */
export function unknownFeatureStepValues(series: readonly { filter?: readonly { field: string; value: string }[] }[] | undefined): string[] {
  const bad = (series ?? []).flatMap((x) => (x.filter ?? []).filter((f) => f.field === 'featureStep' && !featureStepOf(f.value)).map((f) => f.value))
  return [...new Set(bad)]
}
/** Whether a step can match a path the split guard refuses (a static check on the config, never on data).
 * It errs toward true: the prefix test ignores `except`. A step that cannot needs neither the whole-ET-day
 * caption nor blocks a live refresh. */
export function stepMayMatchRefused(match: StepMatch): boolean {
  const lc = (s: string) => s.toLowerCase()
  const exact = (match.exact ?? []).some((p) => {
    const q = lc(p)
    return SPLIT_REFUSED_PATH_PATTERNS.some((pat) => (pat.endsWith('%') ? q.startsWith(pat.slice(0, -1)) : q === pat))
  })
  if (exact) return true
  return (match.prefix ?? []).some((p) => {
    const q = lc(p)
    return SPLIT_REFUSED_PATH_PATTERNS.some((pat) => (pat.endsWith('%') ? pat.slice(0, -1).startsWith(q) || q.startsWith(pat.slice(0, -1)) : pat.startsWith(q)))
  })
}

/** The step values of a beacon date line whose every series is exactly one featureStep filter (a Features-page step chart,
 * or one built like it in the chart editor), in series order; null for any other widget. */
export function featureStepSeriesOf(w: Pick<Widget, 'dataset' | 'dimension' | 'series'>): string[] | null {
  const series = w.series ?? []
  if (w.dataset !== 'geo' || !isDateDim(w.dimension) || !series.length) return null
  const values = series.map((s) => {
    const f = (s.filter ?? []).filter((x) => x.field && x.value)
    return f.length === 1 && f[0].field === 'featureStep' ? f[0].value : null
  })
  return values.every((v): v is string => v !== null) ? values : null
}

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
 * HEALTH_BASELINE_DAYS complete ET days, rows on at least HEALTH_SILENT_MIN_ACTIVE_DAYS of those
 * days, and none at all on the latest complete ET day. Below the average a zero day is ordinary
 * noise (at 5 a day, a quiet day is already rare); below the active-day count the feature is bursty
 * (a week's rows in a few days), and a quiet day is the normal gap between bursts, not an outage. */
export const HEALTH_SILENT_MIN_AVG = 5
/** Of the HEALTH_BASELINE_DAYS baseline days, how many must have had any rows (steady, not bursty). */
export const HEALTH_SILENT_MIN_ACTIVE_DAYS = 6
/** The complete ET days before the latest complete day that the silent average is taken over. */
export const HEALTH_BASELINE_DAYS = 7
/** "New": no rows before this many complete ET days ago. */
export const HEALTH_NEW_DAYS = 7

export type HealthStatus = 'silent' | 'new' | 'ok'
export const HEALTH_STATUS_LABEL: Record<HealthStatus, string> = { silent: 'Went silent', new: 'New', ok: 'OK' }

/** An outage keeps flagging for at most this many complete ET days (the latest one included). */
export const HEALTH_SILENT_MAX_RUN = 7
/** How many complete ET days before the latest the status reads: a baseline taken before the longest
 * flagged zero run. */
export const HEALTH_HISTORY_DAYS = HEALTH_BASELINE_DAYS + HEALTH_SILENT_MAX_RUN - 1

/** The zero run ending at the latest day (latest included, so 0 when the latest day had rows) and the
 * HEALTH_BASELINE_DAYS days before that run: an outage's own zero days never dilute its baseline, so
 * a real outage keeps flagging for up to HEALTH_SILENT_MAX_RUN days. `history` is the daily totals of
 * the days before the latest, oldest first. */
export function silentReading(latest: number, history: readonly number[]): { run: number; baseline: number[] } {
  if (latest !== 0) return { run: 0, baseline: history.slice(-HEALTH_BASELINE_DAYS) }
  let run = 1
  while (run <= history.length && history[history.length - run] === 0) run++
  const end = history.length - (run - 1)
  return { run, baseline: history.slice(Math.max(0, end - HEALTH_BASELINE_DAYS), end) }
}

/** Silent wins over new (a feature that fired and stopped is the alarming reading). `history` is the
 * daily totals of the HEALTH_HISTORY_DAYS days before the latest, oldest first; `before` the count of
 * rows before the new-days cutoff. */
export function statusOf(input: { latest: number; history: readonly number[]; before: number }): HealthStatus {
  const { run, baseline } = silentReading(input.latest, input.history)
  const avg = baseline.length ? baseline.reduce((a, b) => a + b, 0) / baseline.length : 0
  const active = baseline.filter((n) => n > 0).length
  if (run > 0 && run <= HEALTH_SILENT_MAX_RUN && avg >= HEALTH_SILENT_MIN_AVG && active >= HEALTH_SILENT_MIN_ACTIVE_DAYS) return 'silent'
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
export function stepMatches(match: StepMatch, path: string, campaign?: string | null): boolean {
  if (path.includes('\u0000')) return false
  if (match.tag && match.tag !== (campaign ? 'tagged' : 'organic')) return false
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
  /** The first of the HEALTH_HISTORY_DAYS days before `latest`. */
  baselineStart: string
  /** ET midnight of the first of the last HEALTH_NEW_DAYS complete days: rows before it make a feature not new. */
  newCutoffMs: number
  baselineStartMs: number
  /** ET midnight that ends today: the earliest end of the query window, so today's rows are read too. */
  tomorrowMs: number
}
export function healthDays(nowMs: number): HealthDays {
  const today = etDateFast(nowMs)
  const baselineStart = addDays(today, -(HEALTH_HISTORY_DAYS + 1))
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
  caption?: string
  status: HealthStatus
  /** Why: "averaged 12.3 a day over the prior 7 days, none yesterday", "no rows yet", … */
  statusNote: string
  /** The baseline's rows a day, to one decimal (the number statusNote quotes). */
  baselineAvg?: number
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
  const history = dayRange(hd.baselineStart, hd.latest)
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
    const historyCounts = history.map(total)
    const before = Number(input.before[fi]) || 0
    const status = statusOf({ latest, history: historyCounts, before })
    const { run, baseline: baselineCounts } = silentReading(latest, historyCounts)
    const avg = baselineCounts.reduce((a, b) => a + b, 0) / (baselineCounts.length || 1)
    const recent = [...history, hd.latest].reduce((a, d) => a + total(d), 0) + total(hd.today)
    const statusNote =
      status === 'silent'
        ? `averaged ${avg.toFixed(1)} rows a day over the ${HEALTH_BASELINE_DAYS} days before it went quiet, none for ${run} ${run === 1 ? 'day' : 'days'} up to ${hd.latest}`
        : status === 'new'
          ? recent === 0 && before === 0
            ? 'no rows yet'
            : `no rows before the last ${HEALTH_NEW_DAYS} days`
          : `${avg.toFixed(1)} rows a day over the prior ${HEALTH_BASELINE_DAYS} days`
    return {
      id: feature.id,
      label: feature.label,
      blurb: feature.blurb,
      ...(feature.caption ? { caption: feature.caption } : {}),
      status,
      statusNote,
      baselineAvg: Number(avg.toFixed(1)),
      latest,
      prev: total(hd.prev),
      range: days.reduce((a, d) => a + total(d), 0),
      steps,
    }
  })
  return { days, latestDay: hd.latest, prevDay: hd.prev, features: out }
}

/** What a step's ratio is per ("tour opened per shown"), the label assembleHealth gives it; null for a step with no
 * ratio, or one whose "per" step is not in the feature. */
export function stepRatioLabel(feature: FeatureDef, step: StepDef): string | null {
  const per = step.ratioOf ? feature.steps.find((s) => s.id === step.ratioOf!.per) : undefined
  return per ? `${lc(step.label)} per ${lc(per.label)}` : null
}
