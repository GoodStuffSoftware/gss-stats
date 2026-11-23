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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EditableTable from '../table/EditableTable.vue'
import CategorySelect from './CategorySelect.vue'
import TxnToolbar from './TxnToolbar.vue'
import { createCategory, createRule, fetchTxnPage, patchTxn } from '../../lib/budget/clientEdit'
import { budgetColumns, categoryOptions, createTxnTable, reviewReasonText, rowDotColor, selectValueFor, type TableDeps } from '../../lib/budget/tableModel'
import { loadRemainingPages } from '../../lib/budget/txnFill'
import { applyTxnView,anythingActive, defaultTxnViewPrefs, samePrefs, type TxnViewPrefs } from '../../lib/budget/txnView'
import { createPrefsSaver, fetchServerPrefs, putServerPrefs, readCachedPrefs, writeCachedPrefs } from '../../lib/budget/txnPrefsStore'
import { SPENDING_KINDS, type BudgetEditedEvent, type BudgetTableProps, type Category, type Txn } from '../../lib/budget/types'

const props = defineProps<BudgetTableProps>()
const emit = defineEmits<{ edited: [e: BudgetEditedEvent]; 'category-added': [c: Category] }>()

const MAX_HIGHLIGHT_PAGES = 5
const deps: TableDeps = { fetchPage: fetchTxnPage, patch: patchTxn, createRule, createCategory }

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
const { rows, rowState, status, loading, loadingMore, loadError, nextCursor } = model

const columns = computed(() => budgetColumns(props.categories, props.accounts))

