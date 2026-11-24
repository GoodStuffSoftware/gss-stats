<script setup lang="ts">
// The spreadsheet under the Budget pie: the transactions behind the current slice, with the category editable.
// Contract with BudgetSection (src/lib/budget/types.ts): it passes BudgetTableProps and listens for `edited`
// to refetch the pie once. This component fetches the pages itself (cursor paging, "Load more").
//
// - A new `query` starts over at the first page. So does a `refreshKey` change, except the one the parent makes in
//   answer to our own `edited` (that would wipe the "moved to X" notes and the rule offer).
// - An edit shows at once and is saved with PATCH (expectedUpdatedAt); a 409 or a failure puts the row back and says so.
// - The category list is searchable and offers `Add category "<text>"` (POST /categories, then the same edit); the new
//   category is reported up (`category-added`) so every list and the pie know it without a reload.
// - After a category change the row offers "Use for all <merchant>" (POST /rules).
// - Tapping (or clicking, or focusing by keyboard) the merchant opens a small tip with the full merchant text and the raw
//   statement description (what desktop hover shows through `title`). One tip at a time; a tap outside, a second tap on the
//   merchant, Escape, a scroll or a resize closes it. A tap on the merchant does nothing else (the row has no click gesture).
// - The Note column shows each row's note (clamped; the full text is in the merchant tip) and edits it in place (PATCH `note`).
// - `highlightId` scrolls to that row and marks it; when it is not on the loaded pages, more pages are loaded
//   (up to MAX_HIGHLIGHT_PAGES) to find it.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useToggletip } from '../../composables/useToggletip'
import EditableTable from '../table/EditableTable.vue'
import SegmentedControl, { type SegOption } from '../ui/SegmentedControl.vue'
import CategorySelect from './CategorySelect.vue'
import SimilarDialog from './SimilarDialog.vue'
import TxnToolbar from './TxnToolbar.vue'
import { applySimilar, createCategory, createRule, fetchSimilar, fetchTxnPage, patchTxn } from '../../lib/budget/clientEdit'
import { PHONE_TABLE_MIN_WIDTH, budgetColumns, categoryOptions, createTxnTable, loadTxnView, saveTxnView, type TxnView, reviewReasonText, rowDotColor, selectValueFor, type TableDeps } from '../../lib/budget/tableModel'
import { createFillRunner } from '../../lib/budget/txnFill'
import { applyTxnView, anythingActive, defaultTxnViewPrefs, fitPrefs, samePrefs, withSameAmount, type TxnViewPrefs } from '../../lib/budget/txnView'
import { createPrefsSaver, fetchServerPrefs, putServerPrefs, readCachedPrefs, writeCachedPrefs } from '../../lib/budget/txnPrefsStore'
import { SPENDING_KINDS, type BudgetEditedEvent, type BudgetTableProps, type Category, type Txn } from '../../lib/budget/types'

const props = defineProps<BudgetTableProps>()
const emit = defineEmits<{ edited: [e: BudgetEditedEvent]; 'category-added': [c: Category] }>()

const MAX_HIGHLIGHT_PAGES = 5
const deps: TableDeps = { fetchPage: fetchTxnPage, patch: patchTxn, createRule, createCategory, fetchSimilar, applySimilar }

let ownEdit = false
function onEdited(e: BudgetEditedEvent) {
  // The parent bumps refreshKey while it handles this event; the flag is cleared once that update has been rendered.
  ownEdit = true
  emit('edited', e)
  void nextTick(() => {
    ownEdit = false
  })
}

const model = createTxnTable(deps, () => props.categories, onEdited, (c) => emit('category-added', c))
const { rows, rowState, status, loading, loadingMore, loadError, nextCursor, similar } = model

// Phone: Cards (the default) or Table (the real table, scrolled sideways). Shown only while the table is narrower than the
// table layout needs; the choice is kept per device.
const view = ref<TxnView>(loadTxnView())
const narrow = ref(false)
function setView(v: TxnView) {
  view.value = v
  saveTxnView(v)
}
const VIEWS: SegOption[] = [
  { value: 'cards', label: 'Cards', testid: 'txn-view-cards' },
  { value: 'table', label: 'Table', testid: 'txn-view-table' },
]

