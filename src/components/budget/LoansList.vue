<script setup lang="ts">
// The Loans page's list: a facts row (owed, monthly payments, interest, last payoff) and one table of every debt,
// "Loans" first, then "Cards". LoansPage loads the data (one /loans call per page view) and passes it in; this
// does the arithmetic with lib/budget/loanMath.ts. Built from EditableTable (card labels) and a facts `dl`: no new widget type.
//
// Props
//   data: LoansResponse | null   the /api/budget/loans response (null until loaded or after a failure).
//   loading, failed: boolean     the load state; failed shows a Retry.
// Emits
//   retry()    Retry was pressed.
//   open(id)   a row was clicked or tapped (its debt name is also a button, for the keyboard).
import { computed } from 'vue'
import { daysBetween } from '../../lib/budget/dates'
import {
  monthlyInterestCents, monthlyPaymentCents, monthsToPayoff, payoffMonth, totalOwed,
} from '../../lib/budget/loanMath'
import { formatApr } from '../../lib/budget/pieModel'
import { formatAmount, formatDate } from '../../lib/budget/tableModel'
import type { LoanRow, LoansResponse } from '../../lib/budget/types'
import { todayIso } from '../../lib/budget/viewState'
import EditableTable, { type EditableColumn } from '../table/EditableTable.vue'

const props = defineProps<{ data: LoansResponse | null; loading: boolean; failed: boolean }>()
const emit = defineEmits<{ open: [id: string]; retry: [] }>()

const dash = '—'
const money = (c: number | null) => (c === null ? dash : formatAmount(c))
const PROMO_WARN_DAYS = 60

interface Calc {
  row: LoanRow
  cosigned: boolean
  payment: { cents: number; source: string } | null
  interestCents: number | null
  payoff: string
  payoffKey: number | null // month index of the payoff, for "last payoff"
  openEnd: boolean
  promoEnd: string | null
  promoSoon: boolean
}
function monthIndex(asOf: string, months: number): number {
  const m = /^(\d{4})-(\d{2})/.exec(asOf)
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 + months : 0
}
function calc(row: LoanRow, today: string): Calc {
  const cosigned = row.terms?.cosigned === true
  const payment = monthlyPaymentCents(
    row.terms ? { paymentCents: row.terms.paymentCents, every: row.terms.paymentEvery } : null,
    row.payments.map((p) => p.amountCents),
  )
  const openEnd = row.kind === 'line_of_credit' || /heloc|open end/i.test(row.label)
  const res = monthsToPayoff(row.balanceCents, row.aprBp, payment?.cents ?? null)
  const base = row.asOf ?? today
  let payoff = dash
  let payoffKey: number | null = null
  if (res.kind === 'paid_off') payoff = 'Paid off'
  else if (res.kind === 'not_paid_off') payoff = 'Not paid off at this payment'
  else if (res.kind === 'payoff' || res.kind === 'rate_unknown') {
    const when = payoffMonth(base, res.months)
    payoff = res.kind === 'rate_unknown' ? `${when ?? dash} (rate unknown)` : (when ?? dash)
    payoffKey = monthIndex(base, res.months)
  }
  if (openEnd && payoff !== dash) payoff += ' (new draws not counted)'
  const ends = row.promos.map((p) => p.endsOn).filter((d): d is string => !!d).sort()[0] ?? null
  return {
    row, cosigned, payment, interestCents: monthlyInterestCents(row.balanceCents, row.aprBp),
    payoff, payoffKey, openEnd,
    promoEnd: ends, promoSoon: ends !== null && daysBetween(today, ends) < PROMO_WARN_DAYS,
  }
}

const calcs = computed<Calc[]>(() => {
  const today = todayIso()
  return (props.data?.debts ?? []).map((r) => calc(r, today))
})

const facts = computed(() => {
  const own = calcs.value.filter((c) => !c.cosigned)
  const owed = totalOwed(calcs.value.map((c) => ({ balanceCents: c.row.balanceCents, cosigned: c.cosigned })))
  const payments = own.reduce((a, c) => a + (c.payment?.cents ?? 0), 0)
  const interest = own.reduce((a, c) => a + (c.interestCents ?? 0), 0)
  const keys = own.map((c) => c.payoffKey).filter((k): k is number => k !== null)
  const last = keys.length ? Math.max(...keys) : null
  let lastText = dash
  if (last !== null) {
    const y = Math.floor(last / 12)
    lastText = payoffMonth(`${y}-${String((last % 12) + 1).padStart(2, '0')}-01`, 0) ?? dash
  }
  return { ...owed, payments, interest, lastText }
})

