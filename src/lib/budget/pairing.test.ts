import { describe, expect, it } from 'vitest'
import { pairTransfers } from './pairing'
import { ACCOUNTS } from './__fixtures__/synthetic'
import type { PairCandidate } from './types'

const c = (id: string, accountId: string, postedDate: string, amountCents: number, kind: PairCandidate['kind'] = 'transfer',
  counterpartyLast4: string | null = null, pairId: string | null = null): PairCandidate =>
  ({ id, accountId, postedDate, amountCents, kind, counterpartyLast4, pairId })

describe('pairTransfers', () => {
  it('pairs opposite signs of equal size across accounts', () => {
    const rows = [c('a', 'chk-a', '2026-11-14', -50000), c('b', 'sav-a', '2026-11-14', 50000), c('z', 'chk-a', '2026-11-14', -700)]
    expect(pairTransfers(rows, ACCOUNTS)).toEqual([['a', 'b']])
  })
  it('respects the window, in days either way', () => {
    const far = [c('a', 'chk-a', '2026-11-14', -500), c('b', 'sav-a', '2026-11-20', 500)]
    expect(pairTransfers(far, ACCOUNTS)).toEqual([])
    expect(pairTransfers(far, ACCOUNTS, 6)).toEqual([['a', 'b']])
    expect(pairTransfers([c('a', 'chk-a', '2026-11-19', -500), c('b', 'sav-a', '2026-11-14', 500)], ACCOUNTS)).toEqual([['a', 'b']])
  })
  it('never pairs inside one account, same-sign rows or unequal sizes', () => {
    expect(pairTransfers([c('a', 'chk-a', '2026-11-14', -500), c('b', 'chk-a', '2026-11-14', 500)], ACCOUNTS)).toEqual([])
    expect(pairTransfers([c('a', 'chk-a', '2026-11-14', -500), c('b', 'sav-a', '2026-11-14', -500)], ACCOUNTS)).toEqual([])
    expect(pairTransfers([c('a', 'chk-a', '2026-11-14', -500), c('b', 'sav-a', '2026-11-14', 501)], ACCOUNTS)).toEqual([])
  })
  it('a stated counterparty must be the other account', () => {
    const wrong = [c('a', 'chk-a', '2026-11-14', -500, 'transfer', '0004'), c('b', 'sav-a', '2026-11-14', 500)]
    expect(pairTransfers(wrong, ACCOUNTS)).toEqual([])
    const right = [c('a', 'chk-a', '2026-11-14', -500, 'transfer', '0002'), c('b', 'sav-a', '2026-11-14', 500, 'transfer', '0001')]
    expect(pairTransfers(right, ACCOUNTS)).toEqual([['a', 'b']])
  })
  it('only own-account move kinds are candidates, and at least one side must not be plain spend', () => {
    expect(pairTransfers([c('a', 'chk-a', '2026-11-14', -500, 'spend'), c('b', 'sav-a', '2026-11-14', 500, 'income')], ACCOUNTS)).toEqual([])
    expect(pairTransfers([c('a', 'chk-a', '2026-11-14', -500, 'refund'), c('b', 'sav-a', '2026-11-14', 500, 'transfer')], ACCOUNTS)).toEqual([])
    expect(pairTransfers([c('a', 'chk-a', '2026-11-14', -500, 'spend'), c('b', 'sav-a', '2026-11-14', 500, 'transfer')], ACCOUNTS)).toEqual([['a', 'b']])
    expect(pairTransfers([c('a', 'chk-a', '2026-11-14', -500, 'spend'), c('b', 'sav-a', '2026-11-14', 500, 'spend')], ACCOUNTS)).toEqual([])
  })
  it('an already paired row is not a candidate', () => {
    expect(pairTransfers([c('a', 'chk-a', '2026-11-14', -500, 'transfer', null, 'zz'), c('b', 'sav-a', '2026-11-14', 500)], ACCOUNTS)).toEqual([])
  })
  it('takes the closest date first and uses each row once; ties go by id', () => {
    const rows = [c('a1', 'chk-a', '2026-11-10', -500), c('a2', 'chk-a', '2026-11-12', -500), c('b1', 'sav-a', '2026-11-11', 500)]
    expect(pairTransfers(rows, ACCOUNTS)).toEqual([['a1', 'b1']]) // both are 1 day away: the smaller id wins
    const rows2 = [c('a1', 'chk-a', '2026-11-10', -500), c('a2', 'chk-a', '2026-11-13', -500), c('b1', 'sav-a', '2026-11-13', 500)]
    expect(pairTransfers(rows2, ACCOUNTS)).toEqual([['a2', 'b1']])
  })
  it('a confirmed counterparty beats a closer unconfirmed match', () => {
    const rows = [c('a', 'chk-a', '2026-11-10', -500), c('b', 'sav-a', '2026-11-12', 500, 'transfer', '0001'), c('d', 'card-a', '2026-11-10', 500, 'card_payment')]
    expect(pairTransfers(rows, ACCOUNTS)).toEqual([['a', 'b']])
  })
  it('is deterministic under any shuffle of the input', () => {
    const rows: PairCandidate[] = []
    for (let i = 0; i < 6; i++) {
      rows.push(c(`o${i}`, 'chk-a', `2026-11-${String(10 + i).padStart(2, '0')}`, -500))
      rows.push(c(`i${i}`, i % 2 ? 'sav-a' : 'card-a', `2026-11-${String(11 + (i % 3)).padStart(2, '0')}`, 500, 'card_payment'))
    }
    const want = pairTransfers(rows, ACCOUNTS)
    expect(want.length).toBeGreaterThan(0)
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let n = 0; n < 25; n++) {
      const shuffled = [...rows].sort(() => rnd() - 0.5)
      expect(pairTransfers(shuffled, ACCOUNTS)).toEqual(want)
    }
  })
})
