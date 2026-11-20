<script setup lang="ts">
// Stub from the contract commit; leg U2 replaces it.
import type { BudgetTableProps, BudgetEditedEvent } from '../../lib/budget/types'

defineProps<BudgetTableProps>()
defineEmits<{ edited: [e: BudgetEditedEvent] }>()
</script>

<template>
  <div class="budget-table" />
</template>
