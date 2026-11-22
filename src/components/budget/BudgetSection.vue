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
import { readHiddenPanels, togglePanel, writeHiddenPanels, type PanelId } from '../../lib/budget/panelVisibility'
import type { Category, DebtSlice, IsoDate, MetaResponse, SummaryResponse } from '../../lib/budget/types'
import type { BudgetPage } from '../../lib/budget/sectionLink'
import { useBudgetViewState, type DrillStep, type GroupBy } from '../../lib/budget/viewState'
import BudgetFilters from './BudgetFilters.vue'
import BudgetTable from './BudgetTable.vue'
import LoansPage from './LoansPage.vue'
import DebtPanel from './DebtPanel.vue'
import SpendingPanel from './SpendingPanel.vue'

const props = defineProps<{ dark: boolean; today?: IsoDate }>()

const { state, summaryQuery, txnQuery, readUrl, setRange, setPerson, pushStep, popTo, setGroupBy, setReviewOnly, setTab, setPage } =
  useBudgetViewState(props.today)

// ── Access ────────────────────────────────────────────────────────────────────────────────────────────────
const access = ref<'checking' | 'ok' | 'denied' | 'expired' | 'error'>('checking')
const canEdit = computed(() => access.value === 'ok')
const accountEmail = ref('') // from the access probe: the key of this viewer's saved view choices (hashed there)

