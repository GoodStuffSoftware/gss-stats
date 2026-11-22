<script setup lang="ts">
// One debt in full: the balance now, its rate, the balance history as a line, the interest of each statement
// period, the payments, and (when allowed) a form to type a balance: the only way a payment-only debt gets one.
// It loads its own data (clientRead.fetchDebtDetail), saves with putManualBalance, and has its own loading and
// error states.
//
// Props
//   accountId: string    the debt to show.
//   canEdit:   boolean   true once the access probe said 200 (NOT the site's view-only flag): the balance form is
//                        shown only when true.
//   dark:      boolean   site theme.
// Emits
//   close()   "Back to debts".
//   saved()   a manual balance was PUT: BudgetSection refetches /debts so the pie and list update.
import { computed, ref, watch } from 'vue'
import { balanceLineConfig } from '../../lib/budget/balanceChart'
import { fetchDebtDetail, putManualBalance } from '../../lib/budget/clientRead'
import { daysBetween } from '../../lib/budget/dates'
import { debtAprBp, loanMonthlyPayment, monthlyInterestCents, monthsToPayoff, payoffMonth } from '../../lib/budget/loanMath'
import { formatApr } from '../../lib/budget/pieModel'
import { formatAmount, formatDate } from '../../lib/budget/tableModel'
import type { DebtDetail as DebtDetailData } from '../../lib/budget/types'
import { monthsLabel, rangeValid, todayIso } from '../../lib/budget/viewState'
import BaseChart from '../charts/BaseChart.vue'
import EditableTable, { type EditableColumn } from '../table/EditableTable.vue'

// `recentPaymentsCents`: the totals paid in the last 3 full months (the Loans page passes them), the payoff fallback
// when the loan has no scheduled payment.
const props = defineProps<{ accountId: string; canEdit: boolean; dark: boolean; hideBack?: boolean; recentPaymentsCents?: number[]; recentMonths?: string[] }>()
const emit = defineEmits<{ close: []; saved: [] }>()
// The months the average covers (LoansResponse.months, 'YYYY-MM', oldest first).
const recentLabel = computed(() => {
  const m = props.recentMonths
  return (m && m.length ? monthsLabel(m[0], m[m.length - 1]) : '') || 'last 3 months'
})

// ── Loading ──────────────────────────────────────────────────────────────────────────────────────────────
const detail = ref<DebtDetailData | null>(null)
const loading = ref(true)
const failed = ref(false)
let seq = 0
async function load() {
  const mine = ++seq
  loading.value = true
  failed.value = false
  try {
    const d = await fetchDebtDetail(props.accountId)
    if (mine !== seq) return
    detail.value = d
  } catch {
    if (mine !== seq) return
    detail.value = null
    failed.value = true
  } finally {
    if (mine === seq) loading.value = false
  }
}
watch(() => props.accountId, load, { immediate: true })

// ── What it shows ────────────────────────────────────────────────────────────────────────────────────────
const latest = computed(() => {
  const h = detail.value?.history ?? []
  return h.length ? [...h].sort((a, b) => a.asOf.localeCompare(b.asOf)).at(-1)! : null
})
const history = computed(() => [...(detail.value?.history ?? [])].sort((a, b) => a.asOf.localeCompare(b.asOf)))
/** The same rate the Loans list shows (loanMath.debtAprBp): the newest balance's own rate, else the account's. */
const rateBp = computed(() => {
  const d = detail.value
  return d ? debtAprBp(d.history, d.account.aprBp) : null
})
const title = computed(() => {
  const a = detail.value?.account
  return a ? `${a.label}${a.last4 ? ` ••${a.last4}` : ''}` : 'Debt'
})

