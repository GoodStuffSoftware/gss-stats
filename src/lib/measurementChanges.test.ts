// The measurement-change marker (lib/measurementChanges.ts): while its date is null nothing shows
// anywhere; once set it shows on the timeline, under the tagged new-account cards and in the read
// reports. Each wiring is tested in both states.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MEASUREMENT_CHANGES,
  markedChanges,
  measurementNoteOn,
  measurementNoteSince,
  measurementReportLines,
} from './measurementChanges'
import { RELEASES, datedReleases } from './releases'
import { autoCaveatIds, cardShowsAuthSuccess, defaultNoteIdsForScope, getNote, isNoteActive, noteRawText } from './notes'
import { allChartNotes } from './chartNotes'
import { releaseItems } from './timelineOverlay'
import type { Widget } from '../types'

const change = MEASUREMENT_CHANGES[0]
const SHIPPED_DATE = change.dateEt
const PLAY_ENTRY = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.2 Play')!
const PLAY_ENTRY_DATE = PLAY_ENTRY.dateEt
const V1993_WEB = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.3 web')!
const V1993_WEB_DATE = V1993_WEB.dateEt
const V1993_PLAY = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.3 Play')!
const V1993_PLAY_DATE = V1993_PLAY.dateEt
// The web-entry tests below run with the live Play date and the coach-only v1.99.3 web date blanked; the Play describe sets its own dates.
beforeEach(() => {
  PLAY_ENTRY.dateEt = null
  V1993_WEB.dateEt = null
  V1993_PLAY.dateEt = null
})
const NOTE_ID = 'measurement-change-note'
const DAY = '2099-01-10' // after every real release, so the timeline order test stays true

afterEach(() => {
  change.dateEt = SHIPPED_DATE
  PLAY_ENTRY.dateEt = PLAY_ENTRY_DATE
  V1993_WEB.dateEt = V1993_WEB_DATE
  V1993_PLAY.dateEt = V1993_PLAY_DATE
})

const widget = (over: Partial<Widget> = {}): Widget => ({
  id: 'w1',
  i: 'w1',
  title: 't',
  type: 'table',
  dataset: 'campaigns',
  dimension: '',
  metric: 'pageviews',
  limit: 1,
  x: 0,
  y: 0,
  w: 4,
  h: 3,
  ...over,
})

describe('the marker config', () => {
  it('is v1.99.2, dated to its web go-live day', () => {
    expect(change.id).toBe('v1.99.2')
    expect(SHIPPED_DATE).toBe('2026-10-16')
  })
})

describe('while the date is null, nothing shows', () => {
  it('no marked change, no note on or since any day, no report line', () => {
    change.dateEt = null
    expect(markedChanges()).toEqual([])
    expect(measurementNoteOn(DAY)).toBeNull()
    expect(measurementNoteSince(DAY)).toBeNull()
    expect(measurementReportLines(DAY)).toEqual([])
  })

  it('the timeline has no marker for it', () => {
    change.dateEt = null
    expect(RELEASES.some((r) => r.version === change.id)).toBe(true) // listed, undated
    expect(datedReleases().some((r) => r.version === change.id)).toBe(false)
    expect(releaseItems().some((m) => m.label === change.id)).toBe(false)
  })

  it('the card caveat is inactive and shows under no card', () => {
    change.dateEt = null
    expect(isNoteActive(NOTE_ID)).toBe(false)
    expect(defaultNoteIdsForScope('campaigns')).not.toContain(NOTE_ID)
    expect(defaultNoteIdsForScope('overview')).not.toContain(NOTE_ID)
    for (const preset of ['campaign-scorecard', 'campaign-funnel', 'bsk-kpis']) {
      expect(autoCaveatIds(widget({ card: { preset } })), preset).not.toContain(NOTE_ID)
    }
  })
})

