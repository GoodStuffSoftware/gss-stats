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
import type { ChartConfiguration } from 'chart.js'
import { computed, ref, watch } from 'vue'
import { fetchDebtDetail, putManualBalance } from '../../lib/budget/clientRead'
import { formatApr } from '../../lib/budget/pieModel'
import { formatAmount, formatDate } from '../../lib/budget/tableModel'
import type { DebtDetail as DebtDetailData } from '../../lib/budget/types'
import { rangeValid, todayIso } from '../../lib/budget/viewState'
import BaseChart from '../charts/BaseChart.vue'
import EditableTable, { type EditableColumn } from '../table/EditableTable.vue'

const props = defineProps<{ accountId: string; canEdit: boolean; dark: boolean }>()
const emit = defineEmits<{ close: []; saved: [] }>()

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
/** The account's own rate, else the newest statement's. */
const rateBp = computed(() => {
  const d = detail.value
  if (!d) return null
  if (d.account.aprBp !== null) return d.account.aprBp
  const p = [...d.periods].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).find((x) => x.aprBp !== null)
  return p ? p.aprBp : null
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

// ── Balance line ─────────────────────────────────────────────────────────────────────────────────────────
const chartConfig = computed<ChartConfiguration>(() => {
  const ink = props.dark ? '#A89F92' : '#8A8278'
  const grid = props.dark ? 'rgba(255,255,255,0.08)' : '#E7E2D7'
  return {
    type: 'line',
    data: {
      labels: history.value.map((h) => formatDate(h.asOf)),
      datasets: [
        {
          data: history.value.map((h) => h.balanceCents / 100),
          borderColor: '#E0722C',
          backgroundColor: 'rgba(224,114,44,0.15)',
          fill: true,
          tension: 0.2,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => formatAmount(Math.round(Number(ctx.raw) * 100)) } },
      },
      scales: {
        x: { ticks: { color: ink, maxTicksLimit: 6 }, grid: { display: false } },
        y: { ticks: { color: ink, callback: (v) => formatAmount(Math.round(Number(v) * 100)) }, grid: { color: grid } },
      },
    },
  } as ChartConfiguration
})

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
      <button type="button" class="btn dd-back" data-testid="debt-back" @click="emit('close')">← Back to debts</button>
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

      <section v-if="history.length" class="dd-section" aria-label="Balance history">
        <h3 class="dd-h3">Balance over time</h3>
        <div class="dd-chart" role="img" :aria-label="`Balance history of ${title}`" data-testid="debt-chart">
          <BaseChart :config="chartConfig" :drill-open="false" />
        </div>
      </section>

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