const dash = '—'
const money = (c: number | null) => (c === null ? dash : formatAmount(c))
interface PeriodRow { periodEnd: string; rate: string; interest: string; principal: string; advances: string }
interface PaymentRow { id: string; date: string; amount: string; principal: string; interest: string }
const periodColumns: EditableColumn<PeriodRow>[] = [
  { key: 'periodEnd', label: 'Period ending', editor: null },
  { key: 'rate', label: 'Rate', editor: null, align: 'end' },
  { key: 'interest', label: 'Interest', editor: null, align: 'end' },
  { key: 'principal', label: 'Principal paid', editor: null, align: 'end' },
  { key: 'advances', label: 'Borrowed', editor: null, align: 'end' },
]
const paymentColumns: EditableColumn<PaymentRow>[] = [
  { key: 'date', label: 'Date', editor: null },
  { key: 'amount', label: 'Payment', editor: null, align: 'end' },
  { key: 'principal', label: 'Principal', editor: null, align: 'end' },
  { key: 'interest', label: 'Interest', editor: null, align: 'end' },
]
const periodRows = computed<PeriodRow[]>(() =>
  [...(detail.value?.periods ?? [])]
    // a period with nothing known (the newest one is often just a balance snapshot's date) is not a row
    .filter((p) => p.aprBp !== null || p.interestCents !== null || p.principalPaidCents !== null || p.advancesCents !== null)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
    .map((p) => ({
      periodEnd: formatDate(p.periodEnd),
      rate: p.aprBp === null ? dash : formatApr(p.aprBp),
      interest: money(p.interestCents),
      principal: money(p.principalPaidCents),
      advances: money(p.advancesCents),
    })),
)
const paymentRows = computed<PaymentRow[]>(() =>
  (detail.value?.payments ?? []).map((p) => ({
    id: p.id,
    date: formatDate(p.postedDate),
    amount: formatAmount(Math.abs(p.amountCents)),
    principal: money(p.principalCents),
    interest: money(p.interestCents),
  })),
)

// ── Statement facts, terms, promos, payoff ───────────────────────────────────────────────────────────────
const latestStmt = computed(() => detail.value?.latest ?? null)
const terms = computed(() => detail.value?.terms ?? null)
/** The newest balance that came off a statement (not a typed one). */
const stmtBalance = computed(() => [...history.value].reverse().find((h) => h.source === 'statement') ?? null)
const lastPeriod = computed(() => {
  const ls = latestStmt.value
  return ls ? (detail.value?.periods ?? []).find((p) => p.periodEnd === ls.periodEnd) ?? null : null
})
interface Fact { label: string; value: string; sub?: string; testid: string }
const known = (f: Fact) => f.value !== dash
const statementFacts = computed<Fact[]>(() => {
  const ls = latestStmt.value
  const sb = stmtBalance.value
  return [
    { label: 'Statement balance', value: sb ? money(sb.balanceCents) : dash, sub: sb ? `period ending ${formatDate(sb.asOf)}` : undefined, testid: 'fact-stmt-balance' },
    { label: 'Payoff amount', value: money(ls?.payoffCents ?? null), sub: ls && ls.payoffCents !== null ? `good through ${formatDate(ls.periodEnd)}` : undefined, testid: 'fact-payoff' },
    { label: 'Due date', value: ls?.dueDate ? formatDate(ls.dueDate) : dash, testid: 'fact-due' },
    { label: 'Minimum due', value: money(ls?.minDueCents ?? null), testid: 'fact-min-due' },
    { label: 'Principal, last period', value: money(lastPeriod.value?.principalPaidCents ?? null), testid: 'fact-principal' },
    { label: 'Interest, last period', value: money(ls?.interestCents ?? null), testid: 'fact-interest' },
    { label: 'Escrow, last period', value: money(ls?.escrowCents ?? null), testid: 'fact-escrow' },
  ]
})
const hasStatement = computed(() => statementFacts.value.some(known))
const cadence = { monthly: 'monthly', semimonthly: 'twice a month', biweekly: 'every two weeks' } as const
const termFacts = computed<Fact[]>(() => {
  const t = terms.value
  return [
    { label: 'Original amount', value: money(t?.originalCents ?? null), testid: 'fact-original' },
    { label: 'Opened', value: t?.openedOn ? formatDate(t.openedOn) : dash, testid: 'fact-opened' },
    { label: 'Term', value: t?.termMonths ? `${t.termMonths} months` : dash, testid: 'fact-term' },
    { label: 'Maturity', value: t?.maturityOn ? formatDate(t.maturityOn) : dash, testid: 'fact-maturity' },
    { label: 'Scheduled payment', value: money(t?.paymentCents ?? null), sub: t?.paymentCents != null && t.paymentEvery ? cadence[t.paymentEvery] : undefined, testid: 'fact-payment' },
  ]
})
const cosigned = computed(() => terms.value?.cosigned === true)
const hasTerms = computed(() => termFacts.value.some(known) || cosigned.value)

