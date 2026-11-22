// Shared contract for the Budget section (docs/adr/0007-budget-section.md). Owned by the lead;
// legs read it and never edit it. Money: integer cents. Dates: 'YYYY-MM-DD'.
// Sign rule: from the household's side. Negative = money out or a charge (purchase, fee, a payment
// leaving checking). Positive = money in or a credit (refund, income, a payment a card or loan receives).
export type IsoDate = string
export type Cents = number
export const TXN_KINDS = ['spend', 'refund', 'fee', 'income', 'interest_earned', 'interest_charged', 'transfer',
  'transfer_external', 'overdraft_move', 'card_payment', 'loan_payment', 'loan_advance', 'debt_payment', 'other'] as const
export type TxnKind = (typeof TXN_KINDS)[number]
export const SPENDING_KINDS: readonly TxnKind[] = ['spend', 'refund', 'fee']
export type AccountKind = 'checking' | 'savings' | 'card' | 'loan' | 'line_of_credit' | 'external_debt'
export type Source = 'manual' | 'rule' | 'auto' | 'none'
export type ReviewReason = 'rule' | 'ambiguous_store' | 'amount_out_of_band' | 'hidden_merchant'
  | 'transfer_to_unknown_account' | 'possible_duplicate' | 'low_confidence'
export const UNCATEGORIZED = '__none__'

export interface Person { id: string; label: string }
export interface Account { id: string; label: string; kind: AccountKind; personId: string | null; last4: string | null
  isDebt: boolean; inSpending: boolean; creditLimitCents: Cents | null; aprBp: number | null }
export interface Category { id: string; label: string; color: string | null; sort: number }
export interface RuleMatch { merchantKey: string; storeNo: string | null; accountId: string | null
  amountMinCents: Cents | null; amountMaxCents: Cents | null }
export interface MerchantRule extends RuleMatch { id: string; setCategoryId: string | null; setKind: TxnKind | null
  debtAccountId: string | null; displayName: string | null; confidence: number; review: boolean
  reviewReason: ReviewReason | null; source: 'seed' | 'edit'; active: boolean }

export interface ImportRow { postedDate: IsoDate; txnDate?: IsoDate | null; amountCents: Cents; description: string
  bankRef?: string | null; kindHint?: TxnKind | null; principalCents?: Cents | null; interestCents?: Cents | null }
export interface StatementFacts { accountId: string; periodStart: IsoDate; periodEnd: IsoDate
  openingBalanceCents?: Cents | null; closingBalanceCents?: Cents | null; creditLimitCents?: Cents | null
  aprBp?: number | null; apr2Bp?: number | null; interestCents?: Cents | null; feesCents?: Cents | null
  principalPaidCents?: Cents | null; advancesCents?: Cents | null; minDueCents?: Cents | null; dueDate?: IsoDate | null }
export interface ImportStatement extends StatementFacts { rows: ImportRow[] }
export interface ImportSeed { people?: Person[]; accounts?: Account[]; categories?: Category[]
  rules?: Array<Omit<MerchantRule, 'id' | 'source' | 'active'>> }
export interface ImportRequest { importId: string; sourceLabel: string; seed?: ImportSeed; statements: ImportStatement[] }
export interface ImportResult { importId: string; statements: number; rowsIn: number; inserted: number
  duplicates: number; paired: number; needsReview: number }

export interface Txn { id: string; accountId: string; postedDate: IsoDate; txnDate: IsoDate | null; amountCents: Cents
  description: string; merchantKey: string; merchantName: string; storeNo: string | null; kind: TxnKind
  kindSource: 'manual' | 'rule' | 'auto' | 'hint'; categoryId: string | null; categorySource: Source; ruleId: string | null
  confidence: number; needsReview: boolean; reviewReason: ReviewReason | null; pairId: string | null
  debtAccountId: string | null; principalCents: Cents | null; interestCents: Cents | null; note: string | null
  updatedAt: string; updatedBy: string
  /** Set by the transactions API: a rule on this row's merchant key would affect only the merchant the row names (one display
   *  name under the key, not a payment-service key). Absent or false: no "Use for all" offer. */
  ruleSafe?: boolean }
/** What pairing changes on a row: it is the row's classification as it stood before it was paired. */
export type UnpairedFields = Pick<Txn, 'kind' | 'categoryId' | 'categorySource' | 'confidence' | 'needsReview' | 'reviewReason'>
export interface TxnInsert extends Txn { importId: string; statementEnd: IsoDate | null
  counterpartyLast4: string | null; bankRef: string | null
  /** Set on a row the planner paired: its classification and no pair, before pairing. The SQL load inserts
   *  this and then pairs both sides together, so a pair either lands on both rows or on neither. */
  unpaired?: UnpairedFields }
export interface PairCandidate { id: string; accountId: string; postedDate: IsoDate; amountCents: Cents
  kind: TxnKind; counterpartyLast4: string | null; pairId: string | null }
export interface PlanContext { accounts: Account[]; rules: MerchantRule[]; pairCandidates: PairCandidate[]
  existingIds?: ReadonlySet<string> }
export interface ImportPlan { importId: string; sourceLabel: string; createdBy: string; createdAt: string; rowsIn: number
  people: Person[]; accounts: Account[]; categories: Category[]; rules: MerchantRule[]
  statements: StatementFacts[]; txns: TxnInsert[]; pairs: Array<[string, string]> }

