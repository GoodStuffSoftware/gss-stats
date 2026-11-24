import { describe, expect, it } from 'vitest'
import {
  AUTO_APPLY_DEFAULT, AUTO_MIN_SCORE, candidateWindow, chargedCents, dominantHint, isStale, matchReceipt, matchReceipts,
  normalizeDate, toCents, type MatchBankRow, type MatchReceipt,
} from './receiptMatch'

// Made-up merchants and amounts only.
function rcpt(over: Partial<MatchReceipt> = {}): MatchReceipt {
  return {
    id: 'r1', kind: 'purchase', merchant: 'Acme Widgets', paymentVia: 'card', cardLast4: null, orderRef: null,
    emailDate: '2026-03-10', receiptDate: '2026-03-10', relatedDate: null, totalCents: 2599, charges: [], items: [], ...over,
  }
}
function row(over: Partial<MatchBankRow> = {}): MatchBankRow {
  return {
    id: 't1', accountId: 'a1', accountLast4: '1111', postedDate: '2026-03-12', amountCents: -2599, kind: 'spend',
    merchantKey: 'acme-widgets', merchantName: 'ACME WIDGETS 0042', categoryId: null, updatedAt: '2026-03-12T00:00:00.000Z',
    personEdited: false, ...over,
  }
}
const ids = (r: ReturnType<typeof matchReceipt>) => r.proposals.flatMap((p) => p.parts.map((x) => x.txnId))

describe('constants', () => {
  it('auto-apply is off by default and the threshold is 90', () => {
    expect(AUTO_APPLY_DEFAULT).toBe(false)
    expect(AUTO_MIN_SCORE).toBe(90)
  })
})

describe('exact match and score', () => {
  it('matches the exact amount and scores 95 with family and a unique candidate', () => {
    const res = matchReceipt(rcpt(), [row()])
    expect(res.status).toBe('suggested')
    expect(res.winner?.parts[0].txnId).toBe('t1')
    expect(res.winner?.rule).toBe('exact')
    expect(res.winner?.score).toBe(95) // 50 + 20 + 15 + 10
  })
  it('adds 5 for card_last4 equal to the account last4', () => {
    expect(matchReceipt(rcpt({ cardLast4: '1111' }), [row()]).winner?.score).toBe(100)
    expect(matchReceipt(rcpt({ cardLast4: '2222' }), [row()]).winner?.score).toBe(95)
  })
  it('rejects a near amount (one cent off)', () => {
    expect(matchReceipt(rcpt(), [row({ amountCents: -2600 })]).status).toBe('unmatched')
    expect(matchReceipt(rcpt(), [row({ amountCents: -2598 })]).status).toBe('unmatched')
  })
  it('without a family match the score is 80 and still shown', () => {
    const res = matchReceipt(rcpt(), [row({ merchantKey: 'zzz-other', merchantName: 'ZZZ OTHER' })])
    expect(res.winner?.score).toBe(80)
  })
  it('a receipt using the stated single charge matches that charge, not the total', () => {
    const r = rcpt({ totalCents: 3000, charges: [{ amountCents: 2599, last4: null }] })
    expect(chargedCents(r)).toBe(2599)
    expect(matchReceipt(r, [row()]).winner?.parts[0].txnId).toBe('t1')
  })
  it('ignores rows of the wrong direction or kind', () => {
    expect(matchReceipt(rcpt(), [row({ amountCents: 2599 })]).status).toBe('unmatched')
    expect(matchReceipt(rcpt(), [row({ kind: 'card_payment' })]).status).toBe('unmatched')
  })
  it('skips rows already taken', () => {
    expect(matchReceipt(rcpt(), [row()], {}, { takenTxnIds: ['t1'] }).status).toBe('unmatched')
  })
  it('no total means no_total and no match', () => {
    expect(matchReceipt(rcpt({ totalCents: null }), [row()]).status).toBe('no_total')
    expect(matchReceipt(rcpt({ totalCents: 0 }), [row({ amountCents: 0 })]).status).toBe('no_total')
  })
})

