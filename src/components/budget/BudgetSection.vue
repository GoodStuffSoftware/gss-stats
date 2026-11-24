<script setup lang="ts">
// The Budget section frame (docs/adr/0007-budget-section.md): access check, filters, "Spending | Debts | Both"
// tabs (at every width), the panels and the transactions table. It owns the view state (lib/budget/viewState.ts, mirrored
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
import { fetchDebtDetail, fetchDebts, fetchMeta, fetchSummary, probeAccess, resetAccessProbe } from '../../lib/budget/clientRead'
import { migrateLegacyTab, type LegacyChoice } from '../../lib/budget/panelVisibility'
import type { Category, DebtDetail, DebtSlice, IsoDate, MetaResponse, SummaryResponse } from '../../lib/budget/types'
import type { BudgetPage } from '../../lib/budget/sectionLink'
import { defaultTabFor, savedViewOfState, useBudgetViewState, type BudgetTab, type DrillStep, type GroupBy } from '../../lib/budget/viewState'
import { sameSavedView, type SavedView } from '../../lib/budget/savedView'
import { createPrefsSaver, fetchServerView, putServerView, VIEW_SAVE_DELAY_MS } from '../../lib/budget/txnPrefsStore'
import BudgetFilters from './BudgetFilters.vue'
import BudgetTable from './BudgetTable.vue'
import LoansPage from './LoansPage.vue'
import DebtPanel from './DebtPanel.vue'
import SpendingPanel from './SpendingPanel.vue'

const props = defineProps<{ dark: boolean; today?: IsoDate }>()

// ── Width ─────────────────────────────────────────────────────────────────────────────────────────────────
// From 1024 px up the tabs are Spending | Debts | Both and Both puts the two charts side by side; below that Both stacks
// them. The tab nobody chose is Both at 1024 px and wider, Spending below (lib/budget/viewState.ts `defaultTabFor`).
const narrowQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 1023.98px)') : null
const narrow = ref(!!narrowQuery?.matches)
const onNarrow = () => {
  narrow.value = !!narrowQuery?.matches
}

const { state, loanFrom, backToOverview, summaryQuery, txnQuery, readUrl, setRange, setPerson, pushStep, popTo, setGroupBy, setReviewOnly, setTab, setPage, setDebt, restoreView, applyLegacyTab, today: viewToday } =
  useBudgetViewState(props.today, () => defaultTabFor(!narrowQuery?.matches))

// ── Access ────────────────────────────────────────────────────────────────────────────────────────────────
const access = ref<'checking' | 'ok' | 'denied' | 'expired' | 'error'>('checking')
const canEdit = computed(() => access.value === 'ok')
const accountEmail = ref('') // from the access probe: the key of the pre-0.83.0 browser choices (hashed there), migrated once

// ── Tabs ──────────────────────────────────────────────────────────────────────────────────────────────────
// Spending and Debts show one chart; Both shows the two (side by side from 1024 px, stacked below). The table sits under
// Spending and under Both. A chart that has the whole row (one chart, or Both stacked) draws its donut beside its legend
// and keeps its own size per chart; in Both side by side the two donuts share ONE size (donutSizeKey).
const showSpending = computed(() => state.tab !== 'debts')
const showDebts = computed(() => state.tab !== 'spending')
const isBoth = computed(() => state.tab === 'both')
const solo = computed(() => narrow.value || !isBoth.value)
const TABS: { id: BudgetTab; label: string }[] = [
  { id: 'spending', label: 'Spending' },
  { id: 'debts', label: 'Debts' },
  { id: 'both', label: 'Both' },
]

// ── Meta ──────────────────────────────────────────────────────────────────────────────────────────────────
const meta = ref<MetaResponse | null>(null)
const metaError = ref(false)
const hasData = computed(() => !!meta.value && (meta.value.range.min !== null || meta.value.range.max !== null))
const ready = ref(false) // meta is in and the database has rows: data fetches may start

