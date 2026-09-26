// Pop-up / event-beacon path patterns — Best Sudoku sign-in prompt, first-50 promo,
// upsell, install and outcome beacons.
//
// ONE module for every path pattern (per the task brief): both /api/popups (build the
// panels) and /api/geo + /api/sites (exclude these rows from ordinary page-view/visit
// counts) import this file, so a path rename is a one-line edit here — nowhere else.
//
// Live shape confirmed 2026-09-25 against production D1 (`gss-geo`.hits):
//   /signin-prompt/dismiss    22 hits  (response)
//   /signin-prompt/placement  21 hits  (shown, reason = "placement")
//   /install/play               2 hits  (install accept, method = "play")
//   /signin-prompt/streak        1 hit  (shown, reason = "streak")
// — matches the spec exactly: /signin-prompt/<reason> is "shown" (reason absorbs
// whatever value isn't "accept"/"dismiss"), with /signin-prompt/accept and
// /signin-prompt/dismiss reserved as the two response paths. No other popup family had
// any live rows yet, so the rest of this file follows the spec as given (see the task
// report's "open questions" for what's still unconfirmed).

// ── Exclusion: every prefix below is an EVENT beacon, not a screen view. Every existing
// page-view / visit / path count (geo.ts totals + breakdowns, sites.ts site counts) must
// exclude them — hard requirement #2 in the task brief.
export const POPUP_EVENT_PREFIXES = [
  '/signin-prompt',
  '/signin-eligible',
  '/promo-first50',
  '/first50-congrats',
  '/upsell',
  '/install',
  '/popup-outcome',
  // On-device, no-ID return beacon (v1.95.3, see lib/campaigns.ts RETURN_BUCKETS): paths
  // like /return/<uc>/d0, /return/<uc>/d1, /return/<uc>/d2-7, … — an event, not a screen.
  '/return',
] as const

export function isPopupEventPath(path: string): boolean {
  return POPUP_EVENT_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))
}

/** Appends `path <> ? AND path NOT LIKE ?` (ANDed) for every prefix — excludes all popup-event rows. */
export function popupExcludeClause(w: string[], b: unknown[]): void {
  for (const prefix of POPUP_EVENT_PREFIXES) {
    w.push(`path <> ? AND path NOT LIKE ?`)
    b.push(prefix, `${prefix}/%`)
  }
}

/** The inverse of popupExcludeClause: one OR'd fragment matching ANY popup-event row. */
export function popupIncludeClause(): { sql: string; binds: string[] } {
  const sql = `(${POPUP_EVENT_PREFIXES.map(() => 'path = ? OR path LIKE ?').join(' OR ')})`
  const binds: string[] = []
  for (const p of POPUP_EVENT_PREFIXES) binds.push(p, `${p}/%`)
  return { sql, binds }
}

// ── Classification ──────────────────────────────────────────────────────────────────
// A classified pop-up event. `family` identifies which pop-up/funnel — a static id for
// every family except the dynamic outcome beacon, whose family is `popup-outcome:<name>`
// (the `<popup>` path segment, names TBD). `kind` is shown/accept/dismiss/outcome/etc.
// within that family; `extra` is the optional sub-dimension (a reason, an install
// platform/method, an outcome type).
export interface PopupEvent {
  family: string
  kind: string
  extra?: string
}

function segments(path: string, prefix: string): string[] {
  return path.slice(prefix.length).split('/').filter(Boolean)
}

// FINAL LIST (Best Sudoku team, 2026-09-25): settings-upgrade removed — it is not a real
// upsell reason. Any reason segment not in this list is still counted, bucketed as 'other'
// (see classifyPopupPath below) — never silently dropped or passed through raw.
export const UPSELL_REASONS = ['cadence', 'limit', 'daily-locked', 'upgrade-tap'] as const
export const INSTALL_SHOWN_PLATFORMS = ['android', 'ios', 'desktop'] as const
export const INSTALL_PLATFORM_LIST = ['web', 'play', 'app-store'] as const
export const INSTALL_OUTCOMES = ['pwa-installed', 'standalone-detected', 'play-detected'] as const
const INSTALL_PROMPT_DISMISS = ['dismiss', 'dismiss-forever', 'have-it'] as const
// FINAL LIST outcome vocabulary + windows (Best Sudoku team, 2026-09-25) — the window is
// enforced app-side (the app decides when to fire each outcome beacon); this module only
// classifies/aggregates whatever already arrived:
//   signed-in     — within 1 day of shown
//   installed     — within 7 days of shown
//   returned      — days 1-7 after shown
//   still-playing — days 14-21 after shown (NEW)
export const POPUP_OUTCOME_TYPES = ['signed-in', 'installed', 'returned', 'still-playing'] as const

