<script setup lang="ts">
// The debt pie: DrillPie of each debt's balance, then the debts that have no balance yet, each with "Add
// balance". A slice (or its legend row) drills IN PLACE: the pie gives way to that debt's balance line with an
// "All debts > <name>" crumb above it and a "Loan details" link to the Loans page; the crumb (or browser Back)
// returns to the pie. BudgetSection fetches /debts and the drilled debt's history, and shows loading / error /
// "No debts recorded" itself.
//
// Props
//   debts:    DebtSlice[]   the answer for the current person filter; never null, never empty.
//   dark:     boolean       site theme.
//   canEdit:  boolean       true once the access probe said 200 (NOT the site's view-only flag): show
//                           "Add balance" controls only when true.
//   selected: DebtSlice | null   the drilled debt (null = the pie)
//   history:  rows | null   the drilled debt's balance history (null while it loads)
//   historyFailed: boolean  the history could not be loaded
// Emits
//   drill(accountId)   a slice or legend row was picked: BudgetSection opens that debt in place
//   back()             the "All debts" crumb: back to the pie
//   open(accountId)    "Details", "Add balance" or "Loan details": BudgetSection opens the Loans page on that loan
//   retry()            "Retry" after the history failed
import { computed } from 'vue'
import { debtSlices } from '../../lib/budget/pieModel'
import { formatAmount } from '../../lib/budget/tableModel'
import type { DebtSlice } from '../../lib/budget/types'
import { totalOwed } from '../../lib/budget/loanMath'
import DrillPie from '../charts/DrillPie.vue'
import Crumbs from '../nav/Crumbs.vue'
import BalanceChart from './BalanceChart.vue'

const props = defineProps<{
  debts: DebtSlice[]
  dark: boolean
  canEdit: boolean
  selected?: DebtSlice | null
  history?: ReadonlyArray<{ asOf: string; balanceCents: number }> | null
  historyFailed?: boolean
}>()
const emit = defineEmits<{ drill: [accountId: string]; back: []; open: [accountId: string]; retry: [] }>()

const model = computed(() => debtSlices(props.debts))
// the Loans page's rule: a cosigned debt is shown but kept out of the total (and the pie), with its own line
const owed = computed(() => totalOwed(props.debts.map((d) => ({ balanceCents: d.balanceCents === null ? null : Math.max(0, d.balanceCents), cosigned: d.cosigned === true }))))
const totalCents = computed(() => owed.value.totalCents)
const others = computed(() => [...model.value.noBalance, ...model.value.settled])

function onSelect(key: string) {
  emit('drill', key)
}
const name = (d: DebtSlice) => `${d.label}${d.last4 ? ` ••${d.last4}` : ''}`
const crumbItems = computed(() => (props.selected ? [{ key: 'all', label: 'All debts' }, { key: props.selected.accountId, label: name(props.selected) }] : []))
const asOf = (d: DebtSlice) => (d.asOf ? `as of ${d.asOf}` : '')
</script>