const columns = computed(() => budgetColumns(props.categories, props.accounts, { phoneTable: narrow.value && view.value === 'table' }))

// A row that leaves the review list under the finger keeps its footprint: the moment it stops needing review (the tap, before
// the screen redraws) its height is measured and held, and the "Reviewed" text, "Use for all" and any error are drawn in the
// space the pill, tick and reason line held (statusInline), never as a new line. So the rows below never move while a person
// aims at the next one. Held until the list reloads.
const sectionEl = ref<HTMLElement | null>(null)
const reviewedHere = reactive(new Set<string>())
// Rows that had no reason line when first confirmed: they get no line 2 at all (the tap must not add one), so their note and
// "Use for all" go in the pill and tick line.
const noReason = reactive(new Set<string>())
const rowElOf = (id: string) => Array.from(sectionEl.value?.querySelectorAll<HTMLElement>('[data-row-key]') ?? []).find((n) => n.dataset.rowKey === id)
function lockRowHeight(id: string) {
  const el = rowElOf(id)
  // The exact (fractional) height, rounded up only at the 1/100 px: rounding up to a whole pixel grows a row by up to a pixel.
  const h = Math.ceil((el?.getBoundingClientRect().height ?? 0) * 100) / 100
  if (!el || h <= 0) return
  if (el.tagName === 'TR') el.style.height = h + 'px' // a table row's height is a minimum
  else el.style.minHeight = h + 'px'
}
watch(
  () => rows.value.filter((r) => r.needsReview).map((r) => r.id),
  (now, before) => {
    const still = new Set(now)
    for (const id of before ?? []) {
      if (still.has(id) || !rows.value.some((r) => r.id === id)) continue
      if (!reviewedHere.has(id) && !rowElOf(id)?.querySelector('[data-testid="review-reason"]')) noReason.add(id)
      lockRowHeight(id)
      reviewedHere.add(id)
    }
  },
  { flush: 'pre' },
)
// "Use for all" appears in the slot the tick was in, under the finger that just tapped it. For USEALL_ARM_MS it ignores taps
// (disabled), so a second quick tap on the spot where the tick was cannot make a merchant-wide rule.
const USEALL_ARM_MS = 600
const useAllWait = reactive(new Set<string>())
const armTimers = new Map<string, ReturnType<typeof setTimeout>>()
watch(
  () => Object.keys(rowState).filter((id) => rowState[id]?.action),
  (now, before) => {
    const was = new Set(before ?? [])
    for (const id of now) {
      if (was.has(id)) continue
      useAllWait.add(id)
      clearTimeout(armTimers.get(id))
      armTimers.set(id, setTimeout(() => {
        useAllWait.delete(id)
        armTimers.delete(id)
      }, USEALL_ARM_MS))
    }
  },
  { flush: 'pre' },
)
onBeforeUnmount(() => {
  for (const t of armTimers.values()) clearTimeout(t)
  armTimers.clear()
})
const inlineStatus = (row: Txn) => reviewedHere.has(row.id)
const isReviewed = (row: Txn) => reviewedHere.has(row.id) && !row.needsReview
/** Line 2 of a held row: the error, the saving / reviewed note, or (a row put back after a failed save) its reason. */
function heldLine(row: Txn): { text: string; error: boolean } | null {
  const s = rowState[row.id]
  if (s?.error) return { text: s.error, error: true }
  if (s?.pending) return { text: 'Saving…', error: false }
  if (s?.message) return { text: s.message, error: false }
  const reason = row.needsReview ? reviewReasonText(row.reviewReason) : null
  return reason ? { text: reason, error: false } : null
}

