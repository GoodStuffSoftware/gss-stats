// The v1.99.3 coach meaning-change note on the report's tagged coach line.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MEASUREMENT_CHANGES, coachMeasurementNote } from '../../src/lib/measurementChanges'
import { emptyCoachCounts } from '../../src/lib/adsRules'
import { coachCountsLine } from './report'

const web = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.3 web')!
const play = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.3 Play')!
const WEB_DATE = web.dateEt
const PLAY_DATE = play.dateEt
beforeEach(() => {
  play.dateEt = null // these tests read the web entry alone
})
afterEach(() => {
  web.dateEt = WEB_DATE
  play.dateEt = PLAY_DATE
})

describe('coachCountsLine meaning-change note', () => {
  it('null shows nothing', () => {
    web.dateEt = null
    expect(coachCountsLine(emptyCoachCounts(), undefined, coachMeasurementNote('2099-01-01'))).not.toContain('meaning change')
  })
  it('set shows the note', () => {
    web.dateEt = '2026-11-01'
    expect(coachCountsLine(emptyCoachCounts(), undefined, coachMeasurementNote('2026-11-02'))).toContain('; meaning change v1.99.3 web (from 2026-11-01)')
  })
})
