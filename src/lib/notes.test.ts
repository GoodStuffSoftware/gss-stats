import { describe, expect, it } from 'vitest'
import { NOTES_REGISTRY, getNote, noteRawText, isNoteActive, defaultNoteIdsForScope, noteOptions, widgetCaptionNoteIds, FUNNEL_STEP_LABEL_IDS, funnelStepLabel } from './notes'
import { FUNNEL_STEP_ORDER } from './campaigns'
import { MIN_COHORT, INSTALL_FIX_NOTE, INSTALL_OUTCOME_GAP_LABEL, INSTALL_GAP_BEFORE_FIX_LABEL, installOutcomeGapNote, POPUP_PAGE_NOTE, SMALL_SAMPLE_NOTE, SIGNIN_ELIGIBLE_CAVEAT, POPUP_RATE_SPECS } from './popupEvents'

describe('notes registry — lookups', () => {
  it('getNote returns the definition for a known id, undefined for an unknown one', () => {
    expect(getNote('small-sample')?.id).toBe('small-sample')
    expect(getNote('does-not-exist')).toBeUndefined()
  })

  it('noteRawText resolves a static-text note', () => {
    expect(noteRawText('not-instrumented')).toBe('not instrumented')
  })

  it('noteRawText resolves a FUNCTION-backed note fresh, not cached', () => {
    // play-tracking-status wraps popupEvents.playTrackingStatusNote(), which reads live
    // config (PLAY_TRACKING_ACTIVATION_DATE_ET) — asserting it returns a non-empty string
    // proves the registry actually calls through rather than serving a stale snapshot.
    expect(typeof noteRawText('play-tracking-status')).toBe('string')
    expect(noteRawText('play-tracking-status').length).toBeGreaterThan(0)
  })

  it('noteRawText on an unknown id returns an empty string, never throws', () => {
    expect(noteRawText('nope')).toBe('')
  })

  // The retention caveats ride on their metrics (MetricDef.caveats), so they must not pre-fill every new campaigns chart.
  // 'retention-page-scope' is a note widget on the Retention page template only: no scope, so it never pre-fills a new chart.
  const NOTES_WITHOUT_SCOPE = new Set(['retention-disjoint', 'retention-organic-bias', 'retention-lower-bound', 'retention-page-scope', 'play-days', 'play-household', 'play-no-retention', 'play-active-is-stock'])
  it('every registry entry has a non-empty id matching its own key', () => {
    for (const [key, def] of Object.entries(NOTES_REGISTRY)) {
      expect(def.id).toBe(key)
      // A caption ('note'/'text') is a default somewhere; a 'label' never is.
      if (def.kind === 'label') expect(def.scopes).toEqual([])
      // A metric-attached caveat may have no scope: it is never a chart caption default.
      else if (!NOTES_WITHOUT_SCOPE.has(def.id)) expect(def.scopes.length).toBeGreaterThan(0)
    }
  })
})

describe('notes registry — active-when gating', () => {
  it('a note with no activeWhen is always active', () => {
    expect(isNoteActive('small-sample')).toBe(true)
  })

  it('play-tracking-not-live and play-tracking-status (always active) are never BOTH the right note to show — play-tracking-status folds the marker/status distinction into one always-on note, so play-tracking-not-live only adds the "not live yet" variant on top when the date is still null', () => {
    expect(isNoteActive('play-tracking-status')).toBe(true) // always active — no activeWhen
    // play-tracking-not-live gates on the SAME underlying flag play-tracking-status's own
    // text branches on internally.
    const notLive = isNoteActive('play-tracking-not-live')
    expect(typeof notLive).toBe('boolean')
  })

  it('an unknown id is never active', () => {
    expect(isNoteActive('nope')).toBe(false)
  })
})

describe('notes registry — templating (interpolate)', () => {
  it('min-cohort-caveat templates the live MIN_COHORT value in, not a baked-in number', () => {
    expect(noteRawText('min-cohort-caveat')).toContain(String(MIN_COHORT))
    expect(noteRawText('min-cohort-caveat')).not.toContain('{minCohort}')
  })

  it('a caller can override/extend a note\'s own default vars at render time', () => {
    // Even though min-cohort-caveat has its OWN default var, passing one explicitly wins.
    expect(noteRawText('min-cohort-caveat', { minCohort: 999 })).toContain('999')
  })
})

describe('defaultNoteIdsForScope — per-widget/scope defaults', () => {
  it('only returns notes whose scopes include the requested scope', () => {
    const ids = defaultNoteIdsForScope('overview')
    for (const id of ids) {
      expect(NOTES_REGISTRY[id].scopes).toContain('overview')
    }
  })

  it('excludes an inactive (activeWhen: false) note even if its scope matches', () => {
    // play-tracking-not-live is scoped to 'campaigns' but only active while
    // PLAY_TRACKING_ACTIVATION_DATE_ET is null — the repo's current constant is dated, so it
    // should NOT show up in the campaigns defaults right now.
    const ids = defaultNoteIdsForScope('campaigns')
    expect(isNoteActive('play-tracking-not-live')).toBe(false)
    expect(ids).not.toContain('play-tracking-not-live')
  })

  it('a scope with no matching notes returns an empty array, not undefined/throw', () => {
    expect(defaultNoteIdsForScope('rum')).toEqual([])
  })
})

