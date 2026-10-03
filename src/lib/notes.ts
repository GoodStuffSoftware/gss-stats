// The notes/text registry (owner requirement, 2026-09-26): every caveat, definition, and
// explanatory paragraph the dashboard shows lives here, ONE place, instead of scattered
// literal strings/constants across App.vue and the widget bodies. A note is rendered
// through NoteBlock.vue (short, single-line caveats) or TextBlock.vue (longer, possibly
// multi-paragraph prose) — never hand-written markup — via lib/textLite.ts's safe
// tokenizer (no v-html anywhere).
//
// Design:
//  - id: stable key, referenced by widget.noteId (the 'note' widget type) or widget.notes
//    (an attached-caption list on any other widget).
//  - text: a string, or a function for text that depends on live config (e.g. Play
//    tracking's activation date) — always called fresh, never cached.
//  - kind: 'note' (short caveat — NoteBlock's default styling) or 'text' (longer prose —
//    TextBlock's default styling); either component can still render either kind, this is
//    just which one a bare `noteId` picks by default in ChartEditor's "Add chart" flow.
//    'label' (ADR 0003): a short, single-line UI label — a metric/funnel-step name, a unit
//    word, a status word. Never a scope default and never offered as a caption (see
//    defaultNoteIdsForScope / noteOptions), so the caption pickers don't fill up with labels.
//  - severity: cosmetic only (info/caveat/warning) — never changes what data means.
//  - scopes: which dataset/view combinations this note is a DEFAULT for (see
//    defaultNoteIdsForScope) — a widget can still opt into/out of any note regardless of
//    scope via its own `notes` list.
//  - activeWhen: optional gate (e.g. only while a tracking date is still null) — an
//    inactive note is simply not returned by defaultNoteIdsForScope/isNoteActive.
//  - vars: optional default template vars (see lib/textLite.ts tokenizeAndInterpolate) — a
//    caller can still pass its own vars to override/extend at render time (see
//    NoteBlock/TextBlock, which call noteTokens — never noteRawText, which is plain-text
//    only; see that function's own doc comment).
import {
  SMALL_SAMPLE_NOTE,
  POPUP_PAGE_NOTE,
  SIGNIN_ELIGIBLE_CAVEAT,
  NO_OUTCOME_TRACKING_NOTE,
  PLAY_TRACKING_ROLLOUT_CAVEAT,
  PLAY_TRACKING_NOT_LIVE_NOTE,
  PLAY_TRACKING_MARKER_LABEL,
  playTrackingStatusNote,
  PLAY_TRACKING_ACTIVATION_DATE_ET,
  TRACKING_ACTIVATION_DATE_ET,
  MIN_COHORT,
  INSTALL_FIX_NOTE,
} from './popupEvents'
import { ARRIVALS_CAVEAT, RAW_INSTALL_SIGNALS_LABEL, type FunnelStepKey } from './campaigns'
import { tokenizeAndInterpolate, toPlainText } from './textLite'
// Read-only: notes.ts is dashboard-only (never bundled into the ads-sync Worker, unlike
// lib/popupEvents.ts — see that file's own comment on why it keeps AUTH_NEW_EXISTING_LIVE_AT
// out of itself), so importing the constant from lib/adsRules.ts here is fine.
import { AUTH_NEW_EXISTING_LIVE_AT } from './adsRules'
import { etOffsetHours } from './etTime'