// The search / filter / sort toolbar above the table: it narrows and orders the rows loaded here (never the pies), and is
// remembered per login: a localStorage copy for the first paint, the server copy (GET/PUT /api/budget/prefs) once loaded.
const viewPrefs = ref<TxnViewPrefs>(readCachedPrefs(props.accountEmail) ?? defaultTxnViewPrefs())
const viewRows = computed(() => applyTxnView(rows.value, viewPrefs.value, { categories: props.categories, accounts: props.accounts }))
const SAVE_FAILED = 'Your filters could not be saved to your account. They stay on this device and will be saved again on your next change.'
const TOO_MANY = 'That is too many filter choices to remember. Remove some first.'
const saver = createPrefsSaver(putServerPrefs, undefined, undefined, (ok) => {
  if (!ok) status.value = SAVE_FAILED
  else if (status.value === SAVE_FAILED) status.value = ''
})
let userEdited = false
function onPrefs(raw: TxnViewPrefs) {
  const p = fitPrefs(raw)
  if (!p) {
    status.value = TOO_MANY
    return
  }
  userEdited = true
  viewPrefs.value = p
  writeCachedPrefs(props.accountEmail, p)
  saver.schedule(p)
}
const applying = ref(false)
async function onApplySimilar(items: Array<{ id: string; expectedUpdatedAt: string }>, makeRule: boolean) {
  applying.value = true
  try {
    await model.applySimilar(items, makeRule)
  } catch {
    status.value = 'Could not change the similar purchases. Nothing was changed.'
  } finally {
    applying.value = false
  }
}
function onFlipSameAmount(key: string, on: boolean) {
  onPrefs(withSameAmount(viewPrefs.value, key, on))
}
async function loadServerPrefs() {
  const email = props.accountEmail
  if (!email) return
  const server = await fetchServerPrefs()
  if (email !== props.accountEmail) return
  saver.setBaseline(server ?? defaultTxnViewPrefs())
  if (server && !userEdited && !samePrefs(server, viewPrefs.value)) {
    viewPrefs.value = server
    writeCachedPrefs(email, server)
  }
}
watch(() => props.accountEmail, () => {
  userEdited = false
  saver.cancel()
  viewPrefs.value = readCachedPrefs(props.accountEmail) ?? defaultTxnViewPrefs()
  void loadServerPrefs()
})
function onHide() {
  saver.flush()
}
onMounted(() => {
  void loadServerPrefs()
  window.addEventListener('pagehide', onHide)
})
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', onHide)
  saver.flush()
})

function reload() {
  reviewedHere.clear()
  noReason.clear()
  void model.load(props.query)
}
// The query as a value, so a new object with the same contents does not restart paging.
watch(() => JSON.stringify(props.query), reload)
watch(
  () => props.refreshKey,
  () => {
    if (!ownEdit) reload()
  },
)
onMounted(reload)

// With a search, filter or sort active, fetch every remaining page of the period (one request per page, no per-row calls),
// so the toolbar covers the whole period and "N of M" counts against all of it. The query never carries the filters.
// One run per filter activation and period (createFillRunner): its own pages do not start another, so the page cap holds.
const fill = createFillRunner(model, () => anythingActive(viewPrefs.value))
watch(
  [() => anythingActive(viewPrefs.value), () => JSON.stringify(props.query), loading],
  () => {
    void fill.sync(JSON.stringify(props.query), loading.value)
  },
  { flush: 'post' },
)
onBeforeUnmount(() => fill.cancel())

// Find the highlighted purchase: it may be past the first page.
watch(
  [() => props.highlightId, rows, loading],
  async () => {
    const id = props.highlightId
    if (!id || loading.value) return
    let pages = 0
    while (!rows.value.some((r) => r.id === id) && nextCursor.value && !loadError.value && pages++ < MAX_HIGHLIGHT_PAGES) {
      await model.loadMore()
    }
  },
  { flush: 'post' },
)

function onEdit(rowKey: string, field: string, value: string) {
  if (field === 'category') void model.setSelection(rowKey, value)
  else if (field === 'note') void model.setNote(rowKey, value)
}
function onAction(rowKey: string, id: string) {
  if (id === 'rule') void model.useForAll(rowKey)
}