// ── Saved view (where the viewer left off) ────────────────────────────────────────────────────────────────
// The tab and the drill location are saved per login on the server (lib/budget/savedView.ts, its own KV
// key) and put back on a plain open. A link or Back/Forward state always wins (restoreView refuses), and a part
// that no longer exists falls back quietly. The GET is raced against a short timeout so a slow server never holds
// the page; the first data fetches wait for the restore so there is no double fetch.
const VIEW_GET_TIMEOUT_MS = 3000
type ServerView = { ok: boolean; view: SavedView | null; legacyOpen: boolean }
async function loadServerView(): Promise<ServerView> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ServerView>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, view: null, legacyOpen: false }), VIEW_GET_TIMEOUT_MS)
  })
  try {
    return await Promise.race([fetchServerView(), timeout])
  } finally {
    clearTimeout(timer)
  }
}
let viewLoaded: Promise<ServerView> = Promise.resolve({ ok: false, view: null, legacyOpen: false })
let pendingStep: DrillStep | null = null // the saved second drill step, checked when the first level's slices load
const viewSaver = createPrefsSaver<SavedView>(putServerView, VIEW_SAVE_DELAY_MS, undefined, undefined, sameSavedView)
let viewSaverArmed = false
let legacy: LegacyChoice = { tab: null, side: false } // the pre-0.83.0 Side by side / Show choice of this browser
const currentView = computed(() => savedViewOfState(state, viewToday))
watch(currentView, (v) => {
  if (viewSaverArmed) viewSaver.schedule(v)
})
/** Applies what the server holds (once) and arms the saver; called with the meta in, before `ready`. */
async function settleView(m: MetaResponse) {
  const sv = await viewLoaded
  if (viewSaverArmed) return
  if (sv.ok && sv.view) {
    const r = restoreView(sv.view, { categoryIds: [...m.categories.map((c) => c.id), '__none__'], personIds: m.people.map((p) => p.id) })
    pendingStep = r.pendingStep
  }
  // Baseline = what the server holds. With nothing saved it is the view as it stands before the pre-0.83.0 browser
  // choice is applied, so that choice (mapped to a tab) is sent once, and an untouched view sends nothing.
  // A saved 0.82.0 view that hid nothing carries only the phone tab: a browser that was on Side by side lands on Both
  // over it. A legacy view that hid a chart already folded into its single tab; a new view keeps its saved tab.
  const baseline = sv.view ?? currentView.value
  if (!sv.view && legacy.tab) applyLegacyTab(legacy.tab)
  else if (sv.view && sv.legacyOpen && legacy.side && !narrow.value) applyLegacyTab('both', true)
  viewSaver.setBaseline(sv.ok ? baseline : null)
  viewSaverArmed = true
  if (sv.ok) viewSaver.schedule(currentView.value)
}

