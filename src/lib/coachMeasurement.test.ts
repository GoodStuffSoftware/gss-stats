// The v1.99.3 coach meaning-change entries (lib/measurementChanges.ts): both ship undated, so
// nothing shows; once dated the coach readouts get the note and nothing else does.
import { afterEach, describe, expect, it } from 'vitest'
import { MEASUREMENT_CHANGES, authMarkedChanges, coachMeasurementNote, markedChanges, measurementReportLines } from './measurementChanges'
import { noteRawText } from './notes'
import { coachCountsLine } from '../../scripts/ads-reads/report'
import { emptyCoachCounts } from './adsRules'

const web = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.3 web')!
const play = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.3 Play')!
afterEach(() => {
  web.dateEt = null
  play.dateEt = null
})

describe('v1.99.3 coach entries', () => {
  it('exist undated and both name the coach change', () => {
    expect(web.dateEt).toBeNull()
    expect(play.dateEt).toBeNull()
    expect(web.note).toContain('×')
    expect(play.coachNote).toContain('×')
    expect(play.note).toContain('Apps-arm installs')
  })
  it('null shows nothing', () => {
    expect(coachMeasurementNote('2099-01-01')).toBeNull()
    expect(markedChanges().some((c) => c.id.startsWith('v1.99.3'))).toBe(false)
    expect(coachCountsLine(emptyCoachCounts(), undefined, coachMeasurementNote('2099-01-01'))).not.toContain('meaning change')
  })
  it('web set shows from its day on, in the report coach line too', () => {
    web.dateEt = '2026-11-01'
    expect(coachMeasurementNote('2026-10-31')).toBeNull()
    expect(coachMeasurementNote('2026-11-01')).toContain('v1.99.3 web (from 2026-11-01)')
    expect(coachCountsLine(emptyCoachCounts(), undefined, coachMeasurementNote('2026-11-02'))).toContain('; meaning change v1.99.3 web (from 2026-11-01)')
  })
  it('the Play entry counts from its own date, and both list when both are dated', () => {
    play.dateEt = '2026-11-05'
    expect(coachMeasurementNote('2026-11-04')).toBeNull()
    expect(coachMeasurementNote('2026-11-05')).toContain('v1.99.3 Play (from 2026-11-05)')
    web.dateEt = '2026-11-01'
    const both = coachMeasurementNote('2026-11-06')!
    expect(both).toContain('v1.99.3 web')
    expect(both).toContain('v1.99.3 Play')
  })
  it('the coach text stays out of the auth-success caveat and the generic report lines', () => {
    web.dateEt = '2026-11-01'
    play.dateEt = '2026-11-05'
    expect(authMarkedChanges().some((c) => c.id === 'v1.99.3 web')).toBe(false)
    const caveat = noteRawText('measurement-change-note')
    expect(caveat).not.toContain('coach')
    expect(caveat).toContain('v1.99.3 Play')
    const lines = measurementReportLines('2026-11-10').join(' ')
    expect(lines).not.toContain('coach')
    expect(lines).not.toContain('v1.99.3 web')
  })
})