export type PersonFilter = 'all' | string
export interface AccessResponse { ok: true; email: string }
export interface MetaResponse { people: Person[]; accounts: Account[]; categories: Category[]
  range: { min: IsoDate | null; max: IsoDate | null } }
export interface SummaryQuery { from: IsoDate; to: IsoDate; person: PersonFilter; category?: string
  /** A store's display name (the store-level slice key), not a merchant key: several keys can share one name. */
  merchant?: string; groupBy?: 'merchant' | 'account'
  /** Account id; second drill level when the pie is grouped by account. */
  account?: string }
/** `date` and `merchant` come only with purchase slices (the pie builds a short legend label from them). */
export interface SummarySlice { key: string; label: string; netCents: Cents; count: number; date?: IsoDate; merchant?: string }
export interface SummaryResponse { level: 'category' | 'merchant' | 'purchase'; slices: SummarySlice[]
  totalCents: Cents; reviewCount: number }
export interface TxnQuery { from: IsoDate; to: IsoDate; person: PersonFilter; category?: string; merchant?: string
  review?: boolean; scope: 'spending' | 'all'; cursor?: string; limit?: number
  /** Account id; second drill level when the pie is grouped by account. */
  account?: string }
export interface TxnPage { rows: Txn[]; nextCursor: string | null }
export interface TxnPatch { categoryId?: string | null; kind?: TxnKind; note?: string | null; expectedUpdatedAt: string }
export interface TxnPatchResponse { txn: Txn }
/** POST /api/budget/categories. `created` is false when a category of that name (any letter case) already existed: it comes back as is. */
export interface CategoryCreateRequest { name: string }
export interface CategoryCreateResponse { category: Category; created: boolean }
export interface RuleFromEdit { txnId: string; scope: 'merchant' | 'merchant_store' }
export interface RuleResponse { rule: MerchantRule; reapplied: number }
export interface DebtSlice { accountId: string; label: string; kind: AccountKind; last4: string | null
  personId: string | null; balanceCents: Cents | null; asOf: IsoDate | null; source: 'statement' | 'manual' | null
  aprBp: number | null; creditLimitCents: Cents | null }
export interface DebtsResponse { debts: DebtSlice[] }
export interface DebtDetail { account: Account
  history: Array<{ asOf: IsoDate; balanceCents: Cents; source: 'statement' | 'manual'; aprBp?: number | null }>
  periods: Array<{ periodEnd: IsoDate; aprBp: number | null; interestCents: Cents | null
    principalPaidCents: Cents | null; advancesCents: Cents | null }>
  payments: Array<{ id: string; postedDate: IsoDate; amountCents: Cents; principalCents: Cents | null; interestCents: Cents | null }>
  /** Paperwork facts (null until the private load writes a row), the newest statement's extras, and its promos. */
  terms: DebtTerms | null
  latest: LatestStatement | null
  promos: StatementPromo[] }
export interface ManualBalance { asOf: IsoDate; balanceCents: Cents; aprBp?: number | null }
/** migrations/gss-budget/0002_loans.sql. `debt_terms`: one row per debt, written only by the private load. */
export type PaymentEvery = 'monthly' | 'semimonthly' | 'biweekly'
export interface DebtTerms { accountId: string; originalCents: Cents | null; openedOn: IsoDate | null; maturityOn: IsoDate | null
  termMonths: number | null; paymentCents: Cents | null; paymentEvery: PaymentEvery | null; cosigned: boolean
  updatedAt: string; updatedBy: string }
/** The two `statements` columns 0002 adds (NULL = not printed or not loaded yet), keyed by the statement's primary key. `escrowCents` is the escrow part of the period's payment, not the escrow account balance. */
export interface StatementExtras { accountId: string; periodEnd: IsoDate; escrowCents: Cents | null; payoffCents: Cents | null }
/** `statement_promos`: a promotional or deferred-interest balance printed on one statement; `seq` orders them (1..50). */
export interface StatementPromo { accountId: string; periodEnd: IsoDate; seq: number; balanceCents: Cents
  aprBp: number | null; endsOn: IsoDate | null; deferredInterestCents: Cents | null }
/** The newest statement of a debt (by period end, whether or not it printed a closing balance) and what it printed. */
export interface LatestStatement { periodEnd: IsoDate; minDueCents: Cents | null; dueDate: IsoDate | null
  payoffCents: Cents | null; escrowCents: Cents | null; interestCents: Cents | null }
/** GET /api/budget/loans: one row per debt in scope; `payments` has one entry per month of `months`, zero months included. */
export interface LoanRow extends DebtSlice { terms: DebtTerms | null; latest: LatestStatement | null; promos: StatementPromo[]
  payments: Array<{ month: string; amountCents: Cents }> }
export interface LoansResponse { debts: LoanRow[]; months: string[] }
export type BudgetErrorCode = 'budget_denied' | 'bad_request' | 'not_found' | 'conflict' | 'method_not_allowed'
  | 'too_large' | 'budget_db_missing' | 'auth_not_configured'
export interface ApiError { error: BudgetErrorCode; message?: string; current?: Txn }

// U1 <-> U2: BudgetSection renders <BudgetTable v-bind="BudgetTableProps" @edited="..."/>
export interface BudgetTableProps { query: TxnQuery; categories: Category[]; accounts: Account[]
  canEdit: boolean; refreshKey: number; highlightId?: string | null }
export interface BudgetEditedEvent { txnId: string; ruleApplied: boolean; reapplied: number }