/** Payoff at the scheduled payment, and the interest estimate beside the last statement's actual interest. */
const payoff = computed(() => {
  const bal = latest.value
  if (!bal) return null
  const t = terms.value
  const pay = loanMonthlyPayment({ terms: t, recentMonthTotalsCents: props.recentPaymentsCents ?? [] })
  const res = pay ? monthsToPayoff(bal.balanceCents, rateBp.value, pay.cents) : null
  let text = ''
  if (res?.kind === 'payoff' || res?.kind === 'rate_unknown') {
    const when = payoffMonth(bal.asOf, res.months)
    text = `${res.months} month${res.months === 1 ? '' : 's'}${when ? ` (${when})` : ''}${res.kind === 'rate_unknown' ? ', rate unknown' : ''}`
  } else if (res?.kind === 'not_paid_off') text = 'Not paid off at this payment'
  else if (res?.kind === 'paid_off') text = 'Paid off'
  const est = monthlyInterestCents(bal.balanceCents, rateBp.value)
  if (!text && est === null) return null
  const actual = latestStmt.value?.interestCents ?? null
  return { text, source: pay?.source ?? null, estInterest: est === null ? null : formatAmount(est), actualInterest: actual === null ? null : formatAmount(actual) }
})

const SOON_DAYS = 60
const promoRows = computed(() =>
  [...(detail.value?.promos ?? [])]
    .sort((a, b) => (a.endsOn ?? '9999').localeCompare(b.endsOn ?? '9999') || a.seq - b.seq)
    .map((p) => ({
      key: `${p.periodEnd}-${p.seq}`,
      balance: formatAmount(p.balanceCents),
      apr: p.aprBp === null ? dash : formatApr(p.aprBp),
      endsOn: p.endsOn ? formatDate(p.endsOn) : dash,
      atRisk: money(p.deferredInterestCents),
      soon: p.endsOn !== null && daysBetween(todayIso(), p.endsOn) < SOON_DAYS,
    })),
)

// ── Balance line ─────────────────────────────────────────────────────────────────────────────────────────
const chartConfig = computed(() => balanceLineConfig(history.value, props.dark))

// ── The balance form ─────────────────────────────────────────────────────────────────────────────────────
const MAX_CENTS = 99_999_999_999 // $999,999,999.99
/** "$1,234.56", "1234.5", "0" -> cents; anything else (negative, letters, 3 decimals, bad commas) -> null. */
function parseBalance(text: string): number | null {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!m) return null
  const cents = Number(m[1].replace(/,/g, '')) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0)
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : null
}
/** "19.99" or "19.99%" -> basis points 0..10000; blank -> undefined (no rate); anything else -> null. */
function parseRate(text: string): number | undefined | null {
  const t = text.trim().replace(/%$/, '')
  if (!t) return undefined
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(t)) return null
  const bp = Math.round(Number(t) * 100)
  return bp <= 10000 ? bp : null
}

const today = todayIso()
const asOf = ref(today)
const balanceText = ref('')
const rateText = ref('')
const saving = ref(false)
const formError = ref('')
const savedNote = ref('')

