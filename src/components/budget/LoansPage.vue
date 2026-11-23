<script setup lang="ts">
// The Budget section's Loans page (docs/adr/0007-budget-section.md): the list of every debt, or one open loan.
// It makes the page's one /api/budget/loans call (per person; again after a saved edit), hands the response to
// LoansList, and hands the open loan's last-3-month payment totals to DebtDetail for its payoff estimate when the
// loan has no scheduled payment. BudgetSection owns the view state, so the open loan arrives as `loanId` and is
// opened and closed through `open` / `close` (it lives in history.state, never in the URL: an account id names an
// institution).
//
// The open loan shows a breadcrumb trail (components/nav/Crumbs.vue, wrapping) in place of a back button. Opened from the
// Loans list: `Loans > <name ••last4>`. Opened from the Overview debt drill's "Loan details": `All debts > <name ••last4>
// > Loan details`; from a Details button of the debt list: `All debts > <name ••last4>`. Each earlier crumb is exactly
// what browser Back goes to (viewState.ts backToOverview).
//
// Props: `person` (a person id, or null for everyone), `loanId` (the open loan, or null), `from` (where it was opened
// from: viewState.ts LoanFrom, null = this page's list), `canEdit`, `dark`.
// Emits: `open(id)`, `close()` (the Loans crumb), `leave(clearDebt)` (a crumb back to Overview: `true` = to the debt list,
// `false` = to the debt it was opened from), and `saved` when the open loan's edit was saved.
import { computed, ref, watch } from 'vue'
import { fetchLoans } from '../../lib/budget/clientRead'
import type { LoansResponse } from '../../lib/budget/types'
import type { LoanFrom } from '../../lib/budget/viewState'
import Crumbs from '../nav/Crumbs.vue'
import DebtDetail from './DebtDetail.vue'
import LoansList from './LoansList.vue'

const props = withDefaults(defineProps<{ person: string | null; loanId: string | null; from?: LoanFrom | null; canEdit?: boolean; dark?: boolean }>(), {
  from: null,
  canEdit: false,
  dark: false,
})
const emit = defineEmits<{ open: [id: string]; close: []; leave: [clearDebt: boolean]; saved: [] }>()

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

/** "Mortgage ••8714": the open loan's name, once the list has loaded. */
const loanName = computed(() => {
  const d = data.value?.debts.find((x) => x.accountId === props.loanId)
  return d ? `${d.label}${d.last4 ? ` ••${d.last4}` : ''}` : 'Loan'
})
const trail = computed(() => {
  const name = { key: props.loanId ?? '', label: loanName.value }
  if (props.from === 'drill') return [{ key: 'all', label: 'All debts' }, name, { key: 'details', label: 'Loan details' }]
  if (props.from === 'debts') return [{ key: 'all', label: 'All debts' }, name]
  return [{ key: 'loans', label: 'Loans' }, name]
})
function onCrumb(i: number) {
  if (!props.from) emit('close')
  else emit('leave', props.from === 'drill' && i === 0)
}

function onSaved() {
  emit('saved')
  void load()
}
</script>

<template>
  <div class="loans-page" data-testid="loans-page" :data-person="person ?? 'all'">
    <template v-if="loanId">
      <Crumbs :items="trail" label="Loan path" wrap class="lp-crumbs" @go="onCrumb" />
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
.lp-crumbs {
  align-self: stretch;
}
</style>
