// The measurement-change marker in the ads read report: nothing while its date is null, a marker
// line on the change's ET day, a "since" line on later reads. Fixture only: no network.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead, type MorningOptions } from './read'
import { formatMorningReport, measurementLinesAt } from './report'
import { MEASUREMENT_CHANGES } from '../../src/lib/measurementChanges'
import { MIN_COHORT, etDateFromMs } from '../../src/lib/popupEvents'
import { addDays } from '../../src/lib/etTime'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (): Fixture => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8'))
const opts: MorningOptions = { campaignId: '24279250691', releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 }

const change = MEASUREMENT_CHANGES[0]
const SHIPPED_DATE = change.dateEt
const PLAY_ENTRY = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.2 Play')!
const PLAY_ENTRY_DATE = PLAY_ENTRY.dateEt
beforeEach(() => {
  PLAY_ENTRY.dateEt = null
})
afterEach(() => {
  change.dateEt = SHIPPED_DATE
  PLAY_ENTRY.dateEt = PLAY_ENTRY_DATE
})

const hasMeasurementLine = (report: string) => /MEASUREMENT CHANGE TODAY|Measurement change since/.test(report)

describe('measurementLinesAt (readAt -> its ET day)', () => {
  it('prints nothing while the date is null', () => {
    change.dateEt = null
    expect(measurementLinesAt('2026-10-20T15:00:00Z')).toEqual([])
  })

  it('reads the ET day of the read, not the UTC day (02:00Z is still the evening before in ET)', () => {
    change.dateEt = '2026-10-20'
    expect(measurementLinesAt('2026-10-21T02:00:00Z')).toEqual([expect.stringContaining('MEASUREMENT CHANGE TODAY')])
    expect(measurementLinesAt('2026-10-20T15:00:00Z')).toEqual([expect.stringContaining('MEASUREMENT CHANGE TODAY')])
    expect(measurementLinesAt('2026-10-19T15:00:00Z')).toEqual([])
    expect(measurementLinesAt('2026-10-21T15:00:00Z')).toEqual([expect.stringContaining('Measurement change since 2026-10-20')])
  })
})

describe('a morning read report', () => {
  it('has no measurement line while the date is null', async () => {
    change.dateEt = null
    const r = await runMorningRead(fixtureDeps(fixture(), false), opts)
    expect(hasMeasurementLine(formatMorningReport(r))).toBe(false)
  })

  it('marks the day on the read day, a since line after it, nothing before it', async () => {
    const r = await runMorningRead(fixtureDeps(fixture(), false), opts)
    const day = etDateFromMs(Date.parse(r.readAt))

    change.dateEt = day
    const on = formatMorningReport(r).split('\n')
    expect(on[2]).toMatch(/^MEASUREMENT CHANGE TODAY, v1\.99\.2: /) // straight under the two header lines

    change.dateEt = addDays(day, -2)
    expect(formatMorningReport(r)).toContain(`Measurement change since ${addDays(day, -2)}, v1.99.2: `)

    change.dateEt = addDays(day, 1)
    expect(hasMeasurementLine(formatMorningReport(r))).toBe(false)
  })
})