// The merchant tip and the note tip (toggletips: they open on tap or click, so touch has what hover gives a mouse). One
// implementation (useToggletip); each trigger names its own key.
type TipData = { kind: 'merchant'; name: string; description: string; note: string } | { kind: 'note'; note: string }
const { tip, close: closeTip, toggle, openOnKeyboardFocus } = useToggletip<TipData>('.bt-merchant, .et-hold, .bt-tip')
const merchantTip = (row: Txn): TipData => ({ kind: 'merchant', name: row.merchantName || row.description, description: row.description, note: row.note ?? '' })
const merchantKey = (row: Txn) => `merchant:${row.id}`
function toggleTip(row: Txn, e: Event) {
  toggle(merchantKey(row), merchantTip(row), e.currentTarget as HTMLElement)
}
function focusTip(row: Txn, e: FocusEvent) {
  openOnKeyboardFocus(merchantKey(row), merchantTip(row), e.currentTarget as HTMLElement)
}
// The note: a click or tap shows it in full (a row without one has nothing to show, so the table opens the editor), a hold
// edits it (EditableTable, `editGesture: 'hold'`). Editing starting closes the tip.
function onPeek(rowKey: string, field: string, el: HTMLElement, source: 'click' | 'focus') {
  if (field !== 'note') return
  const row = rows.value.find((r) => r.id === rowKey)
  if (!row?.note) return
  const key = `note:${rowKey}`
  const data: TipData = { kind: 'note', note: row.note }
  if (source === 'focus') openOnKeyboardFocus(key, data, el)
  else toggle(key, data, el)
}

const showToolbar = computed(() => !(loadError.value && !rows.value.length) && (rows.value.length > 0 || anythingActive(viewPrefs.value)))
const rowLabel = (t: Txn) => t.merchantName || t.description
const canExclude = (t: Txn) => SPENDING_KINDS.includes(t.kind) || t.included === false
</script>

