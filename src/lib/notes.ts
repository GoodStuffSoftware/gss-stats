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
  RAW_INSTALL_DEDUPE_NOTE,
} from './popupEvents'
import { ARRIVALS_CAVEAT, type FunnelStepKey } from './campaigns'
import { tokenizeAndInterpolate, toPlainText } from './textLite'

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

export const NOTES_REGISTRY: Record<string, NoteDef> = {
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
    text: 'Attribution is by **campaign tag** only ([see lib/campaigns.ts](https://github.com/GoodStuffSoftware/gss-stats/blob/main/src/lib/campaigns.ts)) — no device/location/timestamp correlation across rows. Funnel steps are counted within tagged sessions. Verification and household traffic are excluded server-side.',
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
    text: 'Spend comes from the Google Ads API as stored by the ads-read routine; a campaign with nothing stored falls back to the hand-entered CAMPAIGN_SPEND (lib/campaigns.ts).',
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
    text: 'Shaded bands = campaign flights. Dashed labeled lines = major releases / tracking-activation. Short ticks = other releases (see `lib/releases.ts` for versions).',
    kind: 'note',
    severity: 'info',
    scopes: ['overview'],
  },
  'raw-install-dedupe': {
    id: 'raw-install-dedupe',
    text: RAW_INSTALL_DEDUPE_NOTE,
    kind: 'note',
    severity: 'info',
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
    'label.funnel.arrivals': 'Arrivals',
    'label.funnel.completed': 'Completed a game',
    'label.funnel.ask': 'Sign-in ask',
    'label.funnel.accept': 'Accept',
    'label.funnel.authSuccess': 'Auth success',
    'label.funnel.installPrompt': 'Install prompt',
    // Range-specific install-fix caveats travel with the data instead (functions/api/campaigns.ts
    // funnel.installNote, from lib/popupEvents.ts installOutcomeGapNote).
    'label.funnel.install': 'Install',
  }),
}

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

export function getNote(id: string): NoteDef | undefined {
  return NOTES_REGISTRY[id]
}

/** The note's RAW template text — no tokenizing, no interpolation. Only needed for
 * paragraph-splitting a longer note BEFORE tokenizing each paragraph separately (see
 * TextBlock.vue, which needs paragraph boundaries from the untouched template); every other
 * caller should use noteTokens (safe markup) or noteRawText (safe plain text) instead. */
export function noteTemplate(id: string): string {
  const n = NOTES_REGISTRY[id]
  return n ? resolveText(n) : ''
}

/** The note's markup, tokenized + interpolated the SAFE way (template tokenized first, vars
 * substituted only into text tokens — see lib/textLite.ts tokenizeAndInterpolate) — render
 * these through NoteBlock.vue/TextBlock.vue (or any <template v-for> over bold/link/text),
 * never by joining them back into a string and re-parsing. */
export function noteTokens(id: string, vars?: Record<string, string | number>): import('./textLite').TextToken[] {
  const n = NOTES_REGISTRY[id]
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
  const n = NOTES_REGISTRY[id]
  if (!n) return ''
  return toPlainText(resolveText(n), { ...n.vars, ...vars })
}

export function isNoteActive(id: string): boolean {
  const n = NOTES_REGISTRY[id]
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
      const t = resolveText(n)
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