describe('once the date is set', () => {
  it('lists the change, and the notes read on the day and after it', () => {
    change.dateEt = DAY
    expect(markedChanges().map((c) => c.id)).toEqual([change.id])
    expect(measurementNoteOn(DAY)).toContain(change.note)
    expect(measurementNoteOn('2099-01-11')).toBeNull()
    expect(measurementNoteSince(DAY)).toBeNull() // the day itself is "on", not "since"
    expect(measurementNoteSince('2099-01-11')).toContain(DAY)
    expect(measurementNoteSince('2099-01-09')).toBeNull()
  })

  it('report lines: nothing before, a marker on the day, a since line after', () => {
    change.dateEt = DAY
    expect(measurementReportLines('2099-01-09')).toEqual([])
    expect(measurementReportLines(DAY)).toEqual([expect.stringMatching(/^MEASUREMENT CHANGE TODAY, v1\.99\.2: /)])
    expect(measurementReportLines('2099-01-12')).toEqual([expect.stringMatching(/^Measurement change since 2099-01-10, v1\.99\.2: /)])
  })

  it('the timeline marks it on that day, labelled with the version', () => {
    change.dateEt = DAY
    expect(datedReleases().find((r) => r.version === change.id)).toMatchObject({ dateEt: DAY, note: change.note })
    expect(releaseItems().some((m) => m.label === change.id && m.date === DAY)).toBe(true)
  })

  it('the caveat is active, names the day and tells the reader not to read the rise as performance', () => {
    change.dateEt = DAY
    expect(isNoteActive(NOTE_ID)).toBe(true)
    expect(getNote(NOTE_ID)!.hideable).toBe(false)
    const text = noteRawText(NOTE_ID)
    expect(text).toContain(DAY)
    expect(text).toContain(change.id)
    expect(text).toMatch(/not read the rise as performance/)
  })

  it('shows under the tagged auth-success and new-account cards only', () => {
    change.dateEt = DAY
    for (const preset of ['campaign-scorecard', 'campaign-funnel', 'campaign-returns']) {
      const w = widget({ card: { preset } })
      expect(autoCaveatIds(w).includes(NOTE_ID), preset).toBe(cardShowsAuthSuccess(w.card))
    }
    expect(cardShowsAuthSuccess({ preset: 'campaign-scorecard' })).toBe(true)
    expect(cardShowsAuthSuccess({ preset: 'campaign-funnel' })).toBe(true)
    expect(autoCaveatIds(widget({ dataset: 'overview', card: { preset: 'bsk-kpis' } }))).toContain(NOTE_ID)
    // the Flight 3 daily card lists new accounts, so it carries the note; the Cost card names its own caption instead
    expect(cardShowsAuthSuccess({ preset: 'campaign-f3-daily' })).toBe(true)
    expect(autoCaveatIds(widget({ card: { preset: 'campaign-f3-daily' } }))).toContain(NOTE_ID)
    expect(cardShowsAuthSuccess({ preset: 'campaign-cost' })).toBe(false)
    expect(autoCaveatIds(widget({ card: { preset: 'campaign-cost' } }))).not.toContain(NOTE_ID)
    // a plain chart, a note widget, an unknown preset and a stored spec with junk in it show none
    expect(autoCaveatIds(widget({ type: 'line' }))).not.toContain(NOTE_ID)
    expect(autoCaveatIds(widget({ type: 'note', noteId: 'arrivals-caveat' }))).not.toContain(NOTE_ID)
    expect(cardShowsAuthSuccess({ preset: 'no-such-preset' })).toBe(false)
    expect(cardShowsAuthSuccess(undefined)).toBe(false)
    expect(cardShowsAuthSuccess({ spec: { v: 1, sections: [null, { layout: 'rows', items: [null, { id: 'x' }] }] } } as unknown as Widget['card'])).toBe(false)
  })

  it('a viewer cannot hide it, and it reaches the chart notes under the card', () => {
    change.dateEt = DAY
    const w = widget({ card: { preset: 'campaign-scorecard' }, hiddenCaveats: [NOTE_ID] })
    expect(autoCaveatIds(w)).toContain(NOTE_ID)
    expect(allChartNotes(w, null, null).some((n) => JSON.stringify(n).includes(NOTE_ID))).toBe(true)
  })
})