// The /popup-outcome/<popup>/<outcome> wire vocabulary (FINAL LIST) differs from the
// internal family id for install: the beacon's own path segment is "install-prompt", but
// the family everywhere else in this file (POPUPS id, classifyPopupPath's 'install'
// family) is "install". This is the ONE place that reconciles the two names — every other
// popup's wire name already matches its internal id 1:1.
export const POPUP_OUTCOME_NAME_TO_FAMILY: Record<string, string> = {
  'signin-prompt': 'signin-prompt',
  'promo-first50': 'promo-first50',
  upsell: 'upsell',
  'install-prompt': 'install',
}

// FINAL LIST caveat (Best Sudoku team, 2026-09-25): /signin-eligible is the sign-in
// denominator — one row per signed-out regular finish — but it is DEFERRED at least 30
// minutes after the finish, so the row's own timestamp is NOT the finish time. Show this
// wherever signin-eligible is charted (counts or its rate), and NEVER use it to bucket by
// hour-of-day (see lib/campaigns.ts hourOfDayEt, which is built from tagged arrivals only,
// never from signin-eligible, for exactly this reason).
export const SIGNIN_ELIGIBLE_CAVEAT = 'Deferred ≥30 min after the finish — row time is not the finish time; never use for hour-of-day.'

// Pop-ups page note — CORRECTED 2026-09-26 against best-sudoku origin/main
// (src/services/measurementQuiet.ts, confirmed by the Best Sudoku session): the 30-minute
// quiet period after a sign-in DELAYS popup outcomes, /signin-eligible and /return/ beacons
// (they go out on a later navigation), it does not drop them; shown/accept/dismiss, /auth/
// and /install/ beacons still fire inside it. A held item is lost only if the player never
// navigates again before the 7-day queue expiry. The earlier wording ("Nothing is measured
// within 30 minutes after a sign-in") overstated it. Shown once on the pop-ups page, and the
// ads routine's report carries the same sentence (lib/adsRules.ts MEASUREMENT_QUIET_NOTE).
export const POPUP_PAGE_NOTE = 'Outcomes and return visits may arrive up to 30 minutes late; a small number are lost.'

// ── Install-outcome gap, fixed in Best Sudoku v1.95.4 ──────────────────────────────────
// Before the fix, accepting the install prompt marked the device installed immediately, so
// the later appinstalled / standalone handlers returned early: a prompt-driven install never
// emitted /install/pwa-installed or /popup-outcome/install-prompt/installed.
// /install/pwa-accept (the TAP) was always accurate.
//
// FIXED: v1.95.4 shipped to production web. The first CONFIRMED post-fix instant is
// 2026-09-26T16:26:36Z (12:26:36 ET); 16:25:27Z-16:26:36Z is indeterminate, so the boundary
// sits at its end. Rows of the two gap paths (INSTALL_GAP_PATHS) with ts BEFORE this instant
// are UNMEASURED ("known gap before fix"): they never feed a count, a rate or an alert —
// see isInstallGapUnmeasured and excludeInstallGapUnmeasured. At or after it they are measured
// normally and the known-gap label disappears; a range spanning it carries INSTALL_FIX_NOTE.
// null would mean "fix not shipped" (the whole history unmeasured, pending label).
export const INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS: number | null = Date.parse('2026-09-26T16:26:36Z')
/** The two paths the gap affected. /install/pwa-accept (the tap) and the other outcome
 * beacons were never affected. */
export const INSTALL_GAP_PATHS = ['/popup-outcome/install-prompt/installed', '/install/pwa-installed'] as const
export const INSTALL_OUTCOME_GAP_LABEL = 'known gap: prompt-driven installs not recorded (fix pending)'
export const INSTALL_GAP_BEFORE_FIX_LABEL = 'known gap before fix: prompt-driven installs not recorded'
/** "install fix went live 26 Sep 12:26 ET" — for any range that spans the fix. */
export function installFixMarkerLabel(fixedAtMs: number | null = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): string | null {
  if (fixedAtMs === null) return null
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(fixedAtMs))
      .map((x) => [x.type, x.value]),
  )
  return `install fix went live ${p.day} ${p.month} ${p.hour}:${p.minute} ET`
}
export const INSTALL_FIX_NOTE = `${installFixMarkerLabel() ?? ''}; earlier prompt-driven installs not recorded`

