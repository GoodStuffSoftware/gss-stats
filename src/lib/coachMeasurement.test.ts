// The v1.99.3 coach meaning-change entries (lib/measurementChanges.ts): the web one is dated
// 2026-10-17 (live 05:58:55Z); the Play one ships undated. The coach readouts get the note and nothing else does.
import { afterEach, describe, expect, it } from 'vitest'
import { MEASUREMENT_CHANGES, authMarkedChanges, coachMeasurementNote, markedChanges, measurementReportLines } from './measurementChanges'
import { noteRawText } from './notes'

const web = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.3 web')!
const play = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.3 Play')!
const WEB_DATE = web.dateEt
afterEach(() => {
  web.dateEt = WEB_DATE
  play.dateEt = null
})

describe('v1.99.3 coach entries', () => {
  it('the web entry is dated 2026-10-17, the Play one is undated, and both name the coach change', () => {
    expect(web.dateEt).toBe('2026-10-17')
    expect(play.dateEt).toBeNull()
    expect(web.note).toContain('×')
    expect(play.note).toContain('×')
    expect(play.coachOnly).toBe(true) // coach semantics only: no Play-install caveat on it
    expect(play.note).not.toContain('Apps-arm installs')
  })
  it('the web note carries the no-beacon coach fact, the flight-3 caption fact and the other changes', () => {
    expect(web.coachOnly).toBe(true)
    expect(web.note).toContain('NO beacon')
    expect(web.note).toContain('notes-tip completions are not counted')
    expect(web.note).toContain('before the first flight-3 serve')
    expect(web.note).toContain('mix v1.99.1, v1.99.2 and v1.99.3')
    expect(web.note).toContain('reset/duplicate')
    expect(web.note).toContain('pop-ups')
    expect(web.note).toContain('email verification')
  })
  it('the coach readouts start the web note on 2026-10-17 and not the day before', () => {
    expect(coachMeasurementNote('2026-10-16')).toBeNull()
    expect(coachMeasurementNote('2026-10-17')).toContain('v1.99.3 web (from 2026-10-17)')
    expect(coachMeasurementNote('2026-10-17')).not.toContain('v1.99.3 Play')
  })
  it('undated shows nothing', () => {
    web.dateEt = null
    expect(coachMeasurementNote('2099-01-01')).toBeNull()
    expect(markedChanges().some((c) => c.id.startsWith('v1.99.3'))).toBe(false)
  })
  it('web set shows from its day on, in the report coach line too', () => {
    web.dateEt = '2026-11-01'
    expect(coachMeasurementNote('2026-10-31')).toBeNull()
    expect(coachMeasurementNote('2026-11-01')).toContain('v1.99.3 web (from 2026-11-01)')
  })
  it('the Play entry counts from its own date, and both list when both are dated', () => {
    play.dateEt = '2026-11-05'
    expect(coachMeasurementNote('2026-11-04')).not.toContain('v1.99.3 Play')
    expect(coachMeasurementNote('2026-11-05')).toContain('v1.99.3 Play (from 2026-11-05)')
    web.dateEt = '2026-11-01'
    const both = coachMeasurementNote('2026-11-06')!
    expect(both).toContain('v1.99.3 web')
    expect(both).toContain('v1.99.3 Play')
  })
  it('the coach text stays out of the auth-success caveat and the generic report lines', () => {
    play.dateEt = '2026-11-05'
    expect(authMarkedChanges().some((c) => c.id.startsWith('v1.99.3'))).toBe(false)
    const caveat = noteRawText('measurement-change-note')
    expect(caveat).not.toContain('coach')
    expect(caveat).not.toContain('v1.99.3 Play')
    const lines = measurementReportLines('2026-11-10').join(' ')
    expect(lines).not.toContain('coach')
    expect(lines).not.toContain('v1.99.3 web')
    expect(lines).not.toContain('v1.99.3 Play')
  })
})
