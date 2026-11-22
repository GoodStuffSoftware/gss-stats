// Pure loan arithmetic for the Loans page: integer cents, APR in basis points (1999 = 19.99%). No I/O.

export type PayoffResult =
  | { kind: 'paid_off'; months: number }          // already at or below zero: months = 0
  | { kind: 'payoff'; months: number }            // whole months, rounded up
  | { kind: 'rate_unknown'; months: number }      // APR missing: balance / payment, rounded up
  | { kind: 'not_paid_off' }                      // payment does not beat the monthly interest
  | { kind: 'no_payment' }                        // no usable payment or balance

/** Months to pay a balance off at a fixed monthly payment: n = -ln(1 - rB/P) / ln(1 + r), r = APR/1200. */
export function monthsToPayoff(balanceCents: number | null, aprBp: number | null, monthlyPaymentCents: number | null): PayoffResult {
  if (balanceCents == null || !Number.isFinite(balanceCents)) return { kind: 'no_payment' }
  if (balanceCents <= 0) return { kind: 'paid_off', months: 0 }
  if (monthlyPaymentCents == null || !Number.isFinite(monthlyPaymentCents) || monthlyPaymentCents <= 0) return { kind: 'no_payment' }
  const ceil = (n: number) => Math.max(1, Math.ceil(n - 1e-9))
  if (aprBp == null || !Number.isFinite(aprBp)) return { kind: 'rate_unknown', months: ceil(balanceCents / monthlyPaymentCents) }
  const r = aprBp / 120000
  if (r <= 0) return { kind: 'payoff', months: ceil(balanceCents / monthlyPaymentCents) }
  const x = (r * balanceCents) / monthlyPaymentCents
  if (x >= 1) return { kind: 'not_paid_off' }
  return { kind: 'payoff', months: ceil(-Math.log(1 - x) / Math.log(1 + r)) }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The month-year ("Mar 2028") that `months` whole months after `asOf` ('YYYY-MM-DD') lands in; null for a bad date. */
export function payoffMonth(asOf: string, months: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf)
  if (!m || !Number.isFinite(months)) return null
  const mon = Number(m[2])
  if (mon < 1 || mon > 12) return null
  const idx = Number(m[1]) * 12 + (mon - 1) + Math.max(0, Math.trunc(months))
  return `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`
}

/** Estimated interest for one month: balance x APR/12, rounded to the cent. Null without both inputs. */
export function monthlyInterestCents(balanceCents: number | null, aprBp: number | null): number | null {
  if (balanceCents == null || aprBp == null) return null
  if (balanceCents <= 0) return 0
  return Math.round((balanceCents * aprBp) / 120000)
}

export type PaymentEvery = 'monthly' | 'semimonthly' | 'biweekly'
export type PaymentSource = 'scheduled' | 'from payments'
export interface MonthlyPayment { cents: number; source: PaymentSource }

/** A scheduled payment normalised to a month: biweekly x 26/12, semimonthly x 2. */
export function scheduledMonthlyCents(paymentCents: number, every: PaymentEvery): number {
  if (every === 'biweekly') return Math.round((paymentCents * 26) / 12)
  if (every === 'semimonthly') return paymentCents * 2
  return paymentCents
}

/**
 * The monthly payment: the scheduled one when terms carry it, else the average of the totals paid in the last
 * 3 full months (`recentMonthTotalsCents`, up to 3 entries, one per month, zero months included). Null when neither.
 */
export function monthlyPaymentCents(
  terms: { paymentCents: number | null; every: PaymentEvery | null } | null,
  recentMonthTotalsCents: number[] = [],
): MonthlyPayment | null {
  if (terms && terms.paymentCents != null && terms.paymentCents > 0) {
    return { cents: scheduledMonthlyCents(terms.paymentCents, terms.every ?? 'monthly'), source: 'scheduled' }
  }
  const months = recentMonthTotalsCents.slice(0, 3)
  if (months.length === 0) return null
  const avg = Math.round(months.reduce((a, b) => a + b, 0) / months.length)
  return avg > 0 ? { cents: avg, source: 'from payments' } : null
}

export interface OwedDebt { balanceCents: number | null; cosigned: boolean }

/** Total owed: known balances, cosigned shown apart (not in the total), and how many debts have no balance. */
export function totalOwed(debts: OwedDebt[]): { totalCents: number; cosignedCents: number; missingCount: number } {
  let totalCents = 0, cosignedCents = 0, missingCount = 0
  for (const d of debts) {
    if (d.balanceCents == null) { missingCount++; continue }
    if (d.cosigned) cosignedCents += d.balanceCents
    else totalCents += d.balanceCents
  }
  return { totalCents, cosignedCents, missingCount }
}

export interface AprCandidate { asOf: string; source: 'statement' | 'manual'; aprBp?: number | null }

/**
 * A debt's rate, one rule for the Loans list and the detail: the newest balance's own rate (a typed balance when it
 * is newer than the latest statement balance; a tie goes to the statement), else the account's rate. Null when none.
 */
export function debtAprBp(balances: AprCandidate[], accountAprBp: number | null): number | null {
  let best: AprCandidate | null = null
  for (const b of balances) {
    if (!best || b.asOf > best.asOf || (b.asOf === best.asOf && b.source === 'statement' && best.source !== 'statement')) best = b
  }
  return best?.aprBp ?? accountAprBp
}

export interface LoanPaymentInput {
  terms: { paymentCents: number | null; paymentEvery: PaymentEvery | null } | null
  recentMonthTotalsCents: number[]
}
/** The monthly payment, one rule for list and detail: scheduled (biweekly x 26/12), else the 3-month average. */
export function loanMonthlyPayment(i: LoanPaymentInput): MonthlyPayment | null {
  return monthlyPaymentCents(i.terms ? { paymentCents: i.terms.paymentCents, every: i.terms.paymentEvery } : null, i.recentMonthTotalsCents)
}