<template>
  <section ref="sectionEl" class="budget-table" :class="{ 'bt-phone-table': narrow && view === 'table' }" aria-label="Transactions">
    <div v-if="narrow && !showToolbar" class="bt-viewbar">
      <SegmentedControl
        :options="VIEWS"
        :model-value="view"
        label="Transactions view"
        size="compact"
        data-testid="txn-view"
        @update:model-value="(v) => setView(v as TxnView)"
      />
    </div>
    <!-- Toolbar mount point (feat/budget-txn-filters): one contiguous block; the phone Cards | Table switch is its first
         control, on the same line as the search and Filters. -->
    <TxnToolbar
      v-if="showToolbar"
      :model-value="viewPrefs"
      :rows="rows"
      :categories="categories"
      :accounts="accounts"
      :people="people ?? []"
      :shown="viewRows.length"
      :partial="!!nextCursor"
      :bounds="bounds"
      @update:model-value="onPrefs"
    >
      <template v-if="narrow" #lead>
        <SegmentedControl
          :options="VIEWS"
          :model-value="view"
          label="Transactions view"
          size="compact"
          data-testid="txn-view"
          @update:model-value="(v) => setView(v as TxnView)"
        />
      </template>
    </TxnToolbar>
    <div v-if="loadError && !rows.length" class="bt-error" role="alert">
      <span>Couldn’t load transactions.</span>
      <button type="button" class="bt-btn" @click="reload">Retry</button>
    </div>
    <div v-else-if="loading && !rows.length" class="bt-skeleton" aria-hidden="true">
      <div v-for="n in 6" :key="n" class="bt-skel-row" />
    </div>
    <EditableTable
      v-else
      :columns="columns"
      :rows="viewRows"
      row-key="id"
      :editable="canEdit"
      :layout="narrow && view === 'table' ? 'table' : 'auto'"
      :table-min-width="narrow && view === 'table' ? PHONE_TABLE_MIN_WIDTH : 0"
      :row-status="rowState"
      :status-inline="inlineStatus"
      :highlight-key="highlightId ?? null"
      :status="status"
      :row-label="rowLabel"
      :loading="loading"
      label="Transactions"
      resizable
      storage-key="gss-stats-budget-txn-cols"
      @edit="onEdit"
      @action="onAction"
      @peek="onPeek"
      @edit-start="closeTip"
      @narrow="narrow = $event"
    >
      <template #cell-merchant="{ row }">
        <!-- One line: the pill or the short Use for all button keeps its size and the name gives way, so they never drop below the name and a confirmed row keeps its height. -->
        <span class="bt-mline">
        <button
          type="button"
          class="bt-merchant"
          :title="row.description"
          :aria-expanded="tip?.key === merchantKey(row)"
          :aria-describedby="tip?.key === merchantKey(row) ? 'bt-tip' : undefined"
          data-testid="merchant-tip-toggle"
          @click="toggleTip(row, $event)"
          @focus="focusTip(row, $event)"
        >{{ row.merchantName || row.description }}</button>
        <!-- A row confirmed here keeps these two lines (see lockRowHeight): "Use for all" or the Reviewed pill and tick take the
             pill and tick's place, and the note or error takes the reason line's. -->
        <span v-if="isReviewed(row)" class="bt-flags" data-testid="review-held" :title="noReason.has(row.id) ? (heldLine(row)?.text ?? undefined) : undefined">
          <template v-if="!rowState[row.id]?.action">
            <span class="bt-reviewed">Reviewed</span>
            <span class="bt-done-tick" aria-hidden="true">✓</span>
          </template>
          <!-- A short label: the merchant it applies to is the name beside it; the full text is the title and the aria-label. -->
          <button
            v-if="rowState[row.id]?.action"
            type="button"
            class="bt-useall"
            :title="rowState[row.id]?.action?.label"
            :aria-label="rowState[row.id]?.action?.label"
            :disabled="rowState[row.id]?.action?.busy || useAllWait.has(row.id)"
            data-testid="review-use-all"
            @click="model.useForAll(row.id)"
          >Use for all</button>
        </span>
        <span v-else-if="row.needsReview" class="bt-flags">
          <!-- A row with no reason line shows a failed save here (it has no line to put it in): the full text is the title. -->
          <span
            v-if="noReason.has(row.id) && rowState[row.id]?.error"
            class="bt-badge bt-badge-error"
            role="alert"
            :title="rowState[row.id]?.error"
            :aria-label="rowState[row.id]?.error"
          >Not saved</span>
          <span v-else class="bt-badge" :title="reviewReasonText(row.reviewReason) ?? 'Needs a look'">Review</span>
          <button
            v-if="canEdit"
            type="button"
            class="bt-confirm"
            title="Looks right"
            :aria-label="'Looks right: ' + rowLabel(row)"
            :disabled="!!rowState[row.id]?.pending"
            data-testid="review-confirm"
            @click="model.confirmReview(row.id)"
          >✓</button>
        </span>
        </span>
        <template v-if="reviewedHere.has(row.id)">
          <span
            v-if="!noReason.has(row.id) && heldLine(row)"
            class="bt-reason"
            :class="{ 'bt-reason-error': heldLine(row)!.error }"
            :role="heldLine(row)!.error ? 'alert' : undefined"
            data-testid="review-held-line"
          >{{ heldLine(row)!.text }}</span>
        </template>
        <span
          v-else-if="row.needsReview && reviewReasonText(row.reviewReason)"
          class="bt-reason"
          :title="reviewReasonText(row.reviewReason) ?? ''"
          data-testid="review-reason"
        >{{ reviewReasonText(row.reviewReason) }}</span>
      </template>
      <template #cell-note="{ row, cardLayout }">
        <!-- Clamped to a few lines; a click or tap shows the full text in a tip, a hold edits. A row without a note shows a
             faint "Add note" (desktop: on hover or focus; touch and phone cards: always, one small muted line); a click on it
             opens the editor. -->
        <span v-if="row.note" class="bt-note" :class="{ 'bt-note-card': cardLayout }" data-testid="row-note">{{ row.note }}</span>
        <span v-else class="bt-note-empty">Add note</span>
      </template>
      <template #cell-category="{ row }">
        <span class="bt-cat">
          <span class="bt-dot" :style="{ background: rowDotColor(categories, row) }" aria-hidden="true" />
          {{ categoryOptions(categories, row).find((o) => o.value === selectValueFor(row))?.label }}
        </span>
      </template>
      <template #editor-category="{ row, disabled, label, commit }">
        <CategorySelect
          :value="selectValueFor(row)"
          :options="categoryOptions(categories, row)"
          :color="rowDotColor(categories, row)"
          :label="label"
          :disabled="disabled"
          allow-add
          @change="commit"
          @add="(name: string) => model.addCategoryTo(row.id, name)"
        />
      </template>
      <template #cell-included="{ row }">
        <!-- Only spend, refund and fee rows are in the spending totals, so only they get the switch (a row already
             excluded keeps it, so a person can always turn it back on). -->
        <label
          v-if="canExclude(row)"
          class="bt-included"
          :class="{ 'bt-excluded': row.included === false }"
          title="Count in totals"
          @click.stop
          @pointerdown.stop
          @touchstart.stop
          @contextmenu.stop
        >
          <input
            type="checkbox"
            :checked="row.included !== false"
            :disabled="!canEdit || !!rowState[row.id]?.pending"
            :aria-label="'Count in totals: ' + rowLabel(row)"
            data-testid="included-toggle"
            @change="model.setIncluded(row.id, ($event.target as HTMLInputElement).checked)"
          />
        </label>
      </template>
      <template #empty>No transactions in this view.</template>
      <template #footer>
        <div v-if="loadError && rows.length" class="bt-error" role="alert">
          <span>Couldn’t load more.</span>
          <button type="button" class="bt-btn" @click="model.loadMore()">Retry</button>
        </div>
        <div v-else-if="nextCursor" class="bt-more">
          <button type="button" class="bt-btn" :disabled="loadingMore" @click="model.loadMore()">
            {{ loadingMore ? 'Loading…' : 'Load more' }}
          </button>
        </div>
      </template>
    </EditableTable>
    <SimilarDialog
      :offer="similar"
      :categories="categories"
      :prefs="viewPrefs"
      :busy="applying"
      @close="model.closeSimilar()"
      @apply="onApplySimilar"
      @flip="onFlipSameAmount"
    />
    <div v-if="tip" id="bt-tip" class="bt-tip" role="tooltip" :style="tip.style" data-testid="merchant-tip">
      <template v-if="tip.data.kind === 'merchant'">
        <span class="bt-tip-name">{{ tip.data.name }}</span>
        <span v-if="tip.data.description && tip.data.description !== tip.data.name" class="bt-tip-desc" data-testid="merchant-tip-desc">{{ tip.data.description }}</span>
        <span v-if="tip.data.note" class="bt-tip-note" data-testid="merchant-tip-note">{{ tip.data.note }}</span>
      </template>
      <span v-else class="bt-tip-fullnote" data-testid="note-tip">{{ tip.data.note }}</span>
    </div>
  </section>