/** True while the fix has not shipped at all. */
export function installOutcomeGapOpen(fixedAtMs: number | null = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): boolean {
  return fixedAtMs === null
}
/** A gap-path row at `tsMs` is unmeasured when it predates the fix (boundary inclusive: a row
 * AT the fix instant is measured). Rows of any other path are never affected. */
export function isInstallGapUnmeasured(path: string, tsMs: number, fixedAtMs: number | null = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): boolean {
  if (!(INSTALL_GAP_PATHS as readonly string[]).includes(path)) return false
  return fixedAtMs === null || tsMs < fixedAtMs
}
/** SQL twin of isInstallGapUnmeasured, for queries that count installs: drops pre-fix gap rows
 * row-exactly (by `ts`), leaving everything else. */
export function excludeInstallGapUnmeasured(w: string[], b: unknown[], fixedAtMs: number | null = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): void {
  if (fixedAtMs === null) {
    w.push(`path NOT IN (${INSTALL_GAP_PATHS.map(() => '?').join(', ')})`)
    b.push(...INSTALL_GAP_PATHS)
  } else {
    w.push(`NOT (path IN (${INSTALL_GAP_PATHS.map(() => '?').join(', ')}) AND ts < ?)`)
    b.push(...INSTALL_GAP_PATHS, fixedAtMs)
  }
}
/** The label for an install-outcome figure covering [startMs, endMs): nothing once the whole
 * range is after the fix, "known gap before fix" when it is all before, the fix note when it
 * spans the fix (or no range is known), the pending label while unfixed. */
export function installOutcomeGapNote(range?: { startMs: number; endMs: number } | null, fixedAtMs: number | null = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): string {
  if (fixedAtMs === null) return INSTALL_OUTCOME_GAP_LABEL
  if (range && range.startMs >= fixedAtMs) return ''
  if (range && range.endMs <= fixedAtMs) return INSTALL_GAP_BEFORE_FIX_LABEL
  return INSTALL_FIX_NOTE
}
/** "<text> (<note>)", or just "<text>" when there is no note for the range. */
export function withInstallGapNote(text: string, range?: { startMs: number; endMs: number } | null, fixedAtMs: number | null = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): string {
  const note = installOutcomeGapNote(range, fixedAtMs)
  return note ? `${text} (${note})` : text
}
/** Which figures the gap touches: the install-prompt "installed" outcome rate
 * (POPUP_RATE_SPECS key `install:outcome:installed`), the popup-outcome "installed" count for
 * the install popup, and the pwa-installed real-outcome count. */
export const INSTALL_GAP_RATE_KEY = 'install:outcome:installed'
export const INSTALL_GAP_OUTCOME_KEY = 'pwa-installed'