async function submit() {
  savedNote.value = ''
  if (!rangeValid(asOf.value, asOf.value)) return void (formError.value = 'Pick a real date.')
  if (asOf.value > today) return void (formError.value = 'The date can’t be in the future.')
  const cents = parseBalance(balanceText.value)
  if (cents === null) return void (formError.value = 'Enter the balance as dollars, like 1,250.00.')
  const bp = parseRate(rateText.value)
  if (bp === null) return void (formError.value = 'Enter the rate as a percent from 0 to 100, like 19.99, or leave it blank.')
  formError.value = ''
  saving.value = true
  try {
    await putManualBalance(props.accountId, { asOf: asOf.value, balanceCents: cents, ...(bp !== undefined ? { aprBp: bp } : {}) })
    savedNote.value = `Saved ${formatAmount(cents)} as of ${formatDate(asOf.value)}.`
    balanceText.value = ''
    rateText.value = ''
    emit('saved')
    void load()
  } catch (e) {
    const status = (e as { status?: number }).status
    formError.value = status ? `Couldn’t save the balance (${status}).` : 'Couldn’t save the balance. Check your connection and try again.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="debt-detail" data-testid="debt-detail">
    <div class="dd-head">
      <button v-if="!hideBack" type="button" class="btn dd-back" data-testid="debt-back" @click="emit('close')">← Back to debts</button>
      <h2 class="dd-title">{{ title }}</h2>
    </div>

    <div v-if="failed" class="dd-note" role="alert">
      <span>Couldn’t load this debt.</span>
      <button type="button" class="btn" data-testid="debt-retry" @click="load">Retry</button>
    </div>
    <div v-else-if="loading && !detail" class="dd-skeleton" aria-busy="true" aria-label="Loading debt">
      <div class="dd-sk-chart" />
      <div v-for="n in 4" :key="n" class="dd-sk-row" />
    </div>

    <template v-else-if="detail">
      <div class="dd-top" :class="{ 'dd-top-solo': !history.length }">
      <section v-if="history.length" class="dd-section dd-chart-col" aria-label="Balance history">
        <h3 class="dd-h3">Balance over time</h3>
        <div class="dd-chart" role="img" :aria-label="`Balance history of ${title}`" data-testid="debt-chart">
          <BaseChart :config="chartConfig" :drill-open="false" />
        </div>
      </section>

      <div class="dd-side">
      <dl class="dd-facts">
        <div>
          <dt>Balance</dt>
          <dd data-testid="debt-balance">{{ latest ? formatAmount(latest.balanceCents) : 'No balance yet' }}</dd>
          <dd v-if="latest" class="dd-sub">as of {{ formatDate(latest.asOf) }} ({{ latest.source === 'manual' ? 'typed in' : 'statement' }})</dd>
        </div>
        <div>
          <dt>Rate</dt>
          <dd data-testid="debt-rate">{{ rateBp === null ? dash : `${formatApr(rateBp)} APR` }}</dd>
        </div>
        <div v-if="detail.account.creditLimitCents !== null">
          <dt>Credit limit</dt>
          <dd>{{ formatAmount(detail.account.creditLimitCents) }}</dd>
        </div>
      </dl>

      <section v-if="hasStatement" class="dd-section" aria-label="Statement details" data-testid="statement-facts">
        <h3 class="dd-h3">Last statement</h3>
        <dl class="dd-grid">
          <div v-for="f in statementFacts" :key="f.testid">
            <dt>{{ f.label }}</dt>
            <dd :data-testid="f.testid">{{ f.value }}</dd>
            <dd v-if="f.sub" class="dd-sub">{{ f.sub }}</dd>
          </div>
        </dl>
      </section>

      <section v-if="hasTerms" class="dd-section" aria-label="Loan terms" data-testid="terms-facts">
        <h3 class="dd-h3">
          Terms
          <span v-if="cosigned" class="dd-badge" data-testid="cosigned-badge">Cosigned</span>
        </h3>
        <dl class="dd-grid">
          <div v-for="f in termFacts" :key="f.testid">
            <dt>{{ f.label }}</dt>
            <dd :data-testid="f.testid">{{ f.value }}</dd>
            <dd v-if="f.sub" class="dd-sub">{{ f.sub }}</dd>
          </div>
        </dl>
      </section>

      <p v-if="!hasStatement && !hasTerms" class="dd-empty" data-testid="no-statement-details">No statement details yet</p>

      <section v-if="payoff" class="dd-section" aria-label="Payoff estimate" data-testid="payoff-estimate">
        <h3 class="dd-h3">Payoff estimate</h3>
        <dl class="dd-grid">
          <div v-if="payoff.text">
            <dt>{{ payoff.source === 'from payments' ? `At the average payment (${recentLabel})` : 'At the scheduled payment' }}</dt>
            <dd data-testid="payoff-months">{{ payoff.text }}</dd>
          </div>
          <div v-if="payoff.estInterest">
            <dt>Interest per month (estimate)</dt>
            <dd data-testid="payoff-interest">{{ payoff.estInterest }}</dd>
            <dd v-if="payoff.actualInterest" class="dd-sub">last statement: {{ payoff.actualInterest }}</dd>
          </div>
        </dl>
      </section>

      <section v-if="promoRows.length" class="dd-section" aria-label="Promotional balances" data-testid="promos">
        <h3 class="dd-h3">Promotional balances</h3>
        <ul class="dd-promos">
          <li v-for="p in promoRows" :key="p.key" class="dd-promo" :class="{ 'dd-promo-soon': p.soon }" data-testid="promo">
            <span class="dd-promo-bal">{{ p.balance }}</span>
            <span>{{ p.apr }} APR</span>
            <span data-testid="promo-ends">ends {{ p.endsOn }}</span>
            <span>deferred interest at risk {{ p.atRisk }}</span>
          </li>
        </ul>
      </section>
      </div>
      </div>

      <div class="dd-tables">
      <section v-if="periodRows.length" class="dd-section" aria-label="Interest by period">
        <h3 class="dd-h3">Interest by statement</h3>
        <EditableTable :columns="periodColumns" :rows="periodRows" row-key="periodEnd" label="Interest by statement" card-labels />
      </section>

      <section class="dd-section" aria-label="Payments">
        <h3 class="dd-h3">Payments</h3>
        <EditableTable :columns="paymentColumns" :rows="paymentRows" row-key="id" label="Payments" card-labels>
          <template #empty><span data-testid="debt-no-payments">No payments recorded.</span></template>
        </EditableTable>
      </section>
      </div>

      <section v-if="canEdit" class="dd-section" aria-label="Type a balance">
        <h3 class="dd-h3">Type a balance</h3>
        <form class="dd-form" novalidate data-testid="balance-form" @submit.prevent="submit">
          <label class="dd-field">
            <span>As of</span>
            <input v-model="asOf" type="date" :max="today" data-testid="bal-date" />
          </label>
          <label class="dd-field">
            <span>Balance owed ($)</span>
            <input v-model="balanceText" type="text" inputmode="decimal" autocomplete="off" placeholder="1,250.00" data-testid="bal-amount" />
          </label>
          <label class="dd-field">
            <span>Rate (% APR, optional)</span>
            <input v-model="rateText" type="text" inputmode="decimal" autocomplete="off" placeholder="19.99" data-testid="bal-rate" />
          </label>
          <button type="submit" class="btn btn-primary dd-save" :disabled="saving" data-testid="bal-save">{{ saving ? 'Saving…' : 'Save balance' }}</button>
          <p v-if="formError" class="dd-error" role="alert" data-testid="bal-error">{{ formError }}</p>
          <p v-if="savedNote" class="dd-saved" role="status" data-testid="bal-saved">{{ savedNote }}</p>
        </form>
      </section>
    </template>
  </div>
</template>

<style scoped>
.debt-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.dd-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.dd-back {
  min-height: 44px;
}
.dd-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.dd-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  color: rgb(var(--ink-2));
}
.dd-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dd-sk-chart {
  height: 180px;
  border-radius: 8px;
  background: rgb(var(--sunken));
}
.dd-sk-row {
  height: 18px;
  border-radius: 6px;
  background: rgb(var(--sunken));
}
.dd-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  margin: 0;
}
.dd-facts dt {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.dd-facts dd {
  margin: 0;
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.dd-facts dd.dd-sub {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.dd-section {
  min-width: 0;
}
.dd-top,
.dd-tables {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  min-width: 0;
}
.dd-side {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
@media (min-width: 1024px) {
  .dd-top:not(.dd-top-solo),
  .dd-tables {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (min-width: 1600px) {
  .dd-top:not(.dd-top-solo) {
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  }
}
.dd-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px 20px;
  margin: 0;
}
.dd-grid dt {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.dd-grid dd {
  margin: 0;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
.dd-grid dd.dd-sub {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.dd-empty {
  margin: 0;
  font-size: 14px;
  color: rgb(var(--ink-3));
}
.dd-badge {
  margin-left: 6px;
  padding: 1px 8px;
  border: 1px solid rgb(var(--line));
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  color: rgb(var(--ink-2));
}
.dd-promos {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dd-promo {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  padding: 8px 10px;
  border: 1px solid rgb(var(--line));
  border-radius: 8px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.dd-promo-bal {
  font-weight: 600;
}
.dd-promo-soon {
  border-color: rgb(var(--amber));
  background: rgb(var(--amber) / 0.12);
}
.dd-h3 {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
}
.dd-chart {
  position: relative;
  height: 220px;
}
.dd-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
}
.dd-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: rgb(var(--ink-2));
}
.dd-field input {
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid rgb(var(--line));
  border-radius: 8px;
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  font: inherit;
  font-size: 14px;
}
.dd-field input:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 1px;
}
.dd-save {
  min-height: 44px;
}
.dd-error,
.dd-saved {
  flex: 1 1 100%;
  margin: 0;
  font-size: 13px;
}
.dd-error {
  color: rgb(var(--g4));
}
.dd-saved {
  color: rgb(var(--ink-2));
}
@media (max-width: 480px) {
  .dd-field {
    flex: 1 1 100%;
  }
}
</style>
