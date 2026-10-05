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

import { etOffsetHours, etWallTimeMs } from './etTime'

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
  // v1.95.5 (live 2026-09-26T19:43:02Z, see GAME_COMPLETE_LIVE_AT below): one row per
  // distinct completed game, `/game/complete/<normal|daily>/<easy|medium|hard|expert|
  // unknown>`. WITH the trailing slash, unlike every other entry above — `/game` itself
  // (the real "played a game" page view, see lib/campaigns.ts PLAYED_PATH) must keep
  // counting as a page view, and this entry must anchor on the full `/game/complete/`
  // segment, never a bare `/game` or `/game/complete` prefix (which would also swallow
  // `/game` and any future unrelated `/game/completely-*`-shaped path). Entries ending in
  // '/' are matched as a raw prefix below (isPopupEventPath/popupExcludeClause/
  // popupIncludeClause), not the exact-or-prefix-plus-slash shape the other entries use.
  '/game/complete/',
  // best-sudoku card 125, legacy path: a game finished by an EU visitor while the consent modal
  // was still unanswered once went out later, at consent time, on
  // `/game/complete-deferred/<mode>/<difficulty>` instead of the live `/game/complete/<mode>/
  // <difficulty>` path (see GAME_COMPLETE_DEFERRED_PREFIX in lib/campaigns.ts). No tagged
  // best-sudoku build sends it any more, but the path stays classified so old rows stay out of
  // page views. The worker stamps `ts` at ingest, so the row's time is consent time, not
  // completion time — never a live completion, never a funnel "completed" step (see
  // lib/campaigns.ts classifyFunnelPath, whose GAME_COMPLETE_PREFIX anchors on the exact
  // `/game/complete/` segment and therefore never matches this hyphenated sibling path). Same
  // trailing-slash prefix-match convention as `/game/complete/` above, and a DISTINCT family
  // (never folded into 'game-complete') so the deferred count stays separately visible.
  '/game/complete-deferred/',
  // v1.95.5 (same instant): the new/existing/unknown row `/auth/success/<provider>/<status>`
  // fires ALONGSIDE the base `/auth/success/<provider>` row for the same sign-in, so it is an
  // event, not a second screen view. Anchored per provider WITH the trailing slash, so the base
  // rows themselves (which stay page views, as before) never match. Providers: lib/campaigns.ts
  // AUTH_SUCCESS_PROVIDERS.
  '/auth/success/google/',
  '/auth/success/email/',
  // v1.89.0 (live 2026-09-22, see AUTH_ERROR_REDIRECT_LIVE_AT_ET below): a sign-in FAILURE
  // beacon, `/auth/error/<slug>` — one row per failed attempt. `<slug>` is open-ended
  // (best-sudoku's AUTH_ERROR_SLUGS table grows over time; an unmapped code sends `other`),
  // so this is a plain prefix match, never a fixed enum. Never a screen view.
  '/auth/error',
  // v1.89.0 (same date): the popup-to-redirect sign-in fallback, `/auth/redirect/<provider>`
  // — fires when the popup flow can't run (e.g. an in-app browser) and the app falls back to
  // a full-page redirect. One row per fallback. Never a screen view.
  '/auth/redirect',
  // First-session beacons (Best Sudoku, rolling out 2026-09-30; read by the ads routine's
  // first-session funnel, lib/adsRules.ts firstSessionBucket): the tutorial tour
  // (/tour/start | complete | skip), the first placed digit (/game/first-move), an abandoned
  // game by % filled (/game/abandon/<0|1-25|26-50|51-75|76-99>) and the signed-in welcome card
  // (/welcome-signed-in/<shown|daily|leaderboard|dismiss>). All events, never screen views.
  // '/game/first-move' and '/game/abandon' are exact-or-subpath anchors like every entry
  // above, so '/game' itself stays a page view.
  '/tour',
  // v1.97.0 (live 2026-10-03T17:03:40Z, see TOUR_TRACKING_LIVE_AT below): the tutorial win's
  // completion beacon, split by run kind: `/game/tutorial-complete/first-run` and
  // `/game/tutorial-complete/replay`. NOT a real game completion (never a `/game/complete/`
  // row, never a funnel "completed" step) and never a screen view. `/tour/exit-at/<preamble|
  // hub|section>` rides the existing '/tour' prefix above. Counts only.
  '/game/tutorial-complete',
  '/game/first-move',
  '/game/abandon',
  '/welcome-signed-in',
  // v1.97.0 count-only beacon (live on prod web 2026-10-03, see TOUR_TRACKING_LIVE_AT below): a
  // counted game start, `/game/start/<easy|medium|hard|expert|unknown>`. WITH the trailing slash,
  // like `/game/complete/`: `/game` itself is the real "played a game" page view and must keep
  // counting as one. Without this entry every counted start from 17:03:40Z on was a page view.
  // The other two v1.97.0 beacons need no entry here: `/tour/exit-at/<preamble|hub|section>`
  // sits under '/tour' and `/game/tutorial-complete/<first-run|replay>` is covered by its own
  // entry above. Read by lib/adsRules.ts firstSessionBucket (first-run counters).
  '/game/start/',
] as const

export function isPopupEventPath(path: string): boolean {
  return POPUP_EVENT_PREFIXES.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(p + '/')))
}

/** True for a stored path that contains U+0000 (the JS matcher refuses those too). Literal SQL, no binds. LIKE reads text
 * only up to its first NUL; instr() sees the whole value. Lives here, not in splitGuard.ts, which imports this module. */