export function classifyPopupPath(path: string): PopupEvent | null {
  if (!path) return null

  if (path === '/signin-prompt' || path.startsWith('/signin-prompt/')) {
    const [x] = segments(path, '/signin-prompt')
    if (!x) return null
    if (x === 'accept' || x === 'dismiss') return { family: 'signin-prompt', kind: x }
    return { family: 'signin-prompt', kind: 'shown', extra: x }
  }

  if (path === '/signin-eligible' || path.startsWith('/signin-eligible/')) {
    const [x] = segments(path, '/signin-eligible')
    if (x === 'earned' || x === 'capped' || x === 'unearned') return { family: 'signin-eligible', kind: x }
    return null
  }

  if (path === '/promo-first50' || path.startsWith('/promo-first50/')) {
    const [x] = segments(path, '/promo-first50')
    if (x === 'shown' || x === 'accept' || x === 'dismiss') return { family: 'promo-first50', kind: x }
    return null
  }

  if (path === '/first50-congrats' || path.startsWith('/first50-congrats/')) {
    const [x] = segments(path, '/first50-congrats')
    if (x === 'shown') return { family: 'first50-congrats', kind: 'shown' }
    if (x === 'ack') return { family: 'first50-congrats', kind: 'accept' }
    if (x === 'close') return { family: 'first50-congrats', kind: 'dismiss' }
    return null
  }

  if (path === '/upsell' || path.startsWith('/upsell/')) {
    const [kind, reason] = segments(path, '/upsell')
    if ((kind === 'shown' || kind === 'accept' || kind === 'dismiss') && reason) {
      // FINAL LIST: reasons are exactly UPSELL_REASONS — an unknown/removed reason (e.g. a
      // leftover 'settings-upgrade' beacon) is counted under 'other', never dropped and
      // never passed through as its own ad-hoc breakdown bucket.
      const known = (UPSELL_REASONS as readonly string[]).includes(reason) ? reason : 'other'
      return { family: 'upsell', kind, extra: known }
    }
    return null
  }

  if (path === '/install' || path.startsWith('/install/')) {
    const [a, b] = segments(path, '/install')
    if (!a) return null
    if (a === 'prompt' && b && (INSTALL_SHOWN_PLATFORMS as readonly string[]).includes(b)) {
      return { family: 'install', kind: 'shown', extra: b }
    }
    if (a === 'prompt' && b && (INSTALL_PROMPT_DISMISS as readonly string[]).includes(b)) {
      return { family: 'install', kind: 'dismiss', extra: b }
    }
    if (a === 'platforms' && b && (INSTALL_PLATFORM_LIST as readonly string[]).includes(b)) {
      return { family: 'install', kind: 'platformList', extra: b }
    }
    if (a === 'play') return { family: 'install', kind: 'accept', extra: 'play' }
    if (a === 'pwa-accept') return { family: 'install', kind: 'accept', extra: 'pwa' }
    if (a === 'app-store') return { family: 'install', kind: 'accept', extra: 'app-store' }
    if (a === 'pwa-decline') return { family: 'install', kind: 'dismiss', extra: 'pwa' }
    if ((INSTALL_OUTCOMES as readonly string[]).includes(a)) return { family: 'install', kind: 'outcome', extra: a }
    return null
  }

  if (path === '/popup-outcome' || path.startsWith('/popup-outcome/')) {
    const [name, outcome] = segments(path, '/popup-outcome')
    // FINAL LIST: <popup> is exactly {signin-prompt, promo-first50, upsell, install-prompt}
    // — resolved through POPUP_OUTCOME_NAME_TO_FAMILY so 'install-prompt' lands on the
    // 'install' family (see that constant's doc comment). Any other name (including the
    // bare 'install', which is NOT part of this wire vocabulary) doesn't classify.
    const family = name ? POPUP_OUTCOME_NAME_TO_FAMILY[name] : undefined
    if (family && outcome && (POPUP_OUTCOME_TYPES as readonly string[]).includes(outcome)) {
      return { family: `popup-outcome:${family}`, kind: outcome }
    }
    return null
  }

  return null
}

// ── ET day bucketing (hard requirement #3) ──────────────────────────────────────────
// SQLite has no time zones, so the Function groups rows by UTC HOUR (an aggregate,
// D1-side operation) and this maps each hour's start instant to its US-Eastern calendar
// date via Intl — never a fixed offset, so DST is handled correctly. A single UTC-hour
// bucket never spans two America/New_York calendar days: the ET offset is always a whole
// number of hours (-4 EDT / -5 EST), so ET midnight always falls exactly on a UTC-hour
// boundary — true even on the two DST-transition nights (the repeated/skipped local hour
// still sits inside one UTC hour).
const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
/** The America/New_York calendar date (YYYY-MM-DD) containing the given instant. */
export function etDateFromMs(ms: number): string {
  return ET_DATE_FMT.format(new Date(ms)) // en-CA formats as YYYY-MM-DD directly
}

// ── Rate math (hard requirement #4) ─────────────────────────────────────────────────
// ── Minimum cohort (review addendum, 2026-09-25) ────────────────────────────────────
// A rate computed from a tiny denominator is statistically noise dressed up as a
// percentage (2/3 reads as an alarming/impressive 67%, off by one event either way).
// computeRate — the ONE primitive every rate in this codebase is built on (directly, or
// via gateRate/costPer/funnelStepRates/returnVisitRates in lib/campaigns.ts) — enforces
// this floor itself, so a caller can't accidentally bypass it by using computeRate
// directly instead of a gated wrapper.
export const MIN_COHORT = 5

