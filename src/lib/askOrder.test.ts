// The Ask-order A/B config and the pre-registered read (progress toward 150, the primary, the 1.5x rule and the sign-ins tie-break).
import { describe, expect, it } from 'vitest'
import {
  ASK_ORDER_CALL_ASKS, ASK_ORDER_FEATURES, ASK_ORDER_GROUPS, ASK_ORDER_PRIMARY_MODE, ASK_ORDER_SWITCH_MULTIPLE, askOrderAssignedPath, askOrderFeatureId, askOrderOutcomePath,
  askOrderRespondedPath, askOrderShownPath, assignedStepId, outcomeRowsOf, outcomeStepId, readAskOrder, respondedStepId, responseRowsOf, shownStepId, stepCount, type AskOrderAllTime,
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
/** Once-per-device responded rows of a group: a count for the sign-in ask and/or the install ask. */
const responded = (g: G, c: { signin?: number; install?: number }, tag: 'organic' | 'tagged' = 'organic'): AskOrderAllTime => {
  const out: Record<string, number> = {}
  if (c.signin !== undefined) out[key(g, respondedStepId('signin', tag))] = c.signin
  if (c.install !== undefined) out[key(g, respondedStepId('install', tag))] = c.install
  return out
}
const merge = (...maps: AskOrderAllTime[]): AskOrderAllTime => Object.assign({}, ...maps)

describe('ask-order config', () => {
  it('has a feature per group with 26 unique steps, each on exactly one path and one tag', () => {
    expect(ASK_ORDER_FEATURES.map((f) => f.id)).toEqual(['ao-signin-first', 'ao-install-first'])
    for (const f of ASK_ORDER_FEATURES) {
      expect(f.steps).toHaveLength(26)
      expect(new Set(f.steps.map((s) => s.id)).size).toBe(26)
      for (const s of f.steps) {
        expect(s.match.exact).toHaveLength(1)
        expect(['organic', 'tagged']).toContain(s.match.tag)
      }
    }
  })

  it('uses the planned /ab/ask-order/<group>/... path shapes', () => {
    expect(askOrderAssignedPath('install-first')).toBe('/ab/ask-order/install-first/assigned')
    expect(askOrderShownPath('signin-first', 'install')).toBe('/ab/ask-order/signin-first/shown/install')
    expect(askOrderRespondedPath('install-first', 'signin')).toBe('/ab/ask-order/install-first/responded/signin')
    expect(askOrderOutcomePath('signin-first', 'signin', 'still-playing')).toBe('/ab/ask-order/signin-first/signin/still-playing')
    const paths = flatSteps(ASK_ORDER_FEATURES).flatMap((f) => f.step.match.exact!)
    expect(new Set(paths).size).toBe(26) // 13 paths a group, shared by the organic and tagged steps
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
  it('reads zero with nothing: null ratios, a preliminary verdict, the combined primary', () => {
    const r = readAskOrder({})
    expect(r.bothReachedCall).toBe(false)
    expect(r.primary.id).toBe('combined')
    for (const g of r.groups) {
      expect(g).toMatchObject({ assigned: 0, asksShown: 0, progress: 0, reachedCall: false, responseRows: 0, responseRowsPerAssigned: null, primaryRows: 0, primaryPerAssigned: null })
      expect(g.perOutcome['signed-in'].perAssigned).toBeNull()
    }
    for (const k of r.kinds) expect(k).toMatchObject({ larger: null, multiple: null })
    expect(r.rule).toMatchObject({ basis: 'primary', tieBreak: false, larger: null, multiple: null })
    expect(r.rule.verdict.state).toBe('preliminary')
  })

  it('counts asks shown over both asks and both tags (all traffic), capped at 150', () => {
    const all = merge(
      { [key('signin-first', shownStepId('signin', 'organic'))]: 20, [key('signin-first', shownStepId('install', 'organic'))]: 10, [key('signin-first', shownStepId('signin', 'tagged'))]: 10 },
      counts('install-first', { shown: 400 }),
    )
    const r = readAskOrder(all)
    expect(r.groups[0]).toMatchObject({ asksShown: 40, reachedCall: false })
    expect(r.groups[0].progress).toBeCloseTo(40 / ASK_ORDER_CALL_ASKS)
    expect(r.groups[1]).toMatchObject({ asksShown: 400, reachedCall: true, progress: 1 })
  })

  it('reaches the call point at exactly 150 asks shown, not 149', () => {
    const r = readAskOrder(merge(counts('signin-first', { shown: 150 }), counts('install-first', { shown: 149 })))
    expect(r.groups.map((g) => g.reachedCall)).toEqual([true, false])
    expect(r.bothReachedCall).toBe(false)
  })

  it('stays preliminary while only one group has reached the call point, still showing the multiple', () => {
    const all = merge(
      counts('signin-first', { assigned: 200, shown: 150, signedIn: 100 }),
      counts('install-first', { assigned: 200, shown: 149, signedIn: 10 }),
    )
    const r = readAskOrder(all)
    expect(r.bothReachedCall).toBe(false)
    expect(r.rule.multiple).toBeCloseTo(10) // shown as a preliminary number
    expect(r.rule.verdict.state).toBe('preliminary')
    expect(r.rule.verdict.note).toMatch(/Preliminary/)
    expect(r.rule.verdict.note).toContain('Install first 149 of 150')
    expect((r.rule.verdict as any).switchTo).toBeUndefined()
  })
})

describe('readAskOrder: which primary is active', () => {
  const both150 = (a: Parameters<typeof counts>[1], b: Parameters<typeof counts>[1]) =>
    merge(counts('signin-first', { shown: 150, ...a }), counts('install-first', { shown: 150, ...b }))

  it('auto, no responded row yet: combined response rows, and the label says the responded row is not seen yet', () => {
    const r = readAskOrder(both150({ assigned: 100, signedIn: 10, installed: 5 }, { assigned: 100, signedIn: 1 }))
    expect(ASK_ORDER_PRIMARY_MODE).toBe('auto')
    expect(r.primary.id).toBe('combined')
    expect(r.primary.label).toBe('Primary: combined response rows (responded row not seen yet)')
    expect(r.groups[0]).toMatchObject({ responseRows: 15, responseRowsPerAssigned: 0.15, primaryRows: 15, primaryPerAssigned: 0.15, respondedRows: 0 })
  })

  it('auto, a responded row seen in ANY group (organic or tagged): responded per assigned', () => {
    for (const grp of ['signin-first', 'install-first'] as const) {
      for (const tag of ['organic', 'tagged'] as const) {
        const r = readAskOrder(merge(both150({ assigned: 100, signedIn: 10 }, { assigned: 100, signedIn: 10 }), responded(grp, { install: 1 }, tag)))
        expect(r.primary.id, `${grp} ${tag}`).toBe('responded')
        expect(r.primary.label).toBe('Primary: responded per assigned (once-per-device row)')
      }
    }
  })

  it('the primary count of a group is its responded rows (both asks, both tags) when responded, its response rows when combined', () => {
    const all = merge(
      both150({ assigned: 100, signedIn: 30, installed: 30 }, { assigned: 50 }),
      responded('signin-first', { signin: 8, install: 4 }),
      responded('signin-first', { signin: 3 }, 'tagged'),
    )
    const r = readAskOrder(all)
    expect(r.groups[0]).toMatchObject({ responseRows: 60, respondedRows: 15, primaryRows: 15, primaryPerAssigned: 0.15 })
    expect(r.groups[0].byKind['signed-in'].count).toBe(11)
    expect(r.groups[0].byKind.installed.count).toBe(4)
    expect(readAskOrder(all, 'combined').groups[0]).toMatchObject({ primaryRows: 60, primaryPerAssigned: 0.6 })
  })

  it("mode 'combined' keeps the combined rows even when responded rows exist; mode 'responded' forces responded with none seen", () => {
    const withResponded = merge(both150({ assigned: 100, signedIn: 10 }, { assigned: 100, signedIn: 10 }), responded('signin-first', { signin: 5 }))
    const forcedCombined = readAskOrder(withResponded, 'combined')
    expect(forcedCombined.primary).toMatchObject({ id: 'combined', label: 'Primary: combined response rows (set by hand)' })
    const forcedResponded = readAskOrder(both150({ assigned: 100, signedIn: 10 }, { assigned: 100, signedIn: 10 }), 'responded')
    expect(forcedResponded.primary).toMatchObject({ id: 'responded' })
    expect(forcedResponded.primary.label).toContain('set by hand; no responded row seen yet')
    expect(forcedResponded.groups[0].primaryRows).toBe(0)
  })
})

describe('readAskOrder: the 1.5x rule on the active primary', () => {
  const both150 = (a: Parameters<typeof counts>[1], b: Parameters<typeof counts>[1]) =>
    merge(counts('signin-first', { shown: 150, ...a }), counts('install-first', { shown: 150, ...b }))
  const rule = (all: AskOrderAllTime, mode?: Parameters<typeof readAskOrder>[1]) => readAskOrder(all, mode).rule

  it('switches at exactly 1.5x once both groups reach 150', () => {
    const v = rule(both150({ assigned: 100, signedIn: 10 }, { assigned: 100, signedIn: 15 }))
    expect(v.larger).toBe('install-first')
    expect(v.multiple).toBeCloseTo(ASK_ORDER_SWITCH_MULTIPLE)
    expect(v.verdict).toMatchObject({ state: 'call', switchTo: 'install-first' })
  })

  it('compares integers, so exactly 1.5x is not lost to float division (3/20 over 1/10 is 1.4999999999999998 as floats)', () => {
    expect(3 / 20 / (1 / 10)).toBeLessThan(1.5)
    const v = rule(both150({ assigned: 10, signedIn: 1 }, { assigned: 20, signedIn: 3 }))
    expect(v.verdict).toMatchObject({ state: 'call', switchTo: 'install-first' })
  })

  it('keeps sign-in first just below 1.5x, even when install first is larger', () => {
    const v = rule(both150({ assigned: 100, signedIn: 100 }, { assigned: 100, signedIn: 149 }))
    expect(v.larger).toBe('install-first')
    expect(v.verdict).toMatchObject({ state: 'call', switchTo: null })
    expect(v.verdict.note).toMatch(/keep sign-in first/)
  })

  it('keeps sign-in first when it is the larger one, however large', () => {
    const v = rule(both150({ assigned: 100, signedIn: 40 }, { assigned: 100, signedIn: 10 }))
    expect(v.larger).toBe('signin-first')
    expect(v.verdict).toMatchObject({ state: 'call', switchTo: null })
    expect(v.verdict.note).toMatch(/keep sign-in first/)
  })

  it('a zero smaller rate against a positive larger one switches, with no multiple', () => {
    const v = rule(both150({ assigned: 100, signedIn: 0 }, { assigned: 100, signedIn: 3 }))
    expect(v).toMatchObject({ larger: 'install-first', multiple: null })
    expect(v.verdict).toMatchObject({ state: 'call', switchTo: 'install-first' })
  })

  it('both zero keeps sign-in first; a tie keeps it too', () => {
    expect(rule(both150({ assigned: 100 }, { assigned: 100 })).verdict).toMatchObject({ state: 'call', switchTo: null })
    const tie = rule(both150({ assigned: 100, installed: 5 }, { assigned: 100, installed: 5 }))
    expect(tie).toMatchObject({ larger: null, multiple: null })
    expect(tie.verdict).toMatchObject({ state: 'call', switchTo: null })
  })

  it('nobody assigned in a group gives null ratios and no switch', () => {
    const v = rule(both150({ assigned: 0, signedIn: 5 }, { assigned: 100, signedIn: 50 }))
    expect(v).toMatchObject({ larger: null, multiple: null })
    expect(v.verdict).toMatchObject({ state: 'call', switchTo: null })
  })

  it('combined primary: reads signed-in plus installed rows together, so the kinds are display only', () => {
    // Signed-in 2x, installed 1.05x, combined (10+20) vs (20+21): 1.37x, below the rule.
    const all = both150({ assigned: 100, signedIn: 10, installed: 20 }, { assigned: 100, signedIn: 20, installed: 21 })
    const r = readAskOrder(all)
    expect(r.kinds.map((k) => k.kind)).toEqual(['signed-in', 'installed'])
    expect(r.kinds[0]).toMatchObject({ larger: 'install-first' })
    expect(r.kinds[0].multiple).toBeCloseTo(2)
    expect(r.kinds[1].multiple).toBeCloseTo(1.05)
    expect(r.rule).toMatchObject({ basis: 'primary', tieBreak: false, larger: 'install-first' })
    expect(r.rule.multiple).toBeCloseTo(41 / 30)
    expect(r.rule.verdict).toMatchObject({ state: 'call', switchTo: null })
    expect(r.rule.verdict.note).toContain('response rows')
    // A device that both signs in and installs counts twice in the combined figure.
    expect(r.groups[0]).toMatchObject({ responseRows: 30, responseRowsPerAssigned: 0.3 })
  })

  it('responded primary: the rule reads the once-per-device rows and ignores the outcome rows', () => {
    // Outcome rows say 1:1; the responded rows say 10 vs 15 per 100 assigned: exactly 1.5x.
    const all = merge(
      both150({ assigned: 100, signedIn: 50, installed: 50 }, { assigned: 100, signedIn: 50, installed: 50 }),
      responded('signin-first', { signin: 6, install: 4 }),
      responded('install-first', { signin: 7 }),
      responded('install-first', { install: 8 }, 'tagged'),
    )
    const r = readAskOrder(all)
    expect(r.primary.id).toBe('responded')
    expect(r.rule).toMatchObject({ basis: 'primary', larger: 'install-first' })
    expect(r.rule.multiple).toBeCloseTo(1.5)
    expect(r.rule.verdict).toMatchObject({ state: 'call', switchTo: 'install-first' })
    expect(r.rule.verdict.note).toContain('responded rows')
    // Forcing the combined mode reads the outcome rows instead: a dead heat, keep sign-in first.
    expect(readAskOrder(all, 'combined').rule.verdict).toMatchObject({ state: 'call', switchTo: null })
  })

  it('responded primary: one group with no responded rows at all switches to the other', () => {
    const r = readAskOrder(merge(both150({ assigned: 100 }, { assigned: 100 }), responded('install-first', { signin: 2 })))
    expect(r.rule).toMatchObject({ larger: 'install-first', multiple: null })
    expect(r.rule.verdict).toMatchObject({ state: 'call', switchTo: 'install-first' })
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
    expect(r.rule.multiple).toBeCloseTo(1.5)
    expect(r.rule.verdict).toMatchObject({ state: 'call', switchTo: 'install-first' })
  })

  it('returns and still-playing are plain per-assigned row ratios from the group rows, outside the rule', () => {
    const r = readAskOrder(both150({ assigned: 50, returned: 10, stillPlaying: 5 }, { assigned: 0, returned: 3 }))
    expect(r.groups[0].perOutcome.returned).toMatchObject({ count: 10, perAssigned: 0.2 })
    expect(r.groups[0].perOutcome['still-playing']).toMatchObject({ count: 5, perAssigned: 0.1 })
    expect(r.groups[1].perOutcome.returned).toMatchObject({ count: 3, perAssigned: null })
    expect(r.groups[0].primaryRows).toBe(0)
  })
})

describe('readAskOrder: the sign-ins tie-break when the kinds point opposite ways', () => {
  const both150 = (a: Parameters<typeof counts>[1], b: Parameters<typeof counts>[1]) =>
    merge(counts('signin-first', { shown: 150, ...a }), counts('install-first', { shown: 150, ...b }))

  it('combined: sign-ins favour sign-in first, installs favour install first: sign-ins decide, keep sign-in first', () => {
    // Combined alone would be 10 vs 25 per 100 (2.5x install first).
    const r = readAskOrder(both150({ assigned: 100, signedIn: 10, installed: 0 }, { assigned: 100, signedIn: 5, installed: 20 }))
    expect(r.primary.id).toBe('combined')
    expect(r.rule).toMatchObject({ basis: 'sign-ins', tieBreak: true, larger: 'signin-first' })
    expect(r.rule.verdict).toMatchObject({ state: 'call', switchTo: null })
    expect(r.rule.verdict.note).toContain('sign-ins decide')
    expect(r.rule.verdict.note).toContain('signed-in rows')
  })

  it('combined: sign-ins favour install first 2x, installs favour sign-in first: sign-ins decide, switch', () => {
    // Combined alone would favour sign-in first (50 vs 25 per 100).
    const r = readAskOrder(both150({ assigned: 100, signedIn: 10, installed: 40 }, { assigned: 100, signedIn: 20, installed: 5 }))
    expect(r.rule).toMatchObject({ basis: 'sign-ins', tieBreak: true, larger: 'install-first' })
    expect(r.rule.multiple).toBeCloseTo(2)
    expect(r.rule.verdict).toMatchObject({ state: 'call', switchTo: 'install-first' })
  })

  it('combined: sign-ins decide by the same integer 1.5x test (just under keeps sign-in first)', () => {
    const r = readAskOrder(both150({ assigned: 100, signedIn: 100, installed: 40 }, { assigned: 100, signedIn: 149, installed: 5 }))
    expect(r.rule.tieBreak).toBe(true)
    expect(r.rule.verdict).toMatchObject({ state: 'call', switchTo: null })
  })

  it('responded: the responded sign-in rows decide', () => {
    const all = merge(
      both150({ assigned: 100 }, { assigned: 100 }),
      responded('signin-first', { signin: 10, install: 0 }),
      responded('install-first', { signin: 5, install: 20 }),
    )
    const r = readAskOrder(all)
    expect(r.primary.id).toBe('responded')
    expect(r.rule).toMatchObject({ basis: 'sign-ins', tieBreak: true, larger: 'signin-first' })
    expect(r.rule.verdict).toMatchObject({ state: 'call', switchTo: null })
    expect(r.rule.verdict.note).toContain('responded sign-in rows')
    const flipped = merge(
      both150({ assigned: 100 }, { assigned: 100 }),
      responded('signin-first', { signin: 10, install: 40 }),
      responded('install-first', { signin: 20, install: 5 }),
    )
    expect(readAskOrder(flipped).rule.verdict).toMatchObject({ state: 'call', switchTo: 'install-first' })
  })

  it('shows the tie-break note while preliminary too', () => {
    const r = readAskOrder(merge(counts('signin-first', { assigned: 100, shown: 10, signedIn: 10 }), counts('install-first', { assigned: 100, shown: 10, installed: 20 })))
    expect(r.rule.tieBreak).toBe(true)
    expect(r.rule.verdict.state).toBe('preliminary')
    expect(r.rule.verdict.note).toContain('sign-ins decide')
  })

  it('no tie-break when the kinds agree, or when one kind ties', () => {
    const agree = readAskOrder(both150({ assigned: 100, signedIn: 10, installed: 10 }, { assigned: 100, signedIn: 20, installed: 20 }))
    expect(agree.rule).toMatchObject({ basis: 'primary', tieBreak: false })
    const oneTies = readAskOrder(both150({ assigned: 100, signedIn: 10, installed: 5 }, { assigned: 100, signedIn: 10, installed: 20 }))
    expect(oneTies.kinds[0].larger).toBeNull()
    expect(oneTies.rule).toMatchObject({ basis: 'primary', tieBreak: false })
    expect(oneTies.rule.verdict.note).not.toContain('sign-ins decide')
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
