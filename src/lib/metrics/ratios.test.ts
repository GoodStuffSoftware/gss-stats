// Ratio validity is checked, not documented (ADR 0003): every registered ratio passes
// ratioVerdict, and an invalid registration throws when the module loads.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineRatios, ratioVerdict, RATIO_DEFS, RATIOS, ratioWindowsOf, type RatioDef } from './ratios'
import { METRICS } from './metrics'
import { FUNNEL_STEP_ORDER, VALID_FUNNEL_RATE_STEPS, type FunnelStepKey } from '../campaigns'

describe('every registered ratio is valid', () => {
  it.each(RATIO_DEFS.map((r) => [r.id, r] as const))('%s passes ratioVerdict', (_id, r) => {
    const v = ratioVerdict(r)
    expect(v, v.reason).toMatchObject({ ok: true })
  })
  it('the registry holds every definition, each sharing at least one window', () => {
    expect(RATIOS.size).toBe(RATIO_DEFS.length)
    for (const r of RATIO_DEFS) expect(ratioWindowsOf(r).length, r.id).toBeGreaterThan(0)
  })
  it('costs are money over a count; pairs are counts only; alignDenominator only on proportions', () => {
    for (const r of RATIO_DEFS) {
      if (r.kind === 'cost') expect(METRICS.get(r.num)!.unit).toBe('usd')
      if (r.alignDenominator) expect(r.kind).toBe('proportion')
    }
  })
})

// The rate audit's funnel (ADR 0003 table rows 1-8), as the prototype checks it. The funnel
// step → metric map mirrors lib/campaigns.ts classifyFunnelPath.
const STEP_METRIC: Record<FunnelStepKey, string> = {
  arrivals: 'campaign.taggedArrivals',
  played: 'campaign.gameViews',
  completed: 'campaign.completions',
  ask: 'campaign.asks',
  accept: 'campaign.accepts',
  authSuccess: 'campaign.authSuccess',
  installPrompt: 'campaign.installPrompts',
  install: 'campaign.installs',
}

describe('the audit verdicts, reproduced mechanically', () => {
  it('step-over-previous-step is a valid proportion for exactly accept/ask and install/prompt — lib/campaigns.ts VALID_FUNNEL_RATE_STEPS', () => {
    const valid = new Set<FunnelStepKey>()
    for (let i = 1; i < FUNNEL_STEP_ORDER.length; i++) {
      const step = FUNNEL_STEP_ORDER[i]
      // install's real denominator is the install PROMPT (the step before is installPrompt too).
      const den = STEP_METRIC[FUNNEL_STEP_ORDER[i - 1]]
      if (ratioVerdict({ kind: 'proportion', num: STEP_METRIC[step], den }).ok) valid.add(step)
    }
    expect([...valid].sort()).toEqual([...VALID_FUNNEL_RATE_STEPS].sort())
  })
  it.each([
    ['played / arrivals (314.7%)', 'campaign.gameViews', 'campaign.taggedArrivals', 'unit pageview over device'],
    ['completed / played', 'campaign.completions', 'campaign.gameViews', 'unit completion over pageview'],
    ['ask / completed', 'campaign.asks', 'campaign.completions', 'unit showing over completion'],
    ['auth success / accept', 'campaign.authSuccess', 'campaign.accepts', 'unit signin over showing'],
    ['install prompt / auth success', 'campaign.installPrompts', 'campaign.authSuccess', 'unit showing over signin'],
    ['ask rate: asks / arrivals', 'campaign.asks', 'campaign.taggedArrivals', 'unit showing over device'],
    ['same unit, no subset: install prompts / asks', 'campaign.installPrompts', 'campaign.asks', 'same unit but no declared subset'],
  ])('%s is refused as a percentage', (_name, num, den, reason) => {
    expect(ratioVerdict({ kind: 'proportion', num, den })).toEqual({ ok: false, reason })
  })
  it('the same pairing is allowed as counts only', () => {
    expect(ratioVerdict({ kind: 'pair', num: 'campaign.gameViews', den: 'campaign.taggedArrivals' }).ok).toBe(true)
  })
  it('a cost must be money over a count', () => {
    expect(ratioVerdict({ kind: 'cost', num: 'campaign.taggedArrivals', den: 'campaign.spend' }).ok).toBe(false)
    expect(ratioVerdict({ kind: 'cost', num: 'campaign.spend', den: 'campaign.spend' }).ok).toBe(false)
  })
  it('an unknown metric is refused', () => {
    expect(ratioVerdict({ kind: 'pair', num: 'campaign.nope', den: 'campaign.asks' })).toEqual({ ok: false, reason: 'unknown metric' })
  })
})

describe('an invalid registration throws', () => {
  const bad = (over: Partial<RatioDef>): RatioDef => ({ id: 'campaign.bad', label: 'label.campaign.bad', kind: 'proportion', num: 'campaign.gameViews', den: 'campaign.taggedArrivals', ...over })
  it('defineRatios — the function the module runs at load — throws on the first invalid ratio', () => {
    expect(() => defineRatios([...RATIO_DEFS, bad({})])).toThrow(/campaign\.bad .*invalid: unit pageview over device/)
    expect(() => defineRatios([bad({ kind: 'cost' })])).toThrow(/cost needs usd over a count/)
    expect(() => defineRatios([bad({ kind: 'pair', label: 'Played a game' })])).toThrow(/label must be label\.campaign\.bad/)
    expect(() => defineRatios([bad({ kind: 'pair', alignDenominator: true })])).toThrow(/alignDenominator/)
    expect(() => defineRatios([RATIO_DEFS[0], RATIO_DEFS[0]])).toThrow(/duplicate/)
    // Review #5: a kind outside the union (registrations from untyped data) is refused at runtime.
    expect(() => defineRatios([bad({ kind: 'percent' as never, num: 'campaign.accepts', den: 'campaign.asks' })])).toThrow(/unknown kind percent/)
    expect(ratioVerdict({ kind: 'rate' as never, num: 'campaign.accepts', den: 'campaign.asks' })).toEqual({ ok: false, reason: 'unknown kind rate' })
  })

  afterEach(() => {
    vi.doUnmock('./metrics')
    vi.resetModules()
  })
  it('importing ratios.ts throws when a registered ratio stops being valid (here: installs lose their declared subset)', async () => {
    vi.resetModules()
    vi.doMock('./metrics', async (importOriginal) => {
      const orig = await importOriginal<typeof import('./metrics')>()
      const metrics = new Map(orig.METRICS)
      metrics.set('campaign.installs', { ...metrics.get('campaign.installs')!, subsetOf: undefined })
      return { ...orig, METRICS: metrics }
    })
    await expect(import('./ratios')).rejects.toThrow(/campaign\.installPerPrompt .*invalid: same unit but no declared subset/)
  })
})