interface ListRow {
  id: string; debt: string; cosigned: boolean; balance: string; asOf: string; apr: string; payment: string
  paymentSource: string; interest: string; payoff: string; due: string; minDue: string; promo: string; promoSoon: boolean
}
const columns: EditableColumn<ListRow>[] = [
  { key: 'debt', label: 'Debt', editor: null },
  { key: 'balance', label: 'Balance', editor: null, align: 'end' },
  { key: 'asOf', label: 'As of', editor: null },
  { key: 'apr', label: 'APR', editor: null, align: 'end' },
  { key: 'payment', label: 'Payment / mo', editor: null, align: 'end' },
  { key: 'interest', label: 'Interest / mo', editor: null, align: 'end' },
  { key: 'payoff', label: 'Payoff', editor: null },
  { key: 'due', label: 'Due', editor: null },
  { key: 'minDue', label: 'Min due', editor: null, align: 'end' },
  { key: 'promo', label: 'Promo ends', editor: null },
]
function toRow(c: Calc): ListRow {
  const r = c.row
  return {
    id: r.accountId,
    debt: `${r.label}${r.last4 ? ` ••${r.last4}` : ''}`,
    cosigned: c.cosigned,
    balance: money(r.balanceCents),
    asOf: r.asOf ? formatDate(r.asOf) : dash,
    apr: r.aprBp === null ? dash : formatApr(r.aprBp),
    payment: c.payment ? formatAmount(c.payment.cents) : dash,
    paymentSource: c.payment ? c.payment.source : '',
    interest: money(c.interestCents),
    payoff: c.payoff,
    due: r.latest?.dueDate ? formatDate(r.latest.dueDate) : dash,
    minDue: money(r.latest?.minDueCents ?? null),
    promo: c.promoEnd ? formatDate(c.promoEnd) : dash,
    promoSoon: c.promoSoon,
  }
}
const loanRows = computed(() => calcs.value.filter((c) => c.row.kind !== 'card').map(toRow))
const cardRows = computed(() => calcs.value.filter((c) => c.row.kind === 'card').map(toRow))
const groups = computed(() => [
  { id: 'loans', title: 'Loans', rows: loanRows.value },
  { id: 'cards', title: 'Cards', rows: cardRows.value },
].filter((g) => g.rows.length))

function onClick(e: MouseEvent) {
  const el = (e.target as HTMLElement | null)?.closest?.('[data-row-key]')
  const id = el?.getAttribute('data-row-key')
  if (id) emit('open', id)
}
</script>

<template>
  <div class="loans-list" data-testid="loans-list">
    <div v-if="failed" class="ll-note" role="alert">
      <span>Couldn’t load the loans.</span>
      <button type="button" class="btn" data-testid="loans-retry" @click="emit('retry')">Retry</button>
    </div>
    <div v-else-if="loading && !data" class="ll-skeleton" aria-busy="true" aria-label="Loading loans">
      <div v-for="n in 5" :key="n" class="ll-sk-row" />
    </div>
    <template v-else-if="data">
      <dl class="ll-facts" data-testid="loans-facts">
        <div>
          <dt>Total owed</dt>
          <dd data-testid="fact-owed">{{ formatAmount(facts.totalCents) }}</dd>
          <dd v-if="facts.cosignedCents > 0" class="ll-sub" data-testid="fact-cosigned">+ {{ formatAmount(facts.cosignedCents) }} cosigned</dd>
          <dd v-if="facts.missingCount > 0" class="ll-sub" data-testid="fact-missing">
            {{ facts.missingCount }} {{ facts.missingCount === 1 ? 'debt' : 'debts' }} without a balance
          </dd>
        </div>
        <div>
          <dt>Monthly payments</dt>
          <dd data-testid="fact-payments">{{ formatAmount(facts.payments) }}</dd>
        </div>
        <div>
          <dt>Interest / month</dt>
          <dd data-testid="fact-interest">{{ formatAmount(facts.interest) }}</dd>
        </div>
        <div>
          <dt>Last payoff date</dt>
          <dd data-testid="fact-last">{{ facts.lastText }}</dd>
        </div>
      </dl>

      <p v-if="!groups.length" class="ll-note" data-testid="loans-empty">No loans or cards.</p>
      <!-- A click anywhere on a row opens it; the debt name is a button so the keyboard can too. -->
      <section v-for="g in groups" :key="g.id" class="ll-group" :aria-label="g.title" :data-testid="`group-${g.id}`" @click="onClick">
        <h3 class="ll-h3">{{ g.title }}</h3>
        <EditableTable :columns="columns" :rows="g.rows" row-key="id" :label="g.title" card-labels>
          <template #cell-debt="{ row }">
            <button type="button" class="ll-open" @click.stop="emit('open', row.id)">{{ row.debt }}</button>
            <span v-if="row.cosigned" class="ll-badge" data-testid="cosigned-badge">Cosigned</span>
          </template>
          <template #cell-payment="{ row }">
            {{ row.payment }}<span v-if="row.paymentSource" class="ll-src"> ({{ row.paymentSource }})</span>
          </template>
          <template #cell-promo="{ row }">
            <span :class="{ 'll-soon': row.promoSoon }" :data-testid="row.promoSoon ? 'promo-soon' : undefined">{{ row.promo }}</span>
          </template>
        </EditableTable>
      </section>
    </template>
  </div>
</template>

<style scoped>
.loans-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.ll-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 14px;
  color: rgb(var(--ink-2));
}
.ll-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ll-sk-row {
  height: 18px;
  border-radius: 6px;
  background: rgb(var(--sunken));
}
.ll-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px 28px;
  margin: 0;
}
.ll-facts > div {
  min-width: 0;
}
.ll-facts dt {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.ll-facts dd {
  margin: 0;
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.ll-facts dd.ll-sub {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.ll-group {
  min-width: 0;
  cursor: pointer;
}
.ll-h3 {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
}
.ll-open {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-weight: 600;
  text-align: start;
  cursor: pointer;
}
.ll-open:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 2px;
}
.ll-badge {
  margin-inline-start: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgb(var(--sunken));
  font-size: 11px;
  color: rgb(var(--ink-2));
}
.ll-src {
  font-size: 11px;
  color: rgb(var(--ink-3));
}
.ll-soon {
  padding: 1px 6px;
  border-radius: 6px;
  background: rgb(var(--amber-tint));
  color: rgb(var(--amber-hover));
  font-weight: 600;
}
@media (max-width: 1023px) {
  .ll-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
