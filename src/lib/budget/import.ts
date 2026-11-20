// One statement package in, one ImportPlan out: normalize, key, classify, categorize, flag, de-duplicate
// and pair. Pure and I/O-free (callers read the context and write the plan), so the Pages Function, the
// local tool and the tests all run the same code. Errors name a statement or row index, never a
// description or an amount.
import type {
  Account, Category, ImportPlan, ImportRequest, ImportRow, MerchantRule, PairCandidate, PlanContext, Person, StatementFacts,
  TxnInsert,
} from './types'
import { TXN_KINDS } from './types'
import { maskDigits } from './mask'
import { normalizeDescription } from './normalize'
import { merchantKey, withCounterparty } from './merchant'
import { inferYear, isIsoDate } from './dates'
import { dedupeKey, occurrences } from './dedupe'
import { classifyKind } from './kind'
import { autoCategory, categorize, ruleIdFor, type RuleInput } from './rules'
import { storeSplitReview } from './storeSplit'
import { reviewFlags, sameDayKey } from './review'
import { pairTransfers, REKIND_ON_PAIR } from './pairing'

export class ImportError extends Error {
  constructor(message: string) { super(message); this.name = 'ImportError' }
}

export interface PlanResult {
  plan: ImportPlan
  /** Rows that were already known (same id in the context or earlier in this request) and so are not in plan.txns. */
  duplicates: number
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n)
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

function mergeById<T extends { id: string }>(base: readonly T[], over: readonly T[]): T[] {
  const m = new Map<string, T>()
  for (const x of base) m.set(x.id, x)
  for (const x of over) m.set(x.id, x)
  return [...m.values()]
}

function validateRow(r: ImportRow, si: number, ri: number): void {
  const at = `statement ${si} row ${ri}`
  if (!isIsoDate(r.postedDate)) throw new ImportError(`${at}: postedDate is not an ISO date`)
  if (r.txnDate != null && !isIsoDate(r.txnDate)) throw new ImportError(`${at}: txnDate is not an ISO date`)
  if (!isInt(r.amountCents)) throw new ImportError(`${at}: amountCents is not an integer`)
  if (typeof r.description !== 'string') throw new ImportError(`${at}: description is not text`)
  if (r.bankRef != null && typeof r.bankRef !== 'string') throw new ImportError(`${at}: bankRef is not text`)
  if (r.kindHint != null && !(TXN_KINDS as readonly string[]).includes(r.kindHint)) throw new ImportError(`${at}: unknown kindHint`)
  if (r.principalCents != null && !isInt(r.principalCents)) throw new ImportError(`${at}: principalCents is not an integer`)
  if (r.interestCents != null && !isInt(r.interestCents)) throw new ImportError(`${at}: interestCents is not an integer`)
}

function validate(req: ImportRequest, accounts: Map<string, Account>): void {
  if (typeof req.importId !== 'string' || req.importId.length < 1 || req.importId.length > 64) throw new ImportError('importId must be 1-64 characters')
  if (typeof req.sourceLabel !== 'string' || req.sourceLabel.length > 64) throw new ImportError('sourceLabel must be at most 64 characters')
  if (!Array.isArray(req.statements)) throw new ImportError('statements must be a list')
  req.statements.forEach((s, si) => {
    if (!accounts.has(s.accountId)) throw new ImportError(`statement ${si}: unknown account id`)
    if (!isIsoDate(s.periodStart) || !isIsoDate(s.periodEnd) || s.periodStart > s.periodEnd) throw new ImportError(`statement ${si}: bad period`)
    if (!Array.isArray(s.rows)) throw new ImportError(`statement ${si}: rows must be a list`)
    s.rows.forEach((r, ri) => validateRow(r, si, ri))
  })
}