export const NUL_PATH_SQL = 'instr(path, char(0)) > 0'

/** Appends `path <> '<prefix>' AND path NOT LIKE '<prefix>/%'` (ANDed) for every prefix —
 * excludes all popup-event rows. A prefix that already ends in '/' (see
 * POPUP_EVENT_PREFIXES' `/game/complete/`) is matched with a single `path NOT LIKE
 * '<prefix>%'` — never `${prefix}/%`, which would require a spurious extra slash and never
 * exclude anything.
 *
 * WHY LITERALS, NOT `?` BINDS (fixed 2026-09-27 — D1 bind-ceiling regression): every value
 * here comes from POPUP_EVENT_PREFIXES, this module's own static constant, never from a
 * request — the exact condition popupDimSqlCase's own "WHY LITERALS" comment (below) already
 * documents for the popupFamily/popupOutcome CASE expressions, so this clause follows the
 * same precedent instead of introducing a second policy. Before this fix each prefix cost 1-2
 * BOUND parameters (`?`) in the standing exclusion every functions/api/geo.ts chart query
 * carries; growing POPUP_EVENT_PREFIXES from 11 to 13 entries (auth/error + auth/redirect,
 * this same release) pushed that from 19 to 23 binds and took the documented worst case (50
 * sites + 16 path constraints + a referrer x device ring + "hide my own visits") from exactly
 * 100 D1-bound-parameters to 104 — refused with a 400 ("104 values; at most 100") even though
 * every input was within its own documented maximum (functions/api/geo.ts MAX_SITES /
 * MAX_CONSTRAINTS, unchanged here). Emitting these as escaped SQL literals via sqlLit costs
 * ZERO bind slots per prefix regardless of how many prefixes this list ever grows to — the
 * bind budget is spent only on real request input (sites, drill constraints, own-visit
 * browser/OS, referrer exclusion hosts), which is exactly what D1's 100-parameter cap is
 * meant to bound. See functions/api/geo.derivedDims.test.ts's boundary tests for the
 * before/after bind counts, executed against the real handler. */
export function popupExcludeClause(w: string[], _b: unknown[]): void {
  // A path with a NUL is refused everywhere else (lib/splitGuard.ts), and LIKE stops reading at one, so the
  // prefix tests below see a forged `/return<NUL>x` as `/return` (excluded) but `/page<NUL>x` as `/page` (kept).
  // One AND-ed term, never folded into an OR: a NULL path gives NULL here, as it already does for the LIKE terms, so it is
  // dropped exactly as before; '' and clean paths give true.
  w.push(`NOT (${NUL_PATH_SQL})`)
  for (const prefix of POPUP_EVENT_PREFIXES) {
    if (prefix.endsWith('/')) {
      w.push(`path NOT LIKE ${sqlLit(`${prefix}%`)}`)
    } else {
      w.push(`path <> ${sqlLit(prefix)} AND path NOT LIKE ${sqlLit(`${prefix}/%`)}`)
    }
  }
}

/** The inverse of popupExcludeClause: one OR'd fragment matching ANY popup-event row. Same
 * literal-not-bind rationale as popupExcludeClause above — `binds` stays present (empty) so
 * existing callers (functions/api/popups.ts, popupDimPrefilter below) that spread it into
 * their own bind array don't need to change. */
export function popupIncludeClause(): { sql: string; binds: string[] } {
  const sql = `(${POPUP_EVENT_PREFIXES.map((p) => (p.endsWith('/') ? `path LIKE ${sqlLit(`${p}%`)}` : `path = ${sqlLit(p)} OR path LIKE ${sqlLit(`${p}/%`)}`)).join(' OR ')})`
  return { sql, binds: [] }
}

// ── Path family — a derived dimension (functions/api/geo.ts's 'pathFamily') that groups
// every event-beacon prefix above into one label, so "Include event beacons" charts can
// split by kind of event without a bespoke pop-up-only chart. A real page view (nothing
// below matches) is 'page'. Built from the SAME POPUP_EVENT_PREFIXES list the exclusion
// clause uses, in the same order (first match wins, matching isPopupEventPath's own
// precedence), so the exclusion set and the family split can never drift apart.
const PATH_FAMILY_LABELS: Record<(typeof POPUP_EVENT_PREFIXES)[number], string> = {
  '/signin-prompt': 'signin-prompt',
  '/signin-eligible': 'signin-eligible',
  '/promo-first50': 'promo-first50',
  '/first50-congrats': 'first50-congrats',
  '/upsell': 'upsell',
  '/install': 'install',
  '/popup-outcome': 'popup-outcome',
  '/return': 'return',
  '/game/complete/': 'game-complete',
  '/game/complete-deferred/': 'game-complete-deferred',
  '/auth/success/google/': 'auth-status',
  '/auth/success/email/': 'auth-status',
  '/auth/error': 'auth-error',
  '/auth/redirect': 'auth-redirect',
  '/tour': 'tour',
  '/game/tutorial-complete': 'tutorial-complete',
  '/game/first-move': 'game-first-move',
  '/game/abandon': 'game-abandon',
  '/welcome-signed-in': 'welcome-signed-in',
  '/game/start/': 'game-start',
}

/** Path → family label. 'page' for anything that isn't an event beacon (an ordinary page
 * view). Pure-JS twin of pathFamilySqlCase() below — not currently called from a hot
 * request path (geo.ts groups in SQL), but kept here as the single source of truth other
 * callers (tests, future per-row classification) should use rather than re-deriving it. */