describe('date window (purchase -3/+10)', () => {
  const at = (d: string) => matchReceipt(rcpt(), [row({ postedDate: d })]).status
  it('includes both edges', () => {
    expect(at('2026-03-07')).toBe('suggested') // -3
    expect(at('2026-03-20')).toBe('suggested') // +10
  })
  it('excludes one day outside each edge', () => {
    expect(at('2026-03-06')).toBe('unmatched') // -4
    expect(at('2026-03-21')).toBe('unmatched') // +11
  })
  it('date points: 0-5 days +20, 6-10 days +10', () => {
    const score = (d: string) => matchReceipt(rcpt(), [row({ postedDate: d })]).winner?.score
    expect(score('2026-03-15')).toBe(95) // +5
    expect(score('2026-03-16')).toBe(85) // +6
    expect(score('2026-03-20')).toBe(85) // +10
    expect(score('2026-03-07')).toBe(95) // -3
  })
  it('uses email_date when receipt_date is missing', () => {
    const r = rcpt({ receiptDate: null, emailDate: '2026-03-10' })
    expect(matchReceipt(r, [row({ postedDate: '2026-03-20' })]).status).toBe('suggested')
    expect(matchReceipt(r, [row({ postedDate: '2026-03-21' })]).status).toBe('unmatched')
  })
  it('window arithmetic crosses month, year and DST boundaries without drift', () => {
    const r = rcpt({ receiptDate: '2026-12-25', emailDate: '2026-12-25' })
    expect(matchReceipt(r, [row({ postedDate: '2027-01-04' })]).status).toBe('suggested') // +10
    expect(matchReceipt(r, [row({ postedDate: '2027-01-05' })]).status).toBe('unmatched') // +11
    const dst = rcpt({ receiptDate: '2026-03-05', emailDate: '2026-03-05' }) // US spring-forward 2026-03-08
    expect(matchReceipt(dst, [row({ postedDate: '2026-03-15' })]).status).toBe('suggested')
    expect(matchReceipt(dst, [row({ postedDate: '2026-03-16' })]).status).toBe('unmatched')
  })
  it('candidateWindow reports the inclusive bounds', () => {
    expect(candidateWindow({ kind: 'purchase', emailDate: '2026-03-10', receiptDate: null })).toEqual({ from: '2026-03-07', to: '2026-03-20' })
    expect(candidateWindow({ kind: 'refund', emailDate: '2026-03-10', receiptDate: null })).toEqual({ from: '2026-03-07', to: '2026-03-31' })
    expect(candidateWindow({ kind: 'purchase', emailDate: 'nope', receiptDate: null })).toBeNull()
  })
})

describe('timezone and date-only inputs', () => {
  it('normalizeDate keeps the written calendar date and does not convert zones', () => {
    expect(normalizeDate('2026-03-10')).toBe('2026-03-10')
    expect(normalizeDate('2026-03-10T23:30:00-08:00')).toBe('2026-03-10')
    expect(normalizeDate('2026-03-10T00:15:00+09:00')).toBe('2026-03-10')
    expect(normalizeDate('2026-03-10T23:59:59Z')).toBe('2026-03-10')
    expect(normalizeDate('2026-03-10 08:00')).toBe('2026-03-10')
  })
  it('rejects impossible or malformed dates', () => {
    expect(normalizeDate('2026-02-30')).toBeNull()
    expect(normalizeDate('03/10/2026')).toBeNull()
    expect(normalizeDate('')).toBeNull()
    expect(normalizeDate(null)).toBeNull()
    expect(normalizeDate(20260310)).toBeNull()
  })
  it('date-time receipt and bank inputs behave like date-only ones', () => {
    const r = rcpt({ receiptDate: '2026-03-10T23:30:00-08:00' })
    expect(matchReceipt(r, [row({ postedDate: '2026-03-20T00:00:00Z' })]).status).toBe('suggested')
    expect(matchReceipt(r, [row({ postedDate: '2026-03-21T00:00:00Z' })]).status).toBe('unmatched')
  })
  it('an unreadable receipt date gives unmatched, not a throw', () => {
    expect(matchReceipt(rcpt({ receiptDate: 'garbage', emailDate: 'garbage' }), [row()]).status).toBe('unmatched')
  })
})

describe('cents rounding', () => {
  it('toCents rounds float noise and refuses fractions of a cent', () => {
    expect(toCents(19.99 * 100)).toBe(1999)
    expect(toCents(1998.9999999999998)).toBe(1999)
    expect(toCents(1999.5)).toBeNull()
    expect(toCents(NaN)).toBeNull()
    expect(toCents('5')).toBeNull()
  })
  it('matches an amount carrying float noise exactly', () => {
    const r = rcpt({ totalCents: 19.99 * 100 })
    expect(matchReceipt(r, [row({ amountCents: -1999 })]).status).toBe('suggested')
  })
  it('a half-cent total never matches', () => {
    expect(matchReceipt(rcpt({ totalCents: 2599.5 }), [row({ amountCents: -2600 })]).status).toBe('no_total')
  })
})