async function loadMeta() {
  metaError.value = false
  try {
    const m = await fetchMeta()
    if (state.person !== 'all' && !m.people.some((p) => p.id === state.person)) setPerson('all')
    // The toolbar appears only after the saved view is applied (at most the GET timeout), so a choice made while it
    // is pending can never be overwritten by the restore. The data fetches were waiting on `ready` anyway.
    await settleView(m)
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
    const found = migrateLegacyTab(probed.email) // read once, then the old keys are gone
    legacy = { tab: found.tab ?? legacy.tab, side: found.side || legacy.side }
    viewLoaded = loadServerView()
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
    // The restored second drill step is kept only while this answer is the first level's and still has it.
    const step = pendingStep
    pendingStep = null
    if (step && asked.path.length === 1 && shapeKey(asked.path, asked.groupBy) === shapeKey(state.path, state.groupBy) && r.slices.some((s) => s.key === step.key)) {
      pushStep(step)
    }
  } catch {
    if (seq !== summarySeq) return
    pendingStep = null
    summary.value = null
    shown.value = null
    summaryError.value = true
  } finally {
    if (seq === summarySeq) summaryLoading.value = false
  }
}
// One fetch per distinct query (and per refreshKey bump); the key is null until the data may be read.
watch(
  () => (ready.value && state.page === 'overview' ? JSON.stringify(summaryQuery.value) + '|' + refreshKey.value : null),
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
  () => (ready.value && state.page === 'overview' ? state.person + '|' + debtsRefresh.value : null),
  (key) => {
    if (key !== null) void loadDebts()
  },
  { immediate: true },
)
// ── Debt drill ──────────────────────────────────────────────────────────────────────────────────────────────
// A slice or legend row of the debt pie opens that debt's balance line in place (state.debt, kept in history.state
// only, never in the URL). The history comes from GET /api/budget/debts/:id, once per drill open, cached per person
// while on the page (cleared when the person or the debts change).
const drilled = computed(() => (state.debt && debts.value ? (debts.value.find((d) => d.accountId === state.debt) ?? null) : null))
const debtHistories = new Map<string, DebtDetail['history']>()
const drillHistory = ref<DebtDetail['history'] | null>(null)
const drillFailed = ref(false)
let drillSeq = 0
// Defined before the drill watch below so a person change clears the cache before the drill reloads.
watch(
  () => state.person + '|' + debtsRefresh.value,
  () => {
    debtHistories.clear()
    drillHistory.value = null
  },
)
async function loadDrillHistory(id: string) {
  const seq = ++drillSeq
  drillFailed.value = false
  const hit = debtHistories.get(id)
  if (hit) {
    drillHistory.value = hit
    return
  }
  drillHistory.value = null
  try {
    const d = await fetchDebtDetail(id)
    if (seq !== drillSeq) return
    debtHistories.set(id, d.history)
    drillHistory.value = d.history
  } catch {
    if (seq !== drillSeq) return
    drillFailed.value = true
  }
}
// Reloads when the drilled debt changes AND when the debts are read again (a person change or a recorded balance
// clears the cache above, and the same debt can still be in the new list: its id alone would not change).
watch(
  [() => drilled.value?.accountId ?? null, debts],
  ([id]) => {
    drillSeq++
    if (id) void loadDrillHistory(id)
    else {
      drillHistory.value = null
      drillFailed.value = false
    }
  },
  { immediate: true },
)
// A drilled debt that is not among the loaded debts (a stale history entry, another person) goes back to the pie.
watch([() => state.debt, debts], ([id, list]) => {
  if (id && list && !list.some((d) => d.accountId === id)) setDebt(null)
})
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
// `fromOverview`: the open loan was reached from the Overview debt views, so the page's own trail starts at "All debts"
// and the top bar reads just "Budget" (one trail, not two that disagree). The Loans list's detail keeps "Budget > Loans".
const emit = defineEmits<{ page: [page: BudgetPage]; fromOverview: [on: boolean] }>()
watch(() => state.page, (p) => emit('page', p), { immediate: true })
watch(() => state.page === 'loans' && !!state.loan && !!loanFrom.value, (on) => emit('fromOverview', on), { immediate: true })
function goPage(page: BudgetPage) {
  setPage(page)
}
defineExpose({ goPage })

// ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────────────────
onMounted(() => {
  window.addEventListener('popstate', readUrl)
  void init()
})
// Leaving (closing the tab, another page, the section unmounting) sends a queued view change now.
const flushView = () => viewSaver.flush()
onMounted(() => {
  window.addEventListener('pagehide', flushView)
  narrowQuery?.addEventListener?.('change', onNarrow)
  onNarrow()
})
onBeforeUnmount(() => {
  narrowQuery?.removeEventListener?.('change', onNarrow)
  window.removeEventListener('popstate', readUrl)
  window.removeEventListener('pagehide', flushView)
  viewSaver.flush()
})
</script>

<template>
  <section class="budget-section" :class="{ 'is-both': isBoth }" aria-label="Budget" data-testid="budget-section">
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
          :range-hidden="state.page === 'loans'"
          @range="(r) => setRange(r.from, r.to)"
          @person="setPerson"
        />

        <LoansPage
          v-if="state.page === 'loans'"
          :person="state.person === 'all' ? null : state.person"
          :loan-id="state.loan"
          :from="loanFrom"
          :can-edit="canEdit"
          :dark="dark"
          @open="(id) => setPage('loans', id)"
          @close="setPage('loans')"
          @leave="backToOverview"
          @saved="onDebtSaved"
        />

        <template v-else>
        <div class="b-tabs" role="tablist" aria-label="Budget view">
          <button
            v-for="t in TABS"
            :key="t.id"
            type="button"
            role="tab"
            class="b-tab"
            :class="{ on: state.tab === t.id }"
            :aria-selected="state.tab === t.id"
            :data-testid="`budget-tab-${t.id}`"
            @click="setTab(t.id)"
          >{{ t.label }}</button>
        </div>

        <div class="b-grid">
          <div
            class="b-pane"
            :class="{ active: showSpending, 'has-panel': spendingPanelUp }"
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
              :solo="solo"
              :both="isBoth"
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
            :class="{ active: showDebts, 'has-panel': debtPanelUp }"
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
            <DebtPanel
              v-else
              :debts="debts"
              :dark="dark"
              :can-edit="canEdit"
              :solo="solo"
              :both="isBoth"
              :selected="drilled"
              :history="drillHistory"
              :history-failed="drillFailed"
              @drill="setDebt"
              @back="setDebt(null)"
              @open="(id) => setPage('loans', id)"
              @retry="drilled && loadDrillHistory(drilled.accountId)"
            />
          </div>
        </div>

        <div class="b-table" :class="{ active: showSpending }" data-pane="table">
          <h2 class="b-h2">Transactions</h2>
          <BudgetTable
            :query="txnQuery"
            :categories="meta.categories"
            :accounts="meta.accounts"
            :can-edit="canEdit"
            :refresh-key="refreshKey"
            :highlight-id="highlightId"
            :people="meta.people"
            :account-email="accountEmail"
            :bounds="{ from: state.from, to: state.to }"
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
/* One tab at a time at every width: the pane of a tab that is not shown goes away (Both shows both panes). Below 1024px
 * Both stacks the two charts; from 1024px they sit side by side. */
