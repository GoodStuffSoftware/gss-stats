// The Ask-order A/B config and the pre-registered read (progress toward 150, the 1.5x rule per kind).
import { describe, expect, it } from 'vitest'
import {
  ASK_ORDER_CALL_ASKS, ASK_ORDER_FEATURES, ASK_ORDER_GROUPS, ASK_ORDER_SWITCH_MULTIPLE, askOrderAssignedPath, askOrderFeatureId, askOrderOutcomePath,
  askOrderShownPath, assignedStepId, outcomeRowsOf, outcomeStepId, readAskOrder, responseRowsOf, shownStepId, stepCount, type AskOrderAllTime,
} from './askOrder'
import { flatSteps, stepMatches, type FeatureHealth } from './featureHealth'
import { stepMatchSql } from './featureHealthSql'

type G = 'signin-first' | 'install-first'
const key = (g: G, step: string) => `${askOrderFeatureId(g)}.${step}`
/** Builds an all-time map: organic counts only unless a tagged map is given too. */
function counts(g: G, c: { assigned?: number; shown?: number; signedIn?: number; installed?: number; returned?: number; stillPlaying?: number }, tag: 'organic' | 'tagged' = 'organic'): AskOrderAllTime {
  const out: Record<string, number> = {}
  if (c.assigned !== undefined) out[key(g, assignedStepId(tag))] = c.assigned
  if (c.shown !== undefined) out[key(g, shownStepId('signin', tag))] = c.shown
  if (c.signedIn !== undefined) out[key(g, outcomeStepId('signin', 'signed-in', tag))] = c.signedIn
  if (c.installed !== undefined) out[key(g, outcomeStepId('install', 'installed', tag))] = c.installed
  if (c.returned !== undefined) out[key(g, outcomeStepId('signin', 'returned', tag))] = c.returned
  if (c.stillPlaying !== undefined) out[key(g, outcomeStepId('signin', 'still-playing', tag))] = c.stillPlaying
  return out
}
const merge = (...maps: AskOrderAllTime[]): AskOrderAllTime => Object.assign({}, ...maps)

describe('ask-order config', () => {
  it('has a feature per group with 22 unique steps, each on exactly one path and one tag', () => {
    expect(ASK_ORDER_FEATURES.map((f) => f.id)).toEqual(['ao-signin-first', 'ao-install-first'])
    for (const f of ASK_ORDER_FEATURES) {
      expect(f.steps).toHaveLength(22)
      expect(new Set(f.steps.map((s) => s.id)).size).toBe(22)
      for (const s of f.steps) {
        expect(s.match.exact).toHaveLength(1)
        expect(['organic', 'tagged']).toContain(s.match.tag)
      }
    }
  })

  it('uses the planned /ab/ask-order/<group>/... path shapes', () => {
    expect(askOrderAssignedPath('install-first')).toBe('/ab/ask-order/install-first/assigned')
    expect(askOrderShownPath('signin-first', 'install')).toBe('/ab/ask-order/signin-first/shown/install')
    expect(askOrderOutcomePath('signin-first', 'signin', 'still-playing')).toBe('/ab/ask-order/signin-first/signin/still-playing')
    const paths = flatSteps(ASK_ORDER_FEATURES).flatMap((f) => f.step.match.exact!)
    expect(new Set(paths).size).toBe(22) // 11 paths a group, shared by the organic and tagged steps
    for (const p of paths) expect(p.startsWith('/ab/ask-order/')).toBe(true)
  })

  it('returns are read only from the group-carrying rows, never from the ordinary return rows', () => {
    for (const { step } of flatSteps(ASK_ORDER_FEATURES)) {
      for (const ordinary of ['/return/sudoku_tired_of_ads/d1', '/return/organic/d0', '/game/start/easy']) {
        expect(stepMatches(step.match, ordinary, 'x')).toBe(false)
        expect(stepMatches(step.match, ordinary, '')).toBe(false)
      }
    }
  })

  it('tag matching: tagged is a non-empty campaign, organic an empty or missing one, in JS and in SQL', () => {
    const def = flatSteps(ASK_ORDER_FEATURES).find((f) => f.step.id === assignedStepId('tagged'))!
    const org = flatSteps(ASK_ORDER_FEATURES).find((f) => f.step.id === assignedStepId('organic'))!
    const p = askOrderAssignedPath('signin-first')
    expect(stepMatches(def.step.match, p, 'sudoku_tired_of_ads')).toBe(true)
    expect(stepMatches(def.step.match, p, '')).toBe(false)
    expect(stepMatches(def.step.match, p, null)).toBe(false)
    expect(stepMatches(def.step.match, p)).toBe(false)
    expect(stepMatches(org.step.match, p, '')).toBe(true)
    expect(stepMatches(org.step.match, p, null)).toBe(true)
    expect(stepMatches(org.step.match, p, 'sudoku_tired_of_ads')).toBe(false)
    expect(stepMatchSql(def.step.match)).toContain("campaign IS NOT NULL AND campaign <> ''")
    expect(stepMatchSql(org.step.match)).toContain("campaign IS NULL OR campaign = ''")
  })
})