describe('the Play release of v1.99.2 (second entry, own date)', () => {
  const play = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.2 Play')!
  const PLAY_SHIPPED = play.dateEt
  const WEB_DAY = '2099-01-10'
  const PLAY_DAY = '2099-01-14'
  afterEach(() => {
    play.dateEt = PLAY_SHIPPED
  })

  it('is listed after the web entry and is dated 2026-10-17 (committed 22:49 ET 10-16)', () => {
    expect(MEASUREMENT_CHANGES[1]).toBe(play)
    expect(play.id).toBe('v1.99.2 Play')
    expect(play.note).toMatch(/^Play release of v1\.99\.2: Apps-arm installs get the new app, with the sign-in ask-order A\/B and the auth first-touch fallback, and the Play install referrer carries the campaign into the first sign-in\./)
    expect(play.note).toContain("Committed 22:49 ET 10-16; reaches users when Google's review clears")
    expect(PLAY_SHIPPED).toBe('2026-10-17')
    expect(play.coachOnly).toBeUndefined()
  })

  it('while undated it shows nowhere, even with the web entry dated', () => {
    play.dateEt = null
    change.dateEt = WEB_DAY
    expect(markedChanges().map((c) => c.id)).toEqual([change.id])
    expect(datedReleases().some((r) => r.version === play.id)).toBe(false)
    expect(releaseItems().some((m) => m.label === play.id)).toBe(false)
    expect(measurementReportLines('2099-01-20').join('\n')).not.toContain(play.id)
    expect(noteRawText(NOTE_ID)).not.toContain(play.id)
  })

  it('once dated it is on the timeline, in the report and in the generic caveat under the tagged cards', () => {
    play.dateEt = PLAY_DAY
    change.dateEt = null
    expect(markedChanges().map((c) => c.id)).toEqual([play.id]) // the web entry is still undated
    expect(datedReleases().find((r) => r.version === play.id)).toMatchObject({ dateEt: PLAY_DAY, note: play.note })
    expect(releaseItems().some((m) => m.label === play.id && m.date === PLAY_DAY)).toBe(true)
    expect(measurementReportLines(PLAY_DAY)).toEqual([`MEASUREMENT CHANGE TODAY, ${play.id}: ${play.note}`])
    expect(measurementReportLines('2099-01-20')).toEqual([`Measurement change since ${PLAY_DAY}, ${play.id}: ${play.note}`])
    expect(isNoteActive(NOTE_ID)).toBe(true)
    expect(noteRawText(NOTE_ID)).toContain(`From ${PLAY_DAY} (${play.id}): ${play.note}.`)
    const w = widget({ card: { preset: 'campaign-scorecard' } })
    expect(autoCaveatIds(w)).toContain(NOTE_ID)
  })

  it('both dated: both listed oldest first, the caveat names both days, one "do not read" line', () => {
    change.dateEt = WEB_DAY
    play.dateEt = PLAY_DAY
    expect(markedChanges().map((c) => c.id)).toEqual([change.id, play.id])
    expect(measurementReportLines('2099-01-20')).toHaveLength(2)
    const text = noteRawText(NOTE_ID)
    expect(text).toContain(`From ${WEB_DAY} (${change.id})`)
    expect(text).toContain(`From ${PLAY_DAY} (${play.id})`)
    expect(text.match(/not read the rise as performance/g)).toHaveLength(1)
  })
})

describe('v1.99.3 Play caption', () => {
  it('says it was public on Play 06:34Z 10-17, keeps the coach mixed-semantics sentence', () => {
    expect(V1993_PLAY.note).toContain('Public on Play 06:34Z 10-17.')
    expect(V1993_PLAY.note).toContain('Android coach rows after this are a mix of old and new semantics until updates spread')
  })
})