</template>

<style scoped>
.budget-table {
  min-width: 0;
}
.bt-mline {
  display: flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}
.bt-merchant {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: inherit;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The phone Table view: the Merchant cell gives the table no width of its own (it takes the column's asked width, see budgetColumns), so a long
   name is cut with an ellipsis inside it and Date, Merchant and Amount fit the screen together; the other columns scroll sideways. */
.bt-phone-table .bt-mline {
  contain: inline-size;
}
/* On a phone a long name is cut short so the tick (and Use for all) stays on screen in the scrolling table; the full name is the title and the tip. */
@media (max-width: 700px) {
  .bt-merchant {
    max-width: min(100%, 18ch);
  }
}
.bt-merchant:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 2px;
}
.bt-tip {
  position: fixed;
  z-index: 50;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.18);
  font-size: 13px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.bt-tip-desc {
  font-size: 12px;
  color: rgb(var(--ink-2));
}
.bt-tip-note {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid rgb(var(--line-2));
  white-space: pre-wrap;
}
/* Long notes wrap and stop at three lines (two on the wide table); the merchant tip has the whole text. */
.bt-note {
  display: -webkit-box;
  max-width: 60ch;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.35;
  color: rgb(var(--ink-2));
}
.bt-note-card {
  -webkit-line-clamp: 3;
  line-clamp: 3;
  font-size: 13px;
}
.bt-note-empty {
  font-size: 12px;
  color: rgb(var(--ink-2));
  opacity: 0;
}
tr:hover .bt-note-empty,
.et-text-btn:focus-visible .bt-note-empty {
  opacity: 1;
}
/* No hover on touch: the prompt stays visible, and on the phone cards it is one compact line, not a 44px field. */
@media (hover: none) {
  .bt-note-empty {
    opacity: 1;
  }
}
.budget-table :deep(.et-cards .et-text-btn:has(.bt-note-empty)) {
  width: auto;
  min-height: 32px;
  padding: 0 4px;
}
.budget-table :deep(.et-cards .bt-note-empty) {
  opacity: 1;
  font-size: 13px;
}
.bt-tip-fullnote {
  white-space: pre-wrap;
}
.bt-reason {
  display: block;
  max-width: 48ch;
  margin-top: 1px;
  font-size: 11px;
  line-height: 1.3;
  font-style: italic;
  color: rgb(var(--ink-2));
}
.bt-flags {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  max-width: 100%;
  vertical-align: middle;
  white-space: nowrap;
}
.bt-confirm {
  margin-left: 6px;
  min-width: 28px;
  height: 28px;
  padding: 0;
  vertical-align: middle;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  border-radius: 999px;
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  cursor: pointer;
}
.bt-confirm:hover:not(:disabled) {
  border-color: rgb(var(--amber));
  background: rgb(var(--amber-tint));
}
.bt-confirm:disabled {
  opacity: 0.6;
  cursor: default;
}
/* The held (just confirmed) row: same slots, muted. The Use for all button is as tall as the tick it replaces. */
.bt-reason-error {
  font-style: normal;
  color: rgb(var(--g4));
}
.bt-reviewed,
.bt-done-tick {
  margin-left: 6px;
  color: rgb(var(--ink-2));
  font-size: 11px;
}
.bt-done-tick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  margin-left: 6px;
  font-size: 13px;
  opacity: 0.6;
}
.bt-useall {
  flex: 0 0 auto;
  position: relative;
  height: 28px;
  margin-left: 6px;
  padding: 0 10px;
  white-space: nowrap;
  font: inherit;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid rgb(var(--amber));
  background: rgb(var(--amber-tint));
  color: rgb(var(--ink));
  cursor: pointer;
}
.bt-useall:disabled {
  opacity: 0.6;
  cursor: default;
}
/* A finger needs 36px: the ✓ and Use for all keep their 28px look and height (the held row's height is locked) and get a transparent
   4px ring that takes the tap. The ring is absolutely placed, so it adds nothing to the row. */