/** The rows pairing may look at: rule- and manual-sourced rows are carried as 'other' so they never pair. */
function toCandidate(t: TxnInsert): PairCandidate {
  const locked = t.kindSource === 'manual' || t.kindSource === 'rule'
  return { id: t.id, accountId: t.accountId, postedDate: t.postedDate, amountCents: t.amountCents, kind: locked ? 'other' : t.kind,
    counterpartyLast4: t.counterpartyLast4, pairId: t.pairId }
}

export async function planImportDetailed(req: ImportRequest, ctx: PlanContext, who: string, nowIso: string): Promise<PlanResult> {
  const seed = req.seed ?? {}
  const accountMap = new Map(mergeById(ctx.accounts, seed.accounts ?? []).map((a) => [a.id, a]))
  validate(req, accountMap)
  const accounts = [...accountMap.values()]

  const seedRules: MerchantRule[] = []
  for (const r of seed.rules ?? []) seedRules.push({ ...r, id: await ruleIdFor(r), source: 'seed', active: true })
  const planRules = mergeById([], seedRules)
  const rules = mergeById(ctx.rules, planRules)

  const known = new Set<string>(ctx.existingIds ?? [])
  const seenKeys = new Set<string>()
  for (const c of ctx.pairCandidates) { known.add(c.id); seenKeys.add(sameDayKey(c.accountId, c.postedDate, c.amountCents)) }

  const txns: TxnInsert[] = []
  const facts: StatementFacts[] = []
  let rowsIn = 0
  let duplicates = 0

  for (const st of req.statements) {
    const { rows, ...f } = st
    facts.push(f)
    rowsIn += rows.length
    const account = accountMap.get(st.accountId)!
    const norms = rows.map((r) => normalizeDescription(r.description))
    const occ = occurrences(rows.map((r, i) => ({ postedDate: r.postedDate, amountCents: r.amountCents, clean: norms[i].clean })))
    const stmtKeys = new Set<string>()
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], n = norms[i]
      const id = await dedupeKey({ accountId: st.accountId, postedDate: row.postedDate, amountCents: row.amountCents, clean: n.clean,
        occurrence: occ[i], bankRef: row.bankRef })
      if (known.has(id)) { duplicates++; continue }
      known.add(id)

      const guess = classifyKind(n, row.amountCents, account, accounts, row.kindHint)
      const counterpartyKnown = n.counterpartyLast4 !== null && accounts.some((a) => a.id !== account.id && a.last4 === n.counterpartyLast4)
      let mk = merchantKey(n.clean)
      if (guess.kind === 'transfer_external' && n.counterpartyLast4 && !counterpartyKnown) mk = withCounterparty(mk, n.counterpartyLast4)
      // A payment out to one of our own loans or lines carries that account's last four too, so a rule can treat one
      // debt differently from another (they share the same name words). Every other kind keeps its key.
      else if (guess.kind === 'loan_payment' && row.amountCents < 0 && n.counterpartyLast4 && counterpartyKnown) mk = withCounterparty(mk, n.counterpartyLast4)
      const input: RuleInput = { accountId: st.accountId, merchantKey: mk.key, storeNo: n.storeNo, amountCents: row.amountCents }
      const cat = categorize(input, rules, { kind: guess.kind, kindSource: guess.source, kindConfidence: guess.confidence, categoryId: autoCategory(n.clean) ?? (guess.kind === 'fee' ? 'fees' : null) })
      const split = storeSplitReview(input, cat.rule, rules)
      const confidence = clamp(cat.confidence + split.confidenceDelta)
      const flags = reviewFlags({ ...cat, ...input, confidence, split, aggregator: mk.aggregator, counterpartyLast4: n.counterpartyLast4,
        counterpartyKnown, postedDate: row.postedDate }, { sameDayAmounts: seenKeys })

      let txnDate = row.txnDate ?? null
      if (!txnDate && n.purchaseMmdd) {
        const [mm, dd] = n.purchaseMmdd.split('-').map(Number)
        try { txnDate = inferYear(mm, dd, row.postedDate) } catch { txnDate = null }
      }
      stmtKeys.add(sameDayKey(st.accountId, row.postedDate, row.amountCents))
      txns.push({
        id, accountId: st.accountId, postedDate: row.postedDate, txnDate, amountCents: row.amountCents,
        description: maskDigits(row.description.replace(/\s+/g, ' ').trim()).slice(0, 300),
        merchantKey: mk.key, merchantName: cat.displayName ?? mk.name, storeNo: n.storeNo,
        kind: cat.kind, kindSource: cat.kindSource, categoryId: cat.categoryId, categorySource: cat.categorySource, ruleId: cat.ruleId,
        confidence, needsReview: flags.needsReview, reviewReason: flags.reason, pairId: null, debtAccountId: cat.debtAccountId,
        principalCents: row.principalCents ?? null, interestCents: row.interestCents ?? null, note: null,
        updatedAt: nowIso, updatedBy: who,
        importId: req.importId, statementEnd: st.periodEnd, counterpartyLast4: n.counterpartyLast4, bankRef: row.bankRef?.trim() || null,
      })
    }
    for (const k of stmtKeys) seenKeys.add(k)
  }

  // Pair new rows with each other and with the context's open candidates. Rows with a rule- or
  // manual-sourced kind are not candidates, so pairing never changes them.
  const newById = new Map(txns.map((t) => [t.id, t]))
  const candidates = [...ctx.pairCandidates.filter((c) => !newById.has(c.id)), ...txns.filter((t) => t.kindSource !== 'manual' && t.kindSource !== 'rule').map(toCandidate)]
  const pairs = pairTransfers(candidates, accounts)
  for (const [a, b] of pairs) {
    for (const [mine, other] of [[a, b], [b, a]] as const) {
      const t = newById.get(mine)
      if (!t) continue
      t.pairId = other
      if (REKIND_ON_PAIR.includes(t.kind)) {
        t.kind = 'transfer'
        t.categoryId = null
        t.categorySource = 'none'
        t.confidence = 85
        if (t.reviewReason === 'low_confidence' || t.reviewReason === 'transfer_to_unknown_account' || t.reviewReason === 'hidden_merchant') {
          t.needsReview = false
          t.reviewReason = null
        }
      }
    }
  }

  const plan: ImportPlan = {
    importId: req.importId, sourceLabel: req.sourceLabel, createdBy: who, createdAt: nowIso, rowsIn,
    people: (seed.people ?? []) as Person[], accounts: (seed.accounts ?? []) as Account[], categories: (seed.categories ?? []) as Category[],
    rules: planRules, statements: facts, txns, pairs,
  }
  return { plan, duplicates }
}

export async function planImport(req: ImportRequest, ctx: PlanContext, who: string, nowIso: string): Promise<ImportPlan> {
  return (await planImportDetailed(req, ctx, who, nowIso)).plan
}

/**
 * The context to plan the NEXT request with, after `plan` has been (or will be) written: its ids are
 * known, its accounts and rules exist, its rows are open pairing candidates, and the pairs it made are
 * recorded on the candidates they touched. Lets a tool plan many statement packages as one load.
 */
export function extendContext(ctx: PlanContext, plan: ImportPlan): PlanContext {
  const partner = new Map<string, string>()
  for (const [a, b] of plan.pairs) { partner.set(a, b); partner.set(b, a) }
  return {
    accounts: mergeById(ctx.accounts, plan.accounts),
    rules: mergeById(ctx.rules, plan.rules),
    pairCandidates: [
      ...ctx.pairCandidates.map((c) => (c.pairId === null && partner.has(c.id) ? { ...c, pairId: partner.get(c.id)! } : c)),
      ...plan.txns.map(toCandidate),
    ],
    existingIds: new Set([...(ctx.existingIds ?? []), ...plan.txns.map((t) => t.id)]),
  }
}