describe('readAskOrder: progress toward the call point', () => {
  it('reads zero with nothing, with null ratios and a preliminary verdict', () => {
    const r = readAskOrder({})
    expect(r.bothReachedCall).toBe(false)
    for (const g of r.groups) {
      expect(g).toMatchObject({ assigned: 0, asksShown: 0, progress: 0, reachedCall: false, responseRows: 0, responseRowsPerAssigned: null })
      expect(g.perOutcome['signed-in'].perAssigned).toBeNull()
    }
    for (const k of r.kinds) {
      expect(k).toMatchObject({ larger: null, multiple: null })
      expect(k.verdict.state).toBe('preliminary')
    }
  })

  it('counts asks shown over both asks and both tags, capped at 150', () => {
    const all = merge(
      { [key('signin-first', shownStepId('signin', 'organic'))]: 20, [key('signin-first', shownStepId('install', 'organic'))]: 10, [key('signin-first', shownStepId('signin', 'tagged'))]: 10 },
      counts('install-first', { shown: 400 }),
    )
    const r = readAskOrder(all)
    expect(r.groups[0]).toMatchObject({ asksShown: 40, reachedCall: false })
    expect(r.groups[0].progress).toBeCloseTo(40 / ASK_ORDER_CALL_ASKS)
    expect(r.groups[1]).toMatchObject({ asksShown: 400, reachedCall: true, progress: 1 })
  })

  it('stays preliminary while only one group has reached the call point', () => {
    const all = merge(
      counts('signin-first', { assigned: 200, shown: 150, signedIn: 100 }),
      counts('install-first', { assigned: 200, shown: 149, signedIn: 10 }),
    )
    const r = readAskOrder(all)
    expect(r.bothReachedCall).toBe(false)
    const k = r.kinds.find((x) => x.kind === 'signed-in')!
    expect(k.verdict.state).toBe('preliminary')
    expect(k.multiple).toBeCloseTo(10) // the multiple is still shown, as a preliminary number
    expect(k.verdict.note).toMatch(/Preliminary/)
    expect(k.verdict.note).toContain('Install first 149 of 150')
    expect((k.verdict as any).switchTo).toBeUndefined()
  })
})