@media (max-width: 700px) {
  .bt-confirm {
    position: relative;
  }
  .bt-confirm::after,
  .bt-useall::after {
    content: '';
    position: absolute;
    inset: -4px;
  }
}
.bt-badge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: rgb(var(--ink));
  background: rgb(var(--amber-tint));
  border: 1px solid rgb(var(--amber));
  white-space: nowrap;
}
.bt-badge-error {
  color: rgb(var(--g4));
  background: rgb(var(--surface));
  border-color: rgb(var(--g4));
}
.bt-cat {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* The Included switch: a 44px touch target (a 24px box) that fits beside the amount at 320px; off reads as an empty box. */
.bt-included {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  cursor: pointer;
}
.bt-included input {
  width: 22px;
  height: 22px;
  margin: 0;
  cursor: inherit;
  accent-color: rgb(var(--ink));
}
.bt-included input:disabled {
  cursor: default;
}
.bt-excluded input {
  opacity: 0.7;
}
.bt-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.bt-more,
.bt-error {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  font-size: 13px;
}
.bt-error {
  color: rgb(var(--g4));
}
.bt-btn {
  font: inherit;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  cursor: pointer;
}
.bt-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.bt-skel-row {
  height: 36px;
  margin-bottom: 6px;
  border-radius: 6px;
  background: rgb(var(--sunken));
}
/* Cards | Table switch (phone); the control itself is SegmentedControl. */
.bt-viewbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
</style>
