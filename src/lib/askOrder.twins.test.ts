// The /ab/ask-order twin rows are twins of real rows: they stay out of EVERY ask and outcome total, and
// no other card, read or classifier sees them. Only the Ask-order card reads them (src/lib/askOrder.ts).
import { describe, expect, it } from 'vitest'
import { flatSteps, FEATURES, stepMatches } from './featureHealth'
import { ASK_ORDER_FEATURES } from './askOrder'
import { classifyPopupPath, isAbTwinPath, isPopupEventPath, pathFamilyOf } from './popupEvents'
import { authSuccessRow, classifyFunnelPath } from './campaigns'
import { summarizeSiteEvents, summarizeTaggedRows } from './adsRules'

const twinPaths = [...new Set(flatSteps(ASK_ORDER_FEATURES).flatMap((f) => f.step.match.exact ?? []))]
const T = Date.parse('2026-10-20T15:00:00Z')

describe('ask-order twin rows: classification', () => {
  it('the new-shape paths are twins, popup-event paths of family ab-ask-order, and nothing else', () => {
    expect(twinPaths).toHaveLength(2 * 13)
    expect(twinPaths).toContain('/ab/ask-order/signin-first/responded/install')
    expect(twinPaths).toContain('/ab/ask-order/install-first/responded/signin')
    for (const p of twinPaths) {
      expect(isAbTwinPath(p), p).toBe(true)
      expect(isPopupEventPath(p), p).toBe(true)
      expect(pathFamilyOf(p), p).toBe('ab-ask-order')
      expect(classifyPopupPath(p), p).toBeNull()
      expect(authSuccessRow(p), p).toBeNull()
      expect(classifyFunnelPath(p), p).toBeNull()
    }
  })

  it('no Feature health step matches a twin path, tagged or not', () => {
    for (const p of twinPaths) {
      for (const { feature, step } of flatSteps(FEATURES)) {
        expect(stepMatches(step.match, p, ''), `${feature.id}.${step.id} ${p}`).toBe(false)
        expect(stepMatches(step.match, p, 'sudoku_tired_of_ads'), `${feature.id}.${step.id} ${p}`).toBe(false)
      }
    }
  })

  it('the Ask-order steps match only their own path, and only for their own tag', () => {
    for (const { feature, step } of flatSteps(ASK_ORDER_FEATURES)) {
      const [own] = step.match.exact!
      const tag = step.match.tag!
      expect(stepMatches(step.match, own, tag === 'tagged' ? 'uc' : ''), `${feature.id}.${step.id}`).toBe(true)
      expect(stepMatches(step.match, own, tag === 'tagged' ? '' : 'uc'), `${feature.id}.${step.id} other tag`).toBe(false)
      for (const other of twinPaths.filter((p) => p !== own)) expect(stepMatches(step.match, other, tag === 'tagged' ? 'uc' : ''), other).toBe(false)
    }
  })
})

describe('ask-order twin rows: no ads read total moves', () => {
  const real = [
    { hourStartMs: T, path: '/signin-prompt/placement', visitor: 'returning', count: 7 },
    { hourStartMs: T, path: '/signin-eligible/earned', visitor: 'returning', count: 4 },
    { hourStartMs: T, path: '/popup-outcome/signin-prompt/signed-in', visitor: 'returning', count: 3 },
    { hourStartMs: T, path: '/popup-outcome/install-prompt/installed', visitor: 'new', count: 2 },
    { hourStartMs: T, path: '/auth/success/google/new', visitor: 'new', count: 2 },
    { hourStartMs: T, path: '/game/start/easy', visitor: 'new', count: 9 },
    { hourStartMs: T, path: '/install/inapp/open/instagram', visitor: 'new', count: 1 },
  ]
  const twins = twinPaths.map((path) => ({ hourStartMs: T, path, visitor: 'returning', count: 100 }))

  it('tagged summary is identical with and without twin rows', () => {
    expect(summarizeTaggedRows([...real, ...twins])).toEqual(summarizeTaggedRows(real))
  })

  it('site-wide summary is identical with and without twin rows', () => {
    const strip = (rows: typeof real) => rows.map(({ hourStartMs, path, count }) => ({ hourStartMs, path, count }))
    const matured = T + 86_400_000
    expect(summarizeSiteEvents(strip([...real, ...twins]), matured)).toEqual(summarizeSiteEvents(strip(real), matured))
  })
})