export function pathFamilyOf(path: string): string {
  for (const prefix of POPUP_EVENT_PREFIXES) {
    const hit = prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(prefix + '/')
    if (hit) return PATH_FAMILY_LABELS[prefix]
  }
  return 'page'
}

/** SQL CASE expression computing the same family label pathFamilyOf() computes in JS. Built
 * only from this file's own static, hardcoded prefixes — never from request input — so it's
 * safe to inline into a query string; geo.ts's GEO_DIMS whitelist gates which dimension keys
 * can ever select it, so a caller never chooses the SQL that runs here. */
export function pathFamilySqlCase(): string {
  const whens = POPUP_EVENT_PREFIXES.map((prefix) => {
    const label = PATH_FAMILY_LABELS[prefix]
    return prefix.endsWith('/') ? `WHEN path LIKE '${prefix}%' THEN '${label}'` : `WHEN path = '${prefix}' OR path LIKE '${prefix}/%' THEN '${label}'`
  })
  return `CASE ${whens.join(' ')} ELSE 'page' END`
}

/** Friendly labels for the family values a 'pathFamily' chart's rows carry. */
export const PATH_FAMILY_OPTIONS: { value: string; label: string }[] = [
  { value: 'page', label: 'Page view' },
  { value: 'signin-prompt', label: 'Sign-in prompt' },
  { value: 'signin-eligible', label: 'Sign-in eligibility' },
  { value: 'promo-first50', label: 'First-50 promo' },
  { value: 'first50-congrats', label: 'First-50 congrats' },
  { value: 'upsell', label: 'Upsell prompt' },
  { value: 'install', label: 'Install prompt' },
  { value: 'popup-outcome', label: 'Pop-up outcome' },
  { value: 'return', label: 'Return-visit beacon' },
  { value: 'game-complete', label: 'Game completed' },
  { value: 'game-complete-deferred', label: 'Game completed (deferred, EU consent)' },
  { value: 'auth-status', label: 'Auth new/existing status' },
  { value: 'auth-error', label: 'Sign-in failure' },
  { value: 'auth-redirect', label: 'Sign-in redirect fallback' },
  { value: 'tour', label: 'Tutorial tour' },
  { value: 'tutorial-complete', label: 'Tutorial completed' },
  { value: 'game-first-move', label: 'First move' },
  { value: 'game-abandon', label: 'Game abandoned' },
  { value: 'welcome-signed-in', label: 'Signed-in welcome card' },
  { value: 'game-start', label: 'Game started' },
]

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
export const INSTALL_PROMPT_DISMISS = ['dismiss', 'dismiss-forever', 'have-it'] as const
// FINAL LIST outcome vocabulary + windows (Best Sudoku team, 2026-09-25) — the window is
// enforced app-side (the app decides when to fire each outcome beacon); this module only
// classifies/aggregates whatever already arrived:
//   signed-in     — within 1 day of shown
//   installed     — within 7 days of shown
//   returned      — days 1-7 after shown
//   still-playing — days 14-21 after shown (NEW)
export const POPUP_OUTCOME_TYPES = ['signed-in', 'installed', 'returned', 'still-playing'] as const