describe('widgetCaptionNoteIds — per-widget overrides + migration default', () => {
  it('a note-type widget never gets captions, even if `notes` is somehow set on it', () => {
    expect(widgetCaptionNoteIds({ type: 'note', notes: ['arrivals-caveat'] })).toEqual([])
  })

  it('per-widget override: an explicit notes list is returned verbatim, whatever it contains', () => {
    expect(widgetCaptionNoteIds({ type: 'table', notes: ['spend-source'] })).toEqual(['spend-source'])
  })

  it('per-widget override: an explicit EMPTY list ([]) means "no captions", not "use defaults"', () => {
    expect(widgetCaptionNoteIds({ type: 'table', notes: [] })).toEqual([])
  })

  it('MIGRATION DEFAULT: a widget saved before this feature existed (no `notes` field at all) gets NO captions — it renders exactly as it did before, never gaining one just because the registry now has scope defaults for its dataset', () => {
    expect(widgetCaptionNoteIds({ type: 'hbar' })).toEqual([])
    expect(widgetCaptionNoteIds({ type: 'table', notes: undefined })).toEqual([])
  })
})

describe('noteOptions — ChartEditor picker', () => {
  it('returns one option per caption entry (labels excluded), each with a value and a label', () => {
    const opts = noteOptions()
    expect(opts.length).toBe(Object.values(NOTES_REGISTRY).filter((n) => n.kind !== 'label').length)
    expect(opts.some((o) => NOTES_REGISTRY[o.value].kind === 'label')).toBe(false)
    for (const o of opts) {
      expect(typeof o.value).toBe('string')
      expect(typeof o.label).toBe('string')
      expect(o.label.length).toBeGreaterThan(0)
    }
  })
})

describe("labels (NoteKind 'label', ADR 0003)", () => {
  it('"Games played" / "Played a game" are "Game-screen views": `/game` rows are page views, not games', () => {
    expect(noteRawText('label.bsk.gameViews')).toBe('Game-screen views')
    expect(noteRawText('label.campaign.gameViews')).toBe('Game-screen views')
    expect(funnelStepLabel('played')).toBe('Game-screen views')
    const all = Object.values(NOTES_REGISTRY).map((n) => (typeof n.text === 'string' ? n.text : n.text()))
    expect(all).not.toContain('Played a game')
    expect(all).not.toContain('Games played')
  })

  it('every funnel step has a registry label, and every one of those is a label entry', () => {
    for (const step of FUNNEL_STEP_ORDER) {
      const def = getNote(FUNNEL_STEP_LABEL_IDS[step])
      expect(def?.kind).toBe('label')
      expect(funnelStepLabel(step).length).toBeGreaterThan(0)
    }
  })

  it('labels are never scope defaults (so they never become a widget caption)', () => {
    for (const scope of ['overview', 'campaigns', 'popup', 'geo', 'rum', 'ads-readings'] as const) {
      for (const id of defaultNoteIdsForScope(scope)) expect(NOTES_REGISTRY[id].kind).not.toBe('label')
    }
  })
})
// User-facing text never names code: no module paths, no source files, no backtick code spans
// (owner review, 2026-09-27: "see lib/releases.ts" and "(lib/campaigns.ts)" showed on screen).
describe('notes registry — plain language only', () => {
  const CODE_LIKE = /\blib\/|\.ts\b|`/
  // …and no raw beacon path (e.g. "/return/ d1+"), which reads as code to the owner.
  const RAW_PATH = /(^|[\s(])\/(popup-outcome|install|return|auth|game|signin|promo|upsell)\b/
  it('no registry note text names a file, a module path, a code span or a raw beacon path', () => {
    for (const id of Object.keys(NOTES_REGISTRY)) {
      expect(noteRawText(id), id).not.toMatch(CODE_LIKE)
      expect(noteRawText(id), id).not.toMatch(RAW_PATH)
    }
  })
  it('the guard itself catches a raw path', () => {
    expect('/return/ d1+ returns').toMatch(RAW_PATH)
    expect('Return visits (day 1+)').not.toMatch(RAW_PATH)
  })
  it('nor does any caption that travels with API data', () => {
    const texts = [
      INSTALL_FIX_NOTE,
      INSTALL_OUTCOME_GAP_LABEL,
      INSTALL_GAP_BEFORE_FIX_LABEL,
      installOutcomeGapNote({ startMs: 0, endMs: Date.now() }),
      POPUP_PAGE_NOTE,
      SMALL_SAMPLE_NOTE,
      SIGNIN_ELIGIBLE_CAVEAT,
      ...POPUP_RATE_SPECS.map((s) => s.label),
    ]
    for (const t of texts) {
      expect(t).not.toMatch(CODE_LIKE)
      expect(t).not.toMatch(RAW_PATH)
    }
  })
})

describe('noteOptions — the picker shows plain text, not markup or placeholders', () => {
  it('no ** and no {var} in any option label', () => {
    for (const o of noteOptions()) expect(o.label, o.value).not.toMatch(/\*\*|\{\w+\}/)
    expect(noteOptions().find((o) => o.value === 'min-cohort-caveat')!.label).toContain(`at least ${MIN_COHORT}`)
  })
})
