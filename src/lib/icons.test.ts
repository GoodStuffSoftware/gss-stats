import { describe, expect, it } from 'vitest'
import {
  DATASET_ICON,
  FALLBACK_ICON,
  ICONS,
  ICON_CATEGORIES,
  PICKER_ICONS,
  autoIcon,
  chartsDataset,
  fnv1a,
  groupBadge,
  groupColorIndex,
  groupMonogram,
  isIconKey,
  resolveIcon,
} from './icons'
import { defaultConfig } from './defaults'
import type { DashboardPage, Dataset, Widget } from '../types'

const wd = (id: string, over: Partial<Widget> = {}): Widget => ({ id, i: id, title: id, type: 'bar', dimension: 'd', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 1, h: 1, ...over })
const page = (id: string, widgets: Widget[], over: Partial<DashboardPage> = {}): DashboardPage => ({ id, name: id, isDefault: false, group: 'Mine', filters: {} as any, widgets, ...over })

describe('the icon registry', () => {
  it('offers ~40 curated icons in the five picker categories, each a real component', () => {
    expect(PICKER_ICONS.length).toBe(40)
    expect(new Set(PICKER_ICONS.map((i) => i.category))).toEqual(new Set(ICON_CATEGORIES))
    for (const i of PICKER_ICONS) {
      expect(ICONS[i.key], i.key).toBeTruthy()
      expect(i.label, i.key).toBeTruthy()
    }
    expect(new Set(PICKER_ICONS.map((i) => i.key)).size).toBe(PICKER_ICONS.length) // no duplicates
  })

  it('maps every dataset to a registered icon', () => {
    const datasets: Dataset[] = ['rum', 'geo', 'popup', 'campaigns', 'completions', 'ads-readings', 'overview']
    expect(Object.keys(DATASET_ICON).sort()).toEqual([...datasets].sort())
    expect(datasets.map((d) => DATASET_ICON[d])).toEqual(['trending-up', 'map-pin', 'app-window', 'megaphone', 'trophy', 'tag', 'layout-grid'])
    for (const d of datasets) expect(isIconKey(DATASET_ICON[d])).toBe(true)
  })

  it('knows only its own keys', () => {
    expect(isIconKey('megaphone')).toBe(true)
    expect(isIconKey('file')).toBe(true)
    expect(isIconKey('toString')).toBe(false)
    expect(isIconKey('not-a-key')).toBe(false)
    expect(isIconKey(undefined)).toBe(false)
  })
})

describe('chartsDataset', () => {
  it('the dataset most charts read; notes do not count; no dataset counts as rum', () => {
    expect(chartsDataset([wd('a', { dataset: 'geo' }), wd('b'), wd('c'), wd('n1', { type: 'note', dataset: 'geo' }), wd('n2', { type: 'note', dataset: 'geo' })])).toBe('rum')
  })
  it('a tie goes to the first chart in LAYOUT order (top to bottom, then left to right), not array order', () => {
    const widgets = [wd('late', { dataset: 'geo', y: 10 }), wd('early', { dataset: 'popup', y: 0, x: 6 }), wd('g2', { dataset: 'geo', y: 20 }), wd('p2', { dataset: 'popup', y: 30 })]
    expect(chartsDataset(widgets)).toBe('popup')
    expect(chartsDataset([wd('r', { dataset: 'campaigns', y: 0, x: 6 }), wd('l', { dataset: 'overview', y: 0, x: 0 })])).toBe('overview')
  })
  it('null with no charts (or only notes)', () => {
    expect(chartsDataset([])).toBeNull()
    expect(chartsDataset([wd('n', { type: 'note' })])).toBeNull()
  })
})

