// The Flight 3 hero-vs-features donut's caption used to say the two ads "rotate evenly". The
// report's impressions-balance check showed that is not guaranteed, so the default caption changed
// (LANDING_TAG_NOTE) and a saved layout that still carries the OLD caption verbatim is moved to the
// new one on every load (migrateLandingTagCaption). A caption the owner edited is left alone.
import { describe, expect, it } from 'vitest'
import { F3_HERO_DONUT_ID, defaultCampaignsWidgets, defaultConfig, migrateLandingTagCaption, normalizeConfig } from './defaults'
import { LANDING_TAG_NOTE, LANDING_TAG_NOTE_LEGACY } from './landingTags'
import type { DashboardConfig, DashboardPage, Widget } from '../types'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const donut = () => clone(defaultCampaignsWidgets().find((w) => w.id === F3_HERO_DONUT_ID)!)

/** A saved config (current version) whose page `p1` holds `widgets`. */
const stored = (widgets: Widget[]): DashboardConfig => {
  const base = clone(defaultConfig())
  const page: DashboardPage = { ...clone(base.pages[0]), id: 'p1', name: 'One', isDefault: false, widgets }
  return { ...base, activePageId: base.pages[0].id, pages: [base.pages[0], page] }
}
const loaded = (widgets: Widget[]) => normalizeConfig(stored(widgets)).pages.find((p) => p.id === 'p1')!.widgets.find((w) => w.id === F3_HERO_DONUT_ID)!

describe('the donut caption', () => {
  it('the new default no longer claims an even rotation; the legacy text is what it replaces', () => {
    expect(LANDING_TAG_NOTE).not.toContain('The two ads rotate evenly')
    expect(LANDING_TAG_NOTE).toContain('may not rotate evenly')
    expect(LANDING_TAG_NOTE_LEGACY).toBe('The two ads rotate evenly, so the slice share reflects how well each ad converts to arrivals.')
    expect(donut().caption).toBe(LANDING_TAG_NOTE)
  })
})

describe('migrateLandingTagCaption', () => {
  it('moves an old saved caption on the donut to the new one', () => {
    expect(loaded([{ ...donut(), caption: LANDING_TAG_NOTE_LEGACY }]).caption).toBe(LANDING_TAG_NOTE)
  })
  it('leaves a custom caption alone, even one that only contains the old text', () => {
    expect(loaded([{ ...donut(), caption: 'Hero vs features, my words.' }]).caption).toBe('Hero vs features, my words.')
    const longer = `${LANDING_TAG_NOTE_LEGACY} (checked 10-17)`
    expect(loaded([{ ...donut(), caption: longer }]).caption).toBe(longer)
  })
  it('leaves the new default as it is, and a widget with no caption without one', () => {
    expect(loaded([donut()]).caption).toBe(LANDING_TAG_NOTE)
    const { caption: _drop, ...bare } = donut()
    expect(loaded([bare as Widget]).caption).toBeUndefined()
  })
  it('only touches the landing-tag donut: another widget with the old text keeps it', () => {
    const other: Widget = { ...donut(), id: 'w-other', i: 'w-other', dimension: 'country', caption: LANDING_TAG_NOTE_LEGACY }
    const pages = stored([other]).pages
    const out = migrateLandingTagCaption(pages)
    expect(out).toBe(pages)
    expect(out[1].widgets[0].caption).toBe(LANDING_TAG_NOTE_LEGACY)
  })
  it('returns the same array when nothing matches, and a new one (inputs untouched) when something does', () => {
    const clean = stored([donut()]).pages
    expect(migrateLandingTagCaption(clean)).toBe(clean)
    const old = stored([{ ...donut(), caption: LANDING_TAG_NOTE_LEGACY }]).pages
    const before = JSON.stringify(old)
    const out = migrateLandingTagCaption(old)
    expect(out).not.toBe(old)
    expect(JSON.stringify(old)).toBe(before)
    expect(out[1].widgets[0].caption).toBe(LANDING_TAG_NOTE)
  })
  it('is stable: a second load of the migrated config keeps the new caption', () => {
    const caption = (c: DashboardConfig) => c.pages.find((p) => p.id === 'p1')!.widgets.find((w) => w.id === F3_HERO_DONUT_ID)!.caption
    const once = normalizeConfig(stored([{ ...donut(), caption: LANDING_TAG_NOTE_LEGACY }]))
    expect(caption(once)).toBe(LANDING_TAG_NOTE)
    expect(caption(normalizeConfig(clone(once)))).toBe(LANDING_TAG_NOTE)
  })
})