// Production has only 14 registered users total and 3/50 first-50 promo slots claimed
// (2026-09-26) — MIN_COHORT already blocks any single rate under 5 in its denominator,
// but even an ALLOWED rate (5-14) is still anecdotal at this population size. Shown once
// per page (pop-ups, campaigns, overview) alongside every rate, not a substitute for the
// MIN_COHORT gate above.
export const SMALL_SAMPLE_NOTE = 'Very small numbers: rates are anecdotal. Always read the counts.'

/** True when `denominator` is nonzero but under `minCohort` — the "some data, just not
 * enough" case, distinct from a true zero ("no data at all yet"). A caller that wants to
 * show "too few to report" instead of plain "—" checks this alongside computeRate's null. */
export function isInsufficientCohort(denominator: number, minCohort: number = MIN_COHORT): boolean {
  return denominator > 0 && denominator < minCohort
}

/** numerator / denominator, or null (never NaN/Infinity) when the denominator is 0 OR
 * below MIN_COHORT — see isInsufficientCohort for telling those two null-reasons apart. */
export function computeRate(numerator: number, denominator: number, minCohort: number = MIN_COHORT): number | null {
  if (!denominator || denominator < minCohort) return null
  return numerator / denominator
}

export interface GatedRate {
  value: number | null // computeRate's result
  insufficientCohort: boolean // see isInsufficientCohort
  // The raw counts behind `value` — carried alongside the computed rate (not just
  // derivable from it) so every rate the frontend renders can show its numerator/
  // denominator next to the percentage, even when `value` is null. See SMALL_SAMPLE_NOTE:
  // with only 14 registered users in production, a rate without its counts reads as far
  // more confident than the underlying sample supports.
  numerator: number
  denominator: number
}
/** computeRate bundled with WHY a null came back — the shape every rate-producing
 * function in this codebase (computePopupRate here; funnelStepRates/returnVisitRates/
 * costPer in lib/campaigns.ts) returns, so the frontend never has to re-derive the
 * distinction from a bare number. */
export function gateRate(numerator: number, denominator: number, minCohort: number = MIN_COHORT): GatedRate {
  return {
    value: computeRate(numerator, denominator, minCohort),
    insufficientCohort: isInsufficientCohort(denominator, minCohort),
    numerator,
    denominator,
  }
}

// ── Tracking activation date ("before is unmeasured, not zero") ────────────────────
// The US-Eastern calendar date v1.95.3 ships to prod and pop-up tracking is considered
// LIVE. null until that release is confirmed. Every day before this date — or every day
// at all, while this is still null — is UNMEASURED: it may hold real rows (e.g. the
// 2026-09-19 uncapped-placement-bug reproduction: 22 /signin-prompt/dismiss, 21
// /signin-prompt/placement, 1 /signin-prompt/streak, all from one player), but those
// rows are not a valid baseline and must never feed a rate, a summary figure, or a
// before/after comparison. Set this to the release date's ET calendar day when v1.95.3
// ships — nothing else needs to change: computePopupRate, the popup-count API
// dimensions (functions/api/popups.ts), the trend-chart "tracking starts" marker
// (lib/charts.ts), and the page note (App.vue) all read this one constant.
//
// Summary figures (rate tiles, stat totals) must NEVER present a before/after change
// across the activation boundary — there is deliberately no "vs previous period" delta
// anywhere in the pop-up dataset; don't add one without re-reading this comment.
// v1.95.3 went live on production WEB 2026-09-26 (confirmed live 14:31 UTC) — pop-up +
// campaign-return tracking is LIVE as of this ET calendar day. The Android/Play build is a
// SEPARATE, later release — see PLAY_TRACKING_ACTIVATION_DATE_ET below; this constant is
// web-only.
export const TRACKING_ACTIVATION_DATE_ET: string | null = '2026-09-26'

// ── Play/Android tracking activation date (separate from web, and NOT a step) ──────
// v1.95.3 (version code 19503) was SUBMITTED to the Play production track 2026-09-26
// 14:41 UTC — that's a SUBMISSION, not an arrival. Google reviews it first, and devices
// then update over several days: this is a RAMP, not a single ship date like
// TRACKING_ACTIVATION_DATE_ET above. PLAY_TRACKING_ACTIVATION_DATE_ET is the EARLIEST
// possible date any device could have it (submission day) — never treat it as the day
// data becomes complete, and never gate/gray out days after it the way isPreActivation
// does for the web date: a low count the week after submission is the expected shape of
// a staged rollout, not a tracking gap. null means "not even submitted yet" (kept for
// completeness/tests — not this build's state).
export const PLAY_TRACKING_ACTIVATION_DATE_ET: string | null = '2026-09-26'

