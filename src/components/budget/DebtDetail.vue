<script setup lang="ts">
// STUB (leg U1a). Leg U1b fills it in (balance history line via BaseChart, rate, interest per period,
// payments list, and the manual-balance form) WITHOUT changing this contract or editing BudgetSection.vue.
// It loads its own data with clientRead.fetchDebtDetail(accountId) and saves with putManualBalance
// (clientRead.ts), and shows its own loading / error states.
//
// Props
//   accountId: string    the debt to show.
//   canEdit:   boolean   true once the access probe said 200 (NOT the site's view-only flag): the manual
//                        balance form is shown only when true.
//   dark:      boolean   site theme.
// Emits
//   close()   "Back to debts".
//   saved()   a manual balance was PUT: BudgetSection refetches /debts so the pie and list update.
defineProps<{ accountId: string; canEdit: boolean; dark: boolean }>()
defineEmits<{ close: []; saved: [] }>()
</script>

<template>
  <div class="debt-detail" data-testid="debt-detail" />
</template>