.b-pane:not(.active),
.b-table:not(.active) {
  display: none;
}
@media (min-width: 1024px) {
  /* Both side by side. The grid has shared rows and each panel takes them as a subgrid, so the same part of each panel
   * sits in the same row whatever height the other has: 1 header (the spending crumbs / review / total stack, the
   * debt total), 2 the donut, 3 the hint line, 4 the list, 5 whatever follows the list (the debts without a
   * balance; the last row takes any spare height). Layout only: no pixel offsets. Row gaps are 0; the spacing is
   * margins on the items, so a row with nothing in it (no hint) costs nothing. */
  .is-both .b-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto auto auto auto 1fr;
    column-gap: 16px;
    row-gap: 0;
    align-items: start;
  }
  .is-both .b-pane {
    grid-row: 1 / -1;
  }
  .is-both .b-grid .b-pane.has-panel {
    display: grid;
    grid-template-rows: subgrid;
    align-self: stretch;
  }

  /* The panels' own parts, placed in those rows (the DrillPie wrapper dissolves so its donut, hint and list are
   * placed directly). The panels are drawn by SpendingPanel / DebtPanel / DrillPie, hence :deep. */
  .is-both .b-grid .b-pane.has-panel :deep(.spending-panel),
  .is-both .b-grid .b-pane.has-panel :deep(.debt-panel) {
    display: grid;
    grid-template-rows: subgrid;
    grid-row: 1 / -1;
    row-gap: 0;
    align-items: start;
  }
  .is-both .b-grid .b-pane.has-panel :deep(.sp-body),
  .is-both .b-grid .b-pane.has-panel :deep(.drill-pie) {
    display: contents;
  }
  .is-both .b-grid .b-pane.has-panel :deep(.sp-top),
  .is-both .b-grid .b-pane.has-panel :deep(.dp-total) {
    grid-row: 1;
    align-self: end; /* the two totals share a line at the bottom of the header row */
  }
  .is-both .b-grid .b-pane.has-panel :deep(.dp-canvas) {
    grid-row: 2;
    justify-self: center;
    align-self: start;
    margin-top: 8px;
  }
  .is-both .b-grid .b-pane.has-panel :deep(.dp-hint) {
    grid-row: 3;
    margin: 12px 0 0;
  }
  .is-both .b-grid .b-pane.has-panel :deep(.dp-list) {
    grid-row: 4 / 6; /* spans the row after it, so a longer list than the other panel's does not stretch row 4 */
    margin-top: 12px;
  }
  .is-both .b-grid .b-pane.has-panel :deep(.debt-panel .dp-list) {
    grid-row: 4;
  }
  .is-both .b-grid .b-pane.has-panel :deep(.sp-none),
  .is-both .b-grid .b-pane.has-panel :deep(.dp-none) {
    grid-row: 4;
    margin-top: 12px;
  }
  .is-both .b-grid .b-pane.has-panel :deep(.dp-others) {
    grid-row: 5;
    margin-top: 12px;
  }
  .is-both .b-grid .b-pane.has-panel :deep(.dp-drilled) {
    grid-row: 2 / 6; /* a drilled debt: its balance line takes the rows the pie, hint and list had */
    margin-top: 8px;
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