/** Shown wherever bestsudoku-app /return or Play-referrer data would appear, while
 * PLAY_TRACKING_ACTIVATION_DATE_ET is still null (not even submitted). */
export const PLAY_TRACKING_NOT_LIVE_NOTE = 'Play tracking not yet live'
/** Chart-marker label at PLAY_TRACKING_ACTIVATION_DATE_ET — deliberately NOT "Play
 * tracking starts" (that would claim a step that didn't happen): the submission date is
 * the earliest possible arrival, not a live date. */
export const PLAY_TRACKING_MARKER_LABEL = 'Play: submitted 26 Sep, reaching devices from review onward'
/** Caveat shown alongside any Play/Android figure once PLAY_TRACKING_ACTIVATION_DATE_ET
 * is set — explains why early counts run low without implying anything is broken or
 * that data should be graphed as "unmeasured" the way pre-web-activation rows are. */
export const PLAY_TRACKING_ROLLOUT_CAVEAT =
  'Play submission is in Google review and staged rollout — early counts reflect the rollout curve, not full device coverage.'

/** Human status line for wherever Play/Android data is shown — the null (not submitted)
 * and ramp (submitted, ramping) states read very differently, so callers use this instead
 * of re-deriving the branch themselves. */
export function playTrackingStatusNote(activationDateEt: string | null = PLAY_TRACKING_ACTIVATION_DATE_ET): string {
  return activationDateEt === null ? PLAY_TRACKING_NOT_LIVE_NOTE : PLAY_TRACKING_ROLLOUT_CAVEAT
}

/** True while `etDate` predates tracking — or activation hasn't happened at all yet. */
export function isPreActivation(etDate: string, activationDateEt: string | null): boolean {
  return activationDateEt === null || etDate < activationDateEt
}

// ── Aggregation ──────────────────────────────────────────────────────────────────────
// The Function fetches one row per (UTC hour bucket, path) with its count — still an
// aggregate query (no per-row/per-visitor data), never correlated by timestamp or
// device. This classifies and re-aggregates that into three maps: `coarse` (total per
// family+kind, e.g. every "signin-prompt shown" regardless of reason), `detailed`
// (per family+kind+extra, e.g. per upsell reason) and `byDay` (per ET date + family +
// kind, for trend charts).
export interface HourPathCount {
  hourStartMs: number // the UTC hour bucket's start instant
  path: string
  count: number
  /** Row-exact "ts >= INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS" from the query, when it split on
   * it. Absent = fall back to the hour bucket (post-fix only if the bucket starts at or after
   * the fix — the conservative side). */
  postInstallFix?: boolean
}
/** Whether an hour-bucketed row counts as on/after the install fix (see HourPathCount). */
export function rowIsPostInstallFix(r: HourPathCount, fixedAtMs: number | null = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): boolean {
  if (fixedAtMs === null) return false
  return r.postInstallFix ?? r.hourStartMs >= fixedAtMs
}

export interface PopupAggregate {
  coarse: Map<string, number> // `${family}|${kind}` -> count
  detailed: Map<string, number> // `${family}|${kind}|${extra}` -> count
  byDay: Map<string, number> // `${etDate}|${family}|${kind}` -> count
  // The activation-gated twins of `coarse`/`detailed`: same shape, but only rows whose ET
  // day is on/after the activation date are counted (see isPreActivation). Entirely empty
  // while TRACKING_ACTIVATION_DATE_ET is null — every rate and every pop-up count widget
  // (except the 'date' trend, which plots full history with a marker) reads these instead
  // of `coarse`/`detailed`, so a pre-release row can never compute a misleading rate or
  // count as a baseline. `coarse`/`detailed`/`byDay` themselves stay full-history and
  // unfiltered — the trend chart and any full-history debugging still need them.
  measuredCoarse: Map<string, number>
  measuredDetailed: Map<string, number>
  // Install prompt counted from the install fix on (see INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS),
  // so the "installed" outcome rate compares post-fix outcomes with post-fix showings — a
  // pre-fix showing could never produce one.
  installPostFix: { shown: number; installed: number }
}

