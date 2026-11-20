// An ImportPlan as literal SQL for `wrangler d1 execute --file`: the only load path in v1 (there is no import route).
// One statement per row, every one idempotent (a second run inserts nothing and never touches an edited
// row). D1 limits: 100 KB per statement; this renderer throws rather than emit a bigger one. Values are
// literals, so strings are quoted here and numbers must be safe integers; nothing is spliced unchecked.
import type { Account, Category, ImportPlan, MerchantRule, Person, StatementFacts, TxnInsert } from './types'

/** D1 allows 100 KB per statement; stay a little under. */
export const MAX_STATEMENT_BYTES = 100_000

export function sqlStr(v: string | null | undefined): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v !== 'string') throw new TypeError('sqlStr: not a string')
  if (v.includes('\u0000')) throw new RangeError('sqlStr: NUL character')
  return `'${v.replace(/'/g, "''")}'`
}

export function sqlInt(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new RangeError('sqlInt: not a safe integer')
  return String(v)
}

const sqlBool = (v: boolean): string => (v ? '1' : '0')
const list = (xs: Array<string>): string => xs.join(', ')

/** Kinds a pair turns into 'transfer' (must match pairing.ts REKIND_ON_PAIR). */
const REKIND = `('spend','transfer_external')`
const REKIND_REVIEW = `('low_confidence','transfer_to_unknown_account','hidden_merchant')`

function personSql(p: Person, i: number): string {
  return `INSERT INTO people (id, label, sort) VALUES (${list([sqlStr(p.id), sqlStr(p.label), sqlInt(i)])}) ` +
    `ON CONFLICT(id) DO UPDATE SET label = excluded.label;`
}

function accountSql(a: Account, i: number): string {
  return `INSERT INTO accounts (id, label, kind, person_id, last4, is_debt, in_spending, credit_limit_cents, apr_bp, sort) VALUES (` +
    `${list([sqlStr(a.id), sqlStr(a.label), sqlStr(a.kind), sqlStr(a.personId), sqlStr(a.last4), sqlBool(a.isDebt), sqlBool(a.inSpending),
      sqlInt(a.creditLimitCents), sqlInt(a.aprBp), sqlInt(i)])}) ` +
    `ON CONFLICT(id) DO UPDATE SET label = excluded.label, kind = excluded.kind, person_id = excluded.person_id, last4 = excluded.last4, ` +
    `is_debt = excluded.is_debt, in_spending = excluded.in_spending, credit_limit_cents = excluded.credit_limit_cents, apr_bp = excluded.apr_bp;`
}

function categorySql(c: Category): string {
  return `INSERT INTO categories (id, label, color, sort) VALUES (${list([sqlStr(c.id), sqlStr(c.label), sqlStr(c.color), sqlInt(c.sort)])}) ` +
    `ON CONFLICT(id) DO UPDATE SET label = excluded.label, color = excluded.color, sort = excluded.sort;`
}

function ruleSql(r: MerchantRule, createdAt: string, createdBy: string): string {
  if (!r.setCategoryId && !r.setKind && !r.review) throw new RangeError('rule sets nothing: needs a category, a kind or review')
  return `INSERT INTO merchant_rules (id, merchant_key, store_no, account_id, amount_min_cents, amount_max_cents, set_category_id, set_kind, ` +
    `debt_account_id, display_name, confidence, review, review_reason, source, active, created_at, created_by) VALUES (` +
    `${list([sqlStr(r.id), sqlStr(r.merchantKey), sqlStr(r.storeNo), sqlStr(r.accountId), sqlInt(r.amountMinCents), sqlInt(r.amountMaxCents),
      sqlStr(r.setCategoryId), sqlStr(r.setKind), sqlStr(r.debtAccountId), sqlStr(r.displayName), sqlInt(r.confidence), sqlBool(r.review),
      sqlStr(r.reviewReason), sqlStr(r.source), sqlBool(r.active), sqlStr(createdAt), sqlStr(createdBy)])}) ` +
    // A seed re-run refreshes seed rules only; a rule made from an edit is never overwritten.
    `ON CONFLICT(id) DO UPDATE SET set_category_id = excluded.set_category_id, set_kind = excluded.set_kind, ` +
    `debt_account_id = excluded.debt_account_id, display_name = excluded.display_name, confidence = excluded.confidence, ` +
    `review = excluded.review, review_reason = excluded.review_reason, active = excluded.active WHERE merchant_rules.source = 'seed';`
}

function importSql(plan: ImportPlan): string {
  return `INSERT INTO imports (id, source_label, created_at, created_by, rows_in) VALUES (` +
    `${list([sqlStr(plan.importId), sqlStr(plan.sourceLabel), sqlStr(plan.createdAt), sqlStr(plan.createdBy), sqlInt(plan.rowsIn)])}) ` +
    `ON CONFLICT(id) DO NOTHING;`
}

