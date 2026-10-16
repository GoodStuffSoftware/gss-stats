// The Flight 3 Apps "No ads (hero) vs Features" donut as charts.ts draws it: slice labels, the legend line
// "Label · N · P%", the tooltip, fixed colors, no cost anywhere, and the pins that keep the landing-tag list
// (lib/landingTags.ts) in step with the staged arm and the site constants. Made-up data.
import { describe, expect, it } from 'vitest'
import { buildChartConfig, formatKey, landingLegendText } from './charts'
import { f3HeroDonutWidget, defaultCampaignsWidgets } from './defaults'
import { STAGED_FLIGHT_3 } from './campaigns'
import { LANDING_SITES, LANDING_TAGS, LANDING_TAG_NOTE, F3_APPS_BARE_TAG, F3_APPS_FEATURES_TAG, F3_APPS_HERO_TAG } from './landingTags'
import { BSK_APP_SITE, BSK_WEB_SITE } from './metrics/facts'
import { SINCE_FIRST_CAMPAIGN } from './range'
import type { StatsResponse } from '../types'

const RETURN_UC_RE = /^[a-z][a-z0-9_]{0,39}$/
const resp = (rows: [string, number][]): StatsResponse => ({
  rows: rows.map(([tag, n]) => ({ key: { landingTag: tag }, pageviews: n, visits: n })),
  totals: { pageviews: rows.reduce((t, r) => t + r[1], 0), visits: 0 },
  meta: { site: 'all', host: null, since: '2026-10-13', until: '2026-10-13', dimensions: ['landingTag'], metric: 'pageviews' },
})
const widget = () => f3HeroDonutWidget({ x: 0, y: 0, w: 6, h: 10 })

describe('landing-tag donut: labels and legend', () => {
  it('names the slices No ads (hero), Features and Untagged', () => {
    expect(formatKey('landingTag', F3_APPS_HERO_TAG)).toBe('No ads (hero)')
    expect(formatKey('landingTag', F3_APPS_FEATURES_TAG)).toBe('Features')
    expect(formatKey('landingTag', F3_APPS_BARE_TAG)).toBe('Untagged')
  })

  it('the legend line is "Label · N · P%" with P the share of the plotted sum, and the tooltip says the same', () => {
    const cfg = buildChartConfig(widget(), resp([[F3_APPS_HERO_TAG, 6], [F3_APPS_FEATURES_TAG, 3], [F3_APPS_BARE_TAG, 1]]))!
    expect(cfg.type).toBe('doughnut')
    expect(cfg.data.labels).toEqual(['No ads (hero) · 6 · 60%', 'Features · 3 · 30%', 'Untagged · 1 · 10%'])
    expect(cfg.data.datasets[0].data).toEqual([6, 3, 1])
    const tip = (cfg.options as any).plugins.tooltip.callbacks
    expect(tip.label({ dataIndex: 1 })).toBe(' Features · 3 · 30%')
  })

  it('shares are rounded and a thousand is separated', () => {
    expect(landingLegendText('A', 1, [1, 2])).toBe('A · 1 · 33%')
    expect(landingLegendText('A', 1234, [1234, 1234])).toBe('A · 1,234 · 50%')
    expect(landingLegendText('A', 0, [0])).toBe('A · 0 · 0%')
  })

  it('keeps each tag its own color whatever the order', () => {
    const a = buildChartConfig(widget(), resp([[F3_APPS_HERO_TAG, 6], [F3_APPS_FEATURES_TAG, 3]]))!
    const b = buildChartConfig(widget(), resp([[F3_APPS_FEATURES_TAG, 9], [F3_APPS_HERO_TAG, 1]]))!
    const colorOf = (cfg: typeof a, i: number) => (cfg.data.datasets[0].backgroundColor as string[])[i]
    expect(colorOf(a, 0)).toBe(colorOf(b, 1)) // hero
    expect(colorOf(a, 1)).toBe(colorOf(b, 0)) // features
    expect(colorOf(a, 0)).not.toBe(colorOf(a, 1))
  })

  it('other doughnuts are untouched: plain labels, no custom tooltip', () => {
    const w = { ...widget(), dimension: 'device' }
    const cfg = buildChartConfig(w, { ...resp([]), rows: [{ key: { device: 'mobile' }, pageviews: 4, visits: 4 }, { key: { device: 'desktop' }, pageviews: 1, visits: 1 }] })!
    expect(cfg.data.labels).toEqual(['mobile', 'desktop'])
    expect((cfg.options as any).plugins.tooltip).toBeUndefined()
  })

  it('shows no cost, spend or impressions text in the labels, title or caption', () => {
    const w = widget()
    const cfg = buildChartConfig(w, resp([[F3_APPS_HERO_TAG, 6], [F3_APPS_FEATURES_TAG, 3]]))!
    const text = JSON.stringify([w.title, w.caption, cfg.data.labels])
    expect(text).not.toMatch(/cost|spend|impress|\$|cpc|cpa/i)
  })
})

describe('landing-tag donut: the default card and the pinned constants', () => {
  it('ships on the Campaigns page at x0 y78 w6 h10 with the note as its caption and its own filters', () => {
    const w = defaultCampaignsWidgets().find((x) => x.id === 'cw-f3-hero-donut')!
    expect(w).toBeTruthy()
    expect([w.x, w.y, w.w, w.h]).toEqual([0, 78, 6, 10])
    expect([w.type, w.dataset, w.dimension, w.metric]).toEqual(['doughnut', 'geo', 'landingTag', 'pageviews'])
    expect(w.caption).toBe(LANDING_TAG_NOTE)
    expect(w.caption).toBe('The two ads rotate evenly, so the slice share reflects how well each ad converts to arrivals.')
    expect(w.filters?.rangeRel).toBe(SINCE_FIRST_CAMPAIGN)
    expect(w.filters?.siteSel).toEqual([])
    expect(w.filters?.excludeOwnVisits).toBe(false)
    // Nothing else on the page moved: the two notes above it keep y74 h4.
    expect(defaultCampaignsWidgets().filter((x) => x.y === 74).map((x) => [x.id, x.h])).toEqual([['cw-note-attrib', 4], ['cw-note-smallsample', 4]])
  })

  it('every landing tag is in the staged Apps arm, and is a tag best-sudoku sends a /return/ row for', () => {
    for (const t of LANDING_TAGS) {
      expect(STAGED_FLIGHT_3.apps.ucValues).toContain(t.tag)
      expect(t.tag).toMatch(RETURN_UC_RE)
    }
  })

  it('the landing sites are the web build and the installed app', () => {
    expect([...LANDING_SITES]).toEqual([BSK_WEB_SITE, BSK_APP_SITE])
  })
})