describe('resolveIcon', () => {
  it('1 · explicit: the icon someone picked; an unknown key gets the generic page icon', () => {
    expect(resolveIcon(page('p', [wd('a', { dataset: 'geo' })], { icon: 'rocket' }), [])).toMatchObject({ key: 'rocket', source: 'explicit', drill: false })
    expect(resolveIcon(page('p', [wd('a', { dataset: 'geo' })], { icon: 'retired-key' }), [])).toMatchObject({ key: FALLBACK_ICON, source: 'fallback' })
  })

  it('2 · inherited: a drill page shows its root page\'s icon, with the drill mark', () => {
    const root = page('t', [wd('a', { dataset: 'geo' })], { icon: 'trending-up' })
    const kid = page('k', [wd('a', { dataset: 'geo' })], { parentId: 't' })
    expect(resolveIcon(kid, [root, kid])).toMatchObject({ key: 'trending-up', source: 'inherited', drill: true, from: root })
    const autoRoot = page('c', [wd('x', { dataset: 'campaigns' })])
    const autoKid = page('k2', [wd('x', { dataset: 'geo' })], { parentId: 'c' })
    expect(resolveIcon(autoKid, [autoRoot, autoKid])).toMatchObject({ key: 'megaphone', source: 'inherited', drill: true })
    // a drill page with its own pick keeps it, still marked as a drill
    expect(resolveIcon({ ...kid, icon: 'flag' }, [root, kid])).toMatchObject({ key: 'flag', source: 'explicit', drill: true })
    // a stale parent link is just a page
    expect(resolveIcon(page('s', [wd('a', { dataset: 'popup' })], { parentId: 'gone' }), [])).toMatchObject({ key: 'app-window', drill: false })
  })

  it('2 · inherited at any depth: the top-level page\'s icon (or the nearest ancestor someone picked one for)', () => {
    const root = page('t', [wd('a', { dataset: 'geo' })], { icon: 'trending-up' })
    const m = page('m', [wd('a', { dataset: 'popup' })], { parentId: 't' })
    const ca = page('ca', [wd('a', { dataset: 'popup' })], { parentId: 'm' })
    const la = page('la', [wd('a', { dataset: 'popup' })], { parentId: 'ca' })
    const all = [root, m, ca, la]
    expect(resolveIcon(la, all)).toMatchObject({ key: 'trending-up', source: 'inherited', drill: true, from: root })
    const picked = [root, m, { ...ca, icon: 'flag' }, la]
    expect(resolveIcon(la, picked)).toMatchObject({ key: 'flag', source: 'inherited', drill: true })
    // moved out to a group of its own (no parent any more): its own icon from its charts, no mark
    const { parentId: _p, ...promoted } = ca
    expect(resolveIcon(promoted as typeof ca, [root, m, promoted as typeof ca, la])).toMatchObject({ key: 'app-window', source: 'charts', drill: false })
    expect(resolveIcon(la, [root, m, promoted as typeof ca, la])).toMatchObject({ key: 'app-window', source: 'inherited', drill: true })
  })

  it('3 · from charts, 4 · fallback', () => {
    expect(resolveIcon(page('p', [wd('a', { dataset: 'completions' })]), [])).toMatchObject({ key: 'trophy', source: 'charts', dataset: 'completions' })
    expect(resolveIcon(page('p', []), [])).toMatchObject({ key: FALLBACK_ICON, source: 'fallback', drill: false })
  })

  it('the built-in pages land where the spec says', () => {
    const pages = defaultConfig().pages
    expect(pages.map((p) => [p.id, resolveIcon(p, pages).key, resolveIcon(p, pages).source])).toEqual([
      ['default', 'trending-up', 'charts'], // rum 9 · geo 4
      ['beacon', 'map-pin', 'charts'], // geo 13
      ['bsk-overview', 'layout-grid', 'charts'], // overview 3 · geo 1 · completions 1
      ['bsk-campaigns', 'megaphone', 'charts'], // campaigns 4 · geo 3
      ['bsk-popups', 'app-window', 'charts'], // popup 2 · geo 1
      ['bsk-launch', 'trending-up', 'explicit'], // geo 12 would be the map pin: explicit instead
    ])
    const launch = pages.find((p) => p.id === 'bsk-launch')!
    expect(autoIcon(launch, pages)).toMatchObject({ key: 'map-pin', source: 'charts', dataset: 'geo' })
  })
})

describe('group badges', () => {
  it('monogram: first letters of the first two words, or the first two letters of one word', () => {
    expect(['All sites', 'Best Sudoku', 'Mine', 'Star Rupture', 'x', '  ', 'über alles', 'one two three'].map(groupMonogram)).toEqual(['AS', 'BS', 'MI', 'SR', 'X', '?', 'ÜA', 'OT'])
  })
  it('colour: FNV-1a of the name into seven slots (the spec\'s assignments)', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c) // the FNV-1a 32-bit test vector
    expect(['All sites', 'Best Sudoku', 'Mine', 'Star Rupture'].map(groupColorIndex)).toEqual([1, 3, 5, 2])
    expect(groupBadge('Best Sudoku')).toEqual({ text: 'BS', slot: 3 })
  })
  it('groupMeta pins a palette slot or a hex colour (with readable text), and a logo', () => {
    expect(groupBadge('Mine', { color: 'g0' })).toEqual({ text: 'MI', slot: 0 })
    expect(groupBadge('Mine', { color: '#000000' })).toMatchObject({ color: '#000000', onColor: '#FFFFFF' })
    expect(groupBadge('Mine', { color: '#fff' })).toMatchObject({ color: '#fff', onColor: '#15120F' })
    expect(groupBadge('Mine', { logo: 'https://x.example/l.png' })).toEqual({ text: 'MI', slot: 5, logo: 'https://x.example/l.png' })
    expect(groupBadge('Mine', { color: 'red' })).toEqual({ text: 'MI', slot: 5 }) // not a slot or hex: hashed colour
  })
})
