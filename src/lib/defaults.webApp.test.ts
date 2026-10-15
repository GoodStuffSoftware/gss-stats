// Web and app are told apart in ONE place: the Overview's "Web vs app activity" card (Mike,
// 2026-10-15). Every feature card (coach tips, tour, pop-ups, game starts and completions, hints,
// mode x difficulty) counts web and app together: no default groups, breaks down, filters or
// scopes one by web/app.
import { describe, expect, it } from 'vitest'
import {
  BEST_SUDOKU_SITES,
  WEB_APP_SERIES,
  defaultBestSudokuPopupsWidgets,
  defaultCampaignsWidgets,
  defaultConfig,
  defaultOverviewWidgets,
  defaultRetentionWidgets,
  webAppActivityWidget,
} from './defaults'
import { SPLIT_REFUSED_DIMS, splitRefused } from './splitGuard'
import type { Widget } from '../types'

const sameSet = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

describe('Web vs app activity card', () => {
  const overview = () => defaultConfig().pages.find((p) => p.id === 'bsk-overview')!
  it('is on the default Overview, plainly labelled', () => {
    const card = overview().widgets.find((x) => x.id === 'ow-webapp')
    expect(card?.title).toBe('Web vs app activity')
    expect(defaultOverviewWidgets().some((x) => x.id === 'ow-webapp')).toBe(true)
  })
  it('counts page views per ET day, one line per site tag, all Best Sudoku sites in scope', () => {
    const c = webAppActivityWidget({ x: 0, y: 0, w: 12, h: 9 })
    expect(c).toMatchObject({ type: 'line', dataset: 'geo', dimension: 'dateEt', metric: 'pageviews' })
    expect(c.siteSel && sameSet(c.siteSel, BEST_SUDOKU_SITES)).toBe(true)
    // the three series cover exactly the three Best Sudoku site tags, each once
    const tags = WEB_APP_SERIES.map((s) => s.filter!.map((f) => `${f.field}=${f.value}`).join(','))
    expect(tags.sort()).toEqual(BEST_SUDOKU_SITES.map((s) => `site=${s}`).sort())
    expect(c.series!.map((s) => s.label)).toEqual(['Web', 'App', 'Web (host-tagged)'])
  })
  it('splits by an ET day and a site tag only, neither of which the split guard refuses', () => {
    const c = webAppActivityWidget({ x: 0, y: 0, w: 12, h: 9 })
    const fields = [c.dimension, ...c.series!.flatMap((s) => s.filter!.map((f) => f.field))]
    expect(fields).toEqual(['dateEt', 'site', 'site', 'site'])
    expect(splitRefused({ points: false, fields })).toBe(false)
    // and the guard still refuses what it refused: hour, UTC day, place and device
    for (const d of ['hourEt', 'date', 'country', 'region', 'city', 'device', 'browser', 'os', 'visitor']) expect(SPLIT_REFUSED_DIMS.has(d)).toBe(true)
    expect(SPLIT_REFUSED_DIMS.has('site')).toBe(false)
  })
})

describe('feature cards default to one combined web + app number', () => {
  const featureCards = (): Widget[] => [
    ...defaultOverviewWidgets().filter((x) => x.id !== 'ow-webapp'),
    ...defaultBestSudokuPopupsWidgets(),
    ...defaultCampaignsWidgets(),
    ...defaultRetentionWidgets(),
  ]
  it('none groups, breaks down or filters by site, and none is scoped to web or to app alone', () => {
    const offenders: string[] = []
    for (const x of featureCards()) {
      const bySeries = (x.series ?? []).some((s) => (s.filter ?? []).some((f) => f.field === 'site'))
      const sel = x.siteSel ?? []
      const onlyOne = sel.length > 0 && !sel.some((s) => s === 'bestsudoku-web') !== !sel.some((s) => s === 'bestsudoku-app')
      if (x.dimension === 'site' || x.breakdown === 'site' || bySeries || onlyOne) offenders.push(x.id)
    }
    expect(offenders).toEqual([])
  })
})
