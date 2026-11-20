<script setup lang="ts">
// The debt pie: DrillPie of each debt's balance (a slice opens that debt's detail), then the debts that have
// no balance yet, each with "Add balance". BudgetSection fetches /debts and shows loading / error / "No debts
// recorded" itself.
//
// Props
//   debts:   DebtSlice[]   the answer for the current person filter; never null, never empty.
//   dark:    boolean       site theme.
//   canEdit: boolean       true once the access probe said 200 (NOT the site's view-only flag): show
//                          "Add balance" controls only when true.
// Emits
//   open(accountId: string)   a slice, a list row or "Add balance" was picked: BudgetSection swaps this
//                             panel for <DebtDetail> of that account.
import { computed } from 'vue'
import { debtSlices } from '../../lib/budget/pieModel'
import { formatAmount } from '../../lib/budget/tableModel'
import type { DebtSlice } from '../../lib/budget/types'
import DrillPie from '../charts/DrillPie.vue'

const props = defineProps<{ debts: DebtSlice[]; dark: boolean; canEdit: boolean }>()
const emit = defineEmits<{ open: [accountId: string] }>()

const model = computed(() => debtSlices(props.debts))
const totalCents = computed(() => props.debts.reduce((n, d) => n + Math.max(0, d.balanceCents ?? 0), 0))
const others = computed(() => [...model.value.noBalance, ...model.value.settled])

function onSelect(key: string) {
  emit('open', key)
}
const asOf = (d: DebtSlice) => (d.asOf ? `as of ${d.asOf}` : '')
</script>

<template>
  <div class="debt-panel" data-testid="debt-panel">
    <p class="dp-total" data-testid="debt-total">
      <span class="dp-total-label">Total owed</span>
      <strong class="dp-total-value">{{ formatAmount(totalCents) }}</strong>
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
.dp-total-label {
  font-size: 14px;
  color: rgb(var(--ink-2));
}
.dp-total-value {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
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
