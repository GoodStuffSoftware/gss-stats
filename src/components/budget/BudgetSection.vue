<script setup lang="ts">
// The Budget section frame (docs/adr/0007-budget-section.md): access check, filters, "Spending | Debts"
// tabs, the panels and the transactions table. It owns the view state (lib/budget/viewState.ts, mirrored
// to the URL) and ALL fetching, so the panels only draw and report clicks.
//
// Order of events: nothing is fetched before GET /api/budget/access (probeAccess, memoized) says 200;
// then /meta once; then /summary (and /debts) for the current state. A person or range change refetches
// /summary once; an edit in the table (`edited`) bumps `refreshKey`, which refetches /summary once and is
// passed to the table. No polling anywhere.
//
// Edit controls follow the access probe, NOT the site's view-only flag (a listed site viewer has full
// Budget rights); the server is the real check on every write.
// Props: `dark` (site theme), `today` (YYYY-MM-DD, tests only).
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchDebts, fetchMeta, fetchSummary, probeAccess, resetAccessProbe } from '../../lib/budget/clientRead'
import type { DebtSlice, IsoDate, MetaResponse, SummaryResponse } from '../../lib/budget/types'
import { useBudgetViewState } from '../../lib/budget/viewState'
import BudgetFilters from './BudgetFilters.vue'
import BudgetTable from './BudgetTable.vue'
import DebtDetail from './DebtDetail.vue'
import DebtPanel from './DebtPanel.vue'
import SpendingPanel from './SpendingPanel.vue'

const props = defineProps<{ dark: boolean; today?: IsoDate }>()

const { state, summaryQuery, txnQuery, readUrl, setRange, setPerson, pushStep, popTo, setGroupBy, setReviewOnly, setTab } =
  useBudgetViewState(props.today)

// ── Access ────────────────────────────────────────────────────────────────────────────────────────────────
const access = ref<'checking' | 'ok' | 'denied' | 'expired' | 'error'>('checking')
const canEdit = computed(() => access.value === 'ok')

// ── Meta ──────────────────────────────────────────────────────────────────────────────────────────────────
const meta = ref<MetaResponse | null>(null)
const metaError = ref(false)
const hasData = computed(() => !!meta.value && (meta.value.range.min !== null || meta.value.range.max !== null))
const ready = ref(false) // meta is in and the database has rows: data fetches may start

async function loadMeta() {
  metaError.value = false
  try {
    const m = await fetchMeta()
    if (state.person !== 'all' && !m.people.some((p) => p.id === state.person)) setPerson('all')
    meta.value = m
    ready.value = m.range.min !== null || m.range.max !== null
  } catch {
    metaError.value = true
  }
}
async function init() {
  access.value = 'checking'
  access.value = (await probeAccess()).state
  if (access.value === 'ok') await loadMeta()
}
function retryAccess() {
  resetAccessProbe() // user-initiated: the only retry there is
  void init()
}

// ── Summary (the spending pie) ────────────────────────────────────────────────────────────────────────────
const summary = ref<SummaryResponse | null>(null)
const summaryLoading = ref(false)
const summaryError = ref(false)
const refreshKey = ref(0)
const highlightId = ref<string | null>(null)
let summarySeq = 0
let summaryShape = ''
async function loadSummary() {
  const seq = ++summarySeq
  // A different drill position starts from a skeleton; a new range or person keeps the old pie, dimmed.
  const shape = JSON.stringify([state.path.map((s) => s.key), state.groupBy])
  if (shape !== summaryShape) summary.value = null
  summaryShape = shape
  summaryLoading.value = true
  summaryError.value = false
  try {
    const r = await fetchSummary(summaryQuery.value)
    if (seq !== summarySeq) return
    summary.value = r
  } catch {
    if (seq !== summarySeq) return
    summary.value = null
    summaryError.value = true
  } finally {
    if (seq === summarySeq) summaryLoading.value = false
  }
}
// One fetch per distinct query (and per refreshKey bump); the key is null until the data may be read.
watch(
  () => (ready.value ? JSON.stringify(summaryQuery.value) + '|' + refreshKey.value : null),
  (key) => {
    if (key !== null) void loadSummary()
  },
  { immediate: true },
)
watch(
  () => state.path.length + ':' + state.path.map((s) => s.key).join('/'),
  () => {
    highlightId.value = null
  },
)