describe('readAskOrder: the 1.5x rule, each response kind on its own', () => {
  const both150 = (a: Parameters<typeof counts>[1], b: Parameters<typeof counts>[1]) =>
    merge(counts('signin-first', { shown: 150, ...a }), counts('install-first', { shown: 150, ...b }))
  const kind = (all: AskOrderAllTime, k: 'signed-in' | 'installed') => readAskOrder(all).kinds.find((x) => x.kind === k)!

  it('switches at exactly 1.5x once both groups reach 150', () => {
    const v = kind(both150({ assigned: 100, signedIn: 10 }, { assigned: 100, signedIn: 15 }), 'signed-in')
    expect(v.larger).toBe('install-first')
    expect(v.multiple).toBeCloseTo(ASK_ORDER_SWITCH_MULTIPLE)
    expect(v.verdict).toMatchObject({ state: 'call', switchTo: 'install-first' })
  })

  it('keeps sign-in first below 1.5x, even when install first is larger', () => {
    const v = kind(both150({ assigned: 100, signedIn: 10 }, { assigned: 100, signedIn: 14 }), 'signed-in')
    expect(v.larger).toBe('install-first')
    expect(v.verdict).toMatchObject({ state: 'call', switchTo: null })
    expect(v.verdict.note).toMatch(/keep sign-in first/)
  })

  it('keeps sign-in first when it is the larger one, however large', () => {
    const v = kind(both150({ assigned: 100, signedIn: 40 }, { assigned: 100, signedIn: 10 }), 'signed-in')
    expect(v.larger).toBe('signin-first')
    expect(v.verdict).toMatchObject({ state: 'call', switchTo: null })
    expect(v.verdict.note).toMatch(/keep sign-in first/)
  })

  it('a zero smaller rate against a positive larger one switches, with no multiple', () => {
    const v = kind(both150({ assigned: 100, signedIn: 0 }, { assigned: 100, signedIn: 3 }), 'signed-in')
    expect(v).toMatchObject({ larger: 'install-first', multiple: null })
    expect(v.verdict).toMatchObject({ state: 'call', switchTo: 'install-first' })
  })

  it('both zero keeps sign-in first; a tie keeps it too', () => {
    const zero = kind(both150({ assigned: 100, installed: 0 }, { assigned: 100, installed: 0 }), 'installed')
    expect(zero.verdict).toMatchObject({ state: 'call', switchTo: null })
    const tie = kind(both150({ assigned: 100, installed: 5 }, { assigned: 100, installed: 5 }), 'installed')
    expect(tie).toMatchObject({ larger: null, multiple: null })
    expect(tie.verdict).toMatchObject({ state: 'call', switchTo: null })
  })

  it('nobody assigned in a group gives null ratios and no switch', () => {
    const v = kind(both150({ assigned: 0, signedIn: 5 }, { assigned: 100, signedIn: 50 }), 'signed-in')
    expect(v).toMatchObject({ larger: null, multiple: null })
    expect(v.verdict).toMatchObject({ state: 'call', switchTo: null })
  })

  it('applies the rule to signed-in rows and installed rows separately', () => {
    const all = both150({ assigned: 100, signedIn: 10, installed: 20 }, { assigned: 100, signedIn: 20, installed: 21 })
    expect(kind(all, 'signed-in').verdict).toMatchObject({ state: 'call', switchTo: 'install-first' }) // 2x
    expect(kind(all, 'installed').verdict).toMatchObject({ state: 'call', switchTo: null }) // 1.05x
  })

  it('uses organic plus tagged rows together, per assigned row of the same group', () => {
    const all = merge(
      counts('signin-first', { assigned: 60, shown: 100, signedIn: 6 }),
      counts('signin-first', { assigned: 40, shown: 50, signedIn: 4 }, 'tagged'),
      counts('install-first', { assigned: 50, shown: 100, signedIn: 9 }),
      counts('install-first', { assigned: 50, shown: 50, signedIn: 6 }, 'tagged'),
    )
    const r = readAskOrder(all)
    expect(r.groups[0]).toMatchObject({ assigned: 100, asksShown: 150, reachedCall: true })
    expect(r.groups[0].perOutcome['signed-in']).toMatchObject({ count: 10, perAssigned: 0.1 })
    expect(r.groups[1].perOutcome['signed-in']).toMatchObject({ count: 15, perAssigned: 0.15 })
    expect(r.kinds[0].multiple).toBeCloseTo(1.5)
    expect(r.kinds[0].verdict).toMatchObject({ state: 'call', switchTo: 'install-first' })
  })

  it('the combined response figure counts signed-in rows plus installed rows (a device doing both twice) and is not the rule', () => {
    const r = readAskOrder(both150({ assigned: 100, signedIn: 10, installed: 5 }, { assigned: 100, signedIn: 1, installed: 1 }))
    expect(r.groups[0]).toMatchObject({ responseRows: 15, responseRowsPerAssigned: 0.15 })
    expect(r.kinds.map((k) => k.kind)).toEqual(['signed-in', 'installed'])
  })

  it('returns and still-playing are plain per-assigned row ratios from the group rows', () => {
    const r = readAskOrder(both150({ assigned: 50, returned: 10, stillPlaying: 5 }, { assigned: 0, returned: 3 }))
    expect(r.groups[0].perOutcome.returned).toMatchObject({ count: 10, perAssigned: 0.2 })
    expect(r.groups[0].perOutcome['still-playing']).toMatchObject({ count: 5, perAssigned: 0.1 })
    expect(r.groups[1].perOutcome.returned).toMatchObject({ count: 3, perAssigned: null })
  })
})

describe('range-model readers', () => {
  const f: FeatureHealth = {
    id: askOrderFeatureId('signin-first'),
    label: 'x',
    blurb: '',
    status: 'ok',
    statusNote: '',
    latest: 0,
    prev: 0,
    range: 0,
    steps: [
      { id: outcomeStepId('signin', 'signed-in', 'tagged'), label: '', latest: 2, prev: 0, range: 5, perDay: [] },
      { id: outcomeStepId('install', 'signed-in', 'tagged'), label: '', latest: 1, prev: 0, range: 3, perDay: [] },
      { id: outcomeStepId('install', 'installed', 'tagged'), label: '', latest: 4, prev: 0, range: 9, perDay: [] },
      { id: outcomeStepId('install', 'installed', 'organic'), label: '', latest: 100, prev: 0, range: 100, perDay: [] },
    ],
  } as FeatureHealth
  it('sums outcome rows over both asks for one tag and window, 0 when absent', () => {
    expect(stepCount(f, 'nope', 'latest')).toBe(0)
    expect(stepCount(undefined, 'nope', 'range')).toBe(0)
    expect(outcomeRowsOf(f, 'tagged', ['signed-in'], 'range')).toBe(8)
    expect(responseRowsOf(f, 'tagged', 'latest')).toBe(7)
    expect(responseRowsOf(f, 'organic', 'range')).toBe(100)
    expect(responseRowsOf(undefined, 'tagged', 'range')).toBe(0)
  })
  it('names both groups', () => {
    expect(ASK_ORDER_GROUPS.map((g) => g.id)).toEqual(['signin-first', 'install-first'])
  })
})