<template>
  <div v-if="selected" class="debt-panel" data-testid="debt-panel">
    <div class="dp-total dp-crumbhead">
      <Crumbs :items="crumbItems" label="Debts path" @go="emit('back')" />
    </div>
    <div class="dp-drilled" data-testid="debt-drilled">
      <p class="dp-balance">
        <strong class="dp-total-value" data-testid="debt-drilled-balance">{{ selected.balanceCents === null ? 'No balance yet' : formatAmount(selected.balanceCents) }}</strong>
        <span v-if="selected.asOf" class="dp-total-sub">{{ asOf(selected) }}</span>
      </p>
      <BalanceChart v-if="history" :history="history" :dark="dark" :label="name(selected)" />
      <p v-else-if="historyFailed" class="dp-none" role="alert">
        Couldn't load the balance history.
        <button type="button" class="btn" data-testid="debt-drilled-retry" @click="emit('retry')">Retry</button>
      </p>
      <div v-else class="dp-line-sk" aria-busy="true" aria-label="Loading balance history" />
      <button type="button" class="btn dp-details" data-testid="debt-drilled-open" @click="emit('open', selected.accountId)">Loan details →</button>
    </div>
  </div>

  <div v-else class="debt-panel" data-testid="debt-panel">
    <p class="dp-total" data-testid="debt-total">
      <span class="dp-total-label">Total owed</span>
      <strong class="dp-total-value">{{ formatAmount(totalCents) }}</strong>
      <span v-if="owed.cosignedCents > 0" class="dp-total-sub" data-testid="debt-cosigned">+ {{ formatAmount(owed.cosignedCents) }} cosigned</span>
    </p>

    <DrillPie
      v-if="model.slices.length"
      :slices="model.slices"
      :dark="dark"
      :format="formatAmount"
      label="Debt balances"
      @select="onSelect"
    />
    <p v-else class="dp-none" data-testid="debt-none">No balances yet.</p>

    <ul v-if="model.cosigned.length" class="dp-others" aria-label="Cosigned debts">
      <li v-for="d in model.cosigned" :key="d.accountId" class="dp-other">
        <span class="dp-other-text">
          <span class="dp-other-label">{{ d.label }}<template v-if="d.last4"> ••{{ d.last4 }}</template> <span class="dp-badge" data-testid="cosigned-badge">Cosigned</span></span>
          <span class="dp-other-note">{{ formatAmount(d.balanceCents ?? 0) }} {{ asOf(d) }}</span>
        </span>
        <button type="button" class="btn dp-add" :data-testid="`debt-open-${d.accountId}`" @click="emit('open', d.accountId)">Details</button>
      </li>
    </ul>

    <ul v-if="others.length" class="dp-others" aria-label="Debts without a balance">
      <li v-for="d in others" :key="d.accountId" class="dp-other">
        <span class="dp-other-text">
          <span class="dp-other-label">{{ d.label }}<template v-if="d.last4"> ••{{ d.last4 }}</template></span>
          <span class="dp-other-note">{{ d.balanceCents === null ? 'No balance yet' : `Paid off ${asOf(d)}` }}</span>
        </span>
        <button
          v-if="d.balanceCents === null && canEdit"
          type="button"
          class="btn dp-add"
          :data-testid="`debt-add-${d.accountId}`"
          @click="emit('open', d.accountId)"
        >Add balance</button>
        <button v-else type="button" class="btn dp-add" :data-testid="`debt-open-${d.accountId}`" @click="emit('open', d.accountId)">Details</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.debt-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
/* A debt's name wraps in the legend instead of being cut (a long one, such as a line of credit, stays readable). */
.debt-panel :deep(.dp-label) {
  white-space: normal;
  overflow-wrap: anywhere;
}
/* The same 44 px row the spending panel's breadcrumb has, so the two headers sit on one line on desktop. */
.dp-total {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 44px;
  margin: 0;
}
.dp-total-sub {
  margin-inline-start: 8px;
  font-size: 12px;
  color: rgb(var(--ink-2));
}
.dp-badge {
  margin-inline-start: 4px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgb(var(--sunken));
  font-size: 11px;
  color: rgb(var(--ink-2));
}
.dp-total-label {
  font-size: 14px;
  color: rgb(var(--ink-2));
}
.dp-total-value {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}
.dp-crumbhead {
  min-width: 0;
}
.dp-drilled {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  width: 100%;
}
.dp-drilled > * {
  max-width: 100%;
}
.dp-drilled :deep(.dd-chart) {
  align-self: stretch;
}
.dp-balance {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
}
.dp-line-sk {
  align-self: stretch;
  height: 220px;
  border-radius: 8px;
  background: rgb(var(--sunken));
}
.dp-details {
  min-height: 44px;
}
.dp-none {
  margin: 0;
  font-size: 14px;
  color: rgb(var(--ink-2));
}
.dp-others {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid rgb(var(--line));
}
.dp-other {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 52px;
  border-bottom: 1px solid rgb(var(--line));
}
.dp-other-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.dp-other-label {
  font-size: 14px;
}
.dp-other-note {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.dp-add {
  flex: none;
  min-height: 44px;
}
</style>
