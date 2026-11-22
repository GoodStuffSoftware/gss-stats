<script setup lang="ts">
// The Budget section's Loans page (docs/adr/0007-budget-section.md). A shell for now: the loan list and the
// payoff planner land in later changes. It draws the page and reports what the viewer asks for; it fetches
// nothing itself except through DebtDetail (the one open loan). BudgetSection owns the view state, so the open
// loan arrives as `loanId` and is opened and closed through `open` / `close` (it lives in history.state, never
// in the URL: an account id names an institution).
//
// Props: `person` (a person id, or null for everyone), `loanId` (the open loan, or null), `canEdit`, `dark`.
// Emits: `open(id)`, `close()`, and `saved` when the open loan's edit was saved.
import DebtDetail from './DebtDetail.vue'

withDefaults(defineProps<{ person: string | null; loanId: string | null; canEdit?: boolean; dark?: boolean }>(), {
  canEdit: false,
  dark: false,
})
const emit = defineEmits<{ open: [id: string]; close: []; saved: [] }>()
</script>

<template>
  <div class="loans-page" data-testid="loans-page" :data-person="person ?? 'all'">
    <template v-if="loanId">
      <button type="button" class="btn lp-back" data-testid="loans-back" @click="emit('close')">← Loans</button>
      <DebtDetail :account-id="loanId" :can-edit="canEdit" :dark="dark" hide-back @close="emit('close')" @saved="emit('saved')" />
    </template>
    <template v-else>
      <h2 class="lp-h2">Loans</h2>
      <p class="lp-note" data-testid="loans-placeholder">Your loans will be listed here.</p>
    </template>
  </div>
</template>

<style scoped>
.loans-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.lp-h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.lp-note {
  margin: 0;
  font-size: 14px;
  color: rgb(var(--ink-2));
}
.lp-back {
  align-self: flex-start;
}
</style>