// ── Hidden charts (desktop) ───────────────────────────────────────────────────────────────────────────────
// Which of the two charts this viewer hid, remembered per account in localStorage (lib/budget/panelVisibility.ts).
// Read once the account is known; at most one chart can be hidden. Below 1024 px the tabs pick the panel and
// this is ignored.
const hiddenPanels = ref<PanelId[]>([])
function onTogglePanel(id: PanelId) {
  hiddenPanels.value = togglePanel(hiddenPanels.value, id)
  writeHiddenPanels(accountEmail.value, hiddenPanels.value)
}

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
  const probed = await probeAccess()
  access.value = probed.state
  if (probed.state === 'ok') {
    accountEmail.value = probed.email
    hiddenPanels.value = readHiddenPanels(probed.email)
    await loadMeta()
  }
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
// The drill position the summary on screen was fetched for. Any change (a new level, range, person) keeps the
// old pie on screen, dimmed, until the new answer lands, then the pie plays into it: no skeleton in between
// (only before the very first answer). So the panel is given THIS path, not the live one: path and answer
// arrive together.
const shown = ref<{ path: DrillStep[]; groupBy: GroupBy } | null>(null)
const shownPath = computed(() => shown.value?.path ?? [])
const shownGroupBy = computed(() => shown.value?.groupBy ?? 'merchant')
const shapeKey = (path: DrillStep[], groupBy: GroupBy) => JSON.stringify([path.map((s) => s.key), groupBy])
// The pie on screen is for another drill position than the one asked for: its slices must not be drilled into.
const pieIsStale = computed(() => !!shown.value && shapeKey(shown.value.path, shown.value.groupBy) !== shapeKey(state.path, state.groupBy))
function onDrill(step: DrillStep) {
  if (!pieIsStale.value) pushStep(step)
}
async function loadSummary() {
  const seq = ++summarySeq
  const asked = { path: state.path.map((s) => ({ ...s })), groupBy: state.groupBy }
  summaryLoading.value = true
  summaryError.value = false
  try {
    const r = await fetchSummary(summaryQuery.value)
    if (seq !== summarySeq) return
    summary.value = r
    shown.value = asked
  } catch {
    if (seq !== summarySeq) return
    summary.value = null
    shown.value = null
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
// A pane that holds its chart panel joins the shared grid rows (so the two donuts and lists line up); a pane that
// shows a note, a skeleton or a debt's detail does not.
const spendingPanelUp = computed(
  () => !summaryError.value && !!summary.value && !(summary.value.level === 'category' && summary.value.slices.length === 0),
)
const debtPanelUp = computed(() => !debtsError.value && !!debts.value && debts.value.length > 0)
function onDebtSaved() {
  debtsRefresh.value++
}

// ── Table / edits ─────────────────────────────────────────────────────────────────────────────────────────
function onEdited() {
  refreshKey.value++
}
/** A category made in the table: every list, dot and pie slice reads `meta.categories`, so it goes in there. */
function onCategoryAdded(c: Category) {
  const m = meta.value
  if (m && !m.categories.some((x) => x.id === c.id)) meta.value = { ...m, categories: [...m.categories, c] }
}

// ── Pages ─────────────────────────────────────────────────────────────────────────────────────────────────
// Overview or Loans (lib/budget/viewState.ts keeps it in `b_page`). The shell tells App when it changes (the top
// bar crumbs and the remembered page) and App asks for a page through `goPage` (the ☰ menu, the crumbs).
const emit = defineEmits<{ page: [page: BudgetPage] }>()
watch(() => state.page, (p) => emit('page', p), { immediate: true })
function goPage(page: BudgetPage) {
  setPage(page)
}
defineExpose({ goPage })

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
          :hidden="state.page === 'overview' ? hiddenPanels : undefined"
          :range-hidden="state.page === 'loans'"
          @range="(r) => setRange(r.from, r.to)"
          @person="setPerson"
          @toggle-panel="onTogglePanel"
        />

        <LoansPage
          v-if="state.page === 'loans'"
          :person="state.person === 'all' ? null : state.person"
          :loan-id="state.loan"
          :can-edit="canEdit"
          :dark="dark"
          @open="(id) => setPage('loans', id)"
          @close="setPage('loans')"
          @saved="onDebtSaved"
        />

        <template v-else>
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

        <div class="b-grid" :class="{ solo: hiddenPanels.length > 0 }">
          <div
            class="b-pane"
            :class="{ active: state.tab === 'spending', 'is-hidden': hiddenPanels.includes('spending'), 'has-panel': spendingPanelUp }"
            data-pane="spending"
          >
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
              :path="shownPath"
              :group-by="shownGroupBy"
              :review-only="state.reviewOnly"
              :dark="dark"
              :refreshing="summaryLoading"
              @drill="onDrill"
              @crumb="popTo"
              @group-by="setGroupBy"
              @review-only="setReviewOnly"
              @select-purchase="(id) => (highlightId = id)"
            />
          </div>

          <div
            class="b-pane"
            :class="{ active: state.tab === 'debts', 'is-hidden': hiddenPanels.includes('debts'), 'has-panel': debtPanelUp }"
            data-pane="debts"
          >
            <div v-if="debtsError" class="b-note" role="alert">
              <span>Couldn't load debts.</span>
              <button type="button" class="btn" data-testid="budget-retry-debts" @click="loadDebts">Retry</button>
            </div>
            <div v-else-if="!debts" class="b-skeleton" aria-busy="true" aria-label="Loading debts">
              <div class="sk-pie" />
              <div v-for="n in 6" :key="n" class="sk-row" />
            </div>
            <p v-else-if="debts.length === 0" class="b-note" data-testid="budget-empty-debts">No debts recorded</p>
            <DebtPanel v-else :debts="debts" :dark="dark" :can-edit="canEdit" @open="(id) => setPage('loans', id)" />
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
            @category-added="onCategoryAdded"
          />
        </div>
        </template>
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
  /* Side by side. The grid has shared rows and each panel takes them as a subgrid, so the same part of each panel
   * sits in the same row whatever height the other has: 1 header (the spending crumbs / review / total stack, the
   * debt total), 2 the donut, 3 the hint line, 4 the list, 5 whatever follows the list (the debts without a
   * balance; the last row takes any spare height). Layout only: no pixel offsets. Row gaps are 0; the spacing is
   * margins on the items, so a row with nothing in it (no hint) costs nothing. */
  .b-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto auto auto auto 1fr;
    column-gap: 16px;
    row-gap: 0;
    align-items: start;
  }
  .b-pane {
    grid-row: 1 / -1;
  }
  .b-pane.has-panel {
    display: grid;
    grid-template-rows: subgrid;
    align-self: stretch;
  }
  /* A hidden chart takes its whole panel away (the table stays); the one left is centred at a readable width. */
  .b-pane.is-hidden {
    display: none;
  }
  .b-grid.solo {
    grid-template-columns: minmax(0, 720px);
    justify-content: center;
  }

  /* The panels' own parts, placed in those rows (the DrillPie wrapper dissolves so its donut, hint and list are
   * placed directly). The panels are drawn by SpendingPanel / DebtPanel / DrillPie, hence :deep. */
  .b-pane.has-panel :deep(.spending-panel),
  .b-pane.has-panel :deep(.debt-panel) {
    display: grid;
    grid-template-rows: subgrid;
    grid-row: 1 / -1;
    row-gap: 0;
    align-items: start;
  }
  .b-pane.has-panel :deep(.sp-body),
  .b-pane.has-panel :deep(.drill-pie) {
    display: contents;
  }
  .b-pane.has-panel :deep(.sp-top),
  .b-pane.has-panel :deep(.dp-total) {
    grid-row: 1;
    align-self: end; /* the two totals share a line at the bottom of the header row */
  }
  .b-pane.has-panel :deep(.dp-canvas) {
    grid-row: 2;
    justify-self: center;
    align-self: start;
    margin-top: 8px;
  }
  .b-pane.has-panel :deep(.dp-hint) {
    grid-row: 3;
    margin: 12px 0 0;
  }
  .b-pane.has-panel :deep(.dp-list) {
    grid-row: 4 / 6; /* spans the row after it, so a longer list than the other panel's does not stretch row 4 */
    margin-top: 12px;
  }
  .b-pane.has-panel :deep(.debt-panel .dp-list) {
    grid-row: 4;
  }
  .b-pane.has-panel :deep(.sp-none),
  .b-pane.has-panel :deep(.dp-none) {
    grid-row: 4;
    margin-top: 12px;
  }
  .b-pane.has-panel :deep(.dp-others) {
    grid-row: 5;
    margin-top: 12px;
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
