// The v1.99.3 coach meaning-change entries (lib/measurementChanges.ts): both ship undated, so
// nothing shows; once the web one is dated the coach readouts get its note.
import { afterEach, describe, expect, it } from 'vitest'
import { MEASUREMENT_CHANGES, coachMeasurementNote, markedChanges } from './measurementChanges'
import { coachCountsLine } from '../../scripts/ads-reads/report'
import { emptyCoachCounts } from './adsRules'

const web = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.3 web')!
const play = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.3 Play')!
afterEach(() => {
  web.dateEt = null
})

describe('v1.99.3 coach entries', () => {
  it('exist undated and both name the coach change', () => {
    expect(web.dateEt).toBeNull()
    expect(play.dateEt).toBeNull()
    expect(web.note).toContain('×')
    expect(play.note).toContain('×')
    expect(play.note).toContain('Apps-arm installs')
  })
  it('null shows nothing', () => {
    expect(coachMeasurementNote('2099-01-01')).toBeNull()
    expect(markedChanges().some((c) => c.id.startsWith('v1.99.3'))).toBe(false)
    expect(coachCountsLine(emptyCoachCounts(), undefined, coachMeasurementNote('2099-01-01'))).not.toContain('meaning change')
  })
  it('set shows from its day on, in the report coach line too', () => {
    web.dateEt = '2026-11-01'
    expect(coachMeasurementNote('2026-10-31')).toBeNull()
    expect(coachMeasurementNote('2026-11-01')).toContain('v1.99.3 web (from 2026-11-01)')
    expect(coachCountsLine(emptyCoachCounts(), undefined, coachMeasurementNote('2026-11-02'))).toContain('; meaning change v1.99.3 web (from 2026-11-01)')
  })
})
