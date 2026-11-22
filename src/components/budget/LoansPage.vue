<script setup lang="ts">
// The Budget section's Loans page (docs/adr/0007-budget-section.md): the list of every debt, or one open loan.
// It makes the page's one /api/budget/loans call (per person; again after a saved edit), hands the response to
// LoansList, and hands the open loan's last-3-month payment totals to DebtDetail for its payoff estimate when the
// loan has no scheduled payment. BudgetSection owns the view state, so the open loan arrives as `loanId` and is
// opened and closed through `open` / `close` (it lives in history.state, never in the URL: an account id names an
// institution).
//
// Props: `person` (a person id, or null for everyone), `loanId` (the open loan, or null), `canEdit`, `dark`.
// Emits: `open(id)`, `close()`, and `saved` when the open loan's edit was saved.
import { computed, ref, watch } from 'vue'
import { fetchLoans } from '../../lib/budget/clientRead'
import type { LoansResponse } from '../../lib/budget/types'
import DebtDetail from './DebtDetail.vue'
import LoansList from './LoansList.vue'

const props = withDefaults(defineProps<{ person: string | null; loanId: string | null; canEdit?: boolean; dark?: boolean }>(), {
  canEdit: false,
  dark: false,
})
const emit = defineEmits<{ open: [id: string]; close: []; saved: [] }>()

const data = ref<LoansResponse | null>(null)
const loading = ref(true)
const failed = ref(false)
let seq = 0
async function load() {
  const mine = ++seq
  loading.value = true
  failed.value = false
  try {
    const r = await fetchLoans(props.person)
    if (mine !== seq) return
    data.value = r
  } catch {
    if (mine !== seq) return
    data.value = null
    failed.value = true
  } finally {
    if (mine === seq) loading.value = false
  }
}
watch(() => props.person, load, { immediate: true })

/** The open loan's total paid in each of the last 3 full months (zero months included); undefined until loaded. */
const recentPayments = computed(() =>
  data.value?.debts.find((d) => d.accountId === props.loanId)?.payments.map((p) => p.amountCents))

function onSaved() {
  emit('saved')
  void load()
}
</script>

<template>
  <div class="loans-page" data-testid="loans-page" :data-person="person ?? 'all'">
    <template v-if="loanId">
      <button type="button" class="btn lp-back" data-testid="loans-back" @click="emit('close')">← Loans</button>
      <DebtDetail
        :account-id="loanId" :can-edit="canEdit" :dark="dark" hide-back :recent-payments-cents="recentPayments" :recent-months="data?.months"
        @close="emit('close')" @saved="onSaved"
      />
    </template>
    <template v-else>
      <h2 class="lp-h2">Loans</h2>
      <LoansList :data="data" :loading="loading" :failed="failed" @open="(id) => emit('open', id)" @retry="load" />
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
.lp-back {
  align-self: flex-start;
}
</style>