describe('ties and ambiguity', () => {
  it('two equal rows: both suggested (floored at 60), no single winner, never auto', () => {
    const res = matchReceipt(rcpt(), [row({ id: 't1' }), row({ id: 't2', postedDate: '2026-03-13' })], { autoApply: true })
    expect(res.status).toBe('suggested')
    expect(res.winner).toBeNull()
    expect(res.proposals.map((p) => p.score)).toEqual([60, 60]) // 50 + 20 + 15 - 30 = 55, floored at 60
    expect(res.proposals.every((p) => !p.unique && !p.autoEligible)).toBe(true)
  })
  it('a tie with a card_last4 hit scores above the floor', () => {
    const res = matchReceipt(rcpt({ cardLast4: '1111' }), [row({ id: 't1' }), row({ id: 't2' })])
    expect(res.proposals.map((p) => p.score)).toEqual([60, 60]) // 50 + 20 + 15 + 5 - 30 = 60
    expect(res.winner).toBeNull()
  })
  it('two receipts competing for one row weaken each other and neither wins', () => {
    const out = matchReceipts([rcpt({ id: 'r1' }), rcpt({ id: 'r2' })], [row()])
    for (const o of out) {
      expect(o.winner).toBeNull()
      expect(o.proposals[0].unique).toBe(false)
      expect(o.proposals[0].score).toBe(60)
    }
  })
  it('different amounts do not compete', () => {
    const out = matchReceipts([rcpt({ id: 'r1' }), rcpt({ id: 'r2', totalCents: 4000 })], [row(), row({ id: 't2', amountCents: -4000 })])
    expect(out[0].winner?.parts[0].txnId).toBe('t1')
    expect(out[1].winner?.parts[0].txnId).toBe('t2')
  })
})

describe('auto-apply gating', () => {
  const r = rcpt({ cardLast4: '1111' }) // 100
  it('is never eligible by default', () => {
    expect(matchReceipt(r, [row()]).winner?.autoEligible).toBe(false)
  })
  it('is eligible only with autoApply on, exact rule, unique, score >= 90, row not person-edited', () => {
    expect(matchReceipt(r, [row()], { autoApply: true }).winner?.autoEligible).toBe(true)
    expect(matchReceipt(r, [row({ personEdited: true })], { autoApply: true }).winner?.autoEligible).toBe(false)
    // 80 without a family match: suggested but below 90
    const low = matchReceipt(rcpt(), [row({ merchantKey: 'zzz', merchantName: 'ZZZ' })], { autoApply: true })
    expect(low.winner?.score).toBe(80)
    expect(low.winner?.autoEligible).toBe(false)
  })
  it('a lowered threshold is honored', () => {
    const low = matchReceipt(rcpt(), [row({ merchantKey: 'zzz', merchantName: 'ZZZ' })], { autoApply: true, autoMinScore: 80 })
    expect(low.winner?.autoEligible).toBe(true)
  })
})

describe('refunds', () => {
  const refund = (over: Partial<MatchReceipt> = {}) => rcpt({ id: 'rf', kind: 'refund', ...over })
  const credit = (over: Partial<MatchBankRow> = {}) => row({ id: 'c1', kind: 'refund', amountCents: 2599, ...over })
  it('matches a refund row of the same absolute amount', () => {
    const res = matchReceipt(refund(), [credit()])
    expect(res.winner?.rule).toBe('refund')
    expect(res.winner?.parts[0].txnId).toBe('c1')
  })
  it('window is -3 to +21', () => {
    expect(matchReceipt(refund(), [credit({ postedDate: '2026-03-31' })]).status).toBe('suggested') // +21
    expect(matchReceipt(refund(), [credit({ postedDate: '2026-04-01' })]).status).toBe('unmatched') // +22
    expect(matchReceipt(refund(), [credit({ postedDate: '2026-03-07' })]).status).toBe('suggested') // -3
    expect(matchReceipt(refund(), [credit({ postedDate: '2026-03-06' })]).status).toBe('unmatched') // -4
  })
  it('a day 11-21 out adds no date points', () => {
    expect(matchReceipt(refund(), [credit({ postedDate: '2026-03-25' })]).winner?.score).toBe(75) // 50 + 0 + 15 + 10
  })
  it('does not match a spend row, and a purchase does not match a refund row', () => {
    expect(matchReceipt(refund(), [row()]).status).toBe('unmatched')
    expect(matchReceipt(rcpt(), [credit()]).status).toBe('unmatched')
  })
  it('takes its category from the original receipt with the same order_ref', () => {
    const orig = rcpt({ id: 'r0', orderRef: 'ORD-1', items: [{ description: 'x', amountCents: 2599, categoryHint: 'home' }] })
    const rf = refund({ orderRef: 'ORD-1' })
    const out = matchReceipts([orig, rf], [credit()])
    expect(out[1].winner?.proposedCategoryId).toBe('home')
  })
})