// The search / filter / sort toolbar above the table: it narrows and orders the rows loaded here (never the pies), and is
// remembered per login: a localStorage copy for the first paint, the server copy (GET/PUT /api/budget/prefs) once loaded.
const viewPrefs = ref<TxnViewPrefs>(readCachedPrefs(props.accountEmail) ?? defaultTxnViewPrefs())
const viewRows = computed(() => applyTxnView(rows.value, viewPrefs.value, { categories: props.categories, accounts: props.accounts }))
const saver = createPrefsSaver(putServerPrefs)
let userEdited = false
function onPrefs(p: TxnViewPrefs) {
  userEdited = true
  viewPrefs.value = p
  writeCachedPrefs(props.accountEmail, p)
  saver.schedule(p)
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
watch(
  [() => anythingActive(viewPrefs.value), nextCursor, loading, loadingMore],
  () => {
    if (!anythingActive(viewPrefs.value) || loading.value || loadingMore.value) return
    void loadRemainingPages(model, () => anythingActive(viewPrefs.value))
  },
  { flush: 'post' },
)

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

// The merchant tip (a toggletip: opens on tap, so touch has what hover gives a mouse).
const TIP_WIDTH = 320
const TIP_MARGIN = 8
interface MerchantTip { id: string; name: string; description: string; note: string; style: Record<string, string> }
const tip = ref<MerchantTip | null>(null)
function closeTip() {
  tip.value = null
}
function openTip(row: Txn, el: HTMLElement) {
  const r = el.getBoundingClientRect()
  const vw = document.documentElement.clientWidth || window.innerWidth
  const vh = window.innerHeight
  const width = Math.max(120, Math.min(TIP_WIDTH, vw - TIP_MARGIN * 2))
  const left = Math.max(TIP_MARGIN, Math.min(r.left, vw - TIP_MARGIN - width))
  const style: Record<string, string> = { left: `${left}px`, width: `${width}px` }
  // Below the merchant, unless it sits in the lower part of the screen.
  if (r.bottom > vh * 0.6) style.bottom = `${Math.max(TIP_MARGIN, vh - r.top + 6)}px`
  else style.top = `${r.bottom + 6}px`
  tip.value = { id: row.id, name: row.merchantName || row.description, description: row.description, note: row.note ?? '', style }
}
function toggleTip(row: Txn, e: Event) {
  if (tip.value?.id === row.id) closeTip()
  else openTip(row, e.currentTarget as HTMLElement)
}
function focusTip(row: Txn, e: FocusEvent) {
  // Keyboard focus only: a tap focuses the button too, and its click must not find the tip already open and close it.
  const el = e.currentTarget as HTMLElement
  let keyboard = false
  try {
    keyboard = el.matches(':focus-visible')
  } catch {
    keyboard = false
  }
  if (keyboard && tip.value?.id !== row.id) openTip(row, el)
}
function onDocPointer(e: Event) {
  const t = e.target as Element | null
  if (t?.closest?.('.bt-merchant, .bt-tip')) return
  closeTip()
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeTip()
}
function addTipListeners() {
  document.addEventListener('pointerdown', onDocPointer, true)
  document.addEventListener('keydown', onDocKey)
  window.addEventListener('scroll', closeTip, true)
  window.addEventListener('resize', closeTip)
}
function removeTipListeners() {
  document.removeEventListener('pointerdown', onDocPointer, true)
  document.removeEventListener('keydown', onDocKey)
  window.removeEventListener('scroll', closeTip, true)
  window.removeEventListener('resize', closeTip)
}
watch(
  () => tip.value !== null,
  (open) => (open ? addTipListeners() : removeTipListeners()),
)
onBeforeUnmount(removeTipListeners)

const rowLabel = (t: Txn) => t.merchantName || t.description
const canExclude = (t: Txn) => SPENDING_KINDS.includes(t.kind) || t.included === false
</script>

<template>
  <section class="budget-table" aria-label="Transactions">
    <!-- Toolbar mount point (feat/budget-txn-filters): one contiguous block; any header/toggle from other branches goes above it. -->
    <TxnToolbar
      v-if="!(loadError && !rows.length) && (rows.length || anythingActive(viewPrefs))"
      :model-value="viewPrefs"
      :rows="rows"
      :categories="categories"
      :accounts="accounts"
      :people="people ?? []"
      :shown="viewRows.length"
      :partial="!!nextCursor"
      :bounds="bounds"
      @update:model-value="onPrefs"
    />
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
      layout="auto"
      :row-status="rowState"
      :highlight-key="highlightId ?? null"
      :status="status"
      :row-label="rowLabel"
      :loading="loading"
      label="Transactions"
      @edit="onEdit"
      @action="onAction"
    >
      <template #cell-merchant="{ row }">
        <button
          type="button"
          class="bt-merchant"
          :title="row.description"
          :aria-expanded="tip?.id === row.id"
          :aria-describedby="tip?.id === row.id ? 'bt-tip' : undefined"
          data-testid="merchant-tip-toggle"
          @click="toggleTip(row, $event)"
          @focus="focusTip(row, $event)"
        >{{ row.merchantName || row.description }}</button>
        <span v-if="row.needsReview" class="bt-flags">
          <span class="bt-badge" :title="reviewReasonText(row.reviewReason) ?? 'Needs a look'">Review</span>
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
        <span
          v-if="row.needsReview && reviewReasonText(row.reviewReason)"
          class="bt-reason"
          :title="reviewReasonText(row.reviewReason) ?? ''"
          data-testid="review-reason"
        >{{ reviewReasonText(row.reviewReason) }}</span>
      </template>
      <template #cell-note="{ row, cardLayout }">
        <!-- Clamped to a few lines; the full text is in the merchant tip. A row without a note shows nothing (desktop: a faint
             "Add note" on hover or focus; phone: nothing, since an empty field would add a blank line to every card). -->
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
    <div v-if="tip" id="bt-tip" class="bt-tip" role="tooltip" :style="tip.style" data-testid="merchant-tip">
      <span class="bt-tip-name">{{ tip.name }}</span>
      <span v-if="tip.description && tip.description !== tip.name" class="bt-tip-desc" data-testid="merchant-tip-desc">{{ tip.description }}</span>
      <span v-if="tip.note" class="bt-tip-note" data-testid="merchant-tip-note">{{ tip.note }}</span>
    </div>
  </section>
</template>

<style scoped>
.budget-table {
  min-width: 0;
}
.bt-merchant {
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
.budget-table :deep(.et-cards .et-field:has(.bt-note-empty)) {
  display: none;
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
  align-items: center;
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
</style>