// "counted from 2026-09-26 15:43 ET" — AUTH_NEW_EXISTING_LIVE_AT's own ET wall time, for the
// new/existing/unknown sign-up tiles' partial-window note (lib/metrics/metrics.ts
// AUTH_NEW_EXISTING rule) — a range reaching back before this go-live must read "counted from
// ..." instead of a false zero (A2, review round 2026-09-27). Plain ET arithmetic
// (etOffsetHours), the same non-Intl approach lib/popupEvents.ts installFixMarkerLabel uses for
// the same reason: cheap at module load, computed once, not a live function (the instant is a
// fixed historical constant, same as INSTALL_FIX_NOTE just below).
function formatCountedFromEt(atMs: number | null): string {
  if (atMs === null) return ''
  const et = new Date(atMs + etOffsetHours(atMs) * 3_600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `counted from ${et.getUTCFullYear()}-${pad(et.getUTCMonth() + 1)}-${pad(et.getUTCDate())} ${pad(et.getUTCHours())}:${pad(et.getUTCMinutes())} ET`
}
const AUTH_NEW_EXISTING_COUNTED_FROM_NOTE = formatCountedFromEt(AUTH_NEW_EXISTING_LIVE_AT)

export type NoteSeverity = 'info' | 'caveat' | 'warning'
export type NoteKind = 'note' | 'text' | 'label'
// Which dataset/view combinations a note is a scope-default for — see
// defaultNoteIdsForScope. Deliberately coarse (dataset-level, not one tag per view): most
// notes apply to a whole page's worth of widgets, not one chart specifically.
export type NoteScope = 'overview' | 'campaigns' | 'popup' | 'geo' | 'rum' | 'ads-readings'

export interface NoteDef {
  id: string
  text: string | (() => string)
  kind: NoteKind
  severity: NoteSeverity
  /** Empty for a 'label' (labels are never scope defaults). */
  scopes: NoteScope[]
  activeWhen?: () => boolean
  vars?: Record<string, string | number>
}

function resolveText(n: NoteDef): string {
  return typeof n.text === 'function' ? n.text() : n.text
}

// A null-prototype object (review finding #1): an id such as 'constructor', 'toString' or
// '__proto__' is simply not a note, never an inherited Object member. Look ids up with getNote /
// hasNote (Object.hasOwn), never with `in`.
export const NOTES_REGISTRY: Record<string, NoteDef> = Object.assign(Object.create(null) as Record<string, NoteDef>, {
  'small-sample': {
    id: 'small-sample',
    text: SMALL_SAMPLE_NOTE,
    kind: 'note',
    severity: 'caveat',
    scopes: ['popup', 'overview', 'campaigns'],
  },
  'popup-deferred-signin': {
    id: 'popup-deferred-signin',
    text: POPUP_PAGE_NOTE,
    kind: 'note',
    severity: 'caveat',
    scopes: ['popup'],
  },
  'signin-eligible-caveat': {
    id: 'signin-eligible-caveat',
    text: SIGNIN_ELIGIBLE_CAVEAT,
    kind: 'note',
    severity: 'caveat',
    scopes: ['popup'],
  },
  'no-outcome-tracking': {
    id: 'no-outcome-tracking',
    text: NO_OUTCOME_TRACKING_NOTE,
    kind: 'note',
    severity: 'info',
    scopes: ['popup'],
  },
  'play-tracking-status': {
    id: 'play-tracking-status',
    // Dynamic: reflects PLAY_TRACKING_ACTIVATION_DATE_ET at render time, same as the old
    // inline `{{ playTrackingStatusNote() }}` call — never cached/stale. The "Android/Play:"
    // prefix used to be hard-coded in the .vue template (delta review, 2026-09-26) — it's
    // part of the registry text now, same as everything else this note carries.
    text: () => `Android/Play: ${PLAY_TRACKING_ACTIVATION_DATE_ET ? `${PLAY_TRACKING_MARKER_LABEL} ` : ''}${playTrackingStatusNote()}`,
    kind: 'note',
    severity: 'caveat',
    scopes: ['campaigns'],
  },
  'play-tracking-not-live': {
    id: 'play-tracking-not-live',
    text: PLAY_TRACKING_NOT_LIVE_NOTE,
    kind: 'note',
    severity: 'caveat',
    scopes: ['campaigns'],
    activeWhen: () => PLAY_TRACKING_ACTIVATION_DATE_ET === null,
  },
  'tracking-not-yet-active': {
    id: 'tracking-not-yet-active',
    text: 'Tracking not yet active — numbers before release are not a baseline.',
    kind: 'note',
    severity: 'warning',
    scopes: ['popup'],
    activeWhen: () => TRACKING_ACTIVATION_DATE_ET === null,
  },
  'arrivals-caveat': {
    id: 'arrivals-caveat',
    text: ARRIVALS_CAVEAT,
    kind: 'note',
    severity: 'caveat',
    scopes: ['campaigns', 'overview'],
  },
  'min-cohort-caveat': {
    id: 'min-cohort-caveat',
    // Data-driven value templated in, not baked into the string (owner requirement) — see
    // lib/textLite.ts interpolate.
    text: 'Rates need at least {minCohort} in their denominator, or they show "too few to report".',
    kind: 'note',
    severity: 'caveat',
    scopes: ['campaigns', 'popup'],
    vars: { minCohort: MIN_COHORT },
  },
  'not-instrumented': {
    id: 'not-instrumented',
    text: 'not instrumented',
    kind: 'note',
    severity: 'info',
    scopes: ['campaigns', 'popup'],
  },
  'too-few-to-report': {
    id: 'too-few-to-report',
    text: 'too few to report',
    kind: 'note',
    severity: 'info',
    scopes: ['campaigns', 'popup', 'overview'],
  },
  // Shown on a page opened by drilling into an event-family 'pathFamily' value (e.g.
  // 'install') — see lib/drill.ts drillNeedsEventBeacons, App.vue openFilteredPage. Explains
  // why every chart on this page includes rows every OTHER page excludes by default.
  'event-family-drill': {
    id: 'event-family-drill',
    text: 'This filtered view includes pop-up/install/return/game-complete/auth-status event beacons — every other page excludes them by default, but you drilled into one, so this page carries "Include event beacons" for every chart.',
    kind: 'note',
    severity: 'info',
    scopes: ['geo'],
  },
  // ── Longer prose (kind: 'text') — definitions, "how to read this" captions, section
  // intros. Converted from hard-coded <p>/lede markup in the (now-retired) bespoke pages
  // and the current widget bodies — see the conversion notes in this branch's final report
  // for what was deliberately left inline instead (live API data formatting, not boilerplate
  // copy). ──────────────────────────────────────────────────────────────────────────────
  'campaigns-attribution-scope': {
    id: 'campaigns-attribution-scope',
    text: 'Attribution is by **campaign tag** only — no device/location/timestamp correlation across rows. Funnel steps are counted within tagged sessions. Verification and household traffic are excluded server-side.',
    kind: 'text',
    severity: 'info',
    scopes: ['campaigns'],
  },
  'tagged-arrival-definition': {
    id: 'tagged-arrival-definition',
    text: 'A **tagged hit** is any row carrying a campaign tag — the tag rides every beacon for its 30-minute TTL, so one ad click produces many tagged rows. A **tagged arrival** is specifically a device’s first-ever beacon while tagged: the funnel’s "arrivals" step, cost-per-arrival, and the hour-of-day/flight-day charts all use tagged arrivals, never the raw tagged-hit count.',
    kind: 'text',
    severity: 'info',
    scopes: ['campaigns', 'overview'],
  },
  'spend-source': {
    id: 'spend-source',
    // v0.4.0: spend comes from the ads-read routine's own store (Google Ads API) first,
    // falling back to the hand-entered CAMPAIGN_SPEND (lib/campaigns.ts) only for a
    // campaign with nothing stored yet — each campaign's own "Source" row above says which.
    text: 'Spend comes from the Google Ads API as stored by the ads-read routine; a campaign with nothing stored yet falls back to the hand-entered spend figures.',
    kind: 'note',
    severity: 'info',
    scopes: ['campaigns'],
  },
  'flight-day-caption': {
    id: 'flight-day-caption',
    text: 'Left: arrivals per flight day. Right: cumulative arrivals per flight day (dashed).',
    kind: 'note',
    severity: 'info',
    scopes: ['campaigns'],
  },
  'return-rate-caption': {
    id: 'return-rate-caption',
    text: 'Rate per bucket = bucket count / d0 (first tagged load).',
    kind: 'note',
    severity: 'info',
    scopes: ['campaigns'],
  },
  'return-shared-tag': {
    id: 'return-shared-tag',
    text: 'Shares its tag with another flight — not separable by return beacon.',
    kind: 'note',
    severity: 'caveat',
    scopes: ['campaigns'],
  },
  'overview-timeline-caption': {
    id: 'overview-timeline-caption',
    text: 'Shaded bands = campaign flights. Dashed labelled lines = major releases and go-live moments. Short ticks = other releases. Every marker and band is listed under the chart.',
    kind: 'note',
    severity: 'info',
    scopes: ['overview'],
  },
  'raw-install-dedupe': {
    id: 'raw-install-dedupe',
    // Plain wording for the screen (RAW_INSTALL_DEDUPE_NOTE, with its raw path, stays the ads
    // routine's report text).
    text: 'Raw install signals: duplicate rows from several open tabs stopped being sent (v1.95.6), so expect a small drop, mainly on desktop Chrome and Edge. The main install count is unaffected.',
    kind: 'note',
    severity: 'info',
    scopes: ['overview'],
  },
  // The "Return visits (day 1+)" KPI tile (lib/metrics/presets.ts bsk-kpis): what it counts.
  'returns-d1plus-caveat': {
    id: 'returns-d1plus-caveat',
    text: 'Devices that first arrived through a tagged campaign link and came back on day 1 or later. Each device counts at most once per return window (day 1, days 2-7, 8-14, 15-30, 31-60), so one device can count once in each window.',
    kind: 'note',
    severity: 'info',
    scopes: ['overview'],
  },
  // The "Raw install signals" KPI tile: why it is secondary to the install count.
  'raw-install-double-count': {
    id: 'raw-install-double-count',
    text: 'Can double-count: one install can send more than one raw signal.',
    kind: 'note',
    severity: 'info',
    scopes: ['overview'],
  },
  // Caption for the Pop-ups page's breakdown bar (and any chart on the pop-up dimensions):
  // what the counts include. Plain wording, no code paths.
  'popup-bars-measured': {
    id: 'popup-bars-measured',
    text: 'Counts start the day pop-up tracking went live. Installs before the install fix are not counted. First-50 congrats has no outcome tracking.',
    kind: 'note',
    severity: 'info',
    scopes: ['popup'],
  },
  // Caption for the campaign device-mix doughnut: the population is tagged hits, not people
  // (a heavy user weighs more — shares of rows, not of devices).
  'device-mix-population': {
    id: 'device-mix-population',
    text: 'Shares of **tagged hits** (every beacon a tagged visit sent), not of people: a heavy user weighs more.',
    kind: 'note',
    severity: 'info',
    scopes: ['campaigns'],
  },
  // The release panel (lib/metrics/presets.ts release-before-after): why the before window reads
  // low. Plain wording, as the panel's own line had it.
  // The campaign-country card (lib/metrics/presets.ts CAMPAIGN_COUNTRY): the counts-only rule
  // (lib/splitGuard.ts) gives return and completion rows no country bucket.
  'country-split-excludes-refused': {
    id: 'country-split-excludes-refused',
    text: 'Counts only: the country columns leave out return and completion rows (game starts, completions, tutorial completions, tour exits), so completed games have no row here and an arrival that came in on one of them is in no column.',
    kind: 'note',
    severity: 'info',
    scopes: ['campaigns'],
  },
  'release-before-partial': {
    id: 'release-before-partial',
    text: 'before = partially instrumented — auth success, install, and campaign tagging are new paths this release adds; the "before" window predates them.',
    kind: 'note',
    severity: 'caveat',
    scopes: ['overview'],
  },
  'no-return-visits-yet': {
    id: 'no-return-visits-yet',
    text: 'No return visits recorded yet.',
    kind: 'note',
    severity: 'info',
    scopes: ['campaigns'],
  },
  // ── Labels (kind 'label', ADR 0003) — short single-line UI names. `label.<metricId>` names a
  // metric; `label.funnel.<step>` names a legacy funnel step that has no metric of its own. ──
  ...labels({
    // `/game` rows are PAGE VIEWS (any visitor, many per device), not games played — ADR 0003
    // rate audit, rows 1-2. One name for the site-wide KPI and the campaign funnel step.
    'label.bsk.gameViews': 'Game-screen views',
    'label.campaign.gameViews': 'Game-screen views',
    // The organic baseline arm's name (lib/campaigns.ts ORGANIC_ARM_ID): untagged fresh installs
    // on the web site only, never the installed app.
    'label.arm.organic': 'Organic (web)',
    'label.funnel.arrivals': 'Arrivals',
    'label.funnel.completed': 'Completed a game',
    'label.funnel.ask': 'Sign-in ask',
    'label.funnel.accept': 'Accept',
    'label.funnel.authSuccess': 'Auth success',
    'label.funnel.installPrompt': 'Install prompt',
    // Range-specific install-fix caveats travel with the value instead (the install metric's
    // install-fix note, in a card's Notes).
    'label.funnel.install': 'Install',

    // Metrics (lib/metrics/metrics.ts) — one `label.<metricId>` each.
    'label.campaign.taggedHits': 'Tagged hits',
    'label.campaign.taggedArrivals': 'Tagged arrivals',
    'label.campaign.completions': 'Completed games',
    'label.campaign.asks': 'Sign-in asks',
    'label.campaign.accepts': 'Sign-in accepts',
    'label.campaign.signedInAfterAsk': 'Signed in after ask',
    'label.campaign.authSuccess': 'Auth successes',
    'label.campaign.installPrompts': 'Install prompts',
    'label.campaign.installs': 'Installs',
    'label.campaign.rawInstallSignals': RAW_INSTALL_SIGNALS_LABEL,
    'label.campaign.returnD0': 'First tagged loads (d0)',
    'label.campaign.returnD1': 'Came back on day 1',
    'label.campaign.returnD2to7': 'Came back on days 2-7',
    'label.campaign.returnD8to14': 'Came back on days 8-14',
    'label.campaign.returnD15to30': 'Came back on days 15-30',
    'label.campaign.returnD31to60': 'Came back on days 31-60',
    'label.campaign.spend': 'Spend',
    'label.bsk.pageviews': 'Page views',
    'label.bsk.completions': 'Games completed',
    'label.bsk.popupShown': 'Pop-ups shown',
    'label.bsk.popupAccepts': 'Pop-ups accepted',
    'label.bsk.authSuccess': 'Auth successes',
    // The new/existing/unknown split that rides alongside every base auth-success row (A2,
    // review round 2026-09-27 — see lib/metrics/metrics.ts AUTH_NEW_EXISTING). "New" is the
    // exact sign-up count the ad flight is judged on.
    'label.bsk.authSuccessNew': 'Auth successes — new',
    'label.bsk.authSuccessExisting': 'Auth successes — existing',
    'label.bsk.authSuccessUnknown': 'Auth successes — unknown',
    'label.bsk.authErrors': 'Sign-in failures',
    'label.bsk.authRedirects': 'Sign-in redirect fallbacks',
    'label.bsk.tutorialFirstRun': 'Tutorial completed — first run',
    'label.bsk.tutorialReplay': 'Tutorial completed — replay',
    'label.bsk.tourExitPreamble': 'Tour exits — preamble',
    'label.bsk.tourExitHub': 'Tour exits — hub',
    'label.bsk.tourExitSection': 'Tour exits — section',
    'label.bsk.installs': 'Installs',
    // Short and plain, as the Overview tile reads; the caveat is 'raw-install-double-count'.
    'label.bsk.rawInstallSignals': 'Raw install signals',
    // What the /return/ d1+ beacons count; the caveat lives in 'returns-d1plus-caveat'.
    'label.bsk.returnsD1plus': 'Return visits (day 1+)',
    'label.popup.shown': 'Shown',
    'label.popup.accepts': 'Accepted',
    'label.popup.outcomeSignedIn': 'Signed in',
    'label.popup.outcomeInstalled': 'Installed',
    'label.popup.outcomeReturned': 'Returned',
    'label.popup.outcomeStillPlaying': 'Still playing',
    'label.popup.eligibleEarned': 'Eligible finishes (earned)',
    'label.popup.eligibleFinishes': 'Signed-out finishes',
    'label.popup.eligibleCapped': 'Capped',
    'label.popup.eligibleUnearned': 'Unearned',
    'label.bsk.taggedArrivals': 'Tagged arrivals',
    'label.release.windowDays': 'Days on each side',
    'label.campaign.upsellShown': 'Shown',
    'label.campaign.upsellAccepts': 'Accepted',
    'label.campaign.upsellDismisses': 'Dismissed',
    'label.campaign.spendSource': 'Source',
    'label.campaign.spendThrough': 'Spend through',
    'label.campaign.lastSync': 'Synced',

    // Ratios (lib/metrics/ratios.ts).
    'label.campaign.acceptPerAsk': 'Accept rate',
    'label.campaign.signedInPerAsk': 'Signed in after ask',
    'label.campaign.installPerPrompt': 'Install rate',
    'label.campaign.returnD1PerD0': 'Return rate (d1)',
    'label.campaign.returnD2to7PerD0': 'Return rate (d2-7)',
    'label.campaign.returnD8to14PerD0': 'Return rate (d8-14)',
    'label.campaign.returnD15to30PerD0': 'Return rate (d15-30)',
    'label.campaign.returnD31to60PerD0': 'Return rate (d31-60)',
    'label.campaign.costPerArrival': 'Cost / arrival',
    'label.campaign.costPerSignin': 'Cost / sign-in',
    'label.campaign.gameViewsVsArrivals': 'Game-screen views vs arrivals',
    'label.campaign.taggedHitsVsArrivals': 'Tagged hits vs arrivals',
    'label.bsk.popupTapRate': 'Pop-up tap rate',
    'label.popup.tapRate': 'Tap rate',
    'label.popup.signedInRate': 'Signed-in rate',
    'label.popup.installedRate': 'Installed rate',
    'label.popup.returnedRate': 'Returned rate',
    'label.popup.stillPlayingRate': 'Still-playing rate',
    'label.popup.eligibility': 'Sign-in eligibility rate',

    // Unit words (lib/metrics/units.ts unitLabelId, MetricDef.unitLabel) — the "counts"
    // display reads "1,111 views · 353 arrivals".
    'unit.device': 'devices',
    'unit.row': 'rows',
    'unit.pageview': 'views',
    'unit.completion': 'completions',
    'unit.showing': 'showings',
    'unit.signin': 'sign-ins',
    'unit.finish': 'finishes',
    'unit.usd': 'USD',
    'unit.day': 'days',
    'unit.arrivals': 'arrivals',
    'unit.instant': 'time',
    'unit.hits': 'hits',
    'unit.code': 'kind',

    // Status words and gating messages (MetricValue.status / noteIds).
    'flight-pending': 'pending — start date not yet confirmed',
    'no-campaign-flighting': 'no campaign flighting today',
    'not-yet-tracking': 'not yet tracking',
    'still-arriving': 'still arriving',
    'counted-from': 'counted from {from}',
    'install-fix-note': INSTALL_FIX_NOTE,
    // Time-precise (unlike the generic 'counted-from' {date} template above): the new/existing/
    // unknown sign-up split's own go-live is known to the second (lib/adsRules.ts
    // AUTH_NEW_EXISTING_LIVE_AT, the deploy-log instant), so its note carries the ET clock time
    // the same way lib/popupEvents.ts INSTALL_FIX_NOTE does for the install fix.
    'auth-new-existing-note': AUTH_NEW_EXISTING_COUNTED_FROM_NOTE,
    'new-today': 'new today',
    'no-comparison-yet': 'no comparison yet (first day partial)',
    'metric-unavailable': 'unavailable',
    'not-started': 'not started',
    'no-tracked-campaign-flighting': 'no beacon-tracked campaign flighting today',
    'release-pending': 'no release window yet',
    'spend-source.ads-api': 'Ads API',
    'spend-source.config': 'hand-entered',
    'ads-stale': 'stale — sync pending',
    'no-spend-day-yet': 'no closed spend day stored yet',
    'not-synced-yet': 'not synced yet',

    // Card labels that are not a metric's own name (lib/metrics/presets.ts).
    'label.card.flight': 'Flight',
    'label.card.taggedArrivalsFor': 'Tagged arrivals — {campaign}',
    'label.card.updatedJustNow': 'Updated just now',
    'label.card.updatedSecondsAgo': 'Updated {n}s ago',
    'label.card.updatedMinutesAgo': 'Updated {n}m ago',
    'label.card.refresh': 'Refresh',
    'label.card.notes': 'Notes',
    'label.card.loadFailed': 'Some numbers could not be loaded.',
    'label.card.retry': 'Retry',
    'label.card.invalid': "This card's saved settings could not be read, so it can't be shown. Edit it or restore the default charts.",
    'label.card.openCampaigns': 'Open the Campaigns page',
    'label.card.release': 'Release',
    'label.card.retiredPanel': 'This panel has been replaced by a card or a chart. Edit it, or restore the default charts.',
    'label.card.step': 'Step',
    'label.card.returnTag': 'Return beacons',
    'label.card.return.d1': 'd1',
    'label.card.return.d2-7': 'd2-7',
    'label.card.return.d8-14': 'd8-14',
    'label.card.return.d15-30': 'd15-30',
    'label.card.return.d31-60': 'd31-60',
    'label.card.acceptOfAsks': 'Accept of asks',
    'label.card.installOfPrompts': 'Install of prompts shown post-fix',
    'label.card.upsellSegment': '▼ Signed-out upsell fix at {at} (flight day {day}) — a funnel segment boundary: read the two sides as separate short tests.',
    'label.card.taggedUpsell': 'Tagged upsell',
    'label.card.shown': 'Shown',
    'label.card.accepted': 'Accepted',
    'label.card.dismissed': 'Dismissed',
    'label.card.perArrival': 'Per arrival',
    'label.card.perAuthSuccess': 'Per auth success',
    'label.card.popupTapRate': '{popup} — tap rate (accept / shown)',
    'label.card.installedRateFromFix': 'Install prompt — installed rate (from the install fix on)',
    'label.card.popupOutcomeSignedIn': '{popup} — signed in',
    'label.card.popupOutcomeReturned': '{popup} — returned',
    'label.card.popupOutcomeStillPlaying': '{popup} — still playing',
    'label.card.eligible.earned': 'earned',
    'label.card.eligible.capped': 'capped',
    'label.card.eligible.unearned': 'unearned',
    'release-none': 'No dated release yet. This panel fills in once a release has a date.',

    // Preset names + one-line descriptions for CardEditor's "Start from" picker
    // (lib/metrics/editorModel.ts presetOptions) — never the raw preset id (review fix,
    // 2026-09-27: it was showing an auto-title-cased id, e.g. "Bsk Kpis").
    'label.preset.campaign-scorecard': 'Campaign scorecard',
    'label.preset.campaign-scorecard.description': 'One card per campaign: flight dates, arrivals, auth successes, installs, return rate, cost, and the funnel pills.',
    'label.preset.bsk-kpis': 'Today at a glance (KPI tiles)',
    'label.preset.bsk-kpis.description': 'Site-wide KPI tiles for today so far, each compared with yesterday and the 7-day average.',
    'label.preset.release-before-after': 'Release before/after',
    'label.preset.popup-rates': 'Pop-up rates (valid ratios only)',
    'label.preset.popup-rates.description': 'Each pop-up\'s tap rate, and the install prompt\'s installed rate from the install fix on, each with its counts.',
    'label.preset.signin-eligibility': 'Sign-in eligibility',
    'label.preset.signin-eligibility.description': 'Signed-out finishes that earned a sign-in ask, hit the cap, or did not earn one, and the eligibility rate.',
    'label.preset.campaign-funnel': 'Funnel per campaign',
    'label.preset.campaign-funnel.description': 'One card per beacon-tracked campaign: every funnel step as a bar, the valid accept and install rates, and the upsell-fix segments once that fix ships.',
    'label.preset.campaign-returns': 'Return visits',
    'label.preset.campaign-returns.description': 'One card per campaign with return beacons: first tagged loads (d0) and each later window\'s return rate, left to right.',
    'label.preset.campaign-country': 'Arrivals and funnel by country',
    'label.preset.campaign-country.description': 'One card per beacon-tracked campaign: each funnel step split into US, CA and every other country.',
    'label.preset.campaign-cost': 'Campaign cost',
    'label.preset.campaign-cost.description': 'One card per campaign: spend, where it came from and how fresh it is, and the cost per arrival and per auth success.',
    'label.preset.release-before-after.description': 'The newest release with a full day after it: page views, tagged arrivals, auth successes and installs over the same number of days before and after it.',
  }),
})

function labels(entries: Record<string, string>): Record<string, NoteDef> {
  return Object.fromEntries(Object.entries(entries).map(([id, text]) => [id, { id, text, kind: 'label' as const, severity: 'info' as const, scopes: [] }]))
}

/** The registry label for each legacy funnel step (the campaigns funnel/country views and the
 * overview scorecard chips). 'played' is the campaign game-screen-views metric's own label. */
export const FUNNEL_STEP_LABEL_IDS: Record<FunnelStepKey, string> = {
  arrivals: 'label.funnel.arrivals',
  played: 'label.campaign.gameViews',
  completed: 'label.funnel.completed',
  ask: 'label.funnel.ask',
  accept: 'label.funnel.accept',
  authSuccess: 'label.funnel.authSuccess',
  installPrompt: 'label.funnel.installPrompt',
  install: 'label.funnel.install',
}
export function funnelStepLabel(step: FunnelStepKey): string {
  return noteRawText(FUNNEL_STEP_LABEL_IDS[step])
}

/** Whether `id` is a registry entry (an own key — never an inherited Object member). */
export function hasNote(id: string): boolean {
  return typeof id === 'string' && Object.hasOwn(NOTES_REGISTRY, id)
}

export function getNote(id: string): NoteDef | undefined {
  return hasNote(id) ? NOTES_REGISTRY[id] : undefined
}

/** The note's RAW template text — no tokenizing, no interpolation. Only needed for
 * paragraph-splitting a longer note BEFORE tokenizing each paragraph separately (see
 * TextBlock.vue, which needs paragraph boundaries from the untouched template); every other
 * caller should use noteTokens (safe markup) or noteRawText (safe plain text) instead. */
export function noteTemplate(id: string): string {
  const n = getNote(id)
  return n ? resolveText(n) : ''
}

/** The note's markup, tokenized + interpolated the SAFE way (template tokenized first, vars
 * substituted only into text tokens — see lib/textLite.ts tokenizeAndInterpolate) — render
 * these through NoteBlock.vue/TextBlock.vue (or any <template v-for> over bold/link/text),
 * never by joining them back into a string and re-parsing. */
export function noteTokens(id: string, vars?: Record<string, string | number>): import('./textLite').TextToken[] {
  const n = getNote(id)
  if (!n) return []
  return tokenizeAndInterpolate(resolveText(n), { ...n.vars, ...vars })
}

/** PLAIN-TEXT rendering only (delta review, 2026-09-26) — for call sites that can't render
 * tokens: a `:title` attribute, a bare `{{ }}` interpolation, a table cell. Never returns
 * raw bold/link markup syntax as literal on-screen text — a bold segment keeps only its
 * text, a link keeps only its visible label. If you're about to write
 * `{{ noteRawText(...) }}` inside markup-capable markup (a <p>, a caption area), use
 * <NoteBlock>/<TextBlock> instead so bold/link markup actually renders as such. */
export function noteRawText(id: string, vars?: Record<string, string | number>): string {
  const n = getNote(id)
  if (!n) return ''
  return toPlainText(resolveText(n), { ...n.vars, ...vars })
}

export function isNoteActive(id: string): boolean {
  const n = getNote(id)
  if (!n) return false
  return !n.activeWhen || n.activeWhen()
}

/** Every registry note that DEFAULTS on for a given dataset scope and is currently active —
 * used to seed a widget's attached-caption list (widget.notes) when unset. A widget's OWN
 * `notes` array, once set, always wins over this (see components/widgets bodies /
 * ChartEditor.vue) — this is only the fallback. */
export function defaultNoteIdsForScope(scope: NoteScope): string[] {
  return Object.values(NOTES_REGISTRY)
    .filter((n) => n.kind !== 'label' && n.scopes.includes(scope) && isNoteActive(n.id))
    .map((n) => n.id)
}

/** Options for a "pick a note" dropdown (ChartEditor) — id + a short preview of its text.
 * Captions only: 'label' entries are UI names, never offered as a caption. */
export function noteOptions(): { value: string; label: string }[] {
  return Object.values(NOTES_REGISTRY)
    .filter((n) => n.kind !== 'label')
    .map((n) => {
      // Plain text, as rendered: markup stripped and {vars} filled in (not the raw template).
      const t = noteRawText(n.id)
      return { value: n.id, label: t.length > 64 ? t.slice(0, 61) + '…' : t }
    })
}

/** Resolve which registry note ids a chart widget's attached captions should show — pulled
 * out of ChartCard.vue as a pure function so the per-widget-override rule is unit-testable
 * without mounting a component. Rules (see ChartCard.vue's own comment for the reasoning):
 *  - a 'note' widget never gets captions (a note captioning another note is redundant);
 *  - an EXPLICIT `widget.notes` (even []) always wins, whatever it is;
 *  - otherwise: NO captions. This is the "migration default" for a widget saved before this
 *    feature existed (widget.notes is absent/undefined on it) — it renders exactly as it
 *    did before, never gaining a caption it never had just because the registry now HAS
 *    scope defaults. Scope defaults (defaultNoteIdsForScope) are only ever used to PRE-FILL
 *    `notes` when a widget is first created or edited (see lib/defaults.ts's widget
 *    builders and ChartEditor.vue) — never injected here at render time. */
export function widgetCaptionNoteIds(widget: { type: string; notes?: string[] }): string[] {
  if (widget.type === 'note') return []
  return widget.notes ?? []
}
