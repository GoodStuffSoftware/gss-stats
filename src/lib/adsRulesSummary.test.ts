import { describe, expect, it } from 'vitest'
import { rulesSummary } from './adsRulesSummary'
import type { RuleResult } from './adsRules'

const rule = (id: string, status: RuleResult['status']): RuleResult => ({ id, status }) as RuleResult

describe('rulesSummary tone', () => {
  it('gives a watch count its own tone, distinct from clear', () => {
    const r = rulesSummary([rule('K1', 'clear'), rule('K2', 'clear'), rule('K3', 'watch')])
    expect(r.text).toBe('2 clear, 1 watch')
    expect(r.tone).toBe('watch')
    expect(r.tone).not.toBe('clear')
  })
  it('keeps clear for an all-clear, trip for a trip (a trip outranks watch), muted when unarmed', () => {
    expect(rulesSummary([rule('K1', 'clear'), rule('K2', 'no-data')]).tone).toBe('clear')
    expect(rulesSummary([rule('K1', 'watch'), rule('K2', 'trip')]).tone).toBe('trip')
    expect(rulesSummary([rule('K1', 'n/a')]).tone).toBe('muted')
    expect(rulesSummary(null).tone).toBe('muted')
  })
})
