// Pairs the two sides of a move between the household's own accounts (checking -> card, savings ->
// checking) so neither counts as spending. Deterministic: the answer depends on the rows, never on the
// order they arrive in. Callers pass only rows the engine may change: a row whose kind_source is
// 'manual' or 'rule' is not a candidate (precedence manual > rule > auto), and neither is a paired row.
import type { Account, PairCandidate, TxnKind } from './types'
import { daysBetween } from './dates'

/** Kinds that can be one side of an own-account move. */
export const PAIRABLE_KINDS: readonly TxnKind[] = ['transfer', 'transfer_external', 'overdraft_move', 'card_payment', 'loan_payment',
  'loan_advance', 'debt_payment', 'spend']

/** Kinds that become 'transfer' once paired (a line wrongly taken for spending or for an outside payee). */
export const REKIND_ON_PAIR: readonly TxnKind[] = ['spend', 'transfer_external']

/**
 * Opposite sign, equal size, different accounts, dates within `windowDays`. When a side carries a
 * counterparty last4 it must be the other side's account last4. At least one side must be something
 * other than plain 'spend'. Matches confirmed by a last4 go first, then the closest date, then ids; each
 * row is used once. Returns [idA, idB] with idA < idB, sorted.
 */
export function pairTransfers(rows: readonly PairCandidate[], accounts: readonly Account[], windowDays = 5): Array<[string, string]> {
  const last4Of = new Map(accounts.map((a) => [a.id, a.last4]))
  const pool = rows.filter((r) => r.pairId === null && PAIRABLE_KINDS.includes(r.kind) && r.amountCents !== 0)
  // Bucket by amount so the work is proportional to real matches, not to n squared.
  const byAmount = new Map<number, PairCandidate[]>()
  for (const r of pool) {
    const b = byAmount.get(r.amountCents)
    if (b) b.push(r); else byAmount.set(r.amountCents, [r])
  }
  const edges: Array<{ a: PairCandidate; b: PairCandidate; gap: number; confirmed: boolean }> = []
  for (const [cents, neg] of byAmount) {
    if (cents >= 0) continue
    const pos = byAmount.get(-cents)
    if (!pos) continue
    for (const a of neg) {
      for (const b of pos) {
        if (a.accountId === b.accountId) continue
        if (a.kind === 'spend' && b.kind === 'spend') continue
        const gap = Math.abs(daysBetween(a.postedDate, b.postedDate))
        if (gap > windowDays) continue
        const la = last4Of.get(a.accountId) ?? null, lb = last4Of.get(b.accountId) ?? null
        if (a.counterpartyLast4 && a.counterpartyLast4 !== lb) continue
        if (b.counterpartyLast4 && b.counterpartyLast4 !== la) continue
        edges.push({ a, b, gap, confirmed: Boolean(a.counterpartyLast4 || b.counterpartyLast4) })
      }
    }
  }
  const key = (e: { a: PairCandidate; b: PairCandidate }) => (e.a.id < e.b.id ? [e.a.id, e.b.id] : [e.b.id, e.a.id])
  edges.sort((x, y) => {
    if (x.confirmed !== y.confirmed) return x.confirmed ? -1 : 1
    if (x.gap !== y.gap) return x.gap - y.gap
    const kx = key(x), ky = key(y)
    return kx[0] < ky[0] ? -1 : kx[0] > ky[0] ? 1 : kx[1] < ky[1] ? -1 : kx[1] > ky[1] ? 1 : 0
  })
  const used = new Set<string>()
  const out: Array<[string, string]> = []
  for (const e of edges) {
    if (used.has(e.a.id) || used.has(e.b.id)) continue
    used.add(e.a.id); used.add(e.b.id)
    const [p, q] = key(e)
    out.push([p, q])
  }
  return out.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : 1))
}