describe('proposed category', () => {
  const items = [
    { description: 'a', amountCents: 2000, categoryHint: 'home', quantity: 1 },
    { description: 'b', amountCents: 599, categoryHint: 'fun', quantity: 1 },
  ]
  it('uses the dominant hint when the row category is null or broad', () => {
    expect(matchReceipt(rcpt({ items }), [row()]).winner?.proposedCategoryId).toBe('home')
    expect(matchReceipt(rcpt({ items }), [row({ categoryId: 'shopping' })]).winner?.proposedCategoryId).toBe('home')
    expect(matchReceipt(rcpt({ items }), [row({ categoryId: 'other' })]).winner?.proposedCategoryId).toBe('home')
  })
  it('leaves a specific category alone', () => {
    expect(matchReceipt(rcpt({ items }), [row({ categoryId: 'groceries' })]).winner?.proposedCategoryId).toBeNull()
  })
  it('a tied hint proposes nothing', () => {
    expect(dominantHint([{ description: 'a', amountCents: 100, categoryHint: 'x' }, { description: 'b', amountCents: 100, categoryHint: 'y' }])).toBeNull()
    expect(dominantHint([])).toBeNull()
  })
})

describe('splits are suggest-only', () => {
  it('one order over two charges: 2 rows summing to the total', () => {
    const r = rcpt({ totalCents: 5000, charges: [{ amountCents: 3000, last4: null }, { amountCents: 2000, last4: null }] })
    const res = matchReceipt(r, [row({ id: 's1', amountCents: -3000 }), row({ id: 's2', amountCents: -2000, postedDate: '2026-03-14' })], { autoApply: true })
    expect(res.status).toBe('suggested')
    expect(res.winner).toBeNull()
    const p = res.proposals[0]
    expect(p.rule).toBe('split_charges')
    expect(p.split).toBe(true)
    expect(p.autoEligible).toBe(false)
    expect(p.parts.map((x) => x.txnId).sort()).toEqual(['s1', 's2'])
    expect(p.parts.map((x) => x.shareCents).sort()).toEqual([2000, 3000])
    expect(p.score).toBe(75) // 50 + 20 + 15 + 10 - 20
    expect(p.groupKey.length).toBeLessThanOrEqual(40)
  })
  it('three charges are found, and stated charges must equal the row amounts', () => {
    const rows = [
      row({ id: 's1', amountCents: -1000 }), row({ id: 's2', amountCents: -1500 }), row({ id: 's3', amountCents: -2500 }),
      row({ id: 's4', amountCents: -2000 }),
    ]
    const r = rcpt({ totalCents: 5000, charges: [{ amountCents: 1000, last4: null }, { amountCents: 1500, last4: null }, { amountCents: 2500, last4: null }] })
    const res = matchReceipt(r, rows)
    expect(res.proposals.map((p) => p.parts.map((x) => x.txnId).sort())).toEqual([['s1', 's2', 's3']])
  })
  it('requires the family to match', () => {
    const r = rcpt({ totalCents: 5000 })
    const rows = [row({ id: 's1', amountCents: -3000, merchantKey: 'zzz', merchantName: 'ZZZ' }), row({ id: 's2', amountCents: -2000, merchantKey: 'zzz', merchantName: 'ZZZ' })]
    expect(matchReceipt(r, rows).status).toBe('unmatched')
  })
  it('two possible subsets score lower and stay ambiguous', () => {
    const rows = [row({ id: 's1', amountCents: -3000 }), row({ id: 's2', amountCents: -2000 }), row({ id: 's3', amountCents: -2000 }), row({ id: 's4', amountCents: -3000 })]
    const res = matchReceipt(rcpt({ totalCents: 5000 }), rows)
    expect(res.proposals.length).toBe(4)
    expect(res.proposals.every((p) => p.score === 60 && !p.autoEligible)).toBe(true)
    expect(res.winner).toBeNull()
  })
  it('a single exact row beats trying a split', () => {
    const rows = [row({ id: 'whole', amountCents: -5000 }), row({ id: 's1', amountCents: -3000 }), row({ id: 's2', amountCents: -2000 })]
    const res = matchReceipt(rcpt({ totalCents: 5000 }), rows)
    expect(res.proposals.map((p) => p.rule)).toEqual(['exact'])
  })
  it('split search is bounded to 12 candidates (closest dates first)', () => {
    const noise = Array.from({ length: 12 }, (_, i) => row({ id: `n${String(i).padStart(2, '0')}`, amountCents: -(100 + i), postedDate: '2026-03-10' }))
    const far = [row({ id: 'f1', amountCents: -3000, postedDate: '2026-03-20' }), row({ id: 'f2', amountCents: -2000, postedDate: '2026-03-20' })]
    expect(matchReceipt(rcpt({ totalCents: 5000 }), [...noise, ...far]).status).toBe('unmatched')
  })
  it('several receipts of one order summing to one charge (split_receipts)', () => {
    const a = rcpt({ id: 'ra', orderRef: 'ORD-9', totalCents: 1200 })
    const b = rcpt({ id: 'rb', orderRef: 'ORD-9', totalCents: 800, emailDate: '2026-03-11', receiptDate: '2026-03-11' })
    const out = matchReceipts([a, b], [row({ id: 'one', amountCents: -2000 })], { autoApply: true })
    for (const o of out) {
      expect(o.winner).toBeNull()
      expect(o.proposals[0].rule).toBe('split_receipts')
      expect(o.proposals[0].autoEligible).toBe(false)
      expect(o.proposals[0].parts.map((p) => [p.receiptId, p.shareCents]).sort()).toEqual([['ra', 1200], ['rb', 800]])
    }
    expect(out[0].proposals[0].groupKey).toBe(out[1].proposals[0].groupKey)
  })
  it('receipts with different order_refs are not summed', () => {
    const a = rcpt({ id: 'ra', orderRef: 'ORD-1', totalCents: 1200 })
    const b = rcpt({ id: 'rb', orderRef: 'ORD-2', totalCents: 800 })
    expect(matchReceipts([a, b], [row({ id: 'one', amountCents: -2000 })]).map((o) => o.status)).toEqual(['unmatched', 'unmatched'])
  })
})