const coarseKey = (family: string, kind: string) => `${family}|${kind}`
const detailedKey = (family: string, kind: string, extra: string) => `${family}|${kind}|${extra}`
const dayKey = (etDate: string, family: string, kind: string) => `${etDate}|${family}|${kind}`

function bump(m: Map<string, number>, k: string, n: number): void {
  m.set(k, (m.get(k) ?? 0) + n)
}

export function aggregatePopupRows(
  rows: HourPathCount[],
  activationDateEt: string | null = TRACKING_ACTIVATION_DATE_ET,
): PopupAggregate {
  const coarse = new Map<string, number>()
  const detailed = new Map<string, number>()
  const byDay = new Map<string, number>()
  const measuredCoarse = new Map<string, number>()
  const measuredDetailed = new Map<string, number>()
  const installPostFix = { shown: 0, installed: 0 }
  for (const r of rows) {
    const ev = classifyPopupPath(r.path)
    if (!ev) continue
    bump(coarse, coarseKey(ev.family, ev.kind), r.count)
    if (ev.extra) bump(detailed, detailedKey(ev.family, ev.kind, ev.extra), r.count)
    const etDate = etDateFromMs(r.hourStartMs)
    bump(byDay, dayKey(etDate, ev.family, ev.kind), r.count)
    if (isPreActivation(etDate, activationDateEt)) continue
    const postFix = rowIsPostInstallFix(r)
    // Pre-fix rows of the two gap paths stay UNMEASURED (never a count or a rate).
    if ((INSTALL_GAP_PATHS as readonly string[]).includes(r.path) && !postFix) continue
    bump(measuredCoarse, coarseKey(ev.family, ev.kind), r.count)
    if (ev.extra) bump(measuredDetailed, detailedKey(ev.family, ev.kind, ev.extra), r.count)
    if (postFix && ev.family === 'install' && ev.kind === 'shown') installPostFix.shown += r.count
    if (postFix && ev.family === 'popup-outcome:install' && ev.kind === 'installed') installPostFix.installed += r.count
  }
  return { coarse, detailed, byDay, measuredCoarse, measuredDetailed, installPostFix }
}

export function coarseCount(agg: PopupAggregate, family: string, kind: string): number {
  return agg.coarse.get(coarseKey(family, kind)) ?? 0
}
export function detailedCount(agg: PopupAggregate, family: string, kind: string, extra: string): number {
  return agg.detailed.get(detailedKey(family, kind, extra)) ?? 0
}
/** Activation-gated twin of coarseCount — 0 for any pre-activation-only bucket. */
export function measuredCoarseCount(agg: PopupAggregate, family: string, kind: string): number {
  return agg.measuredCoarse.get(coarseKey(family, kind)) ?? 0
}
/** Activation-gated twin of detailedCount — 0 for any pre-activation-only bucket. */
export function measuredDetailedCount(agg: PopupAggregate, family: string, kind: string, extra: string): number {
  return agg.measuredDetailed.get(detailedKey(family, kind, extra)) ?? 0
}
/** Every `${date}` bucket for one family+kind, as [date, count] pairs, unsorted. */
export function dayCounts(agg: PopupAggregate, family: string, kind: string): [string, number][] {
  const suffix = `|${family}|${kind}`
  const out: [string, number][] = []
  for (const [key, count] of agg.byDay) {
    if (!key.endsWith(suffix)) continue
    out.push([key.slice(0, key.length - suffix.length), count])
  }
  return out
}
/** Every `${extra}` bucket for one family+kind, as [extra, count] pairs, unsorted. */
export function detailedBreakdown(agg: PopupAggregate, family: string, kind: string): [string, number][] {
  const prefix = `${family}|${kind}|`
  const out: [string, number][] = []
  for (const [key, count] of agg.detailed) {
    if (!key.startsWith(prefix)) continue
    out.push([key.slice(prefix.length), count])
  }
  return out
}
/** Activation-gated twin of detailedBreakdown — omits any pre-activation-only bucket. */
export function measuredDetailedBreakdown(agg: PopupAggregate, family: string, kind: string): [string, number][] {
  const prefix = `${family}|${kind}|`
  const out: [string, number][] = []
  for (const [key, count] of agg.measuredDetailed) {
    if (!key.startsWith(prefix)) continue
    out.push([key.slice(prefix.length), count])
  }
  return out
}

