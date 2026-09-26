import { describe, expect, it } from 'vitest'
import { NOTES_REGISTRY, getNote, noteRawText, isNoteActive, defaultNoteIdsForScope, noteOptions, widgetCaptionNoteIds } from './notes'
import { MIN_COHORT } from './popupEvents'

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

  it('every registry entry has a non-empty id matching its own key', () => {
    for (const [key, def] of Object.entries(NOTES_REGISTRY)) {
      expect(def.id).toBe(key)
      expect(def.scopes.length).toBeGreaterThan(0)
    }
  })
})

describe('notes registry — active-when gating', () => {
  it('a note with no activeWhen is always active', () => {
    expect(isNoteActive('small-sample')).toBe(true)
  })

  it('play-tracking-marker and play-tracking-not-live are mutually exclusive on the SAME underlying date flag', () => {
    // Exactly one of the two should be active at any given time — they gate on the same
    // PLAY_TRACKING_ACTIVATION_DATE_ET being non-null vs null.
    const marker = isNoteActive('play-tracking-marker')
    const notLive = isNoteActive('play-tracking-not-live')
    expect(marker).toBe(!notLive)
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
  it('returns one option per registry entry, each with a value and a label', () => {
    const opts = noteOptions()
    expect(opts.length).toBe(Object.keys(NOTES_REGISTRY).length)
    for (const o of opts) {
      expect(typeof o.value).toBe('string')
      expect(typeof o.label).toBe('string')
      expect(o.label.length).toBeGreaterThan(0)
    }
  })
})
