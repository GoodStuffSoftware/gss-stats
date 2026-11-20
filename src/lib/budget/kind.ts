// Kind of a transaction from its wording, sign and account. Rules and manual edits sit above this
// (rules.ts); pairing sits below it (pairing.ts). Generic wording only.
import type { Account, Cents, TxnKind } from './types'
import type { NormalizedDesc } from './normalize'

export interface KindGuess { kind: TxnKind; confidence: number; source: 'hint' | 'auto' }

const RE_TRANSFER = /\b(?:TRANSFER|XFER|TFR|E-?TRANSFER)\b/
const RE_PAYMENT = /\b(?:PAYMENT|PMT|PYMT)\b/
const RE_OVERDRAFT = /\bOVERDRAFT\b|\bOD\s+PROT/
const RE_FEE = /\b(?:FEES?|NSF|CHARGE\s+FOR)\b/
const RE_INTEREST = /\bINTEREST\b|\bDIVIDEND\b/
const RE_PAYROLL = /\b(?:PAYROLL|DIRECT\s+DEP(?:OSIT)?|SALARY)\b/
const RE_REFUND = /\b(?:REFUND|RETURN|REVERSAL|CREDIT\s+VOUCHER)\b/

function ownAccount(n: NormalizedDesc, account: Account, accounts: Account[]): Account | null {
  if (!n.counterpartyLast4) return null
  const hits = accounts.filter((a) => a.id !== account.id && a.last4 === n.counterpartyLast4)
  if (hits.length === 0) return null
  if (hits.length > 1) {
    const text = n.clean
    const want = /\bCARD\b/.test(text) ? ['card'] : /\bLOAN\b|\bLINE\b|\bMORTGAGE\b/.test(text) ? ['loan', 'line_of_credit', 'external_debt'] : []
    const pick = hits.find((a) => want.includes(a.kind))
    if (pick) return pick
  }
  return [...hits].sort((a, b) => (a.id < b.id ? -1 : 1))[0]
}

function toOwn(target: Account, amount: Cents): KindGuess {
  switch (target.kind) {
    case 'card': return { kind: 'card_payment', confidence: 90, source: 'auto' }
    case 'loan':
    case 'line_of_credit': return { kind: amount < 0 ? 'loan_payment' : 'loan_advance', confidence: 90, source: 'auto' }
    case 'external_debt': return { kind: amount < 0 ? 'debt_payment' : 'loan_advance', confidence: 85, source: 'auto' }
    default: return { kind: 'transfer', confidence: 90, source: 'auto' }
  }
}

/**
 * Sign rule (types.ts): negative = a charge or money out, positive = a credit or money in.
 * Interest and fees on cards and loans are charges (negative); a positive line with those words is a
 * reversal. A card or loan statement shows the payment it received as a positive line.
 */
export function classifyKind(n: NormalizedDesc, amountCents: Cents, account: Account, accounts: Account[], hint?: TxnKind | null): KindGuess {
  if (hint) return { kind: hint, confidence: 100, source: 'hint' }
  const t = n.clean
  const out = amountCents < 0
  const inn = amountCents > 0
  if (amountCents === 0) return { kind: 'other', confidence: 20, source: 'auto' }

  if (account.kind === 'card') {
    if (inn) {
      if (RE_PAYMENT.test(t)) return { kind: 'card_payment', confidence: 90, source: 'auto' }
      if (RE_INTEREST.test(t)) return { kind: 'interest_charged', confidence: 60, source: 'auto' }
      return { kind: 'refund', confidence: 75, source: 'auto' }
    }
    if (RE_INTEREST.test(t)) return { kind: 'interest_charged', confidence: 90, source: 'auto' }
    if (RE_FEE.test(t)) return { kind: 'fee', confidence: 85, source: 'auto' }
    return { kind: 'spend', confidence: 60, source: 'auto' }
  }

  if (account.kind === 'loan' || account.kind === 'line_of_credit' || account.kind === 'external_debt') {
    if (inn) {
      if (RE_INTEREST.test(t) && !RE_PAYMENT.test(t)) return { kind: 'interest_charged', confidence: 60, source: 'auto' }
      return { kind: 'loan_payment', confidence: 85, source: 'auto' }
    }
    if (RE_INTEREST.test(t)) return { kind: 'interest_charged', confidence: 90, source: 'auto' }
    if (RE_FEE.test(t)) return { kind: 'fee', confidence: 85, source: 'auto' }
    return { kind: 'loan_advance', confidence: 80, source: 'auto' }
  }

  // Deposit accounts (checking, savings).
  if (RE_OVERDRAFT.test(t)) {
    if (RE_FEE.test(t)) return { kind: out ? 'fee' : 'refund', confidence: 85, source: 'auto' }
    return { kind: 'overdraft_move', confidence: 90, source: 'auto' }
  }
  const own = ownAccount(n, account, accounts)
  if (own && (RE_TRANSFER.test(t) || RE_PAYMENT.test(t))) return toOwn(own, amountCents)
  if (RE_TRANSFER.test(t)) return { kind: 'transfer_external', confidence: n.counterpartyLast4 ? 50 : 55, source: 'auto' }
  if (RE_INTEREST.test(t)) {
    return inn ? { kind: 'interest_earned', confidence: 85, source: 'auto' } : { kind: 'interest_charged', confidence: 80, source: 'auto' }
  }
  if (inn && RE_PAYROLL.test(t)) return { kind: 'income', confidence: 90, source: 'auto' }
  if (RE_FEE.test(t)) return out ? { kind: 'fee', confidence: 85, source: 'auto' } : { kind: 'refund', confidence: 65, source: 'auto' }
  if (inn) {
    if (RE_REFUND.test(t) || n.purchaseMmdd) return { kind: 'refund', confidence: 75, source: 'auto' }
    return { kind: 'income', confidence: 55, source: 'auto' }
  }
  return { kind: 'spend', confidence: 60, source: 'auto' }
}
