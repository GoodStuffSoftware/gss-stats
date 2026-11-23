import { describe, expect, it } from 'vitest'
import { defaultSameAmount, lockedByRule, preTick, ticked, visibleRows } from './similar'
import { defaultTxnViewPrefs, withSameAmount } from './txnView'
import type { SimilarResponse, SimilarRow } from './types'

const row = (o: Partial<SimilarRow> & { id: string }): SimilarRow => ({
  postedDate: '2026-01-05', amountCents: -2399, merchantName: 'Acme Hardware', description: 'ACME', accountId: 'a1', kind: 'spending',
  categoryId: 'c1', categorySource: 'rule', updatedAt: 't1', note: null, personSet: false, scriptSet: false, sameAmount: true, suggestTick: true, ...o,
}) as SimilarRow
const resp = (mixed: boolean): Pick<SimilarResponse, 'mixed' | 'source'> => ({ mixed, source: { id: 's', merchantKey: 'acme', amountCents: -2399, categoryId: 'c2' } })

describe('defaultSameAmount', () => {
  it('follows mixed with no saved choice', () => {
    expect(defaultSameAmount(resp(true), defaultTxnViewPrefs())).toBe(true)
    expect(defaultSameAmount(resp(false), defaultTxnViewPrefs())).toBe(false)
  })
  it('a saved choice wins either way', () => {
    expect(defaultSameAmount(resp(true), withSameAmount(defaultTxnViewPrefs(), 'acme', false))).toBe(false)
    expect(defaultSameAmount(resp(false), withSameAmount(defaultTxnViewPrefs(), 'acme', true))).toBe(true)
  })
})

describe('rows', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', sameAmount: false, amountCents: 500 })]
  it('the filter keeps only exact amounts', () => {
    expect(visibleRows(rows, true).map((r) => r.id)).toEqual(['a'])
    expect(visibleRows(rows, false).map((r) => r.id)).toEqual(['a', 'b'])
  })
  it('pre-tick is the server suggestion', () => {
    expect(preTick(row({ id: 'x', suggestTick: false }))).toBe(false)
    expect(preTick(row({ id: 'x' }))).toBe(true)
  })
  it('the rule locks rows no person or script chose', () => {
    expect(lockedByRule(row({ id: 'x' }), true)).toBe(true)
    expect(lockedByRule(row({ id: 'x' }), false)).toBe(false)
    expect(lockedByRule(row({ id: 'x', personSet: true }), true)).toBe(false)
    expect(lockedByRule(row({ id: 'x', scriptSet: true }), true)).toBe(false)
  })
  it('ticked adds locked rows to the person ticks', () => {
    const rs = [row({ id: 'a' }), row({ id: 'p', personSet: true }), row({ id: 'q', personSet: true })]
    expect(ticked(rs, new Set(['p']), true)).toEqual(['a', 'p'])
    expect(ticked(rs, new Set(['p']), false)).toEqual(['p'])
  })
})
