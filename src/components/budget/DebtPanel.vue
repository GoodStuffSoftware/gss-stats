<script setup lang="ts">
// STUB (leg U1a). Leg U1b fills it in (DrillPie of debts by balance + the list of debts that have no
// balance, each with "Add balance") WITHOUT changing this contract or editing BudgetSection.vue.
// BudgetSection fetches /debts and shows loading / error / "No debts recorded" itself.
//
// Props
//   debts:   DebtSlice[]   the answer for the current person filter; never null, never empty.
//   dark:    boolean       site theme.
//   canEdit: boolean       true once the access probe said 200 (NOT the site's view-only flag): show
//                          "Add balance" controls only when true.
// Emits
//   open(accountId: string)   a slice or a list row (or "Add balance") was picked: BudgetSection swaps this
//                             panel for <DebtDetail> of that account.
import type { DebtSlice } from '../../lib/budget/types'

defineProps<{ debts: DebtSlice[]; dark: boolean; canEdit: boolean }>()
defineEmits<{ open: [accountId: string] }>()
</script>

<template>
  <div class="debt-panel" data-testid="debt-panel" />
</template>