// The /popup-outcome/<popup>/<outcome> wire vocabulary (FINAL LIST) differs from the
// internal family id in two places:
//  - install: the beacon's own path segment is "install-prompt", but the family
//    everywhere else in this file (POPUPS id, classifyPopupPath's 'install' family) is
//    "install".
//  - promo-first50: BUG FOUND 2026-09-26, verified against best-sudoku origin/main
//    (src/services/popupOutcomes.ts:79-109,299 + SignInPromptDialog.vue:361). The OUTCOME
//    beacon's wire name is "first50-offer" (`/popup-outcome/first50-offer/<outcome>`), NOT
//    "promo-first50" — only the separate SHOWN/accept/dismiss beacons use the literal
//    "/promo-first50/..." path (classifyPopupPath's dedicated /promo-first50 branch above,
//    unaffected by this). Without 'first50-offer' in this map, every real outcome row for
//    the first-50 promo classified as unknown and was silently dropped. 'promo-first50' is
//    kept here too as a tolerated alias (in case any historical/test data used it as the
//    outcome name), but the name a real device actually sends is 'first50-offer'.
// This is the ONE place that reconciles wire names to family ids — every other popup's
// wire name already matches its internal id 1:1. Downstream consumers (lib/campaigns.ts,
// lib/adsRules.ts, scripts/ads-reads) all read family ids off classifyPopupPath's result
// rather than re-parsing /popup-outcome/<name> themselves, so fixing the mapping here is
// enough — nothing else hardcodes the wire name.
export const POPUP_OUTCOME_NAME_TO_FAMILY: Record<string, string> = {
  'signin-prompt': 'signin-prompt',
  'promo-first50': 'promo-first50', // tolerated alias — real beacons send 'first50-offer'
  'first50-offer': 'promo-first50',
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
  // Plain ET arithmetic (lib/etTime.ts), not Intl: this runs at module load (INSTALL_FIX_NOTE
  // and lib/adsRules.ts INSTALL_OUTCOME_GAP_NOTE). Byte-identical to the former en-US
  // { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  // parts (popupEvents.test.ts compares them).
  const et = new Date(fixedAtMs + etOffsetHours(fixedAtMs) * 3_600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `install fix went live ${et.getUTCDate()} ${SHORT_MONTHS[et.getUTCMonth()]} ${pad(et.getUTCHours())}:${pad(et.getUTCMinutes())} ET`
}
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
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

  if (path === '/auth/error' || path.startsWith('/auth/error/')) {
    const [slug] = segments(path, '/auth/error')
    if (!slug) return null
    // <slug> is open-ended (best-sudoku AUTH_ERROR_SLUGS grows over time; unmapped codes send
    // 'other') — counted whatever it is, never validated against a fixed list here.
    return { family: 'auth-error', kind: 'occurred', extra: slug }
  }

  if (path === '/auth/redirect' || path.startsWith('/auth/redirect/')) {
    const [provider] = segments(path, '/auth/redirect')
    if (!provider) return null
    return { family: 'auth-redirect', kind: 'occurred', extra: provider }
  }

  // The signed-in welcome card: shown | daily / leaderboard (the two taps, as accept with the
  // destination as extra) | dismiss. Not a POPUPS panel (no rate or outcome tracking), so the
  // pop-ups page ignores it; classified so aggregates and the ads routine read one vocabulary.
  if (path === '/welcome-signed-in' || path.startsWith('/welcome-signed-in/')) {
    const [x] = segments(path, '/welcome-signed-in')
    if (x === 'shown' || x === 'dismiss') return { family: 'welcome-signed-in', kind: x }
    if (x === 'daily' || x === 'leaderboard') return { family: 'welcome-signed-in', kind: 'accept', extra: x }
    return null
  }

  if (path === '/popup-outcome' || path.startsWith('/popup-outcome/')) {
    const [name, outcome] = segments(path, '/popup-outcome')
    // FINAL LIST: <popup> is exactly {signin-prompt, promo-first50, first50-offer, upsell,
    // install-prompt} — resolved through POPUP_OUTCOME_NAME_TO_FAMILY so 'install-prompt'
    // lands on the 'install' family, and both 'first50-offer' (the real wire name) and
    // 'promo-first50' (a tolerated alias) land on 'promo-first50' — see that constant's doc
    // comment for the 2026-09-26 first50-offer bug this fixed. first50-congrats
    // deliberately has NO outcome tracking (product decision, POPUPS[].noOutcomeTracking):
    // its rows return null here, same as any other unrecognized name, but they are still
    // counted — never silently dropped — via aggregatePopupRows' unexpectedOutcomeRows.
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
// Built on first use, not at module load: constructing an Intl formatter is the most expensive
// thing a fresh isolate does, and the gss-stats-sync Worker (10 ms CPU on Workers Free) bundles
// this module without ever calling it. Same options as before, so the output is unchanged.
let etDateFmt: Intl.DateTimeFormat | null = null
/** The America/New_York calendar date (YYYY-MM-DD) containing the given instant. */
export function etDateFromMs(ms: number): string {
  etDateFmt ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return etDateFmt.format(new Date(ms)) // en-CA formats as YYYY-MM-DD directly
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

// ── v1.95.5 go-live markers (2026-09-26T19:43:02Z — first definitely-live instant, per the
// deploy window 19:42:51-19:43:02Z) ─────────────────────────────────────────────────────
// Two new beacon families shipped together in this release: `/game/complete/<mode>/
// <difficulty>` (POPUP_EVENT_PREFIXES above) and `/auth/success/<provider>/<new|existing|
// unknown>` (fires ALONGSIDE the existing base `/auth/success/<provider>` row — see
// lib/campaigns.ts's auth-success counting, which must count the base row only; that
// beacon's own go-live constant, AUTH_NEW_EXISTING_LIVE_AT, lives in lib/adsRules.ts
// instead of here — this module is imported by the ads-sync Worker's cold-started path,
// which never touches the new/existing split, so it stays out of this file). Unlike
// TRACKING_ACTIVATION_DATE_ET/PLAY_TRACKING_ACTIVATION_DATE_ET above (an ET calendar date,
// set once the release is CONFIRMED live), this is an exact UTC instant known from the
// deploy log at hotfix time, so there's no null/"not shipped yet" state to model — it is
// live as of this file landing. Millisecond epoch (not an ET date string) because a
// go-live instant, unlike a whole-day activation date, needs sub-day precision: v1.95.5
// shipped mid-day ET, not at ET midnight.
export const GAME_COMPLETE_LIVE_AT = Date.parse('2026-09-26T19:43:02Z')
/** Chart-marker label at GAME_COMPLETE_LIVE_AT (and lib/adsRules.ts's
 * AUTH_NEW_EXISTING_LIVE_AT — the same instant): both land at the same instant, so callers
 * draw one combined marker rather than two overlapping ones. */
export const NEW_BEACONS_LIVE_MARKER_LABEL = 'game + auth breakdown live'
/** The ET calendar day GAME_COMPLETE_LIVE_AT falls on — a plain string LITERAL, not derived
 * via etDateFromMs/Intl at module load (this file is on the ads-sync Worker's cold-start
 * path — see the block comment above): kept in exact sync with GAME_COMPLETE_LIVE_AT by
 * inspection, the same way TRACKING_ACTIVATION_DATE_ET/PLAY_TRACKING_ACTIVATION_DATE_ET
 * above are literals rather than computed. Callers (e.g. lib/campaigns.ts's per-flight
 * "not instrumented" checks) compare it against a CampaignFlight's day-granularity
 * flightStart/flightEnd, the same way returnBeaconNotInstrumented compares against
 * TRACKING_ACTIVATION_DATE_ET. */
export const NEW_BEACONS_LIVE_AT_ET = '2026-09-26'

// ── Raw /install/* de-dupe marker (v1.95.6, live 2026-09-26T20:23:02Z) — ADD-only, not a
// gate: unlike GAME_COMPLETE_LIVE_AT/NEW_BEACONS_LIVE_AT_ET, nothing here excludes rows
// before this instant — it's purely an annotation on the RAW /install/* signal line
// (lib/campaigns.ts isRawInstallSignal / RAW_INSTALL_SIGNALS_LABEL), never the primary,
// already-deduplicated install count (isInstallPromptInstalled = /popup-outcome/
// install-prompt/installed), which this release doesn't touch at all. Same
// exact-instant + separate-ET-date-string pattern as GAME_COMPLETE_LIVE_AT/
// NEW_BEACONS_LIVE_AT_ET: the ms value for precision, the ET date literal for the
// timeline chart's category-axis marker position (kept in sync by inspection, same as
// NEW_BEACONS_LIVE_AT_ET's own doc comment explains).
export const RAW_INSTALL_DEDUPE_LIVE_AT_UTC_MS = Date.parse('2026-09-26T20:23:02Z')
export const RAW_INSTALL_DEDUPE_LIVE_AT_ET = '2026-09-26'
export const RAW_INSTALL_DEDUPE_MARKER_LABEL = 'raw install dedupe'
export const RAW_INSTALL_DEDUPE_NOTE =
  'raw /install/* dedupe live — duplicate cross-tab rows no longer sent; small drop expected mainly on desktop Chrome/Edge; primary install count unaffected'

// ── v1.89.0 go-live (2026-09-22, ET calendar date — best-sudoku CHANGELOG.md) ───────────────
// Two sign-in signal beacons shipped in this release: `/auth/error/<slug>` (a failed sign-in
// attempt) and `/auth/redirect/<provider>` (the popup-to-redirect fallback), both in
// POPUP_EVENT_PREFIXES above. Same release also added the base `/auth/success/<provider>` row
// (lib/campaigns.ts AUTH_SUCCESS_PATHS), which predates this file's event-beacon convention and
// is intentionally NOT gated here (see campaigns.ts's own doc comment on isAuthSuccessBase).
// A whole ET date, like TRACKING_ACTIVATION_DATE_ET — best-sudoku's changelog dates the release
// by day, not by a deploy-log instant the way GAME_COMPLETE_LIVE_AT is known to the second.
export const AUTH_ERROR_REDIRECT_LIVE_AT_ET: string | null = '2026-09-22'

// ── v1.97.0 go-live (2026-10-03T17:03:40Z, 13:03:40 ET) ─────────────────────────────────────
// Source: the Best Sudoku release owner's 2026-10-03 message: last 1.96.1 seen 17:03:37Z, first
// 1.97.0 seen 17:03:40Z, prod live check passed (a hosting-only local deploy, no backend change
// since 1.96.1). Two beacon families ship with it: the tutorial completion split
// (`/game/tutorial-complete/first-run|replay`) and the tour exit step
// (`/tour/exit-at/<preamble|hub|section>`). The same release makes the first-run tutorial win
// offer "Play a real game", which starts a counted Easy game, so first-run game completions may
// rise from this instant. Counts only: rows are never tied to a device, time or place.
export const TOUR_TRACKING_LIVE_AT = Date.parse('2026-10-03T17:03:40Z')
/** The ET calendar day TOUR_TRACKING_LIVE_AT falls on, a plain literal kept in sync with it. */
export const TOUR_TRACKING_LIVE_AT_ET = '2026-10-03'
export const TOUR_TRACKING_MARKER_LABEL = 'tutorial + tour exit beacons live'
export const TOUR_TRACKING_NOTE = 'Tutorial completions (first run vs replay) and tour exits by step went live; the first-run win now offers a counted real game.'

// ── v1.98.0 go-live (2026-10-03T20:35:04Z, 16:35:04 ET) ─────────────────────────────────────
// Source: the Best Sudoku release owner's 2026-10-03 message: last 1.97.0 response 20:35:02Z, first
// 1.98.0 response 20:35:04Z; the first-new-response instant is used, as for v1.97.0 above. (v1.97.1
// was staging-only and never reached prod.) The anonymous organic first-touch return count
// (`/return/organic/<bucket>`) goes live with it. Organic = a device's first-ever web visit with no
// utm and no ad click id (gclid etc. do not count as organic); first touch wins, a malformed utm
// counts as neither. Organic d0 and campaign d0 are disjoint populations. The same release makes
// starting a real game end the welcome tour. Counts only.
export const ORGANIC_TRACKING_LIVE_AT = Date.parse('2026-10-03T20:35:04Z')

export const TOUR_EXIT_STEPS = ['preamble', 'hub', 'section'] as const
export type TourExitStep = (typeof TOUR_EXIT_STEPS)[number]
/** The run kinds of a `/game/tutorial-complete/<kind>` row. */
export const TUTORIAL_COMPLETE_KINDS = ['first-run', 'replay'] as const
export type TutorialCompleteKind = (typeof TUTORIAL_COMPLETE_KINDS)[number]
/** A `/game/tutorial-complete/<first-run|replay>` row. */
export function isTutorialCompletePath(path: string, kind: TutorialCompleteKind): boolean {
  return path === `/game/tutorial-complete/${kind}`
}
/** A `/tour/exit-at/<group>` row, for one section group (preamble, hub or section; not a step id). */
export function isTourExitPath(path: string, step: TourExitStep): boolean {
  return path === `/tour/exit-at/${step}`
}
/** The difficulties of a `/game/start/<difficulty>` row ('unknown' when the app can't say). */
export const GAME_START_DIFFICULTIES = ['easy', 'medium', 'hard', 'expert', 'unknown'] as const
export type GameStartDifficulty = (typeof GAME_START_DIFFICULTIES)[number]
/** A `/game/start/<difficulty>` row (a counted game start), for one difficulty. */
export function isGameStartPath(path: string, difficulty: GameStartDifficulty): boolean {
  return path === `/game/start/${difficulty}`
}

/** A `/auth/error/<slug>` row (any slug). */
export function isAuthErrorPath(path: string): boolean {
  return classifyPopupPath(path)?.family === 'auth-error'
}
/** A `/auth/redirect/<provider>` row (any provider). */
export function isAuthRedirectPath(path: string): boolean {
  return classifyPopupPath(path)?.family === 'auth-redirect'
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
  // Rows under /popup-outcome/ whose <popup> name classifyPopupPath doesn't recognize —
  // first50-congrats (no outcome tracking, by product decision) or a genuinely
  // unknown/bogus name. This is deliberately NOT mapped into a family (that would invent a
  // rate for a popup that was never meant to have one — see NO_OUTCOME_TRACKING_NOTE), but
  // it is never silently dropped either: this counter surfaces that the rows exist
  // (functions/api/popups.ts includes it in `meta` when nonzero) so an operator can notice
  // an unexpected wire name arriving, the way the 2026-09-26 first50-offer bug should have
  // been caught sooner (see POPUP_OUTCOME_NAME_TO_FAMILY's doc comment).
  unexpectedOutcomeRows: number
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
  let unexpectedOutcomeRows = 0
  for (const r of rows) {
    const ev = classifyPopupPath(r.path)
    if (!ev) {
      // Never silently drop an unrecognized /popup-outcome/ row — count it as "unexpected"
      // instead (see PopupAggregate.unexpectedOutcomeRows).
      if (r.path === '/popup-outcome' || r.path.startsWith('/popup-outcome/')) unexpectedOutcomeRows += r.count
      continue
    }
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
  return { coarse, detailed, byDay, measuredCoarse, measuredDetailed, installPostFix, unexpectedOutcomeRows }
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

// ── Derived dimensions popupFamily / popupOutcome (functions/api/geo.ts) ────────────────
// Two generic geo dimensions so ANY chart (e.g. the breakdown bar on the Pop-ups page) can put
// pop-ups on one axis and what happened to them on another, over the ordinary filtered geo
// query path instead of a bespoke pop-up panel:
//   popupFamily  — which pop-up: signin-prompt | promo-first50 | first50-congrats | upsell |
//                  install. An outcome beacon resolves through POPUP_OUTCOME_NAME_TO_FAMILY,
//                  so /popup-outcome/first50-offer/<o> lands on promo-first50.
//   popupOutcome — what the row records: the SHOWN row counts as outcome 'shown', then
//                  'accept' / 'dismiss', the /popup-outcome/ types (POPUP_OUTCOME_TYPES), and
//                  install's raw signals (INSTALL_OUTCOMES, e.g. 'pwa-installed').
// Both are MEASURED values only, the same rows aggregatePopupRows' `measuredCoarse` counts:
// a row before TRACKING_ACTIVATION_DATE_ET (ET midnight) or a pre-fix install-gap row
// (INSTALL_GAP_PATHS before INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS) gets NO value (''), and
// neither does anything that isn't a pop-up row (page views, /signin-eligible, install's
// platform list, an unknown outcome name). geo.ts drops blank rows for these dims.
//
// The canonical classifier is classifyPopupPath; popupFamilyOf/popupOutcomeOf below are thin
// JS readings of it, and popupDimSqlCase is its SQL twin for the exact wire vocabulary (checked
// row-for-row against classifyPopupPath in derivedDims.sql.test.ts on a real SQLite engine).
//
// WHY LITERALS, NOT `?` PARAMETERS: every value in these CASE expressions comes from this
// module's own constants, never from a request (geo.ts's GEO_DIMS whitelist decides which
// expression runs; a filter VALUE compared against one is always bound). Binding each literal
// would cost ~50 parameters per expression, and a 2-dim chart evaluates two of them in SELECT
// plus a blank test in WHERE — past D1's 100-bound-parameter cap per query. Each literal goes
// through sqlLit, which refuses anything outside a plain path/label alphabet (no quotes), so a
// future constant can't break out of the string even by accident.
const SQL_LIT_RE = /^[A-Za-z0-9 _%./()+-]*$/
/** A constant as a SQL string literal. Throws on anything outside SQL_LIT_RE (never quotes). */
export function sqlLit(value: string): string {
  if (!SQL_LIT_RE.test(value)) throw new Error(`unsafe SQL literal: ${JSON.stringify(value)}`)
  return `'${value}'`
}
/** A constant as a SQL integer literal (timestamps, lengths). Throws on a non-integer. */
export function sqlInt(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error(`unsafe SQL integer: ${value}`)
  return value
}
const sqlList = (values: readonly string[]) => values.map(sqlLit).join(', ')
/** SQL twins of classifyPopupPath's own parsing: a family prefix P matches `path = P` or a
 * path starting `P/` (case-sensitive — LIKE would not be); the rest is split into segments the
 * way `segments()` does, IGNORING empty segments (runs of slashes, a trailing slash) and
 * anything past the segments a rule reads. So `/signin-prompt/accept/`, `/install/prompt/
 * android/` and `/popup-outcome/upsell/signed-in/extra` classify exactly as the JS does. */
export function pathSegmentsSql(prefix: string): { match: string; s1: string; s2: string } {
  const n = sqlInt(prefix.length)
  const match = `(path = ${sqlLit(prefix)} OR substr(path, 1, ${n + 1}) = ${sqlLit(prefix + '/')})`
  // Collapse slash runs (5 passes: runs up to 32) and trim the ends, leaving 'a/b/c'.
  let rest = `substr(path, ${n + 2})`
  for (let i = 0; i < 5; i++) rest = `replace(${rest}, '//', '/')`
  const r = `trim(${rest}, '/')`
  const s1 = `(CASE WHEN instr(${r}, '/') > 0 THEN substr(${r}, 1, instr(${r}, '/') - 1) ELSE ${r} END)`
  const tail = `substr(${r}, instr(${r}, '/') + 1)`
  const s2 = `(CASE WHEN instr(${r}, '/') = 0 THEN '' WHEN instr(${tail}, '/') > 0 THEN substr(${tail}, 1, instr(${tail}, '/') - 1) ELSE ${tail} END)`
  return { match, s1, s2 }
}

/** UTC ms of ET midnight starting TRACKING_ACTIVATION_DATE_ET — the instant from which
 * aggregatePopupRows counts a row as measured (its ET day is on/after the activation date).
 * null while activation is unset: every row is unmeasured. */
export function trackingActivationStartMs(activationDateEt: string | null = TRACKING_ACTIVATION_DATE_ET): number | null {
  return activationDateEt === null ? null : etWallTimeMs(activationDateEt)
}

/** Measurement gate as a SQL condition: TRUE for rows that must get no value (pre-activation,
 * or a pre-fix install-gap row). Mirrors aggregatePopupRows' measured* skip rules. */
function popupUnmeasuredSql(): string {
  const act = trackingActivationStartMs()
  const fix = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS
  const preAct = act === null ? '1 = 1' : `ts < ${sqlInt(act)}`
  const gap = fix === null ? `path IN (${sqlList(INSTALL_GAP_PATHS)})` : `(path IN (${sqlList(INSTALL_GAP_PATHS)}) AND ts < ${sqlInt(fix)})`
  return `(${preAct} OR ${gap})`
}

/** `CASE <expr> WHEN k THEN v ... ELSE E END` over literal pairs (expr is evaluated once). */
function caseMap(expr: string, pairs: [string, string][], empty: string): string {
  return `CASE ${expr} ${pairs.map(([k, v]) => `WHEN ${sqlLit(k)} THEN ${sqlLit(v)}`).join(' ')} ELSE ${empty} END`
}
const same = (xs: readonly string[]): [string, string][] => xs.map((x) => [x, x])

/** SQL CASE expression for the popupFamily / popupOutcome derived dimension; `emptyLabel` is
 * what a non-pop-up or unmeasured row gets (geo.ts passes '' so its blank test drops them).
 * One branch per classifyPopupPath family, in its order, each reading the path's segments with
 * pathSegmentsSql exactly as the classifier reads them. */
export function popupDimSqlCase(dim: 'popupFamily' | 'popupOutcome', emptyLabel: string): string {
  const E = sqlLit(emptyLabel)
  const fam = dim === 'popupFamily'
  const branch: string[] = []
  // /signin-prompt/<x>: accept | dismiss | anything else non-empty = shown (x = reason).
  {
    const g = pathSegmentsSql('/signin-prompt')
    branch.push(`WHEN ${g.match} THEN ${fam ? `CASE WHEN ${g.s1} = '' THEN ${E} ELSE 'signin-prompt' END` : `CASE ${g.s1} WHEN '' THEN ${E} WHEN 'accept' THEN 'accept' WHEN 'dismiss' THEN 'dismiss' ELSE 'shown' END`}`)
  }
  // /promo-first50/<shown|accept|dismiss>
  {
    const g = pathSegmentsSql('/promo-first50')
    const kinds = ['shown', 'accept', 'dismiss']
    branch.push(`WHEN ${g.match} THEN ${caseMap(g.s1, fam ? kinds.map((k) => [k, 'promo-first50']) : same(kinds), E)}`)
  }
  // /first50-congrats/<shown|ack|close> = shown | accept | dismiss
  {
    const g = pathSegmentsSql('/first50-congrats')
    const map: [string, string][] = [['shown', 'shown'], ['ack', 'accept'], ['close', 'dismiss']]
    branch.push(`WHEN ${g.match} THEN ${caseMap(g.s1, fam ? map.map(([k]) => [k, 'first50-congrats']) : map, E)}`)
  }
  // /upsell/<shown|accept|dismiss>/<reason> — the reason segment is required.
  {
    const g = pathSegmentsSql('/upsell')
    const kinds = ['shown', 'accept', 'dismiss']
    branch.push(`WHEN ${g.match} THEN CASE WHEN ${g.s2} = '' THEN ${E} ELSE ${caseMap(g.s1, fam ? kinds.map((k) => [k, 'upsell']) : same(kinds), E)} END`)
  }
  // /install/...: prompt/<platform> shown, prompt/<dismiss kind> dismiss, platforms/* no value,
  // play | pwa-accept | app-store accept, pwa-decline dismiss, INSTALL_OUTCOMES raw outcomes.
  {
    const g = pathSegmentsSql('/install')
    const prompt: [string, string][] = [...INSTALL_SHOWN_PLATFORMS.map((p): [string, string] => [p, 'shown']), ...INSTALL_PROMPT_DISMISS.map((d): [string, string] => [d, 'dismiss'])]
    const direct: [string, string][] = [['play', 'accept'], ['pwa-accept', 'accept'], ['app-store', 'accept'], ['pwa-decline', 'dismiss'], ...same(INSTALL_OUTCOMES)]
    const promptCase = caseMap(g.s2, fam ? prompt.map(([k]) => [k, 'install']) : prompt, E)
    const directPairs = fam ? direct.map(([k]): [string, string] => [k, 'install']) : direct
    branch.push(`WHEN ${g.match} THEN CASE ${g.s1} WHEN 'prompt' THEN ${promptCase} ${directPairs.map(([k, v]) => `WHEN ${sqlLit(k)} THEN ${sqlLit(v)}`).join(' ')} ELSE ${E} END`)
  }
  // /popup-outcome/<name>/<outcome>: <name> through POPUP_OUTCOME_NAME_TO_FAMILY (first50-offer →
  // promo-first50, install-prompt → install), <outcome> one of POPUP_OUTCOME_TYPES.
  {
    const g = pathSegmentsSql('/popup-outcome')
    const names = Object.keys(POPUP_OUTCOME_NAME_TO_FAMILY)
    const value = fam
      ? caseMap(g.s1, names.map((n): [string, string] => [n, POPUP_OUTCOME_NAME_TO_FAMILY[n]]), E)
      : `CASE WHEN ${g.s1} IN (${sqlList(names)}) THEN ${caseMap(g.s2, same(POPUP_OUTCOME_TYPES), E)} ELSE ${E} END`
    branch.push(fam ? `WHEN ${g.match} THEN CASE WHEN ${g.s2} IN (${sqlList(POPUP_OUTCOME_TYPES)}) THEN ${value} ELSE ${E} END` : `WHEN ${g.match} THEN ${value}`)
  }
  return `CASE WHEN ${popupUnmeasuredSql()} THEN ${E} ${branch.join(' ')} ELSE ${E} END`
}

/** The SQL prefilter a popupFamily/popupOutcome query adds (bound, cheap): only pop-up event
 * rows can ever carry a value. Replaces geo.ts's standing event-beacon exclusion for such a
 * chart, which would otherwise remove every row these dimensions describe. */
export function popupDimPrefilter(w: string[], b: unknown[]): void {
  const inc = popupIncludeClause()
  w.push(inc.sql)
  b.push(...inc.binds)
}

function measuredPopupEvent(path: string, tsMs: number): PopupEvent | null {
  const act = trackingActivationStartMs()
  if (act === null || tsMs < act) return null
  if (isInstallGapUnmeasured(path, tsMs)) return null
  return classifyPopupPath(path)
}
const POPUP_FAMILY_IDS = new Set(['signin-prompt', 'promo-first50', 'first50-congrats', 'upsell', 'install'])
/** JS reading of the popupFamily dimension, from classifyPopupPath ('' = no value). */
export function popupFamilyOf(path: string, tsMs: number): string {
  const ev = measuredPopupEvent(path, tsMs)
  if (!ev || ev.kind === 'platformList') return ''
  const fam = ev.family.startsWith('popup-outcome:') ? ev.family.slice('popup-outcome:'.length) : ev.family
  return POPUP_FAMILY_IDS.has(fam) ? fam : ''
}
/** JS reading of the popupOutcome dimension, from classifyPopupPath ('' = no value). */
export function popupOutcomeOf(path: string, tsMs: number): string {
  if (!popupFamilyOf(path, tsMs)) return ''
  const ev = classifyPopupPath(path)!
  if (ev.family === 'install' && ev.kind === 'outcome') return ev.extra ?? ''
  return ev.kind
}

// Display order + labels for the two dimensions' values (lib/charts.ts formatKey / series
// order): the pop-ups in POPUPS order; shown first, then taps, then outcomes, then install's
// raw signals.
export const POPUP_FAMILY_ORDER: string[] = POPUPS.map((p) => p.id)
export const POPUP_OUTCOME_ORDER: string[] = ['shown', 'accept', 'dismiss', ...POPUP_OUTCOME_TYPES, ...INSTALL_OUTCOMES]
export const POPUP_OUTCOME_LABELS: Record<string, string> = {
  shown: 'Shown',
  accept: 'Tapped / accepted',
  dismiss: 'Dismissed',
  'signed-in': 'Signed in',
  installed: 'Installed',
  returned: 'Returned',
  'still-playing': 'Still playing',
  'pwa-installed': 'PWA installed (raw)',
  'standalone-detected': 'Standalone detected (raw)',
  'play-detected': 'Play detected (raw)',
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

// ── The Pop-ups page's rate table: VALID ratios only (the rate-validity rule: a percentage
// only where the numerator is a declared subset of the denominator, same unit, same
// instrumented window). That leaves exactly: each pop-up's taps (accepts) over
// its showings, and the install prompt's "installed" outcome over post-fix showings (the
// denominator counted from INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS on — see computePopupRate).
// Everything else on the page is a count. A test pins this list, so a new key can't slip in.
export const POPUP_RATE_TABLE_KEYS: string[] = [...POPUPS.map((p) => `${p.id}:tap`), INSTALL_GAP_RATE_KEY]

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