// ── Registry (dashboard-facing) ─────────────────────────────────────────────────────
// Every "simple" pop-up funnel this dashboard renders panels for: shown/accept/dismiss
// counts, a tap rate, and (once real events show up) outcome rates. Adding a new one
// here is enough to make it selectable in the chart editor's dimension/rate pickers.
export interface PopupDef {
  id: string
  label: string
  hasReasonBreakdown?: boolean // shown/accept/dismiss further breaks down by a reason
  // FINAL LIST: first50-congrats has no /popup-outcome beacon at all — never generate an
  // outcome-rate spec (or a chart tile) for it, and never render a "not instrumented"
  // placeholder that would imply one is coming. See NO_OUTCOME_TRACKING_NOTE.
  noOutcomeTracking?: boolean
}

export const POPUPS: PopupDef[] = [
  { id: 'signin-prompt', label: 'Sign-in prompt' },
  { id: 'promo-first50', label: 'First 50 promo' },
  { id: 'first50-congrats', label: 'First 50 congrats', noOutcomeTracking: true },
  { id: 'upsell', label: 'Upsell', hasReasonBreakdown: true },
  { id: 'install', label: 'Install prompt', hasReasonBreakdown: true },
]
// Shown once, wherever first50-congrats is charted, instead of any outcome-rate row.
export const NO_OUTCOME_TRACKING_NOTE = 'no outcome tracking'

export interface PopupRateSpec {
  key: string
  label: string
  kind: 'tap' | 'outcome' | 'eligibility'
  popup?: string
  outcome?: string
}

export const POPUP_RATE_SPECS: PopupRateSpec[] = [
  ...POPUPS.map((p) => ({ key: `${p.id}:tap`, label: `${p.label} — tap rate (accept / shown)`, kind: 'tap' as const, popup: p.id })),
  ...POPUPS.filter((p) => !p.noOutcomeTracking).flatMap((p) =>
    POPUP_OUTCOME_TYPES.map((o) => ({
      key: `${p.id}:outcome:${o}`,
      label: `${p.label} — ${o.replace('-', ' ')} rate${`${p.id}:outcome:${o}` === INSTALL_GAP_RATE_KEY ? ' (from the install fix on)' : ''}`,
      kind: 'outcome' as const,
      popup: p.id,
      outcome: o,
    })),
  ),
  { key: 'signin-eligible:rate', label: 'Sign-in eligibility rate (earned / total)', kind: 'eligibility' as const },
]

// Every rate reads the ACTIVATION-GATED (measuredCoarse) counts, never the raw
// full-history `coarse` counts — see isPreActivation / TRACKING_ACTIVATION_DATE_ET.
// While activation is null, measuredCoarse is entirely empty, so every rate here comes
// back null ("—"), regardless of how much real pre-release data exists — a real
// denominator of e.g. 22 pre-release "shown" events must never turn into a real 0%/NaN
// tap rate (hard requirement: "before activation is unmeasured, not zero").
//
// Returns a GatedRate, not a bare number — EVERY kind (tap, outcome, and eligibility) is
// MIN_COHORT-gated via gateRate, so any denominator under 5 (shown, or
// earned+capped+unearned for eligibility) reports "insufficient" instead of a noisy rate.
export function computePopupRate(agg: PopupAggregate, spec: PopupRateSpec): GatedRate {
  if (spec.kind === 'eligibility') {
    const earned = measuredCoarseCount(agg, 'signin-eligible', 'earned')
    const capped = measuredCoarseCount(agg, 'signin-eligible', 'capped')
    const unearned = measuredCoarseCount(agg, 'signin-eligible', 'unearned')
    return gateRate(earned, earned + capped + unearned)
  }
  // Install-prompt "installed": post-fix outcomes over post-fix showings only.
  if (spec.key === INSTALL_GAP_RATE_KEY) return gateRate(agg.installPostFix.installed, agg.installPostFix.shown)
  const shown = measuredCoarseCount(agg, spec.popup!, 'shown')
  if (spec.kind === 'tap') return gateRate(measuredCoarseCount(agg, spec.popup!, 'accept'), shown)
  // outcome
  return gateRate(measuredCoarseCount(agg, `popup-outcome:${spec.popup}`, spec.outcome!), shown)
}