describe('payment services and declines', () => {
  it('a payment-service receipt matches on the service word although the payee differs', () => {
    const r = rcpt({ merchant: 'Some Payee', paymentVia: 'paypal' })
    const res = matchReceipt(r, [row({ merchantKey: 'paypal', merchantName: 'PAYPAL TRANSFER' })])
    expect(res.winner?.score).toBe(95)
  })
  it('a payment_sent via venmo needs a venmo-named debit', () => {
    const r = rcpt({ kind: 'payment_sent', merchant: 'Pat Example', paymentVia: 'venmo' })
    expect(matchReceipt(r, [row({ merchantKey: 'venmo', merchantName: 'VENMO PAYMENT', kind: 'transfer_external' })]).status).toBe('suggested')
    expect(matchReceipt(r, [row({ merchantKey: 'acme-widgets' })]).status).toBe('unmatched')
  })
  it('a decline links the later retried charge, suggest-only, and names same-day fees', () => {
    const d = rcpt({ id: 'rd', kind: 'decline', receiptDate: '2026-03-10', relatedDate: '2026-03-08' })
    const retry = row({ id: 'retry', postedDate: '2026-03-12' })
    const early = row({ id: 'early', postedDate: '2026-03-07', amountCents: -2599 })
    const fee = row({ id: 'fee', postedDate: '2026-03-10', amountCents: -500, kind: 'fee' })
    const res = matchReceipt(d, [early, retry, fee], { autoApply: true })
    expect(ids(res)).toEqual(['retry'])
    expect(res.proposals[0].rule).toBe('decline_retry')
    expect(res.proposals[0].autoEligible).toBe(false)
    expect(res.proposals[0].proposedCategoryId).toBeNull()
    expect(res.proposals[0].explainsTxnIds).toEqual(['fee'])
    expect(res.winner).toBeNull()
  })
})

describe('staleness helper', () => {
  it('goes stale after 75 days', () => {
    expect(isStale({ emailDate: '2026-01-01', receiptDate: null }, '2026-03-17')).toBe(false) // 75
    expect(isStale({ emailDate: '2026-01-01', receiptDate: null }, '2026-03-18')).toBe(true) // 76
  })
})