// ── Debts ─────────────────────────────────────────────────────────────────────────────────────────────────
const debts = ref<DebtSlice[] | null>(null)
const debtsLoading = ref(false)
const debtsError = ref(false)
const debtsRefresh = ref(0)
const selectedDebtId = ref<string | null>(null)
let debtsSeq = 0
async function loadDebts() {
  const seq = ++debtsSeq
  debtsLoading.value = true
  debtsError.value = false
  try {
    const r = await fetchDebts(state.person)
    if (seq !== debtsSeq) return
    debts.value = r.debts
  } catch {
    if (seq !== debtsSeq) return
    debts.value = null
    debtsError.value = true
  } finally {
    if (seq === debtsSeq) debtsLoading.value = false
  }
}
watch(
  () => (ready.value ? state.person + '|' + debtsRefresh.value : null),
  (key) => {
    if (key !== null) void loadDebts()
  },
  { immediate: true },
)
function onDebtSaved() {
  debtsRefresh.value++
}

// ── Table / edits ─────────────────────────────────────────────────────────────────────────────────────────
function onEdited() {
  refreshKey.value++
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────────────────
onMounted(() => {
  window.addEventListener('popstate', readUrl)
  void init()
})
onBeforeUnmount(() => window.removeEventListener('popstate', readUrl))
</script>

<template>
  <section class="budget-section" aria-label="Budget" data-testid="budget-section">
    <p v-if="access === 'checking'" class="b-note" role="status">Loading Budget…</p>
    <p v-else-if="access === 'denied'" class="b-note" data-testid="budget-unavailable">Budget isn't available for this account</p>
    <p v-else-if="access === 'expired'" class="b-note" role="alert">Your sign-in session expired. Sign in again to open Budget.</p>
    <div v-else-if="access === 'error'" class="b-note" role="alert">
      <span>Couldn't check Budget access.</span>
      <button type="button" class="btn" data-testid="budget-retry-access" @click="retryAccess">Retry</button>
    </div>

    <template v-else>
      <div v-if="metaError" class="b-note" role="alert">
        <span>Couldn't load Budget.</span>
        <button type="button" class="btn" data-testid="budget-retry-meta" @click="loadMeta">Retry</button>
      </div>
      <div v-else-if="!meta" class="b-skeleton" aria-busy="true" aria-label="Loading">
        <div class="sk-pie" />
        <div v-for="n in 6" :key="n" class="sk-row" />
      </div>
      <p v-else-if="!hasData" class="b-note" data-testid="budget-empty-db">No statements loaded yet</p>

      <template v-else>
        <BudgetFilters
          :from="state.from"
          :to="state.to"
          :person="state.person"
          :people="meta.people"
          :today="today"
          @range="(r) => setRange(r.from, r.to)"
          @person="setPerson"
        />

        <div class="b-tabs" role="tablist" aria-label="Budget view">
          <button
            type="button"
            role="tab"
            class="b-tab"
            :class="{ on: state.tab === 'spending' }"
            :aria-selected="state.tab === 'spending'"
            data-testid="budget-tab-spending"
            @click="setTab('spending')"
          >Spending</button>
          <button
            type="button"
            role="tab"
            class="b-tab"
            :class="{ on: state.tab === 'debts' }"
            :aria-selected="state.tab === 'debts'"
            data-testid="budget-tab-debts"
            @click="setTab('debts')"
          >Debts</button>
        </div>

        <div class="b-grid">
          <div class="b-pane" :class="{ active: state.tab === 'spending' }" data-pane="spending">
            <div v-if="summaryError" class="b-note" role="alert">
              <span>Couldn't load spending.</span>
              <button type="button" class="btn" data-testid="budget-retry-summary" @click="loadSummary">Retry</button>
            </div>
            <div v-else-if="!summary" class="b-skeleton" aria-busy="true" aria-label="Loading spending">
              <div class="sk-pie" />
              <div v-for="n in 6" :key="n" class="sk-row" />
            </div>
            <p v-else-if="summary.level === 'category' && summary.slices.length === 0" class="b-note" data-testid="budget-empty-range">
              No spending in this range
            </p>
            <SpendingPanel
              v-else
              :summary="summary"
              :categories="meta.categories"
              :path="state.path"
              :group-by="state.groupBy"
              :review-only="state.reviewOnly"
              :dark="dark"
              :refreshing="summaryLoading"
              @drill="pushStep"
              @crumb="popTo"
              @group-by="setGroupBy"
              @review-only="setReviewOnly"
              @select-purchase="(id) => (highlightId = id)"
            />
          </div>

          <div class="b-pane" :class="{ active: state.tab === 'debts' }" data-pane="debts">
            <DebtDetail
              v-if="selectedDebtId"
              :account-id="selectedDebtId"
              :can-edit="canEdit"
              :dark="dark"
              @close="selectedDebtId = null"
              @saved="onDebtSaved"
            />
            <div v-else-if="debtsError" class="b-note" role="alert">
              <span>Couldn't load debts.</span>
              <button type="button" class="btn" data-testid="budget-retry-debts" @click="loadDebts">Retry</button>
            </div>
            <div v-else-if="!debts" class="b-skeleton" aria-busy="true" aria-label="Loading debts">
              <div class="sk-pie" />
              <div v-for="n in 6" :key="n" class="sk-row" />
            </div>
            <p v-else-if="debts.length === 0" class="b-note" data-testid="budget-empty-debts">No debts recorded</p>
            <DebtPanel v-else :debts="debts" :dark="dark" :can-edit="canEdit" @open="(id) => (selectedDebtId = id)" />
          </div>
        </div>

        <div class="b-table" :class="{ active: state.tab === 'spending' }" data-pane="table">
          <h2 class="b-h2">Transactions</h2>
          <BudgetTable
            :query="txnQuery"
            :categories="meta.categories"
            :accounts="meta.accounts"
            :can-edit="canEdit"
            :refresh-key="refreshKey"
            :highlight-id="highlightId"
            @edited="onEdited"
          />
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.budget-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.b-note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 24px 0;
  font-size: 14px;
  color: rgb(var(--ink-2));
}
.b-h2 {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}
.b-tabs {
  display: flex;
  border-bottom: 1px solid rgb(var(--line));
}
.b-tab {
  flex: 1 1 0;
  min-height: 44px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: rgb(var(--ink-2));
  font-size: 14px;
  font-weight: 500;
}
.b-tab.on {
  color: rgb(var(--ink));
  border-bottom-color: rgb(var(--amber));
}
.b-tab:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
}
.b-grid {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.b-pane,
.b-table {
  min-width: 0;
}
/* Below 1024px one panel at a time (the tabs); from 1024px the two sit side by side and the tabs go. */
@media (max-width: 1023.98px) {
  .b-pane:not(.active),
  .b-table:not(.active) {
    display: none;
  }
}
@media (min-width: 1024px) {
  .b-tabs {
    display: none;
  }
  .b-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: start;
  }
}
.b-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sk-pie {
  width: min(100%, 340px);
  aspect-ratio: 1;
  align-self: center;
  border-radius: 50%;
  background: rgb(var(--sunken));
}
.sk-row {
  height: 18px;
  border-radius: 6px;
  background: rgb(var(--sunken));
}
</style>