function statementSql(s: StatementFacts, importId: string): string {
  return `INSERT INTO statements (account_id, period_end, period_start, import_id, opening_balance_cents, closing_balance_cents, ` +
    `credit_limit_cents, apr_bp, apr2_bp, interest_cents, fees_cents, principal_paid_cents, advances_cents, min_due_cents, due_date) VALUES (` +
    `${list([sqlStr(s.accountId), sqlStr(s.periodEnd), sqlStr(s.periodStart), sqlStr(importId), sqlInt(s.openingBalanceCents),
      sqlInt(s.closingBalanceCents), sqlInt(s.creditLimitCents), sqlInt(s.aprBp), sqlInt(s.apr2Bp), sqlInt(s.interestCents), sqlInt(s.feesCents),
      sqlInt(s.principalPaidCents), sqlInt(s.advancesCents), sqlInt(s.minDueCents), sqlStr(s.dueDate)])}) ` +
    `ON CONFLICT(account_id, period_end) DO UPDATE SET period_start = excluded.period_start, import_id = excluded.import_id, ` +
    `opening_balance_cents = excluded.opening_balance_cents, closing_balance_cents = excluded.closing_balance_cents, ` +
    `credit_limit_cents = excluded.credit_limit_cents, apr_bp = excluded.apr_bp, apr2_bp = excluded.apr2_bp, interest_cents = excluded.interest_cents, ` +
    `fees_cents = excluded.fees_cents, principal_paid_cents = excluded.principal_paid_cents, advances_cents = excluded.advances_cents, ` +
    `min_due_cents = excluded.min_due_cents, due_date = excluded.due_date;`
}

function txnSql(t: TxnInsert): string {
  return `INSERT INTO transactions (id, account_id, statement_end, import_id, posted_date, txn_date, amount_cents, description, merchant_key, ` +
    `merchant_name, store_no, counterparty_last4, bank_ref, kind, kind_source, category_id, category_source, rule_id, confidence, needs_review, ` +
    `review_reason, pair_id, debt_account_id, principal_cents, interest_cents, note, updated_at, updated_by) VALUES (` +
    `${list([sqlStr(t.id), sqlStr(t.accountId), sqlStr(t.statementEnd), sqlStr(t.importId), sqlStr(t.postedDate), sqlStr(t.txnDate),
      sqlInt(t.amountCents), sqlStr(t.description), sqlStr(t.merchantKey), sqlStr(t.merchantName), sqlStr(t.storeNo), sqlStr(t.counterpartyLast4),
      sqlStr(t.bankRef), sqlStr(t.kind), sqlStr(t.kindSource), sqlStr(t.categoryId), sqlStr(t.categorySource), sqlStr(t.ruleId),
      sqlInt(t.confidence), sqlBool(t.needsReview), sqlStr(t.reviewReason), sqlStr(t.pairId), sqlStr(t.debtAccountId), sqlInt(t.principalCents),
      sqlInt(t.interestCents), sqlStr(t.note), sqlStr(t.updatedAt), sqlStr(t.updatedBy)])}) ON CONFLICT(id) DO NOTHING;`
}

/**
 * One side of a pair. Never touches a row that is already paired, whose kind_source is 'manual' or
 * 'rule', or whose category was set by hand (category_source 'manual'): a later load starts from an
 * empty context and re-plans every file, so this guard is what protects an edit made since. A row
 * taken for spending or for an outside payee becomes a plain transfer, leaves its category and drops
 * the review reasons the pairing answered.
 */
export function pairUpdateSql(id: string, partnerId: string, updatedAt: string, updatedBy: string): string {
  const re = `kind IN ${REKIND}`
  return `UPDATE transactions SET pair_id = ${sqlStr(partnerId)}, ` +
    `category_id = CASE WHEN ${re} THEN NULL ELSE category_id END, ` +
    `category_source = CASE WHEN ${re} THEN 'none' ELSE category_source END, ` +
    `confidence = CASE WHEN ${re} THEN 85 ELSE confidence END, ` +
    `needs_review = CASE WHEN ${re} AND review_reason IN ${REKIND_REVIEW} THEN 0 ELSE needs_review END, ` +
    `review_reason = CASE WHEN ${re} AND review_reason IN ${REKIND_REVIEW} THEN NULL ELSE review_reason END, ` +
    `kind = CASE WHEN ${re} THEN 'transfer' ELSE kind END, ` +
    `updated_at = ${sqlStr(updatedAt)}, updated_by = ${sqlStr(updatedBy)} ` +
    `WHERE id = ${sqlStr(id)} AND pair_id IS NULL AND kind_source NOT IN ('manual','rule') AND category_source <> 'manual';`
}

/** The statements of a plan, in an order that satisfies the foreign keys. */
export function planStatements(plan: ImportPlan): string[] {
  const out: string[] = []
  plan.people.forEach((p, i) => out.push(personSql(p, i)))
  plan.accounts.forEach((a, i) => out.push(accountSql(a, i)))
  plan.categories.forEach((c) => out.push(categorySql(c)))
  plan.rules.forEach((r) => out.push(ruleSql(r, plan.createdAt, plan.createdBy)))
  if (plan.rowsIn > 0 || plan.statements.length > 0 || plan.txns.length > 0) out.push(importSql(plan))
  plan.statements.forEach((s) => out.push(statementSql(s, plan.importId)))
  plan.txns.forEach((t) => out.push(txnSql(t)))
  for (const [a, b] of plan.pairs) {
    out.push(pairUpdateSql(a, b, plan.createdAt, plan.createdBy))
    out.push(pairUpdateSql(b, a, plan.createdAt, plan.createdBy))
  }
  return out
}

export function renderPlanSql(plan: ImportPlan): string {
  const enc = new TextEncoder()
  const stmts = planStatements(plan)
  for (const s of stmts) {
    if (enc.encode(s).length >= MAX_STATEMENT_BYTES) throw new RangeError('a statement is over the 100 KB D1 limit')
  }
  return stmts.length ? stmts.join('\n') + '\n' : ''
}
