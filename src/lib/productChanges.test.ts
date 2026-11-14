// Product changes (lib/productChanges.ts): the pinned list, its Eastern days, and how the overlay shows it.
import { describe, expect, it } from 'vitest'
import { PRODUCT_CHANGES, datedProductChanges } from './productChanges'
import { changeItems, overlayItems, releaseItems } from './timelineOverlay'
import { widgetHasOverlay, widgetOverlayOptions } from './charts'
import { datedReleases } from './releases'
import { MEASUREMENT_CHANGES } from './measurementChanges'

describe('PRODUCT_CHANGES', () => {
  it('is exactly the two changes that are neither a release nor a counting change, with their UTC instants', () => {
    expect(PRODUCT_CHANGES.map((c) => [c.id, c.atUtc])).toEqual([
      ['first-50-ended', '2026-11-09T16:42:45Z'],
      ['play-listing-fixed', '2026-11-09T19:49:09Z'],
    ])
  })

  it('every id is unique, lowercase words with dashes, and none is also a release version or a measurement-change id', () => {
    const ids = PRODUCT_CHANGES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(datedReleases().some((r) => r.version === id)).toBe(false)
      expect(MEASUREMENT_CHANGES.some((m) => m.id === id)).toBe(false)
    }
  })

  it('labels are short and plain; every instant parses', () => {
    for (const c of PRODUCT_CHANGES) {
      expect(c.label.length).toBeLessThanOrEqual(24)
      expect(Number.isNaN(Date.parse(c.atUtc))).toBe(false)
      expect(c.note.length).toBeGreaterThan(0)
    }
  })

  it('each lands on its Eastern day (11:42 and 14:49 ET on 2026-11-09, both EST-side of the DST change)', () => {
    expect(datedProductChanges().map((c) => [c.id, c.dateEt])).toEqual([
      ['first-50-ended', '2026-11-09'],
      ['play-listing-fixed', '2026-11-09'],
    ])
  })
})

describe('the overlay for product changes', () => {
  it("changeItems are kind 'change' on the Eastern day, with the label and note", () => {
    expect(changeItems()).toEqual([
      { kind: 'change', date: '2026-11-09', label: 'First-50 days end', note: PRODUCT_CHANGES[0].note },
      { kind: 'change', date: '2026-11-09', label: 'Play listing fix', note: PRODUCT_CHANGES[1].note },
    ])
  })

  it('only the changes option switches them on, and nothing else switches it on', () => {
    expect(overlayItems({ changes: true }).map((i) => i.kind)).toEqual(['change', 'change'])
    expect(overlayItems({ releases: true }).some((i) => i.kind === 'change')).toBe(false)
    expect(overlayItems({ goLive: true, flights: true }).some((i) => i.kind === 'change')).toBe(false)
    expect(widgetOverlayOptions({ changeMarkers: true })).toEqual({ releases: false, goLive: false, changes: true, flights: false })
    expect(widgetHasOverlay({ changeMarkers: true })).toBe(true)
    expect(widgetHasOverlay({})).toBe(false)
  })

  it('on the same day, a release is listed before a change', () => {
    const day = overlayItems({ releases: true, changes: true }).filter((i) => i.date === '2026-11-09')
    expect(day.map((i) => i.kind)).toEqual(['change', 'change'])
    const all = overlayItems({ releases: true, changes: true })
    expect([...all.map((i) => i.date)].sort()).toEqual(all.map((i) => i.date))
  })
})

describe('the labelled web releases of 1.107.0 and 1.108.0', () => {
  it('are labelled lines with a plain on-chart label, the Play entries keep their version label', () => {
    const items = releaseItems()
    const at = (v: string) => items.find((i) => i.note === datedReleases().find((r) => r.version === v)!.note)!
    expect(at('v1.107.0 web')).toMatchObject({ kind: 'release', label: 'v1.107.0 sign-in copy', date: '2026-11-04' })
    expect(at('v1.108.0 web')).toMatchObject({ kind: 'release', label: 'v1.108.0 no-ads', date: '2026-11-11' })
    expect(at('v1.107.0 Play').label).toBe('v1.107.0 Play')
    expect(at('v1.108.0 Play')).toMatchObject({ kind: 'release', label: 'v1.108.0 Play', date: '2026-11-11' })
  })

  it('the v1.108.0 Play entry is unchanged: promotion 17:52:16Z, review pending', () => {
    const play = datedReleases().find((r) => r.version === 'v1.108.0 Play')!
    expect(play.note).toContain('17:52:16Z')
    expect(play.note).toContain('Play review was still pending')
  })
})
